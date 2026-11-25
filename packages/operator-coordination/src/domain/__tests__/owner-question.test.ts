import { describe, expect, it, vi } from 'vitest';

import type {
  OwnerQuestionAnswerRecord,
  OwnerQuestionAudience,
  OwnerQuestionOptionRecord,
  OwnerQuestionRecordInput,
} from '../owner-question-records.js';
import { OWNER_QUESTION_RECORD_VERSION } from '../owner-question-records.js';
import {
  OwnerQuestion,
  OWNER_QUESTION_ACTOR_PATTERN,
  canTransitionOwnerQuestion,
  validateAnswerActor,
} from '../entities/OwnerQuestion.js';

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

function rejectedRecord(
  overrides: Partial<OwnerQuestionRecordInput> = {},
): OwnerQuestionRecordInput {
  const answer: OwnerQuestionAnswerRecord = {
    shape: 'reject',
    optionId: null,
    text: null,
    reason: null,
    questionRevision: 1,
    answeredVia: 'cli',
    answeredAt: '2026-10-16T11:00:00.000Z',
    sessionId: null,
  };
  return questionRecord({ state: 'rejected', answer, ...overrides });
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
    expect(() => OwnerQuestion.fromRecord(duplicate)).toThrow(/repeats an option id/);

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
        rejectedRecord({
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
    expect(() =>
      OwnerQuestion.fromRecord(
        questionRecord({
          options: [
            { id: 'a', label: 'First', consequence: 'First path.' },
            { id: 'b'.padEnd(70, 'b'), label: 'Second', consequence: 'Second path.' },
          ],
        }),
      ),
    ).toThrow(/option id exceeds 64/);
    // Bounds count UTF-8 bytes, not string length.
    expect(() =>
      OwnerQuestion.fromRecord(questionRecord({ title: 'é'.repeat(101) })),
    ).toThrow(/title exceeds 200/);
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

  it('refuses a secret shape in id and reference fields without echoing it', () => {
    const secret = fakeSecretShape();
    const cases: readonly OwnerQuestionRecordInput[] = [
      questionRecord({ questionId: `q-${secret}` }),
      questionRecord({ askedBy: `asker-${secret}` }),
      questionRecord({ doorKind: 'one-way', linkedRequestId: `req-${secret}` }),
      questionRecord({ blocks: [{ kind: 'lane', ref: `lane-${secret}` }] }),
      rejectedRecord({
        answer: {
          shape: 'reject',
          optionId: null,
          text: null,
          reason: null,
          questionRevision: 1,
          answeredVia: 'web',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: `session-${secret}`,
        },
      }),
      rejectedRecord({
        state: 'acknowledged',
        acknowledgement: { by: `by-${secret}`, at: '2026-10-16T12:00:00.000Z' },
      }),
    ];
    for (const record of cases) {
      let message = '';
      try {
        OwnerQuestion.fromRecord(record);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
    }
  });

  it('never echoes a requested state that is not a known state', () => {
    const question = OwnerQuestion.fromRecord(questionRecord());
    const marker = 'zz-marker-state-zz';
    let message = '';
    try {
      question.transitionTo(marker as never);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(marker);
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
      rejectedRecord({
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
      rejectedRecord({
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
      questionRecord({
        options: [
          { id: `id-${secret}`, label: 'First', consequence: 'First path.' },
          { id: 'b', label: 'Second', consequence: 'Second path.' },
        ],
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
      'option id',
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

  it('requires a revision of at least 1', () => {
    expect(() => OwnerQuestion.fromRecord(questionRecord({ revision: 0 }))).toThrow(
      /positive integer revision/,
    );
    expect(() => OwnerQuestion.fromRecord(questionRecord({ revision: 1.5 }))).toThrow(
      /positive integer revision/,
    );
  });

  it('treats expired questions as blocking, like open ones', () => {
    expect(OwnerQuestion.fromRecord(questionRecord()).isBlocking()).toBe(true);
    expect(OwnerQuestion.fromRecord(questionRecord({ state: 'expired' })).isBlocking()).toBe(true);
    expect(OwnerQuestion.fromRecord(answeredRecord()).isBlocking()).toBe(false);
    expect(OwnerQuestion.fromRecord(rejectedRecord()).isBlocking()).toBe(false);
  });

  it('keeps answer shape consistent with the state and normalises an accept to the recommended option', () => {
    expect(() =>
      OwnerQuestion.fromRecord(
        rejectedRecord({
          answer: {
            shape: 'accept',
            optionId: 'a',
            text: null,
            reason: null,
            questionRevision: 1,
            answeredVia: 'web',
            answeredAt: '2026-10-16T11:00:00.000Z',
            sessionId: null,
          },
        }),
      ),
    ).toThrow(/state rejected requires an answer of shape reject/);
    expect(() =>
      OwnerQuestion.fromRecord(
        answeredRecord({
          answer: {
            shape: 'reject',
            optionId: null,
            text: null,
            reason: 'Not this path.',
            questionRevision: 1,
            answeredVia: 'web',
            answeredAt: '2026-10-16T11:00:00.000Z',
            sessionId: null,
          },
        }),
      ),
    ).toThrow(/state answered requires an answer of shape accept or answer/);

    // An accept always records the recommended option, whatever the caller named.
    const normalised = OwnerQuestion.fromRecord(
      answeredRecord({
        answer: {
          shape: 'accept',
          optionId: null,
          text: null,
          reason: null,
          questionRevision: 1,
          answeredVia: 'signed-decision',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: null,
        },
      }),
    );
    expect(normalised.toRecord().answer?.optionId).toBe('a');
    const misnamed = OwnerQuestion.fromRecord(
      answeredRecord({
        recommendation: { optionId: 'b', because: 'Second path reads better.' },
        answer: {
          shape: 'accept',
          optionId: 'a',
          text: null,
          reason: null,
          questionRevision: 1,
          answeredVia: 'web',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: null,
        },
      }),
    );
    expect(misnamed.toRecord().answer?.optionId).toBe('b');
  });

  it('normalises timestamps to canonical ISO strings', () => {
    const entity = OwnerQuestion.fromRecord(
      questionRecord({
        askedAt: '2026-10-16T12:00:00+02:00',
        expiresAt: '2026-10-17T00:30:00+02:00',
      }),
    );
    expect(entity.toRecord().askedAt).toBe('2026-10-16T10:00:00.000Z');
    expect(entity.toRecord().expiresAt).toBe('2026-10-16T22:30:00.000Z');
    const answered = OwnerQuestion.fromRecord(
      answeredRecord({ answer: { ...answeredAnswer(), answeredAt: '2026-10-16T13:30:00+02:00' } }),
    );
    expect(answered.toRecord().answer?.answeredAt).toBe('2026-10-16T11:30:00.000Z');
  });

  it('never echoes a caller-supplied identifier in an error message', () => {
    const marker = 'leak-me-id-zz';
    const cases: readonly OwnerQuestionRecordInput[] = [
      questionRecord({ recommendation: { optionId: marker, because: 'nope' } }),
      questionRecord({
        options: [
          { id: 'a', label: 'First', consequence: 'First path.' },
          { id: 'a', label: 'Second', consequence: 'Second path.' },
        ],
      }),
      answeredRecord({
        answer: {
          shape: 'answer',
          optionId: marker,
          text: null,
          reason: null,
          questionRevision: 1,
          answeredVia: 'web',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: null,
        },
      }),
    ];
    for (const record of cases) {
      try {
        OwnerQuestion.fromRecord(record);
        throw new Error('expected a refusal');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(marker);
      }
    }
  });
});

function answeredAnswer(overrides: Partial<OwnerQuestionAnswerRecord> = {}): OwnerQuestionAnswerRecord {
  return {
    shape: 'accept',
    optionId: 'a',
    text: null,
    reason: null,
    questionRevision: 1,
    answeredVia: 'web',
    answeredAt: '2026-10-16T11:00:00.000Z',
    sessionId: null,
    ...overrides,
  };
}

describe('OwnerQuestion record version, audience and answer actor', () => {
  describe('schemaVersion', () => {
    it('normalises an omitted or v1 record to schemaVersion 2 and marks it legacy', () => {
      for (const schemaVersion of [undefined, 1]) {
        const record = questionRecord({
          state: 'open',
          answer: null,
          schemaVersion,
        } as unknown as Partial<OwnerQuestionRecordInput>);
        const stored = OwnerQuestion.fromRecord(record).toRecord();
        expect(stored.schemaVersion).toBe(2);
        expect(stored.schemaVersion).toBe(OWNER_QUESTION_RECORD_VERSION);
        expect(stored.audience).toBe('owner-only');
      }
    });

    it('accepts schemaVersion 2 and keeps a seeded audience of any', () => {
      const stored = OwnerQuestion.fromRecord(
        questionRecord({ state: 'open', answer: null, schemaVersion: 2, audience: 'any' }),
      ).toRecord();
      expect(stored.schemaVersion).toBe(2);
      expect(stored.audience).toBe('any');
    });

    it('refuses unknown or malformed schemaVersion values', () => {
      const bad: unknown[] = [0, 3, -1, 1.5, '2', null, Number.NaN, Number.POSITIVE_INFINITY, {}];
      for (const schemaVersion of bad) {
        let message = '';
        try {
          OwnerQuestion.fromRecord(
            questionRecord({
              state: 'open',
              answer: null,
              schemaVersion,
            } as unknown as Partial<OwnerQuestionRecordInput>),
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, `schemaVersion ${String(schemaVersion)}`).toBe(
          'OwnerQuestion unsupported schemaVersion',
        );
      }
    });
  });

  describe('audience', () => {
    it('reads an omitted or unknown audience on a v2 record as owner-only and preserves any', () => {
      expect(
        OwnerQuestion.fromRecord(
          questionRecord({ state: 'open', answer: null, schemaVersion: 2, audience: undefined }),
        ).toRecord().audience,
      ).toBe('owner-only');
      for (const unknownAudience of ['public', null]) {
        expect(
          OwnerQuestion.fromRecord(
            questionRecord({
              state: 'open',
              answer: null,
              schemaVersion: 2,
              audience: unknownAudience as unknown as OwnerQuestionAudience,
            }),
          ).toRecord().audience,
        ).toBe('owner-only');
      }
      expect(
        OwnerQuestion.fromRecord(
          questionRecord({ state: 'open', answer: null, schemaVersion: 2, audience: 'any' }),
        ).toRecord().audience,
      ).toBe('any');
    });

    it('reads every legacy v1 record as owner-only even when any is stored', () => {
      const stored = OwnerQuestion.fromRecord(
        questionRecord({
          state: 'open',
          answer: null,
          schemaVersion: 1,
          audience: 'any',
        } as Partial<OwnerQuestionRecordInput>),
      ).toRecord();
      expect(stored.audience).toBe('owner-only');
    });
  });

  describe('answer actor', () => {
    it('keeps an owner or agent actor on an any-audience web or cli answer', () => {
      for (const via of ['web', 'cli'] as const) {
        const agent = OwnerQuestion.fromRecord(
          answeredRecord({
            schemaVersion: 2,
            audience: 'any',
            answer: answeredAnswer({ answeredVia: via, actor: 'agent:tok-1' }),
          }),
        ).toRecord();
        expect(agent.answer?.actor).toBe('agent:tok-1');
        const owner = OwnerQuestion.fromRecord(
          answeredRecord({
            schemaVersion: 2,
            audience: 'any',
            answer: answeredAnswer({ answeredVia: via, actor: 'owner' }),
          }),
        ).toRecord();
        expect(owner.answer?.actor).toBe('owner');
      }
    });

    it('reads a missing actor as owner on a legacy record and on a v2 record alike', () => {
      const legacy = OwnerQuestion.fromRecord(answeredRecord()).toRecord();
      expect(legacy.answer?.actor).toBe('owner');
      const v2 = OwnerQuestion.fromRecord(
        answeredRecord({ schemaVersion: 2, audience: 'any', answer: answeredAnswer() }),
      ).toRecord();
      expect(v2.answer?.actor).toBe('owner');
    });

    it('refuses malformed or secret-shaped actor values without echoing them', () => {
      const secret = `tok_${'sec'}_${'X'.repeat(24)}`;
      const bad: unknown[] = [
        '',
        'has space',
        'owner ',
        'agent:',
        `agent:${'a'.repeat(129)}`,
        `agent:bad/slash${'a'.repeat(4)}`,
        42,
        secret,
      ];
      for (const actor of bad) {
        let message = '';
        try {
          OwnerQuestion.fromRecord(
            answeredRecord({
              schemaVersion: 2,
              audience: 'any',
              answer: answeredAnswer({ actor } as unknown as Partial<OwnerQuestionAnswerRecord>),
            }),
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, `actor ${typeof actor === 'string' && actor === secret ? '<secret>' : String(actor)}`).toBe(
          'OwnerQuestion answer actor must be owner or agent:<id>',
        );
        expect(message).not.toContain(secret);
      }
      expect(OWNER_QUESTION_ACTOR_PATTERN.test('agent:tok-1')).toBe(true);
      expect(OWNER_QUESTION_ACTOR_PATTERN.test('owner')).toBe(false);
    });

    it('refuses agent or non-owner actor on signed-decision answers', () => {
      for (const actor of ['agent:tok-1', 'someone-else', 42]) {
        let message = '';
        try {
          OwnerQuestion.fromRecord(
            answeredRecord({
              answer: answeredAnswer({
                answeredVia: 'signed-decision',
                actor,
              } as unknown as Partial<OwnerQuestionAnswerRecord>),
            }),
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toBe('OwnerQuestion signed-decision answer requires actor owner');
      }
      // An absent or explicit owner actor is accepted on a signed decision.
      const signed = OwnerQuestion.fromRecord(
        answeredRecord({ answer: answeredAnswer({ answeredVia: 'signed-decision' }) }),
      ).toRecord();
      expect(signed.answer?.actor).toBe('owner');
    });

    it('refuses agent actor when audience is owner-only or omitted', () => {
      for (const audience of ['owner-only', undefined, 'public', null] as const) {
        let message = '';
        try {
          OwnerQuestion.fromRecord(
            answeredRecord({
              schemaVersion: 2,
              audience: audience as unknown as OwnerQuestionAudience,
              answer: answeredAnswer({ actor: 'agent:tok-1' }),
            }),
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, `audience ${String(audience)}`).toBe(
          'OwnerQuestion refuses agent answer when audience is not any or answeredVia is signed-decision',
        );
      }
    });

    it('keeps the agent actor out of error messages, the stored record and console.error', () => {
      const secret = `tok_${'sec'}_${'X'.repeat(24)}`;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const stored = OwnerQuestion.fromRecord(
          answeredRecord({
            schemaVersion: 2,
            audience: 'any',
            answer: answeredAnswer({ actor: 'agent:tok-1' }),
          }),
        ).toRecord();
        expect(stored.answer?.actor).toBe('agent:tok-1');
        expect(JSON.stringify(stored)).not.toContain(secret);
        let message = '';
        try {
          OwnerQuestion.fromRecord(
            answeredRecord({
              schemaVersion: 2,
              audience: 'any',
              answer: answeredAnswer({ actor: secret } as unknown as Partial<OwnerQuestionAnswerRecord>),
            }),
          );
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).not.toContain(secret);
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('validateAnswerActor', () => {
    it('maps signed-decision answers to owner and refuses every other actor', () => {
      expect(validateAnswerActor(undefined, 'signed-decision', false)).toBe('owner');
      expect(validateAnswerActor('owner', 'signed-decision', true)).toBe('owner');
      expect(() => validateAnswerActor('agent:tok-1', 'signed-decision', false)).toThrow(
        'OwnerQuestion signed-decision answer requires actor owner',
      );
    });

    it('reads a missing actor as owner at every version and validates agent shapes otherwise', () => {
      expect(validateAnswerActor(undefined, 'web', true)).toBe('owner');
      expect(validateAnswerActor(undefined, 'web', false)).toBe('owner');
      expect(validateAnswerActor('owner', 'cli', false)).toBe('owner');
      expect(validateAnswerActor('agent:tok-1', 'cli', false)).toBe('agent:tok-1');
      expect(() => validateAnswerActor('agent:tok 1', 'web', false)).toThrow(
        'OwnerQuestion answer actor must be owner or agent:<id>',
      );
      expect(() => validateAnswerActor(42, 'web', false)).toThrow(
        'OwnerQuestion answer actor must be owner or agent:<id>',
      );
      expect(() => validateAnswerActor(null, 'web', false)).toThrow(
        'OwnerQuestion answer actor must be owner or agent:<id>',
      );
    });
  });

  describe('hostile record and answer input', () => {
    it('refuses null, undefined, primitives, array-likes, and non-plain objects on record and answer', () => {
      const nonObjects: unknown[] = [
        null,
        undefined,
        42,
        'record',
        true,
        [],
        ['a', 'b'],
        new Date(0),
        () => 'x',
        Symbol('x'),
      ];
      for (const bad of nonObjects) {
        let recordMessage = '';
        try {
          OwnerQuestion.fromRecord(bad as OwnerQuestionRecordInput);
        } catch (error) {
          recordMessage = error instanceof Error ? error.message : String(error);
        }
        expect(recordMessage).toBe('OwnerQuestion requires a record');
      }
      // An array-like plain object (indices as own keys) carries no allowed key.
      const arrayLike = Object.assign({}, { 0: 'a', 1: 'b', length: 2 });
      expect(() => OwnerQuestion.fromRecord(arrayLike as unknown as OwnerQuestionRecordInput)).toThrow(
        'OwnerQuestion requires a record',
      );
      // null and undefined answers on an answered record refuse as missing.
      for (const missing of [null, undefined]) {
        let missingMessage = '';
        try {
          OwnerQuestion.fromRecord(
            answeredRecord({ answer: missing as unknown as OwnerQuestionAnswerRecord }),
          );
        } catch (error) {
          missingMessage = error instanceof Error ? error.message : String(error);
        }
        expect(missingMessage).toBe('OwnerQuestion in state answered requires an answer');
      }
      for (const badAnswer of [42, 'answer', [], ['x'], () => 'x']) {
        let answerMessage = '';
        try {
          OwnerQuestion.fromRecord(
            answeredRecord({ answer: badAnswer as unknown as OwnerQuestionAnswerRecord }),
          );
        } catch (error) {
          answerMessage = error instanceof Error ? error.message : String(error);
        }
        expect(answerMessage).toBe('OwnerQuestion answer must be an object');
      }
    });

    it('refuses getters without invoking them, revoked proxies, and prototype-polluting keys', () => {
      let getterRuns = 0;
      const getterRecord: Record<string, unknown> = { ...questionRecord() };
      Object.defineProperty(getterRecord, 'title', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return 'stolen';
        },
      });
      expect(() => OwnerQuestion.fromRecord(getterRecord as unknown as OwnerQuestionRecordInput)).toThrow(
        'OwnerQuestion requires a record',
      );
      expect(getterRuns).toBe(0);

      let answerGetterRuns = 0;
      const getterAnswer: Record<string, unknown> = { ...answeredAnswer() };
      Object.defineProperty(getterAnswer, 'text', {
        enumerable: true,
        get() {
          answerGetterRuns += 1;
          return 'stolen';
        },
      });
      expect(() =>
        OwnerQuestion.fromRecord(
          answeredRecord({ answer: getterAnswer as unknown as OwnerQuestionAnswerRecord }),
        ),
      ).toThrow('OwnerQuestion answer must be an object');
      expect(answerGetterRuns).toBe(0);

      // A spy getter on the record's `answer` slot itself is never run either.
      let answerSlotRuns = 0;
      const spiedRecord: Record<string, unknown> = { ...questionRecord() };
      Object.defineProperty(spiedRecord, 'answer', {
        enumerable: true,
        get() {
          answerSlotRuns += 1;
          return answeredAnswer();
        },
      });
      expect(() => OwnerQuestion.fromRecord(spiedRecord as unknown as OwnerQuestionRecordInput)).toThrow(
        'OwnerQuestion requires a record',
      );
      expect(answerSlotRuns).toBe(0);

      const { proxy, revoke } = Proxy.revocable({ ...questionRecord() }, {});
      revoke();
      expect(() => OwnerQuestion.fromRecord(proxy as unknown as OwnerQuestionRecordInput)).toThrow(
        'OwnerQuestion requires a record',
      );

      for (const pollutingKey of ['__proto__', 'constructor', 'prototype']) {
        const polluted: Record<string, unknown> = { ...questionRecord() };
        Object.defineProperty(polluted, pollutingKey, {
          enumerable: true,
          value: { evil: true },
          writable: true,
          configurable: true,
        });
        expect(() =>
          OwnerQuestion.fromRecord(polluted as unknown as OwnerQuestionRecordInput),
        ).toThrow('OwnerQuestion requires a record');
      }
      const pollutedAnswer: Record<string, unknown> = { ...answeredAnswer() };
      Object.defineProperty(pollutedAnswer, '__proto__', {
        enumerable: true,
        value: { evil: true },
        writable: true,
        configurable: true,
      });
      expect(() =>
        OwnerQuestion.fromRecord(
          answeredRecord({ answer: pollutedAnswer as unknown as OwnerQuestionAnswerRecord }),
        ),
      ).toThrow('OwnerQuestion answer must be an object');
    });

    it('refuses unknown extra keys on the record and the answer', () => {
      const extraKey = { ...questionRecord(), extraField: 'x' } as unknown as OwnerQuestionRecordInput;
      expect(() => OwnerQuestion.fromRecord(extraKey)).toThrow('OwnerQuestion requires a record');
      const extraAnswer = {
        ...answeredAnswer(),
        extraField: 'x',
      } as unknown as OwnerQuestionAnswerRecord;
      expect(() =>
        OwnerQuestion.fromRecord(answeredRecord({ answer: extraAnswer })),
      ).toThrow('OwnerQuestion answer must be an object');
    });

    it('refuses array holes and non-arrays in options and blocks', () => {
      const holedOptions = questionRecord();
      const optionsArray = [holedOptions.options[0], holedOptions.options[1]] as OwnerQuestionOptionRecord[];
      delete (optionsArray as unknown as Record<string, unknown>)[1];
      expect(() => OwnerQuestion.fromRecord({ ...holedOptions, options: optionsArray })).toThrow(
        /options must be objects/,
      );
      expect(() =>
        OwnerQuestion.fromRecord(questionRecord({ options: 'not-an-array' as unknown as OwnerQuestionOptionRecord[] })),
      ).toThrow(/array of options/);
      expect(() =>
        OwnerQuestion.fromRecord(questionRecord({ blocks: 'not-an-array' as unknown as OwnerQuestionRecordInput['blocks'] })),
      ).toThrow(/blocks must be an array/);
      const holed = answeredRecord({ blocks: [{ kind: 'lane', ref: 'lane-7' }] });
      const blocksArray = [{ kind: 'lane', ref: 'lane-7' }] as unknown as OwnerQuestionRecordInput['blocks'];
      delete (blocksArray as unknown as Record<string, unknown>)[0];
      expect(() => OwnerQuestion.fromRecord({ ...holed, blocks: blocksArray })).toThrow(
        /blocks must be objects/,
      );
    });

    it('refuses an enormous actor beyond the pattern length bound', () => {
      let message = '';
      try {
        OwnerQuestion.fromRecord(
          answeredRecord({
            schemaVersion: 2,
            audience: 'any',
            answer: answeredAnswer({ actor: `agent:${'a'.repeat(128)}x` }),
          }),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe('OwnerQuestion answer actor must be owner or agent:<id>');
    });
  });
});
