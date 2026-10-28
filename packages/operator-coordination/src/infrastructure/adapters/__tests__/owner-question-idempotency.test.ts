/**
 * Lane Q1-1 unit tests: the idempotency key on the owner-question record and
 * store. Domain round-trips and refusals, `sameOwnerQuestionAsk`, and the
 * store contract (one question per key, immutable once stored, find by key)
 * in memory and on disk.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';
import { OwnerQuestion, sameOwnerQuestionAsk } from '../../../domain/entities/OwnerQuestion.js';
import { OwnerQuestionIdempotencyKeyConflictError } from '../../../application/ports/out/OwnerQuestionRepositoryPort.out-port.js';
import { OwnerQuestionRepositoryAdapter } from '../OwnerQuestionRepositoryAdapter.adapter.js';

const KEY = 'run-01JB0000000000000000000000/r0/park/0';

/** A secret-shaped fake assembled at runtime; the domain must refuse it. */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
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

describe('OwnerQuestion idempotencyKey (domain)', () => {
  it('round-trips a key and keeps it through a transition', () => {
    const record = questionRecord({ idempotencyKey: KEY });
    const parsed = OwnerQuestion.fromRecord(record).toRecord();
    expect(parsed.idempotencyKey).toBe(KEY);
    const answered = OwnerQuestion.fromRecord(record)
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
    expect(answered.idempotencyKey).toBe(KEY);
  });

  it('omits the property entirely when no key was given', () => {
    const record = OwnerQuestion.fromRecord(questionRecord()).toRecord();
    expect('idempotencyKey' in record).toBe(false);
    expect(JSON.stringify(record)).toBe(JSON.stringify(questionRecord()));
  });

  it('refuses malformed keys without echoing the input', () => {
    const badKeys: unknown[] = [
      '',
      'has space',
      'a'.repeat(257),
      'non-ascii-é',
      42,
      fakeSecretShape(),
    ];
    for (const key of badKeys) {
      let message = '';
      try {
        OwnerQuestion.fromRecord(questionRecord({ idempotencyKey: key as string }));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('idempotencyKey');
      if (String(key).length > 0) {
        expect(message).not.toContain(String(key));
      }
    }
  });
});

describe('sameOwnerQuestionAsk', () => {
  it('is true when only ids, times, state or the key differ', () => {
    const base = questionRecord({ idempotencyKey: KEY });
    expect(
      sameOwnerQuestionAsk(base, questionRecord({ questionId: 'q-other', idempotencyKey: KEY })),
    ).toBe(true);
    expect(
      sameOwnerQuestionAsk(base, questionRecord({ askedAt: '2026-10-17T10:00:00.000Z' })),
    ).toBe(true);
    expect(sameOwnerQuestionAsk(base, questionRecord({ state: 'expired' }))).toBe(true);
    expect(sameOwnerQuestionAsk(base, questionRecord({ idempotencyKey: undefined }))).toBe(true);
  });

  it('is false when the ask itself differs', () => {
    const base = questionRecord();
    expect(sameOwnerQuestionAsk(base, questionRecord({ title: 'Another question' }))).toBe(false);
    expect(
      sameOwnerQuestionAsk(
        base,
        questionRecord({
          options: [
            { id: 'a', label: 'Freeze first', consequence: 'Different consequence.' },
            { id: 'b', label: 'Roll forward', consequence: 'Faster but commits.' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      sameOwnerQuestionAsk(
        base,
        questionRecord({
          options: [
            { id: 'b', label: 'Roll forward', consequence: 'Faster but commits.' },
            { id: 'a', label: 'Freeze first', consequence: 'Slower but reversible.' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      sameOwnerQuestionAsk(base, questionRecord({ expiresAt: '2026-10-17T10:00:00.000Z' })),
    ).toBe(false);
    expect(
      sameOwnerQuestionAsk(base, questionRecord({ blocks: [{ kind: 'lane', ref: 'lane-7' }] })),
    ).toBe(false);
  });
});

describe('OwnerQuestionRepositoryAdapter idempotency key', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-owner-question-key-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function adapter(kind: 'memory' | 'disk'): OwnerQuestionRepositoryAdapter {
    return kind === 'memory'
      ? new OwnerQuestionRepositoryAdapter()
      : new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
  }

  describe.each(['memory', 'disk'] as const)('%s', (kind) => {
    it('finds a question by its key after save', async () => {
      const repo = adapter(kind);
      await repo.save(questionRecord({ questionId: 'q-1', idempotencyKey: KEY }), 0);
      const found = await repo.findByIdempotencyKey(KEY);
      expect(found?.questionId).toBe('q-1');
      expect(found?.idempotencyKey).toBe(KEY);
    });

    it('refuses a second question holding the same key, writing nothing', async () => {
      const repo = adapter(kind);
      await repo.save(questionRecord({ questionId: 'q-1', idempotencyKey: KEY }), 0);
      let error: unknown = null;
      try {
        await repo.save(questionRecord({ questionId: 'q-2', idempotencyKey: KEY }), 0);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OwnerQuestionIdempotencyKeyConflictError);
      if (error instanceof OwnerQuestionIdempotencyKeyConflictError) {
        expect(error.questionId).toBe('q-2');
        expect(error.heldByQuestionId).toBe('q-1');
      }
      expect(await repo.get('q-2')).toBeNull();
      expect((await repo.list()).map((record) => record.questionId)).toEqual(['q-1']);
    });

    it('refuses a save that changes or drops a stored key, leaving the record unchanged', async () => {
      const repo = adapter(kind);
      await repo.save(questionRecord({ questionId: 'q-1', idempotencyKey: KEY }), 0);
      await expect(
        repo.save(questionRecord({ questionId: 'q-1', revision: 2, idempotencyKey: 'other-key' }), 1),
      ).rejects.toThrow(/stored idempotency key/);
      await expect(
        repo.save(questionRecord({ questionId: 'q-1', revision: 2 }), 1),
      ).rejects.toThrow(/stored idempotency key/);
      const stored = await repo.get('q-1');
      expect(stored?.idempotencyKey).toBe(KEY);
      expect(stored?.revision).toBe(1);
    });

    it('returns null for an unknown, empty or non-string key', async () => {
      const repo = adapter(kind);
      await repo.save(questionRecord({ questionId: 'q-1', idempotencyKey: KEY }), 0);
      expect(await repo.findByIdempotencyKey('unknown-key')).toBeNull();
      expect(await repo.findByIdempotencyKey('')).toBeNull();
      expect(await repo.findByIdempotencyKey(42 as unknown as string)).toBeNull();
    });
  });

  it('a fresh adapter on the same directory finds the key', async () => {
    const first = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    await first.save(questionRecord({ questionId: 'q-1', idempotencyKey: KEY }), 0);
    const second = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    expect((await second.findByIdempotencyKey(KEY))?.questionId).toBe('q-1');
  });

  it('reads old files without the field and saves without adding a key', async () => {
    const legacy = questionRecord({ questionId: 'q-legacy' });
    const filePath = path.join(tempDir, 'owner-questions.json');
    await fs.writeFile(filePath, JSON.stringify([legacy]), 'utf8');
    const repo = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    const loaded = await repo.get('q-legacy');
    expect(loaded).not.toBeNull();
    expect('idempotencyKey' in (loaded ?? {})).toBe(false);
    await repo.save({ ...questionRecord({ questionId: 'q-legacy' }), revision: 2 }, 1);
    const saved = await repo.get('q-legacy');
    expect('idempotencyKey' in (saved ?? {})).toBe(false);
    expect(saved?.revision).toBe(2);
  });
});
