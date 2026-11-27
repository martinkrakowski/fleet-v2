/**
 * FC1C stored-record compatibility corpus for `orchestrator-requests.json`
 * in `@fleet/operator-coordination`.
 *
 * The checked-in fixture `compat-fixtures/orchestrator-requests.legacy.json`
 * is exactly `initialRequest()`'s fields (OrchestratorRequestRepositoryAdapter.test.ts)
 * with the `schemaVersion` key removed (D6: an absent `schemaVersion` reads
 * as `1` forever) — the bytes a pre-schemaVersion build of fleet-v2 wrote.
 *
 * The read path must accept the fixture, stamp nothing, rewrite nothing and
 * quarantine nothing. A synthetic unknown `schemaVersion: 2` is refused as
 * `{ outcome: 'unknown', code: 'unknown-schema-version' }` without throwing,
 * rewriting or quarantining.
 *
 * Cost bounds: the fixture is a single minimal record (a few hundred bytes,
 * far under the 16 MiB store cap), so fixture parsing, field scans and every
 * per-input check below are O(N) in that small fixture size with no unbounded
 * loops. Each hostile input is a fresh handful of keys, so the per-parser
 * table is O(1) in record size and O(K) in the K pinned cases.
 *
 * Hostile-input pin: `readStoreRecordSchemaVersion` (file-store.ts, outside
 * this lane's OWNED files) lets a throwing `getPrototypeOf` or
 * `getOwnPropertyDescriptor` reflection trap escape, but
 * `parseVersionedOrchestratorRequestStateRecord` wraps its whole body in a
 * catch and answers `{ status: 'invalid' }` — the throw never escapes.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertValidSchemaVersionPolicy,
  type StoreSchemaVersionPolicy,
} from '../file-store.js';
import {
  ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY,
  OrchestratorRequestRepositoryAdapter,
  parseVersionedOrchestratorRequestStateRecord,
} from '../OrchestratorRequestRepositoryAdapter.adapter.js';

const FIXTURE_DIR = fileURLToPath(new URL('./compat-fixtures/', import.meta.url));
const FIXTURE = 'orchestrator-requests.legacy.json';
const STORE_BASENAME = 'orchestrator-requests.json';

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

async function seedStateFile(prefix: string, basename: string, bytes: Buffer): Promise<string> {
  const dir = await makeTempStateDir(prefix);
  await fs.writeFile(stateFilePath(dir, basename), bytes);
  return dir;
}

async function assertBytesUnchanged(stateFile: string, before: Buffer): Promise<void> {
  const after = await fs.readFile(stateFile);
  expect(Buffer.compare(before, after)).toBe(0);
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

/** Runs one parser and never lets it throw: a throw is a distinct, loudly failing result. */
function callParser(input: unknown): unknown {
  try {
    return parseVersionedOrchestratorRequestStateRecord(input);
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

describe('compat corpus orchestrator-requests fixtures', () => {
  it('the single legacy fixture is a non-empty JSON array whose records carry no schemaVersion key', async () => {
    const fixtures = (await fs.readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.legacy.json'));
    expect(fixtures).toStrictEqual([FIXTURE]);
    const parsed: unknown = JSON.parse((await readFixtureBytes(FIXTURE)).toString('utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    const records = parsed as unknown[];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expectNoSchemaVersionKey(record);
    }
  });
});

describe('orchestrator-requests.json accepts its pre-schemaVersion fixture', () => {
  it('reads the legacy record as schemaVersion 1 without rewriting the file or writing anything else', async () => {
    const bytes = await readFixtureBytes(FIXTURE);
    const fixtureRecords = parseFixtureRecords(bytes);
    const dir = await seedStateFile('fleet-compat-orch-ok-', STORE_BASENAME, bytes);
    try {
      const result = await new OrchestratorRequestRepositoryAdapter({ stateDir: dir }).list();
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      expect(result.truncated).toBe(false);
      expect(result.requests.length).toBe(fixtureRecords.length);
      for (const [index, record] of result.requests.entries()) {
        expectNoSchemaVersionKey(record);
        expect(record).toStrictEqual(fixtureRecords[index]);
      }
      await assertBytesUnchanged(stateFilePath(dir, STORE_BASENAME), bytes);
      await assertNothingQuarantined(dir);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it('refuses a record with an unknown schemaVersion, leaving the bytes untouched and nothing quarantined', async () => {
    const bytes = await readFixtureBytes(FIXTURE);
    const legacyRecord = parseFixtureRecords(bytes)[0];
    const futureRecord = { ...legacyRecord, schemaVersion: 2 };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord, futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-orch-refuse-', STORE_BASENAME, refusingBytes);
    try {
      const stateFile = stateFilePath(dir, STORE_BASENAME);
      const onDiskBefore = await fs.readFile(stateFile);
      const result = await new OrchestratorRequestRepositoryAdapter({ stateDir: dir }).list();
      expect(result).toStrictEqual({ outcome: 'unknown', code: 'unknown-schema-version' });
      await assertNothingQuarantined(dir);
      await assertBytesUnchanged(stateFile, onDiskBefore);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it('declares a policy that accepts the writer version and the previous version, and refuses a version-dropping bump', () => {
    const policy: StoreSchemaVersionPolicy = ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY;
    const checked = assertValidSchemaVersionPolicy(STORE_BASENAME, policy);
    expect(checked.acceptedVersions).toContain(checked.writerVersion);
    if (checked.writerVersion > 1) {
      expect(checked.acceptedVersions).toContain(checked.writerVersion - 1);
    }
    // Bumping `writerVersion` to 2 without keeping 1 in `acceptedVersions` is
    // refused, naming the store and the missing previous version 1.
    let bumpError: unknown;
    try {
      assertValidSchemaVersionPolicy(STORE_BASENAME, { writerVersion: 2, acceptedVersions: [2] });
    } catch (caught) {
      bumpError = caught;
    }
    expect(bumpError).toBeInstanceOf(Error);
    const bumpMessage = (bumpError as Error).message;
    expect(bumpMessage).toContain(STORE_BASENAME);
    expect(bumpMessage).toContain('schemaVersion 1');
  });
});

describe('hostile inputs on parseVersionedOrchestratorRequestStateRecord', () => {
  it('returns the typed invalid refusal for null, undefined, wrong primitives, [], sparse arrays, array-likes, and a schemaVersion getter it never invokes', () => {
    // Non-objects and empty arrays carry no own `schemaVersion` and no body:
    // the parser answers the typed `invalid` result. The sparse array (a hole
    // at index 0) is built at runtime because a `[,]` literal is lint-refused.
    const sparseArray: unknown[] = new Array(2);
    for (const input of [null, undefined, 5, 'x', true, [], sparseArray]) {
      expect(callParser(input)).toStrictEqual({ status: 'invalid' });
    }
    // Array-likes are plain objects with a `length` own property: the absent
    // `schemaVersion` reads as 1 (D6) and the body check refuses.
    for (const input of [{ length: 1 }, { length: Number.MAX_SAFE_INTEGER }]) {
      expect(callParser(input)).toStrictEqual({ status: 'invalid' });
    }
    // The descriptor-based version check never invokes the getter.
    const { target, timesCalled } = schemaVersionGetterTarget();
    expect(callParser(target)).toStrictEqual({ status: 'invalid' });
    expect(timesCalled()).toBe(0);
  });

  it('handles throwing Proxy traps per parser (the orchestrator parser wraps them as invalid)', () => {
    // The parser wraps its whole body in a catch: every throwing reflection
    // trap from `readStoreRecordSchemaVersion` is the typed `invalid` result,
    // never an escape.
    const protoTrap = new Proxy(
      {},
      { getPrototypeOf() { throw new Error('getPrototypeOf trap'); } },
    );
    expect(callParser(protoTrap)).toStrictEqual({ status: 'invalid' });
    const descriptorTrap = new Proxy(
      {},
      { getOwnPropertyDescriptor() { throw new Error('getOwnPropertyDescriptor trap'); } },
    );
    expect(callParser(descriptorTrap)).toStrictEqual({ status: 'invalid' });
  });

  it('refuses or strips an own __proto__ key without polluting Object.prototype', async () => {
    const polluted = withOwnProtoKey(parseFixtureRecords(await readFixtureBytes(FIXTURE))[0]);
    const result = callParser(polluted) as Extract<AnyVersionedParseResult, { status: 'ok' }> | { status: 'invalid' };
    // Pinned: the reader copies only declared, own, enumerable data fields, so
    // the own `__proto__` key is never copied onto the parsed record and
    // `Object.prototype` stays clean.
    expect(['ok', 'invalid']).toContain(result.status);
    if (result.status === 'ok') {
      expect(Object.hasOwn(result.record as unknown as Record<string, unknown>, '__proto__')).toBe(false);
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});
