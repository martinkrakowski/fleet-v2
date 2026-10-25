import { describe, expect, it } from 'vitest';

import type {
  AuthorizationConsumptionRecord,
  CoordinationRequestRecord,
  ProjectProfileRecord,
  RelayAcknowledgementRecord,
} from '../coordination-records.js';
import { AuthorizationConsumption } from '../entities/AuthorizationConsumption.js';
import { CoordinationRequest } from '../entities/CoordinationRequest.js';
import { ProjectProfile } from '../entities/ProjectProfile.js';
import { RelayAcknowledgement } from '../entities/RelayAcknowledgement.js';
import { ActionAuthorization } from '../value-objects/ActionAuthorization.vo.js';
import { COORDINATION_KINDS, CoordinationKind } from '../value-objects/CoordinationKind.vo.js';
import { COORDINATION_STATES, CoordinationState } from '../value-objects/CoordinationState.vo.js';
import { ObservationEnvelope } from '../value-objects/ObservationEnvelope.vo.js';
import { PolicyReference } from '../value-objects/PolicyReference.vo.js';

type Created<T> = { success: boolean; value?: T; error?: Error };

function created<T>(result: Created<T>): T {
  if (!result.success || result.value === undefined) {
    throw result.error ?? new Error('expected a value');
  }
  return result.value;
}

function refused<T>(result: Created<T>): Error {
  if (result.success || result.error === undefined) {
    throw new Error('expected a refusal');
  }
  return result.error;
}

function profileRecord(overrides: Partial<ProjectProfileRecord> = {}): ProjectProfileRecord {
  return {
    projectId: 'project-atlas',
    displayName: 'Atlas',
    repository: 'atlas/repo',
    designatedDispatcherHost: 'dispatcher-01',
    policyRevision: 'policy-7',
    maxConcurrentLanes: 3,
    runnerCapabilities: { 'openai/gpt-5': true, 'local/vllm': false, s3: 'configured-unknown' },
    revision: 2,
    updatedAtIso: '2026-10-15T09:00:00.000Z',
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
    consumedAtIso: '2026-10-15T09:05:00.000Z',
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
    acknowledgedAtIso: '2026-10-15T09:10:00.000Z',
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
    consumptions: [consumptionRecord()],
    acknowledgements: [],
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 4,
    createdAtIso: '2026-10-15T09:00:00.000Z',
    updatedAtIso: '2026-10-15T09:05:00.000Z',
    ...overrides,
  };
}

describe('CoordinationKind', () => {
  it('accepts every kind declared in the manifest', () => {
    for (const kind of COORDINATION_KINDS) {
      expect(created(CoordinationKind.create(kind)).getValue()).toBe(kind);
    }
  });

  it('refuses a kind outside the manifest enum', () => {
    expect(refused(CoordinationKind.create('escalation')).message).toContain(
      'Invalid coordination kind',
    );
    expect(refused(CoordinationKind.create(undefined)).message).toContain('Invalid coordination kind');
  });

  it('asks a decider only for decisions and policy proposals', () => {
    expect(created(CoordinationKind.create('action-decision')).requiresDecision()).toBe(true);
    expect(created(CoordinationKind.create('policy-proposal')).requiresDecision()).toBe(true);
    expect(created(CoordinationKind.create('relay')).requiresDecision()).toBe(false);
    expect(created(CoordinationKind.create('registry-alert')).requiresDecision()).toBe(false);
  });

  it('compares by value', () => {
    const first = created(CoordinationKind.create('relay'));
    const second = created(CoordinationKind.create('relay'));
    const other = created(CoordinationKind.create('registry-alert'));
    expect(first.equals(second)).toBe(true);
    expect(first.equals(other)).toBe(false);
  });
});

describe('CoordinationState', () => {
  it('accepts every state declared in the manifest', () => {
    for (const state of COORDINATION_STATES) {
      expect(created(CoordinationState.create(state)).getValue()).toBe(state);
    }
  });

  it('refuses a state outside the manifest enum', () => {
    expect(refused(CoordinationState.create('running')).message).toContain(
      'Invalid coordination state',
    );
  });

  it('authorizes execution only from the approved state', () => {
    for (const state of COORDINATION_STATES) {
      const expected = state === 'approved';
      expect(created(CoordinationState.create(state)).canAuthorizeExecution()).toBe(expected);
    }
  });

  it('treats completed, declined, expired and cancelled as terminal', () => {
    for (const state of COORDINATION_STATES) {
      const expected =
        state === 'completed' || state === 'declined' || state === 'expired' || state === 'cancelled';
      expect(created(CoordinationState.create(state)).isTerminal()).toBe(expected);
    }
  });
});

describe('PolicyReference', () => {
  const props = { policyId: 'policy-main', revision: 'r7', approvedBy: 'owner-atlas' };

  it('refuses an incomplete reference', () => {
    expect(refused(PolicyReference.create({ ...props, revision: '  ' })).message).toContain(
      'revision',
    );
    expect(refused(PolicyReference.create({ ...props, approvedBy: '' })).message).toContain(
      'approvedBy',
    );
    expect(refused(PolicyReference.create(null)).message).toContain('requires props');
  });

  it('names the approved revision rather than any policy prose', () => {
    const reference = created(PolicyReference.create(props));
    expect(reference.getPolicyId()).toBe('policy-main');
    expect(reference.getRevision()).toBe('r7');
    expect(reference.getApprovedBy()).toBe('owner-atlas');
  });

  it('hands out a copy so the reference cannot be mutated in place', () => {
    const reference = created(PolicyReference.create(props));
    const exported = reference.getProps();
    expect(exported).toEqual(props);
    expect(exported).not.toBe(reference.getProps());
  });

  it('treats a different revision as different authority', () => {
    const current = created(PolicyReference.create(props));
    const superseded = created(PolicyReference.create({ ...props, revision: 'r6' }));
    expect(current.matches(superseded)).toBe(false);
    expect(current.equals(superseded)).toBe(false);
    expect(current.equals(created(PolicyReference.create({ ...props })))).toBe(true);
  });
});

describe('ActionAuthorization', () => {
  const props = {
    grantId: 'grant-9',
    projectId: 'project-atlas',
    actionScope: 'forge:merge',
    expectedHeadSha: 'abc123',
    policyRevision: 'policy-7',
    decisionRevision: 'decision-3',
    consumed: false,
  };

  it('refuses a grant without a decision revision or head sha', () => {
    expect(refused(ActionAuthorization.create({ ...props, decisionRevision: '' })).message).toContain(
      'decisionRevision',
    );
    expect(refused(ActionAuthorization.create({ ...props, expectedHeadSha: '' })).message).toContain(
      'expectedHeadSha',
    );
    expect(
      refused(ActionAuthorization.create({ ...props, consumed: 'yes' as unknown as boolean })).message,
    ).toContain('consumed');
  });

  it('authorizes only the exact action scope and expected commit', () => {
    const authorization = created(ActionAuthorization.create(props));
    expect(authorization.matchesAction('forge:merge', 'abc123')).toBe(true);
    expect(authorization.matchesAction('forge:close', 'abc123')).toBe(false);
    expect(authorization.matchesAction('forge:merge', 'def456')).toBe(false);
  });

  it('keeps a consumed grant visibly consumed', () => {
    expect(created(ActionAuthorization.create(props)).isConsumed()).toBe(false);
    const consumed = created(ActionAuthorization.create({ ...props, consumed: true }));
    expect(consumed.isConsumed()).toBe(true);
    expect(consumed.matchesAction('forge:merge', 'abc123')).toBe(true);
  });
});

describe('ObservationEnvelope', () => {
  const props = {
    observationId: 'observation-1',
    projectId: 'project-atlas',
    eventKind: 'attempt.completed',
    sourceAttemptId: 'attempt-1',
    payloadSummary: 'attempt finished; head commit collected',
    recordedAtIso: '2026-10-15T09:02:00.000Z',
  };

  it('records an unknown source attempt as unknown', () => {
    const envelope = created(ObservationEnvelope.create({ ...props, sourceAttemptId: null }));
    expect(envelope.hasSourceAttempt()).toBe(false);
    expect(envelope.getProps().sourceAttemptId).toBeNull();
    expect(created(ObservationEnvelope.create(props)).hasSourceAttempt()).toBe(true);
  });

  it('refuses a non-string source attempt id', () => {
    expect(
      refused(
        ObservationEnvelope.create({
          ...props,
          sourceAttemptId: 42 as unknown as string,
        }),
      ).message,
    ).toContain('sourceAttemptId');
    expect(refused(ObservationEnvelope.create({ ...props, eventKind: '' })).message).toContain(
      'eventKind',
    );
  });

  it('compares by value', () => {
    expect(
      created(ObservationEnvelope.create(props)).equals(
        created(ObservationEnvelope.create({ ...props })),
      ),
    ).toBe(true);
    expect(
      created(ObservationEnvelope.create(props)).equals(
        created(ObservationEnvelope.create({ ...props, payloadSummary: 'different' })),
      ),
    ).toBe(false);
  });
});

describe('ProjectProfile', () => {
  it('refuses a profile with no designated dispatcher host', () => {
    expect(() =>
      ProjectProfile.fromRecord(profileRecord({ designatedDispatcherHost: '   ' })),
    ).toThrow(/designatedDispatcherHost/);
  });

  it('refuses a profile carrying a credential-shaped field', () => {
    const withToken = { ...profileRecord(), wavesApiToken: 'never-persisted' };
    expect(() => ProjectProfile.fromRecord(withToken as ProjectProfileRecord)).toThrow(
      /credential field/,
    );
    const withSecret = { ...profileRecord(), deploymentSecret: 'never-persisted' };
    expect(() => ProjectProfile.fromRecord(withSecret as ProjectProfileRecord)).toThrow(
      /credential field/,
    );
  });

  it('refuses an unusable lane bound, capability map or revision', () => {
    expect(() => ProjectProfile.fromRecord(profileRecord({ maxConcurrentLanes: 0 }))).toThrow(
      /maxConcurrentLanes/,
    );
    expect(() => ProjectProfile.fromRecord(profileRecord({ revision: -1 }))).toThrow(/revision/);
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          runnerCapabilities: { broken: 7 as unknown as boolean },
        }),
      ),
    ).toThrow(/Runner capability broken/);
    expect(() =>
      ProjectProfile.fromRecord(profileRecord({ runnerCapabilities: null as unknown as Record<string, boolean> })),
    ).toThrow(/runnerCapabilities map/);
  });

  it('separates a supported capability from a missing one and from an unknown', () => {
    const profile = ProjectProfile.fromRecord(profileRecord());
    expect(profile.classifyCapability('openai/gpt-5')).toBe('supported');
    expect(profile.supportsCapability('openai/gpt-5')).toBe(true);
    expect(profile.classifyCapability('local/vllm')).toBe('missing');
    expect(profile.supportsCapability('local/vllm')).toBe(false);
    expect(profile.classifyCapability('s3')).toBe('unknown');
    expect(profile.classifyCapability('never-configured')).toBe('unknown');
  });

  it('moves its revision forward and hides its capability map from mutation', () => {
    const profile = ProjectProfile.fromRecord(profileRecord());
    expect(profile.nextRevision()).toBe(3);
    const exported = profile.toRecord();
    const mutableCopy = { ...exported.runnerCapabilities };
    mutableCopy['openai/gpt-5'] = false;
    expect(exported.runnerCapabilities).not.toBe(profile.toRecord().runnerCapabilities);
    expect(profile.supportsCapability('openai/gpt-5')).toBe(true);
    expect(profile.getId()).toBe('project-atlas');
    expect(profile.getDispatcherHost()).toBe('dispatcher-01');
    expect(profile.getPolicyRevision()).toBe('policy-7');
    expect(profile.getMaxConcurrentLanes()).toBe(3);
  });

  it('reads an old record without v2 fields with all six defaults', () => {
    const oldRecord = {
      projectId: 'project-atlas',
      displayName: 'Atlas',
      repository: 'atlas/repo',
      designatedDispatcherHost: 'dispatcher-01',
      policyRevision: 'policy-7',
      maxConcurrentLanes: 3,
      runnerCapabilities: { 'openai/gpt-5': true },
      revision: 1,
      updatedAtIso: '2026-10-15T09:00:00.000Z',
    };
    const profile = ProjectProfile.fromRecord(oldRecord);
    expect(profile.getStatus()).toBe('active');
    expect(profile.isActive()).toBe(true);
    expect(profile.toRecord().defaultBranch).toBeNull();
    expect(profile.getClones()).toEqual({});
    expect(profile.getGateProcedures()).toEqual([]);
    expect(profile.toRecord().defaultAllowedPathPrefixes).toEqual([]);
    expect(profile.toRecord().lastProbe).toBeNull();
  });

  it('refuses invalid v2 fields with the exact validation messages', () => {
    expect(() =>
      ProjectProfile.fromRecord(profileRecord({ status: 'paused' as never })),
    ).toThrow('ProjectProfile requires status active or retired');
    expect(() =>
      ProjectProfile.fromRecord(profileRecord({ defaultBranch: '  ' })),
    ).toThrow('ProjectProfile requires defaultBranch to be null or a non-empty branch name');
    for (const badBranch of ['-upload-pack=x', 'a..b', 'has space', 'x.lock', '/x']) {
      expect(() =>
        ProjectProfile.fromRecord(profileRecord({ defaultBranch: badBranch })),
      ).toThrow('ProjectProfile requires defaultBranch to be null or a non-empty branch name');
    }
    expect(
      ProjectProfile.fromRecord(profileRecord({ defaultBranch: 'release/1.2' })).toRecord()
        .defaultBranch,
    ).toBe('release/1.2');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          clones: [] as unknown as Readonly<Record<string, { path: string; worktreeRoot: string }>>,
        }),
      ),
    ).toThrow('ProjectProfile requires a clones map');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { '': { path: '/work', worktreeRoot: '/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host name is invalid: ');
    for (const badHost of ['__proto__', 'constructor', '../x', 'host 1']) {
      expect(() =>
        ProjectProfile.fromRecord(
          profileRecord({
            clones: { [badHost]: { path: '/work', worktreeRoot: '/wt' } },
          }),
        ),
      ).toThrow(`ProjectProfile clone host name is invalid: ${badHost}`);
    }
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { hostApiKey: { path: '/work', worktreeRoot: '/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host name is invalid: hostApiKey');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { host1: { path: '/work/../x', worktreeRoot: '/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host1 requires normalised absolute paths');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { host1: { path: '/srv/clone/', worktreeRoot: '/srv/clone' } } }),
      ),
    ).toThrow('ProjectProfile clone host1 requires normalised absolute paths');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { host1: { path: '///srv/clone', worktreeRoot: '/srv/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host1 requires normalised absolute paths');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { host1: { path: '/srv/./clone', worktreeRoot: '/srv/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host1 requires normalised absolute paths');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { host1: { path: '/', worktreeRoot: '/srv/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host1 requires normalised absolute paths');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({ clones: { host1: { path: '/srv/clone', worktreeRoot: '/srv/clone/wt' } } }),
      ),
    ).toThrow('ProjectProfile clone host1 worktreeRoot must be outside the clone');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          clones: {
            host1: { path: '/srv/clone', worktreeRoot: '/srv/wt', extra: 'nope' } as unknown as {
              path: string;
              worktreeRoot: string;
            },
          },
        }),
      ),
    ).toThrow('ProjectProfile clone host1 carries only path and worktreeRoot');
    expect(() =>
      ProjectProfile.fromRecord(profileRecord({ gateProcedures: ['verify', 'verify'] })),
    ).toThrow('ProjectProfile requires gateProcedures to be unique non-empty names');
    expect(() =>
      ProjectProfile.fromRecord(profileRecord({ defaultAllowedPathPrefixes: ['/absolute'] })),
    ).toThrow('ProjectProfile requires defaultAllowedPathPrefixes to be relative paths without ..');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          lastProbe: {
            probedAtIso: '2026-10-15T09:00:00.000Z',
            probedFrom: 'host-1',
            checks: [{ name: '', host: null, result: 'pass', detail: '' }],
          },
        }),
      ),
    ).toThrow('ProjectProfile requires lastProbe to be null or a probe receipt');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          lastProbe: {
            probedAtIso: '2026-10-15T09:00:00.000Z',
            probedFrom: 'host-1',
            checks: [{ name: 'git-fetch', host: '', result: 'pass', detail: 'ok' }],
          },
        }),
      ),
    ).toThrow('ProjectProfile requires lastProbe to be null or a probe receipt');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          lastProbe: {
            probedAtIso: '2026-10-15T09:00:00.000Z',
            probedFrom: 'bad host',
            checks: [],
          },
        }),
      ),
    ).toThrow('ProjectProfile requires lastProbe to be null or a probe receipt');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          runnerCapabilities: { githubToken: 'secret-value' },
        }),
      ),
    ).toThrow('ProjectProfile must not carry a credential capability: githubToken');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          lastProbe: {
            probedAtIso: '2026-10-15T09:00:00.000Z',
            probedFrom: 'host-1',
            checks: [
              {
                name: 'git-fetch',
                host: 'host-1',
                result: 'pass',
                detail: 'ok',
                apiKey: 'secret',
              } as never,
            ],
          },
        }),
      ),
    ).toThrow('ProjectProfile requires lastProbe to be null or a probe receipt');
    expect(() =>
      ProjectProfile.fromRecord(
        profileRecord({
          lastProbe: {
            probedAtIso: '2026-10-15T09:00:00.000Z',
            probedFrom: 'host-1',
            checks: [],
            extra: 'unexpected',
          } as never,
        }),
      ),
    ).toThrow('ProjectProfile requires lastProbe to be null or a probe receipt');
  });

  it('deep-copies clones and the probe receipt on toRecord', () => {
    const profile = ProjectProfile.fromRecord(
      profileRecord({
        clones: { host1: { path: '/srv/clone', worktreeRoot: '/srv/wt' } },
        gateProcedures: ['verify'],
        defaultAllowedPathPrefixes: ['src'],
        lastProbe: {
          probedAtIso: '2026-10-15T09:00:00.000Z',
          probedFrom: 'host-1',
          checks: [{ name: 'git-fetch', host: 'host-1', result: 'pass', detail: 'ok' }],
        },
      }),
    );
    const first = profile.toRecord();
    (first.clones.host1 as { path: string }).path = '/elsewhere';
    (first.gateProcedures as string[]).push('injected');
    (first.defaultAllowedPathPrefixes as string[]).push('injected');
    Object.assign(first.lastProbe!.checks[0], { detail: 'mutated' });
    const second = profile.toRecord();
    expect(second.clones['host1']).toEqual({ path: '/srv/clone', worktreeRoot: '/srv/wt' });
    expect(second.gateProcedures).toEqual(['verify']);
    expect(second.defaultAllowedPathPrefixes).toEqual(['src']);
    expect(second.lastProbe!.checks[0].detail).toBe('ok');
  });
});

describe('AuthorizationConsumption', () => {
  it('refuses a consumption with an unbound grant or action', () => {
    expect(() => AuthorizationConsumption.fromRecord(consumptionRecord({ grantId: '' }))).toThrow(
      /grantId/,
    );
    expect(() =>
      AuthorizationConsumption.fromRecord(consumptionRecord({ attemptId: '  ' })),
    ).toThrow(/attemptId/);
  });

  it('binds the grant to its exact action and attempt', () => {
    const consumption = AuthorizationConsumption.fromRecord(consumptionRecord());
    expect(consumption.isForGrant('grant-9')).toBe(true);
    expect(consumption.isForGrant('grant-8')).toBe(false);
    expect(consumption.isForAction('action-1')).toBe(true);
    expect(consumption.isForAttempt('attempt-2')).toBe(false);
    expect(consumption.getActionId()).toBe('action-1');
    expect(consumption.toRecord().grantId).toBe('grant-9');
  });
});

describe('RelayAcknowledgement', () => {
  it('refuses a response without a recipient or provenance', () => {
    expect(() => RelayAcknowledgement.fromRecord(acknowledgementRecord({ recipientId: '' }))).toThrow(
      /recipientId/,
    );
    expect(() =>
      RelayAcknowledgement.fromRecord(acknowledgementRecord({ provenance: '' })),
    ).toThrow(/provenance/);
  });

  it('attributes the response to the recipient that actually answered', () => {
    const acknowledgement = RelayAcknowledgement.fromRecord(acknowledgementRecord());
    expect(acknowledgement.isFromRecipient('fleet-master')).toBe(true);
    expect(acknowledgement.isFromRecipient('project-controller')).toBe(false);
    expect(acknowledgement.equals(RelayAcknowledgement.fromRecord(acknowledgementRecord()))).toBe(
      true,
    );
  });
});

describe('CoordinationRequest', () => {
  it('refuses a record with a kind or state outside the manifest enum', () => {
    expect(() =>
      CoordinationRequest.fromRecord(
        requestRecord({ kind: 'escalation' as unknown as CoordinationRequestRecord['kind'] }),
      ),
    ).toThrow(/invalid kind/);
    expect(() =>
      CoordinationRequest.fromRecord(
        requestRecord({ state: 'running' as unknown as CoordinationRequestRecord['state'] }),
      ),
    ).toThrow(/invalid state/);
  });

  it('records a delivery gap explicitly and nowhere else', () => {
    expect(() => CoordinationRequest.fromRecord(requestRecord({ deliveryStatus: 'delivery-gap' }))).toThrow(
      /delivery gap reason/,
    );
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ deliveryGapReason: 'transport down' })),
    ).toThrow(/without a delivery gap/);

    const gapped = CoordinationRequest.fromRecord(
      requestRecord({ deliveryStatus: 'delivery-gap', deliveryGapReason: 'outbox unreachable' }),
    );
    expect(gapped.hasDeliveryGap()).toBe(true);
    expect(gapped.getDeliveryGapReason()).toBe('outbox unreachable');
  });

  it('refuses to record one grant as authorizing the same action twice', () => {
    expect(() =>
      CoordinationRequest.fromRecord(
        requestRecord({
          consumptions: [consumptionRecord(), consumptionRecord({ consumptionId: 'consumption-2' })],
        }),
      ),
    ).toThrow(/more than once/);
  });

  it('authorizes only the approved scope at its expected commit', () => {
    const approved = CoordinationRequest.fromRecord(requestRecord());
    expect(approved.canAuthorizeAction('forge:merge', 'abc123')).toBe(true);
    expect(approved.canAuthorizeAction('forge:merge', 'def456')).toBe(false);
    expect(approved.canAuthorizeAction('host:restart', 'abc123')).toBe(false);

    expect(
      CoordinationRequest.fromRecord(requestRecord({ state: 'awaiting-decision' })).canAuthorizeAction(
        'forge:merge',
        'abc123',
      ),
    ).toBe(false);
    expect(
      CoordinationRequest.fromRecord(requestRecord({ state: 'unknown' })).canAuthorizeAction(
        'forge:merge',
        'abc123',
      ),
    ).toBe(false);
    expect(
      CoordinationRequest.fromRecord(requestRecord({ grantId: null })).canAuthorizeAction(
        'forge:merge',
        'abc123',
      ),
    ).toBe(false);
    expect(
      CoordinationRequest.fromRecord(requestRecord({ decisionRevision: null })).canAuthorizeAction(
        'forge:merge',
        'abc123',
      ),
    ).toBe(false);
  });

  it('separates delivery from an actual recipient response', () => {
    const undelivered = CoordinationRequest.fromRecord(requestRecord());
    expect(undelivered.isAcknowledgedBy('fleet-master')).toBe(false);

    const answered = CoordinationRequest.fromRecord(
      requestRecord({ acknowledgements: [acknowledgementRecord()] }),
    );
    expect(answered.isAcknowledgedBy('fleet-master')).toBe(true);
    expect(answered.isAcknowledgedBy('project-controller')).toBe(false);
    expect(answered.getAcknowledgements()).toHaveLength(1);
  });

  it('exposes its consumption receipts and moves its revision forward', () => {
    const request = CoordinationRequest.fromRecord(requestRecord());
    expect(request.hasConsumptionForAction('action-1')).toBe(true);
    expect(request.hasConsumptionForAction('action-2')).toBe(false);
    expect(request.getConsumptionsForGrant('grant-9')).toHaveLength(1);
    expect(request.getConsumptionsForGrant('grant-8')).toHaveLength(0);
    expect(request.nextRevision()).toBe(5);
    expect(request.isTerminal()).toBe(false);
    expect(
      CoordinationRequest.fromRecord(requestRecord({ state: 'completed' })).isTerminal(),
    ).toBe(true);
    expect(request.getId()).toBe('request-1');
    expect(request.getKind()).toBe('action-decision');
    expect(request.getState()).toBe('approved');
  });
});
