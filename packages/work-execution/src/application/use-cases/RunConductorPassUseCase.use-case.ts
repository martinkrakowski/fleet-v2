/**
 * RunConductorPassUseCase: one driver pass of the conductor (plan §3.1), with
 * no timer and no I/O of its own. A pass takes or renews the state directory's
 * driver lease, reads the halt marker, and for each non-terminal run takes or
 * renews its run lease, applies a recorded resume (K7-3), then calls
 * `advanceLaneRun` until the run waits, parks, ends or refuses, at most eight
 * steps. The CLI loops over passes with back-off; `releaseLeases` releases
 * every lease the holder holds on shutdown. Time enters only as `nowIso`; ids
 * come from the caller.
 */

import { isConductorHalted, isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';
import type { LeaseAcquireRequest, LeaseRenewRequest } from '../../domain/lane-run-lease.js';
import type { LaneRunLeaseRecord, LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { AdvanceLaneRunPort, AdvanceLaneRunResult } from '../ports/in/AdvanceLaneRunPort.in-port.js';
import type { ResumeLaneRunPort } from '../ports/in/ResumeLaneRunPort.in-port.js';
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

export interface RunConductorPassDependencies {
  readonly driverLease: ConductorDriverLeasePort;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list' | 'acquireLease' | 'renewLease' | 'releaseLease'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly resume: Pick<ResumeLaneRunPort, 'applyPendingResume'>;
  readonly advance: AdvanceLaneRunPort;
}

const ID_MAX_BYTES = 256;

/** A non-empty id of at most 256 bytes: the driver holder rule. */
function isValidHolderId(value: string): boolean {
  return value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= ID_MAX_BYTES;
}

/** `nowIso` advanced by the driver lease window, normalised. */
function leaseUntilIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) + CONDUCTOR_LEASE_MS).toISOString();
}

/** The stored driver lease without its version: the shared lease shape. */
function withoutLeaseVersion(lease: LaneRunLeaseRecord | null): LaneRunLeaseRecord | null {
  if (lease === null) {
    return null;
  }
  return { holderId: lease.holderId, fence: lease.fence, leaseUntilIso: lease.leaseUntilIso };
}

type HoldLeaseResult =
  | { readonly outcome: 'held'; readonly lease: LaneRunLeaseRecord }
  | { readonly outcome: 'held-by-other' }
  | { readonly outcome: 'refused' };

export class RunConductorPassUseCase implements RunConductorPassPort {
  constructor(private readonly deps: RunConductorPassDependencies) {}

  async runPass(request: RunConductorPassRequest): Promise<RunConductorPassResult> {
    if (!isValidHolderId(request.holderId) || !isZonedIsoDateTime(request.nowIso)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const until = leaseUntilIso(request.nowIso);

    const driverLease = withoutLeaseVersion(await this.deps.driverLease.read());
    const driverHeld = await this.holdLease(
      driverLease,
      request.holderId,
      request.nowIso,
      until,
      (renew) =>
        this.deps.driverLease.renew(renew).then((result) =>
          result.outcome === 'ok' ? withoutLeaseVersion(result.lease) : null,
        ),
      (acquire) =>
        this.deps.driverLease.acquire(acquire).then((result) =>
          result.outcome === 'ok' ? withoutLeaseVersion(result.lease) : null,
        ),
    );
    if (driverHeld.outcome === 'held-by-other') {
      return { outcome: 'refused', reason: 'driver-lease-held' };
    }
    if (driverHeld.outcome === 'refused') {
      return { outcome: 'refused', reason: 'driver-lease-refused' };
    }

    const halted = isConductorHalted(await this.deps.halt.read());

    const runs = await this.deps.runRepo.list();
    // Each run's journal read is independent, so the filtering reads run in parallel.
    const liveRuns = (
      await Promise.all(
        runs.map(async (record) => {
          const state = laneRunJournalState(await this.deps.runJournal.listForRun(record.runId), record.runId);
          return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state) ? null : record;
        }),
      )
    ).filter((record): record is LaneRunRecord => record !== null);

    const reports: ConductorRunReport[] = [];
    const attention: ConductorAttentionItem[] = [];

    // Each run's steps depend on the previous result, and one driver acting on
    // one run at a time keeps the host budget; a for…of with await is intended.
    for (const record of liveRuns) {
      const runHeld = await this.holdLease(
        record.lease,
        request.holderId,
        request.nowIso,
        until,
        (renew) =>
          this.deps.runRepo.renewLease(record.runId, renew).then((result) =>
            result.outcome === 'saved' ? result.record.lease : null,
          ),
        (acquire) =>
          this.deps.runRepo.acquireLease(record.runId, acquire).then((result) =>
            result.outcome === 'saved' ? result.record.lease : null,
          ),
      );
      if (runHeld.outcome === 'held-by-other') {
        reports.push({ runId: record.runId, outcome: 'skipped', reason: 'lease-held' });
        continue;
      }
      if (runHeld.outcome === 'refused') {
        reports.push({ runId: record.runId, outcome: 'skipped', reason: 'lease-refused' });
        continue;
      }

      const lease = { holderId: request.holderId, fence: runHeld.lease.fence };
      const resumed = await this.deps.resume.applyPendingResume({
        runId: record.runId,
        lease,
        nowIso: request.nowIso,
      });
      if (resumed.outcome === 'refused' && resumed.reason === 'save-refused') {
        reports.push({ runId: record.runId, outcome: 'resume-refused', reason: resumed.reason });
        continue;
      }

      const steps: AdvanceLaneRunResult[] = [];
      let finished = false;
      while (steps.length < CONDUCTOR_MAX_STEPS_PER_RUN && !finished) {
        const step = await this.deps.advance.advanceLaneRun({
          runId: record.runId,
          lease,
          halted,
          nowIso: request.nowIso,
        });
        steps.push(step);
        if (step.outcome === 'waiting' && step.reason === 'stop-grace-exceeded') {
          attention.push({ runId: record.runId, kind: 'stop-grace-exceeded' });
        }
        finished = !(step.outcome === 'entered' || step.outcome === 'repaired' || step.outcome === 'acted');
      }
      reports.push({ runId: record.runId, outcome: 'advanced', steps });
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

  /** Take or renew one lease by CAS; another live holder is 'held-by-other', a refused write 'refused'. */
  private async holdLease(
    current: LaneRunLeaseRecord | null,
    holderId: string,
    nowIso: string,
    until: string,
    renew: (request: LeaseRenewRequest) => Promise<LaneRunLeaseRecord | null>,
    acquire: (request: LeaseAcquireRequest) => Promise<LaneRunLeaseRecord | null>,
  ): Promise<HoldLeaseResult> {
    if (current !== null && current.holderId !== holderId && !isLeaseLapsed(current, nowIso)) {
      return { outcome: 'held-by-other' };
    }
    let lease: LaneRunLeaseRecord | null;
    if (current !== null && current.holderId === holderId && !isLeaseLapsed(current, nowIso)) {
      lease = await renew({ holderId, fence: current.fence, leaseUntilIso: until, nowIso });
    } else {
      lease = await acquire({ holderId, observedFence: current?.fence ?? 0, leaseUntilIso: until, nowIso });
    }
    if (lease === null) {
      return { outcome: 'refused' };
    }
    return { outcome: 'held', lease };
  }
}
