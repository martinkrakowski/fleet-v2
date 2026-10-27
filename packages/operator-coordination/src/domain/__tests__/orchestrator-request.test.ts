import { describe, expect, it } from 'vitest';

import { COORDINATION_KINDS } from '../value-objects/CoordinationKind.vo.js';
import { ORCHESTRATOR_REQUEST_KINDS } from '../orchestrator-session-records.js';
import {
  ORCHESTRATOR_REQUEST_LINK_KEY,
  ORCHESTRATOR_REQUEST_STATES,
  ORCHESTRATOR_REQUEST_TARGET_KEY,
} from '../orchestrator-request-records.js';
import { OrchestratorRequest } from '../entities/OrchestratorRequest.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const ID = '01JB0000000000000000000000';
const VALID = {
  requestId: ID, revision: 1, kind: 'dispatch-attempt', projectId: 'example-project',
  target: { attemptId: 'attempt-example-1' },
  requestedBy: { via: 'web', sessionId: 'web-session-example' },
  createdAtIso: '2026-10-27T10:00:00.000Z', expiresAtIso: '2026-10-27T10:30:00.000Z',
  updatedAtIso: '2026-10-27T10:00:00.000Z', state: 'queued', fence: 0, claimCount: 0,
  claim: null, deferredUntilIso: null, reason: null, linked: null,
};

const CLAIM = { orchestratorId: 'orch-example-1', fence: 1, leaseUntilIso: '2026-10-27T10:05:00.000Z' };

function validWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID, ...overrides };
}

function validWithState(state: string): Record<string, unknown> {
  switch (state) {
    case 'claimed':
    case 'cancel-requested':
      return validWith({ state, fence: 1, claim: CLAIM });
    case 'deferred':
      return validWith({
        state,
        reason: { reasonKind: 'capacity', detail: null },
        deferredUntilIso: '2026-10-27T10:15:00.000Z',
      });
    case 'dispatched':
      return validWith({
        state,
        fence: 1,
        claim: CLAIM,
        linked: { attemptId: 'attempt-example-1', journalKey: `request/${ID}` },
      });
    case 'refused':
      return validWith({
        state,
        fence: 1,
        claim: CLAIM,
        reason: { reasonKind: 'policy', detail: null },
      });
    case 'stalled':
      return validWith({ state, fence: 2, claimCount: 2 });
    default:
      return validWith({ state });
  }
}

describe('OrchestratorRequest', () => {
  it('accepts VALID, round-trips, normalises timestamps and returns fresh nested records', () => {
    const result = OrchestratorRequest.create(VALID);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.value.toRecord()).toEqual(VALID);

    const json = JSON.parse(JSON.stringify(VALID)) as unknown;
    const recreated = OrchestratorRequest.create(json);
    expect(recreated.success).toBe(true);
    if (!recreated.success) {
      return;
    }
    expect(recreated.value.toRecord()).toEqual(VALID);

    const normalized = OrchestratorRequest.create({ ...VALID, createdAtIso: '2026-10-27T10:00:00Z' });
    expect(normalized.success).toBe(true);
    if (!normalized.success) {
      return;
    }
    expect(normalized.value.toRecord().createdAtIso).toBe('2026-10-27T10:00:00.000Z');

    const first = result.value.toRecord();
    (first.target as { attemptId: string }).attemptId = 'mutated';
    const second = result.value.toRecord();
    expect((second.target as { attemptId: string }).attemptId).toBe('attempt-example-1');
  });

  const INVARIANT_ROWS: Array<[string, unknown, string]> = [
    ['null input', null, 'OrchestratorRequest requires a record'],
    ['array input', [], 'OrchestratorRequest requires a record'],
    ['unknown key', { ...VALID, note: 'x' }, 'OrchestratorRequest has an unknown key'],
    [
      'missing target',
      Object.fromEntries(Object.entries(VALID).filter(([key]) => key !== 'target')),
      'OrchestratorRequest has an unknown key',
    ],
    ['bad requestId', validWith({ requestId: 'not-a-ulid' }), 'OrchestratorRequest requestId must be a ULID'],
    [
      'lower-case ULID',
      validWith({ requestId: '01jb0000000000000000000000' }),
      'OrchestratorRequest requestId must be a ULID',
    ],
    ['revision zero', validWith({ revision: 0 }), 'OrchestratorRequest revision must be a positive integer'],
    [
      'kind merge',
      validWith({ kind: 'merge' }),
      'OrchestratorRequest kind is not one of dispatch-attempt, start-lane-run, prepare-fix, request-review, resume-run',
    ],
    [
      'kind halt',
      validWith({ kind: 'halt' }),
      'OrchestratorRequest kind is not one of dispatch-attempt, start-lane-run, prepare-fix, request-review, resume-run',
    ],
    [
      'empty projectId',
      validWith({ projectId: '' }),
      'OrchestratorRequest projectId must be a non-empty id of at most 256 bytes',
    ],
    [
      '257-byte projectId',
      validWith({ projectId: 'é'.repeat(129) }),
      'OrchestratorRequest projectId must be a non-empty id of at most 256 bytes',
    ],
    [
      'target wrong key for kind',
      validWith({ target: { workOrderId: 'w' } }),
      'OrchestratorRequest target must hold exactly the one id its kind names',
    ],
    [
      'target extra key',
      validWith({ target: { attemptId: 'a', runId: 'r' } }),
      'OrchestratorRequest target must hold exactly the one id its kind names',
    ],
    [
      'requestedBy cli via',
      validWith({ requestedBy: { via: 'cli', sessionId: 's' } }),
      'OrchestratorRequest requestedBy must be { via: web, sessionId }',
    ],
    [
      'requestedBy missing sessionId',
      validWith({ requestedBy: { via: 'web' } }),
      'OrchestratorRequest requestedBy must be { via: web, sessionId }',
    ],
    ['bad expiresAt', validWith({ expiresAtIso: 'soon' }), 'OrchestratorRequest expiresAtIso must be a valid timestamp'],
    [
      'expiry 1801s after creation',
      validWith({ expiresAtIso: '2026-10-27T10:30:01.000Z' }),
      'OrchestratorRequest expiry exceeds 1800 seconds past creation',
    ],
    [
      'updatedAt before createdAt',
      validWith({ updatedAtIso: '2026-10-27T09:59:59.000Z' }),
      'OrchestratorRequest times must satisfy createdAt <= updatedAt and createdAt < expiresAt',
    ],
    ['unknown state', validWith({ state: 'running' }), 'OrchestratorRequest state is not a known lifecycle state'],
    ['negative fence', validWith({ fence: -1 }), 'OrchestratorRequest fence must be a non-negative integer'],
    [
      'claimCount 3',
      validWith({ claimCount: 3 }),
      'OrchestratorRequest claimCount must be 0, 1 or 2 and never exceed fence',
    ],
    [
      'claimCount exceeds fence',
      validWith({ claimCount: 1, fence: 0 }),
      'OrchestratorRequest claimCount must be 0, 1 or 2 and never exceed fence',
    ],
    [
      'claim with extra key',
      validWith({ claim: { ...CLAIM, extra: true } }),
      'OrchestratorRequest claim must be null or { orchestratorId, fence, leaseUntilIso }',
    ],
    [
      'reason unknown kind',
      validWith({ reason: { reasonKind: 'busy', detail: null } }),
      'OrchestratorRequest reason must be null or { reasonKind, detail }',
    ],
    [
      'reason detail 1025 bytes',
      validWith({ reason: { reasonKind: 'capacity', detail: 'a'.repeat(1025) } }),
      'OrchestratorRequest reason detail must be at most 1024 bytes of plain text',
    ],
    [
      'reason detail control character',
      validWith({ reason: { reasonKind: 'capacity', detail: 'bell\u0007' } }),
      'OrchestratorRequest reason detail must be at most 1024 bytes of plain text',
    ],
    [
      'linked wrong journalKey',
      validWith({
        state: 'dispatched',
        fence: 1,
        claim: CLAIM,
        linked: { attemptId: 'attempt-example-1', journalKey: 'request/OTHER' },
      }),
      `OrchestratorRequest linked must be null or { attemptId, journalKey: request/${ID} }`,
    ],
    [
      'queued with claim',
      validWith({ claim: { ...CLAIM, fence: 1 } }),
      'OrchestratorRequest fields do not match its state',
    ],
    [
      'claimed claim fence differs',
      validWith({ state: 'claimed', fence: 1, claim: { ...CLAIM, fence: 2 } }),
      'OrchestratorRequest fields do not match its state',
    ],
    [
      'stalled claimCount 1',
      validWith({ state: 'stalled', fence: 1, claimCount: 1 }),
      'OrchestratorRequest fields do not match its state',
    ],
    [
      'deferred past expiry',
      validWith({
        state: 'deferred',
        reason: { reasonKind: 'capacity', detail: null },
        deferredUntilIso: '2026-10-27T10:40:00.000Z',
      }),
      'OrchestratorRequest fields do not match its state',
    ],
  ];

  it.each(INVARIANT_ROWS)('rejects %s with the fixed message and invalid code', (_name, input, message) => {
    const result = OrchestratorRequest.create(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(message);
      expect(result.code).toBe('invalid');
    }
  });

  it.each(ORCHESTRATOR_REQUEST_STATES)('accepts a valid %s record', (state) => {
    const result = OrchestratorRequest.create(validWithState(state));
    expect(result.success).toBe(true);
  });

  it.each(ORCHESTRATOR_REQUEST_KINDS)('validates %s target and link keys', (kind) => {
    const targetKey = ORCHESTRATOR_REQUEST_TARGET_KEY[kind];
    const target = { [targetKey]: 'target-id-example' };
    expect(OrchestratorRequest.create(validWith({ kind, target })).success).toBe(true);

    for (const otherKey of ['attemptId', 'workOrderId', 'runId']) {
      if (otherKey === targetKey) {
        continue;
      }
      const result = OrchestratorRequest.create(validWith({ kind, target: { [otherKey]: 'target-id-example' } }));
      expect(result.success).toBe(false);
    }

    const linkKey = ORCHESTRATOR_REQUEST_LINK_KEY[kind];
    const dispatched = OrchestratorRequest.create(
      validWith({
        kind,
        target,
        state: 'dispatched',
        fence: 1,
        claim: CLAIM,
        linked: { [linkKey]: 'target-id-example', journalKey: `request/${ID}` },
      }),
    );
    expect(dispatched.success).toBe(true);
  });

  it('never echoes distinctive input values', () => {
    const inputs: unknown[] = [
      validWith({ kind: 'merge-XYZZY' }),
      { ...VALID, 'XYZZY-key': 'x' },
      validWith({ state: 'XYZZY' }),
      validWith({ target: { XYZZY: 'a' } }),
      validWith({ requestId: 'XYZZY' }),
    ];
    for (const input of inputs) {
      const result = OrchestratorRequest.create(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain('XYZZY');
      }
    }
  });

  it('refuses secret-shaped values without echoing them', () => {
    const fake = fakeSecretShape();

    const projectId = OrchestratorRequest.create(validWith({ projectId: fake }));
    expect(projectId.success).toBe(false);
    if (!projectId.success) {
      expect(projectId.error.message).toContain('projectId');
      expect(projectId.error.message).toContain('secret-shaped');
      expect(projectId.error.message).not.toContain(fake);
    }

    const target = OrchestratorRequest.create(validWith({ target: { attemptId: fake } }));
    expect(target.success).toBe(false);
    if (!target.success) {
      expect(target.error.message).toContain('target');
      expect(target.error.message).toContain('secret-shaped');
      expect(target.error.message).not.toContain(fake);
    }

    const requestedBy = OrchestratorRequest.create(validWith({ requestedBy: { via: 'web', sessionId: fake } }));
    expect(requestedBy.success).toBe(false);
    if (!requestedBy.success) {
      expect(requestedBy.error.message).toContain('requestedBy');
      expect(requestedBy.error.message).toContain('secret-shaped');
      expect(requestedBy.error.message).not.toContain(fake);
    }

    const claim = OrchestratorRequest.create(
      validWith({ state: 'claimed', fence: 1, claim: { ...CLAIM, orchestratorId: fake } }),
    );
    expect(claim.success).toBe(false);
    if (!claim.success) {
      expect(claim.error.message).toContain('claim');
      expect(claim.error.message).toContain('secret-shaped');
      expect(claim.error.message).not.toContain(fake);
    }

    const detail = OrchestratorRequest.create(
      validWith({
        state: 'refused',
        fence: 1,
        claim: CLAIM,
        reason: { reasonKind: 'other', detail: fake },
      }),
    );
    expect(detail.success).toBe(false);
    if (!detail.success) {
      expect(detail.error.message).toContain('reason detail');
      expect(detail.error.message).toContain('secret-shaped');
      expect(detail.error.message).not.toContain(fake);
    }

    const linked = OrchestratorRequest.create(
      validWith({
        state: 'dispatched',
        fence: 1,
        claim: CLAIM,
        linked: { attemptId: fake, journalKey: `request/${ID}` },
      }),
    );
    expect(linked.success).toBe(false);
    if (!linked.success) {
      expect(linked.error.message).toContain('linked');
      expect(linked.error.message).toContain('secret-shaped');
      expect(linked.error.message).not.toContain(fake);
    }
  });

  it('never throws on hostile or boundary input', () => {
    const nonObjects: unknown[] = [undefined, 42, 'text', Object.create(null)];
    for (const input of nonObjects) {
      const result = OrchestratorRequest.create(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain('boom');
      }
    }

    const arrayTarget = OrchestratorRequest.create(validWith({ target: [] }));
    expect(arrayTarget.success).toBe(false);
    if (!arrayTarget.success) {
      expect(arrayTarget.error.message).not.toContain('boom');
    }

    const getterRecord = { ...VALID };
    Object.defineProperty(getterRecord, 'projectId', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const getterResult = OrchestratorRequest.create(getterRecord);
    expect(getterResult.success).toBe(false);
    if (!getterResult.success) {
      expect(getterResult.error.message).not.toContain('boom');
    }

    const proxy = new Proxy({ ...VALID }, {
      ownKeys() {
        throw new Error('boom');
      },
    });
    const proxyResult = OrchestratorRequest.create(proxy);
    expect(proxyResult.success).toBe(false);
    if (!proxyResult.success) {
      expect(proxyResult.error.message).not.toContain('boom');
    }
  });

  const OPEN_PAYLOAD = {
    requestId: ID,
    kind: 'dispatch-attempt',
    projectId: 'example-project',
    target: { attemptId: 'attempt-example-1' },
  };
  const REQUESTED_BY = { via: 'web', sessionId: 'web-session-example' };
  const NOW = '2026-10-27T10:00:00.000Z';

  it('open creates the same record as VALID', () => {
    const result = OrchestratorRequest.open(OPEN_PAYLOAD, REQUESTED_BY, NOW);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.value.toRecord()).toEqual(VALID);
  });

  it('open honours a custom ttl', () => {
    const result = OrchestratorRequest.open(OPEN_PAYLOAD, REQUESTED_BY, NOW, 60);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.value.toRecord().expiresAtIso).toBe('2026-10-27T10:01:00.000Z');
  });

  it('open refuses bad ttl and now values', () => {
    for (const ttl of [1801, 0]) {
      const result = OrchestratorRequest.open(OPEN_PAYLOAD, REQUESTED_BY, NOW, ttl);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('OrchestratorRequest ttl must be 1 to 1800 seconds');
      }
    }
    const badNow = OrchestratorRequest.open(OPEN_PAYLOAD, REQUESTED_BY, 'not-a-time');
    expect(badNow.success).toBe(false);
    if (!badNow.success) {
      expect(badNow.error.message).toBe('OrchestratorRequest now must be a valid timestamp');
    }
  });

  it('open refuses unexpected payload keys', () => {
    for (const extra of ['requestedBy', 'note', 'seat', 'expiresAtIso']) {
      const result = OrchestratorRequest.open({ ...OPEN_PAYLOAD, [extra]: 'x' }, REQUESTED_BY, NOW);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('OrchestratorRequest payload has an unknown key');
      }
    }
  });

  it('open refuses a secret-shaped session id without echoing it', () => {
    const result = OrchestratorRequest.open(OPEN_PAYLOAD, { via: 'web', sessionId: fakeSecretShape() }, NOW);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('requestedBy');
      expect(result.error.message).toContain('secret-shaped');
      expect(result.error.message).not.toContain(fakeSecretShape());
    }
  });

  it('open never throws on hostile payloads', () => {
    const payloads: unknown[] = [undefined, 42, 'text', Object.create(null), { ...OPEN_PAYLOAD, target: [] }];
    for (const payload of payloads) {
      const result = OrchestratorRequest.open(payload, REQUESTED_BY, NOW);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain('boom');
      }
    }
  });

  it('is not a coordination kind', () => {
    expect(COORDINATION_KINDS).not.toContain('orchestrator-request');
    for (const state of ORCHESTRATOR_REQUEST_STATES) {
      expect(COORDINATION_KINDS).not.toContain(state);
    }
    for (const kind of ORCHESTRATOR_REQUEST_KINDS) {
      expect(COORDINATION_KINDS).not.toContain(kind);
    }
  });
});
