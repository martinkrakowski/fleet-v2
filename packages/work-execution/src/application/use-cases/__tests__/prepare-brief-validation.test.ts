import { describe, expect, it, vi } from 'vitest';

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

  it('rejects a worktree path that is not absolute or is the filesystem root', async () => {
    const useCase = makeUseCase();

    for (const worktreePath of ['.', 'wt', '/', '//']) {
      const result = await useCase.prepareBriefPackage(validRequest({ worktreePath }));
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'worktreePath must be an absolute path that is not the filesystem root',
      });
    }
  });

  it('accepts an absolute non-root worktree path', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(validRequest({ worktreePath: '/wt' }));
    expect(result.outcome).not.toBe('rejected');
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
    const useCase = makeUseCase({ worktreePath: '/wt' });

    for (const [artifact, reason] of [
      ['/etc/passwd', 'expectedArtifacts entry is not a valid worktree-relative path: /etc/passwd'],
      ['../escape', 'expectedArtifacts entry is not a valid worktree-relative path: ../escape'],
      [
        'a/../../escape',
        'expectedArtifacts entry is not a valid worktree-relative path: a/../../escape',
      ],
      ['C:\\x', 'expectedArtifacts entry is not a valid worktree-relative path: C:\\x'],
    ] as const) {
      const result = await useCase.prepareBriefPackage(
        validRequest({ expectedArtifacts: [artifact] }),
      );
      expect(result).toEqual({ outcome: 'rejected', reason });
    }
  });

  it('rejects a non-string expectedArtifacts entry by name', async () => {
    const useCase = makeUseCase();

    const result = await useCase.prepareBriefPackage(
      validRequest({ expectedArtifacts: [42 as unknown as string] }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'expectedArtifacts entry is not a valid worktree-relative path: 42',
    });
  });

  it('does not call authorBrief on any rejection', async () => {
    const authorBrief = vi.fn(async () => {
      return {
        outcome: 'authored' as const,
        brief: {
          proseMarkdown: '# Frozen brief prose',
          provenance: 'orchestrator' as const,
        },
      };
    });
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: { authorBrief },
      artifactPort: makeArtifactPort(),
      worktreePath: '/wt',
    });

    await useCase.prepareBriefPackage(validRequest({ expectedArtifacts: undefined as unknown as string[] }));
    await useCase.prepareBriefPackage(validRequest({ expectedArtifacts: ['/etc/passwd'] }));
    await useCase.prepareBriefPackage(validRequest({ expectedArtifacts: ['../escape'] }));

    expect(authorBrief).not.toHaveBeenCalled();
  });

  it('satisfies the worktreePath requirement from deps when the request omits it', async () => {
    const useCase = makeUseCase({ worktreePath: '/wt' });
    const request = validRequest();
    delete (request as { worktreePath?: string }).worktreePath;
    const result = await useCase.prepareBriefPackage(request);

    expect(result.outcome).toBe('prepared');
    if (result.outcome === 'prepared') {
      expect(result.prepared.prosePath).toBe('.lane/brief.md');
      expect(result.prepared.manifestPath).toBe('.lane/brief-manifest.json');
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
