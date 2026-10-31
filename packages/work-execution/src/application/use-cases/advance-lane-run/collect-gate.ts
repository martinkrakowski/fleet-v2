/** The `act collect` and `act gate` steps of AdvanceLaneRunUseCase (AL-2). */
import type { AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { GatePredicateResult } from '../../ports/out/GatePredicatePort.out-port.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendRunIntent, appendRunResult, performPark } from './step-context.js';
import { manifestExpectedArtifacts, readFrozenManifest } from './frozen-manifest.js';
import { historyEntryOf } from '../../../domain/seat-selection.js';

/**
 * The `act collect` decision (K4-6): collect an ended attempt's artifacts
 * through `CollectAttemptArtifactsPort`, running the edit-only commit step
 * (`CommitEditOnlyAttemptPort`) first when the attempt ran under agy. A
 * commit refusal parks for the owner on the next advance, unknown parks as
 * ambiguous, and a collect refusal journals `collect-refused`.
 */
export async function performCollect(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const collect = ctx.deps.collectAttemptArtifacts;
  if (collect === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const commitEditOnlyAttempt = ctx.deps.commitEditOnlyAttempt;
  if (latest.runner?.kind === 'agy' && commitEditOnlyAttempt === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  return runCollectBody(ctx, record, gathered, decision, request, decision.key);
}

/**
 * The collect body after its intent (K4-6): the frozen artifact list is
 * read before any write, the edit-only commit step runs first for an agy
 * attempt, then the collection. Both steps are safe to repeat — the commit
 * reads `already-committed`, a collected record is not collected twice —
 * so the collect reconcile (K4-7) runs this same body under the pending
 * key instead of appending a second intent.
 */
export async function runCollectBody(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' | 'reconcile' }>,
  request: AdvanceLaneRunRequest,
  key: string,
): Promise<AdvanceLaneRunResult> {
  const collect = ctx.deps.collectAttemptArtifacts;
  if (collect === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  // Shared by the act and the reconcile: an agy attempt is never collected without its edit-only commit.
  if (latest.runner?.kind === 'agy' && ctx.deps.commitEditOnlyAttempt === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  if (latest.state !== 'ended' || latest.completionReceipt === null) {
    const resultRefusal = await appendRunResult(ctx, request, key, 'refused', 'no-completion-receipt');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'no-completion-receipt' };
  }
  // The frozen artifact list is read before any write: an absent or unreadable manifest, or an
  // unreadable expectedArtifacts, refuses the collect before the edit-only commit touches git.
  const manifest = await readFrozenManifest(latest, ctx.deps.artifactPort);
  const expectedArtifacts = manifest === null ? null : manifestExpectedArtifacts(manifest);
  if (expectedArtifacts === null) {
    const resultRefusal = await appendRunResult(ctx, request, key, 'refused', 'collect-refused');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'collect-refused' };
  }
  const commitEditOnlyAttempt = ctx.deps.commitEditOnlyAttempt;
  if (latest.runner?.kind === 'agy' && commitEditOnlyAttempt !== undefined) {
    const committed = await commitEditOnlyAttempt.commitEditOnlyAttempt({
      attemptId: latest.id,
      nowIso: request.nowIso,
    });
    if (committed.outcome === 'refused') {
      const resultRefusal = await appendRunResult(ctx, request, key, 'refused', 'edit-only-refused');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'edit-only-refused' };
    }
    if (committed.outcome === 'unknown') {
      const resultRefusal = await appendRunResult(ctx, request, key, 'ambiguous', 'edit-only-unknown');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'ambiguous', reasonCode: 'edit-only-unknown' };
    }
  }
  const collected = await collect.collectAttemptArtifacts({
    attemptId: latest.id,
    workOrderId: record.workOrderId,
    expectedArtifacts,
    completionReceipt: latest.completionReceipt,
  });
  if (collected.outcome === 'collected') {
    const resultRefusal = await appendRunResult(ctx, request, key, 'completed', 'collected');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'collected' };
  }
  const resultRefusal = await appendRunResult(ctx, request, key, 'refused', 'collect-refused');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key, result: 'refused', reasonCode: 'collect-refused' };
}

/** `acceptanceChecks` of a frozen manifest: a non-empty array of non-empty strings, else null. */
function manifestAcceptanceChecks(manifest: Record<string, unknown> | null): readonly string[] | null {
  if (manifest === null) {
    return null;
  }
  const value = manifest.acceptanceChecks;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    return null;
  }
  return value as readonly string[];
}

/**
 * KF-13a: record one verification receipt per acceptance check of the frozen
 * brief at the collected head before the gate's run-result is appended. When
 * wiring or manifest checks are absent nothing is recorded (today's
 * behaviour); every other failure fails closed — `false` makes the gate
 * `ambiguous` / `gate-unknown`, never a throw: acceptance is never attempted
 * without the gate's evidence.
 */
async function recordGateReceipts(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  latest: AttemptRecord,
  key: string,
  request: AdvanceLaneRunRequest,
  results: readonly GatePredicateResult[],
): Promise<boolean> {
  const gateReceipts = ctx.deps.gateReceipts;
  if (gateReceipts === undefined) {
    return true;
  }
  // Every read and write below is guarded: a throw is `false` (gate-unknown),
  // never an exception out of the gate step.
  try {
    return await recordGateReceiptsGuarded(ctx, record, latest, key, request, results, gateReceipts);
  } catch {
    return false;
  }
}

async function recordGateReceiptsGuarded(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  latest: AttemptRecord,
  key: string,
  request: AdvanceLaneRunRequest,
  results: readonly GatePredicateResult[],
  gateReceipts: NonNullable<AdvanceStepContext['deps']['gateReceipts']>,
): Promise<boolean> {
  const manifest = await readFrozenManifest(latest, ctx.deps.artifactPort);
  const checks = manifestAcceptanceChecks(manifest);
  if (checks === null || latest.artifacts === null) {
    return true;
  }
  const reviewAssessment = ctx.deps.reviewAssessment;
  const workOrderRepo = ctx.deps.workOrderRepo;
  if (reviewAssessment === undefined || workOrderRepo === undefined) {
    return false;
  }
  const workOrder = await workOrderRepo.findWorkOrderById(record.workOrderId);
  if (workOrder === null) {
    return false;
  }
  // The implementer of an attempt is the model that ran it — the same value
  // the review step opens the evidence assessment with — so a fix attempt
  // from another seat opens the assessment its review reopens, never a
  // `head-mismatch`.
  const runnerModel = historyEntryOf(latest).model;
  const modelAssignment = manifest?.modelAssignment;
  const manifestModel =
    modelAssignment !== null && typeof modelAssignment === 'object'
      ? (modelAssignment as { readonly model?: unknown }).model
      : null;
  // The manifest's model names only a first-pass writer: a fix attempt with no
  // recorded model has an unknown writer, so the gate fails closed (as the
  // review step refuses it) rather than name the first-pass seat.
  const recorded = runnerModel !== null && runnerModel.trim().length > 0 ? runnerModel : null;
  const implementerModel = recorded ?? (latest.kind === 'fix' ? null : manifestModel);
  if (typeof implementerModel !== 'string' || implementerModel.trim().length === 0) {
    return false;
  }
  const commandResults = results.filter((result) => result.kind === 'command');
  // One result per check, and distinct names: a repeated name would let one
  // recorded receipt stand for two checks in the assessment.
  if (commandResults.length !== checks.length || new Set(checks).size !== checks.length) {
    return false;
  }
  const opened = await reviewAssessment.openReviewAssessment({
    attemptId: latest.id,
    projectId: workOrder.projectId,
    candidateHeadSha: latest.artifacts.headCommit,
    policyRevision: record.runPolicyRevision,
    implementerModel: implementerModel.trim(),
    requiredChecks: checks,
  });
  if (opened.outcome !== 'open') {
    return false;
  }
  const outcome = await gateReceipts.recordGateReceipts({
      attemptId: latest.id,
      projectId: workOrder.projectId,
      candidateHeadSha: latest.artifacts.headCommit,
      hostId: latest.runner?.hostName ?? 'unknown',
      policyRevision: record.runPolicyRevision,
      completedAtIso: request.nowIso,
      evidenceRef: 'run-journal:' + key,
      receipts: checks.map((check, index) => ({
        procedureName: check,
        result: commandResults[index]!.verdict,
        exitCode: commandResults[index]!.exitCode,
        ...(commandResults[index]!.coverage !== undefined
          ? { coverage: commandResults[index]!.coverage }
          : {}),
      })),
    });
  // A recorded answer counts only when every check got its receipt.
  return outcome.outcome === 'recorded' && outcome.count === checks.length;
}

/**
 * The `act gate` decision (K4-6): evaluate the frozen acceptance spec at the
 * collected head through `EvaluateAttemptGatePort`; only the typed verdict
 * decides, never a reason string.
 */
export async function performGate(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const preCheck = await gatePreCheck(ctx, record, gathered, decision, request);
  if (preCheck !== null) {
    return preCheck;
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  return runGateBody(ctx, record, gathered, decision, request, decision.key);
}

/** The gate's pre-checks before its intent (K4-6): the wiring, the attempt's artifacts, the sealed collection. */
export async function gatePreCheck(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' | 'reconcile' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult | null> {
  if (ctx.deps.evaluateAttemptGate === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  // Only a sealed collection is gated: a missing or mismatched C1 manifest parks first.
  if (gathered.facts.attempt?.collection?.manifest !== 'sealed') {
    return performPark(ctx, record, 'artifacts-unsealed', null, gathered.facts.state, request);
  }
  return null;
}

/**
 * The gate body after its intent (K4-6): evaluate the frozen acceptance
 * spec at the collected head and record the typed verdict's mapping. The
 * decision key's retry names the gate run (`/retry<n>`; none = run 0) and
 * is passed to the evaluation, so a congested run journals under its own
 * prefix and never seals the head against a later run (KF-30c2). A second
 * evaluation returns the first's stored outcome (S2b journals it once), so
 * the gate reconcile (K4-7) runs this same body under the pending key
 * instead of appending a second intent.
 */
export async function runGateBody(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' | 'reconcile' }>,
  request: AdvanceLaneRunRequest,
  key: string,
): Promise<AdvanceLaneRunResult> {
  const gate = ctx.deps.evaluateAttemptGate;
  if (gate === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const latest = gathered.latestAttempt;
  if (latest === null || latest.artifacts === null) {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  const parsedKey = parseLaneRunKey(key);
  const gateRun = parsedKey !== null && parsedKey.kind === 'step' ? (parsedKey.retry ?? undefined) : undefined;
  const verdict = await gate.evaluateAttemptGate({
    attemptId: latest.id,
    candidateHeadSha: latest.artifacts.headCommit,
    ...(gateRun === undefined ? {} : { gateRun }),
  });
  if (verdict.verdict === 'passed' || verdict.verdict === 'failed') {
    // KF-13a: record one verification receipt per acceptance check before the
    // run-result is appended; any failure fails closed to `gate-unknown`.
    const recorded = await recordGateReceipts(ctx, record, latest, key, request, verdict.results ?? []);
    if (!recorded) {
      const resultRefusal = await appendRunResult(ctx, request, key, 'ambiguous', 'gate-unknown');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key, result: 'ambiguous', reasonCode: 'gate-unknown' };
    }
  }
  if (verdict.verdict === 'passed') {
    const resultRefusal = await appendRunResult(ctx, request, key, 'completed', 'gate-passed');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'gate-passed' };
  }
  if (verdict.verdict === 'failed') {
    const resultRefusal = await appendRunResult(ctx, request, key, 'completed', 'gate-failed');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'gate-failed' };
  }
  // KF-30c2: the typed congestion signal turns only an `unknown` into a
  // completed `gate-congested` run (never a pass); any other `unknown` stays
  // exactly as today (`ambiguous` / `gate-unknown`).
  if (verdict.verdict === 'unknown' && verdict.congested === true) {
    const congestedRefusal = await appendRunResult(ctx, request, key, 'completed', 'gate-congested');
    if (congestedRefusal !== null) {
      return { outcome: 'refused', reason: congestedRefusal };
    }
    return { outcome: 'acted', step: decision.step, key, result: 'completed', reasonCode: 'gate-congested' };
  }
  const resultRefusal = await appendRunResult(ctx, request, key, 'ambiguous', 'gate-unknown');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key, result: 'ambiguous', reasonCode: 'gate-unknown' };
}
