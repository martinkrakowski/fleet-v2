// @generated inbound contract scaffold — refined for migration step 1.
/**
 * PrepareBriefPackagePort: select applicable context, obtain a reviewed prose
 * brief and freeze its manifest, revision references, the PR notes a
 * conducted run requires and its digest before dispatch. The runtime
 * validates the manifest; the lane reads the prose.
 */

import type { RunnerKind } from '../../../domain/execution-records.js';
import type { AcceptanceSpecProps } from '../../../domain/value-objects/AcceptanceSpec.vo.js';
import type { SeatPlanProps } from '../../../domain/value-objects/SeatPlan.vo.js';

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

/**
 * Frozen PR notes (D7): the three sections a conducted run requires for its
 * PR body. Each is a non-empty string of at most 4000 characters and never
 * secret-shaped. Optional on the prepare request — manual prepare works
 * without them; a conducted start (`StartLaneRun`) refuses a brief without
 * them.
 */
export interface PrNotes {
  readonly hardToUndo: string;
  readonly assumptions: string;
  readonly challengeThis: string;
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

  /**
   * Frozen PR notes (D7): the three sections a conducted run requires for its
   * PR body. Each is a non-empty string of at most 4000 characters and never
   * secret-shaped. Optional on the prepare request — manual prepare works
   * without them; a conducted start (`StartLaneRun`) refuses a brief without
   * them.
   */
  readonly prNotes?: PrNotes;
  /**
   * Optional seat plan (S1, D1): ordered seats per role. When present it is
   * validated, the model assignment must be one of its first-pass seats, no
   * review seat may share a model family with a first-pass or fix seat, and
   * it is frozen into the manifest so the digest covers it. Absent keeps
   * today's single fallback.
   */
  readonly seatPlan?: SeatPlanProps;
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
  /**
   * The gate this lane must pass, frozen into the manifest and covered by the
   * digest (plan S2, D2). Required: a request without a valid spec is rejected.
   * Typed optional because the CLI passes untyped input.
   */
  readonly acceptanceSpec?: AcceptanceSpecProps;
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

/** The acceptance spec as a preview may show it (plan §3.7): no argv element, no path. */
export interface BriefAcceptancePreview {
  readonly commitRequired: boolean;
  readonly diffCheck: boolean;
  readonly commandCount: number;
  /** One digest per command, over JSON.stringify(argv), in spec order. */
  readonly commandDigests: readonly string[];
}

export interface BriefPackagePreview {
  readonly attemptId: string;
  /** The digest a prepare would freeze now (same input, same prose): integrity, not a truth claim. */
  readonly briefDigest: string;
  readonly modelAssignment: { readonly model: string; readonly variant: string; readonly seatTool: RunnerKind };
  /** The frozen seat plan a prepare would write, or null when the request has none. */
  readonly seatPlan: SeatPlanProps | null;
  readonly acceptance: BriefAcceptancePreview;
  readonly prNotesPresent: boolean;
  readonly selectedKnowledgeVersions: readonly SelectedKnowledgeVersion[];
}

export type PreviewBriefPackageResult =
  | { readonly outcome: 'previewed'; readonly preview: BriefPackagePreview }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface PrepareBriefPackagePort {
  /** Freeze one brief package and record its digest before any dispatch. */
  prepareBriefPackage(request: PrepareBriefPackageRequest): Promise<PrepareBriefPackageResult>;
  /**
   * Validate and compute what a prepare would freeze; writes nothing and
   * commits no seat. Optional on the contract so existing port fakes (the
   * conductor's StartLaneRun fake) keep compiling unchanged; the use case
   * always implements it.
   */
  previewBriefPackage?(request: PrepareBriefPackageRequest): Promise<PreviewBriefPackageResult>;
}
