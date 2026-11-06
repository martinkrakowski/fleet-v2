// Lane CO24: PR-feedback fix round — prepare a fix attempt from unresolved review threads.
/**
 * PreparePullRequestFeedbackFixUseCase reads one pull request's unresolved
 * review threads at the exact current head through
 * `PullRequestFindingsReadPort`, wraps every forge-sourced text as untrusted
 * input, and prepares a fresh fix attempt through `PrepareFixAttemptPort`
 * with the numbered findings. The round's identity is the key
 * `pr-feedback/<pullRequest>@<head12>`; a repeat under the same key never
 * creates a second attempt. The fixed head is pushed only through
 * `ForgeActionPort` with `push-to-pr`, guarded by two head probes so a crash
 * between the push and its result recovers on the next call. The use case
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
import type { ForgeActionPort } from '../ports/out/ForgeActionPort.out-port.js';
import type {
  PullRequestFinding,
  PullRequestFindingsReadPort,
  PullRequestFindingsResult,
} from '../ports/out/PullRequestFindingsReadPort.out-port.js';

export interface PreparePullRequestFeedbackFixDependencies {
  readonly findings: PullRequestFindingsReadPort;
  readonly prepareFixAttempt: PrepareFixAttemptPort;
  readonly forgeAction: ForgeActionPort;
  readonly nowIso?: () => string;
  /**
   * Mints one nonce per wrapped finding (16 to 64 lowercase hex characters).
   * Absent, the nonce is derived from the thread id.
   */
  readonly mintNonce?: () => string;
}

/** At most this many findings, UTF-8 bytes per numbered fix, and bytes for the whole handover. */
export const PR_FEEDBACK_MAX_FINDINGS = 200;
export const PR_FEEDBACK_MAX_FIX_BYTES = 8 * 1024;
export const PR_FEEDBACK_MAX_HANDOVER_BYTES = 32 * 1024;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
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

/**
 * A deterministic 32-hex nonce from the thread id (four seeded FNV-1a words).
 * The application layer holds no node builtin; `wrapUntrusted` defangs
 * marker-like text whatever the nonce, so a derived nonce only has to be a
 * valid, stable one. A host that wants an unguessable nonce injects `mintNonce`.
 */
function derivedNonce(threadId: string): string {
  let nonce = '';
  for (let seed = 0; seed < 4; seed += 1) {
    let hash = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
    for (const character of `pr-feedback-nonce:${threadId}`) {
      hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
    }
    nonce += hash.toString(16).padStart(8, '0');
  }
  return nonce;
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
  return typeof answered === 'string' && COMMIT_PATTERN.test(answered) && answered.startsWith(expected);
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
      return refuse('invalid-request');
    }

    const key = keyOf(pullRequestNumber, headSha);
    const derivedId = derivedFixAttemptId(pullRequestNumber, headSha);
    const fixAttemptId = fixAttemptIdField ?? derivedId;
    if (fixAttemptId === priorAttemptId || fixAttemptId !== derivedId) {
      return refuse('invalid-request');
    }

    if (!this.isConfigured(deps)) {
      return refuse('not-configured');
    }

    const read = await this.readFindings(deps, repository, pullRequestNumber, headSha);
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

    const effectiveNow = nowIso ?? this.clock(deps);
    let answer: Awaited<ReturnType<PrepareFixAttemptPort['prepareFixAttempt']>>;
    try {
      answer = await deps.prepareFixAttempt.prepareFixAttempt({
        fixAttemptId,
        workOrderId,
        priorAttemptId,
        numberedFixes: built.fixes,
        ...(unhealthySeatIds !== undefined ? { unhealthySeatIds } : {}),
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
    const repository = readRepository(request);
    const pullRequestNumber = readPullRequestNumber(request);
    const expectedHeadSha = readCommit(request, 'expectedHeadSha');
    const fixedHeadSha = readCommit(request, 'fixedHeadSha');
    const branchName = ownData(request, 'branchName');
    const workOrderId = ownData(request, 'workOrderId');
    const attemptId = ownData(request, 'attemptId');
    const grantId = ownData(request, 'grantId');
    const nowIso = readOptionalIso(request);
    if (
      repository === null ||
      pullRequestNumber === null ||
      expectedHeadSha === null ||
      fixedHeadSha === null ||
      !isSafeBranchName(branchName) ||
      !isNonEmptyString(workOrderId) ||
      !isNonEmptyString(attemptId) ||
      !isNonEmptyString(grantId) ||
      nowIso === null ||
      expectedHeadSha === fixedHeadSha
    ) {
      return invalid;
    }

    const key = keyOf(pullRequestNumber, expectedHeadSha);
    const refusedPush = (code: PreparePullRequestFeedbackFixCode, detail?: string): PushPullRequestFeedbackFixResult =>
      detail === undefined
        ? { outcome: 'refused', key, headSha: fixedHeadSha, code }
        : { outcome: 'refused', key, headSha: fixedHeadSha, code, detail };

    if (!this.isConfigured(deps)) {
      return refusedPush('not-configured');
    }

    // Probe 1: a pull request already at the fixed head needs no push (and a
    // crash between an earlier push and its result lands here).
    const atFixed = await this.probe(deps, repository, pullRequestNumber, fixedHeadSha);
    if (atFixed === 'at-head') {
      return { outcome: 'already-pushed', key, headSha: fixedHeadSha };
    }
    if (atFixed !== 'moved') {
      return refusedPush('forge-unreadable');
    }

    // Probe 2: the pull request must still be at the round's head.
    const atRound = await this.probe(deps, repository, pullRequestNumber, expectedHeadSha);
    if (atRound === 'moved') {
      return refusedPush('head-moved');
    }
    if (atRound !== 'at-head') {
      return refusedPush('forge-unreadable');
    }

    // `push-to-pr` pins the head it is asked to establish: the fixed head.
    let answer: Awaited<ReturnType<ForgeActionPort['performForgeAction']>>;
    try {
      answer = await deps.forgeAction.performForgeAction({
        actionId: key,
        kind: 'push-to-pr',
        expectedHeadSha: fixedHeadSha,
        branchName,
        pullRequestNumber,
        attemptId,
        workOrderId,
      });
    } catch {
      return { outcome: 'ambiguous', key, headSha: fixedHeadSha, code: 'forge-ambiguous' };
    }
    if (answer.outcome === 'executed') {
      return headMatches(answer.headSha, fixedHeadSha)
        ? { outcome: 'pushed', key, headSha: fixedHeadSha }
        : { outcome: 'ambiguous', key, headSha: fixedHeadSha, code: 'forge-ambiguous' };
    }
    if (answer.outcome === 'ambiguous') {
      return { outcome: 'ambiguous', key, headSha: fixedHeadSha, code: 'forge-ambiguous' };
    }
    if (answer.outcome === 'refused') {
      return refusedPush('push-refused', refusalKindWord(answer.refusalKind));
    }
    return invalid;
  }

  private isConfigured(deps: PreparePullRequestFeedbackFixDependencies): boolean {
    try {
      return deps.findings.isConfigured() === true && deps.forgeAction.isConfigured() === true;
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

  /** Whether the pull request is at `headSha`, moved to another head, or unknown. */
  private async probe(
    deps: PreparePullRequestFeedbackFixDependencies,
    repository: { owner: string; repo: string },
    pullRequestNumber: number,
    headSha: string,
  ): Promise<'at-head' | 'moved' | 'unknown'> {
    const result = await this.callFindings(deps, repository, pullRequestNumber, headSha);
    if (result === null) {
      return 'unknown';
    }
    if (result.outcome === 'available') {
      return headMatches(result.headSha, headSha) ? 'at-head' : 'unknown';
    }
    if (result.outcome === 'unavailable' && result.code === 'head-moved') {
      return 'moved';
    }
    return 'unknown';
  }

  private async readFindings(
    deps: PreparePullRequestFeedbackFixDependencies,
    repository: { owner: string; repo: string },
    pullRequestNumber: number,
    headSha: string,
  ): Promise<ReadOutcome> {
    const result = await this.callFindings(deps, repository, pullRequestNumber, headSha);
    if (result === null) {
      return { kind: 'refused', refusal: refuse('forge-unreadable') };
    }
    if (result.outcome === 'unavailable') {
      switch (result.code) {
        case 'head-moved':
          return { kind: 'refused', refusal: refuse('head-moved') };
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
    if (!headMatches(result.headSha, headSha)) {
      return { kind: 'refused', refusal: refuse('head-moved') };
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
        nonce = deps.mintNonce !== undefined ? deps.mintNonce() : derivedNonce(finding.threadId);
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
