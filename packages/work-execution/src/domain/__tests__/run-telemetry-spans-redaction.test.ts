/**
 * Redaction on the real mapper (OT1b-2): a full conducted run (two rounds, a
 * pivot, a fix round, a gate, both reviews, accept, open-pr, merge, a park, a
 * CI wait) and a hand-run attempt with receipts are mapped by `laneRunSpans`
 * and `attemptTraceSpans`, encoded by `encodeOtlpTraces`, and every free-text
 * fixture value is asserted absent by `redactionChecks`. The model id is
 * deliberately left out of the canaries: it legitimately appears on a metered
 * usage span (plan §3.2 "Seats", §3.6). The encoder must refuse nothing: a
 * refused span would mean the mapper emitted something pricing-unsafe.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  telemetryHashInput,
  type TelemetryHmac,
  type TelemetryHashInput,
} from '../run-telemetry-ids.js';
import { attemptTraceSpans, laneRunSpans } from '../run-telemetry-spans.js';
import type { AttemptTraceTelemetryFacts, TelemetryGateReceiptFact, TelemetryReviewReceiptFact } from '../run-telemetry-spans.js';
import { encodeOtlpTraces } from '../../infrastructure/adapters/OtlpJsonEncoder.helper.js';
import { redactionChecks } from '../run-telemetry-redaction.js';
import { buildLaneRunStepKey } from '../lane-run-keys.js';
import { LANE_RUN_RECORD_VERSION, type LaneRunRecord } from '../lane-run-records.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalEntryKind, LaneRunJournalOutcome } from '../lane-run-journal.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';
import type { AttemptRecord } from '../execution-records.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();

const RUN_ID = 'run-01JB0000000000000000000000';
const WORK_ORDER_ID = 'wo-canary-work-order-1';
const ATTEMPT_ROUND0 = 'canary-attempt-round0';
const ATTEMPT_ROUND1 = 'canary-attempt-round1';
const HAND_ATTEMPT_ID = 'canary-attempt-hand-run';
const BRANCH = 'fleet/run-canary-branch';
const WORKTREE_PATH = '/canary/worktree/path';
const SESSION_ID = 'ses_canary_session';
const MODEL_ID = 'example-canary-model';
const RECEIPT_GATE = 'receipt-canary-gate';
const RECEIPT_REVIEW = 'receipt-canary-review';
const HEAD12 = '0123456789ab';

function asInput(text: string): TelemetryHashInput {
  const token = telemetryHashInput(text);
  expect(token).not.toBeNull();
  return token as TelemetryHashInput;
}

function stepKey(step: string, round: number, seatIndex = 0, attemptOrdinal: number | null = null, head12: string | null = null): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round,
    step: step as never,
    seatIndex,
    attemptOrdinal,
    head12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  return built.ok ? built.key : '';
}

const PREPARE_0_KEY = stepKey('prepare', 0, 0, 1);
const DISPATCH_0_KEY = stepKey('dispatch', 0, 0, 1);
const COLLECT_0_KEY = stepKey('collect', 0);
const GATE_0_KEY = stepKey('gate', 0, 0, null, HEAD12);
const BRIEF_CHECK_0_KEY = stepKey('brief-check', 0, 0, null, HEAD12);
const CODE_REVIEW_0_KEY = stepKey('code-review', 0, 0, null, HEAD12);
const PREPARE_1_KEY = stepKey('prepare', 1, 0, 1);
const DISPATCH_1_KEY = stepKey('dispatch', 1, 0, 1);
const COLLECT_1_KEY = stepKey('collect', 1);
const PARK_1_KEY = stepKey('park', 1);
const ACCEPT_KEY = stepKey('accept', 0, 0, null, HEAD12);
const OPEN_PR_KEY = stepKey('open-pr', 0, 0, null, HEAD12);
const PUSH_KEY = stepKey('push', 0, 0, null, HEAD12);
const MERGE_KEY = stepKey('merge', 0, 0, null, HEAD12);

function time(second: number): string {
  return `2026-10-29T10:00:${String(second).padStart(2, '0')}.000Z`;
}

let entryCounter = 0;
function entry(kind: LaneRunJournalEntryKind, fields: Partial<LaneRunJournalEntryRecord>): LaneRunJournalEntryRecord {
  entryCounter += 1;
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: `01JB00000000000000000000${String(entryCounter).padStart(2, '0')}`,
    kind,
    key: null,
    runId: RUN_ID,
    recordedAtIso: time(entryCounter),
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    grantId: null,
    state: null,
    ...fields,
  };
}

function intent(key: string, second: number, mintedId: string | null): LaneRunJournalEntryRecord {
  return entry('intent', { key, recordedAtIso: time(second), mintedId });
}

function result(key: string, second: number, outcome: LaneRunJournalOutcome = 'completed', reasonCode: string | null = null): LaneRunJournalEntryRecord {
  return entry('result', { key, recordedAtIso: time(second), outcome, reasonCode });
}

function conductOf(state: LaneRunStateValue, second: number): LaneRunJournalEntryRecord {
  return entry('conduct', { recordedAtIso: time(second), state });
}

/** The full conducted run: two rounds, a pivot, a fix round, a gate, both reviews, accept, open-pr, merge, a park, a CI wait. */
function fullJournal(): LaneRunJournalEntryRecord[] {
  entryCounter = 0;
  return [
    intent(PREPARE_0_KEY, 1, ATTEMPT_ROUND0), result(PREPARE_0_KEY, 2),
    intent(DISPATCH_0_KEY, 3, ATTEMPT_ROUND0), result(DISPATCH_0_KEY, 4),
    conductOf('running', 5),
    intent(COLLECT_0_KEY, 6, null), result(COLLECT_0_KEY, 7),
    conductOf('gating', 8),
    intent(GATE_0_KEY, 9, null), result(GATE_0_KEY, 10),
    intent(BRIEF_CHECK_0_KEY, 11, null), result(BRIEF_CHECK_0_KEY, 12),
    intent(CODE_REVIEW_0_KEY, 13, null), result(CODE_REVIEW_0_KEY, 14),
    // The pivot: round 1 (the fix round) starts, closing round 0.
    intent(PREPARE_1_KEY, 15, ATTEMPT_ROUND1), result(PREPARE_1_KEY, 16),
    intent(DISPATCH_1_KEY, 17, ATTEMPT_ROUND1), result(DISPATCH_1_KEY, 18),
    conductOf('running', 19),
    intent(COLLECT_1_KEY, 20, null), result(COLLECT_1_KEY, 21),
    conductOf('gating', 22),
    intent(PARK_1_KEY, 23, null), result(PARK_1_KEY, 24),
    conductOf('accepting', 25),
    intent(ACCEPT_KEY, 26, null), result(ACCEPT_KEY, 27),
    intent(OPEN_PR_KEY, 28, null), result(OPEN_PR_KEY, 29),
    intent(PUSH_KEY, 30, null), result(PUSH_KEY, 31),
    conductOf('watching-ci', 32),
    conductOf('merging', 33),
    intent(MERGE_KEY, 34, null), result(MERGE_KEY, 35),
    conductOf('merged', 36),
  ];
}

function makeRun(): LaneRunRecord {
  return {
    version: LANE_RUN_RECORD_VERSION,
    runId: RUN_ID,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: 0, review: null },
    round: 1,
    attemptIds: [ATTEMPT_ROUND0, ATTEMPT_ROUND1],
    prNumber: 42,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    branchName: BRANCH,
  };
}

function makeAttempt(id: string, role: 'first-pass' | 'fix', overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: WORK_ORDER_ID,
    kind: role === 'fix' ? 'fix' : 'initial',
    fixNumber: role === 'fix' ? 1 : 0,
    priorAttemptId: role === 'fix' ? ATTEMPT_ROUND0 : null,
    worktreePath: WORKTREE_PATH,
    baseCommit: 'a'.repeat(40),
    state: 'collected',
    revision: 1,
    dispatchRevision: 1,
    outcome: 'done',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: SESSION_ID,
    completionReceipt: {
      attemptId: id,
      sessionId: SESSION_ID,
      endedAtIso: time(50),
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
    runner: { kind: 'opencode', remotePort: null, host: null, agent: null, model: MODEL_ID, variant: null },
    seatPlan: null,
    seatSelection: {
      role,
      seatIndex: 0,
      seatId: 'seat-' + id,
      model: MODEL_ID,
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    reviewerSeat: null,
    stopReason: 'none',
    createdAtIso: time(1),
    updatedAtIso: time(50),
    usage: {
      source: 'opencode-db',
      readAtIso: time(10),
      sessionId: null,
      steps: 15,
      wallSeconds: 60.5,
      tokensInput: 200,
      tokensOutput: 160,
      tokensReasoning: 40,
      tokensCacheRead: 20,
      tokensCacheWrite: 10,
      costUsd: 0.5,
      model: MODEL_ID,
      agent: role,
      reason: null,
    },
    ...overrides,
  };
}

function handAttempt(): AttemptRecord {
  return {
    id: HAND_ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: 'a'.repeat(40),
    state: 'collected',
    revision: 1,
    dispatchRevision: 1,
    outcome: 'done',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: SESSION_ID,
    completionReceipt: {
      attemptId: HAND_ATTEMPT_ID,
      sessionId: SESSION_ID,
      endedAtIso: time(50),
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
    runner: { kind: 'opencode', remotePort: null, host: null, agent: null, model: MODEL_ID, variant: null },
    seatPlan: null,
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'seat-hand-run',
      model: MODEL_ID,
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    reviewerSeat: null,
    stopReason: 'none',
    createdAtIso: time(40),
    updatedAtIso: time(51),
    usage: {
      source: 'opencode-db',
      readAtIso: time(45),
      sessionId: null,
      steps: 8,
      wallSeconds: 20,
      tokensInput: 50,
      tokensOutput: 40,
      tokensReasoning: 10,
      tokensCacheRead: 5,
      tokensCacheWrite: 2,
      costUsd: 0.12,
      model: MODEL_ID,
      agent: 'first-pass',
      reason: null,
    },
  };
}

const gateReceipt: TelemetryGateReceiptFact = {
  receiptId: asInput(RECEIPT_GATE),
  result: 'pass',
  exitCode: 0,
  completedAtIso: time(52),
};

const reviewReceipt: TelemetryReviewReceiptFact = {
  receiptId: asInput(RECEIPT_REVIEW),
  kind: 'code-review',
  result: 'pass',
  findings: { blocker: 0, major: 1, minor: 2, nit: 3 },
  completedAtIso: time(53),
};

describe('redaction on the real mapper (OT1b-2)', () => {
  it('encodes the conducted run and the hand-run attempt with no refused span and every redaction check passing', () => {
    const journal = fullJournal();
    const run = makeRun();
    const attempts = [makeAttempt(ATTEMPT_ROUND0, 'first-pass'), makeAttempt(ATTEMPT_ROUND1, 'fix')];

    const runResult = laneRunSpans(hmac, { run, journal, project: 'fleet-v2', tags: ['conducted', 'tier-2'], attempts });
    expect(runResult.rejectedInvalid).toBe(0);
    expect(runResult.spans.length).toBeGreaterThan(0);

    const conductedAttemptIds = new Set<string>(run.attemptIds);
    for (const entry of journal) {
      if (entry.kind === 'intent' && entry.mintedId !== null) {
        conductedAttemptIds.add(entry.mintedId);
      }
    }
    const handFacts: AttemptTraceTelemetryFacts = {
      attempt: handAttempt(),
      receipts: { verification: [gateReceipt], review: [reviewReceipt] },
      conductedAttemptIds,
    };
    const handResult = attemptTraceSpans(hmac, handFacts);
    expect(handResult.rejectedInvalid).toBe(0);
    expect(handResult.spans.length).toBeGreaterThan(0);

    const encoded = encodeOtlpTraces([...runResult.spans, ...handResult.spans], {
      serviceVersion: '1.2.3',
      projectName: 'fleet-v2',
    });
    // A refused span would mean the mapper emitted something pricing-unsafe or
    // unencodable; the encoder must refuse nothing here.
    expect(encoded.refused).toEqual([]);
    expect(encoded.payload).not.toBeNull();

    const canaries = [
      WORK_ORDER_ID,
      'canary-attempt',
      ATTEMPT_ROUND0,
      ATTEMPT_ROUND1,
      HAND_ATTEMPT_ID,
      BRANCH,
      WORKTREE_PATH,
      SESSION_ID,
      PREPARE_0_KEY,
      DISPATCH_0_KEY,
      COLLECT_0_KEY,
      GATE_0_KEY,
      BRIEF_CHECK_0_KEY,
      CODE_REVIEW_0_KEY,
      PREPARE_1_KEY,
      DISPATCH_1_KEY,
      COLLECT_1_KEY,
      PARK_1_KEY,
      ACCEPT_KEY,
      OPEN_PR_KEY,
      PUSH_KEY,
      MERGE_KEY,
      RECEIPT_GATE,
      RECEIPT_REVIEW,
    ];
    const report = redactionChecks(encoded.payload as Uint8Array, canaries);
    expect(report.pass).toBe(true);
    for (const check of report.checks) {
      expect(check.pass).toBe(true);
    }
  });
});
