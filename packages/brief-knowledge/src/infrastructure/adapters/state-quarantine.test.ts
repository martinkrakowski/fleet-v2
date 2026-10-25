import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import { KnowledgeEntryRepositoryAdapter } from './KnowledgeEntryRepositoryAdapter.adapter.js';
import { StateFileUnreadableError } from './file-store.js';

const tempDirs: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'brief-knowledge-quarantine-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeEntry(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
  return {
    id: 'entry-1',
    version: '1.0.0',
    projectId: 'proj-1',
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: 'commit-1',
    claimText: 'Always run the typecheck before committing',
    pathPrefixes: [],
    sharedAcrossProjects: false,
    disposition: 'accepted',
    verification: 'supported',
    checkerId: 'checker-1',
    dispositionReason: 'verified by procedure',
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-15T00:00:00.000Z',
    updatedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeSelection(attemptId: string, index: number): ContextSelectionProps {
  return {
    attemptId,
    knowledgeEntryId: `entry-${index}`,
    version: '1.0.0',
    accepted: true,
    decisionBecause: `because-${index}`,
  };
}

describe('KnowledgeEntryRepositoryAdapter quarantines unreadable state files (entries store)', () => {
  const entriesPath = (stateDir: string) => join(stateDir, 'knowledge-entries.json');
  const quarantineDir = (stateDir: string) => join(stateDir, 'quarantine');

  it('quarantines garbage bytes with a byte-identical mode-600 copy', async () => {
    const stateDir = await makeTempStateDir();
    const target = entriesPath(stateDir);
    const garbage = '{ not valid json';
    await writeFile(target, garbage, 'utf8');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.findEntryById('entry-1')).rejects.toBeInstanceOf(StateFileUnreadableError);

    const copies = await readdir(quarantineDir(stateDir));
    expect(copies).toHaveLength(1);
    const copyPath = join(quarantineDir(stateDir), copies[0]!);
    const copyBytes = await readFile(copyPath);
    expect(createHash('sha256').update(copyBytes).digest('hex')).toBe(
      createHash('sha256').update(garbage).digest('hex'),
    );
    expect((await stat(copyPath)).mode & 0o777).toBe(0o600);
  });

  it('quarantines a wrong top-level shape', async () => {
    const stateDir = await makeTempStateDir();
    await writeFile(entriesPath(stateDir), JSON.stringify({ not: 'a list' }), 'utf8');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.listEntriesByProject()).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await readdir(quarantineDir(stateDir))).toHaveLength(1);
  });

  it('rejects instead of silently skipping a record that fails validation', async () => {
    const stateDir = await makeTempStateDir();
    await writeFile(entriesPath(stateDir), JSON.stringify([makeEntry(), { id: 42 }]), 'utf8');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.listEntriesByProject()).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await readdir(quarantineDir(stateDir))).toHaveLength(1);
  });

  it('throws and leaves the original bytes unchanged when a save reads an unreadable file', async () => {
    const stateDir = await makeTempStateDir();
    const target = entriesPath(stateDir);
    const garbage = '{ not valid json';
    await writeFile(target, garbage, 'utf8');
    const before = createHash('sha256').update(await readFile(target)).digest('hex');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.saveEntry(makeEntry({ id: 'entry-corrupt' }))).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );

    const after = createHash('sha256').update(await readFile(target)).digest('hex');
    expect(after).toBe(before);
  });
});

describe('KnowledgeEntryRepositoryAdapter quarantines unreadable state files (selections store)', () => {
  const selectionsPath = (stateDir: string) => join(stateDir, 'context-selections.json');
  const quarantineDir = (stateDir: string) => join(stateDir, 'quarantine');

  it('quarantines garbage bytes with a byte-identical mode-600 copy', async () => {
    const stateDir = await makeTempStateDir();
    const target = selectionsPath(stateDir);
    const garbage = '{ not valid json';
    await writeFile(target, garbage, 'utf8');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.listContextSelections('attempt-1')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );

    const copies = await readdir(quarantineDir(stateDir));
    expect(copies).toHaveLength(1);
    const copyPath = join(quarantineDir(stateDir), copies[0]!);
    const copyBytes = await readFile(copyPath);
    expect(createHash('sha256').update(copyBytes).digest('hex')).toBe(
      createHash('sha256').update(garbage).digest('hex'),
    );
    expect((await stat(copyPath)).mode & 0o777).toBe(0o600);
  });

  it('quarantines a wrong top-level shape', async () => {
    const stateDir = await makeTempStateDir();
    await writeFile(selectionsPath(stateDir), JSON.stringify({ not: 'a list' }), 'utf8');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.listContextSelections('attempt-1')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    expect(await readdir(quarantineDir(stateDir))).toHaveLength(1);
  });

  it('rejects instead of silently skipping a selection that fails validation', async () => {
    const stateDir = await makeTempStateDir();
    await writeFile(
      selectionsPath(stateDir),
      JSON.stringify([makeSelection('attempt-1', 1), { attemptId: 42 }]),
      'utf8',
    );

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(adapter.listContextSelections('attempt-1')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    expect(await readdir(quarantineDir(stateDir))).toHaveLength(1);
  });

  it('throws and leaves the original bytes unchanged when a save reads an unreadable file', async () => {
    const stateDir = await makeTempStateDir();
    const target = selectionsPath(stateDir);
    const garbage = '{ not valid json';
    await writeFile(target, garbage, 'utf8');
    const before = createHash('sha256').update(await readFile(target)).digest('hex');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir });
    await expect(
      adapter.saveContextSelections('attempt-1', [makeSelection('attempt-1', 2)]),
    ).rejects.toBeInstanceOf(StateFileUnreadableError);

    const after = createHash('sha256').update(await readFile(target)).digest('hex');
    expect(after).toBe(before);
  });
});
