// @generated use-case scaffold — refined for lane CO29b.
/**
 * ApplyRelaunchUseCase: apply one stored relaunch plan by digest under a
 * recorded owner grant naming that digest (cutover plan CO29, §4 steps 1–9,
 * invariants I1–I7). Order: validate the request, resolve the owner grant,
 * read and strictly validate the plan, preflight every lane non-mutating
 * (journal replay, conducted runs, attempts), then execute the steps in
 * order, reusing verified journal results so a re-run is safe. Save and adopt
 * delegate to their own keyed, journaled use cases; driver-swap, abort and
 * redispatch journal intent before action here. A lane is aborted only by
 * directory through the runner after its save is verified. It removes,
 * resets or deletes no worktree or branch. `execute` takes `unknown` and
 * never throws. Results carry ids, codes and digests only.
 */

import { containsSecretShape } from '@fleet/shared';

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { pureSha256Hex } from '../../domain/held-work-order.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import { readRecordSchemaVersion, isPlainRecordObject } from '../../domain/record-schema-version.js';
import type {
  AdoptLanePort,
  AdoptLaneResult,
} from '../ports/in/AdoptLanePort.in-port.js';
import type {
  ApplyRelaunchLaneReport,
  ApplyRelaunchPort,
  ApplyRelaunchPartialReason,
  ApplyRelaunchRefusalReason,
  ApplyRelaunchRequest,
  ApplyRelaunchResult,
  ApplyRelaunchUnknownReason,
} from '../ports/in/ApplyRelaunchPort.in-port.js';
import type { SaveLaneEditsPort, SaveLaneEditsResult } from '../ports/in/SaveLaneEditsPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { CutoverJournalEntry, CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import type {
  AbortWorktreeRunResult,
  ExecutionRunnerPort,
} from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { OwnerDecisionPort } from '../ports/out/OwnerDecisionPort.out-port.js';
import type {
  RelaunchPlanRepositoryPort,
  RelaunchPlanStepKind,
  RelaunchSaveSpec,
  RelaunchAdoptSpec,
} from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import { RELAUNCH_PLAN_SCHEMA_VERSION } from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

export interface ApplyRelaunchDependencies {
  readonly relaunchPlanRepository: RelaunchPlanRepositoryPort;
  readonly cutoverJournal: CutoverJournalPort;
  readonly ownerDecisions: OwnerDecisionPort;
  readonly laneRunRepository: LaneRunRepositoryPort;
  readonly attemptRepository: AttemptRepositoryPort;
  readonly saveLaneEdits: SaveLaneEditsPort;
  readonly adoptLane: AdoptLanePort;
  readonly runnerForAttempt: RunnerForAttemptPort;
  readonly workOrderRepository?: WorkOrderRepositoryPort;
  /** Defaults to the pure domain SHA-256 (`pureSha256Hex`). */
  readonly computeDigest?: (text: string) => string;
  /** Defaults to a monotonic ULID-shaped id. */
  readonly mintEntryId?: () => string;
  /** Defaults to the wall clock as a zoned ISO instant. */
  readonly now?: () => string;
}

const PLAN_DIGEST = /^[0-9a-f]{7,64}$/;
const GRANT_REF = /^\S{1,128}$/;
const LANE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_40_64 = /^[0-9a-f]{40,64}$/;
const SAVE_REF = /^refs\/fleet\/saved\/[A-Za-z0-9._/-]{1,120}$/;
const MAX_LANES = 256;

const REQUEST_KEYS = ['planDigest', 'ownerGrantDecisionRef', 'nowIso', 'deadlineIso'];
const PLAN_KEYS = ['schemaVersion', 'planDigest', 'createdAtIso', 'lanes'];
const CONDUCTED_KEYS = ['laneId', 'population', 'runId', 'targetReleaseTag', 'steps'];
const ADOPTABLE_KEYS = ['laneId', 'population', 'attemptId', 'steps', 'save', 'abort', 'adopt', 'targetReleaseTag'];
const ADOPTABLE_STEPS: readonly string[] = ['save', 'abort', 'adopt', 'redispatch'];
const SAVE_SPEC_KEYS = [
  'attemptId', 'worktreePath', 'clonePath', 'recordedHost', 'baseCommit',
  'allowedPathPrefixes', 'policyProtectedPaths', 'secretPatterns',
];
const ABORT_SPEC_KEYS = ['worktreePath', 'recordedHost', 'gracePeriodSeconds'];
const ADOPT_SPEC_KEYS = ['projectId', 'planRef', 'baseBranch', 'workOrder', 'brief', 'attempt', 'run', 'source'];

const refused = (reason: ApplyRelaunchRefusalReason, laneId?: string): ApplyRelaunchResult =>
  laneId === undefined ? { outcome: 'refused', reason } : { outcome: 'refused', reason, laneId };

const unknown = (reason: ApplyRelaunchUnknownReason, laneId?: string): ApplyRelaunchResult =>
  laneId === undefined ? { outcome: 'unknown', reason } : { outcome: 'unknown', reason, laneId };

function stepKey(planDigest: string, laneId: string, step: RelaunchPlanStepKind): string {
  return `relaunch/${planDigest}/${laneId}/${step}`;
}

function hasExactKeys(snap: Record<string, unknown>, allowed: readonly string[]): boolean {
  const own = Object.keys(snap);
  return own.length === allowed.length && own.every((key) => allowed.includes(key));
}

function hasOnlyKeys(snap: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(snap).every((key) => allowed.includes(key));
}

/** Every string in the value, recursively, is screened; a secret-shaped one refuses the whole record. */
function anySecretShape(value: unknown): boolean {
  if (typeof value === 'string') return containsSecretShape(value);
  if (Array.isArray(value)) return value.some(anySecretShape);
  if (isPlainRecordObject(value)) return Object.values(value).some(anySecretShape);
  return false;
}

/** A dense array of at most `max` items; a hole or an over-sized list is a null. */
function denseArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
  }
  return [...value];
}

/** The replay-verified save facts of a completed save result; a null refuses the replay. */
interface SaveReplayFacts {
  readonly saveRef: string;
  readonly commitId: string;
  readonly digest: string;
}

function saveReplayFacts(final: CutoverJournalEntry): SaveReplayFacts | null {
  const { saveRef, commitId, digest } = final;
  if (
    typeof saveRef !== 'string' || !SAVE_REF.test(saveRef) ||
    saveRef.includes('..') || saveRef.includes('//') || saveRef.endsWith('/') || saveRef.endsWith('.lock') ||
    typeof commitId !== 'string' || !HEX_40_64.test(commitId) ||
    typeof digest !== 'string' || !HEX_40_64.test(digest)
  ) {
    return null;
  }
  return { saveRef, commitId, digest };
}

/** The one final result of a keyed journal history; ambiguous entries never satisfy it. */
function finalResultOf(entries: readonly CutoverJournalEntry[]): CutoverJournalEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === 'result' && entry.outcome !== undefined && entry.outcome !== 'ambiguous') {
      return entry;
    }
  }
  return null;
}

function intentOf(entries: readonly CutoverJournalEntry[]): CutoverJournalEntry | null {
  return entries.find((entry) => entry.kind === 'intent') ?? null;
}

interface JournalHistory {
  readonly byKey: ReadonlyMap<string, readonly CutoverJournalEntry[]>;
}

interface LanePlanView {
  readonly laneId: string;
  readonly population: 'conducted' | 'attempt-recorded' | 'unrecorded';
  readonly runId?: string;
  readonly attemptId?: string | null;
  readonly targetReleaseTag?: string;
  readonly steps: readonly RelaunchPlanStepKind[];
  readonly save?: Record<string, unknown>;
  readonly abort?: Record<string, unknown>;
  readonly adopt?: Record<string, unknown>;
}

function isConductedView(lane: LanePlanView): lane is LanePlanView & { runId: string; targetReleaseTag: string } {
  return lane.population === 'conducted';
}

/** Crockford base32 for ULID-shaped entry ids. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(value: bigint, chars: number): string {
  let out = '';
  for (let index = 0; index < chars; index += 1) {
    out = BASE32[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
}

/** A monotonic, ULID-shaped entry id: 10 time chars then 16 counter chars. */
function defaultMintEntryId(): () => string {
  let counter = 0;
  let previous = -1;
  return () => {
    const nowMs = Date.now();
    if (nowMs !== previous) {
      previous = nowMs;
      counter = 0;
    }
    counter += 1;
    // Time is below 2^41, so the leading char stays within the store's 0–7 shape.
    return base32(BigInt(nowMs), 10) + base32(BigInt(counter), 16);
  };
}

export class ApplyRelaunchUseCase implements ApplyRelaunchPort {
  private readonly computeDigest: (text: string) => string;
  private readonly mintEntryId: () => string;

  constructor(private readonly deps: ApplyRelaunchDependencies) {
    this.computeDigest = deps.computeDigest ?? pureSha256Hex;
    this.mintEntryId = deps.mintEntryId ?? defaultMintEntryId();
  }

  async execute(input: unknown): Promise<ApplyRelaunchResult> {
    return this.applyRelaunch(input as ApplyRelaunchRequest);
  }

  async applyRelaunch(request: ApplyRelaunchRequest): Promise<ApplyRelaunchResult> {
    try {
      return await this.apply(request);
    } catch {
      return unknown('apply-unknown');
    }
  }

  private async apply(request: ApplyRelaunchRequest): Promise<ApplyRelaunchResult> {
    // 1. Request validation.
    const requestSnap = snapshotPlainDataRecord(request);
    if (requestSnap === null || !hasOnlyKeys(requestSnap, REQUEST_KEYS)) {
      return refused('invalid-request');
    }
    const {
      planDigest, ownerGrantDecisionRef, nowIso, deadlineIso,
    } = requestSnap as Record<string, unknown> as {
      planDigest: unknown;
      ownerGrantDecisionRef: unknown;
      nowIso: unknown;
      deadlineIso?: unknown;
    };
    if (
      typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest) ||
      typeof ownerGrantDecisionRef !== 'string' || !GRANT_REF.test(ownerGrantDecisionRef) ||
      !isZonedIsoDateTime(nowIso) ||
      !(deadlineIso === undefined || isZonedIsoDateTime(deadlineIso))
    ) {
      return refused('invalid-request');
    }
    if (anySecretShape(requestSnap)) return refused('secret-detected');
    if (this.deadlineExceeded(deadlineIso as string | undefined, nowIso as string)) {
      return unknown('deadline-exceeded');
    }

    // 2. Owner grant check.
    let grant;
    try {
      grant = await this.deps.ownerDecisions.resolveOwnerDecision({
        decisionReference: ownerGrantDecisionRef,
        candidateHeadSha: planDigest,
      });
    } catch {
      return unknown('owner-grant-unknown');
    }
    if (grant.outcome === 'not-approved') return refused('owner-grant-not-approved');
    if (grant.outcome === 'unknown') return unknown('owner-grant-unknown');

    // 3. Plan read and strict validation.
    let planRead;
    try {
      planRead = await this.deps.relaunchPlanRepository.readByDigest(planDigest);
    } catch {
      return unknown('plan-store-unreadable');
    }
    if (planRead.status === 'missing') return refused('plan-missing');
    if (planRead.status === 'unreadable') return unknown('plan-store-unreadable');
    if (planRead.status === 'unknown-version') return unknown('plan-unknown-version');

    const planSnap = snapshotPlainDataRecord(planRead.plan);
    if (planSnap === null || !hasExactKeys(planSnap, PLAN_KEYS)) return refused('plan-malformed');
    // A present but non-numeric version is malformed, never an unknown version.
    const snapVersion = planSnap.schemaVersion;
    if (snapVersion !== undefined && typeof snapVersion !== 'number') return refused('plan-malformed');
    const versionRead = readRecordSchemaVersion(planRead.plan, RELAUNCH_PLAN_SCHEMA_VERSION);
    if (!versionRead.ok) {
      return versionRead.reason === 'unknown-schema-version'
        ? unknown('plan-unknown-version')
        : refused('plan-malformed');
    }
    if (!versionRead.explicit) return refused('plan-malformed');
    const plan = planSnap as unknown as {
      planDigest: unknown;
      createdAtIso: unknown;
      lanes: unknown;
    };
    if (
      plan.planDigest !== planDigest ||
      !isZonedIsoDateTime(plan.createdAtIso)
    ) {
      return plan.planDigest === planDigest ? refused('plan-malformed') : refused('plan-digest-mismatch');
    }
    const lanesRaw = denseArray(plan.lanes, MAX_LANES);
    if (lanesRaw === null || lanesRaw.length < 1) return refused('plan-malformed');
    if (anySecretShape(planSnap)) return refused('secret-detected');

    const lanes: LanePlanView[] = [];
    for (const laneRaw of lanesRaw) {
      const laneSnap = snapshotPlainDataRecord(laneRaw);
      if (laneSnap === null) return refused('plan-malformed');
      const view = this.validateLane(laneSnap);
      if (view === null) {
        const laneId = (laneSnap as { laneId?: unknown }).laneId;
        return refused('plan-malformed', typeof laneId === 'string' ? laneId : undefined);
      }
      if (anySecretShape(laneSnap)) return refused('secret-detected');
      lanes.push(view);
    }

    // 4. Non-mutating preflight across every lane.
    const prefix = `relaunch/${planDigest}/`;
    const history = await this.listJournal(prefix);
    if (history === null) return unknown('cutover-journal-unreadable');

    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index];
      const laneRefusal = await this.preflightLane(planDigest, lane, history);
      if (laneRefusal !== null) return laneRefusal;
    }

    // 5. Step execution.
    return this.executeLanes(planDigest, deadlineIso as string | undefined, nowIso as string, lanes, history);
  }

  /** The start clock against the deadline; an unreadable clock is over the deadline. */
  private deadlineExceeded(deadlineIso: string | undefined, fallbackIso: string): boolean {
    if (deadlineIso === undefined) return false;
    const currentMs = Date.parse(this.deps.now?.() ?? fallbackIso);
    if (Number.isNaN(currentMs)) return true;
    const deadlineMs = Date.parse(deadlineIso);
    if (Number.isNaN(deadlineMs)) return true;
    return currentMs >= deadlineMs;
  }

  private async listJournal(prefix: string): Promise<JournalHistory | null> {
    try {
      const listed = await this.deps.cutoverJournal.listByKeyPrefix(prefix);
      if (listed.outcome !== 'listed') return null;
      const byKey = new Map<string, CutoverJournalEntry[]>();
      for (const entry of listed.entries) {
        const own = byKey.get(entry.key);
        if (own === undefined) byKey.set(entry.key, [entry]);
        else own.push(entry);
      }
      return { byKey };
    } catch {
      return null;
    }
  }

  private validateLane(laneSnap: Record<string, unknown>): LanePlanView | null {
    const { population, steps } = laneSnap as { population?: unknown; steps?: unknown };
    if (population !== 'conducted' && population !== 'attempt-recorded' && population !== 'unrecorded') {
      return null;
    }
    const conducted = population === 'conducted';
    if (!hasExactKeys(laneSnap, conducted ? CONDUCTED_KEYS : ADOPTABLE_KEYS)) {
      // An adoptable lane may omit the optional specs; only the key set matters.
      if (conducted || !hasOnlyKeys(laneSnap, ADOPTABLE_KEYS)) return null;
    }
    const { laneId } = laneSnap as { laneId?: unknown };
    if (typeof laneId !== 'string' || !LANE_ID.test(laneId)) return null;
    const stepList = denseArray(steps, 5);
    if (stepList === null || stepList.length === 0) return null;
    if (conducted) {
      if (stepList.length !== 1 || stepList[0] !== 'driver-swap') return null;
      const { runId, targetReleaseTag } = laneSnap as { runId?: unknown; targetReleaseTag?: unknown };
      if (typeof runId !== 'string' || !LANE_ID.test(runId) || runId !== laneId) return null;
      if (typeof targetReleaseTag !== 'string' || targetReleaseTag === '') return null;
    } else {
      for (const step of stepList) {
        if (typeof step !== 'string' || !ADOPTABLE_STEPS.includes(step)) return null;
      }
      const { attemptId, save, abort, adopt } = laneSnap as {
        attemptId?: unknown;
        save?: unknown;
        abort?: unknown;
        adopt?: unknown;
      };
      if (!(attemptId === null || (typeof attemptId === 'string' && attemptId !== ''))) return null;
      const specs: [unknown, readonly string[]][] = [
        [save, SAVE_SPEC_KEYS],
        [abort, ABORT_SPEC_KEYS],
        [adopt, ADOPT_SPEC_KEYS],
      ];
      for (const [spec, allowed] of specs) {
        if (spec === undefined) continue;
        const specSnap = snapshotPlainDataRecord(spec);
        if (specSnap === null || !hasOnlyKeys(specSnap, allowed)) return null;
      }
    }
    return {
      laneId,
      population,
      ...(conducted
        ? { runId: laneSnap.runId as string, targetReleaseTag: laneSnap.targetReleaseTag as string }
        : {
            attemptId: (laneSnap.attemptId ?? null) as string | null,
            ...(laneSnap.targetReleaseTag !== undefined
              ? { targetReleaseTag: laneSnap.targetReleaseTag as string }
              : {}),
          }),
      steps: stepList as RelaunchPlanStepKind[],
      ...(laneSnap.save !== undefined ? { save: laneSnap.save as Record<string, unknown> } : {}),
      ...(laneSnap.abort !== undefined ? { abort: laneSnap.abort as Record<string, unknown> } : {}),
      ...(laneSnap.adopt !== undefined ? { adopt: laneSnap.adopt as Record<string, unknown> } : {}),
    };
  }

  /** The request digest an intent must carry for its step's replay to be trusted. */
  private requestDigest(planDigest: string, lane: LanePlanView, step: RelaunchPlanStepKind): string {
    const payload: unknown[] = [planDigest, lane.laneId, step];
    if (step === 'save') payload.push(lane.save ?? null);
    if (step === 'abort') payload.push(lane.abort ?? null);
    if (step === 'adopt') payload.push(lane.adopt ?? null);
    if (step === 'driver-swap') payload.push(isConductedView(lane) ? lane.runId : null);
    return this.computeDigest(JSON.stringify(payload));
  }

  private async preflightLane(
    planDigest: string,
    lane: LanePlanView,
    history: JournalHistory,
  ): Promise<ApplyRelaunchResult | null> {
    for (const step of lane.steps) {
      const entries = history.byKey.get(stepKey(planDigest, lane.laneId, step)) ?? [];
      const final = finalResultOf(entries);
      if (final !== null && final.outcome === 'refused') {
        return refused('idempotency-conflict', lane.laneId);
      }
      const intent = intentOf(entries);
      if (intent !== null && intent.digest != null && intent.digest !== this.requestDigest(planDigest, lane, step)) {
        return refused('idempotency-conflict', lane.laneId);
      }
      if (step === 'save' && final !== null && final.outcome === 'completed' && saveReplayFacts(final) === null) {
        return refused('idempotency-conflict', lane.laneId);
      }
      if (
        step === 'save' && final === null && intent !== null &&
        entries.some((entry) => entry.kind === 'result' && entry.outcome === 'ambiguous')
      ) {
        return refused('idempotency-conflict', lane.laneId);
      }
    }
    if (isConductedView(lane)) {
      const guard = await this.preflightConducted(planDigest, lane, history);
      if (guard !== null) return guard;
    } else if (lane.attemptId != null) {
      try {
        const attempt = await this.deps.attemptRepository.findAttemptById(lane.attemptId);
        if (attempt === null) return refused('attempt-missing', lane.laneId);
      } catch {
        return unknown('attempt-store-unavailable', lane.laneId);
      }
    }
    return null;
  }

  private async preflightConducted(
    planDigest: string,
    lane: LanePlanView & { runId: string },
    history: JournalHistory,
  ): Promise<ApplyRelaunchResult | null> {
    let run: Record<string, unknown> | null;
    try {
      run = (await this.deps.laneRunRepository.get(lane.runId)) as Record<string, unknown> | null;
    } catch {
      return unknown('lane-run-store-unavailable', lane.laneId);
    }
    if (run === null || run.runId !== lane.runId) return refused('conducted-run-missing', lane.laneId);
    const runLaneId = (run as { laneId?: unknown }).laneId;
    let workOrder: Record<string, unknown> | null = null;
    if (typeof runLaneId === 'string' && runLaneId !== lane.laneId) {
      return refused('conducted-run-missing', lane.laneId);
    }
    if (this.deps.workOrderRepository !== undefined) {
      try {
        workOrder = (await this.deps.workOrderRepository.findWorkOrderById(run.workOrderId as string)) as
          | Record<string, unknown>
          | null;
      } catch {
        return unknown('lane-run-store-unavailable', lane.laneId);
      }
      if (workOrder !== null && (workOrder as { laneId?: unknown }).laneId !== lane.laneId) {
        return refused('conducted-run-missing', lane.laneId);
      }
    }
    const states = [
      (run as { state?: unknown }).state,
      workOrder === null ? undefined : (workOrder as { state?: unknown }).state,
    ];
    const terminal = states.some((state) => state === 'stopped' || state === 'merged');
    if (terminal) {
      const swapEntries = history.byKey.get(stepKey(planDigest, lane.laneId, 'driver-swap')) ?? [];
      const swapFinal = finalResultOf(swapEntries);
      if (swapFinal === null || swapFinal.outcome !== 'completed') {
        return refused('conducted-run-terminal', lane.laneId);
      }
    }
    return null;
  }

  private async executeLanes(
    planDigest: string,
    deadlineIso: string | undefined,
    requestNowIso: string,
    lanes: readonly LanePlanView[],
    history: JournalHistory,
  ): Promise<ApplyRelaunchResult> {
    const reports: ApplyRelaunchLaneReport[] = [];
    let allReused = true;

    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index];
      const outcome = await this.executeLane(planDigest, deadlineIso, requestNowIso, lane, history);
      if (outcome.kind === 'report') {
        allReused = allReused && outcome.reused;
        reports.push(outcome.report);
        continue;
      }
      // A halt: lanes before this one are done, this one is halted, the rest stay pending.
      for (let ahead = index + 1; ahead < lanes.length; ahead += 1) {
        const pending = lanes[ahead];
        reports.push({
          laneId: pending.laneId,
          population: pending.population,
          status: 'pending',
          completedSteps: [],
          pendingSteps: [...pending.steps],
        });
      }
      if (outcome.kind === 'refused') return refused(outcome.reason, outcome.laneId);
      if (outcome.kind === 'unknown') return unknown(outcome.reason, outcome.laneId);
      return {
        outcome: 'partial',
        planDigest,
        reason: outcome.reason,
        stoppedLaneId: outcome.stoppedLaneId,
        stoppedStep: outcome.stoppedStep,
        lanes: [
          ...reports,
          {
            laneId: outcome.stoppedLaneId,
            population: outcome.population,
            status: 'halted',
            completedSteps: outcome.completedSteps,
            pendingSteps: outcome.pendingSteps,
            stoppedAtStep: outcome.stoppedStep,
            reason: outcome.reason,
            ...(outcome.saveRef !== undefined ? { saveRef: outcome.saveRef } : {}),
            ...(outcome.commitId !== undefined ? { commitId: outcome.commitId } : {}),
          },
        ],
      };
    }
    return { outcome: 'applied', planDigest, reused: allReused, lanes: reports };
  }

  private async executeLane(
    planDigest: string,
    deadlineIso: string | undefined,
    requestNowIso: string,
    lane: LanePlanView,
    history: JournalHistory,
  ): Promise<
    | { kind: 'report'; reused: boolean; report: ApplyRelaunchLaneReport }
    | {
        kind: 'refused';
        reason: ApplyRelaunchRefusalReason;
        laneId: string;
      }
    | { kind: 'unknown'; reason: ApplyRelaunchUnknownReason; laneId: string }
    | {
        kind: 'partial';
        reason: ApplyRelaunchPartialReason;
        stoppedLaneId: string;
        stoppedStep: RelaunchPlanStepKind;
        population: LanePlanView['population'];
        completedSteps: readonly RelaunchPlanStepKind[];
        pendingSteps: readonly RelaunchPlanStepKind[];
        saveRef?: string;
        commitId?: string;
      }
  > {
    const completedSteps: RelaunchPlanStepKind[] = [];
    let reusedAll = true;
    let savedFacts: SaveReplayFacts | null = null;

    for (let position = 0; position < lane.steps.length; position += 1) {
      const step = lane.steps[position];
      const pendingSteps = lane.steps.slice(position + 1);
      if (this.deadlineExceeded(deadlineIso, requestNowIso)) {
        return {
          kind: 'partial',
          reason: 'deadline-exceeded',
          stoppedLaneId: lane.laneId,
          stoppedStep: step,
          population: lane.population,
          completedSteps: [...completedSteps],
          pendingSteps,
          ...(savedFacts === null ? {} : { saveRef: savedFacts.saveRef, commitId: savedFacts.commitId }),
        };
      }
      const key = stepKey(planDigest, lane.laneId, step);
      const entries = history.byKey.get(key) ?? [];
      const final = finalResultOf(entries);

      // A verified completed result is reused as recorded; nothing runs again.
      if (final !== null && final.outcome === 'completed') {
        const facts = step === 'save' ? saveReplayFacts(final) : null;
        if (step !== 'save' || facts !== null) {
          if (step === 'save') savedFacts = facts;
          completedSteps.push(step);
          continue;
        }
        return this.haltOf(lane, step, pendingSteps, completedSteps, { reason: 'step-failed' }, savedFacts);
      }

      reusedAll = false;

      if (step === 'save') {
        const halt = await this.runSave(planDigest, lane);
        if (halt === null) continue;
        if (!('reason' in halt)) {
          savedFacts = halt;
          completedSteps.push(step);
          continue;
        }
        return this.haltOf(lane, step, pendingSteps, completedSteps, halt, savedFacts);
      }
      if (step === 'adopt') {
        const halt = await this.runAdopt(planDigest, deadlineIso, lane);
        if (halt === null) {
          completedSteps.push(step);
          continue;
        }
        return this.haltOf(lane, step, pendingSteps, completedSteps, halt, savedFacts);
      }
      // driver-swap, abort and redispatch journal here, with intent before action.
      // A step with an intent but no result is reconciled read-only, never repeated.
      if (intentOf(entries) !== null && final === null) {
        return this.haltOf(lane, step, pendingSteps, completedSteps, { reason: 'step-failed' }, savedFacts);
      }
      if (step === 'abort') {
        const halt = await this.runAbort(planDigest, lane, savedFacts, key);
        if (halt === null) {
          completedSteps.push(step);
          continue;
        }
        return this.haltOf(lane, step, pendingSteps, completedSteps, halt, savedFacts);
      }
      const appended = await this.appendJournal(key, 'intent', this.requestDigest(planDigest, lane, step), {});
      if (appended !== 'appended') {
        return this.haltOf(lane, step, pendingSteps, completedSteps, { reason: 'journal-write-failed' }, savedFacts);
      }
      const recorded = await this.appendJournal(key, 'completed', null, {
        reasonCode: step === 'driver-swap' ? 'driver-swapped' : 'redispatch-conductor',
      });
      if (recorded !== 'appended') {
        return this.haltOf(lane, step, pendingSteps, completedSteps, { reason: 'journal-write-failed' }, savedFacts);
      }
      completedSteps.push(step);
    }
    return {
      kind: 'report',
      reused: reusedAll,
      report: {
        laneId: lane.laneId,
        population: lane.population,
        status: reusedAll ? 'reused' : 'completed',
        completedSteps: [...completedSteps],
        pendingSteps: [],
        ...(savedFacts === null ? {} : { saveRef: savedFacts.saveRef, commitId: savedFacts.commitId }),
      },
    };
  }

  private haltOf(
    lane: LanePlanView,
    step: RelaunchPlanStepKind,
    pendingSteps: readonly RelaunchPlanStepKind[],
    completedSteps: readonly RelaunchPlanStepKind[],
    halt: { reason: ApplyRelaunchPartialReason },
    savedFacts: SaveReplayFacts | null,
  ) {
    return {
      kind: 'partial' as const,
      reason: halt.reason,
      stoppedLaneId: lane.laneId,
      stoppedStep: step,
      population: lane.population,
      completedSteps: [...completedSteps],
      pendingSteps: [...pendingSteps],
      ...(savedFacts === null ? {} : { saveRef: savedFacts.saveRef, commitId: savedFacts.commitId }),
    };
  }

  /** Delegate the save to CO27's journaled use case; a null means the lane is done. */
  private async runSave(
    planDigest: string,
    lane: LanePlanView,
  ): Promise<{ reason: ApplyRelaunchPartialReason } | { saveRef: string; commitId: string; digest: string } | null> {
    if (lane.save === undefined) return { reason: 'step-failed' };
    let result: SaveLaneEditsResult;
    try {
      const spec = lane.save as unknown as RelaunchSaveSpec;
      result = await this.deps.saveLaneEdits.saveLaneEdits({
        ...spec,
        planDigest,
        laneId: lane.laneId,
        nowIso: this.nowIso(),
      });
    } catch {
      return { reason: 'save-unknown' };
    }
    if (result.outcome === 'saved' || result.outcome === 'already-saved') {
      return { saveRef: result.saveRef, commitId: result.commitId, digest: result.treeDigest };
    }
    if (result.outcome === 'refused') return { reason: 'save-refused' };
    return { reason: 'save-unknown' };
  }

  /** Delegate the adopt to CO28's journaled use case; a null means the step is done. */
  private async runAdopt(
    planDigest: string,
    deadlineIso: string | undefined,
    lane: LanePlanView,
  ): Promise<{ reason: ApplyRelaunchPartialReason } | null> {
    if (lane.adopt === undefined) return { reason: 'step-failed' };
    let result: AdoptLaneResult;
    try {
      const spec = lane.adopt as unknown as RelaunchAdoptSpec;
      result = await this.deps.adoptLane.adoptLane({
        ...spec,
        planDigest,
        laneId: lane.laneId,
        nowIso: this.nowIso(),
        ...(deadlineIso === undefined ? {} : { deadlineIso }),
      });
    } catch {
      return { reason: 'adopt-unknown' };
    }
    if (result.outcome === 'adopted') return null;
    if (result.outcome === 'budget-exhausted') return { reason: 'adopt-budget-exhausted' };
    if (result.outcome === 'refused') return { reason: 'adopt-refused' };
    return { reason: 'adopt-unknown' };
  }

  /** Abort by directory through the runner, only after a verified save. */
  private async runAbort(
    planDigest: string,
    lane: LanePlanView,
    savedFacts: SaveReplayFacts | null,
    key: string,
  ): Promise<{ reason: ApplyRelaunchPartialReason } | null> {
    if (lane.abort === undefined) return { reason: 'step-failed' };
    if (savedFacts === null) return { reason: 'abort-without-save' };
    const spec = lane.abort as unknown as {
      worktreePath?: unknown;
      recordedHost?: unknown;
      gracePeriodSeconds?: unknown;
    };
    const recordedHost = (spec.recordedHost ?? null) as AttemptRunnerRecord | null;
    let resolved: ExecutionRunnerPort | null = null;
    try {
      const resolution = this.deps.runnerForAttempt.runnerForAttempt({ runner: recordedHost });
      resolved = resolution.ok ? resolution.runner : null;
    } catch {
      resolved = null;
    }
    if (resolved === null || resolved.abortWorktreeRun === undefined) {
      return { reason: 'abort-runner-unavailable' };
    }
    const intentDigest = this.requestDigest(planDigest, lane, 'abort');
    const appended = await this.appendJournal(key, 'intent', intentDigest, {});
    if (appended !== 'appended') return { reason: 'journal-write-failed' };

    let result: AbortWorktreeRunResult;
    try {
      result = await resolved.abortWorktreeRun({
        attemptId: lane.attemptId ?? lane.laneId,
        worktreePath: spec.worktreePath as string,
        runner: recordedHost,
        gracePeriodSeconds: typeof spec.gracePeriodSeconds === 'number' ? spec.gracePeriodSeconds : 0,
      });
    } catch {
      result = { outcome: 'unknown', reason: 'abort-threw' };
    }
    if (result.outcome === 'aborted') {
      const recorded = await this.appendJournal(key, 'completed', intentDigest, {
        reasonCode: 'aborted',
        commitId: savedFacts.commitId,
        saveRef: savedFacts.saveRef,
        digest: savedFacts.digest,
      });
      return recorded === 'appended' ? null : { reason: 'journal-write-failed' };
    }
    if (result.outcome === 'refused') {
      await this.appendJournal(key, 'refused', intentDigest, { reasonCode: 'abort-refused' });
      return { reason: 'abort-failed' };
    }
    await this.appendJournal(key, 'ambiguous', intentDigest, { reasonCode: `abort-${result.outcome}` });
    return { reason: 'abort-not-idle' };
  }

  private nowIso(): string {
    const now = this.deps.now;
    if (now !== undefined) return now();
    return new Date().toISOString();
  }

  /**
   * Append one journal entry; `'refused'` for a store refusal, `'unavailable'`
   * for a throw — the caller turns either into a typed partial result.
   */
  private async appendJournal(
    key: string,
    outcome: 'intent' | 'completed' | 'refused' | 'ambiguous',
    digest: string | null,
    fields: { reasonCode?: string; commitId?: string; saveRef?: string; digest?: string },
  ): Promise<'appended' | 'refused' | 'unavailable'> {
    try {
      const result = await this.deps.cutoverJournal.append({
        key,
        kind: outcome === 'intent' ? 'intent' : 'result',
        entryId: this.mintEntryId(),
        recordedAtIso: this.nowIso(),
        digest: fields.digest !== undefined ? fields.digest : digest,
        ...(outcome === 'intent' ? {} : { outcome }),
        ...(fields.reasonCode === undefined ? {} : { reasonCode: fields.reasonCode }),
        ...(fields.commitId === undefined ? {} : { commitId: fields.commitId }),
        ...(fields.saveRef === undefined ? {} : { saveRef: fields.saveRef }),
      });
      return result.outcome === 'appended' ? 'appended' : 'refused';
    } catch {
      return 'unavailable';
    }
  }
}
