import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessmentRepositoryAdapter } from './EvidenceAssessmentRepositoryAdapter.adapter.js';
import { StateFileUnreadableError } from './file-store.js';

describe('EvidenceAssessmentRepositoryAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-assessment-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves both assessments when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });

    const assessment1: EvidenceAssessmentRecord = {
      id: 'assessment-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: 'head-sha-1',
      policyRevision: 'pol-1',
      implementerModel: 'provider-b/model-implementer',
      requiredChecks: ['test', 'typecheck'],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 1,
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const assessment2: EvidenceAssessmentRecord = {
      id: 'assessment-2',
      projectId: 'proj-1',
      attemptId: 'att-2',
      candidateHeadSha: 'head-sha-2',
      policyRevision: 'pol-1',
      implementerModel: 'provider-b/model-implementer',
      requiredChecks: ['lint'],
      state: 'accepted',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: 'rcpt-2',
      blockers: [],
      revision: 1,
      updatedAtIso: '2026-10-15T10:01:00.000Z',
    };

    await Promise.all([adapterA.saveAssessment(assessment1), adapterB.saveAssessment(assessment2)]);

    const found1FromA = await adapterA.findAssessmentById('assessment-1');
    const found2FromA = await adapterA.findAssessmentById('assessment-2');
    const found1FromB = await adapterB.findAssessmentById('assessment-1');
    const found2FromB = await adapterB.findAssessmentById('assessment-2');

    expect(found1FromA?.id).toBe('assessment-1');
    expect(found2FromA?.id).toBe('assessment-2');
    expect(found1FromB?.id).toBe('assessment-1');
    expect(found2FromB?.id).toBe('assessment-2');

    const byHead1 = await adapterA.findAssessmentByHead('head-sha-1');
    const byHead2 = await adapterB.findAssessmentByHead('head-sha-2');
    expect(byHead1?.id).toBe('assessment-1');
    expect(byHead2?.id).toBe('assessment-2');
  });

  it('evaluates optimistic revision against the freshly read assessment', async () => {
    const adapterA = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });

    const assessment1: EvidenceAssessmentRecord = {
      id: 'assessment-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: 'head-sha-1',
      policyRevision: 'pol-1',
      implementerModel: 'provider-b/model-implementer',
      requiredChecks: ['test'],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 1,
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await adapterA.saveAssessment(assessment1);

    // adapterB advances to revision 2
    await adapterB.saveAssessment({ ...assessment1, revision: 2 });

    // adapterA attempts to save with revision 1
    await expect(adapterA.saveAssessment({ ...assessment1, revision: 1 })).rejects.toThrow(
      'Optimistic concurrency conflict for assessment assessment-1: revision 1 does not advance stored revision 2',
    );
  });

  it('throws and preserves file content when saving to a corrupt file', async () => {
    const filePath = path.join(tempDir, 'assessments.json');
    const corruptContent = '{ not valid json';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    const assessment: EvidenceAssessmentRecord = {
      id: 'assessment-corrupt',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: 'head-sha-1',
      policyRevision: 'pol-1',
      implementerModel: 'provider-b/model-implementer',
      requiredChecks: ['test'],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 1,
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await expect(adapter.saveAssessment(assessment)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});

describe('EvidenceAssessmentRepositoryAdapter quarantines unreadable state files', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-assessment-quarantine-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeAssessment(): EvidenceAssessmentRecord {
    return {
      id: 'assessment-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: 'head-sha-1',
      policyRevision: 'pol-1',
      implementerModel: 'provider-b/model-implementer',
      requiredChecks: ['test'],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 1,
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };
  }

  const assessmentsPath = () => path.join(tempDir, 'assessments.json');
  const quarantineDir = () => path.join(tempDir, 'quarantine');

  it('throws StateFileUnreadableError and quarantines garbage bytes', async () => {
    await fs.writeFile(assessmentsPath(), '{ not valid json', 'utf8');
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findAssessmentById('nope')).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });

  it('throws StateFileUnreadableError and quarantines a wrong top-level shape', async () => {
    await fs.writeFile(assessmentsPath(), JSON.stringify({ assessments: [] }), 'utf8');
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findAssessmentById('nope')).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });

  it('throws StateFileUnreadableError instead of skipping an assessment that fails validation', async () => {
    await fs.writeFile(
      assessmentsPath(),
      JSON.stringify([makeAssessment(), { id: 'broken' }]),
      'utf8',
    );
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findAssessmentById('nope')).rejects.toBeInstanceOf(StateFileUnreadableError);
    expect(await fs.readdir(quarantineDir())).toHaveLength(1);
  });

  it('throws and leaves the bytes unchanged when a save reads an unreadable file', async () => {
    const garbage = '{ not valid json';
    await fs.writeFile(assessmentsPath(), garbage, 'utf8');
    const before = createHash('sha256').update(await fs.readFile(assessmentsPath())).digest('hex');
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.saveAssessment(makeAssessment())).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    const after = createHash('sha256').update(await fs.readFile(assessmentsPath())).digest('hex');
    expect(after).toBe(before);
  });
});
