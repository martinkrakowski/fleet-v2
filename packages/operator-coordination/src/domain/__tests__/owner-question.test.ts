import { describe, expect, it } from 'vitest';

import type {
  OwnerQuestionAnswerRecord,
  OwnerQuestionOptionRecord,
  OwnerQuestionRecordInput,
} from '../owner-question-records.js';
import { OwnerQuestion, canTransitionOwnerQuestion } from '../entities/OwnerQuestion.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function questionRecord(overrides: Partial<OwnerQuestionRecordInput> = {}): OwnerQuestionRecordInput {
  return {
    questionId: 'q-1',
    revision: 1,
    askedBy: 'orchestrator',
    title: 'Which rollout door do we take?',
    body: 'Choosing the rollout path for the migration.',
    options: [
      { id: 'a', label: 'Freeze first', consequence: 'Slower but reversible.' },
      { id: 'b', label: 'Roll forward', consequence: 'Faster but commits.' },
    ],
    recommendation: { optionId: 'a', because: 'Reversibility beats speed here.' },
    doorKind: 'two-way',
    linkedRequestId: null,
    blocks: [{ kind: 'lane', ref: 'lane-7' }],
    state: 'open',
    askedAt: '2026-10-16T10:00:00.000Z',
    expiresAt: null,
    answer: null,
    acknowledgement: null,
    ...overrides,
  };
}

function answeredRecord(
  overrides: Partial<OwnerQuestionRecordInput> = {},
): OwnerQuestionRecordInput {
  const answer: OwnerQuestionAnswerRecord = {
    shape: 'accept',
    optionId: 'a',
    text: null,
    reason: null,
    questionRevision: 1,
    answeredVia: 'web',
    answeredAt: '2026-10-16T11:00:00.000Z',
    sessionId: null,
  };
  return questionRecord({ state: 'answered', answer, ...overrides });
}

describe('OwnerQuestion validation', () => {
  it('accepts a well-formed record and keeps every field', () => {
    const entity = OwnerQuestion.fromRecord(questionRecord());
    const record = entity.toRecord();
    expect(record.questionId).toBe('q-1');
    expect(record.doorKind).toBe('two-way');
    expect(record.state).toBe('open');
    expect(record.blocks).toHaveLength(1);
  });

  it('defaults doorKind to one-way when absent and requires a linkedRequestId for it', () => {
    const withoutDoorKind = questionRecord({ doorKind: undefined, linkedRequestId: 'request-9' });
    expect(OwnerQuestion.fromRecord(withoutDoorKind).getDoorKind()).toBe('one-way');

    const oneWayWithoutLink = questionRecord({ doorKind: 'one-way', linkedRequestId: null });
    expect(() => OwnerQuestion.fromRecord(oneWayWithoutLink)).toThrow(
      /one-way requires a linkedRequestId/,
    );

    const twoWayWithLink = questionRecord({ doorKind: 'two-way', linkedRequestId: 'request-9' });
    expect(() => OwnerQuestion.fromRecord(twoWayWithLink)).toThrow(
      /two-way must not carry a linkedRequestId/,
    );
  });

  it('requires the recommendation to name one of the options', () => {
    const record = questionRecord({ recommendation: { optionId: 'zz', because: 'nope' } });
    expect(() => OwnerQuestion.fromRecord(record)).toThrow(/not one of the options/);
  });

  it('requires at least two options with unique non-empty ids', () => {
    const single = questionRecord({
      options: [{ id: 'a', label: 'Only', consequence: 'One path.' }],
    });
    expect(() => OwnerQuestion.fromRecord(single)).toThrow(/at least 2 options/);

    const duplicate = questionRecord({
      options: [
        { id: 'a', label: 'First', consequence: 'First path.' },
        { id: 'a', label: 'Second', consequence: 'Second path.' },
      ],
    });
    expect(() => OwnerQuestion.fromRecord(duplicate)).toThrow(/repeats option id/);

    const emptyId = questionRecord({
      options: [
        { id: ' ', label: 'Blank', consequence: 'Blank id.' },
        { id: 'b', label: 'Second', consequence: 'Second path.' },
      ],
    });
    expect(() => OwnerQuestion.fromRecord(emptyId)).toThrow(/option id must be a non-empty string/);
  });

  it('enforces the field bounds', () => {
    expect(() =>
      OwnerQuestion.fromRecord(questionRecord({ title: 'x'.repeat(201) })),
    ).toThrow(/title exceeds 200/);
    expect(() =>
      OwnerQuestion.fromRecord(questionRecord({ body: 'x'.repeat(8193) })),
    ).toThrow(/body exceeds 8192/);
    expect(() =>
      OwnerQuestion.fromRecord(
        questionRecord({
          options: [
            { id: 'a', label: 'x'.repeat(1025), consequence: 'Fine.' },
            { id: 'b', label: 'Second', consequence: 'Second path.' },
          ],
        }),
      ),
    ).toThrow(/option label exceeds 1024/);
    expect(() =>
      OwnerQuestion.fromRecord(
        answeredRecord({
          answer: {
            shape: 'reject',
            optionId: null,
            text: 'x'.repeat(4097),
            reason: null,
            questionRevision: 1,
            answeredVia: 'cli',
            answeredAt: '2026-10-16T11:00:00.000Z',
            sessionId: null,
          },
        }),
      ),
    ).toThrow(/answer text exceeds 4096/);
  });

  it('refuses the whole record beyond 32768 JSON characters', () => {
    const record = questionRecord({ body: 'x'.repeat(8192) });
    const entity = OwnerQuestion.fromRecord(record);
    expect(JSON.stringify(entity.toRecord()).length).toBeLessThanOrEqual(32768);

    const oversized = questionRecord({
      blocks: Array.from({ length: 500 }, (_, index) => ({
        kind: 'lane' as const,
        ref: `blocked-item-${String(index).padStart(4, '0')}-${'x'.repeat(40)}`,
      })),
    });
    expect(() => OwnerQuestion.fromRecord(oversized)).toThrow(/32768 JSON characters/);
  });

  it('refuses a secret shape in each scanned field and names the field without echoing the value', () => {
    const secret = fakeSecretShape();
    const cases: readonly OwnerQuestionRecordInput[] = [
      questionRecord({ title: `Please review ${secret} now` }),
      questionRecord({ body: `Context: ${secret}` }),
      questionRecord({
        options: [
          { id: 'a', label: `Use ${secret}`, consequence: 'Fine.' },
          { id: 'b', label: 'Second', consequence: 'Second path.' },
        ],
      }),
      questionRecord({
        options: [
          { id: 'a', label: 'First', consequence: `Key ${secret} applies.` },
          { id: 'b', label: 'Second', consequence: 'Second path.' },
        ],
      }),
      questionRecord({ recommendation: { optionId: 'a', because: `Because ${secret} says so` } }),
      answeredRecord({
        answer: {
          shape: 'reject',
          optionId: null,
          text: `Text ${secret}`,
          reason: null,
          questionRevision: 1,
          answeredVia: 'web',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: null,
        },
      }),
      answeredRecord({
        answer: {
          shape: 'reject',
          optionId: null,
          text: null,
          reason: `Reason ${secret}`,
          questionRevision: 1,
          answeredVia: 'web',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: null,
        },
      }),
    ];
    const expectedFields = [
      'title',
      'body',
      'option label',
      'option consequence',
      'recommendation because',
      'answer text',
      'answer reason',
    ];
    cases.forEach((record, index) => {
      try {
        OwnerQuestion.fromRecord(record);
        throw new Error(`expected refusal for ${expectedFields[index]}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message, expectedFields[index]).toContain('secret-shaped value');
        expect(message, expectedFields[index]).toContain(expectedFields[index]);
        expect(message, expectedFields[index]).not.toContain('A'.repeat(30));
      }
    });
  });

  it('allows exactly the declared state transitions and nothing else', () => {
    expect(canTransitionOwnerQuestion('open', 'answered')).toBe(true);
    expect(canTransitionOwnerQuestion('open', 'rejected')).toBe(true);
    expect(canTransitionOwnerQuestion('open', 'expired')).toBe(true);
    expect(canTransitionOwnerQuestion('open', 'acknowledged')).toBe(false);
    expect(canTransitionOwnerQuestion('answered', 'acknowledged')).toBe(true);
    expect(canTransitionOwnerQuestion('rejected', 'acknowledged')).toBe(true);
    expect(canTransitionOwnerQuestion('answered', 'open')).toBe(false);
    expect(canTransitionOwnerQuestion('expired', 'acknowledged')).toBe(false);
    expect(canTransitionOwnerQuestion('acknowledged', 'open')).toBe(false);

    const open = OwnerQuestion.fromRecord(questionRecord());
    expect(open.transitionTo('expired').getState()).toBe('expired');
    expect(() => open.transitionTo('acknowledged')).toThrow(/may not move/);

    const accepted = answeredRecord();
    const answered = OwnerQuestion.fromRecord(accepted);
    expect(() => answered.transitionTo('acknowledged')).toThrow(/requires an acknowledgement/);
    const acknowledged = answered.transitionTo('acknowledged', {
      acknowledgement: { by: 'orchestrator', at: '2026-10-16T12:00:00.000Z' },
    });
    expect(acknowledged.getState()).toBe('acknowledged');
  });

  it('keeps answers, states and acknowledgements mutually consistent', () => {
    const answer: OwnerQuestionAnswerRecord = {
      shape: 'accept',
      optionId: 'a',
      text: null,
      reason: null,
      questionRevision: 1,
      answeredVia: 'signed-decision',
      answeredAt: '2026-10-16T11:00:00.000Z',
      sessionId: 'session-1',
    };
    expect(() =>
      OwnerQuestion.fromRecord(questionRecord({ state: 'answered', answer: null })),
    ).toThrow(/requires an answer/);
    expect(() => OwnerQuestion.fromRecord(questionRecord({ answer }))).toThrow(
      /state open must not carry an answer/,
    );
    expect(() =>
      OwnerQuestion.fromRecord(
        questionRecord({
          state: 'acknowledged',
          answer,
          acknowledgement: { by: 'orchestrator', at: '2026-10-16T12:00:00.000Z' },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      OwnerQuestion.fromRecord(
        questionRecord({ state: 'answered', answer, acknowledgement: { by: 'o', at: '2026-10-16T12:00:00.000Z' } }),
      ),
    ).toThrow(/state answered must not carry an acknowledgement/);
    expect(() =>
      OwnerQuestion.fromRecord(
        answeredRecord({
          answer: { ...answer, shape: 'answer', optionId: 'zz', text: 'Try b instead' },
        }),
      ),
    ).toThrow(/not one of the options/);
    expect(() =>
      OwnerQuestion.fromRecord(
        answeredRecord({
          answer: { ...answer, questionRevision: 2 },
        }),
      ),
    ).toThrow(/questionRevision/);
  });

  it('freezes returned child collections against mutation', () => {
    const entity = OwnerQuestion.fromRecord(questionRecord());
    const record = entity.toRecord();
    expect(() => (record.options as OwnerQuestionOptionRecord[]).push()).toThrow();
  });
});
