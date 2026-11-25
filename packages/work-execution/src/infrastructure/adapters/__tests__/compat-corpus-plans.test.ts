/**
 * Stored-record compatibility corpus for lane plans, relaunch plans and seat
 * observations. The `*.legacy.json` fixtures in `compat-fixtures/plans/` are
 * writer output with only the `schemaVersion` key removed (D6: absent reads
 * as `1`). Each read accepts its fixture, rewrites nothing and quarantines
 * nothing. An unknown `schemaVersion` is refused and the bytes stay
 * bit-identical.
 *
 * Null, a missing file, a non-iterable, an array hole, a wrong primitive, a
 * getter, an array-like, an enormous length and a prototype-polluting key are
 * refused by `readStoreRecordSchemaVersion` (`invalid`, getters never run)
 * and `inspectVersionedRecordListBytes` (`unreadable` or `unknown-version`).
 * This file does not re-test those cases; `compat-corpus.test.ts` does not
 * either. A Proxy that lies consistently in every trap stays an accepted
 * residual of those readers.
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
  LANE_PLAN_STORE_VERSION_POLICY,
  LanePlanRepositoryAdapter,
} from '../LanePlanRepositoryAdapter.adapter.js';
import {
  RELAUNCH_PLAN_STORE_VERSION_POLICY,
  RelaunchPlanRepositoryAdapter,
} from '../RelaunchPlanRepositoryAdapter.adapter.js';
import {
  SEAT_OBSERVATION_STORE_VERSION_POLICY,
  SeatObservationRepositoryAdapter,
} from '../SeatObservationRepositoryAdapter.adapter.js';

const FIXTURE_DIR = fileURLToPath(new URL('./compat-fixtures/plans/', import.meta.url));

interface StoreSpec {
  readonly basename: string;
  readonly fixture: string;
  readonly policy: StoreSchemaVersionPolicy;
}

const STORES: readonly StoreSpec[] = [
  {
    basename: 'lane-plans.json',
    fixture: 'lane-plans.legacy.json',
    policy: LANE_PLAN_STORE_VERSION_POLICY,
  },
  {
    basename: 'relaunch-plans.json',
    fixture: 'relaunch-plans.legacy.json',
    policy: RELAUNCH_PLAN_STORE_VERSION_POLICY,
  },
  {
    basename: 'seat-observations.json',
    fixture: 'seat-observations.legacy.json',
    policy: SEAT_OBSERVATION_STORE_VERSION_POLICY,
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

async function readFixtureRecords(fixture: string): Promise<Record<string, unknown>[]> {
  const parsed: unknown = JSON.parse((await readFixtureBytes(fixture)).toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${fixture} must be a non-empty JSON array`);
  }
  return parsed as Record<string, unknown>[];
}

/**
 * Writes `bytes` as the store's state file in a fresh temp state directory and
 * returns the directory; the caller removes it in `finally`.
 */
async function seedStateFile(prefix: string, basename: string, bytes: Buffer): Promise<string> {
  const dir = await makeTempStateDir(prefix);
  await fs.writeFile(stateFilePath(dir, basename), bytes);
  return dir;
}

/** Top-level strings long enough to be identifiable if an error echoed them. */
function echoedValues(record: Record<string, unknown>): readonly string[] {
  return Object.values(record).filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  );
}

function withoutSchemaVersion(record: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy.schemaVersion;
  return copy;
}

describe('compat corpus fixtures for plans', () => {
  // Cost: O(fixture files × records), bounded by the 3 checked-in fixtures.
  it('every legacy fixture in plans/ is a non-empty JSON array whose records carry no schemaVersion key', async () => {
    const fixtures = (await fs.readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.legacy.json'));
    expect(fixtures).toHaveLength(STORES.length);
    for (const spec of STORES) {
      expect(fixtures).toContain(spec.fixture);
    }
    for (const fixture of fixtures) {
      const parsed: unknown = JSON.parse((await readFixtureBytes(fixture)).toString('utf8'));
      expect(Array.isArray(parsed)).toBe(true);
      const records = parsed as unknown[];
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(Object.hasOwn(record as Record<string, unknown>, 'schemaVersion')).toBe(false);
      }
    }
  });
});

describe('lane-plans.json', () => {
  // Cost: one bounded read of the checked-in fixture. No second pass.
  it('reads the legacy lane plans as the fixture records, leaving the bytes untouched and nothing quarantined', async () => {
    const bytes = await readFixtureBytes('lane-plans.legacy.json');
    const fixture = await readFixtureRecords('lane-plans.legacy.json');
    const dir = await seedStateFile('fleet-compat-plans-ok-', 'lane-plans.json', bytes);
    try {
      const stateFile = stateFilePath(dir, 'lane-plans.json');
      const onDiskBefore = await fs.readFile(stateFile);
      const records = await new LanePlanRepositoryAdapter({ stateDir: dir }).listLanePlans();
      expect(records).toEqual(fixture);
      for (const record of records) {
        expect(Object.hasOwn(record, 'schemaVersion')).toBe(false);
      }
      expect(await fs.readdir(dir)).toHaveLength(1);
      expect(Buffer.compare(onDiskBefore, await fs.readFile(stateFile))).toBe(0);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  // Observed: listLanePlans throws StateFileUnknownVersionError for the
  // unknown-version record and does not quarantine (readRecordsFromDisk
  // returns before any lock or rewrite).
  // Cost: one bounded read of a two-record file.
  it('refuses a record with an unknown schemaVersion, leaving the bytes untouched and nothing quarantined', async () => {
    const legacyRecord = (await readFixtureRecords('lane-plans.legacy.json'))[0] as Record<string, unknown>;
    const futureRecord = { ...legacyRecord, schemaVersion: 2 };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord, futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-plans-refuse-', 'lane-plans.json', refusingBytes);
    try {
      const stateFile = stateFilePath(dir, 'lane-plans.json');
      const onDiskBefore = await fs.readFile(stateFile);
      let error: unknown;
      try {
        await new LanePlanRepositoryAdapter({ stateDir: dir }).listLanePlans();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StateFileUnknownVersionError);
      const unknownVersionError = error as StateFileUnknownVersionError;
      expect(unknownVersionError.recordIndex).toBe(1);
      expect(unknownVersionError.message).toContain('unsupported schemaVersion');
      expect(unknownVersionError.message).toContain('record 1');
      for (const value of echoedValues(legacyRecord)) {
        expect(unknownVersionError.message).not.toContain(value);
      }
      expect(await fs.readdir(dir)).toHaveLength(1);
      expect(Buffer.compare(onDiskBefore, await fs.readFile(stateFile))).toBe(0);
    } finally {
      await removeTempStateDir(dir);
    }
  });
});

describe('relaunch-plans.json', () => {
  // Cost: one bounded read of the checked-in fixture. The returned plan is
  // one record; digest matching hashes that record once.
  it('reads the legacy relaunch plan as schemaVersion 1, leaving the bytes untouched and nothing quarantined', async () => {
    const bytes = await readFixtureBytes('relaunch-plans.legacy.json');
    const fixture = await readFixtureRecords('relaunch-plans.legacy.json');
    const legacy = fixture[0] as Record<string, unknown>;
    const dir = await seedStateFile('fleet-compat-plans-ok-', 'relaunch-plans.json', bytes);
    try {
      const stateFile = stateFilePath(dir, 'relaunch-plans.json');
      const onDiskBefore = await fs.readFile(stateFile);
      const result = await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).findByDigest(
        String(legacy.planDigest),
      );
      expect(result.outcome).toBe('found');
      if (result.outcome !== 'found') {
        return;
      }
      expect(result.plan.schemaVersion).toBe(1);
      expect(withoutSchemaVersion(result.plan)).toEqual(legacy);
      expect(await fs.readdir(dir)).toHaveLength(1);
      expect(Buffer.compare(onDiskBefore, await fs.readFile(stateFile))).toBe(0);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  // Observed: findByDigest does not throw. An unknown schemaVersion is
  // reported as { outcome: 'unreadable', reason: 'unknown-version' }
  // (readFromDisk), and the file is not quarantined. Matches the adapter
  // header: an unknown schema version is reported, never read as empty.
  // Cost: one bounded read of a two-record file.
  it('refuses a record with an unknown schemaVersion, leaving the bytes untouched and nothing quarantined', async () => {
    const legacyRecord = (await readFixtureRecords('relaunch-plans.legacy.json'))[0] as Record<string, unknown>;
    const futureRecord = { ...legacyRecord, schemaVersion: 2 };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord, futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-plans-refuse-', 'relaunch-plans.json', refusingBytes);
    try {
      const stateFile = stateFilePath(dir, 'relaunch-plans.json');
      const onDiskBefore = await fs.readFile(stateFile);
      const result = await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).findByDigest(
        String(legacyRecord.planDigest),
      );
      expect(result).toEqual({ outcome: 'unreadable', reason: 'unknown-version' });
      expect(await fs.readdir(dir)).toHaveLength(1);
      expect(Buffer.compare(onDiskBefore, await fs.readFile(stateFile))).toBe(0);
    } finally {
      await removeTempStateDir(dir);
    }
  });
});

describe('seat-observations.json', () => {
  // Cost: one bounded read of the checked-in fixture. No second pass.
  it('reads the legacy seat observations with version 1 and no schemaVersion key, leaving the bytes untouched and nothing quarantined', async () => {
    const bytes = await readFixtureBytes('seat-observations.legacy.json');
    const fixture = await readFixtureRecords('seat-observations.legacy.json');
    const dir = await seedStateFile('fleet-compat-plans-ok-', 'seat-observations.json', bytes);
    try {
      const stateFile = stateFilePath(dir, 'seat-observations.json');
      const onDiskBefore = await fs.readFile(stateFile);
      const records = await new SeatObservationRepositoryAdapter({ stateDir: dir }).listSeatObservations();
      expect(records).toEqual(fixture);
      for (const record of records) {
        expect(Object.hasOwn(record, 'schemaVersion')).toBe(false);
        expect(record.version).toBe(1);
      }
      expect(await fs.readdir(dir)).toHaveLength(1);
      expect(Buffer.compare(onDiskBefore, await fs.readFile(stateFile))).toBe(0);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  // Observed: listSeatObservations throws StateFileUnknownVersionError on the
  // fast path, before any lock or quarantine copy
  // (readOrQuarantineVersionedRecordList).
  // Cost: one bounded read of a two-record file.
  it('refuses a record with an unknown schemaVersion, leaving the bytes untouched and nothing quarantined', async () => {
    const legacyRecord = (await readFixtureRecords('seat-observations.legacy.json'))[0] as Record<
      string,
      unknown
    >;
    const futureRecord = { ...legacyRecord, schemaVersion: 2 };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord, futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-plans-refuse-', 'seat-observations.json', refusingBytes);
    try {
      const stateFile = stateFilePath(dir, 'seat-observations.json');
      const onDiskBefore = await fs.readFile(stateFile);
      let error: unknown;
      try {
        await new SeatObservationRepositoryAdapter({ stateDir: dir }).listSeatObservations();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StateFileUnknownVersionError);
      const unknownVersionError = error as StateFileUnknownVersionError;
      expect(unknownVersionError.recordIndex).toBe(1);
      expect(unknownVersionError.message).toContain('unsupported schemaVersion');
      expect(unknownVersionError.message).toContain('record 1');
      for (const value of echoedValues(legacyRecord)) {
        expect(unknownVersionError.message).not.toContain(value);
      }
      expect(await fs.readdir(dir)).toHaveLength(1);
      expect(Buffer.compare(onDiskBefore, await fs.readFile(stateFile))).toBe(0);
    } finally {
      await removeTempStateDir(dir);
    }
  });
});

describe.each(STORES)('$basename', (spec) => {
  // Cost: O(1) over a fixed-size acceptedVersions list. No I/O.
  // The live policies are writerVersion 1, so the previous-version rule is
  // pinned by the synthetic writerVersion 2 bump below.
  it('declares a policy that accepts the writer version and the previous version', () => {
    const checked = assertValidSchemaVersionPolicy(spec.basename, spec.policy);
    expect(checked.acceptedVersions).toContain(checked.writerVersion);
    if (checked.writerVersion > 1) {
      expect(checked.acceptedVersions).toContain(checked.writerVersion - 1);
    }
    expect(() =>
      assertValidSchemaVersionPolicy(spec.basename, { writerVersion: 2, acceptedVersions: [2] }),
    ).toThrow('reader must still accept previous schemaVersion 1');
  });
});
