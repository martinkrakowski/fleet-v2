import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  LaneRunJournalEntryKind,
  LaneRunJournalEntryRecord,
  LaneRunJournalOutcome,
} from '../../domain/lane-run-journal.js';
import {
  buildLaneRunStepKey,
  laneRunStopForceKey,
  laneRunStopKey,
} from '../../domain/lane-run-keys.js';
import type {
  LaneRunKeyVia,
  LaneRunStepKeyParts,
} from '../../domain/lane-run-keys.js';
import type { LaneRunStopKeyMode } from '../../domain/lane-run-keys.js';
import { LANE_RUN_KEY_ATTEMPT_RULE, LANE_RUN_KEY_HEAD_RULE } from '../../domain/lane-run-records.js';
import type { LaneRunKeyStep } from '../../domain/lane-run-records.js';
import { StateFileUnreadableError } from './file-store.js';
import { LaneRunJournalAdapter } from './LaneRunJournalAdapter.adapter.js';

let ulidCounter = 0;

/** A REQUEST_ID_PATTERN-conformant ULID (start 0, then 25 zero-padded digits). */
function nextUlid(): string {
  ulidCounter += 1;
  return `0${String(ulidCounter).padStart(25, '0')}`;
}

const RUN_ID = `run-${nextUlid()}`;

function stepKeyFor(step: LaneRunKeyStep): string {
  const parts: LaneRunStepKeyParts = {
    runId: RUN_ID,
    round: 0,
    step,
    seatIndex: 0,
    attemptOrdinal: LANE_RUN_KEY_ATTEMPT_RULE[step] === 'required' ? 1 : null,
    head12: LANE_RUN_KEY_HEAD_RULE[step] === 'required' ? '0123456789ab' : null,
    retry: null,
  };
  const built = buildLaneRunStepKey(parts);
  if (!built.ok) {
    throw new Error(built.error);
  }
  return built.key;
}

function baseEntry(
  kind: LaneRunJournalEntryKind,
  overrides: Partial<LaneRunJournalEntryRecord> = {},
): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId: nextUlid(),
    kind,
    key: null,
    runId: null,
    recordedAtIso: '2026-10-27T00:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
    ...overrides,
  };
}

function stepIntent(step: LaneRunKeyStep): LaneRunJournalEntryRecord {
  return baseEntry('intent', { key: stepKeyFor(step), runId: RUN_ID, mintedId: nextUlid() });
}

function resultEntry(key: string, outcome: LaneRunJournalOutcome): LaneRunJournalEntryRecord {
  return baseEntry('result', { key, runId: RUN_ID, outcome });
}

function conductEntry(): LaneRunJournalEntryRecord {
  return baseEntry('conduct', { runId: RUN_ID, state: 'running' });
}

function stopIntent(mode: LaneRunStopKeyMode, via: LaneRunKeyVia = 'web'): LaneRunJournalEntryRecord {
  const built = mode === 'force' ? laneRunStopForceKey(RUN_ID, via) : laneRunStopKey(RUN_ID, via);
  if (!built.ok) {
    throw new Error(built.error);
  }
  return baseEntry('intent', { key: built.key, runId: RUN_ID, mode, expectedRevision: 3 });
}

describe('LaneRunJournalAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-run-journal-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function adapterFor(mode: 'memory' | 'file'): LaneRunJournalAdapter {
    return mode === 'memory' ? new LaneRunJournalAdapter() : new LaneRunJournalAdapter({ stateDir: tempDir });
  }

  function concurrentAdapters(mode: 'memory' | 'file', count: number): LaneRunJournalAdapter[] {
    const memory = new LaneRunJournalAdapter();
    return Array.from({ length: count }, () =>
      mode === 'memory' ? memory : new LaneRunJournalAdapter({ stateDir: tempDir }),
    );
  }

  describe.each(['memory', 'file'] as const)('%s store', (mode) => {
    it('appends intents, results and conduct in order; lists per run and key; refusals write nothing', async () => {
      const adapter = adapterFor(mode);

      const dispatchKey = stepKeyFor('dispatch');
      const collectKey = stepKeyFor('collect');

      const intent1 = stepIntent('dispatch');
      const result1 = resultEntry(dispatchKey, 'completed');
      const intent2 = stepIntent('collect');
      const result2a = resultEntry(collectKey, 'ambiguous');
      const result2b = resultEntry(collectKey, 'completed');
      const conduct = conductEntry();

      await expect(adapter.append(intent1)).resolves.toEqual({ outcome: 'appended', entry: intent1 });
      await expect(adapter.append(result1)).resolves.toMatchObject({ outcome: 'appended' });
      await expect(adapter.append(intent2)).resolves.toMatchObject({ outcome: 'appended' });
      await expect(adapter.append(result2a)).resolves.toMatchObject({ outcome: 'appended' });
      await expect(adapter.append(result2b)).resolves.toMatchObject({ outcome: 'appended' });
      await expect(adapter.append(conduct)).resolves.toMatchObject({ outcome: 'appended' });

      const runEntries = await adapter.listForRun(RUN_ID);
      expect(runEntries.map((entry) => entry.entryId)).toEqual([
        intent1.entryId,
        result1.entryId,
        intent2.entryId,
        result2a.entryId,
        result2b.entryId,
        conduct.entryId,
      ]);

      const collectEntries = await adapter.listForKey(collectKey);
      expect(collectEntries.map((entry) => entry.entryId)).toEqual([
        intent2.entryId,
        result2a.entryId,
        result2b.entryId,
      ]);

      expect(await adapter.listForRun(`run-${nextUlid()}`)).toEqual([]);
      expect(await adapter.listForRun('not-a-run-id')).toEqual([]);
      expect(await adapter.listForRun(123 as unknown as string)).toEqual([]);
      expect(await adapter.listForKey('no-such-key')).toEqual([]);

      await expect(adapter.append(stepIntent('dispatch'))).resolves.toEqual({
        outcome: 'refused',
        reason: 'duplicate-key',
        detail: null,
      });

      await expect(adapter.append(resultEntry(stepKeyFor('gate'), 'completed'))).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'result-without-intent',
      });

      await expect(adapter.append(resultEntry(collectKey, 'refused'))).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'result-after-final',
      });

      await expect(adapter.append(intent1)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'duplicate-entry-id',
      });

      const gracefulStopBuilt = laneRunStopKey(RUN_ID, 'web');
      if (!gracefulStopBuilt.ok) {
        throw new Error(gracefulStopBuilt.error);
      }
      const gracefulStopKey = gracefulStopBuilt.key;
      await expect(
        adapter.append(baseEntry('intent', { key: gracefulStopKey, runId: RUN_ID, mode: 'force', expectedRevision: 3 })),
      ).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'stop-mode-mismatch',
      });

      await expect(adapter.append({ ...stepIntent('collect'), kind: 'bogus' } as unknown as LaneRunJournalEntryRecord)).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'invalid-entry',
      });

      await expect(adapter.append(stopIntent('graceful', 'web'))).resolves.toMatchObject({ outcome: 'appended' });
      await expect(adapter.append(stopIntent('graceful', 'cli'))).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'stop-already-requested',
      });

      await expect(adapter.append(stopIntent('force', 'web'))).resolves.toMatchObject({ outcome: 'appended' });
      await expect(adapter.append(stopIntent('graceful', 'cli'))).resolves.toMatchObject({
        outcome: 'refused',
        reason: 'stop-already-forced',
      });

      expect((await adapter.listForKey(dispatchKey)).map((entry) => entry.entryId)).toEqual([
        intent1.entryId,
        result1.entryId,
      ]);
      expect((await adapter.listForKey(collectKey)).map((entry) => entry.entryId)).toEqual([
        intent2.entryId,
        result2a.entryId,
        result2b.entryId,
      ]);
    });

    it('returns fresh copies; mutating returned entries does not change the store', async () => {
      const adapter = adapterFor(mode);
      const intent = stepIntent('collect');
      await adapter.append(intent);

      const listed = await adapter.listForKey(stepKeyFor('collect'));
      expect(listed).toHaveLength(1);
      const tamperedListed = listed[0] as unknown as { key: string; mode: string | null };
      tamperedListed.key = 'tampered-key';
      tamperedListed.mode = 'force';

      const again = await adapter.listForKey(stepKeyFor('collect'));
      expect(again[0]).toMatchObject({ key: stepKeyFor('collect'), mode: null, entryId: intent.entryId });

      const appended = await adapter.append(stepIntent('gate'));
      if (appended.outcome === 'appended') {
        (appended.entry as unknown as { entryId: string }).entryId = 'tampered-entry-id';
      }
      const runList = await adapter.listForRun(RUN_ID);
      expect(runList.some((entry) => entry.entryId === 'tampered-entry-id')).toBe(false);
    });

    it('ten concurrent appends of the same step-key intent leave exactly one appended', async () => {
      const adapters = concurrentAdapters(mode, 10);
      const results = await Promise.all(adapters.map((adapter) => adapter.append(stepIntent('dispatch'))));

      const appended = results.filter((result) => result.outcome === 'appended');
      const refused = results.filter((result) => result.outcome === 'refused');
      expect(appended).toHaveLength(1);
      expect(refused).toHaveLength(9);
      for (const result of refused) {
        expect(result.reason).toBe('duplicate-key');
      }
      expect(await adapters[0]!.listForKey(stepKeyFor('dispatch'))).toHaveLength(1);
    });

    it('two stops for one run at once never both pass', async () => {
      const adapters = concurrentAdapters(mode, 2);

      const graceful = await Promise.all([
        adapters[0]!.append(stopIntent('graceful', 'web')),
        adapters[1]!.append(stopIntent('graceful', 'cli')),
      ]);
      expect(graceful.filter((result) => result.outcome === 'appended')).toHaveLength(1);
      expect(graceful.filter((result) => result.outcome === 'refused')).toHaveLength(1);
      expect(graceful.find((result) => result.outcome === 'refused')!.reason).toBe('stop-already-requested');

      const forced = await Promise.all([
        adapters[0]!.append(stopIntent('force', 'web')),
        adapters[1]!.append(stopIntent('force', 'cli')),
      ]);
      expect(forced.filter((result) => result.outcome === 'appended')).toHaveLength(1);
      expect(forced.filter((result) => result.outcome === 'refused')).toHaveLength(1);
      expect(forced.find((result) => result.outcome === 'refused')!.reason).toBe('stop-already-requested');
    });

    it('a graceful and a force stop at once: both when the graceful lands first, else the graceful is forced', async () => {
      const adapters = concurrentAdapters(mode, 2);

      const results = await Promise.all([
        adapters[0]!.append(stopIntent('graceful', 'web')),
        adapters[1]!.append(stopIntent('force', 'cli')),
      ]);

      const appended = results.filter((result) => result.outcome === 'appended');
      const refused = results.filter((result) => result.outcome === 'refused');
      const gracefulAppended = appended.some((result) => result.entry.mode === 'graceful');
      expect(appended.some((result) => result.entry.mode === 'force')).toBe(true);

      if (gracefulAppended) {
        expect(appended).toHaveLength(2);
        expect(refused).toHaveLength(0);
      } else {
        expect(appended).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]!.reason).toBe('stop-already-forced');
      }

      const stopIntents = (await adapters[0]!.listForRun(RUN_ID)).filter((entry) => entry.mode !== null);
      expect(stopIntents.filter((entry) => entry.mode === 'force')).toHaveLength(1);
      expect(stopIntents.filter((entry) => entry.mode === 'graceful')).toHaveLength(gracefulAppended ? 1 : 0);
    });
  });

  describe('file-only behaviors', () => {
    it('lists with a fresh adapter what the first wrote, equal entry by entry; the file is a JSON array', async () => {
      const first = new LaneRunJournalAdapter({ stateDir: tempDir });
      const entries = [stepIntent('dispatch'), resultEntry(stepKeyFor('dispatch'), 'completed'), conductEntry()];
      for (const entry of entries) {
        await first.append(entry);
      }

      const fresh = new LaneRunJournalAdapter({ stateDir: tempDir });
      await expect(fresh.listForRun(RUN_ID)).resolves.toEqual(await first.listForRun(RUN_ID));

      const parsed = JSON.parse(await fs.readFile(path.join(tempDir, 'run-journal.json'), 'utf8')) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed as unknown[]).toHaveLength(entries.length);
    });

    it('reads a pre-KF-14a journal file whose entries carry no detail as detail null', async () => {
      const legacy = { ...stepIntent('dispatch') } as Record<string, unknown>;
      delete legacy.detail;
      await fs.writeFile(path.join(tempDir, 'run-journal.json'), JSON.stringify([legacy]), 'utf8');

      const adapter = new LaneRunJournalAdapter({ stateDir: tempDir });
      const entries = await adapter.listForRun(RUN_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.detail).toBeNull();
    });

    it('quarantines a file holding one invalid entry or not JSON, keeping the exact bytes', async () => {
      const bad = JSON.stringify([{ bogus: true }]);
      await fs.writeFile(path.join(tempDir, 'run-journal.json'), bad, 'utf8');

      const adapter = new LaneRunJournalAdapter({ stateDir: tempDir });
      await expect(adapter.append(stepIntent('dispatch'))).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expect(adapter.listForRun(RUN_ID)).rejects.toBeInstanceOf(StateFileUnreadableError);

      const quarantineDir = path.join(tempDir, 'quarantine');
      const copies = await fs.readdir(quarantineDir);
      expect(copies).toHaveLength(1);
      expect(await fs.readFile(path.join(quarantineDir, copies[0]!), 'utf8')).toBe(bad);

      await fs.writeFile(path.join(tempDir, 'run-journal.json'), '{ not json', 'utf8');
      await expect(adapter.listForKey('anything')).rejects.toBeInstanceOf(StateFileUnreadableError);
    });

    it('refuses file names that collide with another store or are unsafe', async () => {
      const colliding = new LaneRunJournalAdapter({ stateDir: tempDir, fileName: 'journal.json' });
      await expect(colliding.listForRun(RUN_ID)).rejects.toThrow(/collides with another store/);

      const escaping = new LaneRunJournalAdapter({ stateDir: tempDir, fileName: '../x.json' });
      await expect(escaping.listForRun(RUN_ID)).rejects.toThrow(/unsafe state file name/);
    });
  });
});
