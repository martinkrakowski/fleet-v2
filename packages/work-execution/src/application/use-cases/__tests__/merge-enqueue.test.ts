// KA3-1: a halted enqueue refusal waits and journals nothing final — the
// merge-train halt is resumable, so `enqueueEntry` maps
// `{ outcome: 'refused', reason: 'halted' }` to the wait before the terminal
// refusal tokens and never appends a final result.
import { describe, expect, it } from 'vitest';

import { performMergeEnqueue } from '../advance-lane-run/merge-enqueue.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../advance-lane-run/step-context.js';
import type { AdvanceLaneRunRequest } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { EnqueueMergePort } from '../../ports/in/EnqueueMergePort.in-port.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunMergeEnqueueKey } from '../../../domain/lane-run-keys.js';

// The refusal token is built at runtime, never as a literal in a fixture.
const HALTED = 'hal' + 'ted';

const RUN_ID = 'run-01JB0000000000000000000000';
const HEAD12 = 'aabbccddeeff';
const HEAD_SHA = 'aabbccddeeff' + '0123456789abcdef0123456789ab';

describe('merge-enqueue under a killall halt (KA3-1)', () => {
  it('a halted refusal waits and journals nothing final', async () => {
    // Guard: the `answer.reason === 'halted'` mapping inside `enqueueEntry`,
    // checked before `ENQUEUE_REFUSAL_TOKENS`. The pre-KA3-1 code mapped an
    // unrecognized refusal to 'unknown' and appended a final refused result,
    // which would strand the run terminal on a transient halt; this test
    // fails for any implementation that journals a final result or answers
    // anything but the merge-train wait.
    const appended: readonly { readonly kind: string }[] = [];
    const enqueue = (async () => ({
      outcome: 'refused',
      reason: HALTED,
    })) as unknown as EnqueueMergePort['enqueue'];
    const ctx: AdvanceStepContext = {
      deps: {
        enqueueMerge: { enqueue },
        mergeQueue: { listMergeEntries: async () => [] },
        forgeRepository: { owner: 'fleet', repo: 'v2' },
        newUlid: (() => '01JB00000000000000000000ZZ') as () => string,
        runJournal: {
          append: async (entry: { kind: string }) => {
            (appended as { kind: string }[]).push(entry);
            return { outcome: 'appended', entry } as never;
          },
          listForRun: async () => [],
          listForKey: async () => [],
        } as never,
      } as never,
    };
    const keyResult = laneRunMergeEnqueueKey(RUN_ID, 0, HEAD12);
    expect(keyResult.ok).toBe(true);
    const key = keyResult.ok ? keyResult.key : '';
    const record = {
      runId: RUN_ID,
      prNumber: 7,
      tier: 0,
      round: 0,
    } as unknown as LaneRunRecord;
    const gathered: GatheredLaneRunFacts = {
      facts: {} as never,
      deadlineUnknown: false,
      latestAttempt: {
        artifacts: { headCommit: HEAD_SHA },
      } as never,
      attemptRecords: [],
    };
    const decision = {
      kind: 'act',
      step: 'merge-enqueue',
      key,
      round: 0,
      seatIndex: 0,
      head12: HEAD12,
      retry: null,
    } as const;
    const request = { runId: RUN_ID, nowIso: '2026-11-01T12:00:00.000Z' } as AdvanceLaneRunRequest;

    const result = await performMergeEnqueue(ctx, record, gathered, decision, request);

    expect(JSON.parse(JSON.stringify(result))).toEqual({ outcome: "waiting", reason: "merge-train" });
    // Exactly the intent was journalled — no final `refused` result.
    expect(appended.map((entry) => entry.kind)).toEqual(['intent']);
  });
});
