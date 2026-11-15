/**
 * F198: a parked run's worktree is preserved and named.
 *
 * GB3 preserves a patch only for the first attempt's refused dispatch, and GB3a
 * hands a dirty worktree on with nothing preserved. When the seat plan then runs
 * out, neither applies: on 2026-11-13 two parked runs held 137 and 182 lines of
 * implementation in hash-named worktrees that nothing in the journal named.
 */
import { describe, expect, it } from 'vitest';

import type { ActionJournalEntryRecord, AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type {
  PreserveWorktreeEditsRequest,
  PreserveWorktreeEditsResult,
} from '../../ports/out/WorkspacePort.out-port.js';
import {
  PARK_PATCH_SUFFIX,
  PARK_PRESERVE_DETAIL,
  PARK_PRESERVE_REASON,
  preserveParkedWorktree,
  type ParkPreserveDeps,
} from '../advance-lane-run/park-preserve.js';

const WORKTREE = '/mnt/pool/projects/.worktrees/fleet-v2/afbb362bfb95b24574bf44b96f4958df';
const ATTEMPT = 'attempt-01M79FPNQR3HZA894YJ9Y9RHY7';
const NOW = '2026-11-13T07:00:00.000Z';

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: ATTEMPT,
    worktreePath: WORKTREE,
    baseCommit: '1e10ebc373',
    runner: { kind: 'opencode', host: 'sol', hostName: 'solstice', remotePort: 4166 },
    ...over,
  } as unknown as AttemptRecord;
}

function run(attemptIds: readonly string[] = [ATTEMPT]): LaneRunRecord {
  return { workOrderId: 'wo-fleet-v2-co10b-g2', attemptIds } as unknown as LaneRunRecord;
}

interface Harness {
  readonly deps: ParkPreserveDeps;
  readonly appended: ActionJournalEntryRecord[];
  readonly preserveCalls: PreserveWorktreeEditsRequest[];
}

function harness(opts: {
  preserve?: PreserveWorktreeEditsResult;
  throws?: true;
  attempts?: Record<string, AttemptRecord | null>;
  prior?: readonly ActionJournalEntryRecord[];
  wired?: boolean;
  canAppend?: boolean;
} = {}): Harness {
  const appended: ActionJournalEntryRecord[] = [];
  const preserveCalls: PreserveWorktreeEditsRequest[] = [];
  const attempts = opts.attempts ?? { [ATTEMPT]: attempt() };
  const result: PreserveWorktreeEditsResult =
    opts.preserve ?? { outcome: 'preserved', patchPath: 'p', patchBytes: 10 };
  const deps = {
    attemptRepo: {
      async findAttemptById(id: string): Promise<AttemptRecord | null> {
        return attempts[id] ?? null;
      },
    },
    ...(opts.wired === false
      ? {}
      : {
          worktreeRecovery: {
            async preserveWorktreeEdits(request: PreserveWorktreeEditsRequest): Promise<PreserveWorktreeEditsResult> {
              preserveCalls.push(request);
              if (opts.throws === true) {
                throw new Error('transport down');
              }
              return result;
            },
          },
        }),
    executionJournal: {
      ...(opts.canAppend === false
        ? {}
        : {
            async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
              appended.push(entry);
            },
          }),
      async listJournalEntriesForAttempt(): Promise<readonly ActionJournalEntryRecord[]> {
        return opts.prior ?? [];
      },
    },
  } as unknown as ParkPreserveDeps;
  return { deps, appended, preserveCalls };
}

describe('preserveParkedWorktree (F198)', () => {
  it('preserves the worktree and journals the patch path, which names the worktree', async () => {
    const h = harness();
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toHaveLength(1);
    expect(h.preserveCalls[0]?.worktreePath).toBe(WORKTREE);
    expect(h.preserveCalls[0]?.patchPath).toBe(WORKTREE + '.' + ATTEMPT + PARK_PATCH_SUFFIX);
    expect(h.appended).toHaveLength(1);
    const detail = h.appended[0]?.detail ?? '';
    expect(detail.startsWith(PARK_PRESERVE_DETAIL)).toBe(true);
    // The whole point: the entry names the worktree, so untracked files the
    // patch cannot carry are discoverable too.
    expect(detail).toContain(WORKTREE);
    expect(h.appended[0]?.status).toBe('completed');
    expect(h.appended[0]?.attemptId).toBe(ATTEMPT);
  });

  it('journals nothing for a clean worktree', async () => {
    const h = harness({ preserve: { outcome: 'refused', reason: 'nothing-to-preserve' } });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toHaveLength(1);
    expect(h.appended).toEqual([]);
  });

  it('journals a patch that an earlier park already saved', async () => {
    const h = harness({ preserve: { outcome: 'refused', reason: 'destination-exists' } });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.appended).toHaveLength(1);
  });

  it('is idempotent: a re-park writes no second entry and preserves nothing again', async () => {
    const prior = [{ detail: PARK_PRESERVE_DETAIL + '/x.park.patch' } as ActionJournalEntryRecord];
    const h = harness({ prior });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toEqual([]);
    expect(h.appended).toEqual([]);
  });

  it('is a no-op when worktree recovery is not wired', async () => {
    const h = harness({ wired: false });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.appended).toEqual([]);
  });

  it('is a no-op when the journal cannot append', async () => {
    const h = harness({ canAppend: false });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toEqual([]);
  });

  it('never fails the park when the port throws', async () => {
    const h = harness({ throws: true });
    await expect(preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW)).resolves.toBeUndefined();
    expect(h.appended).toEqual([]);
  });

  it('builds no patch path from a traversing worktree path', async () => {
    const h = harness({ attempts: { [ATTEMPT]: attempt({ worktreePath: '/a/../../etc' }) } });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toEqual([]);
    expect(h.appended).toEqual([]);
  });

  it('skips an attempt with no recorded host rather than reading a local executor', async () => {
    const h = harness({ attempts: { [ATTEMPT]: attempt({ runner: null }) } });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toEqual([]);
  });

  it('falls back past a newest attempt whose recorded path cannot build a patch path', async () => {
    const older = 'attempt-01M79FPNQR3HZA894YJ9Y9RHY8';
    const h = harness({
      attempts: {
        [older]: attempt({ id: older, worktreePath: '/mnt/pool/old' }),
        [ATTEMPT]: attempt({ worktreePath: '' }),
      },
    });
    await preserveParkedWorktree(h.deps, run([older, ATTEMPT]), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls[0]?.worktreePath).toBe('/mnt/pool/old');
  });

  it('stands down for every other park reason, which still has a seat or a commit', async () => {
    for (const reason of ['step-refused', 'blocker-after-round-2', 'fix-no-progress', 'ambiguous'] as const) {
      const h = harness();
      await preserveParkedWorktree(h.deps, run(), reason, NOW);
      expect(h.preserveCalls, reason).toEqual([]);
      expect(h.appended, reason).toEqual([]);
    }
  });

  it('stands down when a GB3 recovery already owns the worktree, so nothing re-runs', async () => {
    const prior = [{ detail: 'preserved uncommitted edits: /x.patch' } as ActionJournalEntryRecord];
    const h = harness({ prior });
    await preserveParkedWorktree(h.deps, run(), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toEqual([]);
    expect(h.appended).toEqual([]);
  });

  it('does nothing when the run has no attempts', async () => {
    const h = harness();
    await preserveParkedWorktree(h.deps, run([]), PARK_PRESERVE_REASON, NOW);
    expect(h.preserveCalls).toEqual([]);
  });
});
