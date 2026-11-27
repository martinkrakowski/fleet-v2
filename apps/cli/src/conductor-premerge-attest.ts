/**
 * `fleet-v2 conductor premerge attest` (Tier 2 owner receipt): the owner's
 * manual pre-merge attestation for one lane run. It performs read-only
 * pre-checks over the run's own stores and ports — the run is Tier 2, the
 * attempt's collected head is the PR's current head, the pre-merge review
 * passed and CI passed at the exact head — then, with `--yes`, records one
 * manual pre-merge review receipt through `RecordReviewReceiptUseCase`.
 *
 * It never posts a forge status, never merges, never edits a branch and never
 * calls the network from a new place: the only write is the receipt into the
 * assessment the attempt already has.
 *
 * Every untrusted record (the run, the attempt and its artifacts, the
 * acceptance assessment and every port response) is snapshotted with
 * `snapshotPlainDataRecord` — wrapped in `safePlainSnapshot`, which maps a
 * throwing or revoked Proxy to a typed refusal — before any field is read.
 * A getter, a non-plain prototype, a symbol key, a `__proto__` key, a
 * non-enumerable property or a throwing trap is `invalid-record`, never a
 * pass and never an invoked getter.
 *
 * Refusals: usage errors (exit 2) on stderr for flag and state-dir problems;
 * typed `{ outcome: 'refused', reason }` documents on stdout with exit 1 for
 * `not-tier-2`, `head-mismatch`, `review-not-passed`, `ci-not-green`,
 * `no---yes`, `reviewer-unavailable`, `invalid-record` and a rejected
 * receipt write. Exit 0 only when the receipt was recorded.
 */

import {
  assessmentIdForAttempt,
  isSameModelFamily,
  underlyingModelFamily,
  type ReviewReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import {
  MAX_RUN_ATTEMPT_IDS,
  decideConductorReviewOutcome,
  readBoundedDenseArray,
  snapshotPlainDataRecord,
} from '@fleet/work-execution';

import type { FleetCliRuntime } from './composition.js';
import { CONDUCTOR_HELP, type ConductorCliOptions } from './conductor.js';
import type { CliIo } from './index.js';

/** A collected candidate head: 40 lowercase hex characters. */
const HEX_40_PATTERN = /^[0-9a-f]{40}$/;

export interface PremergeAttestFlags {
  /** The non-empty trimmed run id, given at most once. */
  readonly run: string;
  /** The explicit confirmation; absent means "checks only". */
  readonly yes: boolean;
}

/** One usage error: the message, then the conductor help, on stderr. */
function usageError(io: CliIo, message: string): null {
  io.stderr(`${message}\n${CONDUCTOR_HELP}\n`);
  return null;
}

/**
 * `conductor premerge attest`'s private flag reader: `--run <runId>` (or
 * `--run=<runId>`, required, non-empty trimmed, at most once) and `--yes`
 * (optional, at most once). An unknown flag, a repeated flag, a missing
 * `--run`, a missing `--run` value or a positional is a usage error.
 * `O(N)` in `argv.length`; the values are CLI flags, never a record body.
 */
export function readPremergeAttestFlags(argv: readonly string[], io: CliIo): PremergeAttestFlags | null {
  let run: string | undefined;
  let runSeen = false;
  let yesSeen = false;
  let pendingRunValue = false;
  for (const token of argv) {
    if (pendingRunValue) {
      pendingRunValue = false;
      const trimmed = token.trim();
      if (trimmed === '') {
        return usageError(io, 'conductor premerge attest: --run requires a non-empty run id');
      }
      run = trimmed;
      continue;
    }
    if (token === '--run') {
      if (runSeen) {
        return usageError(io, 'conductor premerge attest: --run given more than once');
      }
      runSeen = true;
      pendingRunValue = true;
      continue;
    }
    if (token.startsWith('--run=')) {
      if (runSeen) {
        return usageError(io, 'conductor premerge attest: --run given more than once');
      }
      runSeen = true;
      const value = token.slice('--run='.length).trim();
      if (value === '') {
        return usageError(io, 'conductor premerge attest: --run requires a non-empty run id');
      }
      run = value;
      continue;
    }
    if (token === '--yes') {
      if (yesSeen) {
        return usageError(io, 'conductor premerge attest: --yes given more than once');
      }
      yesSeen = true;
      continue;
    }
    return usageError(
      io,
      token.startsWith('--')
        ? 'conductor premerge attest: unknown or unsupported flag'
        : 'conductor premerge attest takes no positional arguments',
    );
  }
  if (pendingRunValue) {
    return usageError(io, 'conductor premerge attest: --run requires a value');
  }
  if (run === undefined) {
    return usageError(io, 'conductor premerge attest requires --run <runId>');
  }
  return { run, yes: yesSeen };
}

/**
 * `snapshotPlainDataRecord` wrapped so a revoked Proxy or a throwing trap
 * (`getPrototypeOf`, `ownKeys`, `getOwnPropertyDescriptor`) maps to `null`
 * — a typed refusal — instead of an exception. `O(1)` pre-checks plus one
 * `Reflect.ownKeys` pass and one descriptor read per own key.
 */
function safePlainSnapshot(value: unknown): Record<string, unknown> | null {
  try {
    return snapshotPlainDataRecord(value);
  } catch {
    return null;
  }
}

/**
 * The plain snapshot of one own key of a snapshotted record: `absent` when
 * the key is missing (a legitimate not-found shape), `invalid` when the key
 * is present but not a plain data record, `plain` with its snapshot
 * otherwise.
 */
function fieldSnapshot(
  record: Record<string, unknown>,
  key: string,
): { kind: 'absent' } | { kind: 'invalid' } | { kind: 'plain'; value: Record<string, unknown> } {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { kind: 'absent' };
  }
  const snapshot = safePlainSnapshot(record[key]);
  return snapshot === null ? { kind: 'invalid' } : { kind: 'plain', value: snapshot };
}

/** One typed refusal document on stdout, mapped to exit 1. */
function refuseRecord(io: CliIo, body: Record<string, unknown>): number {
  io.stdout(`${JSON.stringify(body)}\n`);
  return 1;
}

/** The own value of one snapshot key; a missing key reads as `undefined`. */
function fieldOf(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * The run's PR head branch name: the recorded `branchName`, else the last
 * segment of the attempt's worktree path (the same decision K5-5 takes).
 * `null` when neither is a string: the record is invalid, not invented.
 */
function branchNameOf(run: Record<string, unknown>, attempt: Record<string, unknown>): string | null {
  const recorded = fieldOf(run, 'branchName');
  if (typeof recorded === 'string') {
    return recorded;
  }
  const worktreePath = fieldOf(attempt, 'worktreePath');
  if (typeof worktreePath === 'string') {
    const segments = worktreePath.split('/');
    return segments[segments.length - 1] ?? null;
  }
  return null;
}

/**
 * `fleet-v2 conductor premerge attest --run <runId> [--yes]`. Returns 0 only
 * when the manual receipt was recorded; every other exit is a typed refusal
 * (1) or a usage error (2). Each repository or port call is `O(1)` lookups
 * plus one bounded snapshot per returned record; there are no loops over
 * findings, receipts or runs.
 */
export async function premergeAttestCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
): Promise<number> {
  const flags = readPremergeAttestFlags(argv, io);
  if (flags === null) {
    return 2;
  }
  if (options.stateDir === undefined) {
    io.stderr(
      `conductor premerge attest needs a durable state directory (--state-dir or FLEET_STATE_DIR)\n${CONDUCTOR_HELP}\n`,
    );
    return 2;
  }
  const runId = flags.run;
  const conductor = runtime.conductor;
  const invalidRecord = { outcome: 'refused', reason: 'invalid-record', runId } as const;

  // The lane run, snapshotted before any field is read.
  let runRecord: unknown;
  try {
    runRecord = await conductor.laneRunRepository.get(runId);
  } catch {
    runRecord = undefined;
  }
  const run = safePlainSnapshot(runRecord);
  if (run === null) {
    // A hostile run record (getter, Proxy, non-plain) is an invalid record,
    // not a tier answer; a genuinely absent run reads as not a Tier 2 run.
    return refuseRecord(io, runRecord === null || runRecord === undefined ? { outcome: 'refused', reason: 'not-tier-2', runId } : invalidRecord);
  }
  if (fieldOf(run, 'tier') !== 2) {
    return refuseRecord(io, { outcome: 'refused', reason: 'not-tier-2', runId });
  }
  // The attempt list is read through `readBoundedDenseArray`, never indexed
  // directly: an accessor at the last index, a throwing Proxy, an array
  // hole, a foreign own key or an enormous length is refused as an
  // `invalid-record` in O(1) (the length/prototype pre-gate) without ever
  // invoking a getter, and the last element is read from the fresh dense
  // copy the helper returns.
  const attemptIds = readBoundedDenseArray(fieldOf(run, 'attemptIds'), MAX_RUN_ATTEMPT_IDS);
  const attemptIdValue = attemptIds === null || attemptIds.length === 0 ? undefined : attemptIds.array[attemptIds.length - 1];
  if (typeof attemptIdValue !== 'string' || attemptIdValue.trim() === '') {
    return refuseRecord(io, invalidRecord);
  }
  const attemptId = attemptIdValue;

  // The latest attempt and its collected artifacts.
  let attemptRecord: unknown;
  try {
    attemptRecord = await runtime.execution.attemptRepository.findAttemptById(attemptId);
  } catch {
    attemptRecord = undefined;
  }
  const attemptSnapshot = safePlainSnapshot(attemptRecord);
  if (attemptSnapshot === null) {
    return refuseRecord(io, invalidRecord);
  }
  // Only a collected attempt has artifacts the conductor accepted: a running
  // or ended-but-uncollected attempt may carry a stale head, and attesting it
  // would record a receipt for a head that was never collected.
  if (fieldOf(attemptSnapshot, 'state') !== 'collected') {
    return refuseRecord(io, { outcome: 'refused', reason: 'attempt-not-collected', runId });
  }
  const artifacts = safePlainSnapshot(fieldOf(attemptSnapshot, 'artifacts'));
  if (artifacts === null) {
    return refuseRecord(io, invalidRecord);
  }
  const headCommit = fieldOf(artifacts, 'headCommit');
  if (typeof headCommit !== 'string' || !HEX_40_PATTERN.test(headCommit)) {
    return refuseRecord(io, invalidRecord);
  }
  const headSha = headCommit;

  // The PR fact at the run's pull request reference.
  const prNumber = fieldOf(run, 'prNumber');
  const branchName = branchNameOf(run, attemptSnapshot);
  const ref =
    typeof prNumber === 'number'
      ? { kind: 'number' as const, number: prNumber }
      : branchName !== null
        ? { kind: 'branch' as const, branchName }
        : null;
  if (ref === null) {
    return refuseRecord(io, invalidRecord);
  }
  let pullRequestRead: unknown;
  try {
    pullRequestRead = await runtime.execution.forgeRead.readPullRequest({ ref });
  } catch {
    pullRequestRead = undefined;
  }
  const readSnapshot = safePlainSnapshot(pullRequestRead);
  // A null snapshot (getter, Proxy, non-plain) is an invalid record, not a
  // head answer; only a valid, genuinely-not-found or head-differing record
  // is a head mismatch.
  if (readSnapshot === null) {
    return refuseRecord(io, invalidRecord);
  }
  const pullRequestField = fieldSnapshot(readSnapshot, 'pullRequest');
  if (pullRequestField.kind === 'invalid') {
    return refuseRecord(io, invalidRecord);
  }
  if (
    fieldOf(readSnapshot, 'outcome') !== 'found' ||
    pullRequestField.kind === 'absent' ||
    fieldOf(pullRequestField.value, 'headSha') !== headSha
  ) {
    return refuseRecord(io, { outcome: 'refused', reason: 'head-mismatch', runId });
  }

  // The latest pre-merge review receipt at the exact head.
  let reviewRead: unknown;
  try {
    reviewRead = await conductor.reviewRequest.findLatestReceiptOfKind({
      attemptId,
      candidateHeadSha: headSha,
      kind: 'pre-merge',
    });
  } catch {
    reviewRead = undefined;
  }
  const reviewSnapshot = safePlainSnapshot(reviewRead);
  // A null snapshot is an invalid record, not a review verdict.
  if (reviewSnapshot === null) {
    return refuseRecord(io, invalidRecord);
  }
  const receiptField = fieldSnapshot(reviewSnapshot, 'receipt');
  if (receiptField.kind === 'invalid') {
    return refuseRecord(io, invalidRecord);
  }
  if (
    fieldOf(reviewSnapshot, 'outcome') !== 'found' ||
    receiptField.kind === 'absent' ||
    decideConductorReviewOutcome(receiptField.value).outcome !== 'passed'
  ) {
    return refuseRecord(io, { outcome: 'refused', reason: 'review-not-passed', runId });
  }

  // CI passed at the exact head.
  let ciRead: unknown;
  try {
    ciRead = await conductor.ciState.readHeadCiState({ headSha });
  } catch {
    ciRead = undefined;
  }
  const ciSnapshot = safePlainSnapshot(ciRead);
  // A null snapshot is an invalid record, not a CI verdict.
  if (ciSnapshot === null) {
    return refuseRecord(io, invalidRecord);
  }
  if (fieldOf(ciSnapshot, 'headSha') !== headSha || fieldOf(ciSnapshot, 'state') !== 'passed') {
    return refuseRecord(io, { outcome: 'refused', reason: 'ci-not-green', runId });
  }

  // Confirmation gate: without --yes nothing is written and nothing changes.
  if (!flags.yes) {
    io.stdout(`${JSON.stringify({ outcome: 'refused', reason: 'no---yes', runId, attemptId, headSha })}\n`);
    return 1;
  }

  // The acceptance assessment bound to the attempt.
  const assessmentId = assessmentIdForAttempt(attemptId);
  let inspected: unknown;
  try {
    inspected = await runtime.evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({ assessmentId });
  } catch {
    inspected = undefined;
  }
  const inspectedSnapshot = safePlainSnapshot(inspected);
  const assessment = inspectedSnapshot === null ? null : safePlainSnapshot(fieldOf(inspectedSnapshot, 'assessment'));
  if (inspectedSnapshot === null || assessment === null || fieldOf(inspectedSnapshot, 'outcome') !== 'found') {
    return refuseRecord(io, invalidRecord);
  }

  // The reviewer identity, with no fallback: a requested reviewer is named
  // exactly, and every reviewer must differ from the implementer's model family.
  const implementerModel = fieldOf(assessment, 'implementerModel');
  if (typeof implementerModel !== 'string' || implementerModel.trim() === '') {
    return refuseRecord(io, { outcome: 'refused', reason: 'reviewer-unavailable', runId });
  }
  const implementerFamily = underlyingModelFamily(implementerModel);
  const requestedReviewerModel = fieldOf(assessment, 'requestedReviewerModel');
  let reviewerModel: string;
  if (requestedReviewerModel !== undefined) {
    if (typeof requestedReviewerModel !== 'string' || requestedReviewerModel.trim() === '') {
      return refuseRecord(io, { outcome: 'refused', reason: 'reviewer-unavailable', runId });
    }
    if (isSameModelFamily(underlyingModelFamily(requestedReviewerModel.trim()), implementerFamily)) {
      return refuseRecord(io, { outcome: 'refused', reason: 'reviewer-unavailable', runId });
    }
    reviewerModel = requestedReviewerModel.trim();
  } else {
    const preMergeReviewer = fieldOf(receiptField.value, 'reviewerModel');
    if (
      typeof preMergeReviewer !== 'string' ||
      preMergeReviewer.trim() === '' ||
      isSameModelFamily(underlyingModelFamily(preMergeReviewer), implementerFamily)
    ) {
      return refuseRecord(io, { outcome: 'refused', reason: 'reviewer-unavailable', runId });
    }
    reviewerModel = preMergeReviewer;
  }

  // The manual receipt: no requestId (that is what makes it an owner
  // receipt), recorded through the evidence use case.
  const nowIso = options.now !== undefined ? options.now() : new Date().toISOString();
  const receipt: ReviewReceiptRecord = {
    id: 'rcp-' + conductor.newUlid(),
    assessmentId: fieldOf(assessment, 'id') as string,
    projectId: fieldOf(assessment, 'projectId') as string,
    attemptId,
    candidateHeadSha: headSha,
    reviewerModel,
    implementerModel,
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'conductor-premerge-attest:' + runId + '@' + headSha.slice(0, 12),
    policyRevision: fieldOf(assessment, 'policyRevision') as string,
    completedAtIso: nowIso,
    kind: 'pre-merge',
  };

  let recorded: unknown;
  try {
    recorded = await runtime.evidence.recordReviewReceipt.recordReviewReceipt({
      assessmentId: receipt.assessmentId,
      receipt,
      nowIso,
    });
  } catch {
    recorded = undefined;
  }
  const recordedSnapshot = safePlainSnapshot(recorded);
  if (recordedSnapshot === null || fieldOf(recordedSnapshot, 'outcome') !== 'recorded') {
    // The use case's own rejection reason is never echoed: fixed token only.
    return refuseRecord(io, { outcome: 'refused', reason: 'rejected', runId });
  }
  io.stdout(
    `${JSON.stringify({ outcome: 'attested', reason: 'attested', runId, attemptId, headSha, receiptId: receipt.id })}\n`,
  );
  return 0;
}

/** `fleet-v2 conductor premerge <subcommand>` dispatch; today only `attest`. */
export async function premergeCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ConductorCliOptions,
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (subcommand !== 'attest') {
    io.stderr(
      `Unknown conductor premerge subcommand: ${subcommand === '' ? '(none)' : subcommand}\n${CONDUCTOR_HELP}\n`,
    );
    return 2;
  }
  return await premergeAttestCommand(argv.slice(1), io, runtime, options);
}
