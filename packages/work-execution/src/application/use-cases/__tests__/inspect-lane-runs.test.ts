// InspectLaneRunsUseCase tests — GB2 part 1.
/**
 * The read-only status view projects the parked run's failed code-review
 * findings as the bounded view: `null` unless the run is parked
 * `blocker-after-round-2`, `[]` when the park applies but no failed receipt is
 * found (or the read deps are unwired), and the bounded view otherwise. It
 * reads only; a read failure yields `[]`, never a throw.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunParkFindingView } from '../../../domain/park-findings-view.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { InspectLaneRunsUseCase } from '../InspectLaneRunsUseCase.use-case.js';
import type { ReviewRequestPort } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { LaneRunStatusView } from '../../ports/in/InspectLaneRunsPort.in-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const ENTRY_1 = '01JB0000000000000000000001';
const ATTEMPT_ID = 'attempt-example-1';
const COMMIT_A = 'a'.repeat(40);

const BASE_RECORD = {
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
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

/** A collected initial attempt with the given head commit. */
function collectedAttempt(headCommit: string = COMMIT_A): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/wt-example-1',
    baseCommit: COMMIT_A,
    state: 'collected',
    outcome: null,
    revision: 0,
    briefDigest: 'a'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: {
      attemptId: ATTEMPT_ID,
      sessionId: 'session-example-1',
      endedAtIso: NOW,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: { headCommit, commitsSinceBase: [headCommit], collectedArtifactPaths: [], notes: 'present' },
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: 'lane-alias-example',
      hostName: 'lane-host-example',
      agent: null,
      model: null,
      variant: null,
    },
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
      fix: [],
      review: [],
    },
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'fp-1',
      model: 'model-example-1',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

const FINDING: LaneRunParkFindingView = {
  findingId: 'finding-1',
  severity: 'blocker',
  summary: 'blocks the acceptance check',
  filePath: 'src/ex.ts',
  line: 4,
};

/** A reviewRequest port fake answering findLatestReceiptOfKind. */
function reviewPort(answer: ReviewRequestPort['findLatestReceiptOfKind']): Pick<ReviewRequestPort, 'findLatestReceiptOfKind'> {
  return { findLatestReceiptOfKind: answer };
}

type Harness = {
  runRepo: LaneRunRepositoryAdapter;
  runJournal: LaneRunJournalAdapter;
  attemptRepo: AttemptRepositoryAdapter;
  halt: ConductorHaltAdapter;
  driverLease: ConductorDriverLeaseAdapter;
  useCase: InspectLaneRunsUseCase;
};

function makeHarness(overrides: {
  reviewReceipts?: Pick<ReviewRequestPort, 'findLatestReceiptOfKind'>;
  withAttemptRepo?: boolean;
} = {}): Harness {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const halt = new ConductorHaltAdapter();
  const driverLease = new ConductorDriverLeaseAdapter();
  const useCase = new InspectLaneRunsUseCase({
    runRepo,
    runJournal,
    halt,
    driverLease,
    ...(overrides.withAttemptRepo === false ? {} : { attemptRepo }),
    ...(overrides.reviewReceipts === undefined ? {} : { reviewReceipts: overrides.reviewReceipts }),
  });
  return { runRepo, runJournal, attemptRepo, halt, driverLease, useCase };
}

async function seedParkedRun(
  harness: Harness,
  reason: LaneRunParkReason,
  parkCount = 1,
  attemptIds: readonly string[] = [ATTEMPT_ID],
  findings?: readonly LaneRunParkFindingView[] | null,
): Promise<void> {
  const record = runRecord({
    attemptIds,
    parked: {
      reason,
      qualifier: null,
      parkedFrom: 'gating',
      questionId: null,
      ...(findings !== undefined ? { findings } : {}),
    },
    parkCount,
  });
  expect(await harness.runRepo.create(record)).toMatchObject({ outcome: 'saved' });
  const entry: LaneRunJournalEntryRecord = laneRunConductEntry(ENTRY_1, RUN_ID, 'parked', NOW);
  expect(await harness.runJournal.append(entry)).toMatchObject({ outcome: 'appended' });
  await harness.attemptRepo.saveAttempt(collectedAttempt());
}

async function statusRuns(harness: Harness): Promise<readonly LaneRunStatusView[]> {
  const result = await harness.useCase.inspectLaneRuns({ nowIso: NOW });
  expect(result.outcome).toBe('listed');
  if (result.outcome !== 'listed') {
    throw new Error('expected listed');
  }
  return result.runs;
}

describe('InspectLaneRunsUseCase (GB2)', () => {
  it('shows reviewFindings null for a run parked with another reason', async () => {
    const harness = makeHarness({ reviewReceipts: reviewPort(async () => ({ outcome: 'not-found' })) });
    await seedParkedRun(harness, 'halted');
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toBeNull();
  });

  it('shows reviewFindings null for a non-parked run', async () => {
    const harness = makeHarness({ reviewReceipts: reviewPort(async () => ({ outcome: 'not-found' })) });
    const record = runRecord();
    expect(await harness.runRepo.create(record)).toMatchObject({ outcome: 'saved' });
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toBeNull();
  });

  it('projects the bounded findings for a blocker-after-round-2 park with a found failed receipt', async () => {
    const harness = makeHarness({
      reviewReceipts: reviewPort(async (request) => ({
        outcome: 'found',
        receipt: {
          receiptId: 'rcpt-1',
          requestId: null,
          kind: 'code-review',
          reviewerModel: 'review-model-1',
          candidateHeadSha: request.candidateHeadSha,
          verdict: 'failed',
          findings: [
            FINDING,
            { findingId: 'finding-2', severity: 'major', summary: 'second', filePath: 'src/b.ts', line: 9 },
          ],
        },
      })),
    });
    await seedParkedRun(harness, 'blocker-after-round-2');
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([
      FINDING,
      { findingId: 'finding-2', severity: 'major', summary: 'second', filePath: 'src/b.ts', line: 9 },
    ]);
  });

  it('answers [] when the receipt is not-found for a blocker park', async () => {
    const harness = makeHarness({ reviewReceipts: reviewPort(async () => ({ outcome: 'not-found' })) });
    await seedParkedRun(harness, 'blocker-after-round-2');
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([]);
  });

  it('answers [] when the read deps are unwired', async () => {
    const harness = makeHarness({ withAttemptRepo: false });
    await seedParkedRun(harness, 'blocker-after-round-2');
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([]);
  });

  it('answers [] and never throws when the receipt read throws', async () => {
    const harness = makeHarness({
      reviewReceipts: reviewPort(async () => {
        throw new Error('store down');
      }),
    });
    await seedParkedRun(harness, 'blocker-after-round-2');
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([]);
  });

  it('bounds and drops raw receipt fields from the status view', async () => {
    const harness = makeHarness({
      reviewReceipts: reviewPort(async () => ({
        outcome: 'found',
        receipt: {
          receiptId: 'rcpt-1',
          requestId: 'request-1',
          kind: 'code-review',
          reviewerModel: 'review-model-1',
          candidateHeadSha: COMMIT_A,
          verdict: 'failed',
          findings: [
            FINDING,
            { findingId: 'finding-secret', severity: 'blocker', summary: 'sk-' + 'A'.repeat(24) + ' token', filePath: '/etc/passwd', line: -1 },
            { findingId: 'finding-3', severity: 'blocker', summary: 'third', filePath: 'src/c.ts', line: 7 },
            { findingId: 'finding-4', severity: 'blocker', summary: 'fourth', filePath: 'src/d.ts', line: 2 },
            { findingId: 'finding-5', severity: 'blocker', summary: 'fifth', filePath: 'src/e.ts', line: 1 },
            { findingId: 'finding-6', severity: 'blocker', summary: 'sixth', filePath: 'src/f.ts', line: 0 },
          ],
        },
      })),
    });
    await seedParkedRun(harness, 'blocker-after-round-2');
    const [run] = await statusRuns(harness);
    const findings = run.reviewFindings as readonly LaneRunParkFindingView[];
    expect(findings).toHaveLength(5);
    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual(['filePath', 'findingId', 'line', 'severity', 'summary']);
    }
    // The secret-shaped second finding is dropped; the /etc absolute path and
    // negative line are not present; the view never carries raw receipt fields.
    expect(findings.some((finding) => finding.findingId === 'finding-secret')).toBe(false);
    expect(findings.every((finding) => finding.filePath === null || !finding.filePath.startsWith('/'))).toBe(true);
  });

  it('returns saved findings for a blocker park with no attemptRepo or reviewReceipts', async () => {
    const harness = makeHarness({ withAttemptRepo: false });
    await seedParkedRun(harness, 'blocker-after-round-2', 1, [ATTEMPT_ID], [FINDING]);
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([FINDING]);
  });

  it('returns saved findings for a blocker park with an attempt with no head', async () => {
    const harness = makeHarness({
      reviewReceipts: reviewPort(async () => ({ outcome: 'not-found' })),
    });
    const record = runRecord({
      attemptIds: [ATTEMPT_ID],
      parked: {
        reason: 'blocker-after-round-2',
        qualifier: null,
        parkedFrom: 'gating',
        questionId: null,
        findings: [FINDING],
      },
      parkCount: 1,
    });
    expect(await harness.runRepo.create(record)).toMatchObject({ outcome: 'saved' });
    const entry: LaneRunJournalEntryRecord = laneRunConductEntry(ENTRY_1, RUN_ID, 'parked', NOW);
    expect(await harness.runJournal.append(entry)).toMatchObject({ outcome: 'appended' });
    const attemptWithoutHead: AttemptRecord = {
      ...collectedAttempt(),
      artifacts: null,
    };
    await harness.attemptRepo.saveAttempt(attemptWithoutHead);
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([FINDING]);
  });

  it('returns saved findings for a blocker park when receipt lookup throws', async () => {
    const harness = makeHarness({
      reviewReceipts: reviewPort(async () => {
        throw new Error('store down');
      }),
    });
    await seedParkedRun(harness, 'blocker-after-round-2', 1, [ATTEMPT_ID], [FINDING]);
    const [run] = await statusRuns(harness);
    expect(run.reviewFindings).toEqual([FINDING]);
  });
});
