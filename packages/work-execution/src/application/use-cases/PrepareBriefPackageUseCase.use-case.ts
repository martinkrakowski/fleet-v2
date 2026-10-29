// Implemented for migration step 2 — frozen brief packages before dispatch.
/**
 * PrepareBriefPackageUseCase: select applicable context, obtain the reviewed
 * prose brief and freeze its manifest, revision references and digest before
 * any dispatch. The package is placed only under verified ignored paths; the
 * digest is integrity, not a truth claim. Nothing enters the brief unreviewed.
 * The acceptance spec is validated and frozen into the manifest, so the
 * digest covers the gate. PR notes (D7) are validated when present and
 * frozen under `prNotes`; they are optional here because manual prepare
 * works without them, while a conducted start requires them.
 *
 * `previewBriefPackage` (plan §3.3, §3.7) validates the same request and
 * computes what a prepare would freeze — the digest and the seat plan —
 * and shows the acceptance spec only as a projection (commit required, diff
 * check, command count and one digest per command's argv): no frozen brief
 * is placed, no context selection is recorded, no seat is committed, and no
 * argv element, owned path, prefix, artifact path or note text is returned.
 */

import { parseSeatTool } from '../../domain/execution-records.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import { validateAllowedPathPrefix } from '../../domain/lane-diff-check.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
import { isPlanSecretShaped } from '../../domain/lane-plan-sidecar.js';
import { AcceptanceSpec } from '../../domain/value-objects/AcceptanceSpec.vo.js';
import type {
  BriefContextDecision,
  PrepareBriefPackagePort,
  PrepareBriefPackageRequest,
  PrepareBriefPackageResult,
  PreviewBriefPackageResult,
  BriefPackagePreview,
  SelectedKnowledgeVersion,
} from '../ports/in/PrepareBriefPackagePort.in-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AuthoredBriefResult, BriefAuthoringPort } from '../ports/out/BriefAuthoringPort.out-port.js';
import type { BriefKnowledgePort } from '../ports/out/BriefKnowledgePort.out-port.js';
import { isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import { seatMatchesAssignment, seatPlanFamilyConflicts } from '../../domain/seat-selection.js';
import { SeatPlan } from '../../domain/value-objects/SeatPlan.vo.js';

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
  /** KF-8: the recorded host of the worktree; the placement writes there. */
  readonly recordedHost?: AttemptRunnerRecord | null;
};

/**
 * Pure deterministic FNV-1a digest producing a 64-character hex string. It is
 * a test and fallback helper used only when no infrastructure digest is
 * injected; production composition roots inject SHA-256 (`sha256HexDigest`).
 * It keeps the application layer free of Node built-ins.
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

/**
 * Pure deterministic FNV-1a test and fallback helper; production composition
 * roots inject SHA-256 (`sha256HexDigest`).
 */
export function simpleDeterministicHexDigest(content: string): string {
  return DIGEST_SEEDS.map((seed) => fnv1a32(content, seed).toString(16).padStart(8, '0')).join('');
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * PR notes (D7): each of the three sections is a non-empty string of at
 * most 4000 characters and carries no secret shape. Returns a fixed reason
 * or null; never echoes a value.
 */
const PR_NOTE_MAX_LENGTH = 4000;

/**
 * Frozen prose supplied by the caller (KF-6): a non-empty string of at most
 * 64 KiB carrying no secret shape. Returns a fixed reason or null; never
 * echoes a value.
 */
const PROSE_MARKDOWN_MAX_BYTES = 64 * 1024;

function proseMarkdownError(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'proseMarkdown must be a non-empty string';
  }
  if (new TextEncoder().encode(value).byteLength > PROSE_MARKDOWN_MAX_BYTES) {
    return 'proseMarkdown must be at most 64 KiB';
  }
  if (isPlanSecretShaped(value)) {
    return 'proseMarkdown contains a secret-shaped value and was refused';
  }
  return null;
}
/** The runner agent pattern (KF-7): alphanumeric start, then letters, digits, dot, underscore, hyphen. */
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function prNotesError(notes: unknown): string | null {
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) {
    return 'prNotes must be an object with hardToUndo, assumptions and challengeThis';
  }
  const record = notes as Record<string, unknown>;
  for (const key of ['hardToUndo', 'assumptions', 'challengeThis'] as const) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `prNotes.${key} must be a non-empty string`;
    }
    if (value.length > PR_NOTE_MAX_LENGTH) {
      return `prNotes.${key} must be at most ${PR_NOTE_MAX_LENGTH} characters`;
    }
    if (isPlanSecretShaped(value)) {
      return `prNotes.${key} contains a secret-shaped value and was refused`;
    }
  }
  return null;
}

/** Fail-closed model-family comparison (owner rule 2026-10-16). */
function sameModelFamily(left: string, right: string): boolean {
  return isSameModelFamily(underlyingModelFamily(left), underlyingModelFamily(right));
}

/** Validate an optional seat plan against the assignment and reviewer; the plan or a refusal reason. */
function checkSeatPlan(
  request: PrepareBriefPackageRequest,
): { readonly plan: SeatPlan | undefined } | { readonly reason: string } {
  if (request.seatPlan === undefined) {
    return { plan: undefined };
  }
  const created = SeatPlan.create(request.seatPlan);
  if (!created.success || created.value === undefined) {
    return { reason: 'Seat plan is invalid: ' + (created.error?.message ?? 'unknown error') };
  }
  const plan = created.value;
  const conflicts = seatPlanFamilyConflicts(plan, sameModelFamily);
  if (conflicts.length > 0) {
    return { reason: 'Seat plan refused: ' + conflicts.join('; ') };
  }
  const implementerSeats = [...plan.getSeats('first-pass'), ...plan.getSeats('fix')];
  const reviewerClash = implementerSeats.find((seat) => sameModelFamily(seat.model, request.independentReviewer));
  if (reviewerClash !== undefined) {
    return { reason: 'Independent reviewer shares a model family with seat-plan seat ' + reviewerClash.id };
  }
  const assignment = request.modelAssignment;
  const matchesFirstPass = plan.getSeats('first-pass').some((seat) =>
    seatMatchesAssignment(seat, {
      model: assignment.model,
      tool: assignment.seatTool,
      variant: assignment.variant,
      agent: assignment.agent,
    }),
  );
  if (!matchesFirstPass) {
    return { reason: 'Model assignment must match a first-pass seat of the seat plan' };
  }
  return { plan };
}

/** Early request-shape validation: required fields, owned paths, limits, model and seat tool. */
function validateBriefFields(request: PrepareBriefPackageRequest): string | null {
  const requiredFields: readonly (keyof PrepareBriefPackageRequest)[] = [
    'workOrderId',
    'laneId',
    'baseCommit',
  ];
  const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
  if (missingFields.length > 0) {
    return `Missing required brief fields: ${missingFields.join(', ')}`;
  }
  if (!Array.isArray(request.ownedPaths) || request.ownedPaths.length === 0) {
    return 'Brief must own at least one path';
  }
  if (
    typeof request.stepLimit !== 'number' ||
    typeof request.timeLimitSeconds !== 'number' ||
    request.stepLimit <= 0 ||
    request.timeLimitSeconds <= 0
  ) {
    return 'stepLimit and timeLimitSeconds must be positive';
  }
  if (!request.modelAssignment || !isNonEmpty(request.modelAssignment.model)) {
    return 'Model assignment requires a non-empty model';
  }
  // The seat tool is frozen into the manifest and covered by the digest
  // (H8); it is required and never defaulted to a declared kind.
  if (parseSeatTool(request.modelAssignment.seatTool) === undefined) {
    return 'Model assignment requires a declared seat tool (opencode or agy)';
  }
  // The runner agent (KF-7) is optional and frozen into the manifest with the
  // rest of the assignment; when present it must be a non-empty string of at
  // most 64 characters matching the allowed pattern.
  const agent = request.modelAssignment.agent;
  if (
    agent !== undefined &&
    (typeof agent !== 'string' ||
      agent.length === 0 ||
      agent.length > 64 ||
      !AGENT_PATTERN.test(agent))
  ) {
    return 'Model assignment agent must be a non-empty string of at most 64 characters matching [A-Za-z0-9][A-Za-z0-9._-]*';
  }
  return null;
}

/**
 * The allowed path prefixes feed the edit-only diff check. Required for an
 * agy seat, optional for opencode; every entry must be a non-empty relative
 * path that never names `.git` or `.lane`. Plan S2: the gate is data in the
 * frozen manifest, and its diff check needs at least one prefix. Returns the
 * validated prefixes and spec, or a refusal reason.
 */
function validatePathsAndSpec(
  request: PrepareBriefPackageRequest,
): { readonly reason: string } | {
  readonly allowedPathPrefixes: readonly string[];
  readonly acceptanceSpec: AcceptanceSpec;
} {
  // `execute` takes untyped input from the CLI and the API: a string here
  // would pass the length and per-character checks and be frozen into the
  // manifest as a string, so the shape is checked first.
  const allowedPathPrefixes = request.allowedPathPrefixes ?? [];
  if (
    !Array.isArray(allowedPathPrefixes) ||
    !allowedPathPrefixes.every((prefix) => typeof prefix === 'string')
  ) {
    return { reason: 'allowedPathPrefixes must be an array of strings' };
  }
  if (request.modelAssignment.seatTool === 'agy' && allowedPathPrefixes.length === 0) {
    return { reason: 'allowedPathPrefixes is required when the seat tool is agy' };
  }
  for (const prefix of allowedPathPrefixes) {
    const invalidPrefix = validateAllowedPathPrefix(prefix);
    if (invalidPrefix !== null) {
      return { reason: invalidPrefix };
    }
  }
  if (request.acceptanceSpec === undefined || request.acceptanceSpec === null) {
    return {
      reason: 'acceptanceSpec is required: commitRequired, diffCheck and at least one command',
    };
  }
  const acceptanceSpec = AcceptanceSpec.create(request.acceptanceSpec);
  if (!acceptanceSpec.success || acceptanceSpec.value === undefined) {
    return { reason: acceptanceSpec.error?.message ?? 'acceptanceSpec is invalid' };
  }
  if (allowedPathPrefixes.length === 0) {
    return {
      reason:
        'allowedPathPrefixes is required: the acceptance spec diff check refuses every changed path outside them',
    };
  }
  return { allowedPathPrefixes, acceptanceSpec: acceptanceSpec.value };
}

/**
 * The worktree path names where the frozen package lands. It is required and
 * never defaulted to the process's current directory; the request wins over
 * the composition root, and both must be a non-empty absolute path that is
 * not the filesystem root (a relative or root path makes the containment
 * prefix degenerate). Expected artifacts are verified and frozen as relative
 * paths; an absolute or `..` entry would escape the worktree when read back.
 */
function validatePlacement(
  request: PrepareBriefPackageUseCaseRequest,
  configuredWorktreePath: string | undefined,
  forPreview = false,
): { readonly reason: string } | { readonly worktreePath: string } {
  const worktreePath = request.worktreePath ?? configuredWorktreePath;
  if (!isNonEmpty(worktreePath)) {
    return { reason: 'worktreePath is required' };
  }
  const trimmedWorktreePath = worktreePath.replace(/\/+$/, '');
  if (trimmedWorktreePath === '' || !worktreePath.startsWith('/')) {
    return {
      reason: 'worktreePath must be an absolute path that is not the filesystem root',
    };
  }
  if (!Array.isArray(request.expectedArtifacts)) {
    return { reason: 'expectedArtifacts must be an array of strings' };
  }
  for (const artifact of request.expectedArtifacts) {
    const refusedReason = validateWorktreeRelativePath(artifact);
    if (refusedReason !== null) {
      return {
        reason: forPreview
          ? 'an expected artifact path is invalid'
          : `expectedArtifacts entry is not a valid worktree-relative path: ${String(artifact)}`,
      };
    }
  }
  return { worktreePath };
}

/**
 * The reviewer must be named and differ from the implementer model, an
 * optional seat plan is validated, pr notes are validated when present, and
 * every context decision must record decisionBecause. Returns the validated
 * plan or a refusal reason.
 */
function validateReviewerAndPlan(
  request: PrepareBriefPackageRequest,
): { readonly reason: string } | { readonly plan: SeatPlan | undefined } {
  if (!isNonEmpty(request.independentReviewer)) {
    return { reason: 'Independent reviewer must be named' };
  }
  if (request.modelAssignment.model === request.independentReviewer) {
    return { reason: 'Independent reviewer model must differ from the implementer model' };
  }
  const seatPlanCheck = checkSeatPlan(request);
  if ('reason' in seatPlanCheck) {
    return { reason: seatPlanCheck.reason };
  }
  // D7: PR notes are optional on a request (manual prepare works without
  // them), but when present each section must be a non-empty string of at
  // most 4000 characters with no secret shape. A conducted start refuses a
  // brief without them; nothing here depends on presence.
  if (request.prNotes !== undefined) {
    const notesError = prNotesError(request.prNotes);
    if (notesError !== null) {
      return { reason: notesError };
    }
  }
  const decisions = request.contextDecisions ?? [];
  if (decisions.some((decision) => !isNonEmpty(decision.decisionBecause))) {
    return { reason: 'Every context decision must record decisionBecause' };
  }
  return { plan: seatPlanCheck.plan };
}

/** Everything a prepare would write or freeze, or the reason it would refuse. */
type BuiltBriefPackage =
  | { readonly reason: string }
  | {
      readonly authored: Extract<AuthoredBriefResult, { readonly outcome: 'authored' }>;
      readonly attemptId: string;
      readonly worktreePath: string;
      readonly manifestJson: string;
      readonly briefDigest: string;
      readonly acceptanceSpec: AcceptanceSpec;
      readonly plan: SeatPlan | undefined;
      readonly decisions: readonly BriefContextDecision[];
      readonly selectedKnowledgeVersions: readonly SelectedKnowledgeVersion[];
    };

/**
 * A preview rejection that mentions any path the request or the configuration supplies (worktree, allowed prefixes,
 * expected artifacts, owned paths, the hand-written brief) becomes one fixed reason, whichever check produced it;
 * prepare's own messages are unchanged.
 */
const PREVIEW_PATH_REASON = 'the brief request was refused: a supplied path or path prefix is invalid or unavailable';

function redactRequestPaths(
  reason: string,
  request: PrepareBriefPackageUseCaseRequest,
  deps: { readonly handWrittenBriefPath?: string | null },
): string {
  const candidates: unknown[] = [
    request.worktreePath,
    request.handWrittenBriefPath,
    deps.handWrittenBriefPath,
    ...(Array.isArray(request.allowedPathPrefixes) ? request.allowedPathPrefixes : []),
    ...(Array.isArray(request.expectedArtifacts) ? request.expectedArtifacts : []),
    ...(Array.isArray(request.ownedPaths) ? request.ownedPaths : []),
  ];
  const paths = candidates
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .sort((left, right) => right.length - left.length);
  // A reason that mentions any supplied path is replaced as a whole by one fixed message: nothing is rewritten
  // inside the text (a short path such as `a` would otherwise mangle unrelated words), and no path survives.
  return paths.some((path) => reason.includes(path)) ? PREVIEW_PATH_REASON : reason;
}

export class PrepareBriefPackageUseCase implements PrepareBriefPackagePort {
  constructor(private readonly deps?: PrepareBriefPackageDependencies) {}

  /**
   * The shared build behind prepare and preview: validate the request,
   * author the prose, verify the ignored paths and compute the manifest and
   * its digest — everything up to and including step 4 of a prepare, with no
   * write. A rejection reason here is the same reason a prepare would give.
   */
  private async build(
    request: PrepareBriefPackageUseCaseRequest,
    deps: PrepareBriefPackageDependencies,
    forPreview = false,
  ): Promise<BuiltBriefPackage> {
    const fieldsError = validateBriefFields(request);
    if (fieldsError !== null) {
      return { reason: fieldsError };
    }
    const pathsCheck = validatePathsAndSpec(request);
    if ('reason' in pathsCheck) {
      return { reason: pathsCheck.reason };
    }
    const placementCheck = validatePlacement(request, deps.worktreePath, forPreview);
    if ('reason' in placementCheck) {
      return { reason: placementCheck.reason };
    }
    const reviewerCheck = validateReviewerAndPlan(request);
    if ('reason' in reviewerCheck) {
      return { reason: reviewerCheck.reason };
    }

    let authored: Extract<AuthoredBriefResult, { readonly outcome: 'authored' }>;
    if (request.proseMarkdown !== undefined) {
      const proseError = proseMarkdownError(request.proseMarkdown);
      if (proseError !== null) {
        return { reason: proseError };
      }
      authored = {
        outcome: 'authored',
        brief: {
          proseMarkdown: request.proseMarkdown,
          provenance: 'hand-written-file',
        },
      };
    } else {
      const authoredResult = await deps.briefAuthoring.authorBrief({
        workOrderId: request.workOrderId,
        laneId: request.laneId,
        handWrittenBriefPath: request.handWrittenBriefPath ?? deps.handWrittenBriefPath ?? null,
      });
      if (authoredResult.outcome === 'unavailable') {
        return { reason: authoredResult.reason };
      }
      authored = authoredResult;
    }

    const attemptId = request.attemptId ?? deps.attemptId ?? `${request.workOrderId}-attempt-1`;

    const verified = await deps.artifactPort.verifyIgnoredPaths({
      worktreePath: placementCheck.worktreePath,
      candidatePaths: ['.lane/brief.md', '.lane/brief-manifest.json', ...request.expectedArtifacts],
      // KF-8: the verification runs on the worktree's recorded host, so a
      // worktree on an ssh host is checked against that host's ignore rules.
      ...(request.recordedHost !== undefined ? { recordedHost: request.recordedHost } : {}),
    });
    if (verified.outcome === 'not-ignored') {
      return {
        reason: forPreview
          ? 'an expected artifact path is not ignored'
          : `Paths not ignored: ${verified.offendingPaths.join(', ')}`,
      };
    }

    const decisions = request.contextDecisions ?? [];
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
        ...(reviewerCheck.plan !== undefined ? { seatPlan: reviewerCheck.plan.toJSON() } : {}),
        independentReviewer: request.independentReviewer,
        ownedPaths: request.ownedPaths,
        allowedPathPrefixes: pathsCheck.allowedPathPrefixes,
        permissions: request.permissions,
        acceptanceChecks: request.acceptanceChecks,
        acceptanceSpec: pathsCheck.acceptanceSpec.toJSON(),
        stepLimit: request.stepLimit,
        timeLimitSeconds: request.timeLimitSeconds,
        resourceBounds: request.resourceBounds,
        expectedArtifacts: request.expectedArtifacts,
        ownerDecisionReferences: request.ownerDecisionReferences,
        ...(request.prNotes !== undefined
          ? {
              prNotes: {
                hardToUndo: request.prNotes.hardToUndo,
                assumptions: request.prNotes.assumptions,
                challengeThis: request.prNotes.challengeThis,
              },
            }
          : {}),
        selectedKnowledgeVersions,
      },
      null,
      2,
    );

    const briefContent = authored.brief.proseMarkdown + '\n' + manifestJson;
    const briefDigest = deps.computeDigest
      ? deps.computeDigest(briefContent)
      : simpleDeterministicHexDigest(briefContent);

    return {
      authored,
      attemptId,
      worktreePath: placementCheck.worktreePath,
      manifestJson,
      briefDigest,
      acceptanceSpec: pathsCheck.acceptanceSpec,
      plan: reviewerCheck.plan,
      decisions,
      selectedKnowledgeVersions,
    };
  }

  async prepareBriefPackage(
    request: PrepareBriefPackageUseCaseRequest,
  ): Promise<PrepareBriefPackageResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PrepareBriefPackageUseCase');
    }

    const built = await this.build(request, this.deps);
    if ('reason' in built) {
      return { outcome: 'rejected', reason: built.reason };
    }

    const placed = await this.deps.artifactPort.placeFrozenBrief({
      attemptId: built.attemptId,
      worktreePath: built.worktreePath,
      proseMarkdown: built.authored.brief.proseMarkdown,
      manifestJson: built.manifestJson,
      ...(request.recordedHost !== undefined ? { recordedHost: request.recordedHost } : {}),
    });
    if (placed.outcome === 'refused') {
      return { outcome: 'rejected', reason: placed.reason };
    }

    if (this.deps.briefKnowledge) {
      await this.deps.briefKnowledge.recordContextSelection({
        attemptId: built.attemptId,
        selections: built.decisions.map((decision) => ({
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
        attemptId: built.attemptId,
        briefDigest: built.briefDigest,
        prosePath: placed.prosePath,
        manifestPath: placed.manifestPath,
        selectedKnowledgeVersions: built.selectedKnowledgeVersions,
      },
    };
  }

  async previewBriefPackage(
    request: PrepareBriefPackageUseCaseRequest,
  ): Promise<PreviewBriefPackageResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: PrepareBriefPackageUseCase');
    }

    // Preview rejections never echo artifact or offending paths: the preview
    // result must contain no path, so build maps path-bearing rejections to
    // fixed reasons when forPreview is set.
    const built = await this.build(request, this.deps, true);
    if ('reason' in built) {
      return { outcome: 'rejected', reason: redactRequestPaths(built.reason, request, this.deps) };
    }

    const compute = this.deps.computeDigest ?? simpleDeterministicHexDigest;
    const commands = built.acceptanceSpec.getCommands();
    const commandDigests = commands.map((command) => compute(JSON.stringify(command.argv)));
    const preview: BriefPackagePreview = {
      attemptId: built.attemptId,
      briefDigest: built.briefDigest,
      modelAssignment: {
        model: request.modelAssignment.model,
        variant: request.modelAssignment.variant,
        seatTool: request.modelAssignment.seatTool,
      },
      seatPlan: built.plan?.toJSON() ?? null,
      acceptance: {
        commitRequired: built.acceptanceSpec.getCommitRequired(),
        diffCheck: built.acceptanceSpec.getDiffCheck(),
        commandCount: commands.length,
        commandDigests,
      },
      prNotesPresent: request.prNotes !== undefined,
      selectedKnowledgeVersions: built.selectedKnowledgeVersions,
    };
    return { outcome: 'previewed', preview };
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
