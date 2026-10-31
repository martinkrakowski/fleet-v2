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
          (parsed.step === 'dispatch' || parsed.step === 'brief-check' || parsed.step === 'code-review') &&
          (lastStartIso === null || Date.parse(entry.recordedAtIso) > Date.parse(lastStartIso))
        ) {
          lastStartIso = entry.recordedAtIso;
        }
      }
    }
    // Clamp the seed to this pass's now: a start recorded in the future (clock
    // stepped back, skewed process) makes the first wait at most dispatchStaggerMs.
    const seedIso =
      lastStartIso === null || Date.parse(lastStartIso) <= Date.parse(passNowIso)
        ? lastStartIso
        : passNowIso;
    const startGate = new SessionStartSpacing(
      this.deps.dispatchStaggerMs ?? DEFAULT_DISPATCH_STAGGER_MS,
      seedIso,
    );

    const reports: ConductorRunReport[] = [];
    const attention: ConductorAttentionItem[] = [];

    // Each run's steps depend on the previous result, and one driver acting on
    // one run at a time keeps the host budget; a for…of with await is intended.
    const ctx: AdvanceRunContext = { request, halted, startGate, driverKeeper, passNowIso };
    for (const [index, record] of liveRuns.entries()) {
      const outcome = await this.advanceRun(record, { ...ctx, isFirstRun: index === 0 });
      if (outcome.stop !== null) {
        return { outcome: 'refused', reason: outcome.stop };
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
    return { outcome: 'completed', halted, progressed, runs: reports, attention };
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
    while (steps.length < CONDUCTOR_MAX_STEPS_PER_RUN && !finished && stop === null) {
      // Renew the driver lease through the keeper; the keeper reads a fresh time
      // inside its critical section, so the lease never shortens and a refused
      // or other-held renewal ends the pass (reported as this run's stop).
      const driverRenewed = await ctx.driverKeeper.renew();
      if (driverRenewed.outcome === 'invalid-clock') {
        stop = 'invalid-request';
        break;
      }
      if (driverRenewed.outcome === 'lost') {
        stop = driverRenewed.reason;
        break;
      }
      const stepNowIso = driverRenewed.nowIso;
      const stepUntil = leaseUntilIso(stepNowIso);

      // Renew this run's lease; refused or held by another stops acting on it.
      const runRenewed = await holdConductorLease(lease, ctx.request.holderId, stepNowIso, stepUntil, renewRun, acquireRun);
      if (runRenewed.outcome === 'held-by-other') {
        lost = 'lease-held';
        break;
      }
      if (runRenewed.outcome === 'refused') {
        lost = 'lease-refused';
        break;
      }
      lease = runRenewed.lease;

      const step = await this.deps.advance.advanceLaneRun({
        runId: record.runId,
        lease: { holderId: lease.holderId, fence: lease.fence },
        halted: ctx.halted,
        nowIso: stepNowIso,
        startGate: ctx.startGate,
      });
      steps.push(step);
      if (step.outcome === 'waiting' && step.reason === 'stop-grace-exceeded') {
        attention.push({ runId: record.runId, kind: 'stop-grace-exceeded' });
      }
      // KF-33b2: a review that passed only through out-of-scope dispositions
      // is reported for the owner; the journalled detail is a fixed token.
      if (step.outcome === 'acted' && step.detail === 'out-of-scope-findings') {
        attention.push({ runId: record.runId, kind: 'out-of-scope-findings' });
      }
      if (step.outcome === 'waiting' && step.reason === 'session-stagger') {
        // The start gate denied this run's session start: sleep until the run's
        // reserved turn plus one millisecond, so a timer that fires a millisecond
        // early still lands on or after the slot and does not spend an extra
        // stagger step. The run is not finished; the loop ceiling still bounds
        // the wait. The step is reported as it was journalled: none.
        const sleep = this.deps.sleep ?? defaultSleep;
        await sleep(ctx.startGate.pendingMs(record.runId, this.nowIso()) + 1);
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
