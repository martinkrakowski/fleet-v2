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
 * never an input. The gate also stands alone behind EvaluateAttemptGatePort,
 * with a typed verdict (passed, failed, unknown), and runs once per head
 * either way: a second evaluation reads the stored outcome.
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
import type {
  EvaluateAttemptGatePort,
  EvaluateAttemptGateRequest,
  EvaluateAttemptGateResult,
} from '../ports/in/EvaluateAttemptGatePort.in-port.js';
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
import type {
  GatePredicateKind,
  GatePredicatePort,
  GatePredicateResult,
  GatePredicateVerdict,
} from '../ports/out/GatePredicatePort.out-port.js';
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

const GATE_RESULTS_MISMATCH_REASON =
  'Gate predicate results do not match the frozen acceptance spec';

/** Maximum gate retry run number (KF-30c); run 0 is the initial run. */
const GATE_RUN_MAX = 9;

/**
 * The journal id prefix for one gate run of a head. Run 0 is exactly the
 * original `${attemptId}:accept:${headSha}:`; run `n >= 1` adds `/g${n}`
 * so retried runs never collide with or seal the earlier run.
 */
function gateRunPrefix(attemptId: string, candidateHeadSha: string, gateRun: number): string {
  return gateRun === 0
    ? `${attemptId}:accept:${candidateHeadSha}:`
    : `${attemptId}:accept:${candidateHeadSha}/g${gateRun}:`;
}

/**
 * Validate a request `gateRun`: absent means 'the highest stored run at the
 * head' (`'latest'`); a present value must be an integer 1–9. Any other value
 * is out of range and returns `null`. Explicit run 0 is out of range: the
 * initial run is only ever selected by omission.
 */
function normalizeGateRun(value: number | undefined): number | 'latest' | null {
  if (value === undefined) {
    return 'latest';
  }
  if (Number.isInteger(value) && value >= 1 && value <= GATE_RUN_MAX) {
    return value;
  }
  return null;
}

/**
 * The highest STORED gate run 0..9 at one head: the first run (scanning from
 * GATE_RUN_MAX down) whose journal has any stored outcome. When no run is
 * stored, run 0 executes as today.
 */
function highestStoredGateRun(
  entries: readonly ActionJournalEntryRecord[],
  attemptId: string,
  candidateHeadSha: string,
  expected: readonly ExpectedGatePredicate[],
): number {
  for (let run = GATE_RUN_MAX; run >= 0; run -= 1) {
    if (readStoredGateOutcome(entries, attemptId, candidateHeadSha, expected, run).kind !== 'none') {
      return run;
    }
  }
  return 0;
}

/** The gate's typed outcome, shared by acceptance and the standalone gate port. */
type GateVerdict = EvaluateAttemptGateResult;

function gatePassed(results: readonly GatePredicateResult[]): GateVerdict {
  return { verdict: 'passed', results };
}

function gateUnknown(reason: string): GateVerdict {
  return { verdict: 'unknown', reason };
}

function gateFailed(reason: string, results: readonly GatePredicateResult[]): GateVerdict {
  return { verdict: 'failed', reason, results };
}

interface ExpectedGatePredicate {
  readonly name: string;
  readonly kind: GatePredicateKind;
}

function expectedGatePredicates(spec: AcceptanceSpec): readonly ExpectedGatePredicate[] {
  return [
    { name: 'commit', kind: 'commit' },
    { name: 'diff-check', kind: 'diff-check' },
    ...spec.getCommands().map((command, index) => ({
      name: ('command ' + String(index + 1) + ': ' + command.argv.join(' ')).slice(0, 120),
      kind: 'command' as const,
    })),
  ];
}

function resultsMatchExpectedPredicates(
  results: readonly GatePredicateResult[],
  expected: readonly ExpectedGatePredicate[],
): boolean {
  if (results.length !== expected.length) {
    return false;
  }
  return expected.every(
    (predicate, index) =>
      results[index]?.name === predicate.name && results[index]?.kind === predicate.kind,
  );
}

/**
 * The typed verdict for one evaluated head: a mismatch is `unknown`, a
 * `fail` anywhere is `failed`, and otherwise the first non-`pass` result
 * decides (`unknown` or `skipped` → `unknown`, since a skipped predicate
 * before any failure means the gate did not finish), and all pass is
 * `passed`. When nothing failed and every non-pass result is a gate-slot
 * congestion (KF-30c), the `unknown` verdict carries `congested: true`.
 */
function gateVerdictForResults(
  results: readonly GatePredicateResult[],
  expected: readonly ExpectedGatePredicate[],
): GateVerdict {
  if (!resultsMatchExpectedPredicates(results, expected)) {
    return gateUnknown(GATE_RESULTS_MISMATCH_REASON);
  }
  const reasonFor = (result: GatePredicateResult): string => {
    const exitText = result.exitCode === null ? '' : ' with exit code ' + String(result.exitCode);
    return (
      'Gate predicate ' + result.name + ' ' + result.verdict + exitText + ': ' + result.detail
    );
  };
  const failed = results.find((result) => result.verdict === 'fail');
  if (failed !== undefined) {
    return gateFailed(reasonFor(failed), results);
  }
  const nonPassing = results.filter((result) => result.verdict !== 'pass');
  // The adapter skips every command after the first non-pass, so skipped
  // results are neutral: the gate is congested when at least one result is a
  // gate-slot wait limit and every other non-pass result is skipped.
  const notSkipped = nonPassing.filter((result) => result.verdict !== 'skipped');
  const congested =
    notSkipped.length > 0 &&
    notSkipped.every(
      (result) => result.verdict === 'unknown' && result.cause === 'gate-slot-wait-limit',
    );
  const first = nonPassing[0];
  if (first === undefined) {
    return gatePassed(results);
  }
  const reason = reasonFor(first);
  return congested ? { verdict: 'unknown', reason, congested: true } : gateUnknown(reason);
}

function isGatePredicateKind(value: unknown): value is GatePredicateKind {
  return value === 'commit' || value === 'diff-check' || value === 'command';
}

function isGatePredicateVerdict(value: unknown): value is GatePredicateVerdict {
  return value === 'pass' || value === 'fail' || value === 'unknown' || value === 'skipped';
}

export function parseStoredPredicateResult(entry: ActionJournalEntryRecord): GatePredicateResult | null {
  if (typeof entry.detail !== 'string') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.detail);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.predicate !== 'string' ||
    !isGatePredicateKind(record.kind) ||
    !isGatePredicateVerdict(record.verdict) ||
    (record.exitCode !== null && typeof record.exitCode !== 'number') ||
    typeof record.durationMs !== 'number' ||
    typeof record.detail !== 'string' ||
    (record.cause !== undefined && record.cause !== 'gate-slot-wait-limit')
  ) {
    return null;
  }
  const cause = record.cause === undefined ? undefined : record.cause;
  return {
    name: record.predicate,
    kind: record.kind,
    verdict: record.verdict,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    detail: record.detail,
    ...(cause === undefined ? {} : { cause }),
  };
}

/**
 * Pure projection of the stored gate predicate results for one attempt head:
 * the highest STORED run's entries (`${attemptId}:accept:${headSha}:` for run
 * 0, `.../g${n}:` for run n), parsed, with verdict `fail` or `unknown` only,
 * in the id's numeric `n` order. A later retry run's non-passing predicates
 * replace an earlier run's (KF-30c2) — a fix handover names the real failing
 * predicate, never a congestion an earlier retry already recovered from.
 * `detail` and `durationMs` are dropped.
 */
export function nonPassingGatePredicatesOf(
  entries: readonly ActionJournalEntryRecord[],
  attemptId: string,
  headSha: string,
): Array<{ name: string; kind: GatePredicateKind; verdict: 'fail' | 'unknown'; exitCode: number | null }> {
  for (let run = GATE_RUN_MAX; run >= 0; run -= 1) {
    const prefix = gateRunPrefix(attemptId, headSha, run);
    const collected: Array<{
      readonly order: number;
      readonly value: { name: string; kind: GatePredicateKind; verdict: 'fail' | 'unknown'; exitCode: number | null };
    }> = [];
    let stored = false;
    for (const entry of entries) {
      // The id prefix alone is not trusted: the row must be this attempt's own
      // acceptance entry.
      if (!entry.id.startsWith(prefix) || entry.action !== 'accept' || entry.attemptId !== attemptId) {
        continue;
      }
      const indexText = entry.id.slice(prefix.length);
      if (!/^\d+$/.test(indexText)) {
        continue;
      }
      stored = true;
      const parsed = parseStoredPredicateResult(entry);
      if (parsed === null || (parsed.verdict !== 'fail' && parsed.verdict !== 'unknown')) {
        continue;
      }
      collected.push({
        order: Number.parseInt(indexText, 10),
        value: {
          name: parsed.name,
          kind: parsed.kind,
          verdict: parsed.verdict,
          exitCode: parsed.exitCode,
        },
      });
    }
    if (stored) {
      collected.sort((a, b) => a.order - b.order);
      return collected.map((item) => item.value);
    }
  }
  return [];
}

type StoredGateOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'completed'; readonly verdict: GateVerdict }
  | { readonly kind: 'incomplete'; readonly reason: string };

function readStoredGateOutcome(
  entries: readonly ActionJournalEntryRecord[],
  attemptId: string,
  candidateHeadSha: string,
  expected: readonly ExpectedGatePredicate[],
  gateRun: number,
): StoredGateOutcome {
  const prefix = gateRunPrefix(attemptId, candidateHeadSha, gateRun);
  const headSuffix = ` for head ${candidateHeadSha}`;
  // The intent-detail fallback matches only run 0's own intent ids and never
  // a `/g{n}` retry-run id, so a later run's intent cannot block or pollute
  // an earlier run's stored outcome.
  const matching = entries.filter(
    (entry) =>
      entry.attemptId === attemptId &&
      entry.action === 'accept' &&
      (entry.id.startsWith(prefix) ||
        (gateRun === 0 &&
          entry.status === 'intent-recorded' &&
          typeof entry.detail === 'string' &&
          entry.detail.endsWith(headSuffix) &&
          !/\/g[1-9]:/.test(entry.id))),
  );
  if (matching.length === 0) {
    return { kind: 'none' };
  }

  const byId = new Map<string, ActionJournalEntryRecord>();
  for (const entry of matching) {
    byId.set(entry.id, entry);
  }

  const firstResultEntry = byId.get(prefix + '1');
  if (firstResultEntry !== undefined && parseStoredPredicateResult(firstResultEntry) === null) {
    if (firstResultEntry.status === 'ambiguous') {
      return {
        kind: 'completed',
        verdict: gateUnknown('Unknown: gate predicates unavailable: ' + (firstResultEntry.detail ?? '')),
      };
    }
    if (firstResultEntry.status === 'refused') {
      return {
        kind: 'completed',
        verdict: gateUnknown(firstResultEntry.detail ?? GATE_RESULTS_MISMATCH_REASON),
      };
    }
  }

  const parsedResults: GatePredicateResult[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const entry = byId.get(`${prefix}${index + 1}`);
    if (entry === undefined) {
      return {
        kind: 'incomplete',
        reason: `Unknown: gate evaluation for head ${candidateHeadSha} has an unfinished intent in the journal`,
      };
    }
    const parsed = parseStoredPredicateResult(entry);
    if (parsed === null) {
      return {
        kind: 'incomplete',
        reason: `Unknown: gate evaluation for head ${candidateHeadSha} has an unfinished intent in the journal`,
      };
    }
    parsedResults.push(parsed);
  }

  const extraPredicateEntries = matching.some((entry) => {
    if (!entry.id.startsWith(prefix)) {
      return false;
    }
    const indexText = entry.id.slice(prefix.length);
    if (!/^\d+$/.test(indexText)) {
      return false;
    }
    const index = Number.parseInt(indexText, 10);
    return index > expected.length;
  });
  if (extraPredicateEntries) {
    return { kind: 'completed', verdict: gateUnknown(GATE_RESULTS_MISMATCH_REASON) };
  }

  return {
    kind: 'completed',
    verdict: gateVerdictForResults(parsedResults, expected),
  };
}

const inFlightGateRuns = new WeakMap<object, Map<string, Promise<void>>>();

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

export class RequestAttemptAcceptanceUseCase
  implements RequestAttemptAcceptancePort, EvaluateAttemptGatePort
{
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
      const gate = await this.runGate(deps, deps.gatePredicates, attempt, request.candidateHeadSha, 'latest');
      if (gate.verdict !== 'passed') {
        return { outcome: 'rejected', reason: gate.reason };
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

  /**
   * EvaluateAttemptGatePort: the frozen gate alone, with a typed verdict and
   * no reviewer, work order, assessment or free-seat check. The gate still
   * runs once per head; a second call reads the stored outcome. With no
   * `gateRun`, the highest stored run 0..9 at the head decides — so an
   * auto-merge read after a congested run 0 sees the retry's outcome, never
   * run 0's congestion (KF-30c2).
   */
  async evaluateAttemptGate(request: EvaluateAttemptGateRequest): Promise<EvaluateAttemptGateResult> {
    const deps = this.deps;
    if (!deps) {
      throw new Error('Not implemented: RequestAttemptAcceptanceUseCase');
    }
    const gateRun = normalizeGateRun(request.gateRun);
    if (gateRun === null) {
      return gateUnknown(`Unknown: gate run ${String(request.gateRun)} is out of range`);
    }
    if (deps.gatePredicates === undefined) {
      return gateUnknown('Gate predicates are not wired');
    }
    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    if (attempt === null) {
      return gateUnknown('Attempt not found');
    }
    if (attempt.state !== 'collected' && attempt.state !== 'ended') {
      return gateUnknown('Attempt is not ready for the gate');
    }
    if (attempt.artifacts === null) {
      return gateUnknown('Attempt has no collected artifacts');
    }
    if (attempt.artifacts.headCommit !== request.candidateHeadSha) {
      return gateUnknown('Candidate head is not the collected head');
    }
    return this.runGate(deps, deps.gatePredicates, attempt, request.candidateHeadSha, gateRun);
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
   * the evidence assessment. Returns the typed gate verdict; a run journals
   * under its own prefix (`gateRun` 0 is the original prefix; run `n >= 1`
   * adds `/g${n}`) so a congested run never seals the head against a later
   * run, and a later call for the same run reads the stored outcome.
   * `requestedRun` 'latest' resolves the highest STORED gate run 0..9 at the
   * head and returns that run's stored outcome; when no run is stored, run 0
   * executes as today. An explicit run n ≥ 1 is refused (`unknown`, nothing
   * run) unless run n-1 is stored and congested (KF-30c2).
   */
  private async runGate(
    deps: RequestAttemptAcceptanceDependencies,
    gatePort: GatePredicatePort,
    attempt: AttemptRecord,
    candidateHeadSha: string,
    requestedRun: number | 'latest',
  ): Promise<GateVerdict> {
    const id = attempt.id;
    if (deps.journal === undefined) {
      return gateUnknown('Gate predicates need the execution journal');
    }
    const journal = deps.journal;
    if (!isNonEmptyString(attempt.briefPackagePath) || !isNonEmptyString(attempt.briefDigest)) {
      return gateUnknown(`Attempt ${id} records no frozen brief; the gate cannot be read`);
    }
    const artifactPort = deps.artifactPort;
    if (artifactPort?.readBriefFile === undefined || artifactPort.readBriefManifest === undefined) {
      return gateUnknown('No artifact port can read the frozen brief');
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
      return gateUnknown(`Unable to read the frozen brief for attempt ${id}`);
    }
    if (prose === null || manifestRaw === null) {
      return gateUnknown(`Unable to read the frozen brief for attempt ${id}`);
    }

    const digest = (deps.computeDigest ?? simpleDeterministicHexDigest)(
      prose + '\n' + manifestRaw,
    );
    if (digest !== attempt.briefDigest) {
      return gateUnknown(
        `Frozen brief digest mismatch for attempt ${id}: the brief or its manifest changed after it was prepared`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch {
      return gateUnknown(`Frozen brief manifest for attempt ${id} is not a JSON object`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return gateUnknown(`Frozen brief manifest for attempt ${id} is not a JSON object`);
    }
    const manifest = parsed as Record<string, unknown>;
    if (manifest.baseCommit !== attempt.baseCommit) {
      return gateUnknown('Frozen brief base commit does not match the attempt base commit');
    }
    const created = AcceptanceSpec.create(manifest.acceptanceSpec);
    if (!created.success || created.value === undefined) {
      return gateUnknown(
        `Frozen brief has no valid acceptance spec: ${created.error?.message ?? 'unknown error'}`,
      );
    }
    const spec = created.value;

    const rawPrefixes = manifest.allowedPathPrefixes;
    const allowedPathPrefixes =
      Array.isArray(rawPrefixes) && rawPrefixes.every((item) => typeof item === 'string')
        ? (rawPrefixes as string[])
        : [];

    const expected = expectedGatePredicates(spec);

    // The effective run is resolved before anything is run (KF-30c2): the
    // omitted run reads the highest stored run; an explicit run n >= 1 needs a
    // stored congested run n-1 and is refused without running anything else.
    const resolutionEntries = await journal.listJournalEntriesForAttempt(id);
    let effectiveRun: number;
    if (requestedRun === 'latest') {
      effectiveRun = highestStoredGateRun(resolutionEntries, id, candidateHeadSha, expected);
    } else {
      if (requestedRun >= 1) {
        const priorRun = readStoredGateOutcome(
          resolutionEntries,
          id,
          candidateHeadSha,
          expected,
          requestedRun - 1,
        );
        const priorCongested =
          priorRun.kind === 'completed' &&
          priorRun.verdict.verdict === 'unknown' &&
          priorRun.verdict.congested === true;
        if (!priorCongested) {
          return gateUnknown(
            'Unknown: gate run ' + String(requestedRun) +
              ' requires a stored congested gate run ' + String(requestedRun - 1) +
              ' for head ' + candidateHeadSha,
          );
        }
      }
      effectiveRun = requestedRun;
    }

    const gateKey =
      effectiveRun === 0
        ? `${id}:${candidateHeadSha}`
        : `${id}:${candidateHeadSha}/g${effectiveRun}`;
    let journalInFlight = inFlightGateRuns.get(journal);
    if (journalInFlight === undefined) {
      journalInFlight = new Map<string, Promise<void>>();
      inFlightGateRuns.set(journal, journalInFlight);
    }

    const existingInFlight = journalInFlight.get(gateKey);
    if (existingInFlight !== undefined) {
      await existingInFlight;
    }

    const priorEntries = await journal.listJournalEntriesForAttempt(id);
    const storedBefore = readStoredGateOutcome(priorEntries, id, candidateHeadSha, expected, effectiveRun);
    if (storedBefore.kind === 'completed') {
      return storedBefore.verdict;
    }
    if (storedBefore.kind === 'incomplete') {
      return gateUnknown(storedBefore.reason);
    }

    const isOwner = !journalInFlight.has(gateKey);
    let finishInFlight: (() => void) | undefined;
    if (isOwner) {
      const runPromise = new Promise<void>((resolve) => {
        finishInFlight = resolve;
      });
      journalInFlight.set(gateKey, runPromise);
    }

    try {
      try {
        await journal.appendJournalEntry({
          id: gateRunPrefix(id, candidateHeadSha, effectiveRun) + '0',
          attemptId: id,
          workOrderId: attempt.workOrderId,
          action: 'accept',
          baseCommit: attempt.baseCommit,
          recordedAtIso: deps.now?.() ?? new Date().toISOString(),
          sessionId: attempt.sessionId,
          status: 'intent-recorded',
          detail:
            'gate: ' +
            String(expected.length) +
            ' predicates for head ' +
            candidateHeadSha,
        });
      } catch {
        return await this.readAfterCollision(
          journal,
          journalInFlight,
          gateKey,
          isOwner,
          id,
          candidateHeadSha,
          expected,
          effectiveRun,
        );
      }

      if (!isOwner) {
        return await this.readAfterCollision(
          journal,
          journalInFlight,
          gateKey,
          isOwner,
          id,
          candidateHeadSha,
          expected,
          effectiveRun,
        );
      }

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
        try {
          await journal.appendJournalEntry({
            id: gateRunPrefix(id, candidateHeadSha, effectiveRun) + '1',
            attemptId: id,
            workOrderId: attempt.workOrderId,
            action: 'accept',
            baseCommit: attempt.baseCommit,
            recordedAtIso: deps.now?.() ?? new Date().toISOString(),
            sessionId: attempt.sessionId,
            status: 'ambiguous',
            detail: gateResult.reason,
          });
        } catch {
          return await this.readAfterCollision(
            journal,
            journalInFlight,
            gateKey,
            isOwner,
            id,
            candidateHeadSha,
            expected,
            effectiveRun,
          );
        }
        return gateUnknown('Unknown: gate predicates unavailable: ' + gateResult.reason);
      }

      const results = gateResult.results;
      if (!resultsMatchExpectedPredicates(results, expected)) {
        try {
          await journal.appendJournalEntry({
            id: gateRunPrefix(id, candidateHeadSha, effectiveRun) + '1',
            attemptId: id,
            workOrderId: attempt.workOrderId,
            action: 'accept',
            baseCommit: attempt.baseCommit,
            recordedAtIso: deps.now?.() ?? new Date().toISOString(),
            sessionId: attempt.sessionId,
            status: 'refused',
            detail: GATE_RESULTS_MISMATCH_REASON,
          });
        } catch {
          return await this.readAfterCollision(
            journal,
            journalInFlight,
            gateKey,
            isOwner,
            id,
            candidateHeadSha,
            expected,
            effectiveRun,
          );
        }
        return gateUnknown(GATE_RESULTS_MISMATCH_REASON);
      }

      const entries = results.map((result, offset) =>
        this.gateJournalEntry(deps, attempt, id, candidateHeadSha, offset + 1, result, effectiveRun),
      );
      try {
        await entries.reduce(
          (chain, entry) => chain.then(() => journal.appendJournalEntry(entry)),
          Promise.resolve(),
        );
      } catch {
        return await this.readAfterCollision(
          journal,
          journalInFlight,
          gateKey,
          isOwner,
          id,
          candidateHeadSha,
          expected,
          effectiveRun,
        );
      }

      return gateVerdictForResults(results, expected);
    } finally {
      if (isOwner) {
        journalInFlight.delete(gateKey);
        finishInFlight?.();
      }
    }
  }

  private async readAfterCollision(
    journal: Pick<ExecutionJournalPort, 'appendJournalEntry' | 'listJournalEntriesForAttempt'>,
    journalInFlight: Map<string, Promise<void>>,
    gateKey: string,
    isOwner: boolean,
    attemptId: string,
    candidateHeadSha: string,
    expected: readonly ExpectedGatePredicate[],
    gateRun: number,
  ): Promise<GateVerdict> {
    if (!isOwner) {
      const active = journalInFlight.get(gateKey);
      if (active !== undefined) {
        await active;
      }
    }
    const entries = await journal.listJournalEntriesForAttempt(attemptId);
    const stored = readStoredGateOutcome(entries, attemptId, candidateHeadSha, expected, gateRun);
    if (stored.kind === 'none') {
      return gateUnknown(
        `Unknown: gate evaluation for head ${candidateHeadSha} has an unfinished intent in the journal`,
      );
    }
    if (stored.kind === 'completed') {
      return stored.verdict;
    }
    return gateUnknown(stored.reason);
  }

  private gateJournalEntry(
    deps: RequestAttemptAcceptanceDependencies,
    attempt: AttemptRecord,
    id: string,
    candidateHeadSha: string,
    predicateIndex: number,
    result: GatePredicateResult,
    gateRun: number,
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
    if (result.cause !== undefined) {
      detailObject.cause = result.cause;
    }
    return {
      id: gateRunPrefix(id, candidateHeadSha, gateRun) + String(predicateIndex),
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
