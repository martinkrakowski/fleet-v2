/**
 * UN1 application predicates: the sites that read a run-journal result as
 * final must treat `uncertain` exactly like `ambiguous` (non-final), so a
 * pending intent whose only result is `uncertain` is still abandoned by an
 * operator stop. Pure in-memory fake journal; no store, no runner.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../../../application/ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalAppendResult } from '../../../application/ports/out/LaneRunJournalPort.out-port.js';
import { abandonAmbiguousIntentForStop } from '../advance-lane-run/stop-cancel.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../advance-lane-run/step-context.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunRequest } from '../../ports/in/AdvanceLaneRunPort.in-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const HEAD = '0123456789ab';
const ATTEMPT_ID = 'attempt-example-1';

function mustBuild(result: { ok: true; key: string } | { ok: false }): string {
  if (!result.ok) {
    throw new Error('unreachable: key builder');
  }
  return result.key;
}

let ulidCounter = 0;
function nextUlid(): string {
  ulidCounter += 1;
  return '01JB' + String(ulidCounter).padStart(22, '0');
}

/** Minimal in-memory keyed journal honouring the port's append/list reads. */
class FakeRunJournal implements LaneRunJournalPort {
  readonly entries: LaneRunJournalEntryRecord[] = [];

  async append(entry: LaneRunJournalEntryRecord): Promise<LaneRunJournalAppendResult> {
    this.entries.push(entry);
    return { outcome: 'appended', entry };
  }

  async listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    return this.entries.filter((entry) => entry.runId === runId);
  }

  async listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    return this.entries.filter((entry) => entry.key === key);
  }
}

function runRecord(): LaneRunRecord {
  const result = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [ATTEMPT_ID],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
  });
  if (!result.success || result.value === undefined) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function gatheredWithPendingIntent(step: 'push' | 'premerge'): GatheredLaneRunFacts {
  return {
    facts: {
      state: 'running',
      halted: false,
      stopMode: 'graceful',
      stopRequestedAtIso: NOW,
      stopGraceMinutes: 45,
      pendingIntent: { key: PUSH_KEY, step, reconciliation: 'ambiguous' },
      admission: 'admitted',
      costCeilingReached: false,
      implementerSeat: { ok: false },
      reviewSeat: { ok: false },
      roundSeatIndexes: [],
      attempt: null,
      head12: HEAD,
      acceptedHead12: null,
      gate: 'none',
      gateCongestion: null,
      gateUnknown: null,
      briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
      codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
      preMerge: 'none',
      premergePost: 'none',
      mergeEnqueue: 'none',
      acceptance: 'none',
      acceptanceRetry: null,
      ci: 'pending',
      pr: null,
      refusedStep: null,
      merge: { oneWayDoor: false, policyGrant: true },
    },
    deadlineUnknown: false,
    latestAttempt: null,
    attemptRecords: [null],
  } as unknown as GatheredLaneRunFacts;
}

const PUSH_KEY = mustBuild(buildLaneRunStepKey({
  runId: RUN_ID, round: 0, step: 'push', seatIndex: 0, attemptOrdinal: null, head12: HEAD, retry: null,
}));

function ctxWith(journal: FakeRunJournal): AdvanceStepContext {
  const deps = {
    runJournal: journal,
    newUlid: nextUlid,
  } as unknown as AdvanceLaneRunDependencies;
  return { deps };
}

function request(): AdvanceLaneRunRequest {
  return { runId: RUN_ID, lease: { holderId: 'driver', fence: 1 }, halted: false, nowIso: NOW };
}

describe('uncertain application predicates (UN1)', () => {
  it('stop-cancel appends the abandoned result when the only result on the key is uncertain', async () => {
    const journal = new FakeRunJournal();
    journal.entries.push(laneRunIntentEntry(nextUlid(), RUN_ID, PUSH_KEY, ATTEMPT_ID, NOW));
    journal.entries.push(laneRunResultEntry(nextUlid(), RUN_ID, PUSH_KEY, 'uncertain', 'unobservable', NOW));
    const ctx = ctxWith(journal);
    const record = runRecord();
    const outcome = await abandonAmbiguousIntentForStop(
      ctx,
      record,
      gatheredWithPendingIntent('push'),
      { kind: 'wait', reason: 'parked' },
      request(),
    );
    expect(outcome.kind).toBe('resolved');
    const abandoned = journal.entries.at(-1);
    expect(abandoned).not.toBeUndefined();
    expect(abandoned?.kind).toBe('result');
    expect(abandoned?.key).toBe(PUSH_KEY);
    expect(abandoned?.outcome).toBe('overtaken');
    expect(abandoned?.reasonCode).toBe('intent-abandoned-by-operator');
  });
});
