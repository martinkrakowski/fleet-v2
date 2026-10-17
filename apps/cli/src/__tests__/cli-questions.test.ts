/**
 * End-to-end CLI tests for the `questions` command group over the seven
 * owner-question use cases.
 *
 * Every subcommand runs against a real composed runtime with a temp state
 * directory, so the owner-question store persists to
 * `<stateDir>/owner-questions.json` and reloads across invocations exactly as
 * separate CLI processes would see it. The one-way door is exercised through
 * the real decision transport: a declined decision file settles a question
 * without a signature, an approved one only through a valid Ed25519 signature
 * over the canonical decision bytes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { OwnerQuestionRecord } from '@fleet/operator-coordination';

const PROJECT_ID = 'proj-questions-1';
const POLICY_REVISION = 'policy-1';

/** Canonical decision bytes, written out so the test pins the signed format. */
function canonicalDecisionBytes(fields: {
  requestId: string;
  projectId: string;
  actionScope: string;
  expectedHeadSha: string | null;
  decisionRevision: string | null;
  grantId: string | null;
  state: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      requestId: fields.requestId,
      projectId: fields.projectId,
      actionScope: fields.actionScope,
      expectedHeadSha: fields.expectedHeadSha ?? null,
      decisionRevision: fields.decisionRevision ?? null,
      grantId: fields.grantId ?? null,
      state: fields.state,
    }),
    'utf8',
  );
}

/** One CLI invocation: exit code, raw stdout text and captured stderr. */
interface Invocation {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
}

/** A two-way question record the ask use case accepts as-is. */
function twoWayQuestion(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    questionId: id,
    askedBy: 'orchestrator',
    title: 'Pick the demo summary title',
    body: 'Which title should the demo summary carry?',
    options: [
      { id: 'keep', label: 'Keep the current title', consequence: 'No documentation change' },
      { id: 'rename', label: 'Rename to Fleet v2', consequence: 'Documentation is updated' },
    ],
    recommendation: { optionId: 'keep', because: 'Fewer moving parts' },
    doorKind: 'two-way',
    expiresAt: '2030-01-01T00:00:00Z',
    ...overrides,
  };
}

/** A one-way question record linked to an existing coordination request. */
function oneWayQuestion(id: string, linkedRequestId: string, expiresAt?: string): Record<string, unknown> {
  return {
    questionId: id,
    askedBy: 'orchestrator',
    title: 'Approve the merge?',
    body: 'The signed decision file for the linked request decides this question.',
    options: [
      { id: 'approve', label: 'Approve the merge', consequence: 'The merge may proceed' },
      { id: 'hold', label: 'Hold the merge', consequence: 'The merge stays blocked' },
    ],
    recommendation: { optionId: 'approve', because: 'Every required check passes' },
    doorKind: 'one-way',
    linkedRequestId,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

describe('fleet-v2 questions command group', () => {
  let suiteDir: string;
  let stateDir: string;
  let runtime: FleetCliRuntime;
  let ownerPublicKey: string;
  let ownerPrivateKey: KeyObject;

  beforeAll(() => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    ownerPublicKey = publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64');
    ownerPrivateKey = privateKey;
  });

  beforeEach(() => {
    suiteDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-questions-'));
    stateDir = path.join(suiteDir, 'state');
    mkdirSync(stateDir);
    runtime = createFleetCliRuntime({ stateDir, ownerPublicKey });
  });

  afterEach(() => {
    rmSync(suiteDir, { recursive: true, force: true });
  });

  const cli = async (argv: readonly string[]): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    };
    const code = await runCli([...argv], io, runtime);
    return { code, text: out.join(''), stderr: err.join('') };
  };

  /** Invoke without an injected runtime, so runCli composes one from --state-dir. */
  const composedCli = async (argv: readonly string[]): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    };
    const code = await runCli([...argv], io);
    return { code, text: out.join(''), stderr: err.join('') };
  };

  const jsonOf = <T>(invocation: Invocation): T => JSON.parse(invocation.text) as T;

  const writeQuestionFile = (name: string, payload: unknown): string => {
    const filePath = path.join(suiteDir, name);
    writeFileSync(filePath, JSON.stringify(payload));
    return filePath;
  };

  const recordLinkedRequest = async (requestId: string): Promise<void> => {
    const decision = await cli([
      'coordination',
      'request-decision',
      '--json',
      JSON.stringify({
        requestId,
        projectId: PROJECT_ID,
        kind: 'action-decision',
        actionScope: 'forge:merge-pr',
        expectedHeadSha: null,
        proposalDigest: `merge attempt for ${requestId}`,
        policyRevision: POLICY_REVISION,
      }),
    ]);
    expect(decision.code).toBe(0);
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('ask records a question the clock stamped, and list and show read it back', async () => {
    const asked = await cli(['questions', 'ask', '--file', writeQuestionFile('ask.json', twoWayQuestion('q-1'))]);
    expect(asked.code).toBe(0);
    const askedBody = jsonOf<{
      outcome: string;
      question: Pick<OwnerQuestionRecord, 'questionId' | 'state' | 'revision' | 'askedAt' | 'doorKind'>;
    }>(asked);
    expect(askedBody.outcome).toBe('asked');
    expect(askedBody.question).toMatchObject({
      questionId: 'q-1',
      state: 'open',
      revision: 1,
      doorKind: 'two-way',
    });
    // The asked-at moment comes from the composition root's real clock.
    expect(Number.isNaN(Date.parse(askedBody.question.askedAt))).toBe(false);

    const listed = await cli(['questions', 'list']);
    expect(listed.code).toBe(0);
    expect(jsonOf<{ questions: unknown[] }>(listed).questions).toHaveLength(1);

    const openList = await cli(['questions', 'list', '--state', 'open']);
    expect(jsonOf<{ questions: unknown[] }>(openList).questions).toHaveLength(1);
    const answeredList = await cli(['questions', 'list', '--state', 'answered']);
    expect(jsonOf<{ questions: unknown[] }>(answeredList).questions).toHaveLength(0);

    // `--since` takes an explicit zone and filters on the asked-at instant.
    const sincePast = await cli(['questions', 'list', '--since', '2020-01-01T00:00:00+02:00']);
    expect(jsonOf<{ questions: unknown[] }>(sincePast).questions).toHaveLength(1);
    const sinceFuture = await cli(['questions', 'list', '--since', '2030-01-01T00:00:00Z']);
    expect(jsonOf<{ questions: unknown[] }>(sinceFuture).questions).toHaveLength(0);

    const shown = await cli(['questions', 'show', 'q-1']);
    expect(shown.code).toBe(0);
    expect(jsonOf<{ outcome: string; question: { questionId: string } }>(shown)).toMatchObject({
      outcome: 'found',
      question: { questionId: 'q-1' },
    });

    const missing = await cli(['questions', 'show', 'q-never-asked']);
    expect(missing.code).toBe(1);
    expect(jsonOf<{ outcome: string }>(missing).outcome).toBe('not-found');
  });

  it('ask refuses a malformed record and reports file problems as usage errors', async () => {
    const oneOption = twoWayQuestion('q-bad', {
      options: [{ id: 'only', label: 'Only choice', consequence: 'None' }],
    });
    const refused = await cli(['questions', 'ask', '--file', writeQuestionFile('bad.json', oneOption)]);
    expect(refused.code).toBe(1);
    expect(jsonOf<{ outcome: string; reason: string }>(refused).outcome).toBe('refused');

    const noFile = await cli(['questions', 'ask']);
    expect(noFile.code).toBe(2);

    const missingFile = await cli(['questions', 'ask', '--file', path.join(suiteDir, 'absent.json')]);
    expect(missingFile.code).toBe(2);

    const brokenJson = await cli(['questions', 'ask', '--file', writeQuestionFile('broken.json', '{nope')]);
    expect(brokenJson.code).toBe(2);

    const jsonArray = await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('array.json', [twoWayQuestion('q-1')]),
    ]);
    expect(jsonArray.code).toBe(2);
  });

  it('answer records accept, option and reject on two-way questions, then acknowledge', async () => {
    await cli(['questions', 'ask', '--file', writeQuestionFile('ask-accept.json', twoWayQuestion('q-1'))]);

    const accept = await cli(['questions', 'answer', 'q-1', '--revision', '1', '--accept']);
    expect(accept.code).toBe(0);
    const acceptBody = jsonOf<{
      outcome: string;
      question: { state: string; answer: { shape: string; optionId: string | null; answeredVia: string } };
    }>(accept);
    expect(acceptBody.outcome).toBe('answered');
    expect(acceptBody.question.state).toBe('answered');
    expect(acceptBody.question.answer).toMatchObject({ shape: 'accept', optionId: 'keep', answeredVia: 'cli' });

    // Replaying the same answer is idempotent; a different answer for the
    // same revision is refused.
    const replay = await cli(['questions', 'answer', 'q-1', '--revision', '1', '--accept']);
    expect(replay.code).toBe(0);
    expect(jsonOf<{ outcome: string; replayed: boolean }>(replay)).toMatchObject({
      outcome: 'answered',
      replayed: true,
    });

    const different = await cli(['questions', 'answer', 'q-1', '--revision', '1', '--reject']);
    expect(different.code).toBe(1);
    expect(jsonOf<{ outcome: string }>(different).outcome).toBe('refused');

    const acknowledged = await cli(['questions', 'acknowledge', 'q-1', '--by', 'orchestrator']);
    expect(acknowledged.code).toBe(0);
    const ackBody = jsonOf<{
      outcome: string;
      question: { state: string };
      acknowledgement: { by: string };
    }>(acknowledged);
    expect(ackBody.outcome).toBe('acknowledged');
    expect(ackBody.question.state).toBe('acknowledged');
    expect(ackBody.acknowledgement.by).toBe('orchestrator');

    const again = await cli(['questions', 'acknowledge', 'q-1', '--by', 'orchestrator']);
    expect(again.code).toBe(1);
    expect(jsonOf<{ outcome: string }>(again).outcome).toBe('refused');

    // A different option with free text records advice beside the choice.
    await cli(['questions', 'ask', '--file', writeQuestionFile('ask-option.json', twoWayQuestion('q-2'))]);
    const option = await cli([
      'questions',
      'answer',
      'q-2',
      '--revision',
      '1',
      '--option',
      'rename',
      '--text',
      'Please rename it',
    ]);
    expect(option.code).toBe(0);
    const optionBody = jsonOf<{
      question: { answer: { shape: string; optionId: string | null; text: string | null } };
    }>(option);
    expect(optionBody.question.answer).toMatchObject({
      shape: 'answer',
      optionId: 'rename',
      text: 'Please rename it',
    });

    // A rejection records the optional reason and settles wait with exit 1.
    await cli(['questions', 'ask', '--file', writeQuestionFile('ask-reject.json', twoWayQuestion('q-3'))]);
    const reject = await cli(['questions', 'answer', 'q-3', '--revision', '1', '--reject', '--reason', 'Not yet']);
    expect(reject.code).toBe(0);
    const rejectBody = jsonOf<{
      question: { state: string; answer: { shape: string; reason: string | null } };
    }>(reject);
    expect(rejectBody.question.state).toBe('rejected');
    expect(rejectBody.question.answer).toMatchObject({ shape: 'reject', reason: 'Not yet' });

    const waited = await cli(['questions', 'wait', 'q-3', '--max', '2s', '--interval', '20ms']);
    expect(waited.code).toBe(1);
    const waitBody = jsonOf<{ outcome: string; question: { state: string } }>(waited);
    expect(waitBody.outcome).toBe('rejected');
    expect(waitBody.question.state).toBe('rejected');
  });

  it('answer refuses a one-way question: only a signed decision answers it', async () => {
    await recordLinkedRequest('req-one-way');
    const asked = await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('one-way.json', oneWayQuestion('q-one-1', 'req-one-way')),
    ]);
    expect(asked.code).toBe(0);
    expect(jsonOf<{ question: { doorKind: string } }>(asked).question.doorKind).toBe('one-way');

    const refused = await cli(['questions', 'answer', 'q-one-1', '--revision', '1', '--accept']);
    expect(refused.code).toBe(1);
    const body = jsonOf<{ outcome: string; reason: string }>(refused);
    expect(body.outcome).toBe('refused');
    expect(body.reason).toContain('one-way');

    const shown = await cli(['questions', 'show', 'q-one-1']);
    expect(jsonOf<{ question: { state: string } }>(shown).question.state).toBe('open');
  });

  it('sync settles one-way questions from verified signed decisions only', async () => {
    await recordLinkedRequest('req-declined');
    await recordLinkedRequest('req-approved');
    await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('one-declined.json', oneWayQuestion('q-one-d', 'req-declined')),
    ]);
    await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('one-approved.json', oneWayQuestion('q-one-a', 'req-approved')),
    ]);

    // Without decision files both questions stay open, and the run completes.
    const first = await cli(['questions', 'sync']);
    expect(first.code).toBe(0);
    const firstBody = jsonOf<{
      outcome: string;
      answered: unknown[];
      rejected: unknown[];
      unchanged: { questionId: string }[];
    }>(first);
    expect(firstBody.outcome).toBe('synced');
    expect(firstBody.answered).toHaveLength(0);
    expect(firstBody.rejected).toHaveLength(0);
    expect(firstBody.unchanged.map((question) => question.questionId).sort()).toEqual([
      'q-one-a',
      'q-one-d',
    ]);

    const decisionsDir = path.join(stateDir, 'decisions');
    mkdirSync(decisionsDir);
    writeFileSync(path.join(decisionsDir, 'req-declined.json'), `${JSON.stringify({ state: 'declined' })}\n`);
    const signature = sign(
      null,
      canonicalDecisionBytes({
        requestId: 'req-approved',
        projectId: PROJECT_ID,
        actionScope: 'forge:merge-pr',
        expectedHeadSha: null,
        decisionRevision: 'r1',
        grantId: 'grant-1',
        state: 'approved',
      }),
      ownerPrivateKey,
    ).toString('base64');
    writeFileSync(
      path.join(decisionsDir, 'req-approved.json'),
      `${JSON.stringify({ state: 'approved', decisionRevision: 'r1', grantId: 'grant-1', signature })}\n`,
    );

    const second = await cli(['questions', 'sync']);
    expect(second.code).toBe(0);
    const secondBody = jsonOf<{
      answered: { questionId: string; answer: { answeredVia: string } }[];
      rejected: { questionId: string }[];
    }>(second);
    expect(secondBody.answered).toHaveLength(1);
    expect(secondBody.answered[0]).toMatchObject({
      questionId: 'q-one-a',
      answer: { answeredVia: 'signed-decision' },
    });
    expect(secondBody.rejected.map((question) => question.questionId)).toEqual(['q-one-d']);

    const shown = await cli(['questions', 'show', 'q-one-a']);
    expect(jsonOf<{ question: { state: string } }>(shown).question.state).toBe('answered');

    // Settled questions are no longer open, so a second sync moves nothing.
    const third = await cli(['questions', 'sync']);
    const thirdBody = jsonOf<{ answered: unknown[]; rejected: unknown[] }>(third);
    expect(thirdBody.answered).toHaveLength(0);
    expect(thirdBody.rejected).toHaveLength(0);
  });

  it('expire moves only past-due two-way questions and keeps one-way questions open', async () => {
    await recordLinkedRequest('req-expiry');
    await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('due.json', twoWayQuestion('q-due', { expiresAt: '2020-01-01T00:00:00Z' })),
    ]);
    await cli(['questions', 'ask', '--file', writeQuestionFile('future.json', twoWayQuestion('q-future'))]);
    // No expiry at all: the question never leaves open through the clock.
    await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('none.json', twoWayQuestion('q-none', { expiresAt: undefined })),
    ]);
    // A one-way question never expires through the clock, even past its own
    // expiry; only a signed decision settles it.
    await cli([
      'questions',
      'ask',
      '--file',
      writeQuestionFile('one-due.json', oneWayQuestion('q-one-due', 'req-expiry', '2020-01-01T00:00:00Z')),
    ]);

    const expired = await cli(['questions', 'expire']);
    expect(expired.code).toBe(0);
    const body = jsonOf<{
      outcome: string;
      expired: { questionId: string }[];
      unchanged: { questionId: string }[];
    }>(expired);
    expect(body.outcome).toBe('expired');
    expect(body.expired.map((question) => question.questionId)).toEqual(['q-due']);
    const unchangedIds = body.unchanged.map((question) => question.questionId);
    expect(unchangedIds).toContain('q-future');
    expect(unchangedIds).toContain('q-none');
    expect(unchangedIds).toContain('q-one-due');

    const shown = await cli(['questions', 'show', 'q-due']);
    expect(jsonOf<{ question: { state: string } }>(shown).question.state).toBe('expired');
    const stillOpen = await cli(['questions', 'show', 'q-one-due']);
    expect(jsonOf<{ question: { state: string } }>(stillOpen).question.state).toBe('open');
  });

  it('wait returns when the question is answered while it polls', async () => {
    await cli(['questions', 'ask', '--file', writeQuestionFile('wait.json', twoWayQuestion('q-wait'))]);
    const waitPromise = cli(['questions', 'wait', 'q-wait', '--max', '10s', '--interval', '20ms']);
    await delay(120);
    const answered = await cli(['questions', 'answer', 'q-wait', '--revision', '1', '--accept']);
    expect(answered.code).toBe(0);
    const waited = await waitPromise;
    expect(waited.code).toBe(0);
    const body = jsonOf<{
      outcome: string;
      question: { state: string; answer: { shape: string } };
    }>(waited);
    expect(body.outcome).toBe('answered');
    expect(body.question.state).toBe('answered');
    expect(body.question.answer).toMatchObject({ shape: 'accept' });

    // An acknowledged question also completes the wait with exit 0.
    await cli(['questions', 'acknowledge', 'q-wait', '--by', 'orchestrator']);
    const acknowledged = await cli(['questions', 'wait', 'q-wait', '--max', '1s', '--interval', '20ms']);
    expect(acknowledged.code).toBe(0);
    expect(jsonOf<{ outcome: string }>(acknowledged).outcome).toBe('acknowledged');
  });

  it('wait times out with a short max and reports the timeout in the body', async () => {
    await cli(['questions', 'ask', '--file', writeQuestionFile('slow.json', twoWayQuestion('q-slow'))]);
    const timedOut = await cli(['questions', 'wait', 'q-slow', '--max', '200ms', '--interval', '25ms']);
    expect(timedOut.code).toBe(1);
    const body = jsonOf<{ outcome: string; reason: string }>(timedOut);
    expect(body.outcome).toBe('timeout');
    expect(body.reason).toContain('still open');

    const unknown = await cli(['questions', 'wait', 'q-absent', '--max', '150ms', '--interval', '25ms']);
    expect(unknown.code).toBe(1);
    expect(jsonOf<{ outcome: string; reason: string }>(unknown)).toMatchObject({
      outcome: 'timeout',
      reason: 'no owner question is recorded for that id',
    });
  });

  it('usage errors exit 2 across the group', async () => {
    await cli(['questions', 'ask', '--file', writeQuestionFile('usage.json', twoWayQuestion('q-usage'))]);

    const bare = await cli(['questions']);
    expect(bare.code).toBe(2);
    const unknownSubcommand = await cli(['questions', 'bogus']);
    expect(unknownSubcommand.code).toBe(2);

    const noId = await cli(['questions', 'show']);
    expect(noId.code).toBe(2);
    expect(noId.stderr).toContain('question id');

    const badState = await cli(['questions', 'list', '--state', 'bogus']);
    expect(badState.code).toBe(2);
    const naiveSince = await cli(['questions', 'list', '--since', '2026-10-16T08:00:00']);
    expect(naiveSince.code).toBe(2);

    const noShape = await cli(['questions', 'answer', 'q-usage', '--revision', '1']);
    expect(noShape.code).toBe(2);
    const twoShapes = await cli(['questions', 'answer', 'q-usage', '--revision', '1', '--accept', '--reject']);
    expect(twoShapes.code).toBe(2);
    const acceptWithReason = await cli([
      'questions',
      'answer',
      'q-usage',
      '--revision',
      '1',
      '--accept',
      '--reason',
      'why',
    ]);
    expect(acceptWithReason.code).toBe(2);
    const rejectWithText = await cli(['questions', 'answer', 'q-usage', '--revision', '1', '--reject', '--text', 'no']);
    expect(rejectWithText.code).toBe(2);
    const textWithoutOption = await cli(['questions', 'answer', 'q-usage', '--revision', '1', '--text', 'free text']);
    expect(textWithoutOption.code).toBe(2);
    const zeroRevision = await cli(['questions', 'answer', 'q-usage', '--revision', '0', '--accept']);
    expect(zeroRevision.code).toBe(2);
    const textRevision = await cli(['questions', 'answer', 'q-usage', '--revision', 'abc', '--accept']);
    expect(textRevision.code).toBe(2);

    const noBy = await cli(['questions', 'acknowledge', 'q-usage']);
    expect(noBy.code).toBe(2);

    const badMax = await cli(['questions', 'wait', 'q-usage', '--max', 'soon']);
    expect(badMax.code).toBe(2);
    const bareNumberMax = await cli(['questions', 'wait', 'q-usage', '--max', '30']);
    expect(bareNumberMax.code).toBe(2);
    const zeroInterval = await cli(['questions', 'wait', 'q-usage', '--max', '1s', '--interval', '0s']);
    expect(zeroInterval.code).toBe(2);
  });

  it('questions --help prints the group help and exits 0', async () => {
    for (const argv of [['questions', '--help'], ['questions', 'help'], ['questions', '-h']]) {
      const help = await cli(argv);
      expect(help.code).toBe(0);
      expect(help.text).toContain('Usage: fleet-v2 questions');
      expect(help.text).toContain('ask --file');
      expect(help.text).toContain('acknowledge <id> --by <name>');
    }
  });

  it('a free-text flag value of -h or --help is never read as a help request', async () => {
    for (const value of ['-h', '--help']) {
      const result = await cli(['questions', 'answer', 'q-missing', '--revision', '1', '--reject', '--reason', value]);
      expect(result.text).not.toContain('Usage: fleet-v2 questions');
      expect(result.code).not.toBe(0);
    }
    const subHelp = await cli(['questions', 'answer', '--help']);
    expect(subHelp.code).toBe(0);
    expect(subHelp.text).toContain('Usage: fleet-v2 questions');
  });

  it('the composed runtime answers through --state-dir without an injected runtime', async () => {
    const asked = await composedCli([
      '--state-dir',
      stateDir,
      'questions',
      'ask',
      '--file',
      writeQuestionFile('composed.json', twoWayQuestion('q-composed')),
    ]);
    expect(asked.code).toBe(0);
    expect(jsonOf<{ outcome: string }>(asked).outcome).toBe('asked');

    // The composition root persisted the question under the state directory.
    expect(existsSync(path.join(stateDir, 'owner-questions.json'))).toBe(true);

    // A second, freshly composed invocation reads the same store from disk.
    const shown = await composedCli(['--state-dir', stateDir, 'questions', 'show', 'q-composed']);
    expect(shown.code).toBe(0);
    expect(jsonOf<{ question: { questionId: string } }>(shown).question.questionId).toBe('q-composed');
  });

  it('without a state dir the questions runtime stays in-memory', async () => {
    const memoryRuntime = createFleetCliRuntime({});
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    };
    const asked = await runCli(
      ['questions', 'ask', '--file', writeQuestionFile('memory.json', twoWayQuestion('q-mem'))],
      io,
      memoryRuntime,
    );
    expect(asked).toBe(0);
    const shown = await runCli(['questions', 'show', 'q-mem'], io, memoryRuntime);
    expect(shown).toBe(0);

    // A separate in-memory runtime sees nothing: the store is disposable.
    const elsewhere = await runCli(['questions', 'show', 'q-mem'], io, createFleetCliRuntime({}));
    expect(elsewhere).toBe(1);
  });
});
