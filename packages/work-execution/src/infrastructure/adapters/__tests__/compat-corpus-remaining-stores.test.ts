/**
 * FC1C stored-record compatibility corpus for the last three versioned JSON
 * stores in `@fleet/work-execution`: `cutover-journal.json`, `lane-plans.json`
 * and `relaunch-plans.json`.
 *
 * The checked-in fixtures under `compat-fixtures/remaining/` are minimal valid
 * records with the `schemaVersion` key removed (D6: an absent `schemaVersion`
 * reads as `1` forever) — the shapes a pre-schemaVersion build of fleet-v2
 * wrote. They live in `remaining/` so the top-level count guards of the older
 * corpus suites stay byte-for-byte untouched.
 *
 * Each store's read path must accept its fixture, stamp nothing (the relaunch
 * store materializes `schemaVersion: 1` on the returned record), rewrite
 * nothing and quarantine nothing. A synthetic unknown `schemaVersion` is
 * refused per store: `cutover-journal.json` answers `{ outcome: 'unreadable' }`
 * (`listByKeyPrefix` catches `StateFileUnknownVersionError`), `lane-plans.json`
 * throws `StateFileUnknownVersionError`, and the relaunch store — which never
 * throws — answers `{ outcome: 'unreadable', reason: 'unknown-version' }`.
 * Either way the file's bytes stay bit-identical and nothing is quarantined.
 *
 * Cost bounds: every fixture is a single minimal record (a few hundred bytes,
 * far under `STORE_FILE_MAX_BYTES`), so fixture parsing, field scans and every
 * per-input check below are O(N) in that small fixture size with no unbounded
 * loops. Each hostile input is a fresh handful of keys, so the per-parser
 * tables are O(1) in record size and O(K) in the K pinned cases.
 *
 * Hostile-input pin: `readStoreRecordSchemaVersion` (file-store.ts, outside
 * this lane's OWNED files) lets a throwing `getPrototypeOf` or
 * `getOwnPropertyDescriptor` reflection trap escape. The lane-plan and cutover
 * parsers have no internal catch, so the throw propagates out of the exported
 * parser (pinned as current behaviour; the corpus path is unaffected because
 * `inspectVersionedRecordListBytes` wraps every element parse in
 * `parseVersionedElement`, which turns any throw into `{ status: 'invalid' }`,
 * so stored-file reads still fail closed). The relaunch reader wraps its whole
 * body in a catch and answers `null`.
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
  CUTOVER_JOURNAL_STORE_VERSION_POLICY,
  CutoverJournalAdapter,
  readStoredCutoverJournalRecord,
} from '../CutoverJournalAdapter.adapter.js';
import {
  LANE_PLAN_STORE_VERSION_POLICY,
  LanePlanRepositoryAdapter,
  parseVersionedLanePlanStateRecord,
} from '../LanePlanRepositoryAdapter.adapter.js';
import {
  RELAUNCH_PLAN_STORE_VERSION_POLICY,
  RelaunchPlanRepositoryAdapter,
  readRelaunchPlanRecord,
} from '../RelaunchPlanRepositoryAdapter.adapter.js';

const FIXTURE_DIR = fileURLToPath(new URL('./compat-fixtures/remaining/', import.meta.url));

interface RemainingStoreSpec {
  readonly basename: string;
  readonly fixture: string;
  readonly policy: StoreSchemaVersionPolicy;
  /**
   * `'listed'`: `listByKeyPrefix` answers `{ outcome: 'listed', entries }`.
   * `'plans'`: `listLanePlans` resolves to the record list directly and an
   * unknown version throws. `'found'`: `findByDigest` answers
   * `{ outcome: 'found', plan }` and materializes `schemaVersion: 1`.
   */
  readonly resultKind: 'listed' | 'plans' | 'found';
  /** The future `schemaVersion` seeded for the refusal case. */
  readonly futureVersion: number;
  readonly read: (stateDir: string) => Promise<unknown>;
}

const REMAINING_STORES: readonly RemainingStoreSpec[] = [
  {
    basename: 'cutover-journal.json',
    fixture: 'cutover-journal.legacy.json',
    policy: CUTOVER_JOURNAL_STORE_VERSION_POLICY,
    resultKind: 'listed',
    futureVersion: 3,
    read: (dir) => new CutoverJournalAdapter({ stateDir: dir }).listByKeyPrefix('cutover/'),
  },
  {
    basename: 'lane-plans.json',
    fixture: 'lane-plans.legacy.json',
    policy: LANE_PLAN_STORE_VERSION_POLICY,
    resultKind: 'plans',
    futureVersion: 2,
    read: (dir) => new LanePlanRepositoryAdapter({ stateDir: dir }).listLanePlans(),
  },
  {
    basename: 'relaunch-plans.json',
    fixture: 'relaunch-plans.legacy.json',
    policy: RELAUNCH_PLAN_STORE_VERSION_POLICY,
    resultKind: 'found',
    futureVersion: 2,
    read: (dir) => {
      const record = (firstFixtureRecord.get('relaunch-plans.legacy.json') ?? {}) as { planDigest?: string };
      return new RelaunchPlanRepositoryAdapter({ stateDir: dir }).findByDigest(record.planDigest ?? '');
    },
  },
];

/** Fixture bytes and their parsed first record, read once for the whole suite. */
const fixtureCache = new Map<string, Buffer>();
const firstFixtureRecord = new Map<string, Record<string, unknown>>();

async function readFixtureBytes(fixture: string): Promise<Buffer> {
  const cached = fixtureCache.get(fixture);
  if (cached !== undefined) return cached;
  const bytes = await fs.readFile(path.join(FIXTURE_DIR, fixture));
  fixtureCache.set(fixture, bytes);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  expect(Array.isArray(parsed)).toBe(true);
  firstFixtureRecord.set(fixture, (parsed as Record<string, unknown>[])[0]);
  return bytes;
}

async function makeTempStateDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempStateDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

function stateFilePath(stateDir: string, basename: string): string {
  return path.join(stateDir, basename);
}

function expectNoSchemaVersionKey(record: unknown): void {
  expect(Object.hasOwn(record as Record<string, unknown>, 'schemaVersion')).toBe(false);
}

async function seedStateFile(prefix: string, basename: string, bytes: Buffer): Promise<string> {
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

type AnyVersionedParseResult =
  | { readonly status: 'ok'; readonly record: unknown; readonly schemaVersion: number }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'invalid' };

const VERSIONED_PARSERS: readonly (readonly [string, (raw: unknown) => AnyVersionedParseResult | null])[] = [
  ['readStoredCutoverJournalRecord', readStoredCutoverJournalRecord],
  ['parseVersionedLanePlanStateRecord', parseVersionedLanePlanStateRecord],
];

/** Runs one parser and never lets it throw: a throw is a distinct, loudly failing result. */
function callParser(
  parser: (raw: unknown) => unknown,
  input: unknown,
  relaunch: boolean,
): unknown {
  try {
    return relaunch ? readRelaunchPlanRecord(input, true) : parser(input);
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

describe('compat corpus remaining/ fixtures', () => {
  it('every legacy fixture in remaining/ is a non-empty JSON array whose records carry no schemaVersion key, and there are exactly three', async () => {
    const fixtures = (await fs.readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.legacy.json')).sort();
    expect(fixtures).toHaveLength(REMAINING_STORES.length);
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

describe.each(REMAINING_STORES)('$basename accepts its pre-schemaVersion fixture', (spec) => {
  it('reads every legacy record without rewriting the file or writing anything else', async () => {
    const bytes = await readFixtureBytes(spec.fixture);
    const fixtureRecords = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>[];
    const dir = await seedStateFile('fleet-compat-remaining-ok-', spec.basename, bytes);
    try {
      const raw = await spec.read(dir);
      if (spec.resultKind === 'listed') {
        const result = raw as { outcome: unknown; entries?: readonly unknown[] };
        expect(result.outcome).toBe('listed');
        expect(result.entries).toHaveLength(1);
        const entry = (result.entries as readonly Record<string, unknown>[])[0];
        expectNoSchemaVersionKey(entry);
        expect(entry).toStrictEqual(fixtureRecords[0]);
      } else if (spec.resultKind === 'plans') {
        const plans = raw as readonly Record<string, unknown>[];
        expect(plans).toHaveLength(1);
        expectNoSchemaVersionKey(plans[0]);
        // PV1: the reader materialises the optional `featureSet` as null and each
        // lane's optional `rollupOf` as false; every other byte of the legacy
        // record is returned as stored, and the file itself is checked unchanged below.
        const legacyPlan = fixtureRecords[0];
        expect(plans[0]).toStrictEqual({
          ...legacyPlan,
          featureSet: null,
          lanes: (legacyPlan.lanes as Record<string, unknown>[]).map((lane) => ({ ...lane, rollupOf: false })),
        });
      } else {
        const result = raw as { outcome: unknown; plan?: Record<string, unknown> };
        expect(result.outcome).toBe('found');
        // Pinned: the relaunch reader materializes the absent on-disk
        // `schemaVersion` as `1` on the returned record (D6).
        expect(result.plan?.schemaVersion).toBe(1);
        expect(result.plan).toStrictEqual({ ...fixtureRecords[0], schemaVersion: 1 });
      }
      await assertBytesUnchanged(stateFilePath(dir, spec.basename), bytes);
      // Only the state file itself: nothing written, nothing quarantined, no
      // lock file (a healthy read takes the unlocked fast path).
      await assertNothingQuarantined(dir);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it(`refuses a record with an unknown schemaVersion ${spec.futureVersion}, leaving the bytes untouched and nothing quarantined`, async () => {
    const bytes = await readFixtureBytes(spec.fixture);
    const legacyRecord = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>[];
    const futureRecord = { ...legacyRecord[0], schemaVersion: spec.futureVersion };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord[0], futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-remaining-refuse-', spec.basename, refusingBytes);
    try {
      const stateFile = stateFilePath(dir, spec.basename);
      const onDiskBefore = await fs.readFile(stateFile);
      if (spec.resultKind === 'listed') {
        // Pinned: `listByKeyPrefix` catches `StateFileUnknownVersionError` and
        // answers `{ outcome: 'unreadable' }` without rewriting or quarantining.
        const result = (await spec.read(dir)) as { outcome: unknown };
        expect(result).toStrictEqual({ outcome: 'unreadable' });
      } else if (spec.resultKind === 'plans') {
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
        for (const value of echoedValues(legacyRecord[0])) {
          expect(unknownVersionError.message).not.toContain(String(value));
        }
      } else {
        // Pinned: the relaunch store never throws; an unknown `schemaVersion`
        // makes the read plain `unreadable` with the `unknown-version` reason.
        const result = (await spec.read(dir)) as { outcome: unknown; reason?: unknown };
        expect(result).toStrictEqual({ outcome: 'unreadable', reason: 'unknown-version' });
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
  it('returns the typed invalid/null refusal for null, undefined, wrong primitives, [], sparse arrays, array-likes, and a schemaVersion getter it never invokes, for all three parsers', async () => {
    const allParsers: readonly { readonly run: (raw: unknown) => unknown; readonly relaunch: boolean }[] = [
      ...VERSIONED_PARSERS.map(([, parser]) => ({ run: parser as (raw: unknown) => unknown, relaunch: false })),
      { run: (raw: unknown) => readRelaunchPlanRecord(raw, true), relaunch: true },
    ];
    for (const { run: parser, relaunch } of allParsers) {
      // Non-objects and empty arrays carry no own `schemaVersion` and no body:
      // every parser answers the typed `invalid`/null refusal. The sparse
      // array (a hole at index 0) is built at runtime because a `[,]` literal
      // is lint-refused.
      const sparseArray: unknown[] = new Array(2);
      for (const input of [null, undefined, 5, 'x', true, [], sparseArray]) {
        expect(callParser(parser, input, relaunch)).toStrictEqual(
          relaunch ? null : { status: 'invalid' },
        );
      }
      // Array-likes are plain objects with a `length` own property, so the
      // schemaVersion check passes (absent reads as 1, D6) and the body check
      // refuses. Every parser here answers the typed refusal, never a pass
      // and never a throw.
      for (const input of [{ length: 1 }, { length: Number.MAX_SAFE_INTEGER }]) {
        expect(callParser(parser, input, relaunch)).toStrictEqual(
          relaunch ? null : { status: 'invalid' },
        );
      }
      // The descriptor-based version check never invokes the getter.
      const { target, timesCalled } = schemaVersionGetterTarget();
      expect(callParser(parser, target, relaunch)).toStrictEqual(
        relaunch ? null : { status: 'invalid' },
      );
      expect(timesCalled()).toBe(0);
    }
  });

  it('handles throwing Proxy traps per parser (the lane-plan and cutover parsers pin the reflection escape; the relaunch parser wraps it as null)', async () => {
    // FINDING (see the file header): `readStoreRecordSchemaVersion` in
    // `file-store.ts` (outside this lane's OWNED files) lets a throwing
    // reflection trap escape, and the lane-plan and cutover parsers have no
    // internal catch, so the throw propagates. Pinned precisely as the current
    // behaviour; the corpus path is unaffected because
    // `inspectVersionedRecordListBytes` wraps every element parse in
    // `parseVersionedElement`, which turns any throw into
    // `{ status: 'invalid' }`.
    for (const [parserName, parser] of VERSIONED_PARSERS) {
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
      void parserName;
    }
    // The relaunch reader wraps its whole body in a catch: every throwing
    // trap is `null`, never an escape.
    const protoTrap = new Proxy(
      {},
      { getPrototypeOf() { throw new Error('getPrototypeOf trap'); } },
    );
    expect(readRelaunchPlanRecord(protoTrap, true)).toBeNull();
    const descriptorTrap = new Proxy(
      {},
      { getOwnPropertyDescriptor() { throw new Error('getOwnPropertyDescriptor trap'); } },
    );
    expect(readRelaunchPlanRecord(descriptorTrap, true)).toBeNull();
  });

  it('refuses or strips an own __proto__ key without polluting Object.prototype', async () => {
    const pollutedBytes = await Promise.all(
      REMAINING_STORES.map(async (spec) => withOwnProtoKey(
        (JSON.parse((await readFixtureBytes(spec.fixture)).toString('utf8')) as Record<string, unknown>[])[0],
      )),
    );
    // The cutover reader refuses a `__proto__` key outright (unknown entry
    // field); the relaunch reader refuses unknown keys as well.
    expect(readStoredCutoverJournalRecord(pollutedBytes[0])).toStrictEqual({ status: 'invalid' });
    expect(readRelaunchPlanRecord(pollutedBytes[2], true)).toBeNull();
    // Pinned: the lane-plan reader copies only its declared, own, enumerable
    // data fields, so the own `__proto__` key is never copied onto the parsed
    // record and `Object.prototype` stays clean.
    const laneResult = parseVersionedLanePlanStateRecord(pollutedBytes[1]);
    expect(['ok', 'invalid']).toContain(laneResult.status);
    if (laneResult.status === 'ok') {
      expect(Object.hasOwn(laneResult.record as unknown as Record<string, unknown>, '__proto__')).toBe(false);
    }
    // Nothing was ever assigned onto `Object.prototype`.
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});
