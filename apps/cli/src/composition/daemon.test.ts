// KA3-1: the daemon composition wires the killall halt marker and the killall
// train pause as read-only, durable handles — a halted or paused marker stops
// the tick and the merge pass without the daemon mutating the marker files —
// and stays in-memory (writable) without a state directory, mirroring
// `statusReadOnly`.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { composeDaemon } from './daemon.js';
import type { ComposeDaemonInput } from './daemon.js';
import { MergeQueueRepositoryAdapter, mergeQueueRepositoryDigest } from '@fleet/work-execution';

const NOW = '2026-11-01T12:00:00.000Z';
// The merge-queue adapter validates a command's deadline against the real
// host clock, so the fixture enqueue uses a fresh deadline.
const FRESH_NOW = new Date().toISOString();
const FRESH_DEADLINE = new Date(Date.now() + 600_000).toISOString();

const haltedMarkerBytes = JSON.stringify({
  version: 1,
  halted: true,
  changedAtIso: NOW,
});

const clearConductorHalt = {
  read: async () => ({ state: 'clear', record: null }),
};

function makeInput(overrides: Partial<ComposeDaemonInput> = {}): ComposeDaemonInput {
  return {
    stateDir: undefined,
    options: {
      daemonNow: () => NOW,
      daemonSleep: async () => undefined,
      loadInstallationForMergePolicy: () => ({ status: 'invalid', file: 'installation.json', errors: [] }),
    },
    installationModel: undefined,
    forgeMode: 'github',
    mergeForgeRead: {
      isConfigured: () => true,
      async readForgeMerge() {
        return {
          baseRef: 'main',
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          statuses: [],
          headRefOid: null,
        };
      },
    } as unknown as ComposeDaemonInput['mergeForgeRead'],
    mergeQueueRepository: new MergeQueueRepositoryAdapter(),
    chainBranchRead: {
      async readMergeBranchHead() {
        return { outcome: 'refused', reason: 'not-configured' } as never;
      },
    } as unknown as ComposeDaemonInput['chainBranchRead'],
    evidence: {
      inspectAcceptanceEvidence: async () => {
        throw new Error('not used in these tests');
      },
      requestVerification: async () => {
        throw new Error('not used in these tests');
      },
    } as unknown as ComposeDaemonInput['evidence'],
    conductor: {
      laneRunJournal: {
        append: async () => {
          throw new Error('not used in these tests');
        },
        listForRun: async () => [],
        listForKey: async () => [],
      },
      halt: clearConductorHalt,
    } as unknown as ComposeDaemonInput['conductor'],
    runGh: async () => ({ exitCode: 1, stdout: '' }),
    chainAttention: {
      recordAttentionItem: async () => undefined,
      clearAttentionItem: async () => undefined,
    },
    trainHealthAttention: {
      recordAttentionItem: async () => undefined,
      clearAttentionItem: async () => undefined,
      listAttentionItems: async () => [],
    },
    ...overrides,
  } as ComposeDaemonInput;
}

afterAll(() => {});

describe('composeDaemon killall marker wiring (KA3-1)', () => {
  it('composeDaemon wires killallHalt and killallTrainPause read-only when stateDir is set so halted or paused markers stop tick and merge pass without mutating disk', async () => {
    // Guard: the `durable ? ... readOnly: true` wiring. The daemon reads the
    // markers through the composed handles (the tick folds a halted marker
    // into `status.halted`, the pass folds it into a per-entry `halted`
    // reason), and a `set` through a read-only handle throws while the on-disk
    // marker bytes stay untouched (no quarantine, no rewrite).
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-daemon-ka31-'));
    await fs.writeFile(path.join(stateDir, 'killall-halt.json'), haltedMarkerBytes, 'utf8');
    await fs.writeFile(
      path.join(stateDir, 'killall-train-pause.json'),
      JSON.stringify({ version: 1, paused: true, requestedAtIso: NOW }),
      'utf8',
    );

    const mergeQueueRepository = new MergeQueueRepositoryAdapter({ stateDir });
    const composed = composeDaemon(
      makeInput({ stateDir, mergeQueueRepository }),
    );

    expect(composed.durable).toBe(true);

    // The tick reads the halted marker (the conductor stub stays clear) and
    // records the halt without running any job.
    const tick = await composed.runDaemonTick.runTick({
      tickId: `tick-0${'1'.repeat(25)}`,
      repositories: [],
      forgeReachable: true,
    });
    expect(tick.outcome).toBe('completed');
    expect(tick.status?.halted).toBe(true);

    // The merge pass re-reads the same marker per entry and reasons `halted`.
    const digest = mergeQueueRepositoryDigest({ owner: 'fleet', repo: 'v2' });
    const enqueue = await mergeQueueRepository.enqueueMergeEntry({
      repository: { owner: 'fleet', repo: 'v2' },
      pullRequest: 1,
      headOid: 'a'.repeat(40),
      tier: 0,
      enqueuedBy: 'cli',
      runId: null,
      entryId: '01JB0000000000000000000002',
      successorEntryId: '01JB0000000000000000000003',
      enqueuedAtIso: FRESH_NOW,
      deadlineIso: FRESH_DEADLINE,
    });
    expect(enqueue.outcome).toBe('created');
    const pass = await composed.runMergePass.runMergePass({
      repository: { owner: 'fleet', repo: 'v2' },
      repoDigest: digest,
      projectId: 'proj-1',
      policy: {
        policyRevision: 'rev-1',
        shadow: true,
        unattended: true,
        updateBranch: false,
        veto: { mode: 'off' },
      },
      deadlineIso: FRESH_DEADLINE,
    });
    expect(pass.outcome).toBe('completed');
    expect(pass.entries[0]?.reasonCode).toBe('halted');

    // The daemon never mutates the markers: a read-only `set` throws and the
    // on-disk bytes are exactly what the test wrote.
    await expect(composed.killallHalt.set({ halted: false, nowIso: NOW })).rejects.toThrow();
    await expect(composed.killallTrainPause.set({ paused: false, nowIso: NOW })).rejects.toThrow();
    expect(await fs.readFile(path.join(stateDir, 'killall-halt.json'), 'utf8')).toBe(haltedMarkerBytes);
  });

  it('composeDaemon guards readOnly killallHalt and killallTrainPause on stateDir being undefined like statusReadOnly', async () => {
    // Guard: without a durable state directory the adapters are in-memory
    // instances WITHOUT `readOnly: true` (the same guard as `statusReadOnly`),
    // so a set through the composed handle succeeds and reads back.
    const composed = composeDaemon(makeInput());

    expect(composed.durable).toBe(false);

    const setHalt = await composed.killallHalt.set({ halted: true, nowIso: NOW });
    expect(setHalt.outcome).toBe('changed');
    await expect(composed.killallHalt.read()).resolves.toEqual({ state: 'halted' });

    const setPause = await composed.killallTrainPause.set({ paused: true, nowIso: NOW });
    expect(setPause.outcome).toBe('changed');
    await expect(composed.killallTrainPause.read()).resolves.toEqual({ status: 'paused' });
  });
});
