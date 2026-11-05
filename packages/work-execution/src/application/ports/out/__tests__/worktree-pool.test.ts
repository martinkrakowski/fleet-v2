import { describe, expect, it } from 'vitest';

import type {
  RefillWorktreePoolRequest,
  RefillWorktreePoolResult,
  ResetWorktreeToBaseRequest,
  ResetWorktreeToBaseResult,
  TakeWarmWorktreeRequest,
  TakeWarmWorktreeResult,
  WorktreePoolPort,
} from '../WorktreePoolPort.out-port.js';
import {
  isWorktreePoolBaseCommit,
  isWorktreePoolEntryState,
} from '../../../../domain/worktree-pool-records.js';
import type { AttemptRunnerRecord } from '../../../../domain/execution-records.js';
import type { WorktreePoolEntryRecord } from '../../../../domain/worktree-pool-records.js';

const BASE = '0123456789abcdef0123456789abcdef01234567';
const BASE_2 = '0123456789abcdef0123456789abcdef01234568';
const PROJECT = 'proj-a';
const RECORDED_HOST: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4001,
  host: 'runner-host',
  hostName: 'runner-host',
  agent: 'build',
  model: 'test-model',
  variant: null,
};

/**
 * In-memory fake of the warm worktree pool. It keeps the pool's entries in a
 * plain array and answers every port request synchronously from that state;
 * it holds no clock, no I/O and no randomness, so tests are deterministic.
 */
export class InMemoryWorktreePool implements WorktreePoolPort {
  private readonly targetSize: number;
  private entries: WorktreePoolEntryRecord[];

  constructor(options?: { readonly targetSize?: number; readonly entries?: readonly WorktreePoolEntryRecord[] }) {
    this.targetSize = options?.targetSize ?? 2;
    this.entries = options?.entries
      ? options.entries.map((entry) => ({ ...entry }))
      : [];
  }

  snapshot(): readonly WorktreePoolEntryRecord[] {
    return this.entries;
  }

  async take(request: TakeWarmWorktreeRequest): Promise<TakeWarmWorktreeResult> {
    if (request.projectId.length === 0 || !isWorktreePoolBaseCommit(request.baseCommit)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (request.runId !== undefined && request.runId !== null) {
      if (typeof request.runId !== 'string' || request.runId.length === 0) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
    }
    const index = this.entries.findIndex(
      (entry) => entry.projectId === request.projectId && entry.state === 'warm',
    );
    if (index < 0) {
      return { outcome: 'empty' };
    }
    const entry = this.entries[index];
    const taken: WorktreePoolEntryRecord = Object.freeze({
      ...entry,
      state: 'taken',
      takenByRunId: request.runId ?? null,
      revision: entry.revision + 1,
    });
    this.entries[index] = taken;
    return { outcome: 'taken', entry: taken };
  }

  async resetToBase(request: ResetWorktreeToBaseRequest): Promise<ResetWorktreeToBaseResult> {
    if (request.worktreePath.length === 0 || !isWorktreePoolBaseCommit(request.baseCommit)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const index = this.entries.findIndex((entry) => entry.worktreePath === request.worktreePath);
    if (index < 0) {
      return { outcome: 'refused', reason: 'unknown-worktree' };
    }
    const entry = this.entries[index];
    const reset: WorktreePoolEntryRecord = Object.freeze({
      ...entry,
      baseCommit: request.baseCommit,
      revision: entry.revision + 1,
    });
    this.entries[index] = reset;
    return { outcome: 'reset', entry: reset };
  }

  async refillAfterMerge(request: RefillWorktreePoolRequest): Promise<RefillWorktreePoolResult> {
    if (request.projectId.length === 0 || !isWorktreePoolBaseCommit(request.mergedBaseCommit)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const ofProject = this.entries.filter((entry) => entry.projectId === request.projectId);
    const warmOfProject = ofProject.filter((entry) => entry.state === 'warm');
    if (warmOfProject.length === this.targetSize && warmOfProject.every((entry) => entry.baseCommit === request.mergedBaseCommit)) {
      return { outcome: 'refused', reason: 'pool-full' };
    }
    this.entries = this.entries.map((entry) => {
      if (entry.projectId !== request.projectId || entry.state !== 'warm') {
        return entry;
      }
      return Object.freeze({
        ...entry,
        baseCommit: request.mergedBaseCommit,
        revision: entry.revision + 1,
      });
    });
    let warmCount = warmOfProject.length;
    let next = 1;
    while (warmCount < this.targetSize) {
      while (this.entries.some((entry) => entry.entryId === `${request.projectId}#${next}`)) {
        next += 1;
      }
      this.entries.push(
        Object.freeze({
          schemaVersion: 1 as const,
          entryId: `${request.projectId}#${next}`,
          projectId: request.projectId,
          worktreePath: `/fleet/pool/${request.projectId}/${next}`,
          baseCommit: request.mergedBaseCommit,
          state: 'warm' as const,
          takenByRunId: null,
          revision: 1,
        }),
      );
      warmCount += 1;
      next += 1;
    }
    const entries = this.entries.filter(
      (entry) => entry.projectId === request.projectId && entry.state === 'warm',
    );
    return { outcome: 'refilled', entries };
  }
}

function warmEntry(n: number, overrides: Partial<WorktreePoolEntryRecord> = {}): WorktreePoolEntryRecord {
  return {
    schemaVersion: 1 as const,
    entryId: `${PROJECT}#${n}`,
    projectId: PROJECT,
    worktreePath: `/fleet/pool/${PROJECT}/${n}`,
    baseCommit: BASE,
    state: 'warm',
    takenByRunId: null,
    revision: 1,
    ...overrides,
  };
}

describe('InMemoryWorktreePool', () => {
  it('take returns a worktree', async () => {
    const pool = new InMemoryWorktreePool({ entries: [warmEntry(1), warmEntry(2)] });
    const result = await pool.take({ projectId: PROJECT, baseCommit: BASE, runId: 'run-1', recordedHost: RECORDED_HOST });
    expect(result).toMatchObject({ outcome: 'taken' });
    if (result.outcome === 'taken') {
      expect(result.entry.worktreePath).toBe(`/fleet/pool/${PROJECT}/1`);
      expect(result.entry.state).toBe('taken');
      expect(result.entry.takenByRunId).toBe('run-1');
      expect(result.entry.revision).toBe(2);
    }
  });

  it('take returns an empty pool', async () => {
    const pool = new InMemoryWorktreePool();
    const result = await pool.take({ projectId: PROJECT, baseCommit: BASE, recordedHost: RECORDED_HOST });
    expect(result).toEqual({ outcome: 'empty' });
  });

  it('take never returns one already taken', async () => {
    const taken = warmEntry(1, { state: 'taken', takenByRunId: 'other-run', revision: 2 });
    const pool = new InMemoryWorktreePool({ entries: [taken, warmEntry(2)] });
    const result = await pool.take({ projectId: PROJECT, baseCommit: BASE, recordedHost: RECORDED_HOST });
    expect(result.outcome).toBe('taken');
    if (result.outcome === 'taken') {
      expect(result.entry.worktreePath).toBe(`/fleet/pool/${PROJECT}/2`);
    }
  });

  it('reset moves a worktree to the base commit', async () => {
    const pool = new InMemoryWorktreePool({ entries: [warmEntry(1)] });
    const result = await pool.resetToBase({ worktreePath: `/fleet/pool/${PROJECT}/1`, baseCommit: BASE_2, recordedHost: RECORDED_HOST });
    expect(result).toMatchObject({ outcome: 'reset' });
    if (result.outcome === 'reset') {
      expect(result.entry.baseCommit).toBe(BASE_2);
      expect(result.entry.revision).toBe(2);
    }
  });

  it('reset refuses an unknown worktree', async () => {
    const pool = new InMemoryWorktreePool({ entries: [warmEntry(1)] });
    const result = await pool.resetToBase({ worktreePath: '/fleet/pool/other/9', baseCommit: BASE_2, recordedHost: RECORDED_HOST });
    expect(result).toEqual({ outcome: 'refused', reason: 'unknown-worktree' });
  });

  it('refill after a merge tops the pool up at the merged base commit', async () => {
    const pool = new InMemoryWorktreePool({ entries: [warmEntry(1)] });
    const result = await pool.refillAfterMerge({ projectId: PROJECT, mergedBaseCommit: BASE_2, recordedHost: RECORDED_HOST });
    expect(result.outcome).toBe('refilled');
    if (result.outcome === 'refilled') {
      expect(result.entries).toHaveLength(2);
      for (const entry of result.entries) {
        expect(entry.baseCommit).toBe(BASE_2);
        expect(entry.state).toBe('warm');
      }
      expect(result.entries.map((entry) => entry.entryId)).toEqual([`${PROJECT}#1`, `${PROJECT}#2`]);
      expect(result.entries.every((entry) => isWorktreePoolBaseCommit(entry.baseCommit))).toBe(true);
      expect(result.entries.every((entry) => isWorktreePoolEntryState(entry.state))).toBe(true);
    }
  });

  it('refill refuses when the pool is full', async () => {
    const pool = new InMemoryWorktreePool({ entries: [warmEntry(1), warmEntry(2)] });
    const result = await pool.refillAfterMerge({ projectId: PROJECT, mergedBaseCommit: BASE, recordedHost: RECORDED_HOST });
    expect(result).toEqual({ outcome: 'refused', reason: 'pool-full' });
  });
});
