import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../domain/execution-records.js';
import { AttemptRepositoryAdapter } from './AttemptRepositoryAdapter.adapter.js';

describe('AttemptRepositoryAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-repo-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves both records when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new AttemptRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new AttemptRepositoryAdapter({ stateDir: tempDir });

    const attempt1: AttemptRecord = {
      id: 'att-1',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-1',
      baseCommit: 'commit-1',
      state: 'running',
      outcome: null,
      briefDigest: 'digest-1',
      briefPackagePath: null,
      sessionId: 'ses-1',
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const attempt2: AttemptRecord = {
      id: 'att-2',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-2',
      baseCommit: 'commit-2',
      state: 'running',
      outcome: null,
      briefDigest: 'digest-2',
      briefPackagePath: null,
      sessionId: 'ses-2',
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T10:01:00.000Z',
      updatedAtIso: '2026-10-15T10:01:00.000Z',
    };

    // Both instances save different records
    await Promise.all([adapterA.saveAttempt(attempt1), adapterB.saveAttempt(attempt2)]);

    // Both records must survive in both instances
    const found1FromA = await adapterA.findAttemptById('att-1');
    const found2FromA = await adapterA.findAttemptById('att-2');
    const found1FromB = await adapterB.findAttemptById('att-1');
    const found2FromB = await adapterB.findAttemptById('att-2');

    expect(found1FromA?.id).toBe('att-1');
    expect(found2FromA?.id).toBe('att-2');
    expect(found1FromB?.id).toBe('att-1');
    expect(found2FromB?.id).toBe('att-2');

    const allAttempts = await adapterA.listAllAttempts();
    expect(allAttempts.map((a) => a.id).sort()).toEqual(['att-1', 'att-2']);
  });

  it('throws and preserves file content when saving to a corrupt file', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const corruptContent = '{ not valid json';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    const attempt: AttemptRecord = {
      id: 'att-corrupt',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-corrupt',
      baseCommit: 'commit-1',
      state: 'running',
      outcome: null,
      briefDigest: 'digest-1',
      briefPackagePath: null,
      sessionId: 'ses-1',
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await expect(adapter.saveAttempt(attempt)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
