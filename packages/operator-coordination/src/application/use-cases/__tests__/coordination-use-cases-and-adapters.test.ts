/**
 * Step 5 unit tests for the operator-coordination use cases and their
 * infrastructure adapters.
 *
 * The suite covers each of the thirteen inbound use cases against explicit test
 * doubles and against the real adapters, and it exercises the four refusals
 * that carry the safety weight of this context: a profile that would persist a
 * credential, a grant that would authorize a second unrelated action, an
 * observation delivery gap that must stay visible and undelivered, and relay
 * delivery that must never be recorded as a recipient response.
 */

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
  ProjectAttentionSummaryRecord,
  ProjectProbeReceiptRecord,
  ProjectProfileRecord,
  RelayAcknowledgementRecord,
} from '../../../domain/coordination-records.js';
import type { ObservationEnvelopeProps } from '../../../domain/value-objects/ObservationEnvelope.vo.js';
import type {
  InspectConfiguredCapabilitiesRequest,
  ListProjectProfilesRequest,
  RegisterProjectProfileRequest,
  UpdateProjectProfileRequest,
} from '../../ports/in/index.js';
import type { CoordinationRequestRepositoryPort } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { CoordinationRequestRevisionConflictError } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { ProjectProfileRevisionConflictError } from '../../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  DecisionAnswer,
  DecisionAnswerQuery,
  DecisionTransportPort,
} from '../../ports/out/DecisionTransportPort.out-port.js';
import { canonicalDecisionBytes } from '../../../infrastructure/adapters/DecisionSignature.adapter.js';
import type { InstallationReferences } from '../../ports/out/InstallationReferencePort.out-port.js';
import type { ProjectProfileRepositoryPort } from '../../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type { RelayDeliveryOutcome, RelayNoticeRequest } from '../../ports/out/RelayTransportPort.out-port.js';
import { AttentionReadAdapter } from '../../../infrastructure/adapters/AttentionReadAdapter.adapter.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import { InstallationReferenceAdapter } from '../../../infrastructure/adapters/InstallationReferenceAdapter.adapter.js';
import { DecisionTransportAdapter } from '../../../infrastructure/adapters/DecisionTransportAdapter.adapter.js';
import { ObservationPublicationAdapter } from '../../../infrastructure/adapters/ObservationPublicationAdapter.adapter.js';
import { ProjectProfileRepositoryAdapter } from '../../../infrastructure/adapters/ProjectProfileRepositoryAdapter.adapter.js';
import { StateFileUnreadableError } from '../../../infrastructure/adapters/file-store.js';
import { RelayTransportAdapter } from '../../../infrastructure/adapters/RelayTransportAdapter.adapter.js';
import { InspectConfiguredCapabilitiesUseCase } from '../InspectConfiguredCapabilitiesUseCase.use-case.js';
import { InspectOutstandingCoordinationUseCase } from '../InspectOutstandingCoordinationUseCase.use-case.js';
import { InspectProjectProfileUseCase } from '../InspectProjectProfileUseCase.use-case.js';
import { ListProjectProfilesUseCase } from '../ListProjectProfilesUseCase.use-case.js';
import { PublishProjectObservationUseCase } from '../PublishProjectObservationUseCase.use-case.js';
import { ReadProjectAttentionUseCase } from '../ReadProjectAttentionUseCase.use-case.js';
import { RecordAuthorizationConsumptionUseCase } from '../RecordAuthorizationConsumptionUseCase.use-case.js';
import { RecordProjectProbeUseCase } from '../RecordProjectProbeUseCase.use-case.js';
import { RecordRelayAcknowledgementUseCase } from '../RecordRelayAcknowledgementUseCase.use-case.js';
import { RegisterProjectProfileUseCase } from '../RegisterProjectProfileUseCase.use-case.js';
import { RequestScopedDecisionUseCase } from '../RequestScopedDecisionUseCase.use-case.js';
import { RetireProjectProfileUseCase } from '../RetireProjectProfileUseCase.use-case.js';
import { UpdateProjectProfileUseCase } from '../UpdateProjectProfileUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../ResolveActionAuthorizationUseCase.use-case.js';
import { SendFleetRelayUseCase } from '../SendFleetRelayUseCase.use-case.js';

const NOW_ISO = '2026-10-15T09:00:00.000Z';
const LATER_ISO = '2026-10-15T10:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Record factories
 * ------------------------------------------------------------------ */

function profileRecord(overrides: Partial<ProjectProfileRecord> = {}): ProjectProfileRecord {
  return {
    projectId: 'project-atlas',
    displayName: 'Atlas',
    repository: 'atlas/repo',
    designatedDispatcherHost: 'dispatcher-01',
    policyRevision: 'policy-7',
    maxConcurrentLanes: 3,
    runnerCapabilities: { 'openai/gpt-5': true, 'local/vllm': false, s3: 'configured-unknown' },
    revision: 0,
    updatedAtIso: NOW_ISO,
    status: 'active',
    defaultBranch: null,
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
    ...overrides,
  };
}

function consumptionRecord(
  overrides: Partial<AuthorizationConsumptionRecord> = {},
): AuthorizationConsumptionRecord {
  return {
    consumptionId: 'consumption-1',
    grantId: 'grant-9',
    requestId: 'request-1',
    actionId: 'action-1',
    attemptId: 'attempt-1',
    expectedHeadSha: 'abc123',
    consumedAtIso: LATER_ISO,
    ...overrides,
  };
}

function acknowledgementRecord(
  overrides: Partial<RelayAcknowledgementRecord> = {},
): RelayAcknowledgementRecord {
  return {
    acknowledgementId: 'ack-1',
    requestId: 'request-1',
    recipientId: 'fleet-master',
    responseSummary: 'received and triaged',
    provenance: 'waves-inbox-reply',
    acknowledgedAtIso: LATER_ISO,
    ...overrides,
  };
}

function requestRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return {
    id: 'request-1',
    projectId: 'project-atlas',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge',
    expectedHeadSha: 'abc123',
    proposalDigest: 'digest-1',
    policyRevision: 'policy-7',
    decisionRevision: 'decision-3',
    grantId: 'grant-9',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW_ISO,
    updatedAtIso: NOW_ISO,
    ...overrides,
  };
}

function envelope(overrides: Partial<ObservationEnvelopeProps> = {}): ObservationEnvelopeProps {
  return {
    observationId: 'observation-1',
    projectId: 'project-atlas',
    eventKind: 'attempt.completed',
    sourceAttemptId: 'attempt-1',
    payloadSummary: 'attempt finished; head commit collected',
    recordedAtIso: NOW_ISO,
    ...overrides,
  };
}

function attentionSummary(
  overrides: Partial<ProjectAttentionSummaryRecord> = {},
): ProjectAttentionSummaryRecord {
  return {
    projectId: 'project-atlas',
    staleWorkOrderCount: 1,
    awaitingDecisionCount: 2,
    deliveryGapCount: 0,
    summaryText: 'one stale work order; two proposals awaiting a decision',
    observedAtIso: NOW_ISO,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Test doubles
 * ------------------------------------------------------------------ */

class StubProfileRepository implements ProjectProfileRepositoryPort {
  readonly saves: ProjectProfileRecord[] = [];

  constructor(private readonly profiles: Readonly<Record<string, ProjectProfileRecord>> = {}) {}

  async saveProfile(record: ProjectProfileRecord): Promise<void> {
    this.saves.push(record);
  }

  async findProfileById(projectId: string): Promise<ProjectProfileRecord | null> {
    return this.profiles[projectId] ?? null;
  }

  async listProfiles(): Promise<readonly ProjectProfileRecord[]> {
    return Object.values(this.profiles).sort((left, right) =>
      left.projectId.localeCompare(right.projectId),
    );
  }
}

class StubRequestRepository implements CoordinationRequestRepositoryPort {
  readonly saves: CoordinationRequestRecord[] = [];
  readonly requests = new Map<string, CoordinationRequestRecord>();

  constructor(seed: readonly CoordinationRequestRecord[] = []) {
    for (const record of seed) {
      this.requests.set(record.id, record);
    }
  }

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.saves.push(record);
    this.requests.set(record.id, record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const record of this.requests.values()) {
      if (record.grantId === grantId) {
        return record;
      }
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    return [...this.requests.values()].filter(
      (record) => projectId === undefined || record.projectId === projectId,
    );
  }
}

class StubDecisionTransport implements DecisionTransportPort {
  readonly reads: string[] = [];

  constructor(private readonly answers: Readonly<Record<string, DecisionAnswer>> = {}) {}

  async readDecisionAnswer(query: DecisionAnswerQuery): Promise<DecisionAnswer> {
    this.reads.push(query.requestId);
    return (
      this.answers[query.requestId] ?? {
        state: 'awaiting-decision' as const,
        decisionRevision: null,
        grantId: null,
      }
    );
  }
}

class StubRelayTransport {
  readonly notices: RelayNoticeRequest[] = [];

  constructor(private readonly receipts: Readonly<Record<string, RelayDeliveryOutcome>> = {}) {}

  async deliverRelayNotice(request: RelayNoticeRequest): Promise<RelayDeliveryOutcome> {
    this.notices.push(request);
    return this.receipts[request.requestId] ?? { outcome: 'delivered' };
  }
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-coordination-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Use case 1: RegisterProjectProfileUseCase
 * ------------------------------------------------------------------ */

describe('RegisterProjectProfileUseCase', () => {
  const validRequest: RegisterProjectProfileRequest = {
    projectId: 'project-atlas',
    displayName: 'Atlas',
    repository: 'atlas/repo',
    designatedDispatcherHost: 'dispatcher-01',
    policyRevision: 'policy-7',
    maxConcurrentLanes: 3,
    runnerCapabilities: { 'openai/gpt-5': true, 'local/vllm': false },
    nowIso: NOW_ISO,
  };

  it('records a valid installation profile without any credential value', async () => {
    const repo = new StubProfileRepository();
    const result = await new RegisterProjectProfileUseCase({ profileRepo: repo }).execute(
      validRequest,
    );
    expect(result.outcome).toBe('registered');
    if (result.outcome !== 'registered') {
      throw new Error('expected a registered profile');
    }
    expect(result.profile.designatedDispatcherHost).toBe('dispatcher-01');
    expect(result.profile.revision).toBe(0);
    expect(result.profile.updatedAtIso).toBe(NOW_ISO);
    expect(result.profile.status).toBe('active');
    expect(result.profile.defaultBranch).toBeNull();
    expect(result.profile.clones).toEqual({});
    expect(result.profile.gateProcedures).toEqual([]);
    expect(result.profile.defaultAllowedPathPrefixes).toEqual([]);
    expect(result.profile.lastProbe).toBeNull();
    expect(repo.saves).toHaveLength(1);
    expect(Object.keys(result.profile.runnerCapabilities)).toEqual(['openai/gpt-5', 'local/vllm']);
  });

  it('refuses a profile whose id is already registered', async () => {
    const repo = new StubProfileRepository({
      'project-atlas': profileRecord({ revision: 4, updatedAtIso: LATER_ISO }),
    });
    const result = await new RegisterProjectProfileUseCase({ profileRepo: repo }).execute(
      validRequest,
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is already registered; edit it with update',
    });
  });

  it('looks up an existing profile with the trimmed projectId and refuses a second registration', async () => {
    const repo = new ProjectProfileRepositoryAdapter();
    const useCase = new RegisterProjectProfileUseCase({ profileRepo: repo });
    const first = await useCase.execute({ ...validRequest, projectId: 'atlas' });
    expect(first.outcome).toBe('registered');
    const second = await useCase.execute({
      ...validRequest,
      projectId: ' atlas ',
      displayName: 'Atlas Updated',
      nowIso: LATER_ISO,
    });
    expect(second).toEqual({
      outcome: 'rejected',
      reason: 'project atlas is already registered; edit it with update',
    });
  });

  it('turns two concurrent registrations of the same new id into one registered and one rejected', async () => {
    const repo = new ProjectProfileRepositoryAdapter();
    const useCase = new RegisterProjectProfileUseCase({ profileRepo: repo });
    const firstPromise = useCase.execute({ ...validRequest, projectId: 'atlas' });
    const secondPromise = useCase.execute({ ...validRequest, projectId: 'atlas' });
    const outcomes = await Promise.all([firstPromise, secondPromise]);
    const registered = outcomes.filter((result) => result.outcome === 'registered');
    const rejected = outcomes.filter((result) => result.outcome === 'rejected');
    expect(registered).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toEqual({
      outcome: 'rejected',
      reason: 'profile atlas changed while it was being written; read it again and retry',
    });
  });

  it('propagates a saveProfile error that is not a ProjectProfileRevisionConflictError', async () => {
    class FailingProfileRepository implements ProjectProfileRepositoryPort {
      async saveProfile(): Promise<void> {
        throw new Error('ProjectProfileRepositoryAdapter could not write the store');
      }
      async findProfileById(): Promise<ProjectProfileRecord | null> {
        return null;
      }
      async listProfiles(): Promise<readonly ProjectProfileRecord[]> {
        return [];
      }
    }
    await expect(
      new RegisterProjectProfileUseCase({ profileRepo: new FailingProfileRepository() }).execute(
        validRequest,
      ),
    ).rejects.toThrow('ProjectProfileRepositoryAdapter could not write the store');
  });

  it('keeps stored clones and the last probe when an edit does not touch repository or clones', async () => {
    const seeded = profileRecord({
      revision: 1,
      clones: { host1: { path: '/srv/clone', worktreeRoot: '/srv/wt' } },
      lastProbe: {
        probedAtIso: LATER_ISO,
        probedFrom: 'host-1',
        checks: [{ name: 'git-fetch', host: 'host-1', result: 'pass', detail: 'ok' }],
      },
    });
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new UpdateProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 1,
      changes: { displayName: 'Atlas' },
    });
    expect(result.outcome).toBe('updated');
    if (result.outcome !== 'updated') {
      throw new Error('expected an updated profile');
    }
    expect(result.profile.revision).toBe(2);
    expect(result.profile.clones).toEqual(seeded.clones);
    expect(result.profile.lastProbe).toEqual(seeded.lastProbe);
    expect(result.profile.status).toBe('active');
  });

  it('refuses a runner capability or field that would persist a credential', async () => {
    const repo = new StubProfileRepository();
    const useCase = new RegisterProjectProfileUseCase({ profileRepo: repo });
    const capability = await useCase.execute({
      ...validRequest,
      runnerCapabilities: { 'openai/gpt-5': true, providerApiKey: 'never-persisted' },
    });
    expect(capability.outcome).toBe('rejected');
    expect(capability.outcome === 'rejected' && capability.reason).toContain('providerApiKey');

    for (const credentialName of ['secretKey', 'dbPassword', 'wavesToken']) {
      const rejected = await useCase.execute({
        ...validRequest,
        runnerCapabilities: { [credentialName]: 'never-persisted' },
      });
      expect(rejected.outcome).toBe('rejected');
      expect(rejected.outcome === 'rejected' && rejected.reason).toContain(credentialName);
    }

    const field = await useCase.execute({
      ...validRequest,
      deploymentSecret: 'never-persisted',
    } as unknown as RegisterProjectProfileRequest);
    expect(field.outcome).toBe('rejected');
    expect(field.outcome === 'rejected' && field.reason).toContain('deploymentSecret');
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses a profile that cannot dispatch or bound lanes', async () => {
    const repo = new StubProfileRepository();
    const useCase = new RegisterProjectProfileUseCase({ profileRepo: repo });
    const noHost = await useCase.execute({ ...validRequest, designatedDispatcherHost: '  ' });
    expect(noHost.outcome === 'rejected' && noHost.reason).toContain('designatedDispatcherHost');
    const noLanes = await useCase.execute({ ...validRequest, maxConcurrentLanes: 0 });
    expect(noLanes.outcome === 'rejected' && noLanes.reason).toContain('maxConcurrentLanes');
    const noPolicy = await useCase.execute({ ...validRequest, policyRevision: '' });
    expect(noPolicy.outcome === 'rejected' && noPolicy.reason).toContain('policyRevision');
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses to run without dependencies or a request', async () => {
    await expect(
      new RegisterProjectProfileUseCase().execute(validRequest),
    ).rejects.toThrow('Not implemented: RegisterProjectProfileUseCase');
    const result = await new RegisterProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute(undefined);
    expect(result).toEqual({ outcome: 'rejected', reason: 'request must be an object' });
  });

  it('stores v2 fields supplied on the request', async () => {
    const repo = new StubProfileRepository();
    const result = await new RegisterProjectProfileUseCase({ profileRepo: repo }).execute({
      ...validRequest,
      defaultBranch: 'main',
      clones: { host1: { path: '/srv/clone', worktreeRoot: '/srv/wt' } },
      gateProcedures: ['verify-merge'],
      defaultAllowedPathPrefixes: ['src/'],
    });
    expect(result.outcome).toBe('registered');
    if (result.outcome !== 'registered') {
      throw new Error('expected a registered profile');
    }
    expect(result.profile.defaultBranch).toBe('main');
    expect(result.profile.clones).toEqual({
      host1: { path: '/srv/clone', worktreeRoot: '/srv/wt' },
    });
    expect(result.profile.gateProcedures).toEqual(['verify-merge']);
    expect(result.profile.defaultAllowedPathPrefixes).toEqual(['src/']);
    expect(result.profile.revision).toBe(0);
    expect(result.profile.lastProbe).toBeNull();
  });

  it('refuses a request that tries to set status, lastProbe or revision', async () => {
    const repo = new StubProfileRepository();
    const useCase = new RegisterProjectProfileUseCase({ profileRepo: repo });
    for (const key of ['status', 'lastProbe', 'revision'] as const) {
      const result = await useCase.execute({
        ...validRequest,
        [key]: key === 'status' ? 'retired' : key === 'revision' ? 3 : null,
      } as unknown as RegisterProjectProfileRequest);
      expect(result.outcome).toBe('rejected');
      expect(result.outcome === 'rejected' && result.reason).toBe(`${key} cannot be set by registration`);
    }
    expect(repo.saves).toHaveLength(0);
  });

  it('skips installation name checks when no installation references are injected', async () => {
    const repo = new StubProfileRepository();
    const result = await new RegisterProjectProfileUseCase({ profileRepo: repo }).execute({
      ...validRequest,
      designatedDispatcherHost: 'not-in-any-installation',
    });
    expect(result.outcome).toBe('registered');
  });

  it('refuses when the loaded installation is null', async () => {
    const repo = new StubProfileRepository();
    const result = await new RegisterProjectProfileUseCase({
      profileRepo: repo,
      installationRefs: new InstallationReferenceAdapter(null),
    }).execute(validRequest);
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'no installation is loaded to check host and procedure names against',
    });
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses host and procedure names the installation does not have', async () => {
    const repo = new StubProfileRepository();
    const useCase = new RegisterProjectProfileUseCase({
      profileRepo: repo,
      installationRefs: new InstallationReferenceAdapter({
        hostNames: ['dispatcher-01', 'worker-01'],
        procedureNames: ['verify-merge'],
      }),
    });

    const badDispatcher = await useCase.execute({
      ...validRequest,
      designatedDispatcherHost: 'ghost-host',
    });
    expect(badDispatcher).toEqual({
      outcome: 'rejected',
      reason: 'designatedDispatcherHost ghost-host is not a host in the installation',
    });

    const badClone = await useCase.execute({
      ...validRequest,
      clones: {
        zhost: { path: '/srv/z', worktreeRoot: '/srv/wt-z' },
        ahost: { path: '/srv/a', worktreeRoot: '/srv/wt-a' },
      },
    });
    expect(badClone).toEqual({
      outcome: 'rejected',
      reason: 'clone host ahost is not a host in the installation',
    });

    const badProcedure = await useCase.execute({
      ...validRequest,
      gateProcedures: ['verify-merge', 'unlisted-procedure'],
    });
    expect(badProcedure).toEqual({
      outcome: 'rejected',
      reason: 'gate procedure unlisted-procedure is not a verification procedure in the installation',
    });

    expect(repo.saves).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Use case 1b: UpdateProjectProfileUseCase
 * ------------------------------------------------------------------ */

describe('UpdateProjectProfileUseCase', () => {
  const validChange = { displayName: 'Atlas Updated' };

  it('updates an active profile at the expected revision', async () => {
    const seeded = profileRecord({ revision: 2 });
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new UpdateProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 2,
      changes: validChange,
      nowIso: LATER_ISO,
    });
    expect(result.outcome).toBe('updated');
    if (result.outcome !== 'updated') {
      throw new Error('expected an updated profile');
    }
    expect(result.profile.revision).toBe(3);
    expect(result.profile.displayName).toBe('Atlas Updated');
    expect(result.profile.updatedAtIso).toBe(LATER_ISO);
    expect(result.profile.status).toBe('active');
    expect(repo.saves).toHaveLength(1);
    expect(repo.saves[0].revision).toBe(3);
  });

  it('trims string changes as registration does', async () => {
    const repo = new StubProfileRepository({
      'project-atlas': profileRecord({ revision: 0, designatedDispatcherHost: 'old-host' }),
    });
    const result = await new UpdateProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: {
        displayName: ' Atlas Trimmed ',
        repository: ' atlas/repo ',
        designatedDispatcherHost: ' dispatcher-01',
        policyRevision: ' policy-8 ',
        defaultBranch: ' main ',
        gateProcedures: [' verify-merge '],
        defaultAllowedPathPrefixes: [' src/ '],
      },
      nowIso: LATER_ISO,
    });
    expect(result.outcome).toBe('updated');
    if (result.outcome !== 'updated') {
      throw new Error('expected an updated profile');
    }
    expect(result.profile.displayName).toBe('Atlas Trimmed');
    expect(result.profile.repository).toBe('atlas/repo');
    expect(result.profile.designatedDispatcherHost).toBe('dispatcher-01');
    expect(result.profile.policyRevision).toBe('policy-8');
    expect(result.profile.defaultBranch).toBe('main');
    expect(result.profile.gateProcedures).toEqual(['verify-merge']);
    expect(result.profile.defaultAllowedPathPrefixes).toEqual(['src/']);
    expect(result.profile.updatedAtIso).toBe(LATER_ISO);
  });

  it('refuses a missing, retired or stale profile', async () => {
    const missing = await new UpdateProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute({ projectId: 'project-atlas', expectedRevision: 0, changes: validChange });
    expect(missing).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is not registered',
    });

    const retired = await new UpdateProjectProfileUseCase({
      profileRepo: new StubProfileRepository({
        'project-atlas': profileRecord({ status: 'retired', revision: 1 }),
      }),
    }).execute({ projectId: 'project-atlas', expectedRevision: 1, changes: validChange });
    expect(retired).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is retired; a retired profile is not edited',
    });

    const stale = await new UpdateProjectProfileUseCase({
      profileRepo: new StubProfileRepository({ 'project-atlas': profileRecord({ revision: 0 }) }),
    }).execute({ projectId: 'project-atlas', expectedRevision: 2, changes: validChange });
    expect(stale).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is at revision 0, not 2; read it again',
    });
  });

  it('refuses a non-negative-integer expectedRevision', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const useCase = new UpdateProjectProfileUseCase({ profileRepo: repo });
    for (const expectedRevision of [-1, 1.5]) {
      const result = await useCase.execute({
        projectId: 'project-atlas',
        expectedRevision,
        changes: validChange,
      });
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'expectedRevision must be a non-negative integer',
      });
    }
  });

  it('refuses empty or forbidden changes', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const useCase = new UpdateProjectProfileUseCase({ profileRepo: repo });
    const empty = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: {},
    });
    expect(empty).toEqual({ outcome: 'rejected', reason: 'changes must name at least one field' });

    for (const key of ['status', 'lastProbe', 'revision', 'projectId', 'bogus', 'apiToken']) {
      const result = await useCase.execute({
        projectId: 'project-atlas',
        expectedRevision: 0,
        changes: { [key]: 'anything' },
      } as unknown as UpdateProjectProfileRequest);
      expect(result).toEqual({
        outcome: 'rejected',
        reason: `change ${key} is not allowed`,
      });
    }
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses any change whose value is undefined with nothing saved', async () => {
    const repo = new StubProfileRepository({
      'project-atlas': profileRecord({
        defaultBranch: 'main',
        clones: { host1: { path: '/srv/clone', worktreeRoot: '/srv/wt' } },
        gateProcedures: ['verify-merge'],
      }),
    });
    const useCase = new UpdateProjectProfileUseCase({ profileRepo: repo });
    for (const [key, changes] of [
      ['clones', { clones: undefined }],
      ['gateProcedures', { gateProcedures: undefined }],
      ['defaultBranch', { defaultBranch: undefined }],
    ] as const) {
      const result = await useCase.execute({
        projectId: 'project-atlas',
        expectedRevision: 0,
        changes,
      });
      expect(result).toEqual({
        outcome: 'rejected',
        reason: `change ${key} has no value`,
      });
    }
    expect(repo.saves).toHaveLength(0);
  });

  it('clears the last probe when the repository or clones change and keeps it otherwise', async () => {
    const probe: ProjectProbeReceiptRecord = {
      probedAtIso: LATER_ISO,
      probedFrom: 'host-1',
      checks: [{ name: 'git-fetch', host: 'host-1', result: 'pass', detail: 'ok' }],
    };
    const repo = new ProjectProfileRepositoryAdapter();
    await repo.saveProfile(
      profileRecord({ revision: 0, repository: 'atlas/repo', lastProbe: probe }),
    );
    const useCase = new UpdateProjectProfileUseCase({ profileRepo: repo });

    const renamed = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { displayName: 'Atlas Renamed' },
    });
    expect(renamed.outcome === 'updated' && renamed.profile.lastProbe).toEqual(probe);

    const moved = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 1,
      changes: { repository: 'atlas/repo-v2' },
    });
    expect(moved.outcome === 'updated' && moved.profile.lastProbe).toBeNull();

    // A clones change must clear the probe on its own: start from a fresh
    // profile that still carries a probe, so the repository leg above cannot
    // have cleared it already.
    const repo2 = new ProjectProfileRepositoryAdapter();
    await repo2.saveProfile(profileRecord({ revision: 0, lastProbe: probe }));
    const recloned = await new UpdateProjectProfileUseCase({ profileRepo: repo2 }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { clones: { host1: { path: '/srv/clone', worktreeRoot: '/srv/wt' } } },
    });
    expect(recloned.outcome).toBe('updated');
    expect(recloned.outcome === 'updated' && recloned.profile.lastProbe).toBeNull();
  });

  it('refuses credential-shaped nested keys through the entity with nothing saved', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const useCase = new UpdateProjectProfileUseCase({ profileRepo: repo });
    const capability = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { runnerCapabilities: { apiToken: true } },
    });
    expect(capability.outcome).toBe('rejected');
    expect(capability.outcome === 'rejected' && capability.reason).toContain(
      'must not carry a credential capability',
    );
    const clone = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { clones: { access_key: { path: '/srv/clone', worktreeRoot: '/srv/wt' } } },
    });
    expect(clone.outcome).toBe('rejected');
    expect(clone.outcome === 'rejected' && clone.reason).toContain(
      'clone host name is invalid: access_key',
    );
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses an invalid clone path through the entity with nothing saved', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const result = await new UpdateProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { clones: { host1: { path: 'relative/path', worktreeRoot: '/srv/wt' } } },
    });
    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain(
      'ProjectProfile clone host1 requires normalised absolute paths',
    );
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses host and procedure names the installation does not have', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const useCase = new UpdateProjectProfileUseCase({
      profileRepo: repo,
      installationRefs: new InstallationReferenceAdapter({
        hostNames: ['dispatcher-01', 'worker-01'],
        procedureNames: ['verify-merge'],
      }),
    });

    const badDispatcher = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { designatedDispatcherHost: 'ghost-host' },
    });
    expect(badDispatcher).toEqual({
      outcome: 'rejected',
      reason: 'designatedDispatcherHost ghost-host is not a host in the installation',
    });

    const badClone = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: {
        clones: {
          zhost: { path: '/srv/z', worktreeRoot: '/srv/wt-z' },
          ahost: { path: '/srv/a', worktreeRoot: '/srv/wt-a' },
        },
      },
    });
    expect(badClone).toEqual({
      outcome: 'rejected',
      reason: 'clone host ahost is not a host in the installation',
    });

    const badProcedure = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { gateProcedures: ['verify-merge', 'unlisted-procedure'] },
    });
    expect(badProcedure).toEqual({
      outcome: 'rejected',
      reason: 'gate procedure unlisted-procedure is not a verification procedure in the installation',
    });

    expect(repo.saves).toHaveLength(0);
  });

  it('re-checks the whole merged profile against the installation and allows repairing a removed clone host', async () => {
    const repo = new StubProfileRepository({
      'project-atlas': profileRecord({
        revision: 0,
        clones: { 'worker-01': { path: '/srv/clone', worktreeRoot: '/srv/wt' } },
      }),
    });
    const useCase = new UpdateProjectProfileUseCase({
      profileRepo: repo,
      installationRefs: new InstallationReferenceAdapter({
        hostNames: ['dispatcher-01', 'worker-02'],
        procedureNames: ['verify-merge'],
      }),
    });

    const unfixed = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { displayName: 'x' },
      nowIso: LATER_ISO,
    });
    expect(unfixed).toEqual({
      outcome: 'rejected',
      reason: 'clone host worker-01 is not a host in the installation',
    });
    expect(repo.saves).toHaveLength(0);

    const repaired = await useCase.execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: {
        displayName: 'x',
        clones: { 'worker-02': { path: '/srv/clone', worktreeRoot: '/srv/wt' } },
      },
      nowIso: LATER_ISO,
    });
    expect(repaired.outcome).toBe('updated');
    if (repaired.outcome !== 'updated') {
      throw new Error('expected an updated profile');
    }
    expect(repaired.profile.displayName).toBe('x');
    expect(repaired.profile.clones).toEqual({
      'worker-02': { path: '/srv/clone', worktreeRoot: '/srv/wt' },
    });
    expect(repaired.profile.updatedAtIso).toBe(LATER_ISO);
  });

  it('refuses when no installation is loaded', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const result = await new UpdateProjectProfileUseCase({
      profileRepo: repo,
      installationRefs: new InstallationReferenceAdapter(null),
    }).execute({ projectId: 'project-atlas', expectedRevision: 0, changes: validChange });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'no installation is loaded to check host and procedure names against',
    });
    expect(repo.saves).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Use case 1c: RetireProjectProfileUseCase
 * ------------------------------------------------------------------ */

describe('RetireProjectProfileUseCase', () => {
  it('retires an active profile at the expected revision', async () => {
    const seeded = profileRecord({ revision: 1, displayName: 'Atlas' });
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new RetireProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 1,
      nowIso: LATER_ISO,
    });
    expect(result.outcome).toBe('retired');
    if (result.outcome !== 'retired') {
      throw new Error('expected a retired profile');
    }
    expect(result.profile.status).toBe('retired');
    expect(result.profile.revision).toBe(2);
    expect(result.profile.displayName).toBe('Atlas');
    expect(result.profile.updatedAtIso).toBe(LATER_ISO);
    expect(repo.saves).toHaveLength(1);
  });

  it('refuses an already retired profile', async () => {
    const repo = new StubProfileRepository({
      'project-atlas': profileRecord({ status: 'retired', revision: 4 }),
    });
    const result = await new RetireProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 4,
    });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is already retired',
    });
  });

  it('refuses a missing profile and a stale revision', async () => {
    const missing = await new RetireProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute({ projectId: 'project-atlas', expectedRevision: 0 });
    expect(missing).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is not registered',
    });

    const stale = await new RetireProjectProfileUseCase({
      profileRepo: new StubProfileRepository({ 'project-atlas': profileRecord({ revision: 0 }) }),
    }).execute({ projectId: 'project-atlas', expectedRevision: 3 });
    expect(stale).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas is at revision 0, not 3; read it again',
    });
  });

  it('settles a concurrent update and retire on the same revision to one winner', async () => {
    const repo = new ProjectProfileRepositoryAdapter();
    await repo.saveProfile(profileRecord({ revision: 0 }));
    const updatePromise = new UpdateProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      changes: { displayName: 'Concurrent' },
    });
    const retirePromise = new RetireProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
    });
    const outcomes = await Promise.all([updatePromise, retirePromise]);
    const winners = outcomes.filter(
      (result) => result.outcome === 'updated' || result.outcome === 'retired',
    );
    const rejected = outcomes.filter((result) => result.outcome === 'rejected');
    expect(winners).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toEqual({
      outcome: 'rejected',
      reason: 'profile project-atlas changed while it was being written; read it again and retry',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Use case 2: ListProjectProfilesUseCase
 * ------------------------------------------------------------------ */

describe('ListProjectProfilesUseCase', () => {
  const activeAtlas = profileRecord();
  const retiredBorealis = profileRecord({
    projectId: 'project-borealis',
    displayName: 'Borealis',
    status: 'retired',
    revision: 1,
  });
  const activeCygnus = profileRecord({
    projectId: 'project-cygnus',
    displayName: 'Cygnus',
  });

  class CountingProfileRepository extends StubProfileRepository {
    listCalls = 0;

    async listProfiles(): Promise<readonly ProjectProfileRecord[]> {
      this.listCalls += 1;
      return super.listProfiles();
    }
  }

  it('lists every profile sorted by projectId with one repo read and no save', async () => {
    const repo = new CountingProfileRepository({
      'project-cygnus': activeCygnus,
      'project-atlas': activeAtlas,
      'project-borealis': retiredBorealis,
    });
    const result = await new ListProjectProfilesUseCase({ profileRepo: repo }).execute({});
    expect(result).toEqual({
      outcome: 'listed',
      profiles: [activeAtlas, retiredBorealis, activeCygnus],
    });
    expect(repo.listCalls).toBe(1);
    expect(repo.saves).toHaveLength(0);
  });

  it('filters to active profiles only', async () => {
    const repo = new CountingProfileRepository({
      'project-cygnus': activeCygnus,
      'project-atlas': activeAtlas,
      'project-borealis': retiredBorealis,
    });
    const result = await new ListProjectProfilesUseCase({ profileRepo: repo }).execute({
      status: 'active',
    });
    expect(result).toEqual({ outcome: 'listed', profiles: [activeAtlas, activeCygnus] });
  });

  it('filters to retired profiles only', async () => {
    const repo = new CountingProfileRepository({
      'project-cygnus': activeCygnus,
      'project-atlas': activeAtlas,
      'project-borealis': retiredBorealis,
    });
    const result = await new ListProjectProfilesUseCase({ profileRepo: repo }).execute({
      status: 'retired',
    });
    expect(result).toEqual({ outcome: 'listed', profiles: [retiredBorealis] });
  });

  it('refuses a status that is not active or retired without reading the repo', async () => {
    const repo = new CountingProfileRepository({ 'project-atlas': activeAtlas });
    const result = await new ListProjectProfilesUseCase({ profileRepo: repo }).execute({
      status: 'archived',
    } as unknown as ListProjectProfilesRequest);
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'status must be active or retired',
    });
    expect(repo.listCalls).toBe(0);
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses to run without dependencies or a request object', async () => {
    await expect(
      new ListProjectProfilesUseCase().execute({}),
    ).rejects.toThrow('Not implemented: ListProjectProfilesUseCase');
    const result = await new ListProjectProfilesUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute(undefined);
    expect(result).toEqual({ outcome: 'rejected', reason: 'request must be an object' });
  });
});

/* ------------------------------------------------------------------ *
 * Use case 3: InspectProjectProfileUseCase
 * ------------------------------------------------------------------ */

describe('InspectProjectProfileUseCase', () => {
  const seeded = profileRecord();

  it('returns a stored profile as found', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new InspectProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
    });
    expect(result).toEqual({ outcome: 'found', profile: seeded });
  });

  it('reports a known absence as not-found', async () => {
    const result = await new InspectProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute({ projectId: 'project-unknown' });
    expect(result).toEqual({ outcome: 'not-found', projectId: 'project-unknown' });
  });

  it('refuses a blank projectId', async () => {
    const result = await new InspectProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute({ projectId: '   ' });
    expect(result).toEqual({ outcome: 'rejected', reason: 'projectId is required' });
  });

  it('finds a profile when the projectId is surrounded by whitespace', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new InspectProjectProfileUseCase({ profileRepo: repo }).execute({
      projectId: '  project-atlas ',
    });
    expect(result).toEqual({ outcome: 'found', profile: seeded });
  });

  it('refuses to run without dependencies or a request object', async () => {
    await expect(
      new InspectProjectProfileUseCase().execute({ projectId: 'project-atlas' }),
    ).rejects.toThrow('Not implemented: InspectProjectProfileUseCase');
    const result = await new InspectProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute(undefined);
    expect(result).toEqual({ outcome: 'rejected', reason: 'request must be an object' });
  });
});

/* ------------------------------------------------------------------ *
 * Use case 4: RecordProjectProbeUseCase
 * ------------------------------------------------------------------ */

describe('RecordProjectProbeUseCase', () => {
  const receipt: ProjectProbeReceiptRecord = {
    probedAtIso: LATER_ISO,
    probedFrom: 'host-1',
    checks: [{ name: 'git-fetch', host: 'host-1', result: 'pass', detail: 'ok' }],
  };

  it('records a probe receipt, replacing only lastProbe and bumping the revision', async () => {
    const seeded = profileRecord({ revision: 4 });
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new RecordProjectProbeUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 4,
      receipt,
    });
    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected a recorded probe');
    }
    expect(result.profile).toEqual({ ...seeded, lastProbe: receipt, revision: 5 });
    expect(repo.saves).toEqual([result.profile]);
  });

  it('refuses an unregistered project', async () => {
    const repo = new StubProfileRepository();
    const result = await new RecordProjectProbeUseCase({ profileRepo: repo }).execute({
      projectId: 'project-unknown',
      expectedRevision: 0,
      receipt,
    });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'project project-unknown is not registered',
    });
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses a retired project', async () => {
    const seeded = profileRecord({ status: 'retired' });
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new RecordProjectProbeUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      receipt,
    });
    expect(result).toEqual({ outcome: 'rejected', reason: 'project project-atlas is retired' });
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses an expectedRevision that is not a non-negative integer', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const badRevisions: unknown[] = [-1, 1.5, NaN, '0'];
    for (const bad of badRevisions) {
      const result = await new RecordProjectProbeUseCase({ profileRepo: repo }).execute({
        projectId: 'project-atlas',
        expectedRevision: bad as number,
        receipt,
      });
      expect(result.outcome).toBe('rejected');
      expect(result.outcome === 'rejected' && result.reason).toContain('expectedRevision');
    }
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses a probe whose stored revision moved on', async () => {
    const seeded = profileRecord({ revision: 2 });
    const repo = new StubProfileRepository({ 'project-atlas': seeded });
    const result = await new RecordProjectProbeUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 1,
      receipt,
    });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'project project-atlas changed since the probe started (revision 2, probe read 1); probe again',
    });
    expect(repo.saves).toHaveLength(0);
  });

  it('refuses a receipt with a credential-shaped extra key and saves nothing', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const result = await new RecordProjectProbeUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
      expectedRevision: 0,
      receipt: { ...receipt, wavesApiToken: 'never-persisted' },
    });
    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain('lastProbe');
    expect(repo.saves).toHaveLength(0);
  });

  it('records one of two concurrent probes on the same revision and rejects the other', async () => {
    const store = new ProjectProfileRepositoryAdapter();
    await store.saveProfile(profileRecord({ revision: 0 }));
    const useCase = new RecordProjectProbeUseCase({ profileRepo: store });
    const outcomes = await Promise.all([
      useCase.execute({
        projectId: 'project-atlas',
        expectedRevision: 0,
        receipt: { ...receipt, probedAtIso: NOW_ISO },
      }),
      useCase.execute({
        projectId: 'project-atlas',
        expectedRevision: 0,
        receipt: { ...receipt, probedAtIso: LATER_ISO },
      }),
    ]);
    const recorded = outcomes.filter((result) => result.outcome === 'recorded');
    const rejected = outcomes.filter((result) => result.outcome === 'rejected');
    expect(recorded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const stored = await store.findProfileById('project-atlas');
    expect(stored?.revision).toBe(1);
    expect(stored?.lastProbe).not.toBeNull();
  });

  it('refuses to run without dependencies or a request object', async () => {
    await expect(
      new RecordProjectProbeUseCase().execute({
        projectId: 'project-atlas',
        expectedRevision: 0,
        receipt,
      }),
    ).rejects.toThrow('Not implemented: RecordProjectProbeUseCase');
    const result = await new RecordProjectProbeUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute(undefined);
    expect(result).toEqual({ outcome: 'rejected', reason: 'request must be an object' });
  });
});

/* ------------------------------------------------------------------ *
 * Use case 5: InspectConfiguredCapabilitiesUseCase
 * ------------------------------------------------------------------ */

describe('InspectConfiguredCapabilitiesUseCase', () => {
  const request: InspectConfiguredCapabilitiesRequest = {
    projectId: 'project-atlas',
    requiredCapabilities: ['openai/gpt-5', 'local/vllm', 's3', 'never-configured'],
  };

  it('separates supported, missing and explicitly unknown capabilities', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const result = await new InspectConfiguredCapabilitiesUseCase({ profileRepo: repo }).execute(
      request,
    );
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') {
      throw new Error('expected an inspected profile');
    }
    expect(result.missingRequirements).toEqual(['local/vllm', 's3', 'never-configured']);
    expect(result.explicitUnknowns).toEqual(['s3', 'never-configured']);
    expect(result.profile.runnerCapabilities['openai/gpt-5']).toBe(true);
  });

  it('reports an unrecorded project as not-found rather than as having nothing', async () => {
    const result = await new InspectConfiguredCapabilitiesUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute({ projectId: 'project-unknown' });
    expect(result).toEqual({ outcome: 'not-found', projectId: 'project-unknown' });
  });

  it('bounds the report to the requested requirements', async () => {
    const repo = new StubProfileRepository({ 'project-atlas': profileRecord() });
    const result = await new InspectConfiguredCapabilitiesUseCase({ profileRepo: repo }).execute({
      projectId: 'project-atlas',
    });
    expect(result.outcome === 'inspected' && result.missingRequirements).toEqual([]);
    expect(result.outcome === 'inspected' && result.explicitUnknowns).toEqual([]);
  });

  it('refuses to run without dependencies', async () => {
    await expect(
      new InspectConfiguredCapabilitiesUseCase().execute(request),
    ).rejects.toThrow('Not implemented: InspectConfiguredCapabilitiesUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 3: RequestScopedDecisionUseCase
 * ------------------------------------------------------------------ */

describe('RequestScopedDecisionUseCase', () => {
  const request = {
    requestId: 'request-1',
    projectId: 'project-atlas',
    kind: 'action-decision' as const,
    actionScope: 'forge:merge',
    expectedHeadSha: 'abc123',
    proposalDigest: 'digest-1',
    policyRevision: 'policy-7',
    nowIso: NOW_ISO,
  };

  it('records the proposal before any decider is asked', async () => {
    const repo = new StubRequestRepository();
    const result = await new RequestScopedDecisionUseCase({ requestRepo: repo }).execute(request);
    expect(result.outcome).toBe('requested');
    if (result.outcome !== 'requested') {
      throw new Error('expected a recorded request');
    }
    expect(result.request.state).toBe('awaiting-decision');
    expect(result.request.grantId).toBeNull();
    expect(result.request.decisionRevision).toBeNull();
    expect(result.request.revision).toBe(0);
    expect(repo.saves[0]?.id).toBe('request-1');
  });

  it('leaves an unanswered proposal awaiting rather than approved', async () => {
    const repo = new StubRequestRepository();
    const transport = new StubDecisionTransport();
    const result = await new RequestScopedDecisionUseCase({
      requestRepo: repo,
      decisionTransport: transport,
    }).execute(request);
    expect(result.outcome === 'requested' && result.request.state).toBe('awaiting-decision');
    expect(transport.reads).toEqual(['request-1']);
    expect(repo.saves).toHaveLength(1);
  });

  it('applies a verified answer that carries a grant', async () => {
    const repo = new StubRequestRepository();
    const transport = new StubDecisionTransport({
      'request-1': { state: 'approved', decisionRevision: 'decision-3', grantId: 'grant-9' },
    });
    const result = await new RequestScopedDecisionUseCase({
      requestRepo: repo,
      decisionTransport: transport,
    }).execute(request);
    if (result.outcome !== 'requested') {
      throw new Error('expected a recorded request');
    }
    expect(result.request.state).toBe('approved');
    expect(result.request.grantId).toBe('grant-9');
    expect(result.request.decisionRevision).toBe('decision-3');
    expect(result.request.revision).toBe(1);
    expect(repo.saves.map((save) => save.state)).toEqual(['awaiting-decision', 'approved']);
  });

  it('never records an approval that carries no grant', async () => {
    const repo = new StubRequestRepository();
    const transport = new StubDecisionTransport({
      'request-1': { state: 'approved', decisionRevision: 'decision-3', grantId: null },
    });
    const result = await new RequestScopedDecisionUseCase({
      requestRepo: repo,
      decisionTransport: transport,
    }).execute(request);
    expect(result.outcome === 'requested' && result.request.state).toBe('awaiting-decision');
  });

  it('refuses an unrecorded scope, an unknown kind and an absent request', async () => {
    const repo = new StubRequestRepository();
    const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });
    const noScope = await useCase.execute({ ...request, actionScope: '  ' });
    expect(noScope.outcome).toBe('rejected');
    expect(noScope.outcome === 'rejected' && noScope.reason).toContain('actionScope');
    const badKind = await useCase.execute({
      ...request,
      kind: 'escalation',
    } as unknown as typeof request);
    expect(badKind.outcome === 'rejected' && badKind.reason).toContain('kind');
    expect(repo.saves).toHaveLength(0);
    await expect(useCase.execute(undefined)).rejects.toThrow(
      'Not implemented: RequestScopedDecisionUseCase',
    );
  });

  it('rejects a duplicate that races past the lookup instead of leaking the store error', async () => {
    // The real revision-aware adapter does the refusing; only the lookup is
    // stubbed, because a racer's read lands before the other writer commits.
    const store = new CoordinationRequestRepositoryAdapter();
    class RacingRequestRepository implements CoordinationRequestRepositoryPort {
      async saveRequest(record: CoordinationRequestRecord): Promise<void> {
        await store.saveRequest(record);
      }
      async findRequestById(): Promise<CoordinationRequestRecord | null> {
        return null;
      }
      async findRequestByGrantId(): Promise<CoordinationRequestRecord | null> {
        return null;
      }
      async listRequests(): Promise<readonly CoordinationRequestRecord[]> {
        return [];
      }
    }

    const winner = await new RequestScopedDecisionUseCase({ requestRepo: store }).execute(request);
    expect(winner.outcome).toBe('requested');

    // Same id at revision 0 with later timestamps: the store refuses it as a
    // conflict, and the use case reports that as its own typed outcome.
    const loser = await new RequestScopedDecisionUseCase({
      requestRepo: new RacingRequestRepository(),
    }).execute({ ...request, nowIso: LATER_ISO });

    expect(loser.outcome).toBe('rejected');
    expect(loser.outcome === 'rejected' && loser.reason).toContain(
      'a coordination request with id request-1 lost a revision race',
    );
    // The winner's record survives untouched; the racer rewrote nothing.
    const stored = await store.findRequestById('request-1');
    expect(stored?.createdAtIso).toBe(NOW_ISO);
    expect(stored?.revision).toBe(0);
  });

  it('rejects a duplicate whose store reports the conflict before any decider is asked', async () => {
    // A store that refuses the racing save is never consulted again: the decider
    // is not asked, because nothing of this proposal was ever recorded.
    class ConflictingRequestRepository implements CoordinationRequestRepositoryPort {
      async saveRequest(record: CoordinationRequestRecord): Promise<void> {
        throw new CoordinationRequestRevisionConflictError(
          record.id,
          record.revision,
          'CoordinationRequestRepositoryAdapter refuses conflicting revision 0 for request-1',
        );
      }
      async findRequestById(): Promise<CoordinationRequestRecord | null> {
        return null;
      }
      async findRequestByGrantId(): Promise<CoordinationRequestRecord | null> {
        return null;
      }
      async listRequests(): Promise<readonly CoordinationRequestRecord[]> {
        return [];
      }
    }

    const transport = new StubDecisionTransport({
      'request-1': { state: 'approved', decisionRevision: 'decision-3', grantId: 'grant-9' },
    });
    const result = await new RequestScopedDecisionUseCase({
      requestRepo: new ConflictingRequestRepository(),
      decisionTransport: transport,
    }).execute(request);

    expect(result.outcome).toBe('rejected');
    expect(transport.reads).toEqual([]);
  });

  it('propagates a store failure that is not a revision conflict', async () => {
    class FailingRequestRepository implements CoordinationRequestRepositoryPort {
      async saveRequest(): Promise<void> {
        throw new Error('CoordinationRequestRepositoryAdapter could not read the store');
      }
      async findRequestById(): Promise<CoordinationRequestRecord | null> {
        return null;
      }
      async findRequestByGrantId(): Promise<CoordinationRequestRecord | null> {
        return null;
      }
      async listRequests(): Promise<readonly CoordinationRequestRecord[]> {
        return [];
      }
    }

    await expect(
      new RequestScopedDecisionUseCase({ requestRepo: new FailingRequestRepository() }).execute(
        request,
      ),
    ).rejects.toThrow('CoordinationRequestRepositoryAdapter could not read the store');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 4: ResolveActionAuthorizationUseCase
 * ------------------------------------------------------------------ */

describe('ResolveActionAuthorizationUseCase', () => {
  const request = {
    projectId: 'project-atlas',
    actionScope: 'forge:merge',
    expectedHeadSha: 'abc123',
    authorizationGrantId: 'grant-9',
  };

  it('returns the applicable grant of an approved, unconsumed request', async () => {
    const repo = new StubRequestRepository([requestRecord()]);
    const result = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).execute(
      request,
    );
    expect(result).toEqual({
      outcome: 'authorized',
      grantId: 'grant-9',
      requestId: 'request-1',
      expectedHeadSha: 'abc123',
      policyRevision: 'policy-7',
    });
  });

  it('finds an approved request by project and action scope without a grant id', async () => {
    const repo = new StubRequestRepository([requestRecord()]);
    const result = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).execute({
      projectId: 'project-atlas',
      actionScope: 'forge:merge',
      expectedHeadSha: 'abc123',
    });
    expect(result.outcome === 'authorized' && result.grantId).toBe('grant-9');
  });

  it('blocks every state other than an approved grant', async () => {
    const cases: ReadonlyArray<[string, Partial<CoordinationRequestRecord>, RegExp]> = [
      [
        'awaiting-decision',
        { state: 'awaiting-decision', decisionRevision: null },
        /awaiting-decision/,
      ],
      ['declined', { state: 'declined' }, /declined/],
      ['no decision revision', { decisionRevision: null }, /decision revision/],
      ['moved head', { expectedHeadSha: 'def456' }, /not forge:merge at abc123/],
      ['different scope', { actionScope: 'host:restart' }, /host:restart/],
      ['already consumed', { consumptions: [consumptionRecord()] }, /already consumed/],
      ['another project', { projectId: 'project-other' }, /belongs to project project-other/],
    ];
    for (const [name, overrides, expected] of cases) {
      const repo = new StubRequestRepository([requestRecord(overrides)]);
      const result = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).execute(
        request,
      );
      expect(result.outcome, name).toBe('blocked');
      expect(result.outcome === 'blocked' && result.reason, name).toMatch(expected);
    }
  });

  it('blocks a recorded request that carries no grant', async () => {
    const repo = new StubRequestRepository([requestRecord({ grantId: null })]);
    const result = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).execute({
      projectId: 'project-atlas',
      actionScope: 'forge:merge',
      expectedHeadSha: 'abc123',
    });
    expect(result.outcome === 'blocked' && result.reason).toContain('carries no grant');
  });

  it('blocks when nothing is recorded at all', async () => {
    const repo = new StubRequestRepository();
    const missingGrant = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).execute(
      request,
    );
    expect(missingGrant.outcome === 'blocked' && missingGrant.reason).toContain('grant-9');
    const missingScope = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).execute({
      projectId: 'project-atlas',
      actionScope: 'forge:merge',
      expectedHeadSha: 'abc123',
    });
    expect(missingScope.outcome === 'blocked' && missingScope.reason).toContain('forge:merge');
  });

  it('refreshes a pending request from a verified answer once', async () => {
    const repo = new StubRequestRepository([
      requestRecord({ state: 'awaiting-decision', decisionRevision: null }),
    ]);
    const transport = new StubDecisionTransport({
      'request-1': { state: 'approved', decisionRevision: 'decision-3', grantId: 'grant-9' },
    });
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repo,
      decisionTransport: transport,
    }).execute(request);
    expect(result.outcome === 'authorized' && result.grantId).toBe('grant-9');
    expect(transport.reads).toEqual(['request-1']);
    expect(repo.saves).toHaveLength(1);
    expect(repo.saves[0]?.state).toBe('approved');
  });

  it('stays blocked when the verified answer carries no grant or is still pending', async () => {
    const grantless = new StubRequestRepository([
      requestRecord({ state: 'awaiting-decision', decisionRevision: null }),
    ]);
    const grantlessResult = await new ResolveActionAuthorizationUseCase({
      requestRepo: grantless,
      decisionTransport: new StubDecisionTransport({
        'request-1': { state: 'approved', decisionRevision: 'decision-3', grantId: null },
      }),
    }).execute(request);
    expect(grantlessResult.outcome === 'blocked' && grantlessResult.reason).toContain(
      'awaiting-decision',
    );
    expect(grantless.saves).toHaveLength(0);

    const pending = new StubRequestRepository([
      requestRecord({ state: 'awaiting-decision', decisionRevision: null }),
    ]);
    const pendingResult = await new ResolveActionAuthorizationUseCase({
      requestRepo: pending,
      decisionTransport: new StubDecisionTransport({
        'request-1': { state: 'declined', decisionRevision: 'decision-4', grantId: null },
      }),
    }).execute(request);
    expect(pendingResult.outcome).toBe('blocked');
  });

  it('refuses to run without dependencies or a usable request', async () => {
    await expect(
      new ResolveActionAuthorizationUseCase().execute(request),
    ).rejects.toThrow('Not implemented: ResolveActionAuthorizationUseCase');
    await expect(
      new ResolveActionAuthorizationUseCase({
        requestRepo: new StubRequestRepository(),
      }).execute(undefined),
    ).rejects.toThrow('Not implemented: ResolveActionAuthorizationUseCase');
    await expect(
      new ResolveActionAuthorizationUseCase({
        requestRepo: new StubRequestRepository(),
      }).execute({ ...request, expectedHeadSha: '' }),
    ).rejects.toThrow('Not implemented: ResolveActionAuthorizationUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 5: RecordAuthorizationConsumptionUseCase
 * ------------------------------------------------------------------ */

describe('RecordAuthorizationConsumptionUseCase', () => {
  const consumptionRequest = {
    consumptionId: 'consumption-1',
    grantId: 'grant-9',
    actionId: 'action-1',
    // The caller carries the scope over the port (work-execution's
    // forgeActionScope for forge actions); the use case compares it exactly.
    actionScope: 'forge:merge',
    attemptId: 'attempt-1',
    expectedHeadSha: 'abc123',
    nowIso: LATER_ISO,
  };

  it('binds a grant to one action and attempt and completes the request', async () => {
    const repo = new StubRequestRepository([requestRecord()]);
    const result = await new RecordAuthorizationConsumptionUseCase({ requestRepo: repo }).execute(
      consumptionRequest,
    );
    expect(result.outcome).toBe('consumed');
    if (result.outcome !== 'consumed') {
      throw new Error('expected a recorded consumption');
    }
    expect(result.consumption).toEqual({
      consumptionId: 'consumption-1',
      grantId: 'grant-9',
      requestId: 'request-1',
      actionId: 'action-1',
      attemptId: 'attempt-1',
      expectedHeadSha: 'abc123',
      consumedAtIso: LATER_ISO,
    });
    const stored = repo.requests.get('request-1');
    expect(stored?.state).toBe('completed');
    expect(stored?.revision).toBe(2);
    expect(stored?.consumptions).toHaveLength(1);
  });

  it('never lets one grant authorize a second, unrelated action', async () => {
    const repo = new StubRequestRepository([requestRecord()]);
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });
    await useCase.execute(consumptionRequest);
    const second = await useCase.execute({
      ...consumptionRequest,
      consumptionId: 'consumption-2',
      actionId: 'action-2',
      attemptId: 'attempt-2',
    });
    expect(second.outcome).toBe('refused');
    expect(second.outcome === 'refused' && second.reason).toContain('action-1');
    expect(repo.requests.get('request-1')?.consumptions).toHaveLength(1);
  });

  it('refuses to record the same action twice', async () => {
    const repo = new StubRequestRepository([
      requestRecord({ consumptions: [consumptionRecord()] }),
    ]);
    const result = await new RecordAuthorizationConsumptionUseCase({ requestRepo: repo }).execute(
      consumptionRequest,
    );
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' && result.reason).toContain('already authorized');
  });

  it('refuses an unrecorded grant, an unapproved state and a moved head', async () => {
    const unknownGrant = new StubRequestRepository();
    expect(
      (
        await new RecordAuthorizationConsumptionUseCase({ requestRepo: unknownGrant }).execute(
          consumptionRequest,
        )
      ).outcome === 'refused',
    ).toBe(true);

    const declined = new StubRequestRepository([requestRecord({ state: 'declined' })]);
    expect(
      (
        await new RecordAuthorizationConsumptionUseCase({ requestRepo: declined }).execute(
          consumptionRequest,
        )
      ).outcome === 'refused',
    ).toBe(true);

    const moved = new StubRequestRepository([requestRecord({ expectedHeadSha: 'def456' })]);
    const movedResult = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: moved,
    }).execute(consumptionRequest);
    expect(movedResult.outcome === 'refused' && movedResult.reason).toContain('def456');
    expect(moved.saves).toHaveLength(0);
  });

  it('refuses an incomplete consumption and refuses to run without dependencies', async () => {
    const repo = new StubRequestRepository([requestRecord()]);
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });
    const incomplete = await useCase.execute({ ...consumptionRequest, actionId: ' ' });
    expect(incomplete.outcome === 'refused' && incomplete.reason).toContain('actionId');
    const missingScope = await useCase.execute({ ...consumptionRequest, actionScope: ' ' });
    expect(missingScope.outcome === 'refused' && missingScope.reason).toContain('actionScope');
    await expect(useCase.execute(undefined)).rejects.toThrow(
      'Not implemented: RecordAuthorizationConsumptionUseCase',
    );
    await expect(
      new RecordAuthorizationConsumptionUseCase().execute(consumptionRequest),
    ).rejects.toThrow('Not implemented: RecordAuthorizationConsumptionUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 6: PublishProjectObservationUseCase
 * ------------------------------------------------------------------ */

describe('PublishProjectObservationUseCase', () => {
  const observation = {
    observationId: 'observation-1',
    projectId: 'project-atlas',
    eventKind: 'attempt.completed',
    sourceAttemptId: 'attempt-1',
    payloadSummary: 'attempt finished; head commit collected',
    nowIso: NOW_ISO,
  };

  it('publishes an attributed observation snapshot', async () => {
    const published: ObservationEnvelopeProps[] = [];
    const adapter = new ObservationPublicationAdapter({
      publish: (candidate) => {
        published.push(candidate);
      },
    });
    const result = await new PublishProjectObservationUseCase({
      publicationPort: adapter,
    }).execute(observation);
    expect(result).toEqual({ outcome: 'published', observationId: 'observation-1' });
    expect(published).toEqual([envelope()]);
  });

  it('keeps an unknown source attempt unknown rather than inferring one', async () => {
    const published: ObservationEnvelopeProps[] = [];
    const adapter = new ObservationPublicationAdapter({
      publish: (candidate) => {
        published.push(candidate);
      },
    });
    await new PublishProjectObservationUseCase({ publicationPort: adapter }).execute({
      ...observation,
      sourceAttemptId: null,
    });
    expect(published[0]?.sourceAttemptId).toBeNull();
  });

  it('preserves a delivery gap without throwing and leaves the fact undelivered', async () => {
    const adapter = new ObservationPublicationAdapter({
      publish: () => {
        throw new Error('waves client unreachable');
      },
    });
    const result = await new PublishProjectObservationUseCase({
      publicationPort: adapter,
    }).execute(observation);
    expect(result.outcome).toBe('delivery-gap');
    expect(result.outcome === 'delivery-gap' && result.reason).toContain('waves client unreachable');
    await expect(adapter.listUndeliveredObservations('project-atlas')).resolves.toEqual([
      envelope(),
    ]);
  });

  it('refuses an observation it cannot attribute', async () => {
    const adapter = new ObservationPublicationAdapter({ publish: () => undefined });
    const useCase = new PublishProjectObservationUseCase({ publicationPort: adapter });
    await expect(
      useCase.execute({ ...observation, payloadSummary: '  ' }),
    ).rejects.toThrow('Not implemented: PublishProjectObservationUseCase');
    await expect(useCase.execute(undefined)).rejects.toThrow(
      'Not implemented: PublishProjectObservationUseCase',
    );
    await expect(
      new PublishProjectObservationUseCase().execute(observation),
    ).rejects.toThrow('Not implemented: PublishProjectObservationUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 7: ReadProjectAttentionUseCase
 * ------------------------------------------------------------------ */

describe('ReadProjectAttentionUseCase', () => {
  it('reads a bounded summary for one project', async () => {
    const requested: string[] = [];
    const adapter = new AttentionReadAdapter({
      read: (projectId) => {
        requested.push(projectId);
        return attentionSummary();
      },
    });
    const result = await new ReadProjectAttentionUseCase({ attentionPort: adapter }).execute({
      projectId: 'project-atlas',
    });
    expect(result).toEqual({ outcome: 'read', attention: attentionSummary() });
    expect(requested).toEqual(['project-atlas']);
  });

  it('reports an unreadable summary as unavailable rather than healthy', async () => {
    const absent = new ReadProjectAttentionUseCase({
      attentionPort: new AttentionReadAdapter(),
    });
    const missing = await absent.execute({ projectId: 'project-atlas' });
    expect(missing.outcome).toBe('unavailable');

    const failing = new ReadProjectAttentionUseCase({
      attentionPort: new AttentionReadAdapter({
        read: () => {
          throw new Error('attention endpoint timed out');
        },
      }),
    });
    const failed = await failing.execute({ projectId: 'project-atlas' });
    expect(failed.outcome === 'unavailable' && failed.reason).toContain('timed out');

    const crossed = new ReadProjectAttentionUseCase({
      attentionPort: new AttentionReadAdapter({
        summaries: { 'project-other': attentionSummary({ projectId: 'project-other' }) },
      }),
    });
    const otherProject = await crossed.execute({ projectId: 'project-atlas' });
    expect(otherProject.outcome).toBe('unavailable');
  });

  it('refuses to run without dependencies or a project', async () => {
    await expect(
      new ReadProjectAttentionUseCase().execute({ projectId: 'project-atlas' }),
    ).rejects.toThrow('Not implemented: ReadProjectAttentionUseCase');
    await expect(
      new ReadProjectAttentionUseCase({ attentionPort: new AttentionReadAdapter() }).execute(
        undefined,
      ),
    ).rejects.toThrow('Not implemented: ReadProjectAttentionUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 8: SendFleetRelayUseCase
 * ------------------------------------------------------------------ */

describe('SendFleetRelayUseCase', () => {
  const relayRequest = {
    requestId: 'relay-1',
    projectId: 'project-atlas',
    recipientId: 'fleet-master',
    summary: 'attempt finished; head abc123 is ready for review',
    policyRevision: 'policy-7',
    nowIso: NOW_ISO,
  };

  it('records delivery without recording a recipient response', async () => {
    const repo = new StubRequestRepository();
    const transport = new StubRelayTransport();
    const result = await new SendFleetRelayUseCase({
      requestRepo: repo,
      relayTransport: transport,
    }).execute(relayRequest);
    expect(result.outcome).toBe('delivered');
    if (result.outcome !== 'delivered') {
      throw new Error('expected a delivered relay');
    }
    expect(result.request.kind).toBe('relay');
    expect(result.request.deliveryStatus).toBe('delivered');
    expect(result.request.deliveryGapReason).toBeNull();
    // Delivery proves transport only; it never records a response.
    expect(result.request.acknowledgements).toEqual([]);
    expect(result.request.state).toBe('executing');
    expect(transport.notices).toEqual([
      {
        requestId: 'relay-1',
        projectId: 'project-atlas',
        recipientId: 'fleet-master',
        summary: relayRequest.summary,
      },
    ]);
  });

  it('records an explicit delivery gap instead of a fabricated receipt', async () => {
    const repo = new StubRequestRepository();
    const transport = new StubRelayTransport({
      'relay-1': { outcome: 'delivery-gap', reason: 'notice channel is offline' },
    });
    const result = await new SendFleetRelayUseCase({
      requestRepo: repo,
      relayTransport: transport,
    }).execute(relayRequest);
    expect(result.outcome).toBe('delivery-gap');
    if (result.outcome !== 'delivery-gap') {
      throw new Error('expected a delivery gap');
    }
    expect(result.reason).toContain('offline');
    expect(result.request.deliveryStatus).toBe('delivery-gap');
    expect(result.request.deliveryGapReason).toContain('offline');
    expect(result.request.acknowledgements).toEqual([]);
  });

  it('lets an unanswered gapped relay be sent again and refuses an answered one', async () => {
    const repo = new StubRequestRepository();
    const transport = new StubRelayTransport({
      'relay-1': { outcome: 'delivery-gap', reason: 'notice channel is offline' },
    });
    const useCase = new SendFleetRelayUseCase({ requestRepo: repo, relayTransport: transport });
    await useCase.execute(relayRequest);
    const resent = await new SendFleetRelayUseCase({
      requestRepo: repo,
      relayTransport: new StubRelayTransport(),
    }).execute({ ...relayRequest, nowIso: LATER_ISO });
    expect(resent.outcome === 'delivered' && resent.request.revision).toBe(1);
    expect(resent.outcome === 'delivered' && resent.request.createdAtIso).toBe(NOW_ISO);

    const answered = new StubRequestRepository([
      requestRecord({
        id: 'relay-1',
        kind: 'relay',
        state: 'completed',
        grantId: null,
        decisionRevision: null,
        acknowledgements: [acknowledgementRecord({ requestId: 'relay-1' })],
      }),
    ]);
    const refused = await new SendFleetRelayUseCase({
      requestRepo: answered,
      relayTransport: new StubRelayTransport(),
    }).execute(relayRequest);
    expect(refused.outcome === 'rejected' && refused.reason).toContain('already answered');
  });

  it('refuses an unusable notice and refuses to run without dependencies', async () => {
    const repo = new StubRequestRepository();
    const useCase = new SendFleetRelayUseCase({
      requestRepo: repo,
      relayTransport: new StubRelayTransport(),
    });
    const empty = await useCase.execute({ ...relayRequest, summary: '  ' });
    expect(empty.outcome === 'rejected' && empty.reason).toContain('summary');

    const notARelay = await new SendFleetRelayUseCase({
      requestRepo: new StubRequestRepository([requestRecord({ id: 'relay-1' })]),
      relayTransport: new StubRelayTransport(),
    }).execute(relayRequest);
    expect(notARelay.outcome === 'rejected' && notARelay.reason).toContain('not a relay');
    await expect(useCase.execute(undefined)).rejects.toThrow('Not implemented: SendFleetRelayUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 9: RecordRelayAcknowledgementUseCase
 * ------------------------------------------------------------------ */

describe('RecordRelayAcknowledgementUseCase', () => {
  const relayRecord = (overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord =>
    requestRecord({
      id: 'relay-1',
      kind: 'relay',
      state: 'executing',
      actionScope: 'relay:fleet-master',
      expectedHeadSha: null,
      grantId: null,
      decisionRevision: null,
      deliveryStatus: 'delivered',
      ...overrides,
    });

  const acknowledgementRequest = {
    acknowledgementId: 'ack-1',
    requestId: 'relay-1',
    recipientId: 'fleet-master',
    responseSummary: 'received and triaged',
    provenance: 'waves-inbox-reply',
    nowIso: LATER_ISO,
  };

  it('records an actual recipient response and completes the relay', async () => {
    const repo = new StubRequestRepository([relayRecord()]);
    const result = await new RecordRelayAcknowledgementUseCase({ requestRepo: repo }).execute(
      acknowledgementRequest,
    );
    expect(result.outcome).toBe('acknowledged');
    if (result.outcome !== 'acknowledged') {
      throw new Error('expected a recorded response');
    }
    expect(result.acknowledgement).toEqual({
      acknowledgementId: 'ack-1',
      requestId: 'relay-1',
      recipientId: 'fleet-master',
      responseSummary: 'received and triaged',
      provenance: 'waves-inbox-reply',
      acknowledgedAtIso: LATER_ISO,
    });
    expect(result.request.state).toBe('completed');
    expect(result.request.revision).toBe(2);
    expect(result.request.deliveryStatus).toBe('delivered');
  });

  it('refuses silence, an unattributed response and a duplicate', async () => {
    const repo = new StubRequestRepository([relayRecord()]);
    const useCase = new RecordRelayAcknowledgementUseCase({ requestRepo: repo });
    for (const field of ['recipientId', 'responseSummary', 'provenance'] as const) {
      const refused = await useCase.execute({ ...acknowledgementRequest, [field]: '   ' });
      expect(refused.outcome, field).toBe('rejected');
      expect(refused.outcome === 'rejected' && refused.reason, field).toContain(field);
    }
    const missing = await useCase.execute({ ...acknowledgementRequest, requestId: 'relay-none' });
    expect(missing.outcome === 'rejected' && missing.reason).toContain('relay-none');
    const notARelay = await new RecordRelayAcknowledgementUseCase({
      requestRepo: new StubRequestRepository([
        requestRecord({ id: 'relay-1', kind: 'action-decision' }),
      ]),
    }).execute(acknowledgementRequest);
    expect(notARelay.outcome === 'rejected' && notARelay.reason).toContain('not a relay');

    await useCase.execute(acknowledgementRequest);
    const duplicate = await useCase.execute(acknowledgementRequest);
    expect(duplicate.outcome === 'rejected' && duplicate.reason).toContain('already recorded');
    expect(repo.requests.get('relay-1')?.acknowledgements).toHaveLength(1);
  });

  it('keeps a recorded delivery gap visible when a response arrives anyway', async () => {
    const repo = new StubRequestRepository([
      relayRecord({
        deliveryStatus: 'delivery-gap',
        deliveryGapReason: 'notice channel is offline',
      }),
    ]);
    const result = await new RecordRelayAcknowledgementUseCase({ requestRepo: repo }).execute(
      acknowledgementRequest,
    );
    expect(result.outcome === 'acknowledged' && result.request.deliveryStatus).toBe('delivery-gap');
    expect(
      result.outcome === 'acknowledged' && result.request.deliveryGapReason,
    ).toContain('offline');
  });

  it('refuses to run without dependencies or a request', async () => {
    await expect(
      new RecordRelayAcknowledgementUseCase().execute(acknowledgementRequest),
    ).rejects.toThrow('Not implemented: RecordRelayAcknowledgementUseCase');
    await expect(
      new RecordRelayAcknowledgementUseCase({
        requestRepo: new StubRequestRepository(),
      }).execute(undefined),
    ).rejects.toThrow('Not implemented: RecordRelayAcknowledgementUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Use case 10: InspectOutstandingCoordinationUseCase
 * ------------------------------------------------------------------ */

describe('InspectOutstandingCoordinationUseCase', () => {
  it('categorises undecided proposals, unknown actions and unanswered relays', async () => {
    const repo = new StubRequestRepository([
      requestRecord({ id: 'request-1', state: 'proposed', grantId: null, decisionRevision: null }),
      requestRecord({
        id: 'request-2',
        state: 'awaiting-decision',
        grantId: null,
        decisionRevision: null,
      }),
      requestRecord({ id: 'request-3', state: 'unknown', grantId: null, decisionRevision: null }),
      requestRecord({
        id: 'relay-1',
        kind: 'relay',
        state: 'executing',
        actionScope: 'relay:fleet-master',
        expectedHeadSha: null,
        grantId: null,
        decisionRevision: null,
        deliveryStatus: 'delivered',
      }),
      requestRecord({
        id: 'relay-2',
        kind: 'relay',
        state: 'completed',
        actionScope: 'relay:fleet-master',
        expectedHeadSha: null,
        grantId: null,
        decisionRevision: null,
        deliveryStatus: 'delivered',
        acknowledgements: [acknowledgementRecord({ requestId: 'relay-2' })],
      }),
      requestRecord({ id: 'request-4', state: 'completed', projectId: 'project-other' }),
    ]);
    const publicationPort = new ObservationPublicationAdapter({
      publish: () => {
        throw new Error('waves client unreachable');
      },
    });
    const useCase = new InspectOutstandingCoordinationUseCase({
      requestRepo: repo,
      publicationPort,
    });
    const projectScope = await useCase.execute({ projectId: 'project-atlas' });
    expect(projectScope.undecidedProposals.map((record) => record.id)).toEqual([
      'request-1',
      'request-2',
    ]);
    expect(projectScope.unknownActions.map((record) => record.id)).toEqual(['request-3']);
    expect(projectScope.unacknowledgedRelays.map((record) => record.id)).toEqual(['relay-1']);
    expect(projectScope.undeliveredObservations).toEqual([]);

    await new PublishProjectObservationUseCase({ publicationPort }).execute({
      observationId: 'observation-1',
      projectId: 'project-atlas',
      eventKind: 'attempt.completed',
      sourceAttemptId: null,
      payloadSummary: 'attempt finished',
      nowIso: NOW_ISO,
    });
    const withGap = await useCase.execute({ projectId: 'project-atlas' });
    expect(withGap.undeliveredObservations).toHaveLength(1);
    expect(await useCase.execute({ projectId: 'project-other' })).toMatchObject({
      undeliveredObservations: [],
      undecidedProposals: [],
    });

    const fleetWide = await useCase.execute({});
    expect(fleetWide.undecidedProposals).toHaveLength(2);
    expect(fleetWide.unacknowledgedRelays.map((record) => record.id)).toEqual(['relay-1']);
  });

  it('reports known absence as empty lists, never as invented items', async () => {
    const result = await new InspectOutstandingCoordinationUseCase({
      requestRepo: new StubRequestRepository(),
      publicationPort: new ObservationPublicationAdapter({ publish: () => undefined }),
    }).execute({ projectId: 'project-atlas' });
    expect(result).toEqual({
      undecidedProposals: [],
      unknownActions: [],
      undeliveredObservations: [],
      unacknowledgedRelays: [],
    });
  });

  it('refuses to run without dependencies', async () => {
    await expect(
      new InspectOutstandingCoordinationUseCase().execute({ projectId: 'project-atlas' }),
    ).rejects.toThrow('Not implemented: InspectOutstandingCoordinationUseCase');
  });
});

/* ------------------------------------------------------------------ *
 * Shared composition-boundary contract
 * ------------------------------------------------------------------ */

describe('use case composition boundary', () => {
  const cases: ReadonlyArray<[string, { execute: (input: unknown) => Promise<unknown> }]> = [
    ['RegisterProjectProfileUseCase', new RegisterProjectProfileUseCase()],
    ['ListProjectProfilesUseCase', new ListProjectProfilesUseCase()],
    ['InspectProjectProfileUseCase', new InspectProjectProfileUseCase()],
    ['RecordProjectProbeUseCase', new RecordProjectProbeUseCase()],
    ['UpdateProjectProfileUseCase', new UpdateProjectProfileUseCase()],
    ['RetireProjectProfileUseCase', new RetireProjectProfileUseCase()],
    ['InspectConfiguredCapabilitiesUseCase', new InspectConfiguredCapabilitiesUseCase()],
    ['RequestScopedDecisionUseCase', new RequestScopedDecisionUseCase()],
    ['ResolveActionAuthorizationUseCase', new ResolveActionAuthorizationUseCase()],
    ['RecordAuthorizationConsumptionUseCase', new RecordAuthorizationConsumptionUseCase()],
    ['PublishProjectObservationUseCase', new PublishProjectObservationUseCase()],
    ['ReadProjectAttentionUseCase', new ReadProjectAttentionUseCase()],
    ['SendFleetRelayUseCase', new SendFleetRelayUseCase()],
    ['RecordRelayAcknowledgementUseCase', new RecordRelayAcknowledgementUseCase()],
    ['InspectOutstandingCoordinationUseCase', new InspectOutstandingCoordinationUseCase()],
  ];

  it('refuses every unconfigured use case at the boundary', async () => {
    for (const [name, useCase] of cases) {
      await expect(useCase.execute(undefined), name).rejects.toThrow(`Not implemented: ${name}`);
      // A bare id is not a request object, so it never becomes one here.
      await expect(useCase.execute('request-1'), name).rejects.toThrow(`Not implemented: ${name}`);
    }
  });

  it('reports an incomplete request rather than acting on it', async () => {
    const result = await new RegisterProjectProfileUseCase({
      profileRepo: new StubProfileRepository(),
    }).execute({});
    expect(result.outcome).toBe('rejected');
  });
});

/* ------------------------------------------------------------------ *
 * Adapters
 * ------------------------------------------------------------------ */

describe('ProjectProfileRepositoryAdapter', () => {
  it('stores profiles in memory and reports known absence as null', async () => {
    const adapter = new ProjectProfileRepositoryAdapter();
    await expect(adapter.findProfileById('project-atlas')).resolves.toBeNull();
    await adapter.saveProfile(profileRecord({ revision: 0 }));
    const found = await adapter.findProfileById('project-atlas');
    expect(found?.designatedDispatcherHost).toBe('dispatcher-01');
    expect(found?.runnerCapabilities).toEqual(profileRecord().runnerCapabilities);
    expect(found).not.toBe(await adapter.findProfileById('project-atlas'));
  });

  it('refuses a stale or conflicting revision instead of overwriting', async () => {
    const adapter = new ProjectProfileRepositoryAdapter();
    await adapter.saveProfile(profileRecord({ revision: 0 }));
    await expect(
      adapter.saveProfile(profileRecord({ revision: 2, displayName: 'Stale' })),
    ).rejects.toThrow(ProjectProfileRevisionConflictError);
    await expect(
      adapter.saveProfile(profileRecord({ revision: 0, displayName: 'Conflicting' })),
    ).rejects.toThrow(ProjectProfileRevisionConflictError);
    await expect(
      adapter.saveProfile(profileRecord({ revision: 1, displayName: 'Newer' })),
    ).resolves.toBeUndefined();
    expect((await adapter.findProfileById('project-atlas'))?.revision).toBe(1);
  });

  it('refuses to persist a credential-shaped field', async () => {
    const adapter = new ProjectProfileRepositoryAdapter();
    await expect(
      adapter.saveProfile({
        ...profileRecord(),
        wavesApiToken: 'never-persisted',
      } as unknown as ProjectProfileRecord),
    ).rejects.toThrow(/credential field/);
    await expect(adapter.findProfileById('project-atlas')).resolves.toBeNull();
  });

  it('persists to the configured state directory and reloads it', async () => {
    await withTempDir(async (stateDir) => {
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir });
      await adapter.saveProfile(profileRecord({ revision: 0 }));
      await adapter.saveProfile(
        profileRecord({ projectId: 'project-borealis', revision: 0, displayName: 'Borealis' }),
      );
      const persisted = JSON.parse(
        await readFile(join(stateDir, 'project-profiles.json'), 'utf8'),
      ) as ReadonlyArray<Record<string, unknown>>;
      expect(persisted).toHaveLength(2);

      const reloaded = new ProjectProfileRepositoryAdapter({ stateDir });
      const found = await reloaded.findProfileById('project-borealis');
      expect(found?.displayName).toBe('Borealis');
      await expect(reloaded.saveProfile(profileRecord({ revision: 0 }))).rejects.toThrow(
        /Stale project profile revision for project-atlas: stored 0, write must be 1/,
      );
    });
  });

  it('refuses a state file name that would escape the state directory', async () => {
    await withTempDir(async (stateDir) => {
      const escaping = new ProjectProfileRepositoryAdapter({
        stateDir,
        fileName: '../escaped-profiles.json',
      });
      await expect(escaping.saveProfile(profileRecord())).rejects.toThrow(
        /unsafe state file name/,
      );
      await expect(
        new CoordinationRequestRepositoryAdapter({
          stateDir,
          fileName: '../escaped-requests.json',
        }).saveRequest(requestRecord()),
      ).rejects.toThrow(/unsafe state file name/);
    });
  });

  it('treats unreadable persisted state as an error rather than as no profile', async () => {
    await withTempDir(async (stateDir) => {
      await writeFile(join(stateDir, 'project-profiles.json'), 'not json', 'utf8');
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir });
      await expect(adapter.findProfileById('project-atlas')).rejects.toBeInstanceOf(
        StateFileUnreadableError,
      );
    });
  });

  it('enforces a strict compare-and-swap in memory', async () => {
    const adapter = new ProjectProfileRepositoryAdapter();
    await adapter.saveProfile(profileRecord({ revision: 0 }));
    await adapter.saveProfile(profileRecord({ revision: 1, displayName: 'Atlas v2' }));

    const sameRevision = await adapter
      .saveProfile(profileRecord({ revision: 1, displayName: 'different content' }))
      .catch((error: unknown) => error);
    expect(sameRevision).toBeInstanceOf(ProjectProfileRevisionConflictError);
    if (sameRevision instanceof ProjectProfileRevisionConflictError) {
      expect(sameRevision.projectId).toBe('project-atlas');
      expect(sameRevision.expectedRevision).toBe(1);
      expect(sameRevision.actualRevision).toBe(1);
    }

    const skip = await adapter
      .saveProfile(profileRecord({ revision: 3 }))
      .catch((error: unknown) => error);
    expect(skip).toBeInstanceOf(ProjectProfileRevisionConflictError);
    if (skip instanceof ProjectProfileRevisionConflictError) {
      expect(skip.expectedRevision).toBe(1);
      expect(skip.actualRevision).toBe(3);
      expect(skip.message).toContain('stored 1, write must be 2, got 3');
    }

    const newIdSkip = await adapter
      .saveProfile(profileRecord({ projectId: 'project-new', revision: 2 }))
      .catch((error: unknown) => error);
    expect(newIdSkip).toBeInstanceOf(ProjectProfileRevisionConflictError);
    if (newIdSkip instanceof ProjectProfileRevisionConflictError) {
      expect(newIdSkip.expectedRevision).toBe(-1);
      expect(newIdSkip.actualRevision).toBe(2);
      expect(newIdSkip.message).toContain('stored -1, write must be 0');
    }
  });

  it('enforces a strict compare-and-swap on a temp stateDir', async () => {
    await withTempDir(async (stateDir) => {
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir });
      await adapter.saveProfile(profileRecord({ revision: 0 }));
      await adapter.saveProfile(profileRecord({ revision: 1, displayName: 'Atlas v2' }));
      await expect(
        adapter.saveProfile(profileRecord({ revision: 1, displayName: 'different content' })),
      ).rejects.toThrow(ProjectProfileRevisionConflictError);
      await expect(adapter.saveProfile(profileRecord({ revision: 3 }))).rejects.toThrow(
        ProjectProfileRevisionConflictError,
      );
      await expect(
        adapter.saveProfile(profileRecord({ projectId: 'project-new', revision: 2 })),
      ).rejects.toThrow(ProjectProfileRevisionConflictError);
    });
  });

  it('lists every profile sorted by projectId including retired ones', async () => {
    const adapter = new ProjectProfileRepositoryAdapter();
    await adapter.saveProfile(profileRecord({ revision: 0 }));
    await adapter.saveProfile(
      profileRecord({
        projectId: 'project-borealis',
        revision: 0,
        status: 'retired',
        displayName: 'Borealis',
      }),
    );
    const listed = await adapter.listProfiles();
    expect(listed.map((profile) => profile.projectId)).toEqual(['project-atlas', 'project-borealis']);
    expect(listed.map((profile) => profile.status)).toEqual(['active', 'retired']);
  });

  it('lists an old-format file with v2 defaults', async () => {
    await withTempDir(async (stateDir) => {
      const oldFormat = {
        projectId: 'project-legacy',
        displayName: 'Legacy',
        repository: 'org/repo-legacy',
        designatedDispatcherHost: 'host-1',
        policyRevision: 'pol-1',
        maxConcurrentLanes: 2,
        runnerCapabilities: { filesystemScope: 'scoped-worktree' },
        revision: 1,
        updatedAtIso: '2026-10-15T10:00:00.000Z',
      };
      await writeFile(
        join(stateDir, 'project-profiles.json'),
        JSON.stringify([oldFormat]),
        'utf8',
      );
      const adapter = new ProjectProfileRepositoryAdapter({ stateDir });
      const listed = await adapter.listProfiles();
      expect(listed).toHaveLength(1);
      expect(listed[0].status).toBe('active');
      expect(listed[0].defaultBranch).toBeNull();
      expect(listed[0].clones).toEqual({});
      expect(listed[0].gateProcedures).toEqual([]);
      expect(listed[0].defaultAllowedPathPrefixes).toEqual([]);
      expect(listed[0].lastProbe).toBeNull();
    });
  });
});

describe('InstallationReferenceAdapter', () => {
  it('returns frozen sorted copies of the installation references', () => {
    const original: InstallationReferences = {
      hostNames: ['worker-02', 'dispatcher-01'],
      procedureNames: ['verify-merge', 'audit-logs'],
    };
    const adapter = new InstallationReferenceAdapter(original);
    const refs = adapter.references();
    expect(refs).toEqual({
      hostNames: ['dispatcher-01', 'worker-02'],
      procedureNames: ['audit-logs', 'verify-merge'],
    });
    expect(refs?.hostNames).not.toBe(original.hostNames);
    expect(() => {
      (refs?.hostNames as string[]).push('intruder');
    }).toThrow(TypeError);
    expect(() => {
      (refs?.procedureNames as string[]).push('intruder');
    }).toThrow(TypeError);
    expect(original.hostNames).toEqual(['worker-02', 'dispatcher-01']);
    expect(original.procedureNames).toEqual(['verify-merge', 'audit-logs']);
  });

  it('reports null when no installation is loaded', () => {
    expect(new InstallationReferenceAdapter(null).references()).toBeNull();
    expect(new InstallationReferenceAdapter().references()).toBeNull();
  });
});

describe('CoordinationRequestRepositoryAdapter', () => {
  it('finds requests by identity and by grant', async () => {
    const adapter = new CoordinationRequestRepositoryAdapter();
    await expect(adapter.findRequestById('request-1')).resolves.toBeNull();
    await expect(adapter.findRequestByGrantId('grant-9')).resolves.toBeNull();
    await adapter.saveRequest(requestRecord());
    expect((await adapter.findRequestById('request-1'))?.grantId).toBe('grant-9');
    expect((await adapter.findRequestByGrantId('grant-9'))?.id).toBe('request-1');
    expect(await adapter.listRequests()).toHaveLength(1);
    expect(await adapter.listRequests('project-other')).toHaveLength(0);
  });

  it('reindexes a grant when the record holding it changes or releases it', async () => {
    const adapter = new CoordinationRequestRepositoryAdapter();
    await adapter.saveRequest(requestRecord());
    await adapter.saveRequest(
      requestRecord({
        id: 'request-2',
        revision: 0,
        createdAtIso: LATER_ISO,
      }),
    );
    // The newest record for a grant is the one that resolves it.
    expect((await adapter.findRequestByGrantId('grant-9'))?.id).toBe('request-2');

    await adapter.saveRequest(
      requestRecord({
        id: 'request-2',
        revision: 1,
        grantId: null,
        decisionRevision: null,
        updatedAtIso: LATER_ISO,
      }),
    );
    expect(await adapter.findRequestByGrantId('grant-9')).toBeNull();
    expect((await adapter.findRequestById('request-1'))?.grantId).toBe('grant-9');
  });

  it('refuses a stale revision and an invalid record', async () => {
    const adapter = new CoordinationRequestRepositoryAdapter();
    await adapter.saveRequest(requestRecord({ revision: 5 }));
    await expect(
      adapter.saveRequest(requestRecord({ revision: 4, updatedAtIso: LATER_ISO })),
    ).rejects.toThrow(/stale revision 4/);
    await expect(
      adapter.saveRequest(
        requestRecord({ id: 'request-2', deliveryStatus: 'delivery-gap', deliveryGapReason: null }),
      ),
    ).rejects.toThrow(/delivery gap reason/);
  });

  it('persists requests and reloads them with their grant index', async () => {
    await withTempDir(async (stateDir) => {
      const adapter = new CoordinationRequestRepositoryAdapter({ stateDir });
      await adapter.saveRequest(requestRecord());
      await adapter.saveRequest(
        requestRecord({
          id: 'relay-1',
          kind: 'relay',
          state: 'executing',
          actionScope: 'relay:fleet-master',
          expectedHeadSha: null,
          grantId: null,
          decisionRevision: null,
          deliveryStatus: 'delivery-gap',
          deliveryGapReason: 'notice channel is offline',
          revision: 0,
          createdAtIso: LATER_ISO,
        }),
      );
      const reloaded = new CoordinationRequestRepositoryAdapter({ stateDir });
      expect(await reloaded.listRequests()).toHaveLength(2);
      expect((await reloaded.findRequestByGrantId('grant-9'))?.id).toBe('request-1');
      expect((await reloaded.findRequestById('relay-1'))?.deliveryGapReason).toContain('offline');
    });
  });
});

describe('DecisionTransportAdapter', () => {
  function testKeyPair(): { publicKeyBase64: string; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    return {
      publicKeyBase64: raw32.toString('base64'),
      privateKey,
    };
  }

  function testSignature(
    fields: {
      requestId: string;
      projectId: string;
      actionScope: string;
      expectedHeadSha: string | null;
      decisionRevision: string | null;
      grantId: string | null;
      state: string;
    },
    privateKey: KeyObject,
  ): string {
    return sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
  }

  const query: DecisionAnswerQuery = {
    requestId: 'request-1',
    projectId: 'project-atlas',
    actionScope: 'forge:merge',
    expectedHeadSha: 'abc123',
  };

  it('reads a verified answer recorded in process', async () => {
    const { publicKeyBase64, privateKey } = testKeyPair();
    const signature = testSignature(
      {
        ...query,
        decisionRevision: 'decision-3',
        grantId: 'grant-9',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'request-1': {
          state: 'approved',
          decisionRevision: 'decision-3',
          grantId: 'grant-9',
          signature,
        },
      },
    });
    await expect(adapter.readDecisionAnswer(query)).resolves.toEqual({
      state: 'approved',
      decisionRevision: 'decision-3',
      grantId: 'grant-9',
    });
    await expect(
      adapter.readDecisionAnswer({ ...query, requestId: 'request-2' }),
    ).resolves.toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('never upgrades a grantless, malformed or absent answer to approval', async () => {
    const adapter = new DecisionTransportAdapter({
      answers: {
        'request-1': { state: 'approved', decisionRevision: 'decision-3', grantId: null },
        'request-2': { state: 'maybe', decisionRevision: 'decision-3', grantId: 'grant-9' },
      } as never,
    });
    await expect(adapter.readDecisionAnswer(query)).resolves.toMatchObject({
      state: 'awaiting-decision',
      grantId: null,
    });
    await expect(
      adapter.readDecisionAnswer({ ...query, requestId: 'request-2' }),
    ).resolves.toMatchObject({
      state: 'awaiting-decision',
      grantId: null,
    });
  });

  it('reads owner-recorded decision files and treats absence as awaiting', async () => {
    const { publicKeyBase64, privateKey } = testKeyPair();
    const signature = testSignature(
      {
        ...query,
        decisionRevision: 'decision-3',
        grantId: 'grant-9',
        state: 'approved',
      },
      privateKey,
    );
    await withTempDir(async (decisionsDir) => {
      await writeFile(
        join(decisionsDir, 'request-1.json'),
        JSON.stringify({
          state: 'approved',
          decisionRevision: 'decision-3',
          grantId: 'grant-9',
          signature,
        }),
        'utf8',
      );
      await writeFile(join(decisionsDir, 'request-2.json'), 'not json', 'utf8');
      const adapter = new DecisionTransportAdapter({ decisionsDir, ownerPublicKey: publicKeyBase64 });
      await expect(adapter.readDecisionAnswer(query)).resolves.toMatchObject({
        state: 'approved',
        grantId: 'grant-9',
      });
      await expect(
        adapter.readDecisionAnswer({ ...query, requestId: 'request-2' }),
      ).resolves.toMatchObject({
        state: 'awaiting-decision',
      });
      await expect(
        adapter.readDecisionAnswer({ ...query, requestId: 'request-3' }),
      ).resolves.toMatchObject({
        state: 'awaiting-decision',
      });
      await expect(
        adapter.readDecisionAnswer({ ...query, requestId: '../../etc/passwd' }),
      ).resolves.toMatchObject({
        state: 'awaiting-decision',
      });
    });
  });

  it('reports a declined answer without inventing a grant', async () => {
    const adapter = new DecisionTransportAdapter({
      answers: {
        'request-1': { state: 'declined', decisionRevision: 'decision-4', grantId: 'grant-9' },
      },
    });
    await expect(adapter.readDecisionAnswer(query)).resolves.toEqual({
      state: 'declined',
      decisionRevision: 'decision-4',
      grantId: null,
    });
  });
});

describe('ObservationPublicationAdapter', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes through the injected boundary and releases a previous gap', async () => {
    let failing = true;
    const adapter = new ObservationPublicationAdapter({
      publish: () => {
        if (failing) {
          throw new Error('waves client unreachable');
        }
        return { outcome: 'published' };
      },
    });
    const first = await adapter.publishObservationSnapshot(envelope());
    expect(first.outcome).toBe('delivery-gap');
    await expect(adapter.listUndeliveredObservations()).resolves.toHaveLength(1);

    failing = false;
    await expect(adapter.publishObservationSnapshot(envelope())).resolves.toEqual({
      outcome: 'published',
    });
    await expect(adapter.listUndeliveredObservations()).resolves.toEqual([]);
  });

  it('keeps a reported gap undelivered and narrows it to one project', async () => {
    const adapter = new ObservationPublicationAdapter({
      publish: () => ({ outcome: 'delivery-gap', reason: 'snapshot rejected by the client' }),
    });
    await adapter.publishObservationSnapshot(envelope());
    await adapter.publishObservationSnapshot(
      envelope({ observationId: 'observation-2', projectId: 'project-other' }),
    );
    await expect(adapter.listUndeliveredObservations('project-atlas')).resolves.toHaveLength(1);
    await expect(adapter.listUndeliveredObservations()).resolves.toHaveLength(2);
  });

  it('writes to a local outbox when no publication boundary is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-observation-'));
    temporaryDirectories.push(directory);
    const adapter = new ObservationPublicationAdapter({ outboxDir: directory });
    await expect(adapter.publishObservationSnapshot(envelope())).resolves.toEqual({
      outcome: 'published',
    });
    const written = JSON.parse(
      await readFile(join(directory, 'observation-1.json'), 'utf8'),
    ) as ObservationEnvelopeProps;
    expect(written.payloadSummary).toContain('head commit collected');
    await expect(adapter.listUndeliveredObservations()).resolves.toEqual([]);
  });

  it('reports a gap and refuses to publish an unattributable observation', async () => {
    const unconfigured = new ObservationPublicationAdapter();
    const gap = await unconfigured.publishObservationSnapshot(envelope());
    expect(gap.outcome === 'delivery-gap' && gap.reason).toContain('no observation publication');
    const invalid = await unconfigured.publishObservationSnapshot({
      ...envelope(),
      projectId: '',
    });
    expect(invalid.outcome).toBe('delivery-gap');
  });

  it('always records a reason for a gap the boundary reports without one', async () => {
    const adapter = new ObservationPublicationAdapter({
      publish: () => ({ outcome: 'delivery-gap' }) as never,
    });
    const gap = await adapter.publishObservationSnapshot(envelope());
    expect(gap.outcome === 'delivery-gap' && gap.reason).toContain('delivery gap');
    await expect(adapter.listUndeliveredObservations()).resolves.toHaveLength(1);
  });
});

describe('AttentionReadAdapter', () => {
  it('prefers the injected reader and returns known absence as null', async () => {
    const adapter = new AttentionReadAdapter({
      read: (projectId) => (projectId === 'project-atlas' ? attentionSummary() : null),
      summaries: { 'project-other': attentionSummary({ projectId: 'project-other' }) },
    });
    const read = await adapter.fetchProjectAttention('project-atlas');
    expect(read?.awaitingDecisionCount).toBe(2);
    expect(read).not.toBe(await adapter.fetchProjectAttention('project-atlas'));
    // The reader is the boundary, so its absence is authoritative.
    expect(await adapter.fetchProjectAttention('project-other')).toBeNull();
  });

  it('falls back to the local summary store', async () => {
    const adapter = new AttentionReadAdapter({
      summaries: { 'project-atlas': attentionSummary() },
    });
    expect((await adapter.fetchProjectAttention('project-atlas'))?.staleWorkOrderCount).toBe(1);
    expect(await adapter.fetchProjectAttention('project-other')).toBeNull();
    expect(await new AttentionReadAdapter().fetchProjectAttention('project-atlas')).toBeNull();
  });

  it('propagates a failed read instead of returning an empty summary', async () => {
    const adapter = new AttentionReadAdapter({
      read: () => Promise.reject(new Error('attention endpoint timed out')),
    });
    await expect(adapter.fetchProjectAttention('project-atlas')).rejects.toThrow(
      'attention endpoint timed out',
    );
  });
});

describe('RelayTransportAdapter', () => {
  it('delivers through the injected channel and returns its receipt', async () => {
    const notices: RelayNoticeRequest[] = [];
    const adapter = new RelayTransportAdapter({
      deliver: (request) => {
        notices.push(request);
      },
    });
    const notice: RelayNoticeRequest = {
      requestId: 'relay-1',
      projectId: 'project-atlas',
      recipientId: 'fleet-master',
      summary: 'attempt finished',
    };
    await expect(adapter.deliverRelayNotice(notice)).resolves.toEqual({ outcome: 'delivered' });
    expect(notices).toEqual([notice]);
  });

  it('preserves a reported gap and a thrown channel failure', async () => {
    const reported = new RelayTransportAdapter({
      deliver: () => ({ outcome: 'delivery-gap', reason: 'notice channel is offline' }),
    });
    const gap = await reported.deliverRelayNotice({
      requestId: 'relay-1',
      projectId: 'project-atlas',
      recipientId: 'fleet-master',
      summary: 'attempt finished',
    });
    expect(gap).toEqual({ outcome: 'delivery-gap', reason: 'notice channel is offline' });

    const throwing = new RelayTransportAdapter({
      deliver: () => {
        throw new Error('channel closed');
      },
    });
    const failed = await throwing.deliverRelayNotice({
      requestId: 'relay-1',
      projectId: 'project-atlas',
      recipientId: 'fleet-master',
      summary: 'attempt finished',
    });
    expect(failed.outcome === 'delivery-gap' && failed.reason).toContain('channel closed');

    const reasonless = new RelayTransportAdapter({
      deliver: () => ({ outcome: 'delivery-gap' }) as never,
    });
    const unexplained = await reasonless.deliverRelayNotice({
      requestId: 'relay-1',
      projectId: 'project-atlas',
      recipientId: 'fleet-master',
      summary: 'attempt finished',
    });
    expect(unexplained.outcome === 'delivery-gap' && unexplained.reason).toContain('delivery gap');
  });

  it('writes a local outbox receipt and refuses to fabricate one', async () => {
    await withTempDir(async (outboxDir) => {
      const adapter = new RelayTransportAdapter({ outboxDir });
      const notice: RelayNoticeRequest = {
        requestId: 'relay-1',
        projectId: 'project-atlas',
        recipientId: 'fleet-master',
        summary: 'attempt finished',
      };
      await expect(adapter.deliverRelayNotice(notice)).resolves.toEqual({ outcome: 'delivered' });
      const written = JSON.parse(await readFile(join(outboxDir, 'relay-1.json'), 'utf8')) as {
        recipientId: string;
      };
      expect(written.recipientId).toBe('fleet-master');

      const unconfigured = new RelayTransportAdapter();
      const gap = await unconfigured.deliverRelayNotice(notice);
      expect(gap.outcome === 'delivery-gap' && gap.reason).toContain('no relay transport');
      const invalid = await adapter.deliverRelayNotice({ ...notice, recipientId: '  ' });
      expect(invalid.outcome === 'delivery-gap' && invalid.reason).toContain('recipientId');
    });
  });
});

describe('profile read use cases refuse a non-object request', () => {
  it('rejects an array as the request for list, inspect and record', async () => {
    const repo = new ProjectProfileRepositoryAdapter();
    for (const useCase of [
      new ListProjectProfilesUseCase({ profileRepo: repo }),
      new InspectProjectProfileUseCase({ profileRepo: repo }),
      new RecordProjectProbeUseCase({ profileRepo: repo }),
    ]) {
      await expect(useCase.execute([])).resolves.toEqual({
        outcome: 'rejected',
        reason: 'request must be an object',
      });
    }
  });
});
