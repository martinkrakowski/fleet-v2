// Implemented use case — acceptance & forge station (cross-context step).
/**
 * ExecuteAuthorizedForgeActionUseCase implements
 * ExecuteAuthorizedForgeActionPort.
 *
 * It applies one scoped push/PR or merge action only after the attempt's
 * collected head matches the expected head, a merge additionally carries an
 * acceptance receipt for that head, and the authorization grant is durably
 * consumed for exactly this action. Intent is journalled before the forge
 * subprocess runs; ambiguous forge outcomes are reported for reconciliation
 * rather than guessed, and lanes gain no forge credentials here.
 */

import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionRequest,
  ExecuteAuthorizedForgeActionResult,
} from "../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js";
import type { AcceptanceEvidencePort } from "../ports/out/AcceptanceEvidencePort.out-port.js";
import type { OwnerDecisionPort } from "../ports/out/OwnerDecisionPort.out-port.js";
import type { AttemptOwnerDecisionPort } from "../ports/out/AttemptOwnerDecisionPort.out-port.js";
import type { ActionAuthorizationPort } from "../ports/out/ActionAuthorizationPort.out-port.js";
import type { AttemptRepositoryPort } from "../ports/out/AttemptRepositoryPort.out-port.js";
import type { ExecutionJournalPort } from "../ports/out/ExecutionJournalPort.out-port.js";
import type { ForgeActionPort } from "../ports/out/ForgeActionPort.out-port.js";
import type {
  ForgeReadPort,
  PullRequestSnapshot,
} from "../ports/out/ForgeReadPort.out-port.js";
import type { WorkOrderRepositoryPort } from "../ports/out/WorkOrderRepositoryPort.out-port.js";
import type {
  ActionJournalEntryRecord,
  ActionJournalPullRequestRef,
  AttemptRecord,
  WorkOrderRecord,
} from "../../domain/execution-records.js";
import { WorkOrder } from "../../domain/entities/WorkOrder.js";
import {
  MERGE_RECORD_LIMITS,
  MergeRecord,
} from "../../domain/entities/MergeRecord.js";
import { PullRequestLink } from "../../domain/entities/PullRequestLink.js";
import type { PullRequestLinkConflictRecord } from "../../domain/lane-plan-records.js";
import {
  isPlanSecretShaped,
  pullRequestRefError,
} from "../../domain/lane-plan-sidecar.js";
import { FORGE_ACTION_KINDS } from "../../domain/coordination-keys.js";
import type { LanePlanRepositoryPort } from "../ports/out/LanePlanRepositoryPort.out-port.js";
import type { MergeRecordRepositoryPort } from "../ports/out/MergeRecordRepositoryPort.out-port.js";
import { AUTHORIZED_BY_PATTERN } from "../../domain/auto-merge.js";
import {
  BASE_BRANCH_INVALID_MESSAGE,
  parseBaseBranch,
} from "../../domain/base-branch.js";

/** A safe branch name, the forge read's rule (KF-5b): one safe git ref, never all digits. */
function isSafeBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("..") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !/^\d+$/.test(value)
  );
}

export interface ExecuteAuthorizedForgeActionDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly workOrderRepo: WorkOrderRepositoryPort;
  /** Append-only evidence; the intent entry is durable before the forge runs. */
  readonly journal: ExecutionJournalPort;
  /** Durably binds one authorization grant to exactly one action. */
  readonly authorizationPort: ActionAuthorizationPort;
  /** Performs the credential-bearing forge operation behind a port. */
  readonly forgePort: ForgeActionPort;
  /** Out-port for reading acceptance assessment evidence from the evidence context. */
  readonly acceptanceEvidencePort?: AcceptanceEvidencePort;
  /**
   * Out-port for resolving the attempt's frozen one-way doors through owner
   * coordination; the same resolution acceptance uses, so a door that is now
   * undecided, declined or unknown also refuses the forge action.
   */
  readonly ownerDecisionPort?: OwnerDecisionPort;
  /** Out-port for reading the one-way doors the frozen brief named for this attempt. */
  readonly attemptOwnerDecisionPort?: AttemptOwnerDecisionPort;
  /** Non-authoritative cache of accepted-receipt id per head. */
  readonly acceptedReceiptByHead?: Readonly<Record<string, string>>;
  /**
   * The installation's forge mode (D6). Mode `none` refuses every forge
   * action before any grant is consumed or subprocess runs; `github` and an
   * unknown mode keep today's behaviour.
   */
  readonly forgeMode?: "github" | "none";
  /**
   * Composition-root clock for journal and revision timestamps; the
   * wall-clock default is a scaffold convenience, not an authority source.
   */
  readonly now?: () => string;
  /**
   * The lane-plan store (WB5b): pull-request links are recorded on executed
   * PR actions and `pr-already-linked` conflicts are persisted where the
   * board reads them. Optional so existing callers keep working.
   */
  readonly lanePlanRepo?: LanePlanRepositoryPort;
  /**
   * The merge-record store (WB5b): a completed `merge-pr` writes the merge
   * fact through `saveMergeRecord` only after the `completed` journal entry
   * exists. Optional so existing callers keep working.
   */
  readonly mergeRecordRepo?: MergeRecordRepositoryPort;
  /**
   * The read-only pull-request read (WB5b2): every merge number is read once
   * here before the grant is consumed, whatever its source — it must be the
   * attempt's branch at the expected head, on the bound repository, and not a
   * fork's pull request. Absent or unreadable means unverified, and an
   * unverified number never merges.
   */
  readonly forgeRead?: Pick<ForgeReadPort, "readPullRequest">;
}

/** The forge action kinds that act on a pull request (WB5b pre-flight resolution). */
const PULL_REQUEST_ACTION_KINDS: readonly string[] = [
  "push-and-open-pr",
  "push-to-pr",
  "merge-pr",
];

/** Request ids are bounded plain text with no secret shape and no path separators. */
const REQUEST_ID_FIELDS: readonly string[] = [
  "actionId",
  "attemptId",
  "workOrderId",
  "authorizationGrantId",
];

const OPTIONAL_TEXT_FIELDS: readonly string[] = [
  "authorizedBy",
  "branchName",
  "baseBranch",
  "title",
  "body",
];

const MAX_REQUEST_TEXT_CHARS = 256;
const MAX_PULL_REQUEST_NUMBER = 999_999_999;
/** The bound on the verifying pull-request read (WB5b2). */
const PULL_REQUEST_VERIFY_TIMEOUT_MS = 15_000;
/** Digits reserved for the journal sequence in `forge:<actionId>:completed:<seq>`. */
const ACTION_REF_SEQUENCE_DIGITS = 6;
/** The only adapter reasons of the legacy lookup the use case passes through. */
const LEGACY_LOOKUP_PASS_THROUGH_REASONS: ReadonlySet<string> = new Set([
  "legacy-pr-lookup-unbound-repository",
  "legacy-pr-lookup-repository-mismatch",
]);

const GITHUB_HOST = "github.com";
const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Lower-cases ASCII letters only: no Unicode folding (the Kelvin sign stays itself). */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The completed-entry detail: the pull request number, the legacy-lookup marker, or none. */
function completedDetail(
  request: ExecuteAuthorizedForgeActionRequest,
  forgeResult: { readonly pullRequestNumber?: number | undefined },
  legacyLookup: boolean,
): string | null {
  if (
    request.kind !== "merge-pr" &&
    forgeResult.pullRequestNumber !== undefined
  ) {
    return `pull request #${forgeResult.pullRequestNumber}`;
  }
  return legacyLookup ? "prSource=legacy-head-lookup" : null;
}

/** The part of `rest` after `separator`, when the part before it is exactly the GitHub host. */
function pathAfterGithubHost(rest: string, separator: "/" | ":"): string | null {
  const cut = rest.indexOf(separator);
  if (cut < 0 || asciiLower(rest.slice(0, cut)) !== GITHUB_HOST) {
    return null;
  }
  return rest.slice(cut + 1);
}

/**
 * The repository forms the work order store holds (WB5b2), reduced to
 * `{owner, repo}` with the case kept: `https://github.com/<owner>/<repo>[.git]`,
 * `ssh://git@github.com/...`, `git@github.com:<owner>/<repo>[.git]`,
 * `github.com/<owner>/<repo>` and a plain `owner/repo`. Exactly one trailing
 * slash and one trailing `.git` are accepted. The host must be github.com
 * (ASCII case-insensitive); `http://`, credentials, a query, a fragment,
 * whitespace, extra path segments and any character outside
 * `[A-Za-z0-9_.-]` in owner or repo are null.
 */
function parseGithubRepository(
  raw: string,
): { readonly owner: string; readonly repo: string } | null {
  let value = raw.trim();
  if (value.endsWith("/")) {
    value = value.slice(0, -1);
  }
  if (/[?#\s\\]/.test(value)) {
    return null;
  }
  const lowered = asciiLower(value);
  let path: string | null;
  if (lowered.startsWith("https://")) {
    path = pathAfterGithubHost(value.slice("https://".length), "/");
  } else if (lowered.startsWith("ssh://git@")) {
    path = pathAfterGithubHost(value.slice("ssh://git@".length), "/");
  } else if (lowered.startsWith("git@")) {
    path = pathAfterGithubHost(value.slice("git@".length), ":");
  } else if (lowered.startsWith(`${GITHUB_HOST}/`)) {
    path = value.slice(GITHUB_HOST.length + 1);
  } else {
    path = value.includes(":") ? null : value;
  }
  if (path === null) {
    return null;
  }
  if (path.endsWith(".git")) {
    path = path.slice(0, -4);
  }
  const segments = path.split("/");
  const [owner, repo] = segments;
  if (
    segments.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(repo) ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".."
  ) {
    return null;
  }
  return { owner, repo };
}

/** The comparison key of a repository (WB5b2): one function for both sides, ASCII-lower-cased `owner/repo`. */
function canonicalRepositoryKey(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseGithubRepository(raw);
  return parsed === null ? null : asciiLower(`${parsed.owner}/${parsed.repo}`);
}

/**
 * Whether two repository references name the same repository on the canonical
 * (ASCII-lower-cased) key: stored journal entries and links may carry the
 * pre-WB5b3 case of `owner/repo`, so the comparison never trusts the raw case.
 * An unreadable side is never equal to anything.
 */
function sameCanonicalRepository(left: unknown, right: unknown): boolean {
  const leftKey = canonicalRepositoryKey(left);
  return leftKey !== null && leftKey === canonicalRepositoryKey(right);
}

/**
 * The forge port's bound owner, ASCII-lower-cased (WB5b3): the owner a
 * snapshot's `headRepositoryOwner` must match for the merge to proceed. An
 * unbound or unreadable port is null — the caller refuses, never assuming
 * same-repository.
 */
function boundRepositoryOwner(
  deps: ExecuteAuthorizedForgeActionDependencies,
): string | null {
  let bound: ReturnType<ExecuteAuthorizedForgeActionDependencies["forgePort"]["boundRepository"]>;
  try {
    bound = deps.forgePort.boundRepository();
  } catch {
    return null;
  }
  if (bound === undefined) {
    return null;
  }
  return canonicalRepositoryKey(`${bound.owner}/x`) === null ? null : asciiLower(bound.owner);
}

/** The longest `actionId` whose completed journal id still fits the merge record's `actionRef`. */
function actionIdFitsActionRef(actionId: string): boolean {
  return (
    `forge:${actionId}:completed:`.length + ACTION_REF_SEQUENCE_DIGITS <=
    MERGE_RECORD_LIMITS.maxActionRefLength
  );
}

type PullRequestNumberResolution =
  | {
      readonly number: number | undefined;
      /** Set when the forge read shows the pull request already merged at the expected head. */
      readonly alreadyMerged?: true;
    }
  | { readonly reason: string };
const EXPECTED_HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

type ForgeActionRequestRead =
  | { readonly ok: true; readonly request: ExecuteAuthorizedForgeActionRequest }
  | { readonly ok: false; readonly reason: string };

/**
 * Descriptor-safe runtime validation of an authorized forge action request.
 * Every own key is read through its property descriptor, so no getter ever
 * runs; `null`, primitives, arrays (including sparse ones) and any accessor
 * property are a typed refusal, never a throw. Refusal reasons name the field
 * only, never the offending value.
 */
function readForgeActionRequest(raw: unknown): ForgeActionRequestRead {
  const refuse = (reason: string): ForgeActionRequestRead => ({
    ok: false,
    reason,
  });
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return refuse("request must be a plain object");
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== "string") {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined) {
        continue;
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return refuse("request fields must be plain data properties");
      }
      if (!descriptor.enumerable) {
        continue;
      }
      snapshot[key] = descriptor.value;
    }
    const refusal = requestSnapshotRefusal(snapshot);
    if (refusal !== null) {
      return refuse(refusal);
    }
    return {
      ok: true,
      request: snapshot as unknown as ExecuteAuthorizedForgeActionRequest,
    };
  } catch {
    return refuse("request could not be read");
  }
}

/** The first refusal reason for a request snapshot, in the original check order; null when valid. */
function requestSnapshotRefusal(snapshot: Record<string, unknown>): string | null {
  const idRefusal = requestIdFieldsRefusal(snapshot);
  if (idRefusal !== null) {
    return idRefusal;
  }
  const expectedHeadSha = snapshot["expectedHeadSha"];
  if (
    typeof expectedHeadSha !== "string" ||
    !EXPECTED_HEAD_SHA_PATTERN.test(expectedHeadSha)
  ) {
    return "expectedHeadSha must be a 40-character lowercase sha";
  }
  if (!(FORGE_ACTION_KINDS as readonly unknown[]).includes(snapshot["kind"])) {
    return "kind must be one of push-and-open-pr, push-to-pr, merge-pr, post-status";
  }
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const value = snapshot[field];
    // Only a string is checked here; a non-string value falls through to
    // the field's own rule (branch name, base branch, authorizedBy).
    if (typeof value === "string" && isPlanSecretShaped(value)) {
      return `${field} must be plain text`;
    }
  }
  const pullRequestNumber = snapshot["pullRequestNumber"];
  if (
    pullRequestNumber !== undefined &&
    (!Number.isSafeInteger(pullRequestNumber) ||
      (pullRequestNumber as number) < 1 ||
      (pullRequestNumber as number) > MAX_PULL_REQUEST_NUMBER)
  ) {
    return "pullRequestNumber must be a positive integer";
  }
  return null;
}

/** The refusal for the first request id field that is not safe plain text; null when all are. */
function requestIdFieldsRefusal(snapshot: Record<string, unknown>): string | null {
  for (const field of REQUEST_ID_FIELDS) {
    const value = snapshot[field];
    // A `push-to-pr` run key is a valid action id and contains `/`; a
    // backslash path separator is refused on every id.
    const separators = field === "actionId" ? ["\\"] : ["/", "\\"];
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.length > MAX_REQUEST_TEXT_CHARS ||
      separators.some((separator) => value.includes(separator)) ||
      isPlanSecretShaped(value)
    ) {
      return `${field} must be non-empty plain text of at most ${MAX_REQUEST_TEXT_CHARS} characters`;
    }
  }
  return null;
}

/**
 * The canonical UTC instant for link and merge records: the composition
 * clock's value, parsed and reformatted, so `2026-10-15T10:00:00Z` becomes
 * `2026-10-15T10:00:00.000Z`. Null when the clock throws or names an
 * unparseable instant; the caller refuses rather than guessing.
 */
function canonicalTimestampIso(now: (() => string) | undefined): string | null {
  try {
    const raw = now ? now() : new Date().toISOString();
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      return null;
    }
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * The work order's repository in canonical `owner/repo` form (WB5b3): the
 * case is ASCII-lowered so everything written from it — the typed journal
 * reference, the merge record, the pull-request link — stores the canonical
 * key, whatever case the work order named. A leading `github.com/` prefix is
 * stripped, and the result must satisfy the shared pull-request repository
 * rules. Anything else is null (unknown stays unknown).
 */
function normalizeWorkOrderRepository(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = parseGithubRepository(raw);
  if (parsed === null) {
    return null;
  }
  const candidate = asciiLower(`${parsed.owner}/${parsed.repo}`);
  if (
    pullRequestRefError("pr", { repository: candidate, number: 1 }) !== null
  ) {
    return null;
  }
  return candidate;
}

/** The work order's own lane tuple: its plan lane, or its project lane with no plan. */
function workOrderLane(workOrder: WorkOrderRecord): {
  readonly projectId: string;
  readonly planId: string | null;
  readonly laneId: string;
} {
  const planRef = workOrder.planRef;
  if (planRef !== undefined) {
    return {
      projectId: planRef.projectId,
      planId: planRef.planId,
      laneId: planRef.laneId,
    };
  }
  return {
    projectId: workOrder.projectId,
    planId: null,
    laneId: workOrder.laneId,
  };
}

export class ExecuteAuthorizedForgeActionUseCase implements ExecuteAuthorizedForgeActionPort {
  constructor(
    private readonly deps?: ExecuteAuthorizedForgeActionDependencies,
  ) {}

  async executeAuthorizedForgeAction(
    rawRequest: ExecuteAuthorizedForgeActionRequest,
  ): Promise<ExecuteAuthorizedForgeActionResult> {
    const deps = this.deps;
    if (!deps) {
      throw new Error("Not implemented: ExecuteAuthorizedForgeActionUseCase");
    }

    // The request is untrusted runtime input (WB5b): it is read through its
    // own property descriptors and refused, never thrown on, when it is not a
    // plain object of known shape. This runs before anything is consumed,
    // journalled or executed.
    const requestRead = readForgeActionRequest(rawRequest);
    if (!requestRead.ok) {
      return { outcome: "refused", reason: requestRead.reason };
    }
    const request = requestRead.request;

    // Forge mode `none` (D6) is an explicit installation choice: every forge
    // action refuses before anything is consumed, journalled or executed.
    if (deps.forgeMode === "none") {
      return {
        outcome: "refused",
        reason:
          "Forge mode is 'none': no forge transport is configured, so forge actions refuse",
      };
    }

    // The merge record's `actionRef` is the completed journal entry's id
    // (`forge:<actionId>:completed:<seq>`, at most 128 characters): an
    // operator action id that cannot fit refuses before the grant, never
    // after the merge has happened (WB5b2).
    if (request.kind === "merge-pr" && !actionIdFitsActionRef(request.actionId)) {
      return { outcome: "refused", reason: "action-id-too-long" };
    }

    // A policy-authorised action must name a policy setting revision (A8); an
    // owner grant leaves `authorizedBy` absent. Anything else refuses before a
    // grant is consumed or a journal entry is written (A11).
    if (
      request.authorizedBy !== undefined &&
      !AUTHORIZED_BY_PATTERN.test(request.authorizedBy)
    ) {
      return {
        outcome: "refused",
        reason: "authorizedBy must name a policy setting revision",
      };
    }

    // A requested branch must be safe like the forge read's rule (KF-5b); the
    // run's recorded branch already passed the LaneRun domain guard, but the
    // request is untrusted here and refuses before a grant is consumed.
    if (
      request.branchName !== undefined &&
      !isSafeBranchName(request.branchName)
    ) {
      return {
        outcome: "refused",
        reason: "branchName must be a safe branch name",
      };
    }

    // A requested base branch is only meaningful for push-and-open-pr, and
    // must parse as `main` or `chain/<lowercase-dashes>` before a grant is
    // consumed (CB-D2).
    if (
      request.kind === "push-and-open-pr" &&
      request.baseBranch !== undefined &&
      parseBaseBranch(request.baseBranch) === undefined
    ) {
      return { outcome: "refused", reason: BASE_BRANCH_INVALID_MESSAGE };
    }

    // post-status has no default branch: it posts the receipt of the run's
    // branch, so a missing branch refuses before a grant is consumed.
    if (request.kind === "post-status" && request.branchName === undefined) {
      return {
        outcome: "refused",
        reason: "branchName must be a safe branch name",
      };
    }

    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    const workOrder = await deps.workOrderRepo.findWorkOrderById(
      request.workOrderId,
    );
    if (attempt === null || workOrder === null) {
      return { outcome: "refused", reason: "Attempt or work order not found" };
    }

    // A moved head invalidates the readiness the action was authorised on.
    if (attempt.artifacts?.headCommit !== request.expectedHeadSha) {
      return {
        outcome: "refused",
        reason: "Moved head: attempt headCommit does not match expectedHeadSha",
      };
    }

    // One-way doors are re-checked at merge/push-and-open/push-to-pr time
    // through the same owner-decision ports acceptance used: an owner decision
    // withdrawn after a stored acceptance still refuses the forge action, and
    // the refusal happens before any authorization grant is consumed.
    const doorBlockers = await this.collectForgeDoorBlockers(deps, request);
    if (doorBlockers.length > 0) {
      return { outcome: "refused", reason: doorBlockers.join("; ") };
    }

    // Merge requires current-head acceptance; old readiness is not a receipt.
    // An out-port reads the evidence context's assessment; the merge proceeds
    // only when the assessment state is 'accepted', its head equals the request head,
    // its policy revision equals the attempt's, and its receipt id is non-null.
    // Stale or blocked -> refuse.
    if (request.kind === "merge-pr") {
      if (!deps.acceptanceEvidencePort) {
        return {
          outcome: "refused",
          reason: "Cannot merge without a configured acceptance evidence port",
        };
      }
      let acceptance: Awaited<
        ReturnType<AcceptanceEvidencePort["readAcceptance"]>
      >;
      try {
        acceptance = await deps.acceptanceEvidencePort.readAcceptance({
          attemptId: request.attemptId,
          candidateHeadSha: request.expectedHeadSha,
        });
      } catch (error: unknown) {
        // An evidence read that fails is not an absent assessment: it is an
        // unreadable one, and an unreadable assessment never merges.
        return {
          outcome: "refused",
          reason: `Cannot merge: acceptance evidence could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (acceptance.outcome !== "found") {
        return {
          outcome: "refused",
          reason: `Cannot merge: acceptance assessment not found for attempt ${request.attemptId}`,
        };
      }
      const assessment = acceptance.assessment;
      if (assessment.state === "stale") {
        return {
          outcome: "refused",
          reason: "Cannot merge: acceptance assessment is stale",
        };
      }
      if (assessment.state === "blocked") {
        return {
          outcome: "refused",
          reason: "Cannot merge: acceptance assessment is blocked",
        };
      }
      if (assessment.state !== "accepted") {
        return {
          outcome: "refused",
          reason: `Cannot merge: assessment state is '${assessment.state}', expected 'accepted'`,
        };
      }
      if (assessment.candidateHeadSha !== request.expectedHeadSha) {
        return {
          outcome: "refused",
          reason: `Cannot merge: assessment head '${assessment.candidateHeadSha}' does not match expectedHeadSha '${request.expectedHeadSha}'`,
        };
      }
      if (assessment.policyRevision !== workOrder.policyRevision) {
        return {
          outcome: "refused",
          reason: `Cannot merge: assessment policy revision '${assessment.policyRevision}' does not match attempt policy revision '${workOrder.policyRevision}'`,
        };
      }
      if (!assessment.acceptanceReceiptId) {
        return {
          outcome: "refused",
          reason: "Cannot merge: acceptance assessment has no receipt ID",
        };
      }
    }

    if (
      typeof deps.forgePort.isConfigured === "function" &&
      !deps.forgePort.isConfigured()
    ) {
      return {
        outcome: "refused",
        reason: "unavailable",
      };
    }

    // The canonical instant for link and merge records (WB5b): an unreadable
    // clock refuses before a grant is consumed.
    const canonicalNowIso = canonicalTimestampIso(deps.now);
    if (canonicalNowIso === null) {
      return {
        outcome: "refused",
        reason: "the internal clock could not be read",
      };
    }

    const normalizedRepository = normalizeWorkOrderRepository(
      workOrder.repository,
    );

    // The PR number is resolved structurally before the forge runs (WB5b):
    // from the request, from the attempt's typed journal entries, or from the
    // lane's single stored link — never by parsing journal text, never
    // guessed. A thrown pre-flight read refuses before the grant is consumed.
    // The verifying read, the merge and the record must name one repository
    // (WB5b2): the work order's must be the one the forge port is bound to.
    if (request.kind === "merge-pr") {
      const mismatch = this.boundRepositoryRefusal(deps, workOrder.repository);
      if (mismatch !== null) {
        return { outcome: "refused", reason: mismatch };
      }
    }
    let preResolvedPrNumber: number | undefined;
    let alreadyMerged = false;
    let legacyLookup = false;
    // A merge with nowhere to record it refuses first, before any forge read.
    if (request.kind === "merge-pr" && deps.mergeRecordRepo === undefined) {
      return { outcome: "refused", reason: "merge-record-store-unavailable" };
    }
    if (
      (PULL_REQUEST_ACTION_KINDS as readonly string[]).includes(request.kind)
    ) {
      let resolution: PullRequestNumberResolution;
      try {
        resolution = await this.preResolvePullRequestNumber(
          deps,
          request,
          attempt,
          workOrder,
          normalizedRepository,
        );
      } catch {
        return {
          outcome: "refused",
          reason: "a pre-flight pull-request read failed",
        };
      }
      if ("reason" in resolution) {
        return { outcome: "refused", reason: resolution.reason };
      }
      preResolvedPrNumber = resolution.number;
      alreadyMerged = resolution.alreadyMerged === true;
    }

    // A merge with nowhere to record it, or one that cannot say which pull
    // request it merges, would mark the work order merged with no merge
    // record: refuse before the grant is consumed and before any forge call.
    if (request.kind === "merge-pr") {
      // An attempt opened before WB5b has neither a typed journal reference
      // nor a stored link: one read-only lookup of the open pull request for
      // the attempt's branch may name it, never a guess.
      if (
        preResolvedPrNumber === undefined &&
        normalizedRepository !== null &&
        deps.forgePort.findOpenPullRequestsByHead !== undefined
      ) {
        const legacy = await this.legacyHeadLookup(
          deps,
          request,
          workOrder,
          normalizedRepository,
        );
        if ("reason" in legacy) {
          return { outcome: "refused", reason: legacy.reason };
        }
        preResolvedPrNumber = legacy.number;
        legacyLookup = true;
      }
      if (normalizedRepository === null || preResolvedPrNumber === undefined) {
        return {
          outcome: "refused",
          reason: "the pull request number could not be resolved for the merge",
        };
      }
    }

    const authorization =
      await deps.authorizationPort.consumeActionAuthorization({
        authorizationGrantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionKind: request.kind,
        expectedHeadSha: request.expectedHeadSha,
        attemptId: request.attemptId,
      });
    if (authorization.outcome !== "consumed") {
      await this.appendJournal(
        deps,
        request,
        attempt,
        "refused",
        authorization.reason,
      );
      return { outcome: "refused", reason: authorization.reason };
    }

    // Intent is durable before the forge subprocess runs.
    await this.appendJournal(
      deps,
      request,
      attempt,
      "intent-recorded",
      `kind=${request.kind} expectedHeadSha=${request.expectedHeadSha}`,
    );

    let forgeResult: Awaited<
      ReturnType<typeof deps.forgePort.performForgeAction>
    >;
    try {
      // A pull request the read shows merged at the expected head is never
      // merged again (WB5b2): a pass that only lost its merge record completes
      // the record from the typed journal reference.
      forgeResult = alreadyMerged
        ? { outcome: "executed", headSha: request.expectedHeadSha }
        : await deps.forgePort.performForgeAction({
        actionId: request.actionId,
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        kind: request.kind,
        expectedHeadSha: request.expectedHeadSha,
        // The run's recorded branch wins when the request carries one; absent
        // keeps the manual/auto-merge default (KF-5b). post-status always
        // carries a branch (refused above when absent), so the default never
        // applies to it.
        branchName: request.branchName ?? `feat/${workOrder.laneId}`,
        // Title/body are forwarded only when opening a PR; push-to-pr and
        // merge never carry them (K6-2). The PR base branch (CB-D2) is
        // forwarded the same way.
        ...(request.kind === "push-and-open-pr"
          ? {
              ...(request.title !== undefined ? { title: request.title } : {}),
              ...(request.body !== undefined ? { body: request.body } : {}),
              ...(request.baseBranch !== undefined
                ? { baseBranch: request.baseBranch }
                : {}),
            }
          : {}),
        // The status body is forwarded only for post-status.
        ...(request.kind === "post-status" && request.status !== undefined
          ? { status: request.status }
          : {}),
        // The structurally pre-resolved PR number (WB5b) is forwarded when known.
        ...(preResolvedPrNumber !== undefined
          ? { pullRequestNumber: preResolvedPrNumber }
          : {}),
      });
    } catch (error) {
      // The intent is durable but the forge outcome was not recorded; journal
      // the ambiguous outcome before propagating the original forge error.
      try {
        await this.appendJournal(
          deps,
          request,
          attempt,
          "ambiguous",
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // A journalling failure must not mask the original forge error.
      }
      throw error;
    }

    if (forgeResult.outcome === "executed") {
      const resolvedPrNumber =
        forgeResult.pullRequestNumber ?? preResolvedPrNumber;
      // The typed pull-request reference rides on the completed entry (WB5b):
      // merge and PR producers read it structurally, never from `detail`.
      // Note `detail` keeps the executor's rule: a merge entry never says
      // "pull request", or the auto-merge path would misread it.
      const pullRequestRef: ActionJournalPullRequestRef | undefined =
        request.kind !== "post-status" &&
        normalizedRepository !== null &&
        resolvedPrNumber !== undefined
          ? { repository: normalizedRepository, number: resolvedPrNumber }
          : undefined;

      // Coordinator entry condition (a): the `completed` journal entry is
      // durably appended FIRST. If this throws, neither the pull-request
      // link, nor the merge record, nor `markMerged` may run.
      const completedEntry = await this.appendJournal(
        deps,
        request,
        attempt,
        "completed",
        completedDetail(request, forgeResult, legacyLookup),
        pullRequestRef,
      );

      // SECOND: the pull request's one lane. A refused link (the PR is
      // already linked to another lane) is persisted as a conflict record,
      // and the merge fact is still written below — a link conflict never
      // erases the merge.
      let lanePlanFailure: unknown;
      if (
        deps.lanePlanRepo !== undefined &&
        request.kind !== "post-status" &&
        normalizedRepository !== null &&
        resolvedPrNumber !== undefined
      ) {
        try {
          await this.recordPullRequestLink(
            deps,
            workOrder,
            normalizedRepository,
            resolvedPrNumber,
            canonicalNowIso,
          );
        } catch (error: unknown) {
          lanePlanFailure = error;
        }
      }

      // THIRD (merge only): the merge record, written exclusively through
      // `saveMergeRecord` — and therefore always through the domain's
      // `decideMergeRecord` — with the completed journal entry's id as the
      // `actionRef`.
      if (request.kind === "merge-pr") {
        if (
          deps.mergeRecordRepo !== undefined &&
          normalizedRepository !== null &&
          resolvedPrNumber !== undefined
        ) {
          const created = MergeRecord.create({
            schemaVersion: 1,
            repository: normalizedRepository,
            number: resolvedPrNumber,
            headSha: forgeResult.headSha,
            mergedAtIso: canonicalNowIso,
            firstSeenAtIso: canonicalNowIso,
            source: "fleet-forge-action",
            merger: "fleet",
            actionRef: completedEntry.id,
          });
          // The record is the merge's durable fact (WB5b2): a refused,
          // conflicting or thrown save never advances the work order. The
          // completed entry above carries the typed pull-request reference, and
          // the ambiguous entry below marks the merge for a pass to complete
          // (that pass reads the pull request as merged and never merges again).
          let saveFailure: string | null = created.success ? null : "invalid";
          if (created.success) {
            try {
              const saved = await deps.mergeRecordRepo.saveMergeRecord(
                created.value.toRecord(),
              );
              if (
                saved.outcome === "refused" ||
                saved.outcome === "integrity-conflict"
              ) {
                saveFailure = saved.outcome;
              }
            } catch {
              saveFailure = "unavailable";
            }
          }
          if (saveFailure !== null) {
            await this.appendJournal(
              deps,
              request,
              attempt,
              "ambiguous",
              `merge-record-not-saved:${saveFailure}`,
              pullRequestRef,
            );
            return {
              outcome: "refused",
              reason: "merge-record-not-saved",
              forgeAmbiguous: true,
            };
          }
        }
        // FOURTH: a completed merge advances the work order.
        await this.markMerged(deps, workOrder);
      }

      if (lanePlanFailure !== undefined) {
        throw lanePlanFailure;
      }

      return forgeResult.pullRequestNumber !== undefined
        ? {
            outcome: "executed",
            pullRequestNumber: forgeResult.pullRequestNumber,
            headSha: forgeResult.headSha,
          }
        : { outcome: "executed", headSha: forgeResult.headSha };
    }
    if (forgeResult.outcome === "ambiguous") {
      await this.appendJournal(
        deps,
        request,
        attempt,
        "ambiguous",
        forgeResult.reason,
      );
      return {
        outcome: "refused",
        reason: `Ambiguous forge response requires reconciliation: ${forgeResult.reason}`,
        forgeAmbiguous: true,
      };
    }
    await this.appendJournal(
      deps,
      request,
      attempt,
      "refused",
      forgeResult.reason,
    );
    return {
      outcome: "refused",
      reason: forgeResult.reason,
      forgeRefusalKind: forgeResult.refusalKind,
    };
  }

  async execute(input?: unknown): Promise<ExecuteAuthorizedForgeActionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error("Not implemented: ExecuteAuthorizedForgeActionUseCase");
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== "object") {
      throw new Error("Not implemented: ExecuteAuthorizedForgeActionUseCase");
    }
    // An array body is a refusal, never an attempt to read indexed fields.
    if (Array.isArray(input)) {
      return { outcome: "refused", reason: "request must be a plain object" };
    }
    // The HTTP entry point copies every own data property and drops
    // `authorizedBy` so a body can never label a merge as a policy merge
    // (A8). Values are read through their own descriptors, so no getter ever
    // runs; accessor and non-enumerable keys are skipped, not invoked.
    const snapshot: Record<string, unknown> = {};
    try {
      for (const key of Reflect.ownKeys(input)) {
        if (
          typeof key !== "string" ||
          key === "authorizedBy" ||
          key === "__proto__"
        ) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        ) {
          continue;
        }
        snapshot[key] = descriptor.value;
      }
    } catch {
      return { outcome: "refused", reason: "request could not be read" };
    }
    return this.executeAuthorizedForgeAction(
      snapshot as unknown as ExecuteAuthorizedForgeActionRequest,
    );
  }

  /** A completed merge advances the work order to the terminal 'merged' state. */
  private async markMerged(
    deps: ExecuteAuthorizedForgeActionDependencies,
    workOrderRecord: WorkOrderRecord,
  ): Promise<void> {
    const workOrder = WorkOrder.fromRecord(workOrderRecord);
    await deps.workOrderRepo.saveWorkOrder({
      ...workOrderRecord,
      state: "merged",
      revision: workOrder.nextRevision(),
      updatedAtIso: deps.now?.() ?? new Date().toISOString(),
    });
  }

  private async appendJournal(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
    attempt: AttemptRecord,
    status: ActionJournalEntryRecord["status"],
    detail: string | null,
    pullRequest?: ActionJournalPullRequestRef,
  ): Promise<ActionJournalEntryRecord> {
    const priorEntries = await deps.journal.listJournalEntriesForAttempt(
      request.attemptId,
    );
    const sequence = priorEntries.length + 1;
    const entry: ActionJournalEntryRecord = {
      id: `forge:${request.actionId}:${status}:${sequence}`,
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      action: "forge",
      baseCommit: attempt.baseCommit,
      recordedAtIso: deps.now?.() ?? new Date().toISOString(),
      status,
      sessionId: null,
      detail,
      ...(request.authorizedBy === undefined
        ? {}
        : { authorizedBy: request.authorizedBy }),
      ...(pullRequest !== undefined ? { pullRequest } : {}),
    };
    await deps.journal.appendJournalEntry(entry);
    return entry;
  }

  /**
   * Resolve the pull-request number structurally before the forge runs
   * (WB5b): the request's own number, the attempt's latest completed `forge`
   * journal entry carrying a typed reference, and the lane's single stored
   * link. A thrown read propagates: the caller refuses before a grant is
   * consumed. The other kinds keep the first source in that order.
   *
   * A merge (WB5b2) collects every source and refuses when two differ, then
   * verifies the resolved number on the forge before the grant.
   */
  private async preResolvePullRequestNumber(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
    attempt: AttemptRecord,
    workOrder: WorkOrderRecord,
    normalizedRepository: string | null,
  ): Promise<PullRequestNumberResolution> {
    if (request.kind !== "merge-pr") {
      if (request.pullRequestNumber !== undefined) {
        return { number: request.pullRequestNumber };
      }
      const fromJournal = await this.typedJournalNumber(
        deps,
        attempt,
        normalizedRepository,
      );
      return {
        number:
          fromJournal ??
          (await this.storedLinkNumber(deps, workOrder, normalizedRepository)),
      };
    }
    // The attempt's latest typed reference naming another repository is a
    // disagreement, never silently skipped (WB5b2).
    if (
      await this.journalNamesOtherRepository(deps, attempt, normalizedRepository)
    ) {
      return { reason: "pull-request-sources-disagree" };
    }
    const journalNumber = await this.typedJournalNumber(
      deps,
      attempt,
      normalizedRepository,
    );
    const linkNumber = await this.storedLinkNumber(
      deps,
      workOrder,
      normalizedRepository,
    );
    const present = [request.pullRequestNumber, journalNumber, linkNumber].filter(
      (value): value is number => value !== undefined,
    );
    const resolved = present[0];
    if (resolved === undefined) {
      return { number: undefined };
    }
    if (present.some((value) => value !== resolved)) {
      return { reason: "pull-request-sources-disagree" };
    }
    return this.verifyMergeNumber(deps, request, workOrder, normalizedRepository, {
      number: resolved,
      confirmedBySource: journalNumber !== undefined || linkNumber !== undefined,
      linkInvolved: linkNumber !== undefined,
    });
  }

  /**
   * `repository-unbound`, `repository-invalid` or `repository-mismatch` when
   * the port's bound repository is not the work order's; null when they match.
   * Both sides go through one normalisation.
   */
  private boundRepositoryRefusal(
    deps: ExecuteAuthorizedForgeActionDependencies,
    workOrderRepository: unknown,
  ): string | null {
    let bound: ReturnType<ExecuteAuthorizedForgeActionDependencies["forgePort"]["boundRepository"]>;
    try {
      bound = deps.forgePort.boundRepository();
    } catch {
      return "repository-unbound";
    }
    if (bound === undefined) {
      return "repository-unbound";
    }
    const boundKey = canonicalRepositoryKey(`${bound.owner}/${bound.repo}`);
    const workOrderKey = canonicalRepositoryKey(workOrderRepository);
    if (boundKey === null || workOrderKey === null) {
      return "repository-invalid";
    }
    return boundKey === workOrderKey ? null : "repository-mismatch";
  }

  /** Whether the attempt's latest completed typed `forge` reference is for a repository other than this one. */
  private async journalNamesOtherRepository(
    deps: ExecuteAuthorizedForgeActionDependencies,
    attempt: AttemptRecord,
    normalizedRepository: string | null,
  ): Promise<boolean> {
    if (normalizedRepository === null) {
      return false;
    }
    const entries = await deps.journal.listJournalEntriesForAttempt(attempt.id);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (
        entry?.status === "completed" &&
        entry.action === "forge" &&
        entry.pullRequest !== undefined
      ) {
        // A stored entry may name the repository in pre-WB5b3 case; the
        // comparison is on the canonical key, never the raw string.
        return !sameCanonicalRepository(entry.pullRequest.repository, normalizedRepository);
      }
    }
    return false;
  }
  /** The attempt's latest completed `forge` entry carrying a typed reference. */
  private async typedJournalNumber(
    deps: ExecuteAuthorizedForgeActionDependencies,
    attempt: AttemptRecord,
    normalizedRepository: string | null,
  ): Promise<number | undefined> {
    const entries = await deps.journal.listJournalEntriesForAttempt(attempt.id);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (
        entry?.status === "completed" &&
        entry.action === "forge" &&
        entry.pullRequest !== undefined &&
        (normalizedRepository === null ||
          sameCanonicalRepository(entry.pullRequest.repository, normalizedRepository))
      ) {
        return entry.pullRequest.number;
      }
    }
    return undefined;
  }

  /** The lane's single stored link in the repository; zero or several are never guessed between. */
  private async storedLinkNumber(
    deps: ExecuteAuthorizedForgeActionDependencies,
    workOrder: WorkOrderRecord,
    normalizedRepository: string | null,
  ): Promise<number | undefined> {
    const lanePlanRepo = deps.lanePlanRepo;
    if (lanePlanRepo === undefined || normalizedRepository === null) {
      return undefined;
    }
    const lane = workOrderLane(workOrder);
    // A stored link carries the plan's current lane id while the work order
    // may carry an old alias: both sides are resolved before comparing.
    const resolveLaneId = await laneAliasResolver(
      lanePlanRepo,
      lane.projectId,
      lane.planId,
    );
    const wantedLaneId = resolveLaneId(lane.laneId);
    const links = await lanePlanRepo.listPullRequestLinks(lane.projectId);
    const matches = links.filter(
      (link) =>
        sameCanonicalRepository(link.repository, normalizedRepository) &&
        link.projectId === lane.projectId &&
        link.planId === lane.planId &&
        resolveLaneId(link.laneId) === wantedLaneId,
    );
    return matches.length === 1 ? matches[0]?.number : undefined;
  }

  /**
   * Verify the merge's resolved number on the forge (WB5b2), whatever its
   * source: it must be open, on the attempt's branch, at the expected head. A
   * number a journal entry or a stored link already names may instead be
   * merged at the expected head (a pass that lost its record): that completes
   * the record without merging again. Anything else refuses, as stale when a
   * stored link is involved; an unreadable answer refuses too.
   */
  private async verifyMergeNumber(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
    workOrder: WorkOrderRecord,
    normalizedRepository: string | null,
    candidate: {
      readonly number: number;
      readonly confirmedBySource: boolean;
      readonly linkInvolved: boolean;
    },
  ): Promise<PullRequestNumberResolution> {
    const verified = await this.verifyPullRequest(
      deps,
      normalizedRepository,
      candidate.number,
    );
    if (verified.outcome === "unreadable") {
      return { reason: "pull-request-unverified" };
    }
    const snapshot = verified.snapshot;
    // A fork's pull request is refused before the grant and before any forge
    // write, whatever the source of the number (WB5b3): the head branch name
    // and head commit of a fork PR can otherwise pass this same verification
    // and be merged in the target repository. The head owner must also name
    // the repository the read was made against; an owner that cannot be named
    // refuses too — never assuming same-repository.
    if (snapshot.isCrossRepository || verified.readOwner === null) {
      return { reason: "pull-request-cross-repository" };
    }
    if (asciiLower(snapshot.headRepositoryOwner) !== verified.readOwner) {
      return { reason: "pull-request-cross-repository" };
    }
    const failure = candidate.linkInvolved
      ? "pull-request-link-stale"
      : "pull-request-unverified";
    const branch = request.branchName ?? `feat/${workOrder.laneId}`;
    // Open or merged, the pull request must be the attempt's branch at the
    // expected head; the read itself was made against the bound repository.
    if (
      snapshot.headSha !== request.expectedHeadSha ||
      snapshot.headRef !== branch
    ) {
      return { reason: failure };
    }
    if (snapshot.state === "merged" && candidate.confirmedBySource) {
      return { number: candidate.number, alreadyMerged: true };
    }
    return snapshot.state === "open"
      ? { number: candidate.number }
      : { reason: failure };
  }

  /**
   * One bounded read of the pull request (WB5b2). A missing reader, an
   * unbound repository, a not-found, an unavailable answer, a malformed
   * snapshot, a snapshot of another number or a throw is `unreadable`:
   * unknown stays unknown.
   */
  private async verifyPullRequest(
    deps: ExecuteAuthorizedForgeActionDependencies,
    normalizedRepository: string | null,
    number: number,
  ): Promise<
    | {
        readonly outcome: "read";
        readonly snapshot: PullRequestSnapshot;
        /** The ASCII-lower-cased owner of the repository the read targeted; null when it cannot be named. */
        readonly readOwner: string | null;
      }
    | { readonly outcome: "unreadable" }
  > {
    const reader = deps.forgeRead;
    if (reader === undefined || normalizedRepository === null) {
      return { outcome: "unreadable" };
    }
    // A repository that is not `owner/repo` leaves the reader's own bound
    // repository in charge.
    const [owner, repo, ...rest] = normalizedRepository.split("/");
    const repository =
      owner !== undefined && repo !== undefined && rest.length === 0
        ? { repository: { owner, repo } }
        : {};
    const readOwner =
      owner !== undefined && repo !== undefined && rest.length === 0
        ? asciiLower(owner)
        : boundRepositoryOwner(deps);
    try {
      const read = await reader.readPullRequest({
        ref: { kind: "number", number },
        ...repository,
        timeoutMs: PULL_REQUEST_VERIFY_TIMEOUT_MS,
      });
      if (
        read.outcome !== "found" ||
        read.pullRequest.number !== number ||
        typeof read.pullRequest.headSha !== "string" ||
        typeof read.pullRequest.headRef !== "string"
      ) {
        return { outcome: "unreadable" };
      }
      return { outcome: "read", snapshot: read.pullRequest, readOwner };
    } catch {
      return { outcome: "unreadable" };
    }
  }

  /**
   * The legacy pull-request lookup (WB5b): exactly one open pull request of
   * the bound repository's own branch whose head is the expected head names
   * the merge. Zero, several, a head mismatch or an unreadable answer each
   * refuse with their own reason; a thrown read is unreadable.
   */
  private async legacyHeadLookup(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
    workOrder: WorkOrderRecord,
    repository: string,
  ): Promise<{ readonly number: number } | { readonly reason: string }> {
    const lookup = deps.forgePort.findOpenPullRequestsByHead;
    if (lookup === undefined) {
      return { reason: "legacy-pr-lookup-unreadable" };
    }
    let answer: Awaited<ReturnType<typeof lookup>>;
    try {
      answer = await lookup.call(deps.forgePort, {
        repository,
        branchName: request.branchName ?? `feat/${workOrder.laneId}`,
      });
    } catch {
      return { reason: "legacy-pr-lookup-unreadable" };
    }
    if (answer.outcome !== "read") {
      // The adapter's own typed reasons (unbound or mismatched repository)
      // pass through; any other unreadable answer is the generic reason.
      return {
        reason: LEGACY_LOOKUP_PASS_THROUGH_REASONS.has(answer.reason)
          ? answer.reason
          : "legacy-pr-lookup-unreadable",
      };
    }
    if (answer.pullRequests.length === 0) {
      return { reason: "legacy-pr-lookup-none-found" };
    }
    if (answer.pullRequests.length > 1) {
      return { reason: "legacy-pr-lookup-ambiguous" };
    }
    const only = answer.pullRequests[0];
    if (only?.headSha !== request.expectedHeadSha) {
      return { reason: "legacy-pr-lookup-head-mismatch" };
    }
    return { number: only.number };
  }

  /**
   * Record the pull request's one lane (WB5b). A work order with a plan
   * resolves any lane alias to the plan's current lane id; a work order
   * without a plan links its own project lane with a null plan id. When the
   * PR is already linked to a different lane, the conflict is persisted for
   * the board and the caller still writes the merge record.
   */
  private async recordPullRequestLink(
    deps: ExecuteAuthorizedForgeActionDependencies,
    workOrder: WorkOrderRecord,
    repository: string,
    number: number,
    linkedAtIso: string,
  ): Promise<void> {
    const lanePlanRepo = deps.lanePlanRepo;
    if (lanePlanRepo === undefined) {
      return;
    }
    const lane = workOrderLane(workOrder);
    const resolveLaneId = await laneAliasResolver(
      lanePlanRepo,
      lane.projectId,
      lane.planId,
    );
    const laneId = resolveLaneId(lane.laneId);
    const created = PullRequestLink.create({
      version: 1,
      repository,
      number,
      projectId: lane.projectId,
      planId: lane.planId,
      laneId,
      source: "fleet-forge-action",
      linkedAtIso,
    });
    if (!created.success) {
      // The lane identity could not form a valid link; the merge fact is
      // still recorded downstream, so this never blocks the merge itself.
      return;
    }
    const saved = await lanePlanRepo.savePullRequestLink(
      created.value.toRecord(),
    );
    if (!(saved.outcome === "refused" && saved.code === "pr-already-linked")) {
      return;
    }
    const existing = await lanePlanRepo.findPullRequestLink(repository, number);
    if (existing === null) {
      // The refusal could not be corroborated by a stored link; nothing is
      // invented and no conflict is recorded.
      return;
    }
    const sameLane =
      existing.projectId === lane.projectId &&
      existing.planId === lane.planId &&
      resolveLaneId(existing.laneId) === laneId;
    if (sameLane) {
      // The stored link names the same plan lane only under an alias the
      // plan confirms; a different lane of the same plan is a conflict.
      return;
    }
    const conflictRecord: PullRequestLinkConflictRecord = {
      schemaVersion: 1,
      repository,
      number,
      linkedLane: {
        projectId: existing.projectId,
        planId: existing.planId,
        laneId: existing.laneId,
      },
      refusedLane: {
        projectId: lane.projectId,
        planId: lane.planId,
        laneId,
      },
      recordedAtIso: linkedAtIso,
    };
    await lanePlanRepo.savePullRequestLinkConflict?.(conflictRecord);
  }

  /**
   * Merge-time re-check of the attempt's one-way doors. The doors come from
   * the attempt record through the attempt owner-decision port and every
   * reference is resolved through the same owner-decision port acceptance
   * used. An attempt recorded before doors were frozen, a reference that
   * cannot be seen approved, or an unreadable port all refuse the action.
   */
  private async collectForgeDoorBlockers(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
  ): Promise<string[]> {
    const blockers: string[] = [];
    const attemptOwnerDecisionPort = deps.attemptOwnerDecisionPort;
    if (attemptOwnerDecisionPort === undefined) {
      return [
        `owner decision references for attempt '${request.attemptId}' could not be read: no attempt owner decision port is configured`,
      ];
    }
    let recorded: Awaited<
      ReturnType<AttemptOwnerDecisionPort["readAttemptOwnerDecisionReferences"]>
    >;
    try {
      recorded =
        await attemptOwnerDecisionPort.readAttemptOwnerDecisionReferences({
          attemptId: request.attemptId,
        });
    } catch (error: unknown) {
      return [
        `owner decision references for attempt '${request.attemptId}' could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }
    if (recorded.outcome !== "recorded") {
      return [
        `owner decision references for attempt '${request.attemptId}' are unknown: ${recorded.reason}`,
      ];
    }
    for (const reference of recorded.ownerDecisionReferences) {
      const ownerDecisionPort = deps.ownerDecisionPort;
      if (ownerDecisionPort === undefined) {
        blockers.push(
          `owner decision '${reference}' could not be resolved: no owner decision port is configured`,
        );
        continue;
      }
      let decision;
      try {
        decision = await ownerDecisionPort.resolveOwnerDecision({
          decisionReference: reference,
          candidateHeadSha: request.expectedHeadSha,
        });
      } catch (error: unknown) {
        blockers.push(
          `owner decision '${reference}' could not be resolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (decision.outcome === "approved") {
        continue;
      }
      if (decision.outcome === "not-approved") {
        blockers.push(
          `owner decision '${reference}' is not approved: ${decision.reason}`,
        );
      } else {
        blockers.push(
          `owner decision '${reference}' is unknown: ${decision.reason}`,
        );
      }
    }
    return blockers;
  }
}

/**
 * Resolve a lane id to the plan's current lane id through the plan's confirmed
 * aliases. Without a plan, or for an id the plan does not know, the id is
 * returned unchanged.
 */
async function laneAliasResolver(
  lanePlanRepo: LanePlanRepositoryPort,
  projectId: string,
  planId: string | null,
): Promise<(laneId: string) => string> {
  if (planId === null) {
    return (laneId) => laneId;
  }
  const plan = await lanePlanRepo.findLanePlan(projectId, planId);
  if (plan === null) {
    return (laneId) => laneId;
  }
  return (laneId) =>
    plan.lanes.find(
      (candidate) =>
        candidate.laneId === laneId || candidate.aliases.includes(laneId),
    )?.laneId ?? laneId;
}
