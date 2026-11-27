// `conductor premerge attest` CLI tests.
/**
 * Every test drives `premergeAttestCommand` over a fake runtime whose ports
 * are plain spies: the lane-run, attempt and evidence stores, the forge PR
 * read, the review-receipt read and the CI read. Nothing touches a real
 * state directory, no forge call and no subprocess happens — the pre-merge
 * attestation only reads pre-check facts and, with `--yes`, records one
 * manual receipt through the (spied) `RecordReviewReceiptUseCase` port.
 * Hostile records (getter-backed objects, throwing Proxies) must refuse with
 * `invalid-record` without ever invoking a getter.
 */

import { describe, expect, it } from 'vitest';

import { assessmentIdForAttempt, type ReviewReceiptRecord } from '@fleet/evidence-and-acceptance';

import type { FleetCliRuntime } from '../composition.js';
import { premergeAttestCommand, readPremergeAttestFlags } from '../conductor-premerge-attest.js';
import { CONDUCTOR_HELP, type ConductorCliOptions } from '../conductor.js';
import type { CliIo } from '../index.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-example-1';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const NOW = '2026-11-25T10:00:00.000Z';
const IMPL = 'example-provider/glm-5.3';
const REVIEWER = 'example-provider/grok-4.7';
const PROJECT_ID = 'project-example';

const BASE_OPTIONS: ConductorCliOptions = { now: () => NOW, stateDir: '/state-dir-example' };

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text) => {
      outLines.push(text);
    },
    stderr: (text) => {
      errLines.push(text);
    },
  };
}

function runRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    attemptIds: [ATTEMPT_ID],
    prNumber: 7,
    branchName: 'fleet/run-example',
    parked: null,
    revision: 1,
    ...overrides,
  };
}

function attemptRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-example-1',
    state: 'collected',
    worktreePath: '/tmp/opencode/wo-example-1/wt-example-1',
    artifacts: { headCommit: HEAD, commitsSinceBase: [HEAD], collectedArtifactPaths: [], notes: 'present' },
    ...overrides,
  };
}

function passedReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'passed',
    findings: [],
    readOnlyVerified: true,
    reviewerModel: REVIEWER,
    ...overrides,
  };
}

function assessmentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: assessmentIdForAttempt(ATTEMPT_ID),
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: IMPL,
    requestedReviewerModel: undefined,
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: NOW,
    ...overrides,
  };
}

interface PortAnswers {
  readonly run?: unknown;
  readonly attempt?: unknown;
  readonly pullRequest?: unknown;
  readonly review?: unknown;
  readonly ci?: unknown;
  readonly inspection?: unknown;
  /** The review receipt read the pass gate reads before the attestation. */
  readonly preMergeReceipt?: Record<string, unknown>;
}

interface SpiedCalls {
  readonly recordedReceipts: ReviewReceiptRecord[];
}

function makeRuntime(answers: PortAnswers): { runtime: FleetCliRuntime; calls: SpiedCalls } {
  const recordedReceipts: ReviewReceiptRecord[] = [];
  const runtime = {
    conductor: {
      laneRunRepository: {
        get: async () => answers.run ?? runRecord(),
      },
      reviewRequest: {
        findLatestReceiptOfKind: async () =>
          answers.review ?? { outcome: 'found', receipt: answers.preMergeReceipt ?? passedReceipt() },
      },
      ciState: {
        readHeadCiState: async (request: { headSha: string }) =>
          answers.ci ?? { headSha: request.headSha, state: 'passed', reason: 'read' },
      },
      newUlid: () => '01JB0000000000000000000001',
    },
    execution: {
      attemptRepository: {
        findAttemptById: async () => answers.attempt ?? attemptRecord(),
      },
      forgeRead: {
        readPullRequest: async () =>
          answers.pullRequest ?? {
            outcome: 'found',
            pullRequest: { number: 7, headSha: HEAD, headRef: 'fleet/run-example', state: 'open' },
          },
      },
    },
    evidence: {
      inspectAcceptanceEvidence: {
        inspectAcceptanceEvidence: async () =>
          answers.inspection ?? { outcome: 'found', assessment: assessmentRecord() },
      },
      recordReviewReceipt: {
        recordReviewReceipt: async (request: { receipt: ReviewReceiptRecord }) => {
          recordedReceipts.push(request.receipt);
          return { outcome: 'recorded', assessment: assessmentRecord() };
        },
      },
    },
  } as unknown as FleetCliRuntime;
  return { runtime, calls: { recordedReceipts } };
}

async function runAttest(
  runtime: FleetCliRuntime,
  args: readonly string[],
  options: ConductorCliOptions = BASE_OPTIONS,
): Promise<{ code: number; io: CapturedIo }> {
  const io = captureIo();
  const code = await premergeAttestCommand(args, io, runtime, options);
  return { code, io };
}

function lastOut(io: CapturedIo): Record<string, unknown> {
  const last = io.outLines[io.outLines.length - 1] ?? '';
  return JSON.parse(last) as Record<string, unknown>;
}

describe('readPremergeAttestFlags', () => {
  it('parses --run with a space or = value and the optional --yes', () => {
    const io = captureIo();
    expect(readPremergeAttestFlags(['--run', RUN_ID], io)).toEqual({ run: RUN_ID, yes: false });
    expect(readPremergeAttestFlags([`--run=${RUN_ID}`, '--yes'], io)).toEqual({ run: RUN_ID, yes: true });
    expect(readPremergeAttestFlags(['--run', `  ${RUN_ID}  `], io)).toEqual({ run: RUN_ID, yes: false });
    expect(io.errLines).toEqual([]);
  });
});

describe('conductor premerge attest usage errors (exit 2)', () => {
  it('refuses unknown flags, missing --run, repeated flags, positionals and missing stateDir with exit 2', async () => {
    const usageCases: readonly (readonly string[])[] = [
      [],
      ['attest-again'],
      ['--unknown'],
      ['--run'],
      ['--run', ''],
      ['--run='],
      ['--run', RUN_ID, '--run', RUN_ID],
      [`--run=${RUN_ID}`, '--run', RUN_ID],
      ['--run', RUN_ID, '--yes', '--yes'],
      ['--run', RUN_ID, 'extra'],
      ['--run', RUN_ID, 'positional', '--yes'],
    ];
    for (const argv of usageCases) {
      const io = captureIo();
      const code = await premergeAttestCommand(argv, io, makeRuntime({}).runtime, BASE_OPTIONS);
      expect(code, argv.join(' ')).toBe(2);
      expect(io.outLines, argv.join(' ')).toEqual([]);
      expect(io.errLines.length, argv.join(' ')).toBe(1);
      expect(io.errLines[0], argv.join(' ')).toContain('conductor premerge attest');
      expect(io.errLines[0], argv.join(' ')).toBe(`${io.errLines[0]?.split('\n')[0]}\n${CONDUCTOR_HELP}\n`);
    }
    // A missing state directory is a usage error too, even with valid flags.
    const io = captureIo();
    const code = await premergeAttestCommand(['--run', RUN_ID, '--yes'], io, makeRuntime({}).runtime, { now: () => NOW });
    expect(code).toBe(2);
    expect(io.outLines).toEqual([]);
    expect(io.errLines.join('')).toContain('durable state directory');
  });
});

describe('conductor premerge attest records the Tier 2 owner receipt', () => {
  it('attests with --yes: exit 0, one recorded manual pre-merge receipt with no requestId', async () => {
    const { runtime, calls } = makeRuntime({});
    const { code, io } = await runAttest(runtime, ['--run', RUN_ID, '--yes']);
    expect(code).toBe(0);
    expect(lastOut(io)).toEqual({
      outcome: 'attested',
      reason: 'attested',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      headSha: HEAD,
      receiptId: 'rcp-01JB0000000000000000000001',
    });
    expect(calls.recordedReceipts).toHaveLength(1);
    const receipt = calls.recordedReceipts[0]!;
    expect(receipt.requestId).toBeUndefined();
    expect(receipt.kind).toBe('pre-merge');
    expect(receipt.result).toBe('pass');
    expect(receipt.readOnlyVerified).toBe(true);
    expect(receipt.candidateHeadSha).toBe(HEAD);
    expect(receipt.attemptId).toBe(ATTEMPT_ID);
    expect(receipt.assessmentId).toBe(assessmentIdForAttempt(ATTEMPT_ID));
    expect(receipt.implementerModel).toBe(IMPL);
    expect(receipt.policyRevision).toBe('policy-example-1');
    expect(receipt.completedAtIso).toBe(NOW);
    expect(receipt.evidenceRef).toBe(`conductor-premerge-attest:${RUN_ID}@${HEAD.slice(0, 12)}`);
    expect(receipt.findings).toEqual([]);
  });

  it('records requestedReviewerModel when defined and in a different model family from implementerModel', async () => {
    const { runtime, calls } = makeRuntime({
      inspection: { outcome: 'found', assessment: assessmentRecord({ requestedReviewerModel: ' other-provider/qwen-3 ' }) },
    });
    const { code, io } = await runAttest(runtime, ['--run', RUN_ID, '--yes']);
    expect(code).toBe(0);
    expect(lastOut(io)).toMatchObject({ outcome: 'attested' });
    expect(calls.recordedReceipts).toHaveLength(1);
    expect(calls.recordedReceipts[0]!.reviewerModel).toBe('other-provider/qwen-3');
  });

  it('refuses with reviewer-unavailable and records nothing when requestedReviewerModel is empty, invalid, or same model family', async () => {
    const cases: readonly unknown[] = ['', '   ', 7, null, IMPL, 'other-vendor/glm-4.5'];
    for (const requested of cases) {
      const { runtime, calls } = makeRuntime({
        inspection: { outcome: 'found', assessment: assessmentRecord({ requestedReviewerModel: requested }) },
      });
      const { code, io } = await runAttest(runtime, ['--run', RUN_ID, '--yes']);
      expect(code, String(requested)).toBe(1);
      expect(lastOut(io), String(requested)).toEqual({ outcome: 'refused', reason: 'reviewer-unavailable', runId: RUN_ID });
      expect(calls.recordedReceipts, String(requested)).toHaveLength(0);
    }
  });

  it('records conductor pre-merge reviewerModel when requestedReviewerModel is undefined', async () => {
    const { runtime, calls } = makeRuntime({
      preMergeReceipt: passedReceipt({ reviewerModel: 'example-provider/grok-4.7' }),
      inspection: { outcome: 'found', assessment: assessmentRecord({ requestedReviewerModel: undefined }) },
    });
    const { code } = await runAttest(runtime, ['--run', RUN_ID, '--yes']);
    expect(code).toBe(0);
    expect(calls.recordedReceipts).toHaveLength(1);
    expect(calls.recordedReceipts[0]!.reviewerModel).toBe('example-provider/grok-4.7');
  });
});

describe('conductor premerge attest refusals (exit 1)', () => {
  const notTier2 = { run: runRecord({ tier: 1 }) };
  const headMismatch = { pullRequest: { outcome: 'found', pullRequest: { number: 7, headSha: OTHER_HEAD } } };
  const headNotFound = { pullRequest: { outcome: 'not-found' } };
  const reviewNotPassed = { preMergeReceipt: passedReceipt({ verdict: 'failed' }) };
  const reviewMissing = { review: { outcome: 'not-found' } };
  const ciNotGreen = { ci: { headSha: HEAD, state: 'failed', reason: 'read' } };
  const ciHeadMismatch = { ci: { headSha: OTHER_HEAD, state: 'passed', reason: 'read' } };
  const noYes = {};

  /** A getter-backed object: the snapshot must refuse without running the getter. */
  function getterBacked(): Record<string, unknown> {
    return Object.defineProperty({}, 'tier', {
      get() {
        throw new Error('the getter must never run');
      },
      enumerable: true,
    });
  }

  /** A Proxy whose traps all throw: the snapshot must map it to null. */
  function throwingProxy(): unknown {
    return new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile proxy');
        },
        ownKeys() {
          throw new Error('hostile proxy');
        },
        getOwnPropertyDescriptor() {
          throw new Error('hostile proxy');
        },
      },
    );
  }

  const cases: readonly {
    readonly reason: string;
    readonly answers: PortAnswers;
    readonly argv?: readonly string[];
    readonly assert?: (calls: SpiedCalls) => void;
  }[] = [
    { reason: 'not-tier-2', answers: notTier2 },
    { reason: 'head-mismatch', answers: headMismatch },
    { reason: 'head-mismatch', answers: headNotFound },
    { reason: 'review-not-passed', answers: reviewNotPassed },
    { reason: 'review-not-passed', answers: reviewMissing },
    { reason: 'ci-not-green', answers: ciNotGreen },
    { reason: 'ci-not-green', answers: ciHeadMismatch },
    {
      reason: 'no---yes',
      answers: noYes,
      argv: ['--run', RUN_ID],
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'reviewer-unavailable',
      answers: { preMergeReceipt: passedReceipt({ reviewerModel: IMPL }) },
    },
    {
      reason: 'invalid-record',
      answers: { run: getterBacked() },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'invalid-record',
      answers: { attempt: throwingProxy() },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'invalid-record',
      answers: { attempt: attemptRecord({ artifacts: { headCommit: 'zz'.repeat(20) } }) },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'invalid-record',
      answers: { inspection: { outcome: 'found', assessment: throwingProxy() } },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'invalid-record',
      answers: { pullRequest: getterBacked() },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'invalid-record',
      answers: { review: getterBacked() },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
    {
      reason: 'invalid-record',
      answers: { ci: getterBacked() },
      assert: (calls) => expect(calls.recordedReceipts).toHaveLength(0),
    },
  ];

  it.each(cases)('refuses with reason $reason and exit 1 without recording a receipt', async (testCase) => {
    const { runtime, calls } = makeRuntime(testCase.answers);
    const { code, io } = await runAttest(runtime, testCase.argv ?? ['--run', RUN_ID, '--yes']);
    expect(code, testCase.reason).toBe(1);
    expect(lastOut(io), testCase.reason).toEqual({
      outcome: 'refused',
      reason: testCase.reason,
      ...(testCase.reason === 'no---yes' ? { runId: RUN_ID, attemptId: ATTEMPT_ID, headSha: HEAD } : { runId: RUN_ID }),
    });
    if (testCase.assert !== undefined) {
      testCase.assert(calls);
    } else {
      // No refusal path other than no---yes and reviewer-unavailable ever
      // reaches the recording port.
      if (testCase.reason !== 'reviewer-unavailable') {
        expect(calls.recordedReceipts, testCase.reason).toHaveLength(0);
      }
    }
  });

  it('never invokes a getter while snapshotting a getter-backed run, attempt or assessment', async () => {
    let getterRuns = 0;
    const hostile = Object.defineProperty({}, 'tier', {
      get() {
        getterRuns += 1;
        return 2;
      },
      enumerable: true,
    });
    const { runtime } = makeRuntime({ run: hostile });
    const { code, io } = await runAttest(runtime, ['--run', RUN_ID, '--yes']);
    expect(code).toBe(1);
    expect(lastOut(io)).toEqual({ outcome: 'refused', reason: 'invalid-record', runId: RUN_ID });
    expect(getterRuns).toBe(0);
  });
});
