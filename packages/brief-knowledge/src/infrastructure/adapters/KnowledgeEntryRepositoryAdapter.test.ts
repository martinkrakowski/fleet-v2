import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import { KnowledgeEntryRepositoryAdapter } from './KnowledgeEntryRepositoryAdapter.adapter.js';

describe('KnowledgeEntryRepositoryAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-knowledge-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves both knowledge entries when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new KnowledgeEntryRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new KnowledgeEntryRepositoryAdapter({ stateDir: tempDir });

    const entry1: KnowledgeEntryRecord = {
      id: 'entry-1',
      version: 'v1',
      projectId: 'proj-1',
      sourceAttemptId: 'att-1',
      sourceCommitSha: 'sha-1',
      claimText: 'Rule 1 applies to project',
      pathPrefixes: ['src/'],
      sharedAcrossProjects: false,
      disposition: 'candidate',
      verification: 'unverified',
      checkerId: null,
      dispositionReason: null,
      supersededById: null,
      checks: [],
      reuses: [],
      revision: 1,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const entry2: KnowledgeEntryRecord = {
      id: 'entry-2',
      version: 'v1',
      projectId: 'proj-1',
      sourceAttemptId: 'att-2',
      sourceCommitSha: 'sha-2',
      claimText: 'Rule 2 applies to project',
      pathPrefixes: ['src/'],
      sharedAcrossProjects: false,
      disposition: 'candidate',
      verification: 'unverified',
      checkerId: null,
      dispositionReason: null,
      supersededById: null,
      checks: [],
      reuses: [],
      revision: 1,
      createdAtIso: '2026-10-15T10:01:00.000Z',
      updatedAtIso: '2026-10-15T10:01:00.000Z',
    };

    await Promise.all([adapterA.saveEntry(entry1), adapterB.saveEntry(entry2)]);

    const found1FromA = await adapterA.findEntryById('entry-1');
    const found2FromA = await adapterA.findEntryById('entry-2');
    const found1FromB = await adapterB.findEntryById('entry-1');
    const found2FromB = await adapterB.findEntryById('entry-2');

    expect(found1FromA?.id).toBe('entry-1');
    expect(found2FromA?.id).toBe('entry-2');
    expect(found1FromB?.id).toBe('entry-1');
    expect(found2FromB?.id).toBe('entry-2');

    const list = await adapterA.listEntriesByProject('proj-1');
    expect(list.map((e) => e.id).sort()).toEqual(['entry-1', 'entry-2']);
  });

  it('preserves context selections when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new KnowledgeEntryRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new KnowledgeEntryRepositoryAdapter({ stateDir: tempDir });

    const sel1: ContextSelectionProps = {
      attemptId: 'att-1',
      knowledgeEntryId: 'entry-1',
      version: 'v1',
      accepted: true,
      decisionBecause: 'approved context entry',
    };

    const sel2: ContextSelectionProps = {
      attemptId: 'att-2',
      knowledgeEntryId: 'entry-2',
      version: 'v1',
      accepted: false,
      decisionBecause: 'superseded',
    };

    await Promise.all([
      adapterA.saveContextSelections('att-1', [sel1]),
      adapterB.saveContextSelections('att-2', [sel2]),
    ]);

    const selections1 = await adapterA.listContextSelections('att-1');
    const selections2 = await adapterB.listContextSelections('att-2');

    expect(selections1).toEqual([sel1]);
    expect(selections2).toEqual([sel2]);
  });

  it('throws and preserves file content when saving to a corrupt file', async () => {
    const filePath = path.join(tempDir, 'knowledge-entries.json');
    const corruptContent = '{ not valid json';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new KnowledgeEntryRepositoryAdapter({ stateDir: tempDir });
    const entry: KnowledgeEntryRecord = {
      id: 'entry-corrupt',
      version: 'v1',
      projectId: 'proj-1',
      sourceAttemptId: 'att-1',
      sourceCommitSha: 'sha-1',
      claimText: 'Rule corrupt applies',
      pathPrefixes: ['src/'],
      sharedAcrossProjects: false,
      disposition: 'candidate',
      verification: 'unverified',
      checkerId: null,
      dispositionReason: null,
      supersededById: null,
      checks: [],
      reuses: [],
      revision: 1,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await expect(adapter.saveEntry(entry)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
