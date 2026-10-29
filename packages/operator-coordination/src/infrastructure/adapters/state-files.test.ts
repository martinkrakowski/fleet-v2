import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CoordinationRequestRecord,
  ProjectProfileRecord,
} from '../../domain/coordination-records.js';
import type { OwnerItemRecord } from '../../domain/owner-item-records.js';
import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import type { OrchestratorSessionRecord } from '../../domain/orchestrator-session-records.js';
import { OwnerItem } from '../../domain/entities/OwnerItem.js';
import { AttentionItem } from '../../domain/entities/AttentionItem.js';
import {
  StateFileUnreadableError,
  type StateFileDescriptor,
  type StateFileInspection,
} from './file-store.js';
import { CoordinationRequestRepositoryAdapter } from './CoordinationRequestRepositoryAdapter.adapter.js';
import { AttentionItemRepositoryAdapter } from './AttentionItemRepositoryAdapter.adapter.js';
import { OwnerItemRepositoryAdapter } from './OwnerItemRepositoryAdapter.adapter.js';
import { OrchestratorSessionRepositoryAdapter } from './OrchestratorSessionRepositoryAdapter.adapter.js';
import { OwnerQuestionRepositoryAdapter } from './OwnerQuestionRepositoryAdapter.adapter.js';
import { ProjectProfileRepositoryAdapter } from './ProjectProfileRepositoryAdapter.adapter.js';
import { OPERATOR_COORDINATION_STATE_FILES } from './state-files.js';

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

function sessionRecord(overrides: Partial<OrchestratorSessionRecord> = {}): OrchestratorSessionRecord {
  return {
    orchestratorId: 'orch-example-1',
    cliKind: 'claude-code',
    model: 'example-provider/example-model',
    host: 'example-host',
    projects: ['example-project'],
    claims: ['dispatch-attempt', 'prepare-fix'],
    scopes: ['message', 'orchestrate'],
    registeredByTokenId: 'token-example-1',
    startedAtIso: '2026-10-27T10:00:00.000Z',
    lastHeartbeatIso: '2026-10-27T10:00:30.000Z',
    leaseUntilIso: '2026-10-27T10:02:00.000Z',
    lastPolledRequestsAtIso: null,
    status: 'active',
    ...overrides,
  };
}

const NOW = '2026-10-27T10:00:00.000Z';

/** AttentionItem.raise returns a result; a genuine failure is a test bug. */
function raisedItem(overrides: {
  itemId?: string;
  kind?: string;
  subject?: { kind: 'work-order'; ref: string };
  workOrderId?: string | null;
}): unknown {
  const raised = AttentionItem.raise(
    {
      itemId: overrides.itemId ?? 'att-example-1',
      projectId: 'example-project',
      kind: overrides.kind ?? 'needs-owner',
      subject: overrides.subject ?? { kind: 'work-order', ref: 'wo-example-1' },
      workOrderId: overrides.workOrderId === undefined ? 'wo-example-1' : overrides.workOrderId,
      summary: 'example notice',
      raisedBy: 'example-orchestrator',
    },
    NOW,
  );
  if (!raised.success) {
    throw new Error(raised.error.message);
  }
  return raised.value.toRecord();
}

/** OwnerItem.open returns a result; a genuine failure is a test bug. */
function openedItem(overrides: Partial<OwnerItemRecord> = {}): OwnerItemRecord {
  const opened = OwnerItem.open(
    {
      itemId: 'oi-example-1',
      projectId: 'example-project',
      kind: 'merge',
      subject: null,
      refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 1 }],
      blocks: [],
      createdBy: 'example-orchestrator',
    },
    NOW,
  );
  if (!opened.success) {
    throw new Error(opened.error.message);
  }
  return { ...opened.value.toRecord(), ...overrides };
}

const VALID_FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
  'project-profiles.json': [profileRecord(), { ...profileRecord(), projectId: 'proj-2' }],
  'coordination-requests.json': [requestRecord(), { ...requestRecord(), id: 'req-2' }],
  'owner-questions.json': [questionRecord(), { ...questionRecord(), questionId: 'q-2' }],
  'orchestrators.json': [
    { revision: 1, session: sessionRecord({ orchestratorId: 'orch-example-1' }) },
    { revision: 3, session: sessionRecord({ orchestratorId: 'orch-example-2' }) },
  ],
  'owner-items.json': [
    { revision: 1, item: openedItem() },
    {
      revision: 2,
      item: openedItem({
        itemId: 'oi-example-2',
        refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 2 }],
      }),
    },
  ],
  'attention-items.json': [
    { revision: 1, item: raisedItem({ itemId: 'att-example-1' }) },
    {
      revision: 1,
      item: raisedItem({
        itemId: 'att-example-2',
        subject: { kind: 'work-order', ref: 'wo-example-2' },
        workOrderId: 'wo-example-2',
      }),
    },
  ],
};

const READS: Readonly<Record<string, (stateDir: string) => Promise<unknown>>> = {
  'project-profiles.json': (stateDir) =>
    new ProjectProfileRepositoryAdapter({ stateDir }).listProfiles(),
  'coordination-requests.json': (stateDir) =>
    new CoordinationRequestRepositoryAdapter({ stateDir }).listRequests(),
  'owner-questions.json': (stateDir) => new OwnerQuestionRepositoryAdapter({ stateDir }).list(),
  'orchestrators.json': (stateDir) => new OrchestratorSessionRepositoryAdapter({ stateDir }).list(),
  'owner-items.json': (stateDir) => new OwnerItemRepositoryAdapter({ stateDir }).list(),
  'attention-items.json': (stateDir) => new AttentionItemRepositoryAdapter({ stateDir }).list(),
};

type FixtureKind = 'valid' | 'not-json' | 'not-list' | 'bad-record';

function bytesFor(basename: string, kind: FixtureKind): Buffer {
  if (kind === 'not-json') return Buffer.from('{ not json');
  if (kind === 'not-list') return Buffer.from('{}');
  const first = VALID_FIXTURES[basename]![0];
  if (kind === 'bad-record') {
    return Buffer.from(JSON.stringify([first, { bogus: true }]));
  }
  return Buffer.from(JSON.stringify(VALID_FIXTURES[basename]));
}

const CASES: Array<{
  basename: string;
  kind: FixtureKind;
  inspect: (bytes: Buffer) => StateFileInspection;
  read: (stateDir: string) => Promise<unknown>;
  bytes: Buffer;
  expectedOk: boolean;
}> = [];

for (const descriptor of OPERATOR_COORDINATION_STATE_FILES) {
  const kinds: readonly FixtureKind[] = ['valid', 'not-json', 'not-list', 'bad-record'];
  for (const kind of kinds) {
    const bytes = bytesFor(descriptor.basename, kind);
    CASES.push({
      basename: descriptor.basename,
      kind,
      inspect: (b: Buffer) => descriptor.inspect(b),
      read: READS[descriptor.basename]!,
      bytes,
      expectedOk: kind === 'valid',
    });
  }
}

describe('operator-coordination state file descriptors match the store readers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-state-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it.each(CASES)('$basename / $kind', async ({ basename, bytes, inspect, read, expectedOk }) => {
    await fs.writeFile(path.join(tempDir, basename), bytes);
    const inspection = inspect(bytes);
    const outcome = await read(tempDir).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    if (inspection.status === 'ok') {
      expect(outcome).toBe('resolved');
    } else {
      expect(outcome).toBeInstanceOf(StateFileUnreadableError);
      expect((outcome as StateFileUnreadableError).detail).toBe(inspection.detail);
    }
    expect(expectedOk).toBe(inspection.status === 'ok');
  });

  it('lists exactly the owned state files', () => {
    expect(OPERATOR_COORDINATION_STATE_FILES.map((descriptor: StateFileDescriptor) => descriptor.basename)).toEqual([
      'project-profiles.json',
      'coordination-requests.json',
      'owner-questions.json',
      'orchestrators.json',
      'owner-items.json',
      'attention-items.json',
    ]);
  });

  it('treats a file with two items under one key as unreadable with the one-key detail', async () => {
    const sameKeyTwice = Buffer.from(
      JSON.stringify([
        VALID_FIXTURES['attention-items.json']![0],
        {
          revision: 1,
          item: raisedItem({ itemId: 'att-example-2' }),
        },
      ]),
    );
    const descriptor = OPERATOR_COORDINATION_STATE_FILES.find(
      (entry: StateFileDescriptor) => entry.basename === 'attention-items.json',
    );
    expect(descriptor).toBeDefined();
    const inspection = descriptor!.inspect(sameKeyTwice);
    expect(inspection).toEqual({
      status: 'unreadable',
      detail: 'two attention items share one key or id',
      recordIndex: null,
    });
    await fs.writeFile(path.join(tempDir, 'attention-items.json'), sameKeyTwice);
    const outcome = await new AttentionItemRepositoryAdapter({ stateDir: tempDir })
      .list()
      .then(
        () => 'resolved',
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(StateFileUnreadableError);
    expect((outcome as StateFileUnreadableError).detail).toBe('two attention items share one key or id');
  });
});
