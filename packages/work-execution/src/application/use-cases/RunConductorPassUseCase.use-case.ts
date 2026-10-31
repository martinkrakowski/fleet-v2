/**
 * RunConductorPassUseCase: one driver pass of the conductor (plan §3.1), with
 * no timer and no I/O of its own. A pass takes or renews the state directory's
 * driver lease through a serialised `ConductorDriverLeaseKeeper`, reads the
 * halt marker, and for each non-terminal run takes or renews its run lease,
 * applies a recorded resume (K7-3), then calls `advanceLaneRun` until the run
 * waits, parks, ends or refuses, at most eight steps. Each run's turn runs
 * through one method (`advanceRun`) that never returns from the pass: a
 * per-step driver loss or an invalid clock ends that run's steps and reports
 * the stop, and the pass returns the same refusal as before. Before each step
 * the keeper renews the driver lease with a fresh time, so a pass never
 * outlives its lease window and a renewal never shortens the lease; the run's
 * lease renewal stays per run. The CLI loops over passes with back-off;
 * `releaseLeases` releases every lease the holder holds on shutdown. Time
 * enters through the `now` clock (real time in production, a fake in tests);
 * ids come from the caller.
 */

import { isConductorHalted, isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import type { LeaseAcquireRequest, LeaseRenewRequest } from '../../domain/lane-run-lease.js';
import type { LaneRunLeaseRecord, LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { AdvanceLaneRunPort, AdvanceLaneRunResult } from '../ports/in/AdvanceLaneRunPort.in-port.js';
import type { ResumeLaneRunPort } from '../ports/in/ResumeLaneRunPort.in-port.js';
import { SessionStartSpacing } from './advance-lane-run/session-start-gate.js';
import { parseLaneRunKey } from '../../domain/lane-run-keys.js';
import {
  CONDUCTOR_LEASE_MS,
  CONDUCTOR_MAX_STEPS_PER_RUN,
} from '../ports/in/RunConductorPassPort.in-port.js';
import type {
  ConductorAttentionItem,
  ConductorRunReport,
  RunConductorPassPort,
  RunConductorPassRequest,
  RunConductorPassResult,
} from '../ports/in/RunConductorPassPort.in-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import { ConductorDriverLeaseKeeper, holdConductorLease } from './conductor-driver-lease-keeper.js';

export interface RunConductorPassDependencies {
  readonly driverLease: ConductorDriverLeasePort;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list' | 'acquireLease' | 'renewLease' | 'releaseLease'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly resume: Pick<ResumeLaneRunPort, 'applyPendingResume'>;
  readonly advance: AdvanceLaneRunPort;
  /**
   * The pass clock, read fresh before each step; production passes real time,
   * tests a fake. When absent the system clock supplies the time.
   */
  readonly now?: () => string;
  /**
   * The pass sleep, awaited by the session-start gate between a denied start
   * and the run's reserved turn; production passes real time, tests a fake.
   * When absent a `setTimeout` promise supplies the wait.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to space lane session starts through the start gate, in ms. */
  readonly dispatchStaggerMs?: number;
  /**
   * KF-34b: how many live runs one pass advances concurrently. The workers
   * share one start gate, one driver-lease keeper and one latched stop, and
   * take live runs from one queue in list order. Default 1: the serial pass
   * this class has always been; nothing changes until an operator opts in.
   */
  readonly passConcurrency?: number;
}

const DEFAULT_DISPATCH_STAGGER_MS = 20_000;

const ID_MAX_BYTES = 256;

/** The production sleep: a `setTimeout` promise. Tests inject a fake instead. */
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A non-empty id of at most 256 bytes: the driver holder rule. */
function isValidHolderId(value: string): boolean {
  return value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= ID_MAX_BYTES;
}

/** `nowIso` advanced by the driver lease window, normalised. */
function leaseUntilIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) + CONDUCTOR_LEASE_MS).toISOString();
}


/** One run's turn: its report, its attention items, and the stop that ended the pass, if any. */
type RunOutcome = {
  readonly report: ConductorRunReport;
  readonly attention: ConductorAttentionItem[];
  readonly stop: null | 'driver-lease-held' | 'driver-lease-refused' | 'invalid-request';
};

/** The per-pass context `advanceRun` shares with the run loop. */
interface AdvanceRunContext {
  readonly request: RunConductorPassRequest;
  readonly halted: boolean;
  readonly startGate: SessionStartSpacing;
  readonly driverKeeper: ConductorDriverLeaseKeeper;
  /** The pass-start now: reused for the first live run's first lease decision. */
  readonly passNowIso: string;
  /**
   * KF-34b: the pass's one latched stop. A worker sets it on a driver-lease
   * loss, an invalid clock or its own rejection; once set, no worker starts
   * another step. A step already in flight finishes and is reported.
   */
  readonly control: PassControl;
}

/** The shared latched stop of one pass's worker pool (KF-34b). */
interface PassControl {
  /** Latch the stop; later calls keep the first latch. */
  readonly stop: () => void;
  /** True once any worker latched the stop. */
  readonly isStopped: () => boolean;
  /** Record a per-step halt read, so the pass reports a halt it acted under. */
  readonly noteHalt: (halted: boolean) => void;
  /** True when any per-step halt read in this pass saw the marker set. */
  readonly sawHalted: () => boolean;
}

export class RunConductorPassUseCase implements RunConductorPassPort {
  constructor(private readonly deps: RunConductorPassDependencies) {}

  async runPass(request: RunConductorPassRequest): Promise<RunConductorPassResult> {
    if (!isValidHolderId(request.holderId)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // Taking the driver lease at the start of the pass goes through the keeper.
    const driverKeeper = new ConductorDriverLeaseKeeper({
      driverLease: this.deps.driverLease,
      holderId: request.holderId,
      now: () => this.nowIso(),
    });
    const initial = await driverKeeper.renew();
    if (initial.outcome === 'invalid-clock') {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (initial.outcome === 'lost') {
      return { outcome: 'refused', reason: initial.reason };
    }
    const passNowIso = initial.nowIso;

    const halted = isConductorHalted(await this.deps.halt.read());

    const runs = await this.deps.runRepo.list();
    // Each run's journal read is independent, so the filtering reads run in parallel.
    // The entries are kept: the start gate's seed reads the latest session-start
    // intent from them, so the journals are never read twice.
    const journalEntriesByRun = new Map<string, Awaited<ReturnType<LaneRunJournalPort['listForRun']>>>();
    const liveRuns = (
      await Promise.all(
        runs.map(async (record) => {
          const entries = await this.deps.runJournal.listForRun(record.runId);
          journalEntriesByRun.set(record.runId, entries);
          const state = laneRunJournalState(entries, record.runId);
          return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state) ? null : record;
        }),
      )
    ).filter((record): record is LaneRunRecord => record !== null);

    // One gate per pass, seeded with the latest recorded session start among the
    // dispatch, brief-check and code-review intents the filtering reads already
    // carried: a start is spaced from one the previous pass or process made.
    // An unparseable recordedAtIso is skipped, so it never seeds the gate (not
    // even with the pass time): the gate starts unseeded, as before KF-34a2.
    let lastStartMs: number | null = null;
    let lastStartIso: string | null = null;
    for (const entries of journalEntriesByRun.values()) {
      for (const entry of entries) {
        if (entry.kind !== 'intent' || entry.key === null) {
          continue;
        }
        const parsed = parseLaneRunKey(entry.key);
        if (
          parsed !== null &&
          parsed.kind === 'step' &&
          (parsed.step === 'dispatch' || parsed.step === 'brief-check' || parsed.step === 'code-review')
        ) {
          const recordedMs = Date.parse(entry.recordedAtIso);
          if (!Number.isNaN(recordedMs) && (lastStartMs === null || recordedMs > lastStartMs)) {
            lastStartMs = recordedMs;
            lastStartIso = entry.recordedAtIso;
          }
        }
      }
    }
    // Clamp the seed to this pass's now: a start recorded in the future (clock
    // stepped back, skewed process) makes the first wait at most dispatchStaggerMs.
    const seedIso =
      lastStartIso === null || lastStartMs === null || lastStartMs <= Date.parse(passNowIso)
        ? lastStartIso
        : passNowIso;
    const startGate = new SessionStartSpacing(
      this.deps.dispatchStaggerMs ?? DEFAULT_DISPATCH_STAGGER_MS,
      seedIso,
    );

    const reports: ConductorRunReport[] = [];
    const attention: ConductorAttentionItem[] = [];

    let stopped = false;
    let haltedSeen = halted;
    const control: PassControl = {
      stop: (): void => {
        stopped = true;
      },
      isStopped: (): boolean => stopped,
      noteHalt: (stepHalted: boolean): void => {
        if (stepHalted) {
          haltedSeen = true;
        }
      },
      sawHalted: (): boolean => haltedSeen,
    };
    const ctx: AdvanceRunContext = { request, halted, startGate, driverKeeper, passNowIso, control };

    // KF-34b: the pass's worker pool. `passConcurrency` workers (default 1, the
    // serial pass) take live runs from one queue in list order; each runs
    // `advanceRun` for one run at a time. They share the pass's one start
    // gate, one driver-lease keeper and one latched stop.
    const passConcurrency = Math.max(1, Math.trunc(this.deps.passConcurrency ?? 1));
    const outcomes: (RunOutcome | undefined)[] = new Array(liveRuns.length).fill(undefined);
    let rejection: { readonly error: unknown } | null = null;
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (control.isStopped()) {
          return;
        }
        const index = nextIndex;
        if (index >= liveRuns.length) {
          return;
        }
        nextIndex += 1;
        let outcome: RunOutcome;
        try {
          outcome = await this.advanceRun(liveRuns[index]!, { ...ctx, isFirstRun: index === 0, control });
        } catch (error) {
          // A worker's rejection latches the stop so its siblings start no new
          // step; the error itself is rethrown only after every worker joined.
          rejection ??= { error };
          control.stop();
          return;
        }
        outcomes[index] = outcome;
        if (outcome.stop !== null) {
          control.stop();
        }
      }
    };
    const workers = Array.from({ length: Math.min(passConcurrency, liveRuns.length) }, () => runWorker());
    // Join before returning anything, including a refusal: the CLI's
    // `finally { releaseLeases }` then never releases a run lease while a
    // step on that run is still in flight.
    await Promise.allSettled(workers);
    const thrown = rejection as { readonly error: unknown } | null;
    if (thrown !== null) {
      // The same error type as today's serial pass: the rejection surfaces
      // from `runPass` exactly as an uncaught `advance` error did before.
      throw thrown.error;
    }
    // The stop maps to today's refusal reason, chosen deterministically by run
    // order when several workers stopped.
    let stopReason: RunOutcome['stop'] = null;
    for (const outcome of outcomes) {
      if (outcome !== undefined && outcome.stop !== null) {
        stopReason = outcome.stop;
        break;
      }
    }
    if (stopReason !== null) {
      return { outcome: 'refused', reason: stopReason };
    }
    for (const outcome of outcomes) {
      if (outcome === undefined) {
        continue;
      }
      reports.push(outcome.report);
      attention.push(...outcome.attention);
    }

    const progressed = reports.some(
      (report) =>
        report.outcome === 'advanced' &&
        report.steps.some(
          (step) => step.outcome === 'entered' || step.outcome === 'repaired' || step.outcome === 'acted',
        ),
    );
    return { outcome: 'completed', halted: control.sawHalted(), progressed, runs: reports, attention };
  }

  async releaseLeases(request: RunConductorPassRequest): Promise<{ readonly released: number }> {
    const runs = await this.deps.runRepo.list();
    const heldRuns = runs.filter(
      (record): record is LaneRunRecord & { lease: LaneRunLeaseRecord } =>
        record.lease !== null && record.lease.holderId === request.holderId,
    );
    const releasedCounts = await Promise.all(
      heldRuns.map(async (record) => {
        const result = await this.deps.runRepo.releaseLease(record.runId, {
          holderId: request.holderId,
          fence: record.lease.fence,
          nowIso: request.nowIso,
        });
        return result.outcome === 'saved' ? 1 : 0;
      }),
    );
    let released = releasedCounts.reduce<number>((sum, count) => sum + count, 0);

    const driverLease = await this.deps.driverLease.read();
    if (driverLease !== null && driverLease.holderId === request.holderId) {
      const result = await this.deps.driverLease.release({
        holderId: request.holderId,
        fence: driverLease.fence,
        nowIso: request.nowIso,
      });
      if (result.outcome === 'ok') {
        released += 1;
      }
    }
    return { released };
  }

  /** The pass clock, read fresh before each step; production real time, tests a fake. */
  private nowIso(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /**
   * One run's turn. Never returns from the pass: on a stop (a per-step driver
   * loss or an invalid clock) it ends this run's steps and reports the stop,
   * and the caller returns the refusal. The run-lease renewal stays per run;
   * the driver-lease renewal goes through the pass's keeper.
   */
  private async advanceRun(record: LaneRunRecord, ctx: AdvanceRunContext & { readonly isFirstRun: boolean }): Promise<RunOutcome> {
    const renewRun = (renew: LeaseRenewRequest) =>
      this.deps.runRepo.renewLease(record.runId, renew).then((result) =>
        result.outcome === 'saved' ? result.record.lease : null,
      );
    const acquireRun = (acquire: LeaseAcquireRequest) =>
      this.deps.runRepo.acquireLease(record.runId, acquire).then((result) =>
        result.outcome === 'saved' ? result.record.lease : null,
      );

    // Fresh time for this run's first lease decision: earlier runs' steps and
    // the dispatch stagger can make the pass-start time stale. The first live
    // run reuses the pass-start now; later runs read fresh.
    const runNowIso = ctx.isFirstRun ? ctx.passNowIso : this.nowIso();
    if (!isZonedIsoDateTime(runNowIso)) {
      return {
        report: { runId: record.runId, outcome: 'advanced', steps: [] },
        attention: [],
        stop: 'invalid-request',
      };
    }
    const runUntil = leaseUntilIso(runNowIso);
    const runHeld = await holdConductorLease(record.lease, ctx.request.holderId, runNowIso, runUntil, renewRun, acquireRun);
    if (ctx.control.isStopped()) {
      return { report: { runId: record.runId, outcome: 'advanced', steps: [] }, attention: [], stop: null };
    }
    if (runHeld.outcome === 'held-by-other') {
      return {
        report: { runId: record.runId, outcome: 'skipped', reason: 'lease-held' },
        attention: [],
        stop: null,
      };
    }
    if (runHeld.outcome === 'refused') {
      return {
        report: { runId: record.runId, outcome: 'skipped', reason: 'lease-refused' },
        attention: [],
        stop: null,
      };
    }

    let lease: LaneRunLeaseRecord = {
      holderId: ctx.request.holderId,
      fence: runHeld.lease.fence,
      leaseUntilIso: runHeld.lease.leaseUntilIso,
    };
    const resumed = await this.deps.resume.applyPendingResume({
      runId: record.runId,
      lease: { holderId: lease.holderId, fence: lease.fence },
      nowIso: runNowIso,
    });
    if (ctx.control.isStopped()) {
      return { report: { runId: record.runId, outcome: 'advanced', steps: [] }, attention: [], stop: null };
    }
    if (resumed.outcome === 'refused' && resumed.reason === 'save-refused') {
      return {
        report: { runId: record.runId, outcome: 'resume-refused', reason: resumed.reason },
        attention: [],
        stop: null,
      };
    }

    const steps: AdvanceLaneRunResult[] = [];
    const attention: ConductorAttentionItem[] = [];
    let finished = false;
    // Set when this run's lease could not be renewed: stop acting on the run at once.
    let lost: 'lease-held' | 'lease-refused' | null = null;
    // Set when the driver lease is lost or the clock is invalid: end this run's
    // steps and report the stop (never return from the pass).
    let stop: RunOutcome['stop'] = null;
    while (steps.length < CONDUCTOR_MAX_STEPS_PER_RUN && !finished && stop === null && !ctx.control.isStopped()) {
      // Renew the driver lease through the keeper; the keeper reads a fresh time
      // inside its critical section, so the lease never shortens and a refused
      // or other-held renewal ends the pass (reported as this run's stop).
      const driverRenewed = await ctx.driverKeeper.renew();
      if (ctx.control.isStopped()) {
        break;
      }
      if (driverRenewed.outcome === 'invalid-clock') {
        stop = 'invalid-request';
        ctx.control.stop();
        break;
      }
      if (driverRenewed.outcome === 'lost') {
        stop = driverRenewed.reason;
        ctx.control.stop();
        break;
      }
      const stepNowIso = driverRenewed.nowIso;
      const stepUntil = leaseUntilIso(stepNowIso);

      // Renew this run's lease; refused or held by another stops acting on it.
      const runRenewed = await holdConductorLease(lease, ctx.request.holderId, stepNowIso, stepUntil, renewRun, acquireRun);
      if (ctx.control.isStopped()) {
        break;
      }
      if (runRenewed.outcome === 'held-by-other') {
        lost = 'lease-held';
        break;
      }
      if (runRenewed.outcome === 'refused') {
        lost = 'lease-refused';
        break;
      }
      lease = runRenewed.lease;

      // KF-34b: the halt marker is re-read at action admission, so a halt
      // recorded mid-pass stops new actions. Already started operations are
      // not cancelled; they finish and their results are reported.
      const haltedNow = isConductorHalted(await this.deps.halt.read());
      ctx.control.noteHalt(haltedNow);
      if (ctx.control.isStopped()) {
        break;
      }
      const step = await this.deps.advance.advanceLaneRun({
        runId: record.runId,
        lease: { holderId: lease.holderId, fence: lease.fence },
        halted: haltedNow,
        nowIso: stepNowIso,
        startGate: ctx.startGate,
      });
      steps.push(step);
      if (step.outcome === 'waiting' && step.reason === 'stop-grace-exceeded') {
        attention.push({ runId: record.runId, kind: 'stop-grace-exceeded' });
      }
      if (step.outcome === 'waiting' && step.reason === 'session-stagger') {
        // The start gate denied this run's session start: sleep until the run's
        // reserved turn plus one millisecond, so a timer that fires a millisecond
        // early still lands on or after the slot and does not spend an extra
        // stagger step. The run is not finished; the loop ceiling still bounds
        // the wait. The step is reported as it was journalled: none.
        const sleep = this.deps.sleep ?? defaultSleep;
        await sleep(ctx.startGate.pendingMs(record.runId, this.nowIso()) + 1);
        if (ctx.control.isStopped()) {
          break;
        }
        continue;
      }
      finished = !(step.outcome === 'entered' || step.outcome === 'repaired' || step.outcome === 'acted');
    }
    // One report per run: skipped when the lease was lost before any step, else the steps that ran.
    const report: ConductorRunReport =
      lost !== null && steps.length === 0
        ? { runId: record.runId, outcome: 'skipped', reason: lost }
        : { runId: record.runId, outcome: 'advanced', steps };
    return { report, attention, stop };
  }
}
