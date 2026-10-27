import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord, PolicyGrantRecord } from '../coordination-records.js';
import { CoordinationRequest } from '../entities/CoordinationRequest.js';
import {
  isPolicyGrantRecord,
  parsePolicyDecisionRevision,
  policyDecisionRevision,
  policyGrantActionScope,
  policyGrantForgeKindOf,
  policyGrantProposalDigest,
} from '../policy-grants.js';

const HEAD = 'a'.repeat(40);
const NOW_ISO = '2026-10-27T00:00:00.000Z';
const VALID_GRANT: PolicyGrantRecord = {
  workOrderId: 'wo-example-a',
  attemptId: 'attempt-example-a',
  acceptanceReceiptId: 'receipt-example-a',
};

function requestRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return {
    id: 'request-example-a',
    projectId: 'project-example',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: HEAD,
    proposalDigest: 'digest-example-a',
    policyRevision: 'policy-revision-example',
    decisionRevision: 'policy:autoMerge@309ab8c40bf2',
    grantId: 'grant-example-a',
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

describe('policy-grant helpers', () => {
  it('builds the forge action scope', () => {
    expect(policyGrantActionScope('push-to-pr')).toBe('forge:push-to-pr');
  });

  it('maps every forge kind scope to its kind', () => {
    expect(policyGrantForgeKindOf('forge:push-and-open-pr')).toBe('push-and-open-pr');
    expect(policyGrantForgeKindOf('forge:push-to-pr')).toBe('push-to-pr');
    expect(policyGrantForgeKindOf('forge:merge-pr')).toBe('merge-pr');
  });

  it('returns null for a scope that is not a policy-grant forge kind', () => {
    expect(policyGrantForgeKindOf('forge:merge')).toBeNull();
    expect(policyGrantForgeKindOf('forge:merge-pr-x')).toBeNull();
    expect(policyGrantForgeKindOf('host:restart')).toBeNull();
  });

  it('builds the policy decision revision', () => {
    expect(policyDecisionRevision('autoMerge', '309ab8c40bf2')).toBe(
      'policy:autoMerge@309ab8c40bf2',
    );
  });

  it('parses a well-formed policy decision revision and rejects anything else', () => {
    expect(parsePolicyDecisionRevision('policy:autoMerge@309ab8c40bf2')).toEqual({
      source: 'autoMerge',
      revision: '309ab8c40bf2',
    });
    expect(parsePolicyDecisionRevision('policy:conductor@309ab8c40bf2')).toEqual({
      source: 'conductor',
      revision: '309ab8c40bf2',
    });
    expect(parsePolicyDecisionRevision('policy:autoMerge@XYZ')).toBeNull();
    expect(parsePolicyDecisionRevision('policy:other@309ab8c40bf2')).toBeNull();
    expect(parsePolicyDecisionRevision('decision-3')).toBeNull();
    expect(parsePolicyDecisionRevision(null)).toBeNull();
    expect(parsePolicyDecisionRevision(42)).toBeNull();
  });

  it('builds the canonical proposal digest', () => {
    expect(policyGrantProposalDigest('a1', HEAD, 'r1')).toBe(
      `policy-grant/v1:{"attemptId":"a1","expectedHeadSha":"${HEAD}","acceptanceReceiptId":"r1"}`,
    );
  });
});

describe('CoordinationRequest.fromRecord with a policyGrant', () => {
  it('round-trips a valid merge policy grant', () => {
    const record = requestRecord({ policyGrant: VALID_GRANT });
    const entity = CoordinationRequest.fromRecord(record);
    expect(entity.isPolicyGrant()).toBe(true);
    expect(entity.toRecord()).toEqual(record);
  });

  it('round-trips a valid push-to-pr grant under the conductor setting', () => {
    const record = requestRecord({
      actionScope: 'forge:push-to-pr',
      decisionRevision: 'policy:conductor@309ab8c40bf2',
      policyGrant: VALID_GRANT,
    });
    const entity = CoordinationRequest.fromRecord(record);
    expect(entity.isPolicyGrant()).toBe(true);
    expect(entity.toRecord()).toEqual(record);
  });

  it('returns a fresh policyGrant copy that mutation cannot reach', () => {
    const entity = CoordinationRequest.fromRecord(requestRecord({ policyGrant: VALID_GRANT }));
    const grant = entity.getPolicyGrant();
    expect(grant).toEqual(VALID_GRANT);
    if (grant !== null) {
      (grant as { workOrderId: string }).workOrderId = 'mutated-work-order';
    }
    expect(entity.getPolicyGrant()?.workOrderId).toBe('wo-example-a');
    expect(entity.toRecord().policyGrant?.workOrderId).toBe('wo-example-a');
  });

  it('round-trips a record without policyGrant with no key and isPolicyGrant false', () => {
    const record = requestRecord({ decisionRevision: 'decision-example-a' });
    const entity = CoordinationRequest.fromRecord(record);
    expect(entity.isPolicyGrant()).toBe(false);
    expect(entity.getPolicyGrant()).toBeNull();
    const out = entity.toRecord();
    expect(out).toEqual(record);
    expect(Object.hasOwn(out, 'policyGrant')).toBe(false);
  });

  it('drops a policyGrant key present with value undefined', () => {
    const record = requestRecord({ policyGrant: undefined });
    const out = CoordinationRequest.fromRecord(record).toRecord();
    expect(Object.hasOwn(out, 'policyGrant')).toBe(false);
  });
});

describe('CoordinationRequest.fromRecord rejects an invalid policyGrant', () => {
  const shapeError = 'CoordinationRequest policyGrant must be { workOrderId, attemptId, acceptanceReceiptId }';

  const invalidRows: ReadonlyArray<readonly [string, Partial<CoordinationRequestRecord>, string]> = [
    ['a null policyGrant', { policyGrant: null as unknown as PolicyGrantRecord }, shapeError],
    [
      'an array policyGrant',
      { policyGrant: [] as unknown as PolicyGrantRecord },
      shapeError,
    ],
    [
      'a policyGrant missing attemptId',
      {
        policyGrant: {
          workOrderId: 'wo-example-a',
          acceptanceReceiptId: 'receipt-example-a',
        } as unknown as PolicyGrantRecord,
      },
      shapeError,
    ],
    [
      'a policyGrant with an extra key',
      {
        policyGrant: {
          ...VALID_GRANT,
          extra: 'x',
        } as unknown as PolicyGrantRecord,
      },
      shapeError,
    ],
    [
      'a policyGrant with empty workOrderId',
      { policyGrant: { ...VALID_GRANT, workOrderId: '' } },
      shapeError,
    ],
    ['a relay kind', { kind: 'relay' }, 'CoordinationRequest policy grant must be an action-decision'],
    [
      'a non-policy decision revision',
      { decisionRevision: 'decision-3' },
      'CoordinationRequest policy grant must carry a policy decision revision',
    ],
    [
      'a null decision revision',
      { decisionRevision: null },
      'CoordinationRequest policy grant must carry a policy decision revision',
    ],
    [
      'a merge scope under the conductor setting',
      { decisionRevision: 'policy:conductor@309ab8c40bf2' },
      'CoordinationRequest policy grant scope does not match its setting',
    ],
    [
      'a push scope under the autoMerge setting',
      { actionScope: 'forge:push-to-pr' },
      'CoordinationRequest policy grant scope does not match its setting',
    ],
    [
      'an unrelated action scope',
      { actionScope: 'host:restart' },
      'CoordinationRequest policy grant scope does not match its setting',
    ],
    [
      'a null expected head',
      { expectedHeadSha: null },
      'CoordinationRequest policy grant requires an expected head',
    ],
  ];

  it.each(invalidRows)('rejects %s', (_label, overrides, message) => {
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: VALID_GRANT, ...overrides })),
    ).toThrow(message);
  });
});

describe('CoordinationRequest.fromRecord policy grant scope pairings', () => {
  it('pairs push-and-open-pr with the conductor setting', () => {
    const record = requestRecord({
      actionScope: 'forge:push-and-open-pr',
      decisionRevision: 'policy:conductor@309ab8c40bf2',
      policyGrant: VALID_GRANT,
    });
    const entity = CoordinationRequest.fromRecord(record);
    expect(entity.isPolicyGrant()).toBe(true);
    expect(entity.toRecord()).toEqual(record);
  });

  it('refuses push-and-open-pr paired with autoMerge', () => {
    expect(() =>
      CoordinationRequest.fromRecord(
        requestRecord({
          actionScope: 'forge:push-and-open-pr',
          policyGrant: VALID_GRANT,
        }),
      ),
    ).toThrow('CoordinationRequest policy grant scope does not match its setting');
  });
});

describe('CoordinationRequest.fromRecord refuses a hostile policyGrant', () => {
  it('refuses a grant whose field is a getter without running it', () => {
    let ran = false;
    const grant = { ...VALID_GRANT } as PolicyGrantRecord;
    Object.defineProperty(grant, 'workOrderId', {
      get() {
        ran = true;
        return 'wo-example-a';
      },
      enumerable: true,
      configurable: true,
    });
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant })),
    ).toThrow('Policy grant property must be an enumerable data property.');
    expect(ran).toBe(false);
  });

  it('refuses a grant with a custom prototype', () => {
    const grant = Object.assign(
      Object.create({ extra: true }) as object,
      VALID_GRANT,
    ) as PolicyGrantRecord;
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant })),
    ).toThrow(
      'CoordinationRequest policyGrant must only use Object.prototype or null as its prototype.',
    );
  });

  it('refuses a policy grant whose head is not a full commit id', () => {
    for (const head of ['abc', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
      expect(() =>
        CoordinationRequest.fromRecord(requestRecord({ expectedHeadSha: head, policyGrant: VALID_GRANT })),
      ).toThrow('CoordinationRequest policy grant requires an expected head');
    }
  });

  it('never runs a proxy get trap: values come from the descriptor snapshot', () => {
    let getTrapRan = false;
    const grant = new Proxy({ ...VALID_GRANT } as PolicyGrantRecord, {
      get() {
        getTrapRan = true;
        throw new Error('secret-get-text');
      },
    });
    const request = CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant }));
    expect(getTrapRan).toBe(false);
    expect(request.toRecord().policyGrant).toEqual(VALID_GRANT);
  });

  it('refuses a proxy whose ownKeys trap throws without leaking the message', () => {
    const grant = new Proxy({ ...VALID_GRANT } as PolicyGrantRecord, {
      ownKeys() {
        throw new Error('secret-ownkeys-text');
      },
    });
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant })),
    ).toThrow('PolicyGrant validation failed due to a prohibited Proxy trap execution.');
    let message = '';
    try {
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secret-ownkeys-text');
  });

  it('refuses a grant object with a symbol key', () => {
    const grant = { ...VALID_GRANT } as unknown as PolicyGrantRecord;
    (grant as unknown as Record<symbol, unknown>)[Symbol('hidden')] = 'x';
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant })),
    ).toThrow('Policy grant key must be a non-empty string.');
  });

  it('refuses a grant object with a non-enumerable key', () => {
    const grant = { ...VALID_GRANT } as unknown as PolicyGrantRecord;
    Object.defineProperty(grant, 'hidden', {
      value: 'x',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ policyGrant: grant })),
    ).toThrow('Policy grant property must be an enumerable data property.');
  });
});

describe('isPolicyGrantRecord', () => {
  it('is true for a policy-prefixed decision revision even without policyGrant', () => {
    expect(
      isPolicyGrantRecord(requestRecord({ decisionRevision: 'policy:autoMerge@309ab8c40bf2' })),
    ).toBe(true);
    expect(isPolicyGrantRecord(requestRecord({ decisionRevision: 'policy:autoMerge@nothex' }))).toBe(
      true,
    );
    expect(isPolicyGrantRecord(requestRecord({ decisionRevision: 'decision-example-a' }))).toBe(false);
  });
});
