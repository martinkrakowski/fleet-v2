// Implemented for migration step 2 — frozen brief packages before dispatch.
/**
 * PrepareBriefPackageUseCase: select applicable context, obtain the reviewed
 * prose brief and freeze its manifest, revision references and digest before
 * any dispatch. The package is placed only under verified ignored paths; the
 * digest is integrity, not a truth claim. Nothing enters the brief unreviewed.
 */

import { parseSeatTool } from '../../domain/execution-records.js';
import type {
  PrepareBriefPackagePort,
  PrepareBriefPackageRequest,
  PrepareBriefPackageResult,
  SelectedKnowledgeVersion,
} from '../ports/in/PrepareBriefPackagePort.in-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { BriefAuthoringPort } from '../ports/out/BriefAuthoringPort.out-port.js';
import type { BriefKnowledgePort } from '../ports/out/BriefKnowledgePort.out-port.js';

export interface PrepareBriefPackageDependencies {
  readonly briefAuthoring: BriefAuthoringPort;
  readonly artifactPort: AttemptArtifactPort;
  readonly briefKnowledge?: BriefKnowledgePort;
  /** Infrastructure digest; when absent the pure helper below is used. */
  readonly computeDigest?: (content: string) => string;
  readonly worktreePath?: string;
  readonly attemptId?: string;
  readonly handWrittenBriefPath?: string | null;
}

/** The request may carry placement details the composition root knows. */
export type PrepareBriefPackageUseCaseRequest = PrepareBriefPackageRequest & {
  readonly attemptId?: string;
  readonly worktreePath?: string;
  readonly handWrittenBriefPath?: string | null;
};

/**
 * Pure deterministic FNV-1a digest producing a 64-character hex string, used
 * when no infrastructure digest is injected. It replaces `node:crypto` so the
 * application layer stays free of Node built-ins. It is integrity only: the
 * same input always produces the same digest, never a truth claim.
 */
const DIGEST_SEEDS: readonly number[] = [
  0x811c9dc5, 0x01000193, 0x41c6ce57, 0x9e3779b9, 0xdeadbeef, 0x0badc0de, 0x12345678, 0x7fffffff,
];

function fnv1a32(content: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function simpleDeterministicHexDigest(content: string): string {
  return DIGEST_SEEDS.map((seed) => fnv1a32(content, seed).toString(16).padStart(8, '0')).join('');
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class PrepareBriefPackageUseCase implements PrepareBriefPackagePort {
  constructor(private readonly deps?: PrepareBriefPackageDependencies) {}

  async prepareBriefPackage(
    request: PrepareBriefPackageUseCaseRequest,
  ): Promise<PrepareBriefPackageResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PrepareBriefPackageUseCase');
    }

    const requiredFields: readonly (keyof PrepareBriefPackageRequest)[] = [
      'workOrderId',
      'laneId',
      'baseCommit',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'rejected', reason: `Missing required brief fields: ${missingFields.join(', ')}` };
    }
    if (!Array.isArray(request.ownedPaths) || request.ownedPaths.length === 0) {
      return { outcome: 'rejected', reason: 'Brief must own at least one path' };
    }
    if (
      typeof request.stepLimit !== 'number' ||
      typeof request.timeLimitSeconds !== 'number' ||
      request.stepLimit <= 0 ||
      request.timeLimitSeconds <= 0
    ) {
      return { outcome: 'rejected', reason: 'stepLimit and timeLimitSeconds must be positive' };
    }
    if (!request.modelAssignment || !isNonEmpty(request.modelAssignment.model)) {
      return { outcome: 'rejected', reason: 'Model assignment requires a non-empty model' };
    }
    // The seat tool is frozen into the manifest and covered by the digest
    // (H8); it is required and never defaulted to a declared kind.
    if (parseSeatTool(request.modelAssignment.seatTool) === undefined) {
      return {
        outcome: 'rejected',
        reason: 'Model assignment requires a declared seat tool (opencode or agy)',
      };
    }
    if (!isNonEmpty(request.independentReviewer)) {
      return { outcome: 'rejected', reason: 'Independent reviewer must be named' };
    }
    if (request.modelAssignment.model === request.independentReviewer) {
      return {
        outcome: 'rejected',
        reason: 'Independent reviewer model must differ from the implementer model',
      };
    }

    const decisions = request.contextDecisions ?? [];
    if (decisions.some((decision) => !isNonEmpty(decision.decisionBecause))) {
      return { outcome: 'rejected', reason: 'Every context decision must record decisionBecause' };
    }

    const authored = await this.deps.briefAuthoring.authorBrief({
      workOrderId: request.workOrderId,
      laneId: request.laneId,
      handWrittenBriefPath: request.handWrittenBriefPath ?? this.deps.handWrittenBriefPath ?? null,
    });
    if (authored.outcome === 'unavailable') {
      return { outcome: 'rejected', reason: authored.reason };
    }

    const attemptId = request.attemptId ?? this.deps.attemptId ?? `${request.workOrderId}-attempt-1`;
    const worktreePath = request.worktreePath ?? this.deps.worktreePath ?? '.';

    const verified = await this.deps.artifactPort.verifyIgnoredPaths({
      worktreePath,
      candidatePaths: ['.lane/brief.md', '.lane/brief-manifest.json', ...request.expectedArtifacts],
    });
    if (verified.outcome === 'not-ignored') {
      return { outcome: 'rejected', reason: `Paths not ignored: ${verified.offendingPaths.join(', ')}` };
    }

    const selectedKnowledgeVersions: readonly SelectedKnowledgeVersion[] = decisions
      .filter((decision) => decision.accepted)
      .map((decision) => ({ knowledgeEntryId: decision.knowledgeEntryId, version: decision.version }));

    const manifestJson = JSON.stringify(
      {
        attemptId,
        workOrderId: request.workOrderId,
        projectId: request.projectId,
        taskId: request.taskId,
        laneId: request.laneId,
        repository: request.repository,
        baseCommit: request.baseCommit,
        policyRevision: request.policyRevision,
        modelAssignment: request.modelAssignment,
        independentReviewer: request.independentReviewer,
        ownedPaths: request.ownedPaths,
        permissions: request.permissions,
        acceptanceChecks: request.acceptanceChecks,
        stepLimit: request.stepLimit,
        timeLimitSeconds: request.timeLimitSeconds,
        resourceBounds: request.resourceBounds,
        expectedArtifacts: request.expectedArtifacts,
        ownerDecisionReferences: request.ownerDecisionReferences,
        selectedKnowledgeVersions,
      },
      null,
      2,
    );

    const briefDigest = this.deps.computeDigest
      ? this.deps.computeDigest(authored.brief.proseMarkdown + '\n' + manifestJson)
      : simpleDeterministicHexDigest(authored.brief.proseMarkdown + '\n' + manifestJson);

    const placed = await this.deps.artifactPort.placeFrozenBrief({
      attemptId,
      worktreePath,
      proseMarkdown: authored.brief.proseMarkdown,
      manifestJson,
    });
    if (placed.outcome === 'refused') {
      return { outcome: 'rejected', reason: placed.reason };
    }

    if (this.deps.briefKnowledge) {
      await this.deps.briefKnowledge.recordContextSelection({
        attemptId,
        selections: decisions.map((decision) => ({
          proposalId: decision.proposalId,
          knowledgeEntryId: decision.knowledgeEntryId,
          version: decision.version,
          accepted: decision.accepted,
          decisionBecause: decision.decisionBecause,
        })),
      });
    }

    return {
      outcome: 'prepared',
      prepared: {
        attemptId,
        briefDigest,
        prosePath: placed.prosePath,
        manifestPath: placed.manifestPath,
        selectedKnowledgeVersions,
      },
    };
  }

  async execute(input?: unknown): Promise<PrepareBriefPackageResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: PrepareBriefPackageUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: PrepareBriefPackageUseCase');
    }
    return this.prepareBriefPackage(input as PrepareBriefPackageUseCaseRequest);
  }
}
