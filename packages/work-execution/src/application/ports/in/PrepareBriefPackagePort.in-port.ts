// @generated inbound contract scaffold — refined for migration step 1.
/**
 * PrepareBriefPackagePort: select applicable context, obtain a reviewed prose
 * brief and freeze its manifest, revision references and digest before
 * dispatch. The runtime validates the manifest; the lane reads the prose.
 */

import type { RunnerKind } from '../../../domain/execution-records.js';

export interface BriefContextDecision {
  readonly proposalId: string;
  readonly knowledgeEntryId: string;
  readonly version: string;
  readonly proposedBecause: string;
  readonly accepted: boolean;
  readonly decisionBecause: string;
}

/**
 * Durable model assignment: model, variant and fallback as bound in the brief
 * manifest. Host seat names are installation and never enter this contract.
 */
export interface BriefModelAssignment {
  readonly model: string;
  readonly variant: string;
  readonly fallbackModel: string;
  /**
   * The runner tool the implementer seat runs. Frozen into the brief
   * manifest, so it is covered by the digest; dispatch reads it back from
   * there and never from a request.
   */
  readonly seatTool: RunnerKind;
}

export interface PrepareBriefPackageRequest {
  readonly workOrderId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  readonly repository: string;
  readonly baseCommit: string;
  readonly policyRevision: string;
  readonly modelAssignment: BriefModelAssignment;
  readonly independentReviewer: string;
  readonly ownedPaths: readonly string[];
  /**
   * The relative path prefixes a lane may touch, checked by the edit-only
   * diff check (`LaneDiffCheckPort`). Optional for opencode seats; REQUIRED
   * when the seat tool is `agy`. Validated at prepare time and frozen into
   * the manifest, so the digest covers it; old manifests read it as absent.
   */
  readonly allowedPathPrefixes?: readonly string[];
  readonly permissions: readonly string[];
  readonly acceptanceChecks: readonly string[];
  readonly stepLimit: number;
  readonly timeLimitSeconds: number;
  readonly resourceBounds: Readonly<Record<string, string>>;
  readonly expectedArtifacts: readonly string[];
  readonly ownerDecisionReferences: readonly string[];
  /** Orchestrator decisions on every retrieved proposal; nothing enters unreviewed. */
  readonly contextDecisions: readonly BriefContextDecision[];
}

export interface SelectedKnowledgeVersion {
  readonly knowledgeEntryId: string;
  readonly version: string;
}

export interface PreparedBriefPackage {
  readonly attemptId: string;
  /** Integrity digest of the frozen package; it is not a truth claim. */
  readonly briefDigest: string;
  readonly prosePath: string;
  readonly manifestPath: string;
  readonly selectedKnowledgeVersions: readonly SelectedKnowledgeVersion[];
}

export type PrepareBriefPackageResult =
  | { readonly outcome: 'prepared'; readonly prepared: PreparedBriefPackage }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface PrepareBriefPackagePort {
  /** Freeze one brief package and record its digest before any dispatch. */
  prepareBriefPackage(request: PrepareBriefPackageRequest): Promise<PrepareBriefPackageResult>;
}
