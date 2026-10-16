import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import { CoordinationRequestRepositoryAdapter } from '../CoordinationRequestRepositoryAdapter.adapter.js';
import { OwnerQuestionRepositoryAdapter } from '../OwnerQuestionRepositoryAdapter.adapter.js';
import { OwnerQuestionRevisionConflictError } from '../../../application/ports/out/OwnerQuestionRepositoryPort.out-port.js';
import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

/**
 * A secret-shaped fake assembled at runtime from inert pieces; the scanner
 * must still refuse the shape in stored text.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function questionRecord(overrides: Partial<OwnerQuestionRecord> = {}): OwnerQuestionRecord {
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
    doorKind: 'one-way',
    linkedRequestId: 'request-9',
    blocks: [{ kind: 'lane', ref: 'lane-7' }],
    state: 'open',
    askedAt: '2026-10-16T10:00:00.000Z',
    expiresAt: null,
    answer: null,
    acknowledgement: null,
    ...overrides,
  };
}

function requestRecord(id: string): CoordinationRequestRecord {
  return {
    id,
    projectId: 'proj-1',
    kind: 'action-decision',
    actionScope: 'forge:push-and-open-pr',
    expectedHeadSha: 'commit-1',
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: null,
    grantId: null,
    state: 'proposed',
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    consumptions: [],
    acknowledgements: [],
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
  };
}

describe('OwnerQuestionRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-owner-question-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips a record through the state file', async () => {
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(questionRecord(), 0);

    const loaded = await adapter.get('q-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.doorKind).toBe('one-way');
    expect(loaded?.linkedRequestId).toBe('request-9');
    expect(loaded?.options).toHaveLength(2);

    // A second adapter instance reads the same persisted state.
    const other = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    expect(await other.get('q-1')).not.toBeNull();

    expect(await fs.readFile(path.join(tempDir, 'owner-questions.json'), 'utf8')).toContain('q-1');
  });

  it('refuses a save whose expected revision does not match the stored revision', async () => {
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(questionRecord(), 0);

    try {
      await adapter.save(questionRecord({ revision: 2 }), 0);
      throw new Error('expected a revision conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OwnerQuestionRevisionConflictError);
      const conflict = error as OwnerQuestionRevisionConflictError;
      expect(conflict.questionId).toBe('q-1');
      expect(conflict.attemptedRevision).toBe(0);
    }

    // The accepted optimistic path: read, then write the next revision.
    const current = await adapter.get('q-1');
    await adapter.save({ ...questionRecord(), revision: (current?.revision ?? 0) + 1 }, 1);
    expect((await adapter.get('q-1'))?.revision).toBe(2);
  });

  it('keeps owner questions in their own file, separate from coordination requests', async () => {
    const questions = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    const requests = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
    await questions.save(questionRecord({ questionId: 'q-2' }), 0);
    await requests.saveRequest(requestRecord('req-1'));

    // The coordination request repository (the one ResolveActionAuthorizationUseCase
    // reads) never sees owner questions, on disk or through its port.
    expect(await requests.listRequests()).toHaveLength(1);
    expect((await requests.listRequests())[0]?.id).toBe('req-1');
    expect(await requests.findRequestById('q-2')).toBeNull();
    const requestsFile = await fs.readFile(
      path.join(tempDir, 'coordination-requests.json'),
      'utf8',
    );
    expect(requestsFile).not.toContain('q-2');

    const questionsFile = await fs.readFile(path.join(tempDir, 'owner-questions.json'), 'utf8');
    expect(questionsFile).toContain('q-2');
    expect(questionsFile).not.toContain('req-1');
    expect(await questions.list()).toHaveLength(1);
  });

  it('filters list by state and since', async () => {
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(questionRecord({ questionId: 'q-early', askedAt: '2026-10-15T09:00:00.000Z' }), 0);
    await adapter.save(questionRecord({ questionId: 'q-late', askedAt: '2026-10-16T09:00:00.000Z' }), 0);

    expect((await adapter.list()).map((q) => q.questionId)).toEqual(['q-early', 'q-late']);
    expect((await adapter.list({ since: '2026-10-16T00:00:00.000Z' })).map((q) => q.questionId)).toEqual([
      'q-late',
    ]);
    expect((await adapter.list({ state: 'open' })).map((q) => q.questionId)).toEqual([
      'q-early',
      'q-late',
    ]);
    expect(await adapter.list({ state: 'answered' })).toHaveLength(0);
  });

  it('re-validates persisted records through the domain on load', async () => {
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(questionRecord(), 0);
    const filePath = path.join(tempDir, 'owner-questions.json');
    const tampered = JSON.parse(await fs.readFile(filePath, 'utf8')) as OwnerQuestionRecord[];
    // Secret-shaped text injected behind the adapter's back must not become readable state.
    (tampered[0] as { title: string }).title = `Looks fine ${fakeSecretShape()}`;
    await fs.writeFile(filePath, JSON.stringify(tampered), 'utf8');
    await expect(adapter.get('q-1')).rejects.toThrow(/secret-shaped value/);
  });

  it('works fully in memory when no stateDir is configured', async () => {
    const adapter = new OwnerQuestionRepositoryAdapter();
    await adapter.save(questionRecord(), 0);
    expect(await adapter.get('q-1')).not.toBeNull();
    await expect(adapter.save(questionRecord(), 0)).rejects.toBeInstanceOf(
      OwnerQuestionRevisionConflictError,
    );
  });
});
