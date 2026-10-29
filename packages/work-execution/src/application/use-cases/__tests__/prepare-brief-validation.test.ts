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
    acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
    allowedPathPrefixes: ['packages/app-a'],
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

function makeCapturingArtifactPort(): { port: AttemptArtifactPort; placedManifestJsons: string[] } {
  const placedManifestJsons: string[] = [];
  const port: AttemptArtifactPort = {
    async verifyIgnoredPaths(request) {
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief(request) {
      placedManifestJsons.push(request.manifestJson);
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
  return { port, placedManifestJsons };
}

describe('PrepareBriefPackageUseCase acceptance spec (S2a)', () => {
  it('rejects a request without an acceptance spec', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(validRequest({ acceptanceSpec: undefined }));

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'acceptanceSpec is required: commitRequired, diffCheck and at least one command',
    });
  });

  it('rejects an acceptance spec with a shell-string command', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({
        acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn build'] }] },
      }),
    );

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'AcceptanceSpec command 1 looks like a shell string; give each argument its own argv entry',
    });
  });

  it('rejects a package without allowed path prefixes', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(validRequest({ allowedPathPrefixes: [] }));

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'allowedPathPrefixes is required: the acceptance spec diff check refuses every changed path outside them',
    });
  });

  it('freezes the acceptance spec into the placed manifest', async () => {
    const captured = makeCapturingArtifactPort();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring(),
      artifactPort: captured.port,
    });

    const result = await useCase.prepareBriefPackage(validRequest());
    expect(result.outcome).toBe('prepared');
    expect(captured.placedManifestJsons).toHaveLength(1);
    const manifest = JSON.parse(captured.placedManifestJsons[0]) as { acceptanceSpec?: unknown };
    expect(manifest.acceptanceSpec).toEqual({
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ['corepack', 'yarn', 'build'] }],
    });
  });

  it('covers the acceptance spec in the brief digest', async () => {
    const useCase = makeUseCase();
    const first = await useCase.prepareBriefPackage(validRequest());
    const second = await useCase.prepareBriefPackage(
      validRequest({
        acceptanceSpec: {
          commitRequired: true,
          diffCheck: true,
          commands: [{ argv: ['corepack', 'yarn', 'build:prod'] }],
        },
      }),
    );

    expect(first.outcome).toBe('prepared');
    expect(second.outcome).toBe('prepared');
    if (first.outcome === 'prepared' && second.outcome === 'prepared') {
      expect(first.prepared.briefDigest).not.toBe(second.prepared.briefDigest);
    }
  });

  it('does not call authorBrief on any acceptance-spec rejection', async () => {
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

    await useCase.prepareBriefPackage(validRequest({ acceptanceSpec: undefined }));
    await useCase.prepareBriefPackage(
      validRequest({
        acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn build'] }] },
      }),
    );
    await useCase.prepareBriefPackage(validRequest({ allowedPathPrefixes: [] }));

    expect(authorBrief).not.toHaveBeenCalled();
  });
});

function makeProseCapturingArtifactPort(): { port: AttemptArtifactPort; placedProseMarkdowns: string[] } {
  const placedProseMarkdowns: string[] = [];
  const port: AttemptArtifactPort = {
    async verifyIgnoredPaths(request) {
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief(request) {
      placedProseMarkdowns.push(request.proseMarkdown);
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
  return { port, placedProseMarkdowns };
}

describe('PrepareBriefPackageUseCase proseMarkdown (KF-6)', () => {
  it('skips authoring and places the supplied prose when proseMarkdown is present', async () => {
    const authorBrief = vi.fn(async () => {
      return {
        outcome: 'authored' as const,
        brief: {
          proseMarkdown: '# Frozen brief prose',
          provenance: 'orchestrator' as const,
        },
      };
    });
    const captured = makeProseCapturingArtifactPort();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: { authorBrief },
      artifactPort: captured.port,
      worktreePath: '/wt',
    });

    const prose = '# Fix round 1 handover';
    const result = await useCase.prepareBriefPackage(validRequest({ proseMarkdown: prose }));
    expect(result.outcome).toBe('prepared');
    if (result.outcome === 'prepared') {
      expect(result.prepared.prosePath).toBe('.lane/brief.md');
    }
    expect(captured.placedProseMarkdowns).toEqual([prose]);
    expect(authorBrief).not.toHaveBeenCalled();
  });

  it('covers the supplied prose in the brief digest', async () => {
    const useCase = makeUseCase();
    const first = await useCase.prepareBriefPackage(validRequest({ proseMarkdown: '# Fix round 1' }));
    const second = await useCase.prepareBriefPackage(validRequest({ proseMarkdown: '# Fix round 2' }));

    expect(first.outcome).toBe('prepared');
    expect(second.outcome).toBe('prepared');
    if (first.outcome === 'prepared' && second.outcome === 'prepared') {
      expect(first.prepared.briefDigest).not.toBe(second.prepared.briefDigest);
    }
  });

  it('rejects an empty proseMarkdown', async () => {
    const useCase = makeUseCase();

    for (const proseMarkdown of ['', '   ', 0, null, true]) {
      const result = await useCase.prepareBriefPackage(
        validRequest({ proseMarkdown: proseMarkdown as unknown as string }),
      );
      expect(result).toEqual({ outcome: 'rejected', reason: 'proseMarkdown must be a non-empty string' });
    }
  });

  it('rejects a secret-shaped proseMarkdown', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({ proseMarkdown: 'ghp_' + 'A'.repeat(20) }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'proseMarkdown contains a secret-shaped value and was refused',
    });
  });

  it('rejects a proseMarkdown over 64 KiB', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({ proseMarkdown: 'x'.repeat(64 * 1024 + 1) }),
    );
    expect(result).toEqual({ outcome: 'rejected', reason: 'proseMarkdown must be at most 64 KiB' });
  });
});

describe('PrepareBriefPackageUseCase runner agent (KF-7)', () => {
  const agentSeatPlan = {
    version: 1 as const,
    'first-pass': [{ id: 'fp-1', model: 'implementer-model', tool: 'opencode', agent: 'lane' }],
    fix: [{ id: 'fx-1', model: 'implementer-model', tool: 'opencode' }],
    review: [],
  };

  it('accepts and freezes an assignment whose agent matches its first-pass seat', async () => {
    const captured = makeCapturingArtifactPort();
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring(),
      artifactPort: captured.port,
    });

    const result = await useCase.prepareBriefPackage(
      validRequest({
        seatPlan: agentSeatPlan,
        modelAssignment: {
          ...validRequest().modelAssignment,
          agent: 'lane',
        },
      }),
    );
    expect(result.outcome).toBe('prepared');
    expect(captured.placedManifestJsons).toHaveLength(1);
    const manifest = JSON.parse(captured.placedManifestJsons[0]) as { modelAssignment?: unknown };
    expect(manifest.modelAssignment).toMatchObject({ agent: 'lane' });
  });

  it('rejects an invalid model assignment agent', async () => {
    const useCase = makeUseCase();

    for (const agent of ['', '   ', 'a'.repeat(65), 'lane-glm!', '-lane', 5]) {
      const result = await useCase.prepareBriefPackage(
        validRequest({
          modelAssignment: { ...validRequest().modelAssignment, agent: agent as unknown as string },
        }),
      );
      expect(result).toEqual({
        outcome: 'rejected',
        reason:
          'Model assignment agent must be a non-empty string of at most 64 characters matching [A-Za-z0-9][A-Za-z0-9._-]*',
      });
    }
  });
});
