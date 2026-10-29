/**
 * Lane K6-0 (D7): frozen PR notes in the brief package. Tests the optional
 * `prNotes` request field — validation per section (non-empty string ≤ 4000
 * characters, no secret shape), freezing into the manifest under `prNotes`,
 * digest coverage, and manual prepare without notes staying unchanged.
 * The conducted-start refusal (`pr-notes-missing`) is covered in
 * `start-lane-run.test.ts`.
 */

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

const VALID_NOTES = {
  hardToUndo: 'The conductor opens the PR and merges it automatically',
  assumptions: 'The base branch is main and CI passes',
  challengeThis: 'That the merge train is safe without a reviewer on the final diff',
};

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
    contextDecisions: [],
    worktreePath: '/wt',
    ...overrides,
  };
}

function makeUseCase(artifactPort: AttemptArtifactPort = makeArtifactPort()) {
  return new PrepareBriefPackageUseCase({
    briefAuthoring: makeBriefAuthoring(),
    artifactPort,
  });
}

describe('PrepareBriefPackageUseCase pr notes (K6-0, D7)', () => {
  it('freezes valid prNotes into the placed manifest under the key prNotes and reads them back', async () => {
    const captured = makeCapturingArtifactPort();
    const useCase = makeUseCase(captured.port);
    const result = await useCase.prepareBriefPackage(
      validRequest({ prNotes: VALID_NOTES }),
    );

    expect(result.outcome).toBe('prepared');
    expect(captured.placedManifestJsons).toHaveLength(1);
    const manifest = JSON.parse(captured.placedManifestJsons[0]) as { prNotes?: unknown };
    expect(manifest.prNotes).toEqual(VALID_NOTES);
  });

  it('freezes exactly the three PR-note sections, never extra request keys', async () => {
    const captured = makeCapturingArtifactPort();
    const useCase = makeUseCase(captured.port);
    await useCase.prepareBriefPackage(
      validRequest({
        prNotes: {
          hardToUndo: 'a',
          assumptions: 'b',
          challengeThis: 'c',
          extra: 'not frozen',
        } as unknown as PrepareBriefPackageUseCaseRequest['prNotes'],
      }),
    );

    const manifest = JSON.parse(captured.placedManifestJsons[0]) as { prNotes?: Record<string, unknown> };
    expect(manifest.prNotes).toEqual({ hardToUndo: 'a', assumptions: 'b', challengeThis: 'c' });
  });

  it('covers prNotes in the brief digest', async () => {
    const useCase = makeUseCase();
    const first = await useCase.prepareBriefPackage(validRequest({ prNotes: VALID_NOTES }));
    const second = await useCase.prepareBriefPackage(
      validRequest({
        prNotes: { ...VALID_NOTES, assumptions: 'The base branch is trunk' },
      }),
    );

    expect(first.outcome).toBe('prepared');
    expect(second.outcome).toBe('prepared');
    if (first.outcome === 'prepared' && second.outcome === 'prepared') {
      expect(first.prepared.briefDigest).not.toBe(second.prepared.briefDigest);
    }
  });

  it('keeps manual prepare without prNotes working and leaves the manifest unchanged', async () => {
    const captured = makeCapturingArtifactPort();
    const useCase = makeUseCase(captured.port);
    const result = await useCase.prepareBriefPackage(validRequest());

    expect(result.outcome).toBe('prepared');
    const manifest = JSON.parse(captured.placedManifestJsons[0]) as Record<string, unknown>;
    expect('prNotes' in manifest).toBe(false);
  });

  it('does not call authorBrief on any prNotes rejection', async () => {
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

    await useCase.prepareBriefPackage(validRequest({ prNotes: 'not-an-object' as unknown as PrepareBriefPackageUseCaseRequest['prNotes'] }));
    await useCase.prepareBriefPackage(validRequest({ prNotes: { hardToUndo: '', assumptions: 'b', challengeThis: 'c' } }));
    await useCase.prepareBriefPackage(validRequest({ prNotes: { hardToUndo: 'a', assumptions: 'b', challengeThis: 'ghp_' + 'A'.repeat(20) } }));

    expect(authorBrief).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'not-an-object'],
    ['an array', ['a', 'b']],
    ['null', null],
  ] as const)('rejects prNotes that is %s', async (_label, notes) => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({ prNotes: notes as unknown as PrepareBriefPackageUseCaseRequest['prNotes'] }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'prNotes must be an object with hardToUndo, assumptions and challengeThis',
    });
  });

  it.each([
    ['hardToUndo', { assumptions: 'b', challengeThis: 'c' }],
    ['assumptions', { hardToUndo: 'a', challengeThis: 'c' }],
    ['challengeThis', { hardToUndo: 'a', assumptions: 'b' }],
  ] as const)('rejects a missing %s section', async (_key, notes) => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({ prNotes: notes as unknown as PrepareBriefPackageUseCaseRequest['prNotes'] }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: `prNotes.${_key} must be a non-empty string`,
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a number', 42],
  ] as const)('rejects a %s section value', async (_label, value) => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({
        prNotes: { hardToUndo: value, assumptions: 'b', challengeThis: 'c' } as unknown as PrepareBriefPackageUseCaseRequest['prNotes'],
      }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'prNotes.hardToUndo must be a non-empty string',
    });
  });

  it('rejects a section longer than 4000 characters', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({
        prNotes: { hardToUndo: 'x'.repeat(4001), assumptions: 'b', challengeThis: 'c' },
      }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'prNotes.hardToUndo must be at most 4000 characters',
    });
  });

  it('accepts a section of exactly 4000 characters', async () => {
    const useCase = makeUseCase();
    const result = await useCase.prepareBriefPackage(
      validRequest({
        prNotes: { hardToUndo: 'x'.repeat(4000), assumptions: 'b', challengeThis: 'c' },
      }),
    );
    expect(result.outcome).toBe('prepared');
  });

  it.each([
    ['hardToUndo', 'ghp_' + 'A'.repeat(20)],
    // Assembled at runtime from inert pieces so this file never contains a
    // credential-shaped literal (the scanner still recognizes the shape).
    ['assumptions', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')],
    ['challengeThis', ['password = "', 'hunter22"'].join('')],
  ] as const)('rejects a secret-shaped %s section without echoing it', async (_key, value) => {
    const useCase = makeUseCase();
    const notes: Record<string, unknown> = {
      hardToUndo: 'a',
      assumptions: 'b',
      challengeThis: 'c',
    };
    notes[_key] = value;
    const result = await useCase.prepareBriefPackage(
      validRequest({ prNotes: notes as unknown as PrepareBriefPackageUseCaseRequest['prNotes'] }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: `prNotes.${_key} contains a secret-shaped value and was refused`,
    });
  });
});
