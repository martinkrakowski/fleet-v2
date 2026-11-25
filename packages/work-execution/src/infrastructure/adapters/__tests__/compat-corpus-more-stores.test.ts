/**
 * FC1A stored-record compatibility corpus for the three remaining versioned
 * JSON stores in `@fleet/work-execution`: `merge-records.json`,
 * `seat-tickets.json` and `held-work-orders.json`.
 *
 * The checked-in fixtures under `compat-fixtures/more/` are exactly the bytes
 * the current writers (`MergeRecordRepositoryAdapter.saveMergeRecord`,
 * `SeatTicketRepositoryAdapter.saveSeatTicket`,
 * `HeldWorkOrderRepositoryAdapter.recordHoldIntent` + `completeHoldIntent`)
 * produce with the `schemaVersion` key removed from every record (D6: an
 * absent `schemaVersion` reads as `1` forever). They live in `more/` so the
 * original `compat-corpus.test.ts` — whose `readdir` is non-recursive and
 * asserts the exact file count directly under `compat-fixtures/` — and the
 * five existing `*.legacy.json` fixtures stay byte-for-byte untouched.
 *
 * Each store's read path must accept its fixture, stamp nothing, rewrite
 * nothing and quarantine nothing. A synthetic unknown `schemaVersion: 2` is
 * refused per store: the two `readOrQuarantineVersionedRecordList` stores
 * throw `StateFileUnknownVersionError` (never quarantined), and the
 * held-work-order store — which never quarantines at all — answers
 * `{ outcome: 'unreadable' }` without throwing. Either way the file's bytes
 * stay bit-identical and no quarantine copy or lock file appears.
 *
 * Cost bounds: every fixture is a single minimal record (a few hundred bytes,
 * far under `STORE_FILE_MAX_BYTES` = 8 MiB), so fixture parsing, field scans
 * and every per-input check below are O(N) in that small fixture size with no
 * unbounded loops. Each hostile input is a fresh handful of keys, so the
 * per-parser tables are O(1) in record size and O(K) in the K pinned cases.
 *
 * Hostile-input pin (orchestrator correction, 2026-11-25): a Proxy whose
 * `getPrototypeOf` or `getOwnPropertyDescriptor` trap throws must not escape
 * `readStoreRecordSchemaVersion`. That function is in `file-store.ts`, outside
 * this lane's OWNED files, so it is not edited here; the current behaviour is
 * pinned precisely instead. A Proxy that lies consistently in every trap stays
 * the accepted residual.
 * FINDING: `readStoreRecordSchemaVersion` (file-store.ts) lets a throwing
 * `Object.getPrototypeOf` or `Object.getOwnPropertyDescriptor` reflection trap
 * escape, and `parseVersionedMergeRecordStateRecord` has no internal catch, so
 * the throw propagates out of that exported parser. The corpus path itself is
 * unaffected: `inspectVersionedRecordListBytes` wraps every element parse in
 * `parseVersionedElement`, which turns any throw into `{ status: 'invalid' }`,
 * so stored-file reads still fail closed. The seat and held parsers wrap their
 * whole body in a catch and answer `{ status: 'invalid' }`.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertValidSchemaVersionPolicy,
  StateFileUnknownVersionError,
  type StoreSchemaVersionPolicy,
} from '../file-store.js';
import {
  MERGE_RECORD_STORE_VERSION_POLICY,
  MergeRecordRepositoryAdapter,
  parseVersionedMergeRecordStateRecord,
} from '../MergeRecordRepositoryAdapter.adapter.js';
import {
  SEAT_TICKET_STORE_VERSION_POLICY,
  SeatTicketRepositoryAdapter,
  parseVersionedSeatTicketStateRecord,
} from '../SeatTicketRepositoryAdapter.adapter.js';
import {
  HELD_WORK_ORDER_STORE_VERSION_POLICY,
  HeldWorkOrderRepositoryAdapter,
  parseVersionedHeldWorkOrderStateRecord,
} from '../HeldWorkOrderRepositoryAdapter.adapter.js';

const FIXTURE_DIR = fileURLToPath(new URL('./compat-fixtures/more/', import.meta.url));

interface MoreStoreSpec {
  readonly basename: string;
  readonly fixture: string;
  readonly policy: StoreSchemaVersionPolicy;
  /**
   * `'records'`: the read resolves to the record list directly (merge, seat).
   * `'held-list-result'`: it resolves to the held store's
   * `{ outcome, records }` result (held).
   */
  readonly resultKind: 'records' | 'held-list-result';
  /**
   * True when the read materializes the absent on-disk `schemaVersion` as `1`
   * on every returned record (`merge-records.json`; D6).
   */
  readonly stampsSchemaVersionOnRead: boolean;
  readonly read: (stateDir: string) => Promise<unknown>;
}

const MORE_STORES: readonly MoreStoreSpec[] = [
  {
    basename: 'merge-records.json',
    fixture: 'merge-records.legacy.json',
    policy: MERGE_RECORD_STORE_VERSION_POLICY,
    resultKind: 'records',
    stampsSchemaVersionOnRead: true,
    read: (dir) => new MergeRecordRepositoryAdapter({ stateDir: dir }).listMergeRecords(),
  },
  {
    basename: 'seat-tickets.json',
    fixture: 'seat-tickets.legacy.json',
    policy: SEAT_TICKET_STORE_VERSION_POLICY,
    resultKind: 'records',
    stampsSchemaVersionOnRead: false,
    read: (dir) => new SeatTicketRepositoryAdapter({ stateDir: dir }).listSeatTickets(),
  },
  {
    basename: 'held-work-orders.json',
    fixture: 'held-work-orders.legacy.json',
    policy: HELD_WORK_ORDER_STORE_VERSION_POLICY,
    resultKind: 'held-list-result',
    stampsSchemaVersionOnRead: false,
    read: (dir) => new HeldWorkOrderRepositoryAdapter({ stateDir: dir }).listHeldWorkOrders(),
  },
];

async function makeTempStateDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempStateDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function stateFilePath(stateDir: string, basename: string): string {
  return path.join(stateDir, basename);
}

async function readFixtureBytes(fixture: string): Promise<Buffer> {
  return fs.readFile(path.join(FIXTURE_DIR, fixture));
}

function parseFixtureRecords(bytes: Buffer): readonly Record<string, unknown>[] {
  return JSON.parse(bytes.toString('utf8')) as readonly Record<string, unknown>[];
}

function expectNoSchemaVersionKey(record: unknown): void {
  expect(Object.hasOwn(record as Record<string, unknown>, 'schemaVersion')).toBe(false);
}

/**
 * Writes `bytes` as the store's state file in a fresh temp state directory and
 * returns the directory; the caller removes it in `finally`.
 */
async function seedStateFile(
  prefix: string,
  basename: string,
  bytes: Buffer,
): Promise<string> {
  const dir = await makeTempStateDir(prefix);
  await fs.writeFile(stateFilePath(dir, basename), bytes);
  return dir;
}

async function assertBytesUnchanged(stateFile: string, before: Buffer): Promise<void> {
  const after = await fs.readFile(stateFile);
  expect(Buffer.compare(before, after)).toBe(0);
}

/**
 * Field values whose `String` form can meaningfully appear in an error
 * message at all: strings long enough to be identifiers. Booleans, numbers,
 * nulls and one-character strings collide trivially with ordinary prose and
 * prove nothing about echoing.
 */
function echoedValues(record: Record<string, unknown>): readonly string[] {
  return Object.values(record)
    .filter((value): value is string => typeof value === 'string' && value.length >= 8);
}

/** The only entry next to a state file must be the state file itself: nothing was quarantined or locked. */
async function assertNothingQuarantined(stateDir: string): Promise<void> {
  const entries = await fs.readdir(stateDir);
  expect(entries).toHaveLength(1);
}

/** The record list behind one read: the `{ outcome: 'ok', records }` result is unwrapped, anything else refuses. */
function recordsOfRead(spec: MoreStoreSpec, raw: unknown): readonly Record<string, unknown>[] {
  if (spec.resultKind === 'held-list-result') {
    const result = raw as { readonly outcome: unknown; readonly records?: unknown };
    if (result.outcome !== 'ok' || !Array.isArray(result.records)) {
      throw new Error(`held store answered outcome ${JSON.stringify(result.outcome)}`);
    }
    return result.records as readonly Record<string, unknown>[];
  }
  return raw as readonly Record<string, unknown>[];
}

/** The record without its own materialized `schemaVersion` key, if the read added one. */
function withoutOwnSchemaVersion(record: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.schemaVersion;
  return copy;
}

type AnyVersionedParseResult =
  | { readonly status: 'ok'; readonly record: unknown; readonly schemaVersion: number }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'invalid' };

type VersionedRecordParser = (raw: unknown) => AnyVersionedParseResult;

const VERSIONED_PARSERS: readonly (readonly [string, VersionedRecordParser])[] = [
  ['parseVersionedMergeRecordStateRecord', parseVersionedMergeRecordStateRecord],
  ['parseVersionedSeatTicketStateRecord', parseVersionedSeatTicketStateRecord],
  ['parseVersionedHeldWorkOrderStateRecord', parseVersionedHeldWorkOrderStateRecord],
];

/**
 * Runs one parser and never lets it throw: a throw is reported as a distinct
 * result so every pinned expectation fails loudly against it.
 */
function callParser(parser: VersionedRecordParser, input: unknown): unknown {
  try {
    return parser(input);
  } catch (error) {
    return { status: 'threw', message: (error as Error).message };
  }
}

/** An object whose own `schemaVersion` is an enumerable accessor; the getter counts its invocations. */
function schemaVersionGetterTarget(): {
  readonly target: Record<string, unknown>;
  readonly timesCalled: () => number;
} {
  let calls = 0;
  const target: Record<string, unknown> = {};
  Object.defineProperty(target, 'schemaVersion', {
    enumerable: true,
    get() {
      calls += 1;
      return 2;
    },
  });
  return { target, timesCalled: () => calls };
}

/** A plain copy of `record` with an own enumerable `__proto__` data property. */
function withOwnProtoKey(record: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  Object.defineProperty(copy, '__proto__', {
    value: 'polluted',
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

describe('compat corpus more/ fixtures', () => {
  it('every legacy fixture in more/ is a non-empty JSON array whose records carry no schemaVersion key, and there are exactly three', async () => {
    const fixtures = (await fs.readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.legacy.json'));
    expect(fixtures).toHaveLength(MORE_STORES.length);
    for (const fixture of fixtures) {
      const fixtureBytes = await readFixtureBytes(fixture);
      const parsed: unknown = JSON.parse(fixtureBytes.toString('utf8'));
      expect(Array.isArray(parsed)).toBe(true);
      const records = parsed as unknown[];
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expectNoSchemaVersionKey(record);
      }
    }
  });
});

describe.each(MORE_STORES)('$basename accepts its pre-schemaVersion fixture', (spec) => {
  it('reads every legacy record as schemaVersion 1 without rewriting the file or writing anything else', async () => {
    const bytes = await readFixtureBytes(spec.fixture);
    const fixtureRecords = parseFixtureRecords(bytes);
    const dir = await seedStateFile('fleet-compat-more-ok-', spec.basename, bytes);
    try {
      const raw = await spec.read(dir);
      if (spec.resultKind === 'held-list-result') {
        expect((raw as { outcome: unknown }).outcome).toBe('ok');
      }
      const records = recordsOfRead(spec, raw);
      expect(records.length).toBe(fixtureRecords.length);
      expect(records.length).toBeGreaterThan(0);
      for (const [index, record] of records.entries()) {
        const stamped = record as { schemaVersion?: unknown };
        if (spec.stampsSchemaVersionOnRead) {
          // `merge-records.json`: the absent on-disk `schemaVersion` is
          // materialized as `1` on the returned record (D6).
          expect(stamped.schemaVersion).toBe(1);
        } else {
          expectNoSchemaVersionKey(record);
        }
        expect(withoutOwnSchemaVersion(record)).toStrictEqual(fixtureRecords[index]);
      }
      await assertBytesUnchanged(stateFilePath(dir, spec.basename), bytes);
      // Only the state file itself: nothing written, nothing quarantined, no
      // lock file (a healthy read takes the unlocked fast path).
      await assertNothingQuarantined(dir);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it('refuses a record with an unknown schemaVersion, leaving the bytes untouched and nothing quarantined', async () => {
    const bytes = await readFixtureBytes(spec.fixture);
    const legacyRecord = parseFixtureRecords(bytes)[0];
    const futureRecord = { ...legacyRecord, schemaVersion: 2 };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord, futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-more-refuse-', spec.basename, refusingBytes);
    try {
      const stateFile = stateFilePath(dir, spec.basename);
      const onDiskBefore = await fs.readFile(stateFile);
      if (spec.resultKind === 'held-list-result') {
        // Pinned: the held store never quarantines and never throws; an
        // unknown `schemaVersion` makes the whole store plain `unreadable`.
        const raw = await spec.read(dir);
        expect((raw as { outcome: unknown }).outcome).toBe('unreadable');
      } else {
        let error: unknown;
        try {
          await spec.read(dir);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(StateFileUnknownVersionError);
        const unknownVersionError = error as StateFileUnknownVersionError;
        expect(unknownVersionError.recordIndex).toBe(1);
        expect(unknownVersionError.message).toContain('unsupported schemaVersion');
        expect(unknownVersionError.message).toContain('record 1');
        // No stored string value of length >= 8 is echoed into the refusal.
        for (const value of echoedValues(legacyRecord)) {
          expect(unknownVersionError.message).not.toContain(String(value));
        }
        if (spec.basename === 'seat-tickets.json') {
          // Pinned: this matches `readOrQuarantineVersionedRecordList`, where
          // an unknown schemaVersion is never quarantined — even though
          // `SeatTicketRepositoryAdapter`'s header comment says unreadable
          // files keep a quarantine copy. Only unreadable bytes are
          // quarantined; an unknown schemaVersion refuses without any copy.
        }
      }
      await assertNothingQuarantined(dir);
      await assertBytesUnchanged(stateFile, onDiskBefore);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it('declares a policy that accepts the writer version and the previous version, and refuses a version-dropping bump', () => {
    const checked = assertValidSchemaVersionPolicy(spec.basename, spec.policy);
    expect(checked.acceptedVersions).toContain(checked.writerVersion);
    if (checked.writerVersion > 1) {
      expect(checked.acceptedVersions).toContain(checked.writerVersion - 1);
    }
    // Bumping `writerVersion` to 2 without keeping 1 in `acceptedVersions` is
    // refused, naming the store and the missing previous version 1.
    let bumpError: unknown;
    try {
      assertValidSchemaVersionPolicy(spec.basename, { writerVersion: 2, acceptedVersions: [2] });
    } catch (caught) {
      bumpError = caught;
    }
    expect(bumpError).toBeInstanceOf(Error);
    const bumpMessage = (bumpError as Error).message;
    expect(bumpMessage).toContain(spec.basename);
    expect(bumpMessage).toContain('schemaVersion 1');
  });
});

describe('hostile inputs on the versioned record parsers', () => {
  it('returns the typed { status: "invalid" } refusal for null, undefined, wrong primitives, [], the array-like { length: N } and a schemaVersion getter it never invokes, for all three parsers', () => {
    for (const [parserName, parser] of VERSIONED_PARSERS) {
      // Non-objects and empty arrays carry no own `schemaVersion` and no body:
      // every parser answers the typed `invalid` result.
      for (const input of [null, undefined, 5, 'x', true, []]) {
        const result = callParser(parser, input);
        expect(result).toStrictEqual({ status: 'invalid' });
      }
      // Array-likes are plain objects with a `length` own property, so the
      // schemaVersion check passes (absent reads as 1, D6) and the body check
      // refuses. Pinned precisely: the merge and held parsers answer
      // `{ status: 'invalid' }` (missing/unknown body), while the seat parser
      // answers `{ status: 'unknown-version' }` because its body check treats
      // a record without `version: 1` as an unsupported version. A typed
      // refusal either way, never a pass and never a throw.
      for (const input of [{ length: 1 }, { length: Number.MAX_SAFE_INTEGER }]) {
        const result = callParser(parser, input);
        if (parserName === 'parseVersionedSeatTicketStateRecord') {
          expect(result).toStrictEqual({ status: 'unknown-version' });
        } else {
          expect(result).toStrictEqual({ status: 'invalid' });
        }
      }
      // The descriptor-based version check never invokes the getter.
      const { target, timesCalled } = schemaVersionGetterTarget();
      expect(callParser(parser, target)).toStrictEqual({ status: 'invalid' });
      expect(timesCalled()).toBe(0);
    }
  });

  it('keeps a throwing Proxy trap inside the seat and held parsers, and pins the current merge parser escape', () => {
    for (const [, parser] of VERSIONED_PARSERS) {
      if (parser !== parseVersionedMergeRecordStateRecord) {
        continue;
      }
      // FINDING (see the file header): `readStoreRecordSchemaVersion` in
      // `file-store.ts` (outside this lane's OWNED files) lets a throwing
      // reflection trap escape, and this parser has no internal catch, so the
      // throw propagates. Pinned precisely as the current behaviour; the
      // corpus path is unaffected because `inspectVersionedRecordListBytes`
      // wraps every element parse in `parseVersionedElement`, which turns any
      // throw into `{ status: 'invalid' }`.
      const protoTrap = new Proxy(
        {},
        { getPrototypeOf() { throw new Error('getPrototypeOf trap'); } },
      );
      expect(() => parser(protoTrap)).toThrowError('getPrototypeOf trap');
      const descriptorTrap = new Proxy(
        {},
        { getOwnPropertyDescriptor() { throw new Error('getOwnPropertyDescriptor trap'); } },
      );
      expect(() => parser(descriptorTrap)).toThrowError('getOwnPropertyDescriptor trap');
    }
    // The seat and held parsers wrap their whole body in a catch: every
    // throwing trap is the typed `invalid` result, never an escape.
    for (const [parserName, parser] of VERSIONED_PARSERS) {
      if (parserName !== 'parseVersionedSeatTicketStateRecord' && parserName !== 'parseVersionedHeldWorkOrderStateRecord') {
        continue;
      }
      const protoTrap = new Proxy(
        {},
        { getPrototypeOf() { throw new Error('getPrototypeOf trap'); } },
      );
      expect(callParser(parser, protoTrap)).toStrictEqual({ status: 'invalid' });
      const descriptorTrap = new Proxy(
        {},
        { getOwnPropertyDescriptor() { throw new Error('getOwnPropertyDescriptor trap'); } },
      );
      expect(callParser(parser, descriptorTrap)).toStrictEqual({ status: 'invalid' });
    }
  });

  it('drops an own __proto__ key without copying it or polluting Object.prototype (merge, seat) and refuses the record (held)', async () => {
    const pollutedMerge = withOwnProtoKey(parseFixtureRecords(await readFixtureBytes('merge-records.legacy.json'))[0]);
    const pollutedSeat = withOwnProtoKey(parseFixtureRecords(await readFixtureBytes('seat-tickets.legacy.json'))[0]);
    const pollutedHeld = withOwnProtoKey(parseFixtureRecords(await readFixtureBytes('held-work-orders.legacy.json'))[0]);
    // Pinned: the merge and seat readers copy only their declared fields, so
    // the own `__proto__` key is ignored rather than copied — the parsed
    // record carries no `__proto__` key and `Object.prototype` stays clean.
    const mergeResult = parseVersionedMergeRecordStateRecord(pollutedMerge);
    expect(mergeResult.status).toBe('ok');
    if (mergeResult.status === 'ok') {
      expect(Object.hasOwn(mergeResult.record as unknown as Record<string, unknown>, '__proto__')).toBe(false);
    }
    const seatResult = parseVersionedSeatTicketStateRecord(pollutedSeat);
    expect(seatResult.status).toBe('ok');
    if (seatResult.status === 'ok') {
      expect(Object.hasOwn(seatResult.record as unknown as Record<string, unknown>, '__proto__')).toBe(false);
    }
    // The held reader snapshots every own key of the record and refuses a
    // `__proto__` key outright.
    expect(parseVersionedHeldWorkOrderStateRecord(pollutedHeld)).toStrictEqual({ status: 'invalid' });
    // Nothing was ever assigned onto `Object.prototype`.
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});
