/**
 * Lane Q1b unit tests for the owner-question use cases.
 *
 * Every refusal path, answer idempotency, the revision conflict, one-way
 * answering only through the decision transport, and the invariant that no
 * step here ever writes a coordination request. The clock is always injected.
 */

import { describe, expect, it } from 'vitest';

import type {
  CoordinationRequestRecord,
} from '../../../domain/coordination-records.js';
import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';
import { OwnerQuestion } from '../../../domain/entities/OwnerQuestion.js';
import type { OwnerQuestionClock } from '../../ports/in/AskOwnerQuestionPort.in-port.js';
import type {
  AcknowledgeOwnerAnswerRequest,
} from '../../ports/in/AcknowledgeOwnerAnswerPort.in-port.js';
import type { AnswerOwnerQuestionRequest } from '../../ports/in/AnswerOwnerQuestionPort.in-port.js';
import type { AskOwnerQuestionRequest } from '../../ports/in/AskOwnerQuestionPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type {
  DecisionAnswer,
  DecisionAnswerQuery,
  DecisionTransportPort,
} from '../../ports/out/DecisionTransportPort.out-port.js';
import { OwnerQuestionRevisionConflictError } from '../../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type {
  OwnerQuestionListQuery,
  OwnerQuestionRepositoryPort,
} from '../../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import { AcknowledgeOwnerAnswerUseCase } from '../AcknowledgeOwnerAnswerUseCase.use-case.js';
import { AnswerOwnerQuestionUseCase } from '../AnswerOwnerQuestionUseCase.use-case.js';
import { AskOwnerQuestionUseCase } from '../AskOwnerQuestionUseCase.use-case.js';
import { ExpireOwnerQuestionsUseCase } from '../ExpireOwnerQuestionsUseCase.use-case.js';
import { ListOwnerQuestionsUseCase } from '../ListOwnerQuestionsUseCase.use-case.js';
import { ReadOwnerQuestionUseCase } from '../ReadOwnerQuestionUseCase.use-case.js';
import { SyncOneWayOwnerQuestionsUseCase } from '../SyncOneWayOwnerQuestionsUseCase.use-case.js';

const NOW_ISO = '2026-10-16T12:00:00.000Z';

/** A clock the composition root would inject; it counts its reads. */
function clock(at: string = NOW_ISO): OwnerQuestionClock & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    nowIso() {
      state.calls += 1;
      return at;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Test doubles
 * ------------------------------------------------------------------ */

class FakeOwnerQuestionRepo implements OwnerQuestionRepositoryPort {
  readonly records = new Map<string, OwnerQuestionRecord>();
  saveCalls = 0;
  readonly savedWithExpectedRevision: number[] = [];
  failNextSaveWith: OwnerQuestionRevisionConflictError | null = null;
  readonly queries: OwnerQuestionListQuery[] = [];

  async save(record: OwnerQuestionRecord, expectedRevision: number): Promise<void> {
    this.saveCalls += 1;
    this.savedWithExpectedRevision.push(expectedRevision);
    const stored = this.records.get(record.questionId);
    const freshRevision = stored === undefined ? 0 : stored.revision;
    if (expectedRevision !== freshRevision) {
      throw new OwnerQuestionRevisionConflictError(
        record.questionId,
        record.revision,
        `stored revision ${freshRevision} does not match expected revision ${expectedRevision}`,
      );
    }
    if (this.failNextSaveWith !== null) {
      const failure = this.failNextSaveWith;
      this.failNextSaveWith = null;
      throw failure;
    }
    this.records.set(record.questionId, record);
  }

  async get(questionId: string): Promise<OwnerQuestionRecord | null> {
    return this.records.get(questionId) ?? null;
  }

  async list(query?: OwnerQuestionListQuery): Promise<readonly OwnerQuestionRecord[]> {
    this.queries.push(query ?? {});
    const sinceMs = query?.since === undefined ? null : new Date(query.since).getTime();
    return [...this.records.values()].filter((record) => {
      if (query?.state !== undefined && record.state !== query.state) {
        return false;
      }
      if (sinceMs !== null && new Date(record.askedAt).getTime() < sinceMs) {
        return false;
      }
      return true;
    });
  }
}

/** A coordination request repository that refuses every write: no owner
 * question use case may ever write a CoordinationRequest. */
class NeverWritingRequestRepo implements CoordinationRequestRepositoryPort {
  saveRequestCalls = 0;
  constructor(private readonly records: Map<string, CoordinationRequestRecord>) {}

  async saveRequest(): Promise<void> {
    this.saveRequestCalls += 1;
    throw new Error('a coordination request must never be written by an owner question use case');
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.records.get(requestId) ?? null;
  }

  async findRequestByGrantId(): Promise<CoordinationRequestRecord | null> {
    return null;
  }

  async listRequests(): Promise<readonly CoordinationRequestRecord[]> {
    return [...this.records.values()];
  }
}

class StubDecisionTransport implements DecisionTransportPort {
  calls: DecisionAnswerQuery[] = [];
  constructor(
    private readonly answers: DecisionAnswer | Error,
  ) {}

  async readDecisionAnswer(query: DecisionAnswerQuery): Promise<DecisionAnswer> {
    this.calls.push(query);
    if (this.answers instanceof Error) {
      throw this.answers;
    }
    return this.answers;
  }
}

/* ------------------------------------------------------------------ *
 * Record factories
 * ------------------------------------------------------------------ */

function twoWayRecord(overrides: Partial<OwnerQuestionRecord> = {}): OwnerQuestionRecord {
  return {
    questionId: 'q-two-way',
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
    blocks: [],
    state: 'open',
    askedAt: '2026-10-16T10:00:00.000Z',
    expiresAt: null,
    answer: null,
    acknowledgement: null,
    ...overrides,
  };
}

function oneWayRecord(overrides: Partial<OwnerQuestionRecord> = {}): OwnerQuestionRecord {
  return twoWayRecord({
    questionId: 'q-one-way',
    doorKind: 'one-way',
    linkedRequestId: 'request-9',
    ...overrides,
  });
}

function requestRecord(id: string, kind: CoordinationRequestRecord['kind'] = 'action-decision'): CoordinationRequestRecord {
  return {
    id,
    projectId: 'proj-1',
    kind,
    state: 'proposed',
    actionScope: 'forge:push-and-open-pr',
    expectedHeadSha: 'commit-1',
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: null,
    grantId: null,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
  };
}

function askRequest(overrides: Partial<AskOwnerQuestionRequest> = {}): AskOwnerQuestionRequest {
  return {
    questionId: 'q-new',
    askedBy: 'orchestrator',
    title: 'Which rollout door do we take?',
    body: 'Choosing the rollout path for the migration.',
    options: [
      { id: 'a', label: 'Freeze first', consequence: 'Slower but reversible.' },
      { id: 'b', label: 'Roll forward', consequence: 'Faster but commits.' },
    ],
    recommendation: { optionId: 'a', because: 'Reversibility beats speed here.' },
    doorKind: 'two-way',
    ...overrides,
  };
}

function answerRequest(
  overrides: Partial<AnswerOwnerQuestionRequest> = {},
): AnswerOwnerQuestionRequest {
  return {
    questionId: 'q-two-way',
    questionRevision: 1,
    shape: 'accept',
    answeredVia: 'web',
    ...overrides,
  };
}

function ackRequest(
  overrides: Partial<AcknowledgeOwnerAnswerRequest> = {},
): AcknowledgeOwnerAnswerRequest {
  return { questionId: 'q-two-way', by: 'orchestrator', ...overrides };
}

/* ------------------------------------------------------------------ *
 * Ask
 * ------------------------------------------------------------------ */

describe('AskOwnerQuestionUseCase', () => {
  it('asks a two-way question at revision 1 with askedAt from the injected clock', async () => {
    const repo = new FakeOwnerQuestionRepo();
    const injectedClock = clock();
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(new Map()),
      clock: injectedClock,
    });
    const result = await useCase.askOwnerQuestion(askRequest());
    expect(result.outcome).toBe('asked');
    if (result.outcome !== 'asked') return;
    expect(result.question.revision).toBe(1);
    expect(result.question.state).toBe('open');
    expect(result.question.askedAt).toBe(NOW_ISO);
    expect(repo.savedWithExpectedRevision).toEqual([0]);
  });

  it('asks a one-way question that references an existing action-decision request', async () => {
    const repo = new FakeOwnerQuestionRepo();
    const requests = new Map([[ 'request-9', requestRecord('request-9') ]]);
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(requests),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(
      askRequest({
        doorKind: 'one-way',
        linkedRequestId: 'request-9',
        blocks: [{ kind: 'lane', ref: 'lane-7' }],
      }),
    );
    expect(result.outcome).toBe('asked');
    expect(repo.saveCalls).toBe(1);
  });

  it('accepts a one-way question referencing an existing policy-proposal request', async () => {
    const repo = new FakeOwnerQuestionRepo();
    const requests = new Map([[
      'request-9',
      requestRecord('request-9', 'policy-proposal'),
    ]]);
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(requests),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(
      askRequest({ doorKind: 'one-way', linkedRequestId: 'request-9' }),
    );
    expect(result.outcome).toBe('asked');
  });

  it('refuses a one-way question whose linked request is not recorded', async () => {
    const repo = new FakeOwnerQuestionRepo();
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(new Map()),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(
      askRequest({ doorKind: 'one-way', linkedRequestId: 'request-9' }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('must reference an existing coordination request'),
    });
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses a one-way question whose linked request is a relay, not a decision', async () => {
    const repo = new FakeOwnerQuestionRepo();
    const requests = new Map([[ 'request-9', requestRecord('request-9', 'relay') ]]);
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(requests),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(
      askRequest({ doorKind: 'one-way', linkedRequestId: 'request-9' }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('action-decision or policy-proposal'),
    });
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses a record the domain rejects and stores nothing', async () => {
    const repo = new FakeOwnerQuestionRepo();
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(new Map()),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(
      askRequest({ options: [{ id: 'a', label: 'Only', consequence: 'One path.' }] }),
    );
    expect(result.outcome).toBe('refused');
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses when the save loses a revision race', async () => {
    const repo = new FakeOwnerQuestionRepo();
    repo.failNextSaveWith = new OwnerQuestionRevisionConflictError('q-new', 1, 'lost race');
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new NeverWritingRequestRepo(new Map()),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(askRequest());
    expect(result.outcome).toBe('refused');
  });

  it('is not implemented without dependencies', async () => {
    const useCase = new AskOwnerQuestionUseCase();
    await expect(useCase.execute(askRequest())).rejects.toThrow(/Not implemented/);
  });
});

/* ------------------------------------------------------------------ *
 * Answer
 * ------------------------------------------------------------------ */

describe('AnswerOwnerQuestionUseCase', () => {
  function setup(record: OwnerQuestionRecord) {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set(record.questionId, record);
    const useCase = new AnswerOwnerQuestionUseCase({ ownerQuestionRepo: repo, clock: clock() });
    return { repo, useCase };
  }

  it('answers an open two-way question at the current revision with the clock moment', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    const result = await useCase.answerOwnerQuestion(answerRequest({ shape: 'answer', optionId: 'b' }));
    expect(result.outcome).toBe('answered');
    if (result.outcome !== 'answered') return;
    expect(result.replayed).toBe(false);
    expect(result.question.state).toBe('answered');
    expect(result.question.answer?.optionId).toBe('b');
    expect(result.question.answer?.answeredAt).toBe(NOW_ISO);
    expect(result.question.answer?.questionRevision).toBe(1);
    expect(repo.savedWithExpectedRevision).toEqual([1]);
  });

  it('moves a reject answer to the rejected state', async () => {
    const { useCase } = setup(twoWayRecord());
    const result = await useCase.answerOwnerQuestion(
      answerRequest({ shape: 'reject', reason: 'not now' }),
    );
    expect(result.outcome).toBe('answered');
    if (result.outcome !== 'answered') return;
    expect(result.question.state).toBe('rejected');
    expect(result.question.answer?.shape).toBe('reject');
    expect(result.question.answer?.reason).toBe('not now');
  });

  it('refuses a one-way question: only a signed owner decision answers it', async () => {
    const { useCase } = setup(oneWayRecord());
    const result = await useCase.answerOwnerQuestion(answerRequest({ questionId: 'q-one-way' }));
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'one-way questions are answered only by a signed owner decision',
    });
  });

  it('refuses an answer whose revision is not the current revision', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    const result = await useCase.answerOwnerQuestion(answerRequest({ questionRevision: 2 }));
    expect(result.outcome).toBe('refused');
    expect(repo.saveCalls).toBe(0);
  });

  it('replays the same answer idempotently without a second write', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    const first = await useCase.answerOwnerQuestion(answerRequest());
    const second = await useCase.answerOwnerQuestion(answerRequest());
    expect(first).toMatchObject({ outcome: 'answered', replayed: false });
    expect(second).toMatchObject({ outcome: 'answered', replayed: true, question: first.outcome === 'answered' ? first.question : undefined });
    expect(repo.saveCalls).toBe(1);
  });

  it('refuses a different answer for an already answered revision', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    await useCase.answerOwnerQuestion(answerRequest());
    const different = await useCase.answerOwnerQuestion(
      answerRequest({ shape: 'answer', optionId: 'b' }),
    );
    expect(different.outcome).toBe('refused');
    expect(repo.saveCalls).toBe(1);
  });

  it('refuses an answer the domain rejects, without saving', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    const result = await useCase.answerOwnerQuestion(
      answerRequest({ shape: 'accept', reason: 'accept carries no reason' }),
    );
    expect(result.outcome).toBe('refused');
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses an answer for an unknown question', async () => {
    const { useCase } = setup(twoWayRecord());
    const result = await useCase.answerOwnerQuestion(answerRequest({ questionId: 'q-unknown' }));
    expect(result.outcome).toBe('refused');
  });

  it('refuses an answeredVia reserved for signed decisions', async () => {
    const { useCase } = setup(twoWayRecord());
    const result = await useCase.answerOwnerQuestion(
      answerRequest({ answeredVia: 'signed-decision' as 'web' }),
    );
    expect(result.outcome).toBe('refused');
  });
});

/* ------------------------------------------------------------------ *
 * Expire
 * ------------------------------------------------------------------ */

describe('ExpireOwnerQuestionsUseCase', () => {
  function setup(records: OwnerQuestionRecord[]) {
    const repo = new FakeOwnerQuestionRepo();
    for (const record of records) {
      repo.records.set(record.questionId, record);
    }
    const useCase = new ExpireOwnerQuestionsUseCase({ ownerQuestionRepo: repo, clock: clock() });
    return { repo, useCase };
  }

  it('expires an open question whose expiresAt has passed and it stays blocking', async () => {
    const { repo, useCase } = setup([
      twoWayRecord({ questionId: 'q-old', expiresAt: '2026-10-16T11:59:59.000Z' }),
    ]);
    const result = await useCase.expireOwnerQuestions();
    expect(result.expired).toHaveLength(1);
    expect(result.unchanged).toHaveLength(0);
    const stored = repo.records.get('q-old');
    expect(stored?.state).toBe('expired');
    expect(OwnerQuestion.fromRecord(stored!).isBlocking()).toBe(true);
    expect(repo.savedWithExpectedRevision).toEqual([1]);
  });

  it('expires exactly at the boundary (expiresAt <= now)', async () => {
    const { repo, useCase } = setup([
      twoWayRecord({ questionId: 'q-edge', expiresAt: NOW_ISO }),
    ]);
    const result = await useCase.expireOwnerQuestions();
    expect(result.expired.map((question) => question.questionId)).toEqual(['q-edge']);
    expect(repo.records.get('q-edge')?.state).toBe('expired');
  });

  it('leaves questions with future expiry or no expiry unchanged', async () => {
    const { repo, useCase } = setup([
      twoWayRecord({ questionId: 'q-future', expiresAt: '2026-10-16T12:00:01.000Z' }),
      twoWayRecord({ questionId: 'q-no-expiry', expiresAt: null }),
    ]);
    const result = await useCase.expireOwnerQuestions();
    expect(result.expired).toHaveLength(0);
    expect(result.unchanged).toHaveLength(2);
    expect(repo.saveCalls).toBe(0);
    expect(repo.records.get('q-future')?.state).toBe('open');
    expect(repo.records.get('q-no-expiry')?.state).toBe('open');
  });

  it('leaves a question whose save loses a revision race for the next run', async () => {
    const { repo, useCase } = setup([
      twoWayRecord({ questionId: 'q-old', expiresAt: '2026-10-16T11:00:00.000Z' }),
    ]);
    repo.failNextSaveWith = new OwnerQuestionRevisionConflictError('q-old', 2, 'lost race');
    const result = await useCase.expireOwnerQuestions();
    expect(result.expired).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Acknowledge
 * ------------------------------------------------------------------ */

describe('AcknowledgeOwnerAnswerUseCase', () => {
  function setup(record: OwnerQuestionRecord) {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set(record.questionId, record);
    const useCase = new AcknowledgeOwnerAnswerUseCase({
      ownerQuestionRepo: repo,
      clock: clock(),
    });
    return { repo, useCase };
  }

  it('acknowledges an answered question with by from the request and at from the clock', async () => {
    const answered = OwnerQuestion.fromRecord(twoWayRecord())
      .transitionTo('answered', {
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
      })
      .toRecord();
    const { repo, useCase } = setup(answered);
    const result = await useCase.acknowledgeOwnerAnswer(ackRequest({ by: 'the-owner' }));
    expect(result.outcome).toBe('acknowledged');
    if (result.outcome !== 'acknowledged') return;
    expect(result.question.state).toBe('acknowledged');
    expect(result.acknowledgement).toEqual({ by: 'the-owner', at: NOW_ISO });
    expect(repo.savedWithExpectedRevision).toEqual([1]);
  });

  it('acknowledges a rejected question', async () => {
    const rejected = OwnerQuestion.fromRecord(twoWayRecord())
      .transitionTo('rejected', {
        answer: {
          shape: 'reject',
          optionId: null,
          text: null,
          reason: null,
          questionRevision: 1,
          answeredVia: 'cli',
          answeredAt: '2026-10-16T11:00:00.000Z',
          sessionId: null,
        },
      })
      .toRecord();
    const { useCase } = setup(rejected);
    const result = await useCase.acknowledgeOwnerAnswer(ackRequest());
    expect(result.outcome).toBe('acknowledged');
  });

  it('refuses to acknowledge an open question', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    const result = await useCase.acknowledgeOwnerAnswer(ackRequest());
    expect(result.outcome).toBe('refused');
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses to acknowledge an expired question', async () => {
    const { useCase } = setup(twoWayRecord({ state: 'expired' }));
    const result = await useCase.acknowledgeOwnerAnswer(ackRequest());
    expect(result.outcome).toBe('refused');
  });

  it('refuses an empty acknowledger', async () => {
    const { repo, useCase } = setup(twoWayRecord());
    const result = await useCase.acknowledgeOwnerAnswer(ackRequest({ by: '  ' }));
    expect(result.outcome).toBe('refused');
    expect(repo.saveCalls).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * SyncOneWay
 * ------------------------------------------------------------------ */

describe('SyncOneWayOwnerQuestionsUseCase', () => {
  function setup(record: OwnerQuestionRecord, answers: DecisionAnswer | Error) {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set(record.questionId, record);
    const requests = new Map([[ record.linkedRequestId ?? '', requestRecord(record.linkedRequestId ?? '') ]]);
    const requestRepo = new NeverWritingRequestRepo(requests);
    const transport = new StubDecisionTransport(answers);
    const useCase = new SyncOneWayOwnerQuestionsUseCase({
      ownerQuestionRepo: repo,
      requestRepo,
      decisionTransport: transport,
      clock: clock(),
    });
    return { repo, requestRepo, transport, useCase };
  }

  it('moves an approved one-way question to answered via signed-decision', async () => {
    const { repo, requestRepo, transport, useCase } = setup(
      oneWayRecord(),
      { state: 'approved', decisionRevision: 'd-1', grantId: null, signature: null },
    );
    const result = await useCase.syncOneWayOwnerQuestions();
    expect(result.answered).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    const stored = repo.records.get('q-one-way');
    expect(stored?.state).toBe('answered');
    expect(stored?.answer).toMatchObject({
      shape: 'accept',
      optionId: 'a',
      answeredVia: 'signed-decision',
      questionRevision: 1,
      answeredAt: NOW_ISO,
    });
    expect(transport.calls).toEqual([
      {
        requestId: 'request-9',
        projectId: 'proj-1',
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: 'commit-1',
      },
    ]);
    expect(repo.savedWithExpectedRevision).toEqual([1]);
    expect(requestRepo.saveRequestCalls).toBe(0);
  });

  it('moves a declined one-way question to rejected', async () => {
    const { repo, useCase } = setup(
      oneWayRecord(),
      { state: 'declined', decisionRevision: 'd-1', grantId: null, signature: null },
    );
    const result = await useCase.syncOneWayOwnerQuestions();
    expect(result.rejected).toHaveLength(1);
    expect(result.answered).toHaveLength(0);
    const stored = repo.records.get('q-one-way');
    expect(stored?.state).toBe('rejected');
    expect(stored?.answer).toMatchObject({ shape: 'reject', answeredVia: 'signed-decision' });
  });

  it('leaves an awaiting one-way question unchanged', async () => {
    const { repo, useCase } = setup(
      oneWayRecord(),
      { state: 'awaiting-decision', decisionRevision: null, grantId: null, signature: null },
    );
    const result = await useCase.syncOneWayOwnerQuestions();
    expect(result.unchanged).toHaveLength(1);
    expect(repo.saveCalls).toBe(0);
    expect(repo.records.get('q-one-way')?.state).toBe('open');
  });

  it('leaves a one-way question unchanged when the transport fails', async () => {
    const { repo, useCase } = setup(oneWayRecord(), new Error('transport down'));
    const result = await useCase.syncOneWayOwnerQuestions();
    expect(result.unchanged).toHaveLength(1);
    expect(repo.saveCalls).toBe(0);
    expect(repo.records.get('q-one-way')?.state).toBe('open');
  });

  it('never writes a coordination request, even when a decision lands', async () => {
    const { requestRepo, useCase } = setup(
      oneWayRecord(),
      { state: 'approved', decisionRevision: 'd-1', grantId: null, signature: null },
    );
    await useCase.syncOneWayOwnerQuestions();
    expect(requestRepo.saveRequestCalls).toBe(0);
  });

  it('ignores two-way questions entirely', async () => {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set('q-two-way', twoWayRecord());
    const requestRepo = new NeverWritingRequestRepo(new Map());
    const transport = new StubDecisionTransport(
      { state: 'approved', decisionRevision: 'd-1', grantId: null, signature: null },
    );
    const useCase = new SyncOneWayOwnerQuestionsUseCase({
      ownerQuestionRepo: repo,
      requestRepo,
      decisionTransport: transport,
      clock: clock(),
    });
    const result = await useCase.syncOneWayOwnerQuestions();
    expect(result).toEqual({ outcome: 'synced', answered: [], rejected: [], unchanged: [] });
    expect(transport.calls).toHaveLength(0);
    expect(repo.saveCalls).toBe(0);
  });

  it('leaves a question whose save loses a revision race unchanged', async () => {
    const { repo, useCase } = setup(
      oneWayRecord(),
      { state: 'approved', decisionRevision: 'd-1', grantId: null, signature: null },
    );
    repo.failNextSaveWith = new OwnerQuestionRevisionConflictError('q-one-way', 2, 'lost race');
    const result = await useCase.syncOneWayOwnerQuestions();
    expect(result.answered).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
    expect(repo.records.get('q-one-way')?.state).toBe('open');
  });
});

/* ------------------------------------------------------------------ *
 * List and Read
 * ------------------------------------------------------------------ */

describe('ListOwnerQuestionsUseCase and ReadOwnerQuestionUseCase', () => {
  it('passes state and since filters through as a thin read', async () => {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set('q-1', twoWayRecord());
    repo.records.set('q-2', twoWayRecord({ questionId: 'q-2', askedAt: '2026-10-17T10:00:00.000Z' }));
    const useCase = new ListOwnerQuestionsUseCase({ ownerQuestionRepo: repo });
    const all = await useCase.listOwnerQuestions();
    expect(all.questions).toHaveLength(2);
    const narrowed = await useCase.listOwnerQuestions({ state: 'open', since: '2026-10-17T00:00:00.000Z' });
    expect(narrowed.questions.map((question) => question.questionId)).toEqual(['q-2']);
    expect(repo.queries[1]).toEqual({ state: 'open', since: '2026-10-17T00:00:00.000Z' });
  });

  it('returns no invented questions for an unknown state or unreadable since', async () => {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set('q-1', twoWayRecord());
    const useCase = new ListOwnerQuestionsUseCase({ ownerQuestionRepo: repo });
    expect((await useCase.listOwnerQuestions({ state: 'nonsense' as 'open' })).questions).toEqual([]);
    expect((await useCase.listOwnerQuestions({ since: 'not-a-time' })).questions).toEqual([]);
  });

  it('reads a recorded question and reports known absence', async () => {
    const repo = new FakeOwnerQuestionRepo();
    repo.records.set('q-1', twoWayRecord());
    const useCase = new ReadOwnerQuestionUseCase({ ownerQuestionRepo: repo });
    const found = await useCase.readOwnerQuestion({ questionId: 'q-1' });
    expect(found).toEqual({ outcome: 'found', question: twoWayRecord() });
    const missing = await useCase.readOwnerQuestion({ questionId: 'q-none' });
    expect(missing).toEqual({ outcome: 'not-found', questionId: 'q-none' });
  });
});
