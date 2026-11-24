/**
 * VB09: usage validation for `questions answer` and `questions acknowledge`.
 * Every refusal path must exit 2 through `CliUsageError` before any use case
 * is invoked, and the valid paths must forward exactly the typed request.
 * Each check in `questions.ts` is an O(1) scalar or flag-count test on the
 * already-parsed payload, so no additional cost bound applies.
 */
import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type AnswerCall = Record<string, unknown>;
type AcknowledgeCall = Record<string, unknown>;

const runWith = async (
  runtime: FleetCliRuntime,
  argv: readonly string[],
): Promise<Invocation> => {
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
  return { code, stdout: out.join(''), stderr: err.join('') };
};

describe('questions answer and acknowledge usage validation', () => {
  const harness = () => {
    const answerCalls: AnswerCall[] = [];
    const acknowledgeCalls: AcknowledgeCall[] = [];
    const base = createFleetCliRuntime({});
    const runtime = {
      ...base,
      coordination: {
        ...base.coordination,
        answerOwnerQuestion: {
          answerOwnerQuestion: async (request: AnswerCall) => {
            answerCalls.push({ ...request });
            return { outcome: 'answered' };
          },
        },
        acknowledgeOwnerAnswer: {
          acknowledgeOwnerAnswer: async (request: AcknowledgeCall) => {
            acknowledgeCalls.push({ ...request });
            return { outcome: 'acknowledged' };
          },
        },
      },
    } as unknown as FleetCliRuntime;
    return { runtime, answerCalls, acknowledgeCalls };
  };

  it('answer refuses missing, zero, fractional, and non-numeric --revision without calling the use case', async () => {
    const { runtime, answerCalls } = harness();
    for (const argv of [
      ['questions', 'answer', 'q-1', '--accept'],
      ['questions', 'answer', 'q-1', '--accept', '--revision', '0'],
      ['questions', 'answer', 'q-1', '--accept', '--revision', '1.5'],
      ['questions', 'answer', 'q-1', '--accept', '--revision', 'abc'],
    ]) {
      const invocation = await runWith(runtime, argv);
      expect(invocation.code, `exit code for ${argv.join(' ')}`).toBe(2);
      expect(invocation.stderr, `stderr for ${argv.join(' ')}`).toContain(
        "requires '--revision <n>'",
      );
    }
    expect(answerCalls).toHaveLength(0);
  });

  it('answer refuses zero or multiple shape flags without calling the use case', async () => {
    const { runtime, answerCalls } = harness();
    for (const argv of [
      ['questions', 'answer', 'q-1', '--revision', '1'],
      ['questions', 'answer', 'q-1', '--revision', '1', '--accept', '--reject'],
      ['questions', 'answer', 'q-1', '--revision', '1', '--accept', '--option', 'o1'],
      ['questions', 'answer', 'q-1', '--revision', '1', '--reject', '--option', 'o1'],
    ]) {
      const invocation = await runWith(runtime, argv);
      expect(invocation.code, `exit code for ${argv.join(' ')}`).toBe(2);
      expect(invocation.stderr, `stderr for ${argv.join(' ')}`).toContain(
        'requires exactly one of',
      );
    }
    expect(answerCalls).toHaveLength(0);
  });

  it('answer refuses incompatible modifier combinations without calling the use case', async () => {
    const { runtime, answerCalls } = harness();
    for (const [argv, message] of [
      [['questions', 'answer', 'q-1', '--revision', '1', '--accept', '--reason', 'x'], "takes no '--reason' or '--text'"],
      [['questions', 'answer', 'q-1', '--revision', '1', '--accept', '--text', 'x'], "takes no '--reason' or '--text'"],
      [['questions', 'answer', 'q-1', '--revision', '1', '--reject', '--option', 'o1'], 'requires exactly one of'],
      [['questions', 'answer', 'q-1', '--revision', '1', '--reject', '--text', 'x'], "'--reject' takes an optional '--reason' only"],
      [['questions', 'answer', 'q-1', '--revision', '1', '--text', 'x'], 'requires exactly one of'],
    ] as const) {
      const invocation = await runWith(runtime, [...argv]);
      expect(invocation.code, `exit code for ${argv.join(' ')}`).toBe(2);
      expect(invocation.stderr, `stderr for ${argv.join(' ')}`).toContain(message);
    }
    expect(answerCalls).toHaveLength(0);
  });

  it('answer forwards a --reject --reason answer with the revision and without option or text keys', async () => {
    const { runtime, answerCalls } = harness();
    const invocation = await runWith(runtime, [
      'questions',
      'answer',
      'q-1',
      '--reject',
      '--reason',
      'x',
      '--revision',
      '2',
    ]);
    expect(invocation.code).toBe(0);
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]).toEqual({
      questionId: 'q-1',
      questionRevision: 2,
      shape: 'reject',
      answeredVia: 'cli',
      reason: 'x',
    });
    expect('optionId' in answerCalls[0]).toBe(false);
    expect('text' in answerCalls[0]).toBe(false);
  });

  it('answer forwards a valid --option --text payload with only the answer-shape keys', async () => {
    const { runtime, answerCalls } = harness();
    const invocation = await runWith(runtime, [
      'questions',
      'answer',
      'q-1',
      '--revision',
      '3',
      '--option',
      'o1',
      '--text',
      't',
    ]);
    expect(invocation.code).toBe(0);
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]).toEqual({
      questionId: 'q-1',
      questionRevision: 3,
      shape: 'answer',
      answeredVia: 'cli',
      optionId: 'o1',
      text: 't',
    });
    expect('reason' in answerCalls[0]).toBe(false);
  });

  it('answer forwards a bare --accept payload with only the accept-shape keys', async () => {
    const { runtime, answerCalls } = harness();
    const invocation = await runWith(runtime, [
      'questions',
      'answer',
      'q-1',
      '--revision',
      '3',
      '--accept',
    ]);
    expect(invocation.code).toBe(0);
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]).toEqual({
      questionId: 'q-1',
      questionRevision: 3,
      shape: 'accept',
      answeredVia: 'cli',
    });
  });

  it('acknowledge refuses a missing question id without calling the use case', async () => {
    const { runtime, acknowledgeCalls } = harness();
    const invocation = await runWith(runtime, ['questions', 'acknowledge', '--by', 'alice']);
    expect(invocation.code).toBe(2);
    expect(invocation.stderr).toContain('questions acknowledge requires a question id');
    expect(acknowledgeCalls).toHaveLength(0);
  });

  it('acknowledge refuses missing or blank --by without calling the use case', async () => {
    const { runtime, acknowledgeCalls } = harness();
    for (const argv of [
      ['questions', 'acknowledge', 'q-1'],
      ['questions', 'acknowledge', 'q-1', '--by', '   '],
      ['questions', 'acknowledge', 'q-1', '--by', ''],
    ]) {
      const invocation = await runWith(runtime, argv);
      expect(invocation.code, `exit code for ${argv.join(' ')}`).toBe(2);
      expect(invocation.stderr, `stderr for ${argv.join(' ')}`).toContain(
        "requires '--by <name>'",
      );
    }
    expect(acknowledgeCalls).toHaveLength(0);
  });

  it('acknowledge forwards the question id and actor to the use case', async () => {
    const { runtime, acknowledgeCalls } = harness();
    const invocation = await runWith(runtime, [
      'questions',
      'acknowledge',
      'q-1',
      '--by',
      'alice',
    ]);
    expect(invocation.code).toBe(0);
    expect(acknowledgeCalls).toHaveLength(1);
    expect(acknowledgeCalls[0]).toEqual({ questionId: 'q-1', by: 'alice' });
  });
});
