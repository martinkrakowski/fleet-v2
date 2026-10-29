import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CoordinationRequestRecord,
  ProjectProfileRecord,
} from '../../domain/coordination-records.js';
import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import { CoordinationRequestRepositoryAdapter } from './CoordinationRequestRepositoryAdapter.adapter.js';
import { OwnerQuestionRepositoryAdapter } from './OwnerQuestionRepositoryAdapter.adapter.js';
import { ProjectProfileRepositoryAdapter } from './ProjectProfileRepositoryAdapter.adapter.js';
import { describeRecordListStore, StateFileUnreadableError } from './file-store.js';

function profileRecord(): ProjectProfileRecord {
  return {
    projectId: 'proj-1',
    displayName: 'Project One',
    repository: 'org/repo-1',
    designatedDispatcherHost: 'host-1',
    policyRevision: 'pol-1',
    maxConcurrentLanes: 2,
    runnerCapabilities: {
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
    },
    revision: 0,
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    status: 'active',
    defaultBranch: null,
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
  };
}

function questionRecord(): OwnerQuestionRecord {
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
  };
}

function requestRecord(): CoordinationRequestRecord {
  return {
    id: 'req-1',
    projectId: 'proj-1',
    kind: 'action-decision',
    actionScope: 'forge:push-and-open-pr',
    expectedHeadSha: 'commit-1',
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: null,
    grantId: 'grant-1',
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

async function expectSingleQuarantineCopy(filePath: string, originalBytes: Buffer): Promise<void> {
  const quarantineDir = path.join(path.dirname(filePath), 'quarantine');
  const entries = await fs.readdir(quarantineDir);
  expect(entries).toHaveLength(1);
  const copyPath = path.join(quarantineDir, entries[0]);
  const copyBytes = await fs.readFile(copyPath);
  expect(createHash('sha256').update(copyBytes).digest('hex')).toBe(
    createHash('sha256').update(originalBytes).digest('hex'),
  );
  const stat = await fs.stat(copyPath);
  expect(stat.mode & 0o777).toBe(0o600);
}

describe('operator-coordination stores quarantine unreadable state', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-state-quarantine-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('ProjectProfileRepositoryAdapter', () => {
    const filePath = (): string => path.join(tempDir, 'project-profiles.json');

    it('a. rejects garbage bytes and keeps one byte-exact quarantine copy at mode 0o600', async () => {
      const garbage = Buffer.from('{ not valid json', 'utf8');
      await fs.writeFile(filePath(), garbage);
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.listProfiles()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), garbage);
    });

    it('b. rejects a wrong top-level shape and keeps one quarantine copy', async () => {
      const bytes = Buffer.from(JSON.stringify({ not: 'a list' }), 'utf8');
      await fs.writeFile(filePath(), bytes);
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.listProfiles()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), bytes);
    });

    it('c. rejects one valid plus one invalid record instead of silently skipping it', async () => {
      const bytes = Buffer.from(JSON.stringify([profileRecord(), { projectId: 'broken' }]), 'utf8');
      await fs.writeFile(filePath(), bytes);
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.listProfiles()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), bytes);
    });

    it('d. rejects a save over an unreadable file and leaves the original bytes unchanged', async () => {
      const garbage = Buffer.from('{ not valid json', 'utf8');
      await fs.writeFile(filePath(), garbage);
      const before = createHash('sha256').update(await fs.readFile(filePath())).digest('hex');
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.saveProfile(profileRecord())).rejects.toBeInstanceOf(
        StateFileUnreadableError,
      );
      const after = createHash('sha256').update(await fs.readFile(filePath())).digest('hex');
      expect(after).toBe(before);
    });
  });

  describe('OwnerQuestionRepositoryAdapter', () => {
    const filePath = (): string => path.join(tempDir, 'owner-questions.json');

    it('a. rejects garbage bytes and keeps one byte-exact quarantine copy at mode 0o600', async () => {
      const garbage = Buffer.from('{ not valid json', 'utf8');
      await fs.writeFile(filePath(), garbage);
      const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), garbage);
    });

    it('b. rejects a wrong top-level shape and keeps one quarantine copy', async () => {
      const bytes = Buffer.from(JSON.stringify({ not: 'a list' }), 'utf8');
      await fs.writeFile(filePath(), bytes);
      const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), bytes);
    });

    it('c. rejects one valid plus one invalid record instead of silently skipping it', async () => {
      const bytes = Buffer.from(JSON.stringify([questionRecord(), { questionId: 'broken' }]), 'utf8');
      await fs.writeFile(filePath(), bytes);
      const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), bytes);
    });

    it('d. rejects a save over an unreadable file and leaves the original bytes unchanged', async () => {
      const garbage = Buffer.from('{ not valid json', 'utf8');
      await fs.writeFile(filePath(), garbage);
      const before = createHash('sha256').update(await fs.readFile(filePath())).digest('hex');
      const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.save(questionRecord(), 0)).rejects.toBeInstanceOf(
        StateFileUnreadableError,
      );
      const after = createHash('sha256').update(await fs.readFile(filePath())).digest('hex');
      expect(after).toBe(before);
    });
  });

  describe('CoordinationRequestRepositoryAdapter', () => {
    const filePath = (): string => path.join(tempDir, 'coordination-requests.json');

    it('a. rejects garbage bytes and keeps one byte-exact quarantine copy at mode 0o600', async () => {
      const garbage = Buffer.from('{ not valid json', 'utf8');
      await fs.writeFile(filePath(), garbage);
      const adapter = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.listRequests()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), garbage);
    });

    it('b. rejects a wrong top-level shape and keeps one quarantine copy', async () => {
      const bytes = Buffer.from(JSON.stringify({ not: 'a list' }), 'utf8');
      await fs.writeFile(filePath(), bytes);
      const adapter = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.listRequests()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), bytes);
    });

    it('c. rejects one valid plus one invalid record instead of silently skipping it', async () => {
      const bytes = Buffer.from(JSON.stringify([requestRecord(), { id: 'broken' }]), 'utf8');
      await fs.writeFile(filePath(), bytes);
      const adapter = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.listRequests()).rejects.toBeInstanceOf(StateFileUnreadableError);
      await expectSingleQuarantineCopy(filePath(), bytes);
    });

    it('d. rejects a save over an unreadable file and leaves the original bytes unchanged', async () => {
      const garbage = Buffer.from('{ not valid json', 'utf8');
      await fs.writeFile(filePath(), garbage);
      const before = createHash('sha256').update(await fs.readFile(filePath())).digest('hex');
      const adapter = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
      await expect(adapter.saveRequest(requestRecord())).rejects.toBeInstanceOf(
        StateFileUnreadableError,
      );
      const after = createHash('sha256').update(await fs.readFile(filePath())).digest('hex');
      expect(after).toBe(before);
    });
  });

  describe('describeRecordListStore validateList', () => {
    interface FakeRecord {
      readonly id: string;
    }
    const parseFake = (raw: unknown): FakeRecord | undefined =>
      typeof raw === 'object' && raw !== null && typeof (raw as FakeRecord).id === 'string'
        ? (raw as FakeRecord)
        : undefined;

    it('marks the whole file unreadable with the validateList detail when it returns one', () => {
      const descriptor = describeRecordListStore<FakeRecord>(
        'fake.json',
        parseFake,
        () => 'two fakes share one id',
      );
      const bytes = Buffer.from(JSON.stringify([{ id: 'a' }, { id: 'b' }]), 'utf8');
      expect(descriptor.inspect(bytes)).toEqual({
        status: 'unreadable',
        detail: 'two fakes share one id',
        recordIndex: null,
      });
    });

    it('is ok when validateList returns undefined and behaves as today when it is absent', () => {
      const withValidator = describeRecordListStore<FakeRecord>('fake.json', parseFake, () => undefined);
      const withoutValidator = describeRecordListStore<FakeRecord>('fake.json', parseFake);
      const bytes = Buffer.from(JSON.stringify([{ id: 'a' }, { id: 'b' }]), 'utf8');
      expect(withValidator.inspect(bytes)).toEqual({ status: 'ok', recordCount: 2 });
      expect(withoutValidator.inspect(bytes)).toEqual({ status: 'ok', recordCount: 2 });
    });

    it('does not call validateList when a record fails to parse', () => {
      let calls = 0;
      const descriptor = describeRecordListStore<FakeRecord>('fake.json', parseFake, () => {
        calls += 1;
        return 'two fakes share one id';
      });
      const bytes = Buffer.from(JSON.stringify([{ id: 'a' }, { bogus: true }]), 'utf8');
      expect(descriptor.inspect(bytes)).toEqual({
        status: 'unreadable',
        detail: 'record 1 failed validation',
        recordIndex: 1,
      });
      expect(calls).toBe(0);
    });
  });
});
