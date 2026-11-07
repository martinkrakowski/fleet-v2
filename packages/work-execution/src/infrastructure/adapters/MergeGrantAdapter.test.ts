import { describe, expect, it } from 'vitest';
import type {
  IssueMergeGrantPort,
  IssueMergeGrantRequest,
  IssueMergeGrantResult,
} from '@fleet/operator-coordination';
import type {
  MergeGrantRequest,
} from '../../application/ports/out/MergeGrantPort.out-port.js';
import { MERGE_GRANT_FORGE_KINDS } from '../../application/ports/out/MergeGrantPort.out-port.js';
import { MergeGrantAdapter } from './MergeGrantAdapter.adapter.js';

describe('MergeGrantPort contract and MergeGrantAdapter', () => {
  it('defines the forge kinds on the consumer contract', () => {
    expect(MERGE_GRANT_FORGE_KINDS).toEqual(['merge-pr', 'update-branch', 'post-status']);
  });

  it('maps consumer forge kinds correctly in attempt-less merge grants', async () => {
    const recordedCalls: IssueMergeGrantRequest[] = [];
    const mockIssueMergeGrant: Pick<IssueMergeGrantPort, 'issueMergeGrant'> = {
      issueMergeGrant: async (req: IssueMergeGrantRequest): Promise<IssueMergeGrantResult> => {
        recordedCalls.push(req);
        return {
          outcome: 'issued',
          requestId: 'req-1',
          grantId: 'grant-1',
          decisionRevision: `policy:merge@${req.settingRevision}`,
          cancelledGrantIds: [],
        };
      },
    };

    const adapter = new MergeGrantAdapter({
      issueMergeGrant: mockIssueMergeGrant,
    });

    for (const kind of ['merge-pr', 'update-branch', 'post-status'] as const) {
      const request: MergeGrantRequest = {
        kind: 'attempt-less',
        projectId: 'proj-1',
        repository: { owner: 'owner-1', repo: 'repo-1' },
        pullRequestNumber: 10,
        expectedHeadSha: '1111111111111111111111111111111111111111',
        forgeKind: kind,
        settingRevision: 'aaaaaaaaaaaa',
        deadlineIso: '2026-11-02T01:00:00.000Z',
      };

      const result = await adapter.issueMergeGrant(request);
      expect(result.outcome).toBe('issued');
    }

    expect(recordedCalls).toHaveLength(3);
    expect(recordedCalls[0].forgeKind).toBe('merge-pr');
    expect(recordedCalls[1].forgeKind).toBe('update-branch');
    expect(recordedCalls[2].forgeKind).toBe('post-status');
  });

  it('returns refused when delegate is not configured', async () => {
    const adapter = new MergeGrantAdapter();
    const request: MergeGrantRequest = {
      kind: 'attempt-less',
      projectId: 'proj-1',
      repository: { owner: 'owner-1', repo: 'repo-1' },
      pullRequestNumber: 10,
      expectedHeadSha: '1111111111111111111111111111111111111111',
      forgeKind: 'merge-pr',
      settingRevision: 'aaaaaaaaaaaa',
      deadlineIso: '2026-11-02T01:00:00.000Z',
    };

    const result = await adapter.issueMergeGrant(request);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('not-configured');
    }
  });

  it('propagates superseded and refused outcomes from delegate', async () => {
    const mockIssueMergeGrant: Pick<IssueMergeGrantPort, 'issueMergeGrant'> = {
      issueMergeGrant: async (req: IssueMergeGrantRequest): Promise<IssueMergeGrantResult> => {
        if (req.pullRequestNumber === 1) {
          return {
            outcome: 'superseded',
            requestId: 'req-s',
            grantId: 'grant-s',
            cancelledGrantIds: ['grant-s'],
            unresolvedGrantIds: [],
          };
        }
        return {
          outcome: 'refused',
          reason: 'custom refusal reason',
        };
      },
    };

    const adapter = new MergeGrantAdapter({
      issueMergeGrant: mockIssueMergeGrant,
    });

    const resSuperseded = await adapter.issueMergeGrant({
      kind: 'attempt-less',
      projectId: 'proj-1',
      repository: { owner: 'owner-1', repo: 'repo-1' },
      pullRequestNumber: 1,
      expectedHeadSha: '1111111111111111111111111111111111111111',
      forgeKind: 'merge-pr',
      settingRevision: 'aaaaaaaaaaaa',
      deadlineIso: '2026-11-02T01:00:00.000Z',
    });
    expect(resSuperseded.outcome).toBe('superseded');

    const resRefused = await adapter.issueMergeGrant({
      kind: 'attempt-less',
      projectId: 'proj-1',
      repository: { owner: 'owner-1', repo: 'repo-1' },
      pullRequestNumber: 2,
      expectedHeadSha: '1111111111111111111111111111111111111111',
      forgeKind: 'merge-pr',
      settingRevision: 'aaaaaaaaaaaa',
      deadlineIso: '2026-11-02T01:00:00.000Z',
    });
    expect(resRefused.outcome).toBe('refused');
    if (resRefused.outcome === 'refused') {
      expect(resRefused.reason).toBe('custom refusal reason');
    }
  });
});
