// ConductorForgeGrantAdapter tests (K6-2): issue mappings from the supplier's
// IssuePolicyForgeGrantPort with source 'conductor', the refusal codes, and
// the never-merge guarantee.

import { describe, expect, it } from 'vitest';

import {
  ConductorForgeGrantAdapter,
  type ConductorForgeGrantIssueRequest,
  type ConductorForgeGrantIssueResult,
} from '../ConductorForgeGrantAdapter.adapter.js';
import type { ConductorForgeGrantRequest } from '../../../application/ports/out/ConductorForgeGrantPort.out-port.js';

const REVISION = '0123456789ab';
const EXPECTED_DECISION_REVISION = `policy:conductor@${REVISION}`;
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const GRANT_ID = 'grant-1';

function conductorRequest(
  overrides: Partial<ConductorForgeGrantRequest> = {},
): ConductorForgeGrantRequest {
  return {
    projectId: 'proj-1',
    workOrderId: 'wo-1',
    attemptId: 'att-1',
    forgeKind: 'push-and-open-pr',
    expectedHeadSha: HEAD_SHA,
    policyRevision: 'pol-1',
    acceptanceReceiptId: 'receipt-1',
    ...overrides,
  };
}

function issued(): ConductorForgeGrantIssueResult {
  return {
    outcome: 'issued',
    grantId: GRANT_ID,
    decisionRevision: EXPECTED_DECISION_REVISION,
  };
}

function makeDelegate(overrides: {
  issue?: ((
    request: ConductorForgeGrantIssueRequest,
  ) => Promise<ConductorForgeGrantIssueResult>) | null;
  conductorRevision?: (() => string | null) | null;
} = {}) {
  const issue = 'issue' in overrides
    ? (overrides.issue ?? undefined)
    : async (_request: ConductorForgeGrantIssueRequest): Promise<ConductorForgeGrantIssueResult> =>
        issued();
  const conductorRevision = 'conductorRevision' in overrides
    ? (overrides.conductorRevision ?? undefined)
    : () => REVISION;
  return { issue, conductorRevision };
}

describe('ConductorForgeGrantAdapter', () => {
  it('issues a push-and-open-pr grant with source conductor and the current revision', async () => {
    const seen: ConductorForgeGrantIssueRequest[] = [];
    const delegate = makeDelegate({
      issue: async (request) => {
        seen.push(request);
        return issued();
      },
    });
    const adapter = new ConductorForgeGrantAdapter(delegate);

    const result = await adapter.issueConductorForgeGrant(conductorRequest());

    expect(result).toEqual({
      outcome: 'issued',
      grantId: GRANT_ID,
      decisionRevision: EXPECTED_DECISION_REVISION,
    });
    expect(seen).toEqual([
      {
        projectId: 'proj-1',
        workOrderId: 'wo-1',
        attemptId: 'att-1',
        forgeKind: 'push-and-open-pr',
        expectedHeadSha: HEAD_SHA,
        policyRevision: 'pol-1',
        acceptanceReceiptId: 'receipt-1',
        source: 'conductor',
        settingRevision: REVISION,
      },
    ]);
  });

  it('issues a push-to-pr grant with the same mapping', async () => {
    const delegate = makeDelegate();
    const adapter = new ConductorForgeGrantAdapter(delegate);

    const result = await adapter.issueConductorForgeGrant(
      conductorRequest({ forgeKind: 'push-to-pr' }),
    );

    expect(result).toEqual({
      outcome: 'issued',
      grantId: GRANT_ID,
      decisionRevision: EXPECTED_DECISION_REVISION,
    });
  });

  it('issues a post-status grant with source conductor', async () => {
    const seen: ConductorForgeGrantIssueRequest[] = [];
    const delegate = makeDelegate({
      issue: async (request) => {
        seen.push(request);
        return issued();
      },
    });
    const adapter = new ConductorForgeGrantAdapter(delegate);

    const result = await adapter.issueConductorForgeGrant(
      conductorRequest({ forgeKind: 'post-status' }),
    );

    expect(result).toEqual({
      outcome: 'issued',
      grantId: GRANT_ID,
      decisionRevision: EXPECTED_DECISION_REVISION,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.forgeKind).toBe('post-status');
    expect(seen[0]!.source).toBe('conductor');
  });

  it('refuses not-configured without a delegate', async () => {
    const adapter = new ConductorForgeGrantAdapter();
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured' });
  });

  it('refuses not-configured when only issue is bound', async () => {
    const adapter = new ConductorForgeGrantAdapter(makeDelegate({ conductorRevision: undefined }));
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured' });
  });

  it('refuses not-configured when only conductorRevision is bound', async () => {
    const adapter = new ConductorForgeGrantAdapter(makeDelegate({ issue: undefined }));
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured' });
  });

  it('refuses not-configured when conductorRevision returns null', async () => {
    const adapter = new ConductorForgeGrantAdapter(makeDelegate({ conductorRevision: () => null }));
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured' });
  });

  it('refuses unreadable when the issue delegate throws', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        issue: async () => {
          throw new Error('policy store exploded');
        },
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'unreadable' });
  });

  it('refuses unreadable when conductorRevision throws', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        conductorRevision: () => {
          throw new Error('policy unreadable');
        },
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'unreadable' });
  });

  it('refuses unreadable when conductorRevision returns a malformed revision', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({ conductorRevision: () => 'not-a-revision' }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'unreadable' });
  });

  it('refuses mismatch when the issued decisionRevision does not match policy:conductor@<rev>', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        issue: async () => ({
          outcome: 'issued' as const,
          grantId: GRANT_ID,
          decisionRevision: 'policy:conductor@aaaaaaaaaaaa',
        }),
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'mismatch' });
  });

  it('refuses mismatch when the issued decisionRevision names another source', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        issue: async () => ({
          outcome: 'issued' as const,
          grantId: GRANT_ID,
          decisionRevision: `policy:autoMerge@${REVISION}`,
        }),
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'mismatch' });
  });

  it('passes through a supplier refusal with its reason', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        issue: async () => ({ outcome: 'refused', reason: 'grant scope does not match' }),
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'grant scope does not match' });
  });

  it('maps a superseded grant to refused', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        issue: async () => ({
          outcome: 'superseded',
          grantId: GRANT_ID,
          cancelledGrantIds: [],
          unresolvedGrantIds: [],
        }),
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'superseded' });
  });

  it('refuses unreadable for a malformed supplier answer', async () => {
    const adapter = new ConductorForgeGrantAdapter(
      makeDelegate({
        issue: async () => ({ outcome: 'weird' }) as unknown as ConductorForgeGrantIssueResult,
      }),
    );
    const result = await adapter.issueConductorForgeGrant(conductorRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'unreadable' });
  });

  it('validates the request before calling the delegate', async () => {
    let called = false;
    const delegate = makeDelegate({
      issue: async (_request) => {
        called = true;
        return issued();
      },
    });
    const adapter = new ConductorForgeGrantAdapter(delegate);

    const mergeKind = await adapter.issueConductorForgeGrant(
      conductorRequest({ forgeKind: 'merge-pr' as never }),
    );
    expect(mergeKind.outcome).toBe('refused');
    expect(mergeKind.outcome === 'refused' && mergeKind.reason).toContain('forgeKind');

    const missingProject = await adapter.issueConductorForgeGrant(
      conductorRequest({ projectId: '' }),
    );
    expect(missingProject.outcome).toBe('refused');
    expect(missingProject.outcome === 'refused' && missingProject.reason).toContain('projectId');

    const badHead = await adapter.issueConductorForgeGrant(
      conductorRequest({ expectedHeadSha: 'not-a-commit' }),
    );
    expect(badHead.outcome).toBe('refused');
    expect(badHead.outcome === 'refused' && badHead.reason).toContain('expectedHeadSha');

    expect(called).toBe(false);
  });
});
