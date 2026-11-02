import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord, MergeGrantRecord } from '../coordination-records.js';
import { CoordinationRequest } from '../entities/CoordinationRequest.js';
import {
  isPolicyGrantRecord,
  mergeGrantActionScope,
  mergeGrantDecisionRevision,
  mergeGrantProposalDigest,
} from '../policy-grants.js';

const HEAD = 'a'.repeat(40);
const NOW_ISO = '2026-10-27T00:00:00.000Z';
const VALID_MERGE_GRANT: MergeGrantRecord = {
  repository: { owner: 'acme', repo: 'widgets' },
  pullRequestNumber: 12,
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
    policyRevision: '309ab8c40bf2',
    decisionRevision: 'policy:merge@309ab8c40bf2',
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

describe('merge-grant helpers', () => {
  it('builds the forge action scope', () => {
    expect(mergeGrantActionScope('merge-pr')).toBe('forge:merge-pr');
    expect(mergeGrantActionScope('update-branch')).toBe('forge:update-branch');
    expect(mergeGrantActionScope('post-status')).toBe('forge:post-status');
  });

  it('builds the policy:merge decision revision', () => {
    expect(mergeGrantDecisionRevision('309ab8c40bf2')).toBe('policy:merge@309ab8c40bf2');
  });

  it('builds the canonical proposal digest with exactly the merge-grant key order', () => {
    expect(mergeGrantProposalDigest({ owner: 'acme', repo: 'widgets' }, 12, HEAD)).toBe(
      `merge-grant/v1:{"owner":"acme","repo":"widgets","pullRequestNumber":12,"expectedHeadSha":"${HEAD}"}`,
    );
  });

  it('is skipped by the no-id resolve rule through its policy-prefixed decision revision', () => {
    expect(isPolicyGrantRecord(requestRecord({ mergeGrant: VALID_MERGE_GRANT }))).toBe(true);
  });
});

describe('CoordinationRequest.fromRecord with a mergeGrant', () => {
  it('round-trips a valid merge grant', () => {
    const record = requestRecord({ mergeGrant: VALID_MERGE_GRANT });
    const entity = CoordinationRequest.fromRecord(record);
    expect(entity.getMergeGrant()).toEqual(VALID_MERGE_GRANT);
    expect(entity.toRecord()).toEqual(record);
  });

  it('returns a fresh mergeGrant copy that mutation cannot reach', () => {
    const entity = CoordinationRequest.fromRecord(
      requestRecord({ mergeGrant: VALID_MERGE_GRANT }),
    );
    const grant = entity.getMergeGrant();
    expect(grant).toEqual(VALID_MERGE_GRANT);
    if (grant !== null) {
      (grant.repository as { owner: string }).owner = 'mutated-owner';
      (grant as { pullRequestNumber: number }).pullRequestNumber = 99;
    }
    expect(entity.getMergeGrant()?.repository.owner).toBe('acme');
    expect(entity.getMergeGrant()?.pullRequestNumber).toBe(12);
    expect(entity.toRecord().mergeGrant?.repository.owner).toBe('acme');
  });

  it('round-trips a record without mergeGrant with no key', () => {
    const record = requestRecord({ decisionRevision: 'decision-example-a' });
    const entity = CoordinationRequest.fromRecord(record);
    expect(entity.getMergeGrant()).toBeNull();
    const out = entity.toRecord();
    expect(out).toEqual(record);
    expect(Object.hasOwn(out, 'mergeGrant')).toBe(false);
  });

  it('drops a mergeGrant key present with value undefined', () => {
    const record = requestRecord({ mergeGrant: undefined });
    const out = CoordinationRequest.fromRecord(record).toRecord();
    expect(Object.hasOwn(out, 'mergeGrant')).toBe(false);
  });
});

describe('CoordinationRequest.fromRecord rejects an invalid mergeGrant', () => {
  const shapeError = 'CoordinationRequest mergeGrant must be { repository, pullRequestNumber }';
  const repoShapeError = 'CoordinationRequest mergeGrant repository must be { owner, repo }';
  const prError = 'CoordinationRequest mergeGrant pullRequestNumber must be a positive safe integer';

  const invalidRows: ReadonlyArray<readonly [string, Partial<CoordinationRequestRecord>, string]> = [
    ['a null mergeGrant', { mergeGrant: null as unknown as MergeGrantRecord }, shapeError],
    ['an array mergeGrant', { mergeGrant: [] as unknown as MergeGrantRecord }, shapeError],
    [
      'a mergeGrant missing pullRequestNumber',
      { mergeGrant: { repository: { owner: 'acme', repo: 'widgets' } } as unknown as MergeGrantRecord },
      shapeError,
    ],
    [
      'a mergeGrant with an extra key',
      { mergeGrant: { ...VALID_MERGE_GRANT, extra: 'x' } as unknown as MergeGrantRecord },
      shapeError,
    ],
    ['a mergeGrant whose repository is a string', { mergeGrant: { ...VALID_MERGE_GRANT, repository: 'acme/widgets' } as unknown as MergeGrantRecord }, repoShapeError],
    [
      'a mergeGrant repository missing repo',
      { mergeGrant: { repository: { owner: 'acme' }, pullRequestNumber: 12 } as unknown as MergeGrantRecord },
      repoShapeError,
    ],
    [
      'a mergeGrant repository with an empty owner',
      { mergeGrant: { repository: { owner: '   ', repo: 'widgets' }, pullRequestNumber: 12 } as unknown as MergeGrantRecord },
      repoShapeError,
    ],
    ['a zero pullRequestNumber', { mergeGrant: { ...VALID_MERGE_GRANT, pullRequestNumber: 0 } }, prError],
    ['a negative pullRequestNumber', { mergeGrant: { ...VALID_MERGE_GRANT, pullRequestNumber: -3 } }, prError],
    ['a fractional pullRequestNumber', { mergeGrant: { ...VALID_MERGE_GRANT, pullRequestNumber: 1.5 } }, prError],
    ['a string pullRequestNumber', { mergeGrant: { ...VALID_MERGE_GRANT, pullRequestNumber: '12' as unknown as number } }, prError],
  ];

  it.each(invalidRows)('rejects %s', (_label, overrides, message) => {
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: VALID_MERGE_GRANT, ...overrides })),
    ).toThrow(message);
  });
});

describe('CoordinationRequest.fromRecord refuses a hostile mergeGrant', () => {
  it('refuses a mergeGrant whose field is a getter without running it', () => {
    let ran = false;
    const grant = { ...VALID_MERGE_GRANT } as MergeGrantRecord;
    Object.defineProperty(grant, 'repository', {
      get() {
        ran = true;
        return { owner: 'acme', repo: 'widgets' };
      },
      enumerable: true,
      configurable: true,
    });
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: grant })),
    ).toThrow('Merge grant mergeGrant property must be an enumerable data property.');
    expect(ran).toBe(false);
  });

  it('refuses a mergeGrant whose repository field is a getter without running it', () => {
    let ran = false;
    const repository = { owner: 'acme', repo: 'widgets' };
    Object.defineProperty(repository, 'owner', {
      get() {
        ran = true;
        return 'acme';
      },
      enumerable: true,
      configurable: true,
    });
    const grant = { repository, pullRequestNumber: 12 } as MergeGrantRecord;
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: grant })),
    ).toThrow('Merge grant mergeGrant repository property must be an enumerable data property.');
    expect(ran).toBe(false);
  });

  it('refuses a mergeGrant with a custom prototype', () => {
    const grant = Object.assign(
      Object.create({ extra: true }) as object,
      VALID_MERGE_GRANT,
    ) as MergeGrantRecord;
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: grant })),
    ).toThrow(
      'CoordinationRequest mergeGrant must only use Object.prototype or null as its prototype.',
    );
  });

  it('refuses a mergeGrant whose repository has a custom prototype', () => {
    const repository = Object.assign(
      Object.create({ extra: true }) as object,
      { owner: 'acme', repo: 'widgets' },
    );
    const grant = { repository, pullRequestNumber: 12 } as unknown as MergeGrantRecord;
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: grant })),
    ).toThrow(
      'CoordinationRequest mergeGrant repository must only use Object.prototype or null as its prototype.',
    );
  });

  it('refuses a mergeGrant descriptor that is an accessor property', () => {
    const record = requestRecord();
    Object.defineProperty(record, 'mergeGrant', {
      get() {
        return VALID_MERGE_GRANT;
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => CoordinationRequest.fromRecord(record)).toThrow(
      'CoordinationRequest mergeGrant cannot be an accessor property.',
    );
  });

  it('refuses a mergeGrant object with a symbol key', () => {
    const grant = { ...VALID_MERGE_GRANT } as unknown as MergeGrantRecord;
    (grant as unknown as Record<symbol, unknown>)[Symbol('hidden')] = 'x';
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: grant })),
    ).toThrow('Merge grant mergeGrant key must be a non-empty string.');
  });

  it('refuses a mergeGrant object with a non-enumerable key', () => {
    const grant = { ...VALID_MERGE_GRANT } as unknown as MergeGrantRecord;
    Object.defineProperty(grant, 'hidden', {
      value: 'x',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(() =>
      CoordinationRequest.fromRecord(requestRecord({ mergeGrant: grant })),
    ).toThrow('Merge grant mergeGrant property must be an enumerable data property.');
  });
});
