// Lane CO24: PR-feedback fix round — prepare a fix attempt from unresolved review threads.
/**
 * PreparePullRequestFeedbackFixUseCase reads one pull request's unresolved
 * review threads at the exact current head through
 * `PullRequestFindingsReadPort`, wraps every forge-sourced text as untrusted
 * input, and prepares a fresh fix attempt through `PrepareFixAttemptPort`
 * with the numbered findings. The round's identity is the key
 * `pr-feedback/<pullRequest>@<head12>`; a repeat under the same key never
 * creates a second attempt. The fixed head is pushed only through
 * `ExecuteAuthorizedForgeActionPort` with `push-to-pr`: that path durably
 * consumes the run's grant for exactly this action (kind, head and attempt
 * scoped) before the forge runs, so a missing, unknown, already-consumed or
 * mismatched grant refuses and nothing is pushed. Two head probes guard the
 * push so a crash between the push and its result recovers on the next call.
 * The request's repository must be the one repository this composition's
 * forge path acts on. The use case
 * never resolves, replies to or comments on a thread, and returns ids, codes
 * and counts only — no path, no forge text, no token.
 *
 * A configured use case never throws on runtime input: a malformed request
 * (a throwing getter included), a malformed dependency answer or a failing
 * dependency is a typed refusal.
 */

import { wrapUntrusted } from '@fleet/evidence-and-acceptance';
import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import type { PrepareFixAttemptPort } from '../ports/in/PrepareFixAttemptPort.in-port.js';
import type {
  PreparePullRequestFeedbackFixCode,
  PreparePullRequestFeedbackFixPort,
  PreparePullRequestFeedbackFixRequest,
  PreparePullRequestFeedbackFixResult,
  PushPullRequestFeedbackFixRequest,
  PushPullRequestFeedbackFixResult,
} from '../ports/in/PreparePullRequestFeedbackFixPort.in-port.js';
import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionResult,
} from '../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type {
  PullRequestFinding,
  PullRequestFindingsReadPort,
  PullRequestFindingsResult,
} from '../ports/out/PullRequestFindingsReadPort.out-port.js';

export interface PreparePullRequestFeedbackFixDependencies {
  readonly findings: PullRequestFindingsReadPort;
  readonly prepareFixAttempt: PrepareFixAttemptPort;
  /**
   * The one authorised forge path: it consumes the run's grant for this
   * action before the credential-bearing `push-to-pr` runs. There is no
   * direct ForgeActionPort dependency, so no push can skip the grant.
   */
  readonly executeForgeAction: ExecuteAuthorizedForgeActionPort;
  /**
   * The repository the bound forge path acts on. A request naming another
   * repository refuses `repository-mismatch`, so findings read from one
   * repository never drive a push to another.
   */
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly nowIso?: () => string;
  /** Mints one nonce per wrapped finding (16 to 64 lowercase hex characters). */
  readonly mintNonce: () => string;
}

/** At most this many findings, UTF-8 bytes per numbered fix, and bytes for the whole handover. */
export const PR_FEEDBACK_MAX_FINDINGS = 200;
export const PR_FEEDBACK_MAX_FIX_BYTES = 8 * 1024;
export const PR_FEEDBACK_MAX_HANDOVER_BYTES = 32 * 1024;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9_.:@/-]{1,200}$/;
/** The forge path's refusal when no forge transport is bound (ExecuteAuthorizedForgeActionUseCase). */
const FORGE_UNCONFIGURED_REASON = 'unavailable';
/** ExecuteAuthorizedForgeActionUseCase's refusal prefixes for forge mode `none` and an attempt whose head is not the pushed head. */
const FORGE_MODE_NONE_PREFIX = "Forge mode is 'none'";
const ATTEMPT_HEAD_MOVED_PREFIX = 'Moved head:';
const NONCE_PATTERN = /^[0-9a-f]{16,64}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_=-]{1,128}$/;
const FINDING_LABEL = 'review finding';
const ALREADY_EXISTS_PREFIX = 'Fix attempt id already exists';
const MAX_UNHEALTHY_SEATS = 100;

type Refused = Extract<PreparePullRequestFeedbackFixResult, { outcome: 'refused' }>;

function refuse(code: PreparePullRequestFeedbackFixCode, detail?: string): Refused {
  return detail === undefined ? { outcome: 'refused', code } : { outcome: 'refused', code, detail };
}

/** One own data property, read without running a getter; undefined for anything else. */
function ownData(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor === undefined ? undefined : descriptor.value;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Branch names stay one safe git ref segment path (the rule `ForgeActionAdapter` applies). */
function isSafeBranchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('..') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

function readRepository(request: unknown): { owner: string; repo: string } | null {
  const repository = ownData(request, 'repository');
  const owner = ownData(repository, 'owner');
  const repo = ownData(repository, 'repo');
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    !REPOSITORY_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repo)
  ) {
    return null;
  }
  return { owner, repo };
}

function readPullRequestNumber(request: unknown): number | null {
  const value = ownData(request, 'pullRequestNumber');
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function readCommit(request: unknown, key: string): string | null {
  const value = ownData(request, key);
  return typeof value === 'string' && COMMIT_PATTERN.test(value) ? value : null;
}

/** An optional non-empty string field: absent is `undefined`, a wrong type is `null`. */
function readOptionalId(request: unknown, key: string): string | undefined | null {
  const value = ownData(request, key);
  if (value === undefined) {
    return undefined;
  }
  return isNonEmptyString(value) ? value : null;
}

/** An optional dense array of strings: absent is `undefined`, sparse or wrong-typed is `null`. */
function readOptionalStrings(request: unknown, key: string): readonly string[] | undefined | null {
  const value = ownData(request, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_UNHEALTHY_SEATS) {
    return null;
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = ownData(value, String(index));
    if (typeof item !== 'string') {
      return null;
    }
    items.push(item);
  }
  return items;
}

function readOptionalIso(request: unknown): string | undefined | null {
  const value = ownData(request, 'nowIso');
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function head12Of(headSha: string): string {
  return headSha.slice(0, 12);
}

function keyOf(pullRequestNumber: number, headSha: string): string {
  return `pr-feedback/${pullRequestNumber}@${head12Of(headSha)}`;
}

function derivedFixAttemptId(pullRequestNumber: number, headSha: string): string {
  return `pr-feedback-${pullRequestNumber}-${head12Of(headSha)}`;
}

function secretShaped(text: string): boolean {
  return LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(text)) || containsSecretShape(text);
}

/** The refusal reason from PrepareFixAttempt, reduced to a fixed phrase (never an id, path or text). */
function fixAttemptRefusalPhrase(reason: unknown): string {
  if (typeof reason !== 'string') {
    return 'refused';
  }
  if (reason.startsWith('Missing required fix attempt fields')) {
    return 'missing-fields';
  }
  if (reason.startsWith('fixAttemptId must differ')) {
    return 'same-as-prior';
  }
  if (reason.startsWith('numberedFixes')) {
    return 'no-fixes';
  }
  if (reason.startsWith('Prior attempt not found')) {
    return 'prior-not-found';
  }
  if (reason.startsWith('Prior attempt carries an invalid seat plan')) {
    return 'seat-plan-invalid';
  }
  if (reason.startsWith('Prior attempt ')) {
    return 'prior-not-settled';
  }
  if (reason.startsWith('Attempt ')) {
    return 'sibling-active';
  }
  if (reason.startsWith('No fix seat available')) {
    return 'no-fix-seat';
  }
  if (reason.startsWith('unhealthySeatIds')) {
    return 'invalid-seats';
  }
  return 'refused';
}

/** A refusal-kind word from the forge port; anything unrecognisable is `other`. */
function refusalKindWord(kind: unknown): string {
  return typeof kind === 'string' && /^[a-z][a-z-]{0,31}$/.test(kind) ? kind : 'other';
}

function headMatches(answered: unknown, expected: string): boolean {
  return typeof answered === 'string' && answered === expected;
}

/** GitHub owner and repository names compare without case. */
function sameRepository(
  left: { readonly owner: string; readonly repo: string },
  right: { readonly owner: unknown; readonly repo: unknown },
): boolean {
  return (
    typeof right.owner === 'string' &&
    typeof right.repo === 'string' &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

interface ReadTarget {
  readonly repository: { owner: string; repo: string };
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly branchName: string;
}

type ProbeAnswer = 'at-head' | 'moved' | 'not-open' | 'branch-mismatch' | 'unknown';

/** A probe answer that stops the push, as its refusal code. */
function probeRefusal(answer: Exclude<ProbeAnswer, 'at-head' | 'moved'>): PreparePullRequestFeedbackFixCode {
  if (answer === 'not-open') {
    return 'pull-request-not-open';
  }
  return answer === 'branch-mismatch' ? 'branch-mismatch' : 'forge-unreadable';
}

interface PrepareFields {
  readonly repository: { owner: string; repo: string };
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly branchName: string;
  readonly workOrderId: string;
  readonly priorAttemptId: string;
  readonly fixAttemptId: string;
  readonly unhealthySeatIds: readonly string[] | undefined;
  readonly nowIso: string | undefined;
}

/** The prepare request's fields, or null for an invalid request (including a fix attempt id the key does not imply). */
function readPrepareFields(request: unknown): PrepareFields | null {
  const repository = readRepository(request);
  const pullRequestNumber = readPullRequestNumber(request);
  const headSha = readCommit(request, 'headSha');
  const branchName = ownData(request, 'branchName');
  const workOrderId = ownData(request, 'workOrderId');
  const priorAttemptId = ownData(request, 'priorAttemptId');
  const fixAttemptIdField = readOptionalId(request, 'fixAttemptId');
  const grantId = readOptionalId(request, 'grantId');
  const unhealthySeatIds = readOptionalStrings(request, 'unhealthySeatIds');
  const nowIso = readOptionalIso(request);
  if (
    repository === null ||
    pullRequestNumber === null ||
    headSha === null ||
    !isSafeBranchName(branchName) ||
    !isNonEmptyString(workOrderId) ||
    !isNonEmptyString(priorAttemptId) ||
    fixAttemptIdField === null ||
    grantId === null ||
    unhealthySeatIds === null ||
    nowIso === null
  ) {
    return null;
  }
  const derivedId = derivedFixAttemptId(pullRequestNumber, headSha);
  const fixAttemptId = fixAttemptIdField ?? derivedId;
  if (fixAttemptId === priorAttemptId || fixAttemptId !== derivedId) {
    return null;
  }
  return { repository, pullRequestNumber, headSha, branchName, workOrderId, priorAttemptId, fixAttemptId, unhealthySeatIds, nowIso };
}

interface PushFields {
  readonly repository: { owner: string; repo: string };
  readonly pullRequestNumber: number;
  readonly expectedHeadSha: string;
  readonly fixedHeadSha: string;
  readonly branchName: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  /** Undefined when the request carries no grant (refused `grant-missing`). */
  readonly grantId: string | undefined;
  readonly authorizedBy: string | undefined;
}

/**
 * The push request's fields, or null for an invalid request. A grant id that
 * is absent or blank reads as missing; one of another type, or malformed (too
 * long, unsafe characters), is an invalid request. The attempt must be the fix
 * attempt this round's key derives (`pr-feedback-<pr>-<head12>`), so a grant
 * scoped to one pull request's fix attempt never authorises a push to another
 * pull request.
 */
function readPushFields(request: unknown): PushFields | null {
  const repository = readRepository(request);
  const pullRequestNumber = readPullRequestNumber(request);
  const expectedHeadSha = readCommit(request, 'expectedHeadSha');
  const fixedHeadSha = readCommit(request, 'fixedHeadSha');
  const branchName = ownData(request, 'branchName');
  const workOrderId = ownData(request, 'workOrderId');
  const attemptId = ownData(request, 'attemptId');
  const rawGrant = ownData(request, 'grantId');
  const authorizedBy = readOptionalId(request, 'authorizedBy');
  const nowIso = readOptionalIso(request);
  if (
    repository === null ||
    pullRequestNumber === null ||
    expectedHeadSha === null ||
    fixedHeadSha === null ||
    !isSafeBranchName(branchName) ||
    !isNonEmptyString(workOrderId) ||
    !isNonEmptyString(attemptId) ||
    authorizedBy === null ||
    nowIso === null ||
    expectedHeadSha === fixedHeadSha ||
    attemptId !== derivedFixAttemptId(pullRequestNumber, expectedHeadSha)
  ) {
    return null;
  }
  if (rawGrant !== undefined && typeof rawGrant !== 'string') {
    return null;
  }
  const grantId = isNonEmptyString(rawGrant) ? rawGrant : undefined;
  if (grantId !== undefined && !GRANT_ID_PATTERN.test(grantId)) {
    return null;
  }
  return {
    repository,
    pullRequestNumber,
    expectedHeadSha,
    fixedHeadSha,
    branchName,
    workOrderId,
    attemptId,
    grantId,
    authorizedBy,
  };
}

/**
 * The authorised forge path's answer as a push result. A refusal the forge
 * itself gave (after the grant was consumed) is `push-refused`; an ambiguous
 * forge outcome is `ambiguous`; any other refusal happened before the forge
 * ran (grant not consumed, attempt head or one-way door check) and is
 * `grant-refused`, except an unbound forge transport (`not-configured`).
 */
function pushOutcome(
  answer: ExecuteAuthorizedForgeActionResult,
  key: string,
  fixedHeadSha: string,
  refusedPush: (code: PreparePullRequestFeedbackFixCode, detail?: string) => PushPullRequestFeedbackFixResult,
): PushPullRequestFeedbackFixResult {
  const outcome = ownData(answer, 'outcome');
  if (outcome === 'executed') {
    return headMatches(ownData(answer, 'headSha'), fixedHeadSha)
      ? { outcome: 'pushed', key, headSha: fixedHeadSha }
      : { outcome: 'ambiguous', key, headSha: fixedHeadSha, code: 'forge-ambiguous' };
  }
  if (outcome !== 'refused') {
    return refusedPush('invalid-request');
  }
  if (ownData(answer, 'forgeAmbiguous') === true) {
    return { outcome: 'ambiguous', key, headSha: fixedHeadSha, code: 'forge-ambiguous' };
  }
  const forgeRefusalKind = ownData(answer, 'forgeRefusalKind');
  if (forgeRefusalKind !== undefined) {
    return refusedPush('push-refused', refusalKindWord(forgeRefusalKind));
  }
  const reason = ownData(answer, 'reason');
  if (reason === FORGE_UNCONFIGURED_REASON || (typeof reason === 'string' && reason.startsWith(FORGE_MODE_NONE_PREFIX))) {
    return refusedPush('not-configured');
  }
  if (typeof reason === 'string' && reason.startsWith(ATTEMPT_HEAD_MOVED_PREFIX)) {
    return refusedPush('head-moved');
  }
  return refusedPush('grant-refused');
}

type ReadOutcome =
  | { readonly kind: 'available'; readonly findings: readonly PullRequestFinding[] }
  | { readonly kind: 'refused'; readonly refusal: Refused };

export class PreparePullRequestFeedbackFixUseCase implements PreparePullRequestFeedbackFixPort {
  constructor(private readonly deps?: PreparePullRequestFeedbackFixDependencies) {}

  async preparePullRequestFeedbackFix(
    request: PreparePullRequestFeedbackFixRequest,
  ): Promise<PreparePullRequestFeedbackFixResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PreparePullRequestFeedbackFixUseCase');
    }
    try {
      return await this.prepare(this.deps, request);
    } catch {
      return refuse('invalid-request');
    }
  }

  async pushPullRequestFeedbackFix(
    request: PushPullRequestFeedbackFixRequest,
  ): Promise<PushPullRequestFeedbackFixResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PreparePullRequestFeedbackFixUseCase');
    }
    try {
      return await this.push(this.deps, request);
    } catch {
      return { outcome: 'refused', key: null, headSha: null, code: 'invalid-request' };
    }
  }

  async execute(input?: unknown): Promise<PreparePullRequestFeedbackFixResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PreparePullRequestFeedbackFixUseCase');
    }
    return this.preparePullRequestFeedbackFix(input as PreparePullRequestFeedbackFixRequest);
  }

  private async prepare(
    deps: PreparePullRequestFeedbackFixDependencies,
    request: unknown,
  ): Promise<PreparePullRequestFeedbackFixResult> {
    const fields = readPrepareFields(request);
    if (fields === null) {
      return refuse('invalid-request');
    }
    const { repository, pullRequestNumber, headSha, branchName, workOrderId, priorAttemptId, fixAttemptId } = fields;
    const key = keyOf(pullRequestNumber, headSha);
    if (!this.isBoundRepository(deps, repository)) {
      return refuse('repository-mismatch');
    }

    if (!this.isConfigured(deps)) {
      return refuse('not-configured');
    }

    const read = await this.readFindings(deps, { repository, pullRequestNumber, headSha, branchName });
    if (read.kind === 'refused') {
      return read.refusal;
    }
    const findings = read.findings.filter((finding) => finding.state === 'unresolved');
    if (findings.length === 0) {
      return refuse('no-unresolved-threads');
    }
    if (findings.length > PR_FEEDBACK_MAX_FINDINGS) {
      return refuse('too-large');
    }

    const built = this.numberedFixes(deps, findings);
    if ('outcome' in built) {
      return built;
    }

    const effectiveNow = fields.nowIso ?? this.clock(deps);
    let answer: Awaited<ReturnType<PrepareFixAttemptPort['prepareFixAttempt']>>;
    try {
      answer = await deps.prepareFixAttempt.prepareFixAttempt({
        fixAttemptId,
        workOrderId,
        priorAttemptId,
        numberedFixes: built.fixes,
        ...(fields.unhealthySeatIds !== undefined ? { unhealthySeatIds: fields.unhealthySeatIds } : {}),
        ...(effectiveNow !== undefined ? { nowIso: effectiveNow } : {}),
      });
    } catch {
      return refuse('fix-attempt-refused', 'prepare-failed');
    }
    if (answer.outcome === 'prepared') {
      return { outcome: 'prepared', key, fixAttemptId, findingCount: findings.length };
    }
    if (answer.outcome === 'refused') {
      if (typeof answer.reason === 'string' && answer.reason.startsWith(ALREADY_EXISTS_PREFIX)) {
        return { outcome: 'already-prepared', key, fixAttemptId, findingCount: findings.length };
      }
      return refuse('fix-attempt-refused', fixAttemptRefusalPhrase(answer.reason));
    }
    return refuse('invalid-request');
  }

  private async push(
    deps: PreparePullRequestFeedbackFixDependencies,
    request: unknown,
  ): Promise<PushPullRequestFeedbackFixResult> {
    const invalid: PushPullRequestFeedbackFixResult = {
      outcome: 'refused',
      key: null,
      headSha: null,
      code: 'invalid-request',
    };
    const fields = readPushFields(request);
    if (fields === null) {
      return invalid;
    }
    const { repository, pullRequestNumber, expectedHeadSha, fixedHeadSha } = fields;

    const key = keyOf(pullRequestNumber, expectedHeadSha);
    const refusedPush = (code: PreparePullRequestFeedbackFixCode, detail?: string): PushPullRequestFeedbackFixResult =>
      detail === undefined
        ? { outcome: 'refused', key, headSha: fixedHeadSha, code }
        : { outcome: 'refused', key, headSha: fixedHeadSha, code, detail };

    // No grant, no forge interaction of any kind: refused before a probe.
    if (fields.grantId === undefined) {
      return refusedPush('grant-missing');
    }
    if (!this.isBoundRepository(deps, repository)) {
      return refusedPush('repository-mismatch');
    }
    if (!this.isConfigured(deps)) {
      return refusedPush('not-configured');
    }

    const precheck = await this.pushPrecheck(deps, fields);
    if (precheck === 'already-pushed') {
      return { outcome: 'already-pushed', key, headSha: fixedHeadSha };
    }
    if (precheck !== 'push') {
      return refusedPush(precheck);
    }

    // The push runs only through the authorised forge path, which consumes
    // the grant for this action id, kind, head and attempt before the forge
    // runs. `expectedHeadSha` there is the head being pushed: the fix
    // attempt's collected head, which the grant is scoped to.
    let answer: ExecuteAuthorizedForgeActionResult;
    try {
      answer = await deps.executeForgeAction.executeAuthorizedForgeAction({
        actionId: key,
        attemptId: fields.attemptId,
        workOrderId: fields.workOrderId,
        kind: 'push-to-pr',
        expectedHeadSha: fixedHeadSha,
        authorizationGrantId: fields.grantId,
        branchName: fields.branchName,
        ...(fields.authorizedBy === undefined ? {} : { authorizedBy: fields.authorizedBy }),
      });
    } catch {
      return { outcome: 'ambiguous', key, headSha: fixedHeadSha, code: 'forge-ambiguous' };
    }
    return pushOutcome(answer, key, fixedHeadSha, refusedPush);
  }

  /**
   * The two head probes before a push. Probe 1: a pull request already at the
   * fixed head needs no push (a crash between an earlier push and its result
   * lands here). Probe 2: the pull request must still be at the round's head.
   * Both require the probed pull request's head branch to be the request's
   * branch in the bound repository, so the branch the forge pushes is the
   * pull request that was probed.
   */
  private async pushPrecheck(
    deps: PreparePullRequestFeedbackFixDependencies,
    fields: PushFields,
  ): Promise<'push' | 'already-pushed' | PreparePullRequestFeedbackFixCode> {
    const target = { repository: fields.repository, pullRequestNumber: fields.pullRequestNumber, branchName: fields.branchName };
    const atFixed = await this.probe(deps, { ...target, headSha: fields.fixedHeadSha });
    if (atFixed === 'at-head') {
      return 'already-pushed';
    }
    if (atFixed !== 'moved') {
      return probeRefusal(atFixed);
    }
    const atRound = await this.probe(deps, { ...target, headSha: fields.expectedHeadSha });
    if (atRound === 'at-head') {
      return 'push';
    }
    return atRound === 'moved' ? 'head-moved' : probeRefusal(atRound);
  }

  /** Whether the request names the repository the bound forge path acts on. */
  private isBoundRepository(
    deps: PreparePullRequestFeedbackFixDependencies,
    repository: { readonly owner: string; readonly repo: string },
  ): boolean {
    try {
      const bound = deps.repository;
      return (
        typeof bound === 'object' &&
        bound !== null &&
        sameRepository(repository, { owner: ownData(bound, 'owner'), repo: ownData(bound, 'repo') })
      );
    } catch {
      return false;
    }
  }

  private isConfigured(deps: PreparePullRequestFeedbackFixDependencies): boolean {
    try {
      return (
        deps.findings.isConfigured() === true &&
        typeof deps.executeForgeAction?.executeAuthorizedForgeAction === 'function'
      );
    } catch {
      return false;
    }
  }

  private clock(deps: PreparePullRequestFeedbackFixDependencies): string | undefined {
    if (deps.nowIso === undefined) {
      return undefined;
    }
    try {
      const value = deps.nowIso();
      return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async callFindings(
    deps: PreparePullRequestFeedbackFixDependencies,
    repository: { owner: string; repo: string },
    pullRequestNumber: number,
    headSha: string,
  ): Promise<PullRequestFindingsResult | null> {
    try {
      return await deps.findings.readPullRequestFindings({
        repository,
        pullRequestNumber,
        expectedHeadSha: headSha,
      });
    } catch {
      return null;
    }
  }

  /** Whether the pull request is at `headSha` on the expected branch, moved, not open, on another branch, or unknown. */
  private async probe(
    deps: PreparePullRequestFeedbackFixDependencies,
    target: ReadTarget,
  ): Promise<ProbeAnswer> {
    const result = await this.callFindings(deps, target.repository, target.pullRequestNumber, target.headSha);
    if (result === null) {
      return 'unknown';
    }
    if (result.outcome === 'available') {
      if (!headMatches(result.headSha, target.headSha)) {
        return 'unknown';
      }
      return this.isExpectedBranch(deps, result, target.branchName) ? 'at-head' : 'branch-mismatch';
    }
    if (result.outcome === 'unavailable' && result.code === 'head-moved') {
      return 'moved';
    }
    if (result.outcome === 'unavailable' && result.code === 'not-open') {
      return 'not-open';
    }
    return 'unknown';
  }

  /** The probed pull request's head branch is `branchName` in the bound repository (never a fork). */
  private isExpectedBranch(
    deps: PreparePullRequestFeedbackFixDependencies,
    result: unknown,
    branchName: string,
  ): boolean {
    const headRepository = ownData(result, 'headRepository');
    return (
      ownData(result, 'headRefName') === branchName &&
      typeof headRepository === 'object' &&
      headRepository !== null &&
      this.isBoundRepository(deps, {
        owner: String(ownData(headRepository, 'owner')),
        repo: String(ownData(headRepository, 'repo')),
      })
    );
  }

  private async readFindings(
    deps: PreparePullRequestFeedbackFixDependencies,
    target: ReadTarget,
  ): Promise<ReadOutcome> {
    const result = await this.callFindings(deps, target.repository, target.pullRequestNumber, target.headSha);
    if (result === null) {
      return { kind: 'refused', refusal: refuse('forge-unreadable') };
    }
    if (result.outcome === 'unavailable') {
      switch (result.code) {
        case 'head-moved':
          return { kind: 'refused', refusal: refuse('head-moved') };
        case 'not-open':
          return { kind: 'refused', refusal: refuse('pull-request-not-open') };
        case 'forge-error':
        case 'unreadable':
          return { kind: 'refused', refusal: refuse('forge-unreadable') };
        case 'partial-page':
          return { kind: 'refused', refusal: refuse('partial-page') };
        case 'too-large':
          return { kind: 'refused', refusal: refuse('too-large') };
        case 'unconfigured':
          return { kind: 'refused', refusal: refuse('not-configured') };
        default:
          return { kind: 'refused', refusal: refuse('invalid-request') };
      }
    }
    if (result.outcome !== 'available' || !Array.isArray(result.findings)) {
      return { kind: 'refused', refusal: refuse('invalid-request') };
    }
    if (!headMatches(result.headSha, target.headSha)) {
      return { kind: 'refused', refusal: refuse('head-moved') };
    }
    if (!this.isExpectedBranch(deps, result, target.branchName)) {
      return { kind: 'refused', refusal: refuse('branch-mismatch') };
    }
    const findings: PullRequestFinding[] = [];
    for (const finding of result.findings) {
      const checked = checkFinding(finding);
      if (checked === null) {
        return { kind: 'refused', refusal: refuse('invalid-request') };
      }
      findings.push(checked);
    }
    return { kind: 'available', findings };
  }

  /** One numbered, wrapped fix per finding, in thread order; or the refusal. */
  private numberedFixes(
    deps: PreparePullRequestFeedbackFixDependencies,
    findings: readonly PullRequestFinding[],
  ): { readonly fixes: readonly string[] } | Refused {
    for (const finding of findings) {
      if (secretShaped(finding.text) || secretShaped(finding.path)) {
        return refuse('redaction-refused');
      }
    }
    const fixes: string[] = [];
    let handoverBytes = 0;
    for (let index = 0; index < findings.length; index += 1) {
      const finding = findings[index];
      let nonce: string;
      try {
        nonce = deps.mintNonce();
      } catch {
        return refuse('invalid-request');
      }
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
        return refuse('invalid-request');
      }
      let wrapped: string;
      try {
        wrapped = wrapUntrusted({
          label: FINDING_LABEL,
          text: [`path: ${finding.path}`, `line: ${finding.line === null ? 'none' : finding.line}`, '', finding.text].join('\n'),
          nonce,
        });
      } catch {
        return refuse('invalid-request');
      }
      const fix = `${index + 1}. Review thread ${finding.threadId} (author ${finding.authorKind})\n${wrapped}`;
      const bytes = Buffer.byteLength(fix, 'utf8');
      handoverBytes += bytes;
      if (bytes > PR_FEEDBACK_MAX_FIX_BYTES || handoverBytes > PR_FEEDBACK_MAX_HANDOVER_BYTES) {
        return refuse('too-large');
      }
      fixes.push(fix);
    }
    return { fixes };
  }
}

/** A dependency finding rebuilt as a plain typed record, or null for an unknown shape or enum value. */
function checkFinding(raw: unknown): PullRequestFinding | null {
  const threadId = ownData(raw, 'threadId');
  const path = ownData(raw, 'path');
  const line = ownData(raw, 'line');
  const authorKind = ownData(raw, 'authorKind');
  const state = ownData(raw, 'state');
  const text = ownData(raw, 'text');
  if (
    typeof threadId !== 'string' ||
    !THREAD_ID_PATTERN.test(threadId) ||
    typeof path !== 'string' ||
    typeof text !== 'string' ||
    (line !== null && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0)) ||
    (authorKind !== 'user' && authorKind !== 'bot') ||
    (state !== 'unresolved' && state !== 'resolved')
  ) {
    return null;
  }
  return { threadId, path, line, authorKind, state, text };
}
