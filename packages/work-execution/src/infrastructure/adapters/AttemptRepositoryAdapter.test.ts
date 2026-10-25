import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../domain/execution-records.js';
import {
  AttemptRevisionConflictError,
  nextAttemptRevision,
} from '../../application/ports/out/AttemptRepositoryPort.out-port.js';
import { AttemptRepositoryAdapter } from './AttemptRepositoryAdapter.adapter.js';
import { StateFileUnreadableError } from './file-store.js';

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

describe('AttemptRepositoryAdapter revision compare-and-swap', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-repo-cas-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
    return {
      id: 'att-1',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-1',
      baseCommit: 'commit-1',
      state: 'dispatching',
      outcome: null,
      briefDigest: 'digest-1',
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
      ...overrides,
    };
  }

  function makeRepo(useStateDir: boolean): AttemptRepositoryAdapter {
    return useStateDir ? new AttemptRepositoryAdapter({ stateDir: tempDir }) : new AttemptRepositoryAdapter();
  }

  const modes = [
    { label: 'in-memory', useStateDir: false },
    { label: 'stateDir', useStateDir: true },
  ] as const;

  for (const mode of modes) {
    it(`creates at revision 0 then updates at revision 1 (${mode.label})`, async () => {
      const adapter = makeRepo(mode.useStateDir);
      await adapter.saveAttempt(makeAttempt());

      const created = await adapter.findAttemptById('att-1');
      expect(created?.revision).toBe(0);

      await adapter.saveAttempt({
        ...created!,
        state: 'running',
        sessionId: 'ses-1',
        revision: nextAttemptRevision(created!),
      });

      const updated = await adapter.findAttemptById('att-1');
      expect(updated?.revision).toBe(1);
      expect(updated?.state).toBe('running');
      expect(updated?.sessionId).toBe('ses-1');
    });

    it(`a stale writer that never saw the update conflicts with expected and actual (${mode.label})`, async () => {
      const adapter = makeRepo(mode.useStateDir);
      await adapter.saveAttempt(makeAttempt());
      const created = (await adapter.findAttemptById('att-1'))!;
      await adapter.saveAttempt({
        ...created,
        state: 'running',
        sessionId: 'ses-1',
        revision: nextAttemptRevision(created),
      });

      // Writer B read the record at revision 0 and sends revision 1, but the
      // store is already at revision 1.
      await expect(
        adapter.saveAttempt({ ...created, state: 'cancelled', revision: 1 }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AttemptRevisionConflictError &&
          error.attemptId === 'att-1' &&
          error.expectedRevision === 1 &&
          error.actualRevision === 1,
      );
    });

    it(`a skipped revision (3 over stored 1) conflicts (${mode.label})`, async () => {
      const adapter = makeRepo(mode.useStateDir);
      await adapter.saveAttempt(makeAttempt());
      const created = (await adapter.findAttemptById('att-1'))!;
      await adapter.saveAttempt({
        ...created,
        state: 'running',
        sessionId: 'ses-1',
        revision: nextAttemptRevision(created),
      });
      const stored = (await adapter.findAttemptById('att-1'))!;

      await expect(adapter.saveAttempt({ ...stored, revision: 3 })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AttemptRevisionConflictError &&
          error.expectedRevision === 1 &&
          error.actualRevision === 3,
      );
    });

    it(`names the stored revision and the required write revision in the conflict message (${mode.label})`, async () => {
      const adapter = makeRepo(mode.useStateDir);
      await adapter.saveAttempt(makeAttempt());
      const created = (await adapter.findAttemptById('att-1'))!;
      await adapter.saveAttempt({
        ...created,
        state: 'running',
        sessionId: 'ses-1',
        revision: nextAttemptRevision(created),
      });
      const stored = (await adapter.findAttemptById('att-1'))!;

      await expect(adapter.saveAttempt({ ...stored, revision: 3 })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AttemptRevisionConflictError &&
          error.message ===
            'Stale attempt revision for att-1: stored 1, write must be 2, got 3',
      );
    });

    it(`still guards immutable identity before revision checks (${mode.label})`, async () => {
      const adapter = makeRepo(mode.useStateDir);
      await adapter.saveAttempt(makeAttempt());
      const created = (await adapter.findAttemptById('att-1'))!;

      // The revision would be valid; the identity mutation must still refuse.
      await expect(
        adapter.saveAttempt({ ...created, workOrderId: 'wo-other', revision: 1 }),
      ).rejects.toThrow('Immutable attempt identity changed for att-1: workOrderId');
    });
  }

  it('reads a legacy on-disk record without a revision as 0 and accepts revision 1 (stateDir)', async () => {
    const legacy = makeAttempt({ state: 'running', sessionId: 'ses-legacy' });
    await fs.writeFile(path.join(tempDir, 'attempts.json'), JSON.stringify([legacy]), 'utf8');

    const adapter = makeRepo(true);
    const loaded = await adapter.findAttemptById('att-1');
    expect(loaded?.revision).toBe(0);

    await expect(
      adapter.saveAttempt({ ...loaded!, state: 'ended', revision: nextAttemptRevision(loaded!) }),
    ).resolves.not.toThrow();

    const saved = await adapter.findAttemptById('att-1');
    expect(saved?.revision).toBe(1);
    expect(saved?.state).toBe('ended');
  });
});

describe('AttemptRepositoryAdapter quarantines unreadable state files', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-quarantine-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
    return {
      id: 'att-1',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-1',
      baseCommit: 'commit-1',
      state: 'dispatching',
      outcome: null,
      briefDigest: 'digest-1',
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
      ...overrides,
    };
  }

  const attemptsPath = () => path.join(tempDir, 'attempts.json');
  const quarantineDir = () => path.join(tempDir, 'quarantine');

  it('throws StateFileUnreadableError and quarantines garbage bytes', async () => {
    await fs.writeFile(attemptsPath(), '{ not valid json', 'utf8');
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.listAllAttempts()).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });

  it('throws StateFileUnreadableError and quarantines a wrong top-level shape', async () => {
    await fs.writeFile(attemptsPath(), JSON.stringify({ not: 'a list' }), 'utf8');
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.listAllAttempts()).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });

  it('throws StateFileUnreadableError instead of skipping a record that fails validation', async () => {
    await fs.writeFile(
      attemptsPath(),
      JSON.stringify([makeAttempt(), { id: 'broken', workOrderId: 42 }]),
      'utf8',
    );
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.listAllAttempts()).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });

  it('throws and leaves the bytes unchanged when a save reads an unreadable file', async () => {
    const garbage = '{ not valid json';
    await fs.writeFile(attemptsPath(), garbage, 'utf8');
    const before = createHash('sha256').update(await fs.readFile(attemptsPath())).digest('hex');
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.saveAttempt(makeAttempt({ id: 'att-corrupt' }))).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    const after = createHash('sha256').update(await fs.readFile(attemptsPath())).digest('hex');
    expect(after).toBe(before);
  });

  it('rejects saveAttempt with StateFileUnreadableError, keeps SHA-256 unchanged, and writes one quarantine copy when the file holds one valid and one invalid record', async () => {
    await fs.writeFile(
      attemptsPath(),
      JSON.stringify([makeAttempt(), { id: 'broken', workOrderId: 42 }]),
      'utf8',
    );
    const before = createHash('sha256').update(await fs.readFile(attemptsPath())).digest('hex');
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.saveAttempt(makeAttempt({ id: 'att-2' }))).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    const after = createHash('sha256').update(await fs.readFile(attemptsPath())).digest('hex');
    expect(after).toBe(before);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });
});
