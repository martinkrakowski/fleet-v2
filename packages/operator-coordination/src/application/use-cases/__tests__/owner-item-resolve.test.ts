/**
 * Lane WB3a-3-2 unit tests for ResolveOwnerItemUseCase.
 *
 * One typed resolution (plan §3.3) applied to one owner item and saved at the
 * revision read: merge observations, answers read from the owner question
 * store, plan decisions, done/withdraw by the owner, the clock rules, request
 * shape refusals and the one retry on a revision conflict. Names are example-only.
 */

import { describe, expect, it } from 'vitest';

import { OwnerItem } from '../../../domain/entities/OwnerItem.js';
import { OwnerQuestion } from '../../../domain/entities/OwnerQuestion.js';
import type { OwnerItemRecord } from '../../../domain/owner-item-records.js';
import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';
import type {
  OwnerItemRepositoryPort,
  StoredOwnerItem,
} from '../../ports/out/OwnerItemRepositoryPort.out-port.js';
import { OwnerItemRevisionConflictError } from '../../ports/out/OwnerItemRepositoryPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerItemClock } from '../../ports/in/RecordOwnerItemPort.in-port.js';
import { OwnerItemRepositoryAdapter } from '../../../infrastructure/adapters/OwnerItemRepositoryAdapter.adapter.js';
import { ResolveOwnerItemUseCase } from '../ResolveOwnerItemUseCase.use-case.js';

const OPEN_ISO = '2026-10-27T10:00:00.000Z';
const NOW_ISO = '2026-10-27T11:00:00.000Z';
const ACTOR = 'owner-example';

const MERGE_REPO = 'example-org/example-repo';
const MERGE_NUMBER = 251;
const ANSWERED_AT = '2026-10-27T10:30:00.000Z';

/** A clock the composition root would inject; it counts its reads. */
function clock(at: string = NOW_ISO): OwnerItemClock & { calls: number } {
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

class FakeOwnerQuestionRepo implements OwnerQuestionRepositoryPort {
  readonly records = new Map<string, OwnerQuestionRecord>();

  async save(_record: OwnerQuestionRecord, _expectedRevision: number): Promise<void> {}

  async get(questionId: string): Promise<OwnerQuestionRecord | null> {
    return this.records.get(questionId) ?? null;
  }

  async list(): Promise<readonly OwnerQuestionRecord[]> {
    return [...this.records.values()];
  }
}

function emptyQuestions(): FakeOwnerQuestionRepo {
  return new FakeOwnerQuestionRepo();
}

function questionRecord(overrides: Partial<OwnerQuestionRecord> = {}): OwnerQuestionRecord {
  return {
    questionId: 'q-example-1',
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

function answeredQuestion(
  questionId: string,
  answerOverrides: Partial<OwnerQuestionRecord['answer']> = {},
): OwnerQuestionRecord {
  return OwnerQuestion.fromRecord(questionRecord({ questionId }))
    .transitionTo('answered', {
      answer: {
        shape: 'accept',
        optionId: 'a',
        text: null,
        reason: null,
        questionRevision: 1,
        answeredVia: 'web',
        answeredAt: ANSWERED_AT,
        sessionId: null,
        ...answerOverrides,
      },
    })
    .toRecord();
}

/**
 * A plain record with the `answer` the test needs, bypassing entity
 * validation for odd shapes (reject, blank text); the use case reads only
 * `answer`.
 */
function plainAnsweredRecord(
  questionId: string,
  answerOverrides: Partial<OwnerQuestionRecord['answer']> = {},
): OwnerQuestionRecord {
  return questionRecord({
    questionId,
    state: 'answered',
    answer: {
      shape: 'accept',
      optionId: 'a',
      text: null,
      reason: null,
      questionRevision: 1,
      answeredVia: 'web',
      answeredAt: ANSWERED_AT,
      sessionId: null,
      ...answerOverrides,
    },
  });
}

function mergeBody(number: number = MERGE_NUMBER, repository: string = MERGE_REPO): Record<string, unknown> {
  return {
    projectId: 'example-project',
    kind: 'merge',
    subject: null,
    refs: [{ kind: 'pr', repository, number }],
    blocks: [],
  };
}

function decisionQuestionBody(): Record<string, unknown> {
  return {
    projectId: 'example-project',
    kind: 'decision',
    subject: null,
    refs: [{ kind: 'question', id: 'q-example-1' }],
    blocks: [],
  };
}

function decisionBody(): Record<string, unknown> {
  return {
    projectId: 'example-project',
    kind: 'decision',
    subject: null,
    refs: [{ kind: 'plan-decision', planId: '2026-10-27_example', decisionId: 'D1' }],
    blocks: [],
  };
}

/** Open and store an item at revision 1; never a hand-written record. */
async function seed(repo: OwnerItemRepositoryAdapter, body: Record<string, unknown>, id: string): Promise<void> {
  const opened = OwnerItem.open({ itemId: id, createdBy: ACTOR, ...body }, OPEN_ISO);
  expect(opened.success).toBe(true);
  if (!opened.success) {
    return;
  }
  await repo.save(opened.value.toRecord(), 0);
}

function uc(
  itemRepo: OwnerItemRepositoryPort,
  ownerQuestionRepo: OwnerQuestionRepositoryPort = emptyQuestions(),
  at: string = NOW_ISO,
): ResolveOwnerItemUseCase {
  return new ResolveOwnerItemUseCase({ itemRepo, ownerQuestionRepo, clock: clock(at) });
}

function observePrRequest(
  overrides: Partial<{
    projectId: string;
    repository: string;
    number: number;
    state: 'merged' | 'closed' | 'open';
    source: 'merge-record' | 'forge-observation';
    observedAtIso: string;
  }> = {},
): Record<string, unknown> {
  return {
    action: 'observe-pr',
    projectId: 'example-project',
    repository: MERGE_REPO,
    number: MERGE_NUMBER,
    state: 'merged',
    source: 'merge-record',
    observedAtIso: NOW_ISO,
    ...overrides,
  };
}

class CountingItemRepo implements OwnerItemRepositoryPort {
  saves = 0;

  constructor(private readonly real: OwnerItemRepositoryPort) {}

  async get(itemId: string): Promise<StoredOwnerItem | null> {
    return this.real.get(itemId);
  }

  async findByKey(key: string): Promise<StoredOwnerItem | null> {
    return this.real.findByKey(key);
  }

  async save(item: OwnerItemRecord, expectedRevision: number): Promise<StoredOwnerItem> {
    this.saves += 1;
    return this.real.save(item, expectedRevision);
  }

  async list(): Promise<readonly StoredOwnerItem[]> {
    return this.real.list();
  }
}

class ConflictOnceItemRepo implements OwnerItemRepositoryPort {
  gets = 0;
  saves = 0;

  constructor(private readonly real: OwnerItemRepositoryPort) {}

  async get(itemId: string): Promise<StoredOwnerItem | null> {
    this.gets += 1;
    return this.real.get(itemId);
  }

  async findByKey(key: string): Promise<StoredOwnerItem | null> {
    return this.real.findByKey(key);
  }

  async save(item: OwnerItemRecord, expectedRevision: number): Promise<StoredOwnerItem> {
    this.saves += 1;
    if (this.saves === 1) {
      throw new OwnerItemRevisionConflictError(item.itemId, expectedRevision, 'moved');
    }
    return this.real.save(item, expectedRevision);
  }

  async list(): Promise<readonly StoredOwnerItem[]> {
    return this.real.list();
  }
}

class AlwaysConflictItemRepo extends ConflictOnceItemRepo {
  override async save(item: OwnerItemRecord, expectedRevision: number): Promise<StoredOwnerItem> {
    this.saves += 1;
    throw new OwnerItemRevisionConflictError(item.itemId, expectedRevision, 'moved');
  }
}

describe('ResolveOwnerItemUseCase', () => {
  it('observes a merge record and resolves a merge item, writing nothing on repeat', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, mergeBody(), 'oi-example-1');
    const counting = new CountingItemRepo(repo);
    const useCase = uc(counting);

    const first = await useCase.resolveOwnerItem(observePrRequest(), ACTOR);
    expect(first).toEqual({
      outcome: 'resolved',
      item: expect.objectContaining({ itemId: 'oi-example-1', state: 'closed' }),
      revision: 2,
    });
    if (first.outcome === 'resolved') {
      expect(first.item.resolution).toEqual({ kind: 'merged', observedAtIso: NOW_ISO });
    }
    expect(counting.saves).toBe(1);

    const second = await useCase.resolveOwnerItem(observePrRequest(), ACTOR);
    expect(second).toEqual({
      outcome: 'unchanged',
      item: expect.objectContaining({ state: 'closed' }),
      revision: 2,
    });
    expect(counting.saves).toBe(1);
  });

  it('refuses a merge from a forge observation on a fresh item', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, mergeBody(), 'oi-example-1');
    const useCase = uc(repo);

    const result = await useCase.resolveOwnerItem(
      observePrRequest({ source: 'forge-observation' }),
      ACTOR,
    );
    expect(result).toMatchObject({ outcome: 'refused', code: 'source' });
    expect((await repo.get('oi-example-1'))?.revision).toBe(1);
  });

  it('closes then reopens a merge item by forge observation and merges again', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, mergeBody(), 'oi-example-1');
    const useCase = uc(repo);

    const closed = await useCase.resolveOwnerItem(
      observePrRequest({ state: 'closed', source: 'forge-observation' }),
      ACTOR,
    );
    expect(closed).toEqual({ outcome: 'resolved', item: expect.objectContaining({ state: 'closed' }), revision: 2 });
    if (closed.outcome === 'resolved') {
      expect(closed.item.resolution).toEqual({ kind: 'pr-closed', observedAtIso: NOW_ISO });
    }

    const reopenByMerge = await useCase.resolveOwnerItem(
      observePrRequest({ state: 'open', source: 'merge-record' }),
      ACTOR,
    );
    expect(reopenByMerge).toMatchObject({ outcome: 'refused', code: 'source' });

    const reopened = await useCase.resolveOwnerItem(
      observePrRequest({ state: 'open', source: 'forge-observation' }),
      ACTOR,
    );
    expect(reopened).toEqual({ outcome: 'resolved', item: expect.objectContaining({ state: 'open' }), revision: 3 });
    if (reopened.outcome === 'resolved') {
      expect(reopened.item.history.map((entry) => entry.event)).toEqual(['opened', 'closed', 'reopened']);
    }

    const mergedAgain = await useCase.resolveOwnerItem(observePrRequest(), ACTOR);
    expect(mergedAgain).toEqual({ outcome: 'resolved', item: expect.objectContaining({ state: 'closed' }), revision: 4 });
    if (mergedAgain.outcome === 'resolved') {
      expect(mergedAgain.item.history.map((entry) => entry.event)).toEqual(['opened', 'closed', 'reopened', 'closed']);
    }
  });

  it('does not find a merge by another number or project', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, mergeBody(), 'oi-example-1');
    const useCase = uc(repo);

    const otherNumber = await useCase.resolveOwnerItem(
      observePrRequest({ number: 252 }),
      ACTOR,
    );
    expect(otherNumber).toEqual({ outcome: 'not-found' });

    const otherProject = await useCase.resolveOwnerItem(
      observePrRequest({ projectId: 'other-project' }),
      ACTOR,
    );
    expect(otherProject).toEqual({ outcome: 'not-found' });
  });

  it('answers a decision item from the recorded question answer, never the request', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, decisionQuestionBody(), 'oi-example-1');
    const questions = new FakeOwnerQuestionRepo();
    questions.records.set('q-example-1', answeredQuestion('q-example-1'));
    const useCase = uc(repo, questions);

    const result = await useCase.resolveOwnerItem({ action: 'answer', questionId: 'q-example-1' }, ACTOR);
    expect(result).toEqual({
      outcome: 'resolved',
      item: expect.objectContaining({ itemId: 'oi-example-1', state: 'closed' }),
      revision: 2,
    });
    if (result.outcome === 'resolved') {
      expect(result.item.resolution).toEqual({
        kind: 'answered',
        questionId: 'q-example-1',
        answeredAtIso: ANSWERED_AT,
      });
    }

    const claimed = await useCase.resolveOwnerItem(
      { action: 'answer', questionId: 'q-example-1', shape: 'accept', hasOption: true, answeredAtIso: NOW_ISO },
      ACTOR,
    );
    expect(claimed).toMatchObject({ outcome: 'refused', code: 'request' });
  });

  it('refuses no-choice answers and missing stores or items', async () => {
    const unansweredRepo = new OwnerItemRepositoryAdapter();
    await seed(unansweredRepo, decisionQuestionBody(), 'oi-example-1');
    const unansweredQuestions = new FakeOwnerQuestionRepo();
    unansweredQuestions.records.set('q-example-1', questionRecord());
    const unanswered = await uc(unansweredRepo, unansweredQuestions).resolveOwnerItem(
      { action: 'answer', questionId: 'q-example-1' },
      ACTOR,
    );
    expect(unanswered).toMatchObject({ outcome: 'refused', code: 'no-choice' });

    const rejectRepo = new OwnerItemRepositoryAdapter();
    await seed(rejectRepo, decisionQuestionBody(), 'oi-example-1');
    const rejectQuestions = new FakeOwnerQuestionRepo();
    rejectQuestions.records.set('q-example-1', plainAnsweredRecord('q-example-1', { shape: 'reject', optionId: null, text: null }));
    const rejected = await uc(rejectRepo, rejectQuestions).resolveOwnerItem(
      { action: 'answer', questionId: 'q-example-1' },
      ACTOR,
    );
    expect(rejected).toMatchObject({ outcome: 'refused', code: 'no-choice' });

    const blankRepo = new OwnerItemRepositoryAdapter();
    await seed(blankRepo, decisionQuestionBody(), 'oi-example-1');
    const blankQuestions = new FakeOwnerQuestionRepo();
    blankQuestions.records.set('q-example-1', plainAnsweredRecord('q-example-1', { shape: 'answer', optionId: null, text: '   ' }));
    const blank = await uc(blankRepo, blankQuestions).resolveOwnerItem(
      { action: 'answer', questionId: 'q-example-1' },
      ACTOR,
    );
    expect(blank).toMatchObject({ outcome: 'refused', code: 'no-choice' });

    const missingQuestionRepo = new OwnerItemRepositoryAdapter();
    await seed(missingQuestionRepo, decisionQuestionBody(), 'oi-example-1');
    const missingQuestion = await uc(missingQuestionRepo, new FakeOwnerQuestionRepo()).resolveOwnerItem(
      { action: 'answer', questionId: 'q-example-1' },
      ACTOR,
    );
    expect(missingQuestion).toEqual({ outcome: 'not-found' });

    const noItemRepo = new OwnerItemRepositoryAdapter();
    await seed(noItemRepo, decisionQuestionBody(), 'oi-example-1');
    const noItem = await uc(noItemRepo).resolveOwnerItem(
      { action: 'answer', questionId: 'q-nonexistent' },
      ACTOR,
    );
    expect(noItem).toEqual({ outcome: 'not-found' });
  });

  it('refuses kind when another kind holds the question key, leaving the item unchanged', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(
      repo,
      {
        projectId: 'example-project',
        kind: 'other',
        subject: 'example follow-up',
        refs: [{ kind: 'question', id: 'q-example-2' }],
        blocks: [],
      },
      'oi-example-1',
    );
    const questions = new FakeOwnerQuestionRepo();
    questions.records.set('q-example-2', answeredQuestion('q-example-2'));
    const useCase = uc(repo, questions);

    const result = await useCase.resolveOwnerItem({ action: 'answer', questionId: 'q-example-2' }, ACTOR);
    expect(result).toMatchObject({ outcome: 'refused', code: 'kind' });
    const stored = await repo.get('oi-example-1');
    expect(stored?.item.state).toBe('open');
    expect(stored?.revision).toBe(1);
  });

  it('records a plan decision and refuses a later removal or bad revision', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, decisionBody(), 'oi-example-1');
    const useCase = uc(repo);

    const decided = await useCase.resolveOwnerItem(
      { action: 'plan-decision', projectId: 'example-project', planId: '2026-10-27_example', decisionId: 'D1', outcome: 'decided', planRevision: 3 },
      ACTOR,
    );
    expect(decided).toEqual({ outcome: 'resolved', item: expect.objectContaining({ state: 'closed' }), revision: 2 });
    if (decided.outcome === 'resolved') {
      expect(decided.item.resolution).toEqual({ kind: 'plan-decided', planRevision: 3, atIso: NOW_ISO });
    }

    const again = await useCase.resolveOwnerItem(
      { action: 'plan-decision', projectId: 'example-project', planId: '2026-10-27_example', decisionId: 'D1', outcome: 'decided', planRevision: 3 },
      ACTOR,
    );
    expect(again).toEqual({ outcome: 'unchanged', item: expect.objectContaining({ state: 'closed' }), revision: 2 });

    const removed = await useCase.resolveOwnerItem(
      { action: 'plan-decision', projectId: 'example-project', planId: '2026-10-27_example', decisionId: 'D1', outcome: 'removed', planRevision: 3 },
      ACTOR,
    );
    expect(removed).toMatchObject({ outcome: 'refused', code: 'state' });

    const badRevision = await useCase.resolveOwnerItem(
      { action: 'plan-decision', projectId: 'example-project', planId: '2026-10-27_example', decisionId: 'D1', outcome: 'decided', planRevision: 0 },
      ACTOR,
    );
    expect(badRevision).toMatchObject({ outcome: 'refused', code: 'invalid' });
  });

  it('refuses done and withdraw for merge and decision items', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, mergeBody(), 'oi-example-1');
    await seed(repo, decisionBody(), 'oi-example-2');
    const useCase = uc(repo);

    const doneMerge = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-1', via: 'cli' }, ACTOR);
    expect(doneMerge).toMatchObject({ outcome: 'refused', code: 'kind' });
    const withdrawMerge = await useCase.resolveOwnerItem({ action: 'withdraw', itemId: 'oi-example-1', reason: 'superseded' }, ACTOR);
    expect(withdrawMerge).toMatchObject({ outcome: 'refused', code: 'kind' });
    const doneDecision = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-2', via: 'cli' }, ACTOR);
    expect(doneDecision).toMatchObject({ outcome: 'refused', code: 'kind' });
    const withdrawDecision = await useCase.resolveOwnerItem({ action: 'withdraw', itemId: 'oi-example-2', reason: 'duplicate' }, ACTOR);
    expect(withdrawDecision).toMatchObject({ outcome: 'refused', code: 'kind' });

    expect((await repo.get('oi-example-1'))?.item.state).toBe('open');
    expect((await repo.get('oi-example-1'))?.revision).toBe(1);
    expect((await repo.get('oi-example-2'))?.item.state).toBe('open');
    expect((await repo.get('oi-example-2'))?.revision).toBe(1);
  });

  it('marks secret, backup and other items done by the owner', async () => {
    for (const kind of ['secret', 'backup', 'other'] as const) {
      const repo = new OwnerItemRepositoryAdapter();
      await seed(
        repo,
        { projectId: 'example-project', kind, subject: kind === 'other' ? 'example follow-up' : 'example rotation', refs: [], blocks: [] },
        'oi-example-1',
      );
      const useCase = uc(repo);

      const result = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-1', via: 'cli' }, ACTOR);
      expect(result).toEqual({ outcome: 'resolved', item: expect.objectContaining({ state: 'closed' }), revision: 2 });
      if (result.outcome === 'resolved') {
        expect(result.item.resolution).toEqual({ kind: 'done', via: 'cli', by: ACTOR, atIso: NOW_ISO });
      }
    }
  });

  it('withdraws secret, backup and other items with each typed reason, then refuses a second withdraw', async () => {
    for (const kind of ['secret', 'backup', 'other'] as const) {
      for (const reason of ['no-longer-needed', 'duplicate', 'superseded'] as const) {
        const repo = new OwnerItemRepositoryAdapter();
        await seed(
          repo,
          { projectId: 'example-project', kind, subject: kind === 'other' ? 'example follow-up' : 'example rotation', refs: [], blocks: [] },
          'oi-example-1',
        );
        const useCase = uc(repo);

        const first = await useCase.resolveOwnerItem({ action: 'withdraw', itemId: 'oi-example-1', reason }, ACTOR);
        expect(first).toMatchObject({ outcome: 'resolved', revision: 2 });
        if (first.outcome === 'resolved') {
          expect(first.item.state).toBe('withdrawn');
          expect(first.item.withdrawal).toEqual({ reason, by: ACTOR, atIso: NOW_ISO });
        }

        const second = await useCase.resolveOwnerItem({ action: 'withdraw', itemId: 'oi-example-1', reason }, ACTOR);
        expect(second).toMatchObject({ outcome: 'refused', code: 'state' });
      }
    }
  });

  it('refuses an unknown withdraw reason without echoing it', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, { projectId: 'example-project', kind: 'other', subject: 'example follow-up', refs: [], blocks: [] }, 'oi-example-1');
    const useCase = uc(repo);

    const result = await useCase.resolveOwnerItem({ action: 'withdraw', itemId: 'oi-example-1', reason: 'XYZZY' }, ACTOR);
    expect(result).toMatchObject({ outcome: 'refused', code: 'invalid' });
    if (result.outcome === 'refused') {
      expect(result.reason).not.toContain('XYZZY');
    }
  });

  it('returns not-found for an unknown item id', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, { projectId: 'example-project', kind: 'other', subject: 'example follow-up', refs: [], blocks: [] }, 'oi-example-1');
    const useCase = uc(repo);

    const result = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-nonexistent', via: 'cli' }, ACTOR);
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('refuses a clock before the last history entry', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, { projectId: 'example-project', kind: 'other', subject: 'example follow-up', refs: [], blocks: [] }, 'oi-example-1');
    const useCase = uc(repo, emptyQuestions(), '2026-10-27T09:00:00.000Z');

    const result = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-1', via: 'cli' }, ACTOR);
    expect(result).toMatchObject({ outcome: 'refused', code: 'clock' });
  });

  it('refuses an unreadable clock', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, { projectId: 'example-project', kind: 'other', subject: 'example follow-up', refs: [], blocks: [] }, 'oi-example-1');
    const useCase = uc(repo, emptyQuestions(), 'not-a-time');

    const result = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-1', via: 'cli' }, ACTOR);
    expect(result).toMatchObject({ outcome: 'refused', code: 'clock-read' });
  });

  it('refuses malformed requests without echoing input values', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    await seed(repo, mergeBody(), 'oi-example-1');
    const useCase = uc(repo);

    const bodies: unknown[] = [
      { action: 'merge-it' },
      { action: 'observe-pr', projectId: 'example-project' },
      {
        action: 'observe-pr',
        projectId: 'example-project',
        repository: MERGE_REPO,
        number: MERGE_NUMBER,
        state: 'merged',
        source: 'merge-record',
        observedAtIso: NOW_ISO,
        extra: true,
      },
      {
        action: 'observe-pr',
        projectId: 'example-project',
        repository: MERGE_REPO,
        number: 1.5,
        state: 'merged',
        source: 'merge-record',
        observedAtIso: NOW_ISO,
      },
      42,
      null,
      'observe-pr',
    ];
    for (const body of bodies) {
      const result = await useCase.resolveOwnerItem(body, ACTOR);
      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') {
        expect(result.code).toBe('request');
        expect(result.reason).not.toContain(String(body));
      }
    }

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    const proxyResult = await useCase.resolveOwnerItem(throwingProxy, ACTOR);
    expect(proxyResult).toMatchObject({ outcome: 'refused', code: 'request' });
    if (proxyResult.outcome === 'refused') {
      expect(proxyResult.reason).not.toContain('boom');
    }
  });

  it('retries once after a revision conflict and resolves', async () => {
    const real = new OwnerItemRepositoryAdapter();
    await seed(real, { projectId: 'example-project', kind: 'other', subject: 'example follow-up', refs: [], blocks: [] }, 'oi-example-1');
    const racing = new ConflictOnceItemRepo(real);
    const useCase = uc(racing);

    const result = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-1', via: 'cli' }, ACTOR);
    expect(result).toEqual({ outcome: 'resolved', item: expect.objectContaining({ state: 'closed' }), revision: 2 });
    expect(racing.gets).toBe(2);
    expect(racing.saves).toBe(2);
  });

  it('refuses with conflict after exactly two attempts when the save always loses', async () => {
    const real = new OwnerItemRepositoryAdapter();
    await seed(real, { projectId: 'example-project', kind: 'other', subject: 'example follow-up', refs: [], blocks: [] }, 'oi-example-1');
    const racing = new AlwaysConflictItemRepo(real);
    const useCase = uc(racing);

    const result = await useCase.resolveOwnerItem({ action: 'done', itemId: 'oi-example-1', via: 'cli' }, ACTOR);
    expect(result).toMatchObject({ outcome: 'refused', code: 'conflict' });
    expect(racing.gets).toBe(2);
    expect(racing.saves).toBe(2);
  });

  it('throws Not implemented when unconfigured', async () => {
    await expect(new ResolveOwnerItemUseCase().resolveOwnerItem({}, 'x')).rejects.toThrow(
      'Not implemented: ResolveOwnerItemUseCase',
    );
  });
});
