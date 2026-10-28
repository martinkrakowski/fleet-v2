/**
 * Lane Q1-2 unit tests: `AskOwnerQuestion` is find-or-create by idempotency
 * key, and `FindOwnerQuestionByKey` reads one question by its key.
 *
 * Every store here is in memory (adapters built without `stateDir`); no test
 * runs a binary, reads a network or touches a live route. The clock is always
 * injected, so a retried ask never depends on wall time.
 */

import { describe, expect, it } from 'vitest';

import type {
  CoordinationRequestRecord,
} from '../../../domain/coordination-records.js';
import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';
import { OwnerQuestionIdempotencyKeyConflictError } from '../../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type {
  OwnerQuestionListQuery,
  OwnerQuestionRepositoryPort,
} from '../../ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { AskOwnerQuestionRequest } from '../../ports/in/AskOwnerQuestionPort.in-port.js';
import type { OwnerQuestionClock } from '../../ports/in/AskOwnerQuestionPort.in-port.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import { OwnerQuestionRepositoryAdapter } from '../../../infrastructure/adapters/OwnerQuestionRepositoryAdapter.adapter.js';
import { AskOwnerQuestionUseCase } from '../AskOwnerQuestionUseCase.use-case.js';
import { FindOwnerQuestionByKeyUseCase } from '../FindOwnerQuestionByKeyUseCase.use-case.js';

const NOW_ISO = '2026-10-16T12:00:00.000Z';
const LATER_ISO = '2026-10-16T12:05:00.000Z';
const K = 'run-01JB0000000000000000000000/r0/park/0';

/** A clock the composition root would inject; it counts its reads. */
function clock(at: string = NOW_ISO): OwnerQuestionClock {
  return {
    nowIso() {
      return at;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Example ask body (two-way), as the Q1b use-case test builds one.
 * ------------------------------------------------------------------ */

function exampleRequest(overrides: Partial<AskOwnerQuestionRequest> = {}): AskOwnerQuestionRequest {
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

function requestRecord(id: string): CoordinationRequestRecord {
  return {
    id,
    projectId: 'proj-1',
    kind: 'action-decision',
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

/* ------------------------------------------------------------------ *
 * Test doubles
 * ------------------------------------------------------------------ */

/**
 * A repository wrapper that hides the key on its first `findByIdempotencyKey`
 * call (a lost race: another writer holds the key but the first lookup missed
 * it) and, when armed, plants a racing holder for the incoming record's key
 * under a chosen questionId before refusing the save with the typed key
 * conflict — exactly the race the store resolves after a refused save.
 * Everything else reaches the real in-memory adapter.
 */
class RacingKeyRepo implements OwnerQuestionRepositoryPort {
  keyLookups = 0;
  /** When armed, a save first plants the record's key under this questionId, then raises the key conflict. */
  armPlantThenRefuse: string | null = null;
  constructor(private readonly inner: OwnerQuestionRepositoryPort) {}

  async save(record: OwnerQuestionRecord, expectedRevision: number): Promise<void> {
    if (this.armPlantThenRefuse !== null) {
      const holderQuestionId = this.armPlantThenRefuse;
      this.armPlantThenRefuse = null;
      await this.inner.save({ ...record, questionId: holderQuestionId, revision: 1 }, 0);
      throw new OwnerQuestionIdempotencyKeyConflictError(
        record.questionId,
        holderQuestionId,
        'the key is held',
      );
    }
    await this.inner.save(record, expectedRevision);
  }

  async get(questionId: string): Promise<OwnerQuestionRecord | null> {
    return this.inner.get(questionId);
  }

  async list(query?: OwnerQuestionListQuery): Promise<readonly OwnerQuestionRecord[]> {
    return this.inner.list(query);
  }

  async findByIdempotencyKey(key: string): Promise<OwnerQuestionRecord | null> {
    this.keyLookups += 1;
    if (this.keyLookups === 1) {
      return null;
    }
    return this.inner.findByIdempotencyKey(key);
  }
}

/* ------------------------------------------------------------------ *
 * Ask: find-or-create by key
 * ------------------------------------------------------------------ */

describe('AskOwnerQuestionUseCase with an idempotency key', () => {
  it('asks a keyed question once and stores the key', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const result = await useCase.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(result.outcome).toBe('asked');
    if (result.outcome !== 'asked') return;
    expect(result.question.idempotencyKey).toBe(K);
    const stored = await repo.get(result.question.questionId);
    expect(stored?.idempotencyKey).toBe(K);
  });

  it('answers a retry with the same key and same ask as exists, from the store alone', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const first = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const firstResult = await first.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(firstResult.outcome).toBe('asked');

    const retry = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(LATER_ISO),
    });
    const retryResult = await retry.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(retryResult.outcome).toBe('exists');
    if (retryResult.outcome !== 'exists') return;
    expect(retryResult.question.askedAt).toBe(NOW_ISO);
    expect(retryResult.question.questionId).toBe('q-new');
    const all = await repo.list();
    expect(all.length).toBe(1);
  });

  it('answers a retry with the same key and another questionId as exists with the original id', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const first = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const firstResult = await first.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(firstResult.outcome).toBe('asked');

    const retry = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const retryResult = await retry.askOwnerQuestion(
      exampleRequest({ idempotencyKey: K, questionId: 'q-other' }),
    );
    expect(retryResult.outcome).toBe('exists');
    if (retryResult.outcome !== 'exists') return;
    expect(retryResult.question.questionId).toBe('q-new');
    const all = await repo.list();
    expect(all.length).toBe(1);
  });

  it('answers a retry after the owner answered as exists, never re-asked', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const first = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const firstResult = await first.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(firstResult.outcome).toBe('asked');
    if (firstResult.outcome !== 'asked') return;

    const stored = await repo.get(firstResult.question.questionId);
    if (stored === null) {
      throw new Error('the first ask did not store its question');
    }
    await repo.save(
      {
        ...stored,
        revision: 2,
        state: 'answered',
        answer: {
          shape: 'answer',
          optionId: 'a',
          text: 'Freeze first.',
          reason: null,
          questionRevision: 1,
          answeredVia: 'web',
          answeredAt: NOW_ISO,
          sessionId: null,
        },
      },
      1,
    );

    const retry = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const retryResult = await retry.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(retryResult.outcome).toBe('exists');
    if (retryResult.outcome !== 'exists') return;
    expect(retryResult.question.state).toBe('answered');
  });

  it('refuses a different ask under a held key, with a fixed reason and nothing new stored', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const first = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const firstResult = await first.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(firstResult.outcome).toBe('asked');

    const second = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const secondResult = await second.askOwnerQuestion(
      exampleRequest({
        idempotencyKey: K,
        questionId: 'q-different',
        title: 'A completely different decision',
      }),
    );
    expect(secondResult.outcome).toBe('refused');
    if (secondResult.outcome !== 'refused') return;
    expect(secondResult.reason).toBe('another question holds this idempotency key with a different ask');
    expect(secondResult.reason).not.toContain(K);
    expect(secondResult.reason).not.toContain('q-different');
    expect(secondResult.reason).not.toContain('A completely different decision');
    const all = await repo.list();
    expect(all.length).toBe(1);
  });

  it('reads the key before the linked-request check, so a one-way retry survives a missing link', async () => {
    const requests = new CoordinationRequestRepositoryAdapter();
    await requests.saveRequest(requestRecord('request-9'));
    const repo = new OwnerQuestionRepositoryAdapter();
    const first = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: requests,
      clock: clock(),
    });
    const askBody = exampleRequest({
      idempotencyKey: K,
      doorKind: 'one-way',
      linkedRequestId: 'request-9',
    });
    const firstResult = await first.askOwnerQuestion(askBody);
    expect(firstResult.outcome).toBe('asked');

    const retry = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: requests,
      clock: clock(),
    });
    const retryResult = await retry.askOwnerQuestion(askBody);
    expect(retryResult.outcome).toBe('exists');

    // A fresh request store knows nothing of the link; the stored key still
    // answers the ask before any link check.
    const freshRetry = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const freshResult = await freshRetry.askOwnerQuestion(askBody);
    expect(freshResult.outcome).toBe('exists');
    if (freshResult.outcome !== 'exists') return;
    expect(freshResult.question.doorKind).toBe('one-way');
  });

  it('resolves a race on the key from the store after the refused save', async () => {
    const inner = new OwnerQuestionRepositoryAdapter();
    const racing = new RacingKeyRepo(inner);
    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: racing,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const body = exampleRequest({ idempotencyKey: K });

    // Same ask: the racing save plants a holder for K, then raises the key
    // conflict; the use case maps the planted holder to exists.
    racing.armPlantThenRefuse = 'q-race-winner';
    const sameAskResult = await useCase.askOwnerQuestion(body);
    expect(sameAskResult.outcome).toBe('exists');
    if (sameAskResult.outcome !== 'exists') return;
    expect(sameAskResult.question.idempotencyKey).toBe(K);

    // A different ask under the planted holder is refused with the fixed text.
    const different = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: racing,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const differentResult = await different.askOwnerQuestion(
      exampleRequest({ idempotencyKey: K, questionId: 'q-different', title: 'Something else' }),
    );
    expect(differentResult.outcome).toBe('refused');
    if (differentResult.outcome !== 'refused') return;
    expect(differentResult.reason).toBe('another question holds this idempotency key with a different ask');
  });

  it('resolves a race on the id: same id stored with the key returns exists, without it refuses', async () => {
    const inner = new OwnerQuestionRepositoryAdapter();
    const racing = new RacingKeyRepo(inner);
    const seed = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: inner,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    // Seed the id with the key so the wrapper's first (hidden) key lookup
    // misses it but the revision conflict path finds it again.
    const seeded = await seed.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(seeded.outcome).toBe('asked');

    const useCase = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: racing,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const raceResult = await useCase.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(raceResult.outcome).toBe('exists');
    if (raceResult.outcome !== 'exists') return;
    expect(raceResult.question.idempotencyKey).toBe(K);

    // The same id stored without a key keeps the existing refusal text.
    const plain = new OwnerQuestionRepositoryAdapter();
    const plainSeed = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: plain,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const plainSeeded = await plainSeed.askOwnerQuestion(exampleRequest());
    expect(plainSeeded.outcome).toBe('asked');
    const plainRetry = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: plain,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const plainRetryResult = await plainRetry.askOwnerQuestion(exampleRequest());
    expect(plainRetryResult.outcome).toBe('refused');
    if (plainRetryResult.outcome !== 'refused') return;
    expect(plainRetryResult.reason).toBe('another writer moved this question first; ask again');
  });

  it('behaves exactly as before when no key is given', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const first = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const firstResult = await first.askOwnerQuestion(exampleRequest());
    expect(firstResult.outcome).toBe('asked');
    if (firstResult.outcome !== 'asked') return;
    expect(firstResult.question.idempotencyKey).toBeUndefined();

    const second = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const secondResult = await second.askOwnerQuestion(exampleRequest());
    expect(secondResult.outcome).toBe('refused');
    if (secondResult.outcome !== 'refused') return;
    expect(secondResult.reason).toBe('another writer moved this question first; ask again');
    const all = await repo.list();
    expect(all.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Find by key
 * ------------------------------------------------------------------ */

describe('FindOwnerQuestionByKeyUseCase', () => {
  it('finds the question holding the key after it is asked', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const ask = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const askResult = await ask.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(askResult.outcome).toBe('asked');

    const find = new FindOwnerQuestionByKeyUseCase({ ownerQuestionRepo: repo });
    const found = await find.findOwnerQuestionByKey({ idempotencyKey: K });
    expect(found.outcome).toBe('found');
    if (found.outcome !== 'found') return;
    expect(found.question.idempotencyKey).toBe(K);
    expect(found.question.questionId).toBe('q-new');
  });

  it('reports known absence, and never reads for a key that is not a non-empty string', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const find = new FindOwnerQuestionByKeyUseCase({ ownerQuestionRepo: repo });
    const unknown = await find.findOwnerQuestionByKey({ idempotencyKey: 'no-such-key' });
    expect(unknown.outcome).toBe('not-found');
    const empty = await find.findOwnerQuestionByKey({ idempotencyKey: '' });
    expect(empty.outcome).toBe('not-found');
    // The adapter also answers absence for anything that is not a string key;
    // the use case reports it without inventing a question.
    const whitespace = await find.findOwnerQuestionByKey({ idempotencyKey: '   ' });
    expect(whitespace.outcome).toBe('not-found');
  });

  it('throws when unconfigured', async () => {
    const find = new FindOwnerQuestionByKeyUseCase();
    await expect(find.findOwnerQuestionByKey({ idempotencyKey: K })).rejects.toThrow(
      'Not implemented: FindOwnerQuestionByKeyUseCase',
    );
  });
});

describe('Q1-2 review fixes', () => {
  it('a keyed ask whose id is held by the same ask WITHOUT the key is refused, never exists', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const unkeyed = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    expect((await unkeyed.askOwnerQuestion(exampleRequest())).outcome).toBe('asked');
    const keyed = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    const result = await keyed.askOwnerQuestion(exampleRequest({ idempotencyKey: K }));
    expect(result.outcome).toBe('refused');
  });

  it('finds by the exact key only: a padded key never resolves to the stored one', async () => {
    const repo = new OwnerQuestionRepositoryAdapter();
    const ask = new AskOwnerQuestionUseCase({
      ownerQuestionRepo: repo,
      requestRepo: new CoordinationRequestRepositoryAdapter(),
      clock: clock(),
    });
    expect((await ask.askOwnerQuestion(exampleRequest({ idempotencyKey: K }))).outcome).toBe('asked');
    const find = new FindOwnerQuestionByKeyUseCase({ ownerQuestionRepo: repo });
    expect((await find.findOwnerQuestionByKey({ idempotencyKey: ` ${K} ` })).outcome).toBe('not-found');
    expect((await find.findOwnerQuestionByKey({ idempotencyKey: '   ' })).outcome).toBe('not-found');
    expect((await find.findOwnerQuestionByKey({ idempotencyKey: K })).outcome).toBe('found');
  });
});
