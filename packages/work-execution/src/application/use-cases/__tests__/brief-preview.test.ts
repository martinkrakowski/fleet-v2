/**
 * Lane BP1 (plan §3.3, §3.7, §4.2 row BP1): the dry-run preview of
 * `PrepareBriefPackage`. `previewBriefPackage` validates exactly as a real
 * prepare and computes what it would freeze — the manifest's digest and seat
 * plan — while writing nothing: no frozen brief placed, no context selection
 * recorded, no seat committed. The acceptance spec appears only as a
 * projection (commit required, diff check, command count, one digest per
 * command's argv); no argv element, owned path, prefix, artifact path, prose
 * or note text ever leaves the use case.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PrepareBriefPackageUseCase,
  type PrepareBriefPackageUseCaseRequest,
} from '../PrepareBriefPackageUseCase.use-case.js';
import type { BriefAuthoringPort } from '../../ports/out/BriefAuthoringPort.out-port.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { BriefKnowledgePort } from '../../ports/out/BriefKnowledgePort.out-port.js';

function makeBriefAuthoring(proseMarkdown = '# Frozen brief prose'): BriefAuthoringPort {
  return {
    authorBrief: vi.fn(async () => ({
      outcome: 'authored' as const,
      brief: { proseMarkdown, provenance: 'orchestrator' as const },
    })),
  };
}

function makeRecordingArtifactPort(): {
  port: AttemptArtifactPort;
  counts: { placeCalls: number; verifyCalls: number };
} {
  const counts = { placeCalls: 0, verifyCalls: 0 };
  const port: AttemptArtifactPort = {
    async verifyIgnoredPaths(request) {
      counts.verifyCalls += 1;
      return { outcome: 'ignored', checkedPaths: request.candidatePaths };
    },
    async placeFrozenBrief() {
      counts.placeCalls += 1;
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
          headCommit: '0000000000000000000000000000000000000000',
          commitsSinceBase: [],
          collectedArtifactPaths: [],
          notes: 'present',
        },
      };
    },
  };
  return { port, counts };
}

function makeRecordingKnowledgePort(): {
  port: BriefKnowledgePort;
  counts: { recordCalls: number };
} {
  const counts = { recordCalls: 0 };
  const port: BriefKnowledgePort = {
    async requestBriefContextProposals() {
      return { outcome: 'proposed', proposals: [] };
    },
    async recordContextSelection() {
      counts.recordCalls += 1;
      return { outcome: 'recorded' };
    },
    async forwardCompletedAttemptNotes() {
      return { outcome: 'forwarded' };
    },
  };
  return { port, counts };
}

/** A head-like base commit: 40 repeated digits, no repository named. */
const EXAMPLE_HEAD = '1'.repeat(40);

function validRequest(overrides: Partial<PrepareBriefPackageUseCaseRequest> = {}): PrepareBriefPackageUseCaseRequest {
  return {
    workOrderId: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'example-repository',
    baseCommit: EXAMPLE_HEAD,
    policyRevision: 'policy-example-1',
    modelAssignment: {
      model: 'example-provider/glm-5.3',
      variant: 'default',
      fallbackModel: 'example-provider/grok-4.7',
      seatTool: 'opencode',
    },
    independentReviewer: 'example-provider/grok-4.7',
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp-a', model: 'example-provider/glm-5.3', tool: 'opencode' }],
      fix: [{ id: 'fp-b', model: 'example-provider/glm-5.3', tool: 'opencode' }],
      review: [{ id: 'rv-a', model: 'example-provider/grok-4.7' }],
    },
    ownedPaths: ['packages/example/**'],
    allowedPathPrefixes: ['packages/example'],
    permissions: ['filesystem:worktree'],
    acceptanceChecks: ['example-check'],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ['corepack', 'yarn', 'build'] }, { argv: ['corepack', 'yarn', 'test'] }],
    },
    stepLimit: 40,
    timeLimitSeconds: 3600,
    resourceBounds: { cpu: '2' },
    expectedArtifacts: [],
    ownerDecisionReferences: ['decision-example-1'],
    contextDecisions: [
      {
        proposalId: 'proposal-example-1',
        knowledgeEntryId: 'knowledge-example-1',
        version: '1',
        proposedBecause: 'retrieval matched',
        accepted: true,
        decisionBecause: 'owner accepted',
      },
    ],
    worktreePath: '/wt-example',
    ...overrides,
  };
}

interface UseCaseHarness {
  useCase: PrepareBriefPackageUseCase;
  artifact: ReturnType<typeof makeRecordingArtifactPort>;
  knowledge: ReturnType<typeof makeRecordingKnowledgePort>;
}

function makeUseCase(options: {
  proseMarkdown?: string;
  computeDigest?: (content: string) => string;
} = {}): UseCaseHarness {
  const artifact = makeRecordingArtifactPort();
  const knowledge = makeRecordingKnowledgePort();
  const useCase = new PrepareBriefPackageUseCase({
    briefAuthoring: makeBriefAuthoring(options.proseMarkdown),
    artifactPort: artifact.port,
    briefKnowledge: knowledge.port,
    ...(options.computeDigest !== undefined ? { computeDigest: options.computeDigest } : {}),
  });
  return { useCase, artifact, knowledge };
}

describe('PrepareBriefPackageUseCase previewBriefPackage (BP1)', () => {
  it('previews a valid request and writes nothing: no frozen brief, no context selection', async () => {
    const { useCase, artifact, knowledge } = makeUseCase();
    const result = await useCase.previewBriefPackage(validRequest());

    expect(result.outcome).toBe('previewed');
    if (result.outcome !== 'previewed') {
      return;
    }
    expect(result.preview.attemptId).toBe('wo-example-1-attempt-1');
    expect(result.preview.modelAssignment).toEqual({
      model: 'example-provider/glm-5.3',
      variant: 'default',
      seatTool: 'opencode',
    });
    expect(result.preview.seatPlan).not.toBeNull();
    expect(result.preview.prNotesPresent).toBe(false);
    expect(result.preview.selectedKnowledgeVersions).toEqual([
      { knowledgeEntryId: 'knowledge-example-1', version: '1' },
    ]);
    expect(artifact.counts.placeCalls).toBe(0);
    expect(knowledge.counts.recordCalls).toBe(0);
    expect(artifact.counts.verifyCalls).toBeGreaterThan(0);
  });

  it('computes the same digest as a prepare for the same request, without computeDigest', async () => {
    const request = validRequest();
    const prepareHarness = makeUseCase();
    const previewHarness = makeUseCase();
    const prepared = await prepareHarness.useCase.prepareBriefPackage(request);
    const previewed = await previewHarness.useCase.previewBriefPackage(request);

    expect(prepared.outcome).toBe('prepared');
    expect(previewed.outcome === 'previewed' ? previewed.preview.briefDigest : '').toBe(
      prepared.outcome === 'prepared' ? prepared.prepared.briefDigest : '',
    );
  });

  it('computes the same digest as a prepare for the same request, with computeDigest', async () => {
    const computeDigest = (content: string): string => 'digest-' + content.length.toString(16);
    const request = validRequest();
    const prepareHarness = makeUseCase({ computeDigest });
    const previewHarness = makeUseCase({ computeDigest });
    const prepared = await prepareHarness.useCase.prepareBriefPackage(request);
    const previewed = await previewHarness.useCase.previewBriefPackage(request);

    expect(prepared.outcome).toBe('prepared');
    expect(previewed.outcome === 'previewed' ? previewed.preview.briefDigest : '').toBe(
      prepared.outcome === 'prepared' ? prepared.prepared.briefDigest : '',
    );
  });

  it('rejects with the same reason a prepare would give for five invalid requests', async () => {
    const invalidRequests: readonly PrepareBriefPackageUseCaseRequest[] = [
      validRequest({ ownedPaths: [] }),
      validRequest({ acceptanceSpec: undefined }),
      validRequest({
        modelAssignment: {
          model: 'example-provider/glm-5.3',
          variant: 'default',
          fallbackModel: 'example-provider/grok-4.7',
          seatTool: 'agy',
        },
        allowedPathPrefixes: undefined,
      }),
      validRequest({ independentReviewer: 'example-provider/glm-5.3' }),
      validRequest({
        prNotes: { hardToUndo: '', assumptions: 'assumption', challengeThis: 'challenge' },
      }),
    ];
    for (const invalid of invalidRequests) {
      const prepared = await makeUseCase().useCase.prepareBriefPackage(invalid);
      const previewed = await makeUseCase().useCase.previewBriefPackage(invalid);
      expect(prepared.outcome).toBe('rejected');
      expect(previewed.outcome).toBe('rejected');
      if (prepared.outcome === 'rejected' && previewed.outcome === 'rejected') {
        expect(previewed.reason).toBe(prepared.reason);
      }
    }
  });

  it('shows the marker-free acceptance projection: counts and digests only, no argv or path', async () => {
    const request = validRequest({
      ownedPaths: ['MARKER-OWNED/**'],
      allowedPathPrefixes: ['MARKER-PREFIX'],
      expectedArtifacts: ['MARKER-ARTIFACT.txt'],
      prNotes: {
        hardToUndo: 'MARKER-NOTES hard to undo',
        assumptions: 'MARKER-NOTES assumption',
        challengeThis: 'MARKER-NOTES challenge',
      },
      acceptanceSpec: {
        commitRequired: true,
        diffCheck: true,
        commands: [
          { argv: ['corepack', 'yarn', 'MARKER-ARGV-build'] },
          { argv: ['corepack', 'yarn', 'MARKER-ARGV-test'] },
        ],
      },
    });
    const { useCase } = makeUseCase({ proseMarkdown: 'MARKER-PROSE prose' });
    const result = await useCase.previewBriefPackage(request);

    expect(result.outcome).toBe('previewed');
    if (result.outcome !== 'previewed') {
      return;
    }
    expect(JSON.stringify(result)).not.toContain('MARKER');
    expect(result.preview.acceptance.commitRequired).toBe(true);
    expect(result.preview.acceptance.diffCheck).toBe(true);
    expect(result.preview.acceptance.commandCount).toBe(2);
    expect(result.preview.acceptance.commandDigests).toHaveLength(2);
    expect(result.preview.acceptance.commandDigests[0]).not.toBe(result.preview.acceptance.commandDigests[1]);
  });

  it('preview rejection reasons never contain artifact or offending paths; prepare keeps its messages', async () => {
    // Invalid artifact path: preview maps to a fixed reason without the path.
    const invalidArtifactPath = '../MARKER-INVALID-ARTIFACT.txt';
    const invalidPreview = await makeUseCase().useCase.previewBriefPackage(
      validRequest({ expectedArtifacts: [invalidArtifactPath] }),
    );
    expect(invalidPreview.outcome).toBe('rejected');
    if (invalidPreview.outcome === 'rejected') {
      expect(invalidPreview.reason).not.toContain(invalidArtifactPath);
      expect(invalidPreview.reason).toBe('an expected artifact path is invalid');
    }

    // Not-ignored path: preview maps to a fixed reason without the path, while
    // prepare keeps its byte-for-byte message that includes the path.
    const notIgnoredPath = 'MARKER-NOT-IGNORED.txt';
    const notIgnoredArtifactPort: AttemptArtifactPort = {
      async verifyIgnoredPaths() {
        return { outcome: 'not-ignored', offendingPaths: [notIgnoredPath] };
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
            headCommit: '0000000000000000000000000000000000000000',
            commitsSinceBase: [],
            collectedArtifactPaths: [],
            notes: 'present',
          },
        };
      },
    };
    const useCase = new PrepareBriefPackageUseCase({
      briefAuthoring: makeBriefAuthoring(),
      artifactPort: notIgnoredArtifactPort,
      briefKnowledge: makeRecordingKnowledgePort().port,
    });
    const notIgnoredPreview = await useCase.previewBriefPackage(validRequest());
    expect(notIgnoredPreview.outcome).toBe('rejected');
    if (notIgnoredPreview.outcome === 'rejected') {
      expect(notIgnoredPreview.reason).not.toContain(notIgnoredPath);
      expect(notIgnoredPreview.reason).toBe('an expected artifact path is not ignored');
    }
    const prepared = await useCase.prepareBriefPackage(validRequest());
    expect(prepared.outcome).toBe('rejected');
    if (prepared.outcome === 'rejected') {
      expect(prepared.reason).toContain(notIgnoredPath);
    }
  });

  it('throws Not implemented when unconfigured and keeps execute() prepared/rejected only', async () => {
    const unconfigured = new PrepareBriefPackageUseCase();
    await expect(unconfigured.previewBriefPackage(validRequest())).rejects.toThrow(
      'Not implemented: PrepareBriefPackageUseCase',
    );

    const executeHarness = makeUseCase();
    const executed = await executeHarness.useCase.execute(validRequest());
    expect(executed.outcome === 'prepared' || executed.outcome === 'rejected').toBe(true);
    expect(executed.outcome).toBe('prepared');

    const refusedExecution = await executeHarness.useCase.execute(validRequest({ ownedPaths: [] }));
    expect(refusedExecution.outcome).toBe('rejected');
  });
});
