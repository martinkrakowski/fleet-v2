import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import { EvidenceAssessmentRepositoryAdapter } from '../EvidenceAssessmentRepositoryAdapter.adapter.js';
import {
  ReadOnlyStateStoreError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
} from '../file-store.js';

const STATE_FILE = 'assessments.json';

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

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function entryOf(dir: string, name: string): Promise<[string, string]> {
  const full = path.join(dir, name);
  const stat = await fs.lstat(full);
  if (stat.isFile()) {
    const digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    return [name, digest];
  }
  return [name + '/', 'dir'];
}

/** Every file under dir (recursive) with its sha256: the whole on-disk state. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await fs.readdir(dir, { recursive: true });
  const entries = await Promise.all(names.map((name) => entryOf(dir, name)));
  return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

describe('EvidenceAssessmentRepositoryAdapter read-only (telemetry plan §3.3)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-readonly-assessment-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const assessmentsPath = () => path.join(tempDir, STATE_FILE);

  it('rejects an unreadable file with StateFileUnreadableReadOnlyError and writes nothing', async () => {
    await fs.writeFile(assessmentsPath(), '{not json CANARY-bytes', 'utf8');
    const before = await snapshot(tempDir);
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir, readOnly: true });

    const byIdError = await captureRejection(adapter.findAssessmentById('assessment-1'));
    expect(byIdError).toBeInstanceOf(StateFileUnreadableReadOnlyError);
    expect(byIdError).not.toBeInstanceOf(StateFileUnreadableError);
    expect(byIdError).toMatchObject({ filePath: assessmentsPath(), detail: 'not valid JSON' });
    expect((byIdError as Error).message).not.toContain('CANARY');

    const byHeadError = await captureRejection(adapter.findAssessmentByHead('head-sha-1'));
    expect(byHeadError).toBeInstanceOf(StateFileUnreadableReadOnlyError);
    expect(byHeadError).toMatchObject({ filePath: assessmentsPath(), detail: 'not valid JSON' });

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('rejects an invalid record with StateFileUnreadableReadOnlyError and writes nothing', async () => {
    await fs.writeFile(assessmentsPath(), JSON.stringify([{ id: 1 }]), 'utf8');
    const before = await snapshot(tempDir);
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir, readOnly: true });

    const error = await captureRejection(adapter.findAssessmentById('assessment-1'));
    expect(error).toBeInstanceOf(StateFileUnreadableReadOnlyError);
    expect(error).toMatchObject({ filePath: assessmentsPath(), detail: 'record 0 failed validation' });

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('reads a readable file by id and by head and writes nothing', async () => {
    await fs.writeFile(assessmentsPath(), JSON.stringify([makeAssessment()]), 'utf8');
    const before = await snapshot(tempDir);
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir, readOnly: true });

    const byId = await adapter.findAssessmentById('assessment-1');
    expect(byId?.id).toBe('assessment-1');
    const byHead = await adapter.findAssessmentByHead('head-sha-1');
    expect(byHead?.id).toBe('assessment-1');

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('reads a missing file as empty and writes nothing', async () => {
    const before = await snapshot(tempDir);
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir, readOnly: true });

    await expect(adapter.findAssessmentById('assessment-1')).resolves.toBeNull();
    await expect(adapter.findAssessmentByHead('head-sha-1')).resolves.toBeNull();

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('refuses every write on a read-only store and leaves the directory empty', async () => {
    const fileAdapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir, readOnly: true });
    await expect(fileAdapter.saveAssessment(makeAssessment())).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    await expect(fileAdapter.saveAssessment(makeAssessment())).rejects.toThrow(
      'EvidenceAssessmentRepositoryAdapter was opened read-only and refuses every write',
    );
    expect(await snapshot(tempDir)).toEqual({});

    const inMemoryAdapter = new EvidenceAssessmentRepositoryAdapter({ readOnly: true });
    await expect(inMemoryAdapter.saveAssessment(makeAssessment())).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    await expect(inMemoryAdapter.saveAssessment(makeAssessment())).rejects.toThrow(
      'EvidenceAssessmentRepositoryAdapter was opened read-only and refuses every write',
    );
  });

  it('without the read-only option still quarantines an unreadable file', async () => {
    await fs.writeFile(assessmentsPath(), '{not json CANARY-bytes', 'utf8');
    const adapter = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });

    const error = await captureRejection(adapter.findAssessmentById('assessment-1'));
    expect(error).toBeInstanceOf(StateFileUnreadableError);
    expect((error as StateFileUnreadableError).quarantinePath).not.toBeNull();

    const quarantineDir = path.join(tempDir, 'quarantine');
    expect(await fs.readdir(quarantineDir)).toHaveLength(1);
  });
});
