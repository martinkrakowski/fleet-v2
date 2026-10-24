import { describe, expect, it } from 'vitest';

import {
  PrepareBriefPackageUseCase,
  type PrepareBriefPackageUseCaseRequest,
} from '../PrepareBriefPackageUseCase.use-case.js';
import type { BriefAuthoringPort } from '../../ports/out/BriefAuthoringPort.out-port.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';

function makeBriefAuthoring(): BriefAuthoringPort {
  return {
    async authorBrief() {
      return {
        outcome: 'authored',
        brief: {
          proseMarkdown: '# Frozen brief prose',
          provenance: 'orchestrator',
        },
      };
    },
  };
}

function makeArtifactPort(): AttemptArtifactPort {
  return {
    async verifyIgnoredPaths(request) {
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief() {
      return {
        outcome: 'placed',
        prosePath: '.lane/brief.md',
        manifestPath: '.lane/brief-manifest.json',
      };
    },
    async collectCompletedAttemptArtifacts() {
      return {
        outcome: 'collected',
        artifacts: {
          headCommit: 'head456',
          commitsSinceBase: ['commit-1'],
          collectedArtifactPaths: ['dist/report.json'],
          notes: 'present',
        },
      };
    },
  };
}

function validRequest(overrides: Partial<PrepareBriefPackageUseCaseRequest> = {}): PrepareBriefPackageUseCaseRequest {
  return {
    workOrderId: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    policyRevision: 'policy-7',
    modelAssignment: {
      model: 'implementer-model',
      variant: 'default',
      fallbackModel: 'fallback-model',
      seatTool: 'opencode',
    },
    independentReviewer: 'reviewer-model',
    ownedPaths: ['packages/app-a/**'],
    permissions: ['filesystem:worktree'],
    acceptanceChecks: ['yarn test'],
    stepLimit: 40,
    timeLimitSeconds: 3600,
    resourceBounds: { cpu: '2' },
    expectedArtifacts: [],
    ownerDecisionReferences: ['decision-1'],
    contextDecisions: [
      {
        proposalId: 'p-1',
        knowledgeEntryId: 'ke-1',
        version: 'v1',
        proposedBecause: 'lexical match',
        accepted: true,
        decisionBecause: 'applicable to this lane',
      },
    ],
    worktreePath: '/wt',
    ...overrides,
  };
}

function makeUseCase(deps: { worktreePath?: string } = {}) {
  return new PrepareBriefPackageUseCase({
    briefAuthoring: makeBriefAuthoring(),
    artifactPort: makeArtifactPort(),
    ...deps,
  });
}

describe('PrepareBriefPackageUseCase path validation', () => {
  it('rejects when worktreePath is missing from the request and deps', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(validRequest({ worktreePath: undefined }));

    expect(result).toEqual({ outcome: 'rejected', reason: 'worktreePath is required' });
  });

  it('rejects when worktreePath is not a non-empty string', async () => {
    const useCase = makeUseCase();

    for (const worktreePath of ['', '   ', 0, null, true]) {
      const result = await useCase.prepareBriefPackage(
        validRequest({ worktreePath: worktreePath as unknown as string }),
      );
      expect(result).toEqual({ outcome: 'rejected', reason: 'worktreePath is required' });
    }
  });

  it('rejects when expectedArtifacts is not an array', async () => {
    const useCase = makeUseCase();

    for (const expectedArtifacts of [undefined, 'x', { 0: 'x' }, 7]) {
      const result = await useCase.prepareBriefPackage(
        validRequest({ expectedArtifacts: expectedArtifacts as unknown as string[] }),
      );
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'expectedArtifacts must be an array of strings',
      });
    }
  });

  it('rejects when an expectedArtifacts entry escapes the worktree', async () => {
    const useCase = makeUseCase();

    for (const artifact of ['/etc/passwd', '../escape', 'a/../../escape', 'C:\\x', 42]) {
      const result = await useCase.prepareBriefPackage(
        validRequest({ expectedArtifacts: [artifact as unknown as string] }),
      );
      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain('expectedArtifacts entry');
        expect(result.reason).toContain(String(artifact));
      }
    }
  });

  it('prepares a brief for a valid request with an explicit worktreePath', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(validRequest());

    expect(result.outcome).toBe('prepared');
    if (result.outcome === 'prepared') {
      expect(result.prepared.prosePath).toBe('.lane/brief.md');
      expect(result.prepared.manifestPath).toBe('.lane/brief-manifest.json');
    }
  });
});
