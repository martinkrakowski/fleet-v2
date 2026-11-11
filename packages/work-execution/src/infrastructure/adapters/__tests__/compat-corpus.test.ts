/**
 * G1a stored-record compatibility corpus: the checked-in `*.legacy.json`
 * fixtures in `compat-fixtures/` are the on-disk shapes a pre-Q5a build wrote
 * (no `schemaVersion` key; absent reads as `1`, D6). Each store's read path
 * must accept its fixture, stamp nothing, rewrite nothing and quarantine
 * nothing; a synthetic unknown `schemaVersion` is refused with
 * `StateFileUnknownVersionError` and the file's bytes stay bit-identical.
 *
 * Future-lane rule (R6): when a writer bumps a record's `schemaVersion` to N,
 * that lane adds `<store>.v<N>.json` produced by the new writer, leaves every
 * older fixture byte-for-byte untouched, adds N to the store's
 * `acceptedVersions`, and adds a describe block here for the new fixture.
 * Older fixtures are never edited.
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
  ATTEMPT_STORE_VERSION_POLICY,
  AttemptRepositoryAdapter,
} from '../AttemptRepositoryAdapter.adapter.js';
import {
  LaneRunJournalAdapter,
  LANE_RUN_JOURNAL_STORE_VERSION_POLICY,
} from '../LaneRunJournalAdapter.adapter.js';
import {
  LaneRunRepositoryAdapter,
  LANE_RUN_STORE_VERSION_POLICY,
} from '../LaneRunRepositoryAdapter.adapter.js';
import {
  ExecutionJournalAdapter,
  JOURNAL_STORE_VERSION_POLICY,
  RESERVATION_STORE_VERSION_POLICY,
} from '../ExecutionJournalAdapter.adapter.js';

const FIXTURE_DIR = fileURLToPath(new URL('./compat-fixtures/', import.meta.url));

interface StoreSpec {
  readonly basename: string;
  readonly fixture: string;
  readonly policy: StoreSchemaVersionPolicy;
  readonly read: (stateDir: string) => Promise<readonly unknown[]>;
}

const RUN_0 = 'run-01JB0000000000000000000000';

const STORES: readonly StoreSpec[] = [
  {
    basename: 'attempts.json',
    fixture: 'attempts.legacy.json',
    policy: ATTEMPT_STORE_VERSION_POLICY,
    read: (dir) => new AttemptRepositoryAdapter({ stateDir: dir }).listAllAttempts(),
  },
  {
    basename: 'lane-runs.json',
    fixture: 'lane-runs.legacy.json',
    policy: LANE_RUN_STORE_VERSION_POLICY,
    read: (dir) => new LaneRunRepositoryAdapter({ stateDir: dir }).list(),
  },
  {
    basename: 'run-journal.json',
    fixture: 'run-journal.legacy.json',
    policy: LANE_RUN_JOURNAL_STORE_VERSION_POLICY,
    read: (dir) => new LaneRunJournalAdapter({ stateDir: dir }).listForRun(RUN_0),
  },
  {
    basename: 'journal.json',
    fixture: 'journal.legacy.json',
    policy: JOURNAL_STORE_VERSION_POLICY,
    read: (dir) => new ExecutionJournalAdapter({ stateDir: dir }).listJournalEntriesForAttempt('attempt-example-1'),
  },
  {
    basename: 'reservations.json',
    fixture: 'reservations.legacy.json',
    policy: RESERVATION_STORE_VERSION_POLICY,
    read: (dir) => new ExecutionJournalAdapter({ stateDir: dir }).listActiveReservations(),
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

/** The only entry next to a state file must be the state file itself: nothing was quarantined. */
async function assertNothingQuarantined(stateDir: string): Promise<void> {
  const entries = await fs.readdir(stateDir);
  expect(entries).toHaveLength(1);
}

describe('compat corpus fixtures', () => {
  it('every legacy fixture is a JSON array whose records carry no schemaVersion key', async () => {
    const fixtures = (await fs.readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.legacy.json'));
    expect(fixtures).toHaveLength(STORES.length);
    for (const fixture of fixtures) {
      const fixtureBytes = await readFixtureBytes(fixture);
      const parsed: unknown = JSON.parse(fixtureBytes.toString('utf8'));
      expect(Array.isArray(parsed)).toBe(true);
      for (const record of parsed as unknown[]) {
        expectNoSchemaVersionKey(record);
      }
    }
  });
});

describe.each(STORES)('$basename accepts its pre-Q5a fixture', (spec) => {
  it('reads every legacy record as schemaVersion 1 without rewriting the file', async () => {
    const bytes = await readFixtureBytes(spec.fixture);
    const dir = await seedStateFile('fleet-compat-ok-', spec.basename, bytes);
    try {
      const records = await spec.read(dir);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect((record as { schemaVersion?: unknown }).schemaVersion).toBe(1);
      }
      await assertBytesUnchanged(stateFilePath(dir, spec.basename), bytes);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it('refuses a record with an unknown schemaVersion, leaving the bytes untouched and nothing quarantined', async () => {
    const bytes = await readFixtureBytes(spec.fixture);
    const legacyRecord = JSON.parse(bytes.toString('utf8'))[0] as Record<string, unknown>;
    const futureRecord = { ...legacyRecord, schemaVersion: 2 };
    const refusingBytes = Buffer.from(JSON.stringify([legacyRecord, futureRecord]), 'utf8');
    const dir = await seedStateFile('fleet-compat-refuse-', spec.basename, refusingBytes);
    try {
      const stateFile = stateFilePath(dir, spec.basename);
      const onDiskBefore = await fs.readFile(stateFile);
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
      for (const value of echoedValues(legacyRecord)) {
        expect(unknownVersionError.message).not.toContain(String(value));
      }
      await assertNothingQuarantined(dir);
      await assertBytesUnchanged(stateFile, onDiskBefore);
    } finally {
      await removeTempStateDir(dir);
    }
  });

  it('declares a policy that accepts the writer version and the previous version', () => {
    const checked = assertValidSchemaVersionPolicy(spec.basename, spec.policy);
    expect(checked.acceptedVersions).toContain(checked.writerVersion);
    if (checked.writerVersion > 1) {
      expect(checked.acceptedVersions).toContain(checked.writerVersion - 1);
    }
  });
});
