// Lane CO18: pre-dispatch verification of a frozen brief package.
/**
 * The use case verifies the frozen brief package in a worktree (the manifest
 * JSON and the prose markdown) against the `WorkOrderRecord` it claims to
 * implement: digest integrity through `readBriefPackageManifest`, prose
 * structure through `lintBrief`, `allowedPathPrefixes` containment, and exact
 * `ownedPaths` agreement with the record. The independent review through
 * `ReviewRequestPort` is required and its `brief-verify` receipt must pass; an
 * omitted, incomplete or refused review is `unverified`, never `verified`.
 * Pure application code: no filesystem, no subprocess, no clock, no
 * randomness; the artifacts are read only through `AttemptArtifactPort`, and
 * every failure is a typed verdict that never throws and never echoes file
 * content.
 */

import { readPlainRecord, type PlainRecordSchema } from '@fleet/shared';
import { lintBrief } from '../../domain/brief-answer.js';
import { isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import {
  isFixedProtectedPath,
  pathUnderPrefix,
  validateAllowedPathPrefix,
} from '../../domain/lane-diff-check.js';
import { WorkOrder } from '../../domain/entities/WorkOrder.js';
import {
  BRIEF_PACKAGE_MAX_MANIFEST_BYTES,
  BRIEF_PACKAGE_MAX_OWNED_PATHS,
  BRIEF_PACKAGE_MAX_PATH_CHARS,
  BRIEF_PACKAGE_MAX_PROSE_BYTES,
  BRIEF_PACKAGE_MAX_SCALAR_CHARS,
  readBriefPackageManifest,
  type BriefPackage,
} from '../../domain/value-objects/BriefPackage.vo.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
import type {
  AttemptArtifactPort,
} from '../ports/out/AttemptArtifactPort.out-port.js';
import type {
  ReviewRequest,
  ReviewRequestPort,
} from '../ports/out/ReviewRequestPort.out-port.js';
import type {
  WorkOrderRepositoryPort,
} from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRunnerRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import type {
  VerifyBriefPort,
  VerifyBriefRefusalReason,
  VerifyBriefRequest,
  VerifyBriefResult,
  VerifyBriefUnverifiedReason,
} from '../ports/in/VerifyBriefPort.in-port.js';
import { VERIFY_BRIEF_DEFAULT_MANIFEST_PATH, VERIFY_BRIEF_DEFAULT_PROSE_PATH } from '../ports/in/VerifyBriefPort.in-port.js';

export interface VerifyBriefDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'>;
  /** Cryptographic digest function (e.g. SHA-256); omitted at runtime fails closed as `unverified`. */
  readonly computeDigest: (content: string) => string;
  /** Independent review port; omitted at runtime fails closed as `unverified`. */
  readonly reviews: Pick<ReviewRequestPort, 'requestReview'>;
}

const HEX_64 = /^[0-9a-f]{64}$/;

const REQUEST_SCHEMA: PlainRecordSchema = {
  workOrderId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  attemptId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  worktreePath: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  expectedBriefDigest: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  prosePath: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_PATH_CHARS, optional: true },
  manifestPath: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_PATH_CHARS, optional: true },
  recordedHost: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS, optional: true },
};

/**
 * The manifest fields this verification reads. The two path arrays are read
 * from the parsed JSON directly after this snapshot succeeds, so an element
 * of the wrong type returns its specific refusal reason
 * (`invalid-owned-paths`, `invalid-allowed-prefix`) instead of collapsing
 * into `non-plain-manifest`.
 */
const MANIFEST_SCHEMA: PlainRecordSchema = {
  schemaVersion: { kind: 'integer', min: 1, optional: true },
  attemptId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  workOrderId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  projectId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  taskId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS, optional: true },
  laneId: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  repository: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  baseCommit: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  policyRevision: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  prosePath: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_PATH_CHARS, optional: true },
  manifestPath: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_PATH_CHARS, optional: true },
  independentReviewer: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  // `acceptanceSpec`, `modelAssignment` and `seatPlan` are deliberately not
  // snapshotted here: an empty nested schema snapshots any record to `{}`,
  // which would make `AcceptanceSpec.create` refuse every valid spec with
  // `missing-acceptance-spec` and would erase the seat models the reviewer
  // family check reads. The parsed manifest is fresh `JSON.parse` output
  // (plain, dense), so the raw values are read from it directly below.
};

const RECEIPT_SCHEMA: PlainRecordSchema = {
  requestId: { kind: 'string', maxLength: 512 },
  kind: { kind: 'literal', values: ['brief-verify'] },
  verdict: { kind: 'string', maxLength: 64 },
  candidateHeadSha: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
  reviewerModel: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS },
};

/**
 * The untrusted review result is read only through `readPlainRecord`, never
 * through direct property access, `Object.hasOwn` or
 * `Object.getOwnPropertyDescriptor`: each of those runs a proxy trap that can
 * throw out of `verifyBrief`, so every read goes through the snapshotting
 * reader, which turns a hostile trap into a typed refusal.
 */
const REVIEW_REASON_SCHEMA: PlainRecordSchema = {
  reason: { kind: 'string', maxLength: BRIEF_PACKAGE_MAX_SCALAR_CHARS, optional: true },
};

const REVIEW_RECEIPT_SCHEMA: PlainRecordSchema = {
  receipt: { kind: 'record', schema: RECEIPT_SCHEMA },
};

const UNVERIFIED_WORK_ORDER_UNREADABLE: VerifyBriefResult = {
  outcome: 'unverified',
  reason: 'work-order-unreadable',
  detail: 'missing-work-order-repository',
};

function refuse(reason: VerifyBriefRefusalReason, detail: string | null): VerifyBriefResult {
  return { outcome: 'refused', reason, detail };
}

function unverified(reason: VerifyBriefUnverifiedReason, detail: string | null): VerifyBriefResult {
  return { outcome: 'unverified', reason, detail };
}

/** A non-empty, trimmed, NUL-free string within the scalar bound. */
function isValidScalar(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.trim().length > 0
    && value.length <= BRIEF_PACKAGE_MAX_SCALAR_CHARS
    && !value.includes('\0')
  );
}

/**
 * A prefix the brief accepts. `validateAllowedPathPrefix` itself normalises
 * trailing slashes away, so a prefix such as `src/` passes it; the brief
 * refuses that form explicitly.
 */
function isValidAllowedPrefix(prefix: unknown): boolean {
  if (typeof prefix !== 'string' || validateAllowedPathPrefix(prefix) !== null) {
    return false;
  }
  return !prefix.trim().endsWith('/');
}

/**
 * The implementer/author seat models the frozen manifest declares: the model
 * assignment (the authoring seat) plus every first-pass and fix seat of the
 * optional seat plan. Read from the parsed manifest (fresh `JSON.parse`
 * output, plain and dense) and fail closed: a seat whose model cannot be
 * established is not a model that proves independence, so an empty result
 * means the reviewer's independence cannot be verified.
 */
function implementerModelsOf(manifestPaths: Record<string, unknown>): string[] {
  const models: string[] = [];
  const assignment = manifestPaths.modelAssignment;
  if (assignment !== null && typeof assignment === 'object' && !Array.isArray(assignment)) {
    const model = (assignment as { model?: unknown }).model;
    if (isValidScalar(model)) {
      models.push(model.trim());
    } else {
      // The authoring seat must be known; without it no independence is provable.
      return [];
    }
  } else {
    return [];
  }
  const seatPlan = manifestPaths.seatPlan;
  if (seatPlan !== undefined && seatPlan !== null && typeof seatPlan === 'object' && !Array.isArray(seatPlan)) {
    // The frozen plan groups its seats under role keys (SeatPlanProps).
    for (const role of ['first-pass', 'fix'] as const) {
      const seats = (seatPlan as Record<string, unknown>)[role];
      if (!Array.isArray(seats)) {
        // A malformed plan is the reader's refusal (`invalid-seat-plan`); skip it here.
        continue;
      }
      for (let index = 0; index < seats.length; index += 1) {
        const seat = Object.getOwnPropertyDescriptor(seats, String(index))?.value;
        if (seat === null || typeof seat !== 'object' || Array.isArray(seat)) {
          continue;
        }
        const model = (seat as { model?: unknown }).model;
        if (isValidScalar(model)) {
          models.push(model.trim());
        } else {
          return [];
        }
      }
    }
  }
  return models;
}

interface Snapshot {
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly expectedBriefDigest: string;
  readonly prosePath: string;
  readonly manifestPath: string;
  readonly recordedHost: string | undefined;
}

/** Snapshot and validate a runtime request; the detail code when it is not a valid request. */
function snapshotRequest(request: unknown): { readonly snapshot: Snapshot; readonly detail: null } | {
  readonly snapshot: null;
  readonly detail: string
} {
  const read = readPlainRecord(request, REQUEST_SCHEMA);
  if (!read.ok) {
    return { snapshot: null, detail: read.field === null ? read.reason : `${read.reason}:${read.field}` };
  }
  const raw = read.value;
  for (const field of ['workOrderId', 'attemptId', 'worktreePath', 'expectedBriefDigest'] as const) {
    if (!isValidScalar(raw[field])) {
      return { snapshot: null, detail: field };
    }
  }
  const workOrderId = raw.workOrderId as string;
  const attemptId = raw.attemptId as string;
  const worktreePath = raw.worktreePath as string;
  const expectedBriefDigest = raw.expectedBriefDigest as string;
  if (!HEX_64.test(expectedBriefDigest)) {
    return { snapshot: null, detail: 'expectedBriefDigest' };
  }
  if (!worktreePath.startsWith('/') || worktreePath.split('/').includes('..')) {
    return { snapshot: null, detail: 'worktreePath' };
  }
  const prosePath = typeof raw.prosePath === 'string' ? raw.prosePath : VERIFY_BRIEF_DEFAULT_PROSE_PATH;
  const manifestPath = typeof raw.manifestPath === 'string'
    ? raw.manifestPath
    : VERIFY_BRIEF_DEFAULT_MANIFEST_PATH;
  if (validateWorktreeRelativePath(prosePath) !== null) {
    return { snapshot: null, detail: 'prosePath' };
  }
  if (validateWorktreeRelativePath(manifestPath) !== null) {
    return { snapshot: null, detail: 'manifestPath' };
  }
  if (raw.recordedHost !== undefined && !isValidScalar(raw.recordedHost)) {
    return { snapshot: null, detail: 'recordedHost' };
  }
  return {
    detail: null,
    snapshot: {
      workOrderId,
      attemptId,
      worktreePath,
      expectedBriefDigest,
      prosePath,
      manifestPath,
      recordedHost: raw.recordedHost as string | undefined,
    },
  };
}

/** Loads and rehydrates the claimed work order; a verdict when it fails, or the record. */
async function loadWorkOrder(
  deps: VerifyBriefDependencies,
  workOrderId: string,
): Promise<{ readonly record: WorkOrderRecord } | {
  readonly verdict: VerifyBriefResult
}> {
  let record: WorkOrderRecord | null | undefined;
  try {
    record = await deps.workOrderRepo.findWorkOrderById(workOrderId);
  } catch {
    return { verdict: unverified('work-order-unreadable', 'repository-error') };
  }
  if (record === null || record === undefined) {
    return { verdict: unverified('work-order-missing', null) };
  }
  let workOrder: WorkOrder;
  try {
    workOrder = WorkOrder.fromRecord(record);
  } catch {
    return { verdict: unverified('work-order-unreadable', 'invalid-work-order-record') };
  }
  if (
    record.id !== workOrderId
    || !Array.isArray(record.ownedPaths)
    || record.ownedPaths.length === 0
    || record.ownedPaths.length > BRIEF_PACKAGE_MAX_OWNED_PATHS
  ) {
    return { verdict: unverified('work-order-unreadable', 'invalid-work-order-record') };
  }
  if (workOrder.isTerminal()) {
    return { verdict: refuse('work-order-terminal', workOrder.getState()) };
  }
  return { record };
}

/**
 * Builds the `AttemptRunnerRecord` shape `AttemptArtifactPort` and
 * `ExecutorForHost` expect for a worktree host alias (`host` set, `hostName`
 * null so `ExecutorForHost` resolves the SSH host by alias instead of
 * falling back to the local executor).
 */
function recordedHostRunnerOf(recordedHost: string | undefined): AttemptRunnerRecord | undefined {
  if (recordedHost === undefined) {
    return undefined;
  }
  return {
    kind: 'opencode',
    remotePort: null,
    host: recordedHost,
    hostName: null,
    agent: null,
    model: null,
    variant: null,
  };
}

export class VerifyBriefUseCase implements VerifyBriefPort {
  // Defaulted so zero-argument structural checks compile; runtime calls
  // validate the dependencies and report `unverified` instead of throwing.
  public constructor(private readonly deps: VerifyBriefDependencies = {} as VerifyBriefDependencies) {}

  public async verifyBrief(request: VerifyBriefRequest): Promise<VerifyBriefResult> {
    let snapshotRequestResult: ReturnType<typeof snapshotRequest>;
    try {
      snapshotRequestResult = snapshotRequest(request);
    } catch {
      snapshotRequestResult = { snapshot: null, detail: 'invalid-request' };
    }
    if (snapshotRequestResult.snapshot === null) {
      return refuse('invalid-request', snapshotRequestResult.detail);
    }
    return this.run(snapshotRequestResult.snapshot);
  }

  public async execute(input: unknown): Promise<VerifyBriefResult> {
    return this.verifyBrief(input as VerifyBriefRequest);
  }

  private async run(request: Snapshot): Promise<VerifyBriefResult> {
    const deps = this.deps;
    if (typeof deps !== 'object' || deps === null
      || typeof (deps.workOrderRepo as VerifyBriefDependencies['workOrderRepo'] | undefined)?.findWorkOrderById
        !== 'function') {
      return UNVERIFIED_WORK_ORDER_UNREADABLE;
    }
    const loaded = await loadWorkOrder(deps, request.workOrderId);
    if ('verdict' in loaded) {
      return loaded.verdict;
    }
    const workOrderRecord = loaded.record;

    if (
      typeof deps.artifactPort?.readBriefManifest !== 'function'
      || typeof deps.artifactPort?.readBriefFile !== 'function'
    ) {
      return unverified('artifact-reader-unavailable', null);
    }

    const recordedHost = recordedHostRunnerOf(request.recordedHost);
    let manifestRaw: unknown;
    let proseRaw: unknown;
    try {
      manifestRaw = await deps.artifactPort.readBriefManifest(
        request.worktreePath, request.manifestPath, recordedHost,
      );
      proseRaw = await deps.artifactPort.readBriefFile(
        request.worktreePath, request.prosePath, recordedHost,
      );
    } catch {
      return refuse('unreadable-package', 'artifact-read-thrown');
    }
    if (manifestRaw === null || manifestRaw === undefined || proseRaw === null || proseRaw === undefined) {
      return refuse(
        'missing-package',
        manifestRaw === null || manifestRaw === undefined ? 'missing-manifest' : 'missing-prose',
      );
    }
    if (typeof manifestRaw !== 'string' || typeof proseRaw !== 'string') {
      return refuse('unreadable-package', 'non-string-artifact');
    }

    return this.verifyPackage(request, workOrderRecord, manifestRaw, proseRaw);
  }

  private async verifyPackage(
    request: Snapshot,
    workOrderRecord: WorkOrderRecord,
    manifestRaw: string,
    proseRaw: string,
  ): Promise<VerifyBriefResult> {
    const computeDigest = this.deps.computeDigest;
    if (typeof computeDigest !== 'function') {
      return unverified('digest-computation-failed', 'missing-digest-function');
    }
    const encoder = new TextEncoder();
    if (
      encoder.encode(manifestRaw).byteLength > BRIEF_PACKAGE_MAX_MANIFEST_BYTES
      || encoder.encode(proseRaw).byteLength > BRIEF_PACKAGE_MAX_PROSE_BYTES
    ) {
      return refuse('malformed-package', 'oversized');
    }
    if (manifestRaw.trim().length === 0) {
      return refuse('malformed-package', 'empty-manifest');
    }
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(manifestRaw);
    } catch {
      return refuse('malformed-package', 'invalid-json');
    }
    const manifestRead = readPlainRecord(parsedManifest, MANIFEST_SCHEMA);
    if (!manifestRead.ok) {
      return refuse('malformed-package', 'non-plain-manifest');
    }
    const rawManifest = manifestRead.value as Record<string, unknown>;
    // The parsed manifest is fresh `JSON.parse` output (plain, dense), so the
    // two path arrays are read from it directly; keeping them out of the
    // snapshot schema makes a wrong-type element return its specific refusal
    // reason below instead of collapsing into `non-plain-manifest`.
    const manifestPaths = parsedManifest as Record<string, unknown>;

    // The digest is computed once here so a throwing digest function is
    // `unverified` rather than a `malformed-package` collapse.
    try {
      computeDigest(`${proseRaw}\n${manifestRaw}`);
    } catch {
      return unverified('digest-computation-failed', null);
    }

    // Declared paths are checked before the package reader so each class of
    // escape returns its specific refusal reason.
    const declaredOwnedPaths = manifestPaths.ownedPaths;
    if (
      !Array.isArray(declaredOwnedPaths)
      || declaredOwnedPaths.length === 0
      || declaredOwnedPaths.length > BRIEF_PACKAGE_MAX_OWNED_PATHS
      || !declaredOwnedPaths.every((path) => typeof path === 'string' && path.trim().length > 0)
    ) {
      return refuse('malformed-package', 'invalid-owned-paths');
    }
    const allowedPathPrefixes = manifestPaths.allowedPathPrefixes;
    if (
      !Array.isArray(allowedPathPrefixes)
      || allowedPathPrefixes.length === 0
      || allowedPathPrefixes.length > BRIEF_PACKAGE_MAX_OWNED_PATHS
      || !allowedPathPrefixes.every((prefix) => isValidAllowedPrefix(prefix))
    ) {
      return refuse('path-escapes-allowed-prefixes', 'invalid-allowed-prefix');
    }
    for (const path of declaredOwnedPaths as readonly string[]) {
      if (
        validateWorktreeRelativePath(path) !== null
        || isFixedProtectedPath(path)
        || !allowedPathPrefixes.some((prefix) => pathUnderPrefix(path, prefix as string))
      ) {
        return refuse('path-escapes-allowed-prefixes', path);
      }
    }
    const recordPaths = new Set(workOrderRecord.ownedPaths);
    const declaredPaths = new Set(declaredOwnedPaths as readonly string[]);
    if (
      declaredPaths.size !== (declaredOwnedPaths as readonly string[]).length
      || (declaredOwnedPaths as readonly string[]).length !== recordPaths.size
      || (declaredOwnedPaths as readonly string[]).some((path) => !recordPaths.has(path))
      || workOrderRecord.ownedPaths.some((path) => !declaredPaths.has(path))
    ) {
      return refuse('owned-paths-mismatch', null);
    }

    const read = readBriefPackageManifest(
      {
        manifestRaw,
        prose: proseRaw,
        expectedBriefDigest: request.expectedBriefDigest,
        prosePath: request.prosePath,
        manifestPath: request.manifestPath,
        attemptId: request.attemptId,
        baseCommit: workOrderRecord.baseCommit,
        policyRevision: workOrderRecord.policyRevision,
        independentReviewer: rawManifest.independentReviewer,
        ownedPaths: manifestPaths.ownedPaths,
        // Read raw from the parsed manifest: the plain-record snapshot would
        // reduce any acceptance spec to `{}` and break `AcceptanceSpec.create`.
        acceptanceSpec: manifestPaths.acceptanceSpec,
      },
      { computeDigest },
    );
    if (!read.ok) {
      return refuse('malformed-package', read.code);
    }
    const pkg: BriefPackage = read.value;

    // The frozen package must describe the record it claims to implement.
    if (
      rawManifest.attemptId !== request.attemptId
      || rawManifest.workOrderId !== workOrderRecord.id
      || rawManifest.projectId !== workOrderRecord.projectId
      || (rawManifest.taskId !== undefined && rawManifest.taskId !== workOrderRecord.taskId)
      || rawManifest.laneId !== workOrderRecord.laneId
      || rawManifest.repository !== workOrderRecord.repository
      || rawManifest.baseCommit !== workOrderRecord.baseCommit
      || rawManifest.policyRevision !== workOrderRecord.policyRevision
    ) {
      return refuse('malformed-package', 'record-mismatch');
    }

    // The reviewer must be independent of every implementer/author seat the
    // frozen manifest declares (owner rule 2026-10-16, fail closed): the
    // same underlying model family after provider prefixes and tier variants
    // is never independence, and a seat whose model is unknown refuses.
    const implementerModels = implementerModelsOf(manifestPaths);
    if (implementerModels.length === 0) {
      return refuse('malformed-package', 'invalid-model-assignment');
    }
    const reviewerModel = typeof rawManifest.independentReviewer === 'string'
      ? rawManifest.independentReviewer.trim()
      : '';
    const reviewerFamily = underlyingModelFamily(reviewerModel);
    if (implementerModels.some(
      (model) => isSameModelFamily(reviewerFamily, underlyingModelFamily(model)),
    )) {
      return refuse('malformed-package', 'reviewer-not-independent');
    }

    const lintResult = lintBrief(proseRaw);
    if (!lintResult.ok) {
      return refuse('malformed-package', lintResult.findings[0]?.rule ?? 'brief-lint-failed');
    }

    const digest12 = pkg.getBriefDigest().slice(0, 12);
    const verificationKey = `brief-verify/${workOrderRecord.id}@${digest12}`;
    const reviewOutcome = await this.requestIndependentReview({
      reviews: this.deps.reviews,
      pkg,
      workOrderRecord,
      proseRaw,
      implementerModel: implementerModels[0]!,
      digest12,
    });
    if (reviewOutcome !== null) {
      return reviewOutcome;
    }

    return {
      outcome: 'verified',
      workOrderId: workOrderRecord.id,
      attemptId: pkg.getAttemptId(),
      briefDigest: pkg.getBriefDigest(),
      verificationKey,
    };
  }

  /** Runs the required independent `brief-verify` review; null means the receipt passed. */
  private async requestIndependentReview(context: {
    readonly reviews: Pick<ReviewRequestPort, 'requestReview'> | undefined;
    readonly pkg: BriefPackage;
    readonly workOrderRecord: WorkOrderRecord;
    readonly proseRaw: string;
    readonly implementerModel: string;
    readonly digest12: string;
  }): Promise<VerifyBriefResult | null> {
    const { reviews, pkg, workOrderRecord, proseRaw, implementerModel, digest12 } = context;
    if (typeof reviews?.requestReview !== 'function') {
      return unverified('review-unverified', 'missing-request-review');
    }
    const requestId = `brief-verify:${workOrderRecord.id}:${digest12}`;
    const reviewRequest: ReviewRequest = {
      requestId,
      kind: 'brief-verify',
      attemptId: pkg.getAttemptId(),
      projectId: workOrderRecord.projectId,
      candidateHeadSha: workOrderRecord.baseCommit,
      subject: {
        kind: 'brief',
        projectId: workOrderRecord.projectId,
        briefPackageDigest: pkg.getBriefDigest(),
        baseCommit: workOrderRecord.baseCommit,
      },
      policyRevision: workOrderRecord.policyRevision,
      implementerModel,
      reviewerModel: pkg.getIndependentReviewer(),
      briefText: proseRaw,
    };
    let reviewResult: unknown;
    try {
      reviewResult = await reviews.requestReview(reviewRequest);
    } catch {
      return unverified('review-unverified', 'review-thrown');
    }
    // The `reason` detail is snapshotted like everything else: reading it
    // directly would run a proxy trap that can throw out of `verifyBrief`.
    const detailForIncomplete = (): string => {
      const reasonRead = readPlainRecord(reviewResult, REVIEW_REASON_SCHEMA);
      return reasonRead.ok && typeof reasonRead.value.reason === 'string'
        ? reasonRead.value.reason
        : 'review-incomplete';
    };
    // The result must be a plain record: `in` and property access accept
    // inherited outcomes and hostile proxy traps can throw out of
    // `verifyBrief`, so the snapshot below refuses both.
    const outcomeRead = readPlainRecord(
      reviewResult,
      { outcome: { kind: 'string', maxLength: 64 } },
    );
    if (!outcomeRead.ok) {
      return unverified('review-unverified', detailForIncomplete());
    }
    const outcome = outcomeRead.value.outcome;
    if (outcome === 'unknown' || outcome === 'no-receipt' || outcome === 'refused') {
      return unverified('review-unverified', detailForIncomplete());
    }
    if (outcome !== 'receipt') {
      return unverified('review-unverified', detailForIncomplete());
    }
    // The receipt is snapshotted as a nested record: `Object.hasOwn` and
    // `getOwnPropertyDescriptor` on the untrusted result run proxy traps that
    // can throw out of `verifyBrief`, and `in`/property access accept
    // inherited receipts.
    const receiptRead = readPlainRecord(reviewResult, REVIEW_RECEIPT_SCHEMA);
    const receipt = receiptRead.ok
      ? (receiptRead.value.receipt as Record<string, unknown>)
      : null;
    if (
      receipt === null
      || receipt.requestId !== requestId
      || !isValidScalar(receipt.candidateHeadSha)
      || receipt.candidateHeadSha !== workOrderRecord.baseCommit
      || !isValidScalar(receipt.reviewerModel)
      || receipt.reviewerModel !== pkg.getIndependentReviewer()
    ) {
      return unverified('review-unverified', 'receipt-mismatch');
    }
    const verdict = receipt.verdict;
    if (verdict === 'failed') {
      return refuse('review-failed', null);
    }
    if (verdict !== 'passed') {
      return unverified('review-unverified', 'verdict-unknown');
    }
    return null;
  }
}
