// Implemented use case — acceptance & forge station (cross-context step).
/**
 * RequestAttemptAcceptanceUseCase implements RequestAttemptAcceptancePort.
 *
 * It requests verification and independent review of one exact candidate
 * head: the attempt must have ended and been collected, the candidate head
 * must match the collected artifacts exactly, and the reviewer's model
 * family must differ from the implementer's (a provider prefix or a tier/
 * suffix change alone is never independence).
 * The implementer is the attempt's own recorded seat — the runner model
 * dispatch wrote, or failing that the frozen brief manifest's model
 * assignment read through the artifact port. There is no default seat and no
 * worktree-file fallback: an attempt whose seat is unknown is refused, never
 * compared against an assumed model, and a model is never read from a file
 * inside the worker's worktree.
 * The evidence context's exact-head assessment is consumed through
 * AcceptanceAssessmentPort; a receipt for any other head is never propagated
 * as an acceptance of the requested one.
 * When the gate is wired, the frozen acceptance spec is evaluated predicate
 * by predicate before the evidence assessment, each result is journaled,
 * and the first predicate that does not pass rejects; model reports are
 * never an input.
 *
 * `resolveImplementerSeat` is the single binding of an attempt to the seat
 * that implemented it. Composition roots read it through the same function so
 * no boundary (CLI, API) can state an implementer model of its own.
 */

import type {
  RequestAttemptAcceptancePort,
  RequestAttemptAcceptanceRequest,
  RequestAttemptAcceptanceResult,
} from '../ports/in/RequestAttemptAcceptancePort.in-port.js';
import type { AcceptanceAssessmentPort } from '../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRecord, WorkOrderRecord, ActionJournalEntryRecord } from '../../domain/execution-records.js';
import { WorkOrder } from '../../domain/entities/WorkOrder.js';
import { isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import type { AllowedSeatPort } from '../ports/out/AllowedSeatPort.out-port.js';
import { AcceptanceSpec } from '../../domain/value-objects/AcceptanceSpec.vo.js';
import { simpleDeterministicHexDigest } from './PrepareBriefPackageUseCase.use-case.js';
import type { GatePredicatePort, GatePredicateResult, GatePredicateVerdict } from '../ports/out/GatePredicatePort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Ports that can read the frozen brief manifest; the artifact port reads the
 * product's frozen brief package, and is not assumed present.
 */
export interface ImplementerSeatPorts {
  readonly artifactPort?: Pick<AttemptArtifactPort, 'readBriefManifest'>;
}

/** The seat an attempt was implemented on, and the record that established it. */
export type ImplementerSeatResolution =
  | {
      readonly outcome: 'resolved';
      readonly model: string;
      readonly source: 'attempt-runner' | 'frozen-manifest';
    }
  | { readonly outcome: 'unknown'; readonly reason: string };

const GATE_PREDICATE_VERDICT_TO_STATUS: Record<
  GatePredicateVerdict,
  ActionJournalEntryRecord['status']
> = {
  pass: 'completed',
  fail: 'refused',
  unknown: 'ambiguous',
  skipped: 'refused',
};

/**
 * Read `modelAssignment.model` from the attempt's frozen brief manifest. The
 * candidate paths are derived from the dispatch-recorded brief package path
 * only, and the manifest is read only through the artifact port, which reads
 * the product's frozen brief package: a worker-writable worktree file is
 * never a seat authority, so an attempt without a recorded runner model and
 * without a wired artifact port stays `unknown` and is refused. An unreadable
 * or non-JSON candidate is absence, not an error.
 */
async function readFrozenManifestModel(
  attempt: AttemptRecord,
  ports: ImplementerSeatPorts,
): Promise<string | null> {
  const briefPackagePath = attempt.briefPackagePath;
  const candidates = [
    briefPackagePath,
    isNonEmptyString(briefPackagePath)
      ? briefPackagePath.replace(/\.md$/, '-manifest.json')
      : null,
  ].filter(isNonEmptyString);

  for (const candidate of candidates) {
    let raw: string | null = null;
    try {
      raw = ports.artifactPort?.readBriefManifest
        ? await ports.artifactPort.readBriefManifest(
            attempt.worktreePath,
            candidate,
            attempt.runner ?? null,
          )
        : null;
    } catch {
      continue;
    }
    if (!isNonEmptyString(raw)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') {
        continue;
      }
      const model = (parsed as { readonly modelAssignment?: { readonly model?: unknown } })
        .modelAssignment?.model;
      if (isNonEmptyString(model)) {
        return model.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Bind an attempt to the seat that implemented it: the runner model dispatch
 * recorded on the attempt, otherwise the frozen brief manifest's model
 * assignment read through the artifact port. Neither known is `unknown`,
 * never an assumed default seat, and an attempt with no recorded runner model
 * and no wired artifact port is refused.
 */
export async function resolveImplementerSeat(
  attempt: AttemptRecord,
  ports: ImplementerSeatPorts = {},
): Promise<ImplementerSeatResolution> {
  const recorded = attempt.runner?.model;
  if (isNonEmptyString(recorded)) {
    return { outcome: 'resolved', model: recorded.trim(), source: 'attempt-runner' };
  }
  const manifestModel = await readFrozenManifestModel(attempt, ports);
  if (manifestModel !== null) {
    return { outcome: 'resolved', model: manifestModel, source: 'frozen-manifest' };
  }
  return {
    outcome: 'unknown',
    reason: `Attempt ${attempt.id} records no implementer seat: neither the dispatched runner model nor the frozen brief manifest's model assignment is known`,
  };
}

export interface RequestAttemptAcceptanceDependencies {
  /** Attempt lookup is read-only; acceptance never mutates an attempt. */
  readonly attemptRepo: AttemptRepositoryPort;
  /**
   * The work order supplies the approved policy revision that scopes the
   * assessment, and receives the 'ready-to-merge' state on acceptance.
   * Without it no policy-scoped assessment can be requested.
   */
  readonly workOrderRepo?: WorkOrderRepositoryPort;
  /** Consumes the evidence context's exact-head assessment. */
  readonly acceptancePort: AcceptanceAssessmentPort;
  /** Reads the frozen brief package (prose and manifest) for the gate. */
  readonly artifactPort?: Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'>;
  /**
   * Plan S2: evaluates the frozen acceptance spec before the evidence
   * assessment. When absent the gate is not run (composition roots wire it).
   */
  readonly gatePredicates?: GatePredicatePort;
  /** Required with gatePredicates: one entry per predicate. */
  readonly journal?: Pick<ExecutionJournalPort, 'appendJournalEntry' | 'listJournalEntriesForAttempt'>;
  /** Infrastructure digest (SHA-256); the FNV fallback is for tests. */
  readonly computeDigest?: (content: string) => string;
  /** Free-seat check (plan F5): refuses a free or unknown reviewer when wired. */
  readonly allowedSeats?: AllowedSeatPort;
  /**
   * Composition-root clock for revision timestamps; the wall-clock default
   * is a scaffold convenience, not an authority source.
   */
  readonly now?: () => string;
}

export class RequestAttemptAcceptanceUseCase implements RequestAttemptAcceptancePort {
  constructor(private readonly deps?: RequestAttemptAcceptanceDependencies) {}

  async requestAttemptAcceptance(
    request: RequestAttemptAcceptanceRequest,
  ): Promise<RequestAttemptAcceptanceResult> {
    const deps = this.deps;
    if (!deps) {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }

    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (attempt === null) {
      return { outcome: 'rejected', reason: 'Attempt not found' };
    }
    if (attempt.state !== 'collected' && attempt.state !== 'ended') {
      return {
        outcome: 'rejected',
        reason: `Attempt is not ready for acceptance: state is '${attempt.state}'`,
      };
    }
    if (attempt.artifacts === null) {
      return { outcome: 'rejected', reason: 'Attempt has no collected artifacts' };
    }

    // Only the exact collected head is ever assessed; a moved head is stale.
    if (attempt.artifacts.headCommit !== request.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Candidate head mismatch: expected ${attempt.artifacts.headCommit}, got ${request.candidateHeadSha}`,
      };
    }

    // The implementer is the attempt's own seat; an unknown seat is refused
    // rather than compared against an assumed default.
    const implementerSeat = await resolveImplementerSeat(attempt, {
      artifactPort: deps.artifactPort,
    });
    if (implementerSeat.outcome === 'unknown') {
      return { outcome: 'rejected', reason: implementerSeat.reason };
    }
    const implementerModel = implementerSeat.model;
    // The reviewer seat must be named; a missing one is refused before any
    // independence or free-seat check is evaluated.
    if (!isNonEmptyString(request.reviewerModel)) {
      return { outcome: 'rejected', reason: 'reviewerModel is required' };
    }
    // Independence is the owner-decided family rule: the same underlying model
    // family (after the provider path and any `#`, `:` or `@` suffix are
    // dropped) is never independence, and an empty family fails closed.
    if (
      isSameModelFamily(
        underlyingModelFamily(implementerModel),
        underlyingModelFamily(request.reviewerModel),
      )
    ) {
      return {
        outcome: 'rejected',
        reason: `Reviewer model ${request.reviewerModel} matches implementer model ${implementerModel}; an independent reviewer is required`,
      };
    }
    // S1: with a seat plan the lane may rotate implementers across families;
    // the reviewer must be independent of every model that ran in the lane.
    if (attempt.seatPlan) {
      const lane = await deps.attemptRepo.listAttemptsByWorkOrder(attempt.workOrderId);
      const laneModels = lane
        .map((record) => record.runner?.model ?? null)
        .filter((model): model is string => typeof model === 'string' && model.trim().length > 0);
      const clash = laneModels.find((model) =>
        isSameModelFamily(underlyingModelFamily(model), underlyingModelFamily(request.reviewerModel)),
      );
      if (clash !== undefined) {
        return {
          outcome: 'rejected',
          reason:
            'Reviewer model ' + request.reviewerModel + ' shares a model family with implementer model ' +
            clash + ' earlier in this lane; an independent reviewer is required',
        };
      }
    }

    // Free-seat policy (plan F5): with the flag off, a reviewer model must be
    // a catalogue seat that is not free; a free or unknown reviewer is
    // rejected before any verification is requested.
    if (deps.allowedSeats) {
      const verdict = deps.allowedSeats.checkReviewerModel({ model: request.reviewerModel });
      if (!verdict.allowed) {
        return { outcome: 'rejected', reason: verdict.reason };
      }
    }

    const workOrder = deps.workOrderRepo
      ? await deps.workOrderRepo.findWorkOrderById(attempt.workOrderId)
      : null;
    if (workOrder === null) {
      return {
        outcome: 'rejected',
        reason: 'Acceptance requires the work order policy revision; no work order is available',
      };
    }

    if (deps.gatePredicates !== undefined) {
      const gate = await this.runGate(deps, deps.gatePredicates, attempt, request.candidateHeadSha);
      if (gate !== null) {
        return { outcome: 'rejected', reason: gate };
      }
    }

    const verdict = await deps.acceptancePort.assessHeadAcceptance({
      attemptId: request.attemptId,
      workOrderId: attempt.workOrderId,
      candidateHeadSha: request.candidateHeadSha,
      policyRevision: workOrder.policyRevision,
    });

    if (verdict.outcome === 'accepted') {
      // A receipt for a different head is stale evidence, never a pass.
      if (verdict.assessedHeadSha !== request.candidateHeadSha) {
        return {
          outcome: 'rejected',
          reason: `Stale: assessed head ${verdict.assessedHeadSha} does not match candidate head ${request.candidateHeadSha}`,
        };
      }
      await this.markReadyToMerge(deps, workOrder);
      return {
        outcome: 'accepted',
        candidateHeadSha: verdict.assessedHeadSha,
        receiptId: verdict.receiptId,
      };
    }
    if (verdict.outcome === 'unknown') {
      return { outcome: 'rejected', reason: `Unknown: ${verdict.reason}` };
    }
    return { outcome: 'rejected', reason: verdict.reason };
  }

  async execute(input?: unknown): Promise<RequestAttemptAcceptanceResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }
    return this.requestAttemptAcceptance(input as RequestAttemptAcceptanceRequest);
  }

  /** Accepted heads may move a non-terminal work order to 'ready-to-merge'. */
  private async markReadyToMerge(
    deps: RequestAttemptAcceptanceDependencies,
    workOrderRecord: WorkOrderRecord,
  ): Promise<void> {
    if (deps.workOrderRepo === undefined) {
      return;
    }
    const workOrder = WorkOrder.fromRecord(workOrderRecord);
    if (workOrder.isTerminal()) {
      return;
    }
    await deps.workOrderRepo.saveWorkOrder({
      ...workOrderRecord,
      state: 'ready-to-merge',
      revision: workOrder.nextRevision(),
      updatedAtIso: deps.now?.() ?? new Date().toISOString(),
    });
  }

  /**
   * Plan S2: evaluate the frozen acceptance spec predicate by predicate before
   * the evidence assessment. Returns a rejection reason, or null when every
   * predicate passed.
   */
  private async runGate(
    deps: RequestAttemptAcceptanceDependencies,
    gatePort: GatePredicatePort,
    attempt: AttemptRecord,
    candidateHeadSha: string,
  ): Promise<string | null> {
    const id = attempt.id;
    if (deps.journal === undefined) {
      return 'Gate predicates need the execution journal';
    }
    const journal = deps.journal;
    if (!isNonEmptyString(attempt.briefPackagePath) || !isNonEmptyString(attempt.briefDigest)) {
      return `Attempt ${id} records no frozen brief; the gate cannot be read`;
    }
    const artifactPort = deps.artifactPort;
    if (artifactPort?.readBriefFile === undefined || artifactPort.readBriefManifest === undefined) {
      return 'No artifact port can read the frozen brief';
    }

    let prose: string | null;
    let manifestRaw: string | null;
    try {
      prose = await artifactPort.readBriefFile(
        attempt.worktreePath,
        attempt.briefPackagePath,
        attempt.runner ?? null,
      );
      manifestRaw = await artifactPort.readBriefManifest(
        attempt.worktreePath,
        attempt.briefPackagePath.replace(/\.md$/, '-manifest.json'),
        attempt.runner ?? null,
      );
    } catch {
      return `Unable to read the frozen brief for attempt ${id}`;
    }
    if (prose === null || manifestRaw === null) {
      return `Unable to read the frozen brief for attempt ${id}`;
    }

    const digest = (deps.computeDigest ?? simpleDeterministicHexDigest)(
      prose + '\n' + manifestRaw,
    );
    if (digest !== attempt.briefDigest) {
      return `Frozen brief digest mismatch for attempt ${id}: the brief or its manifest changed after it was prepared`;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      return `Frozen brief manifest for attempt ${id} is not a JSON object`;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `Frozen brief manifest for attempt ${id} is not a JSON object`;
    }
    const manifest = parsed as Record<string, unknown>;
    if (manifest.baseCommit !== attempt.baseCommit) {
      return 'Frozen brief base commit does not match the attempt base commit';
    }
    const created = AcceptanceSpec.create(manifest.acceptanceSpec);
    if (!created.success || created.value === undefined) {
      return `Frozen brief has no valid acceptance spec: ${created.error?.message ?? 'unknown error'}`;
    }
    const spec = created.value;

    const rawPrefixes = manifest.allowedPathPrefixes;
    const allowedPathPrefixes =
      Array.isArray(rawPrefixes) && rawPrefixes.every((item) => typeof item === 'string')
        ? (rawPrefixes as string[])
        : [];

    const priorEntries = await journal.listJournalEntriesForAttempt(id);
    const entryCount = priorEntries.length + 1;
    await journal.appendJournalEntry({
      id: `${id}:accept:${entryCount}`,
      attemptId: id,
      workOrderId: attempt.workOrderId,
      action: 'accept',
      baseCommit: attempt.baseCommit,
      recordedAtIso: deps.now?.() ?? new Date().toISOString(),
      sessionId: attempt.sessionId,
      status: 'intent-recorded',
      detail: 'gate: ' + String(2 + spec.getCommands().length) + ' predicates for head ' + candidateHeadSha,
    });

    const gateResult = await gatePort.evaluateGatePredicates({
      attemptId: id,
      worktreePath: attempt.worktreePath,
      runner: attempt.runner ?? null,
      baseCommit: attempt.baseCommit,
      candidateHeadSha,
      allowedPathPrefixes,
      spec: spec.toJSON(),
    });
    if (gateResult.outcome === 'unavailable') {
      await journal.appendJournalEntry({
        id: `${id}:accept:${entryCount + 1}`,
        attemptId: id,
        workOrderId: attempt.workOrderId,
        action: 'accept',
        baseCommit: attempt.baseCommit,
        recordedAtIso: deps.now?.() ?? new Date().toISOString(),
        sessionId: attempt.sessionId,
        status: 'ambiguous',
        detail: gateResult.reason,
      });
      return 'Unknown: gate predicates unavailable: ' + gateResult.reason;
    }

    const results = gateResult.results;
    const entries = results.map((result, offset) =>
      this.gateJournalEntry(deps, attempt, id, entryCount + 1 + offset, result),
    );
    await entries.reduce(
      (chain, entry) => chain.then(() => journal.appendJournalEntry(entry)),
      Promise.resolve(),
    );

    for (const result of results) {
      if (result.verdict !== 'pass') {
        const exitText = result.exitCode === null ? '' : ' with exit code ' + result.exitCode;
        return 'Gate predicate ' + result.name + ' ' + result.verdict + exitText + ': ' + result.detail;
      }
    }
    return null;
  }

  private gateJournalEntry(
    deps: RequestAttemptAcceptanceDependencies,
    attempt: AttemptRecord,
    id: string,
    offset: number,
    result: GatePredicateResult,
  ): ActionJournalEntryRecord {
    const detailObject: Record<string, unknown> = {
      predicate: result.name,
      kind: result.kind,
      verdict: result.verdict,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      detail: result.detail,
    };
    if (result.coverage !== undefined) {
      detailObject.coverage = result.coverage;
    }
    return {
      id: `${id}:accept:${offset}`,
      attemptId: id,
      workOrderId: attempt.workOrderId,
      action: 'accept',
      baseCommit: attempt.baseCommit,
      recordedAtIso: deps.now?.() ?? new Date().toISOString(),
      sessionId: attempt.sessionId,
      status: GATE_PREDICATE_VERDICT_TO_STATUS[result.verdict],
      detail: JSON.stringify(detailObject),
    };
  }
}
