/**
 * PT1a (SN2/SN3): the runs the conductor holds for longer than the stall
 * threshold — parked runs via the SN1 park rules, non-parked runs a driver is
 * not adopting via `driver-not-adopting` — derived from the run records and
 * their keyed journals by the SN1 rule set (`detectStalls`), never by a
 * second threshold check. The conductor pass raises one attention item per
 * stalled run, keyed `stall:<runId>`, and `conductor status --stalled` lists
 * the same views. Pure: no I/O and no clock (`nowIso` comes in); ids, codes
 * and counts only, never a finding text or a path. Total: never throws.
 */

import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import type { LaneRunRecord } from './lane-run-records.js';
import { laneRunJournalPendingIntent, laneRunJournalState } from './lane-run-journal.js';
import { isCanonicalIso } from './lane-activity-records.js';
import { parkClassOf } from './park-class.js';
import type { LaneRunParkClass } from './park-class.js';
import { DEFAULT_STALL_THRESHOLDS, detectStalls } from './stall-rules.js';
import type { StallRun } from './stall-rules.js';
import type { LaneRunPreMergeHold } from './lane-run-transitions.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';

/** The attention kind every stall item carries. */
export const STALL_ATTENTION_KIND = 'conductor-stall';

/** The stable key of one run's stall item. */
export function stallAttentionKey(runId: string): string {
  return 'stall:' + runId;
}

/** One stalled run: ids, the park class and the park age in whole minutes. */
export interface StalledRunView {
  readonly runId: string;
  /** `stall:<runId>`. */
  readonly key: string;
  readonly workOrderId: string;
  readonly parkClass: LaneRunParkClass;
  readonly ageMinutes: number;
  readonly parkedAtIso: string;
}

/** One non-parked stalled run: ids, the journal state and the idle age in whole minutes. */
export interface IdleStallView {
  readonly runId: string;
  /** `stall:<runId>`. */
  readonly key: string;
  readonly workOrderId: string;
  readonly state: LaneRunStateValue;
  readonly ageMinutes: number;
  readonly lastAdvancedAtIso: string;
}

/** When the run's current park began: the recorded time of its latest `parked` conduct entry, else null. */
export function parkedAtIsoOf(entries: readonly LaneRunJournalEntryRecord[], runId: string): string | null {
  let parkedAt: string | null = null;
  for (const entry of entries) {
    if (entry.kind === 'conduct' && entry.runId === runId && entry.state === 'parked') {
      parkedAt = entry.recordedAtIso;
    }
  }
  return parkedAt;
}

/** When the run last advanced: the recorded time of its latest journal entry of any kind, else null. */
export function lastAdvancedAtIsoOf(entries: readonly LaneRunJournalEntryRecord[], runId: string): string | null {
  let lastAdvanced: string | null = null;
  for (const entry of entries) {
    if (entry.runId === runId) {
      lastAdvanced = entry.recordedAtIso;
    }
  }
  return lastAdvanced;
}

/**
 * Whether a run's long idle wait is legitimate and must not page: the
 * conductor polling the forge (`watching-ci`), a Tier 2 run holding for the
 * pre-merge review (`awaiting-premerge`, or `merging` with an open `premerge`
 * intent), or a `merging` run sat in the merge train (an open
 * `merge-enqueue` intent). Everything else is a stuck run and stays visible.
 * Never reads the clock; a malformed run id reads as `ready` and is false.
 * Never throws.
 */
export function isLegitimateIdleWait(record: LaneRunRecord, entries: readonly LaneRunJournalEntryRecord[]): boolean {
  const state = laneRunJournalState(entries, record.runId);
  const pending = laneRunJournalPendingIntent(entries, record.runId);
  if (state === 'watching-ci') {
    return true;
  }
  if (record.tier === 2 && isPreMergeHold(state)) {
    if (state === 'awaiting-premerge' || pending?.step === 'premerge') {
      return true;
    }
  }
  if (state === 'merging' && pending?.step === 'merge-enqueue') {
    return true;
  }
  return false;
}

/** The two conduct states of the pre-merge hold. */
function isPreMergeHold(state: string): state is LaneRunPreMergeHold {
  return state === 'awaiting-premerge' || state === 'merging';
}

/** The oldest-first order: larger age first, then run id bytewise. */
function compareViews(a: StalledRunView | IdleStallView, b: StalledRunView | IdleStallView): number {
  if (a.ageMinutes !== b.ageMinutes) {
    return a.ageMinutes > b.ageMinutes ? -1 : 1;
  }
  if (a.runId === b.runId) {
    return 0;
  }
  return a.runId < b.runId ? -1 : 1;
}

/**
 * The stalled runs at `nowIso`: every parked run the journal projects as
 * `parked` for more than `stallAfterMinutes`, as the SN1 `unowned-park` rule
 * (no PR) or its `owned-park` sibling (a PR is open) decides, plus every
 * non-parked, non-terminal run the `driver-not-adopting` rule finds past the
 * same operator threshold, unless it is a legitimate long wait
 * (`isLegitimateIdleWait`). A parked run without a usable park time is left
 * out (unknown stays unknown; SN1 names the missing field), and a non-parked
 * run with no usable last-advanced time never appears.
 */
export function stalledRunsOf(input: {
  readonly records: readonly LaneRunRecord[];
  readonly journals: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  readonly stallAfterMinutes: number;
  readonly nowIso: string;
}): (StalledRunView | IdleStallView)[] {
  try {
    const byId = new Map<string, LaneRunRecord>();
    const runs: StallRun[] = [];
    for (const record of input.records) {
      const entries = input.journals.get(record.runId) ?? [];
      const state = laneRunJournalState(entries, record.runId);
      if (record.parked !== null && state === 'parked') {
        byId.set(record.runId, record);
        const parkedAtIso = parkedAtIsoOf(entries, record.runId);
        runs.push({
          id: record.runId,
          state: 'parked',
          ...(parkedAtIso === null ? {} : { parkedAtIso }),
          ...(record.prNumber === null ? {} : { prNumber: record.prNumber }),
          handOwned: false,
        });
        continue;
      }
      if (
        record.parked === null &&
        state !== 'parked' &&
        state !== 'merged' &&
        state !== 'stopped'
      ) {
        const lastAdvancedAtIso = lastAdvancedAtIsoOf(entries, record.runId);
        if (
          lastAdvancedAtIso !== null &&
          isCanonicalIso(lastAdvancedAtIso) &&
          !isLegitimateIdleWait(record, entries)
        ) {
          byId.set(record.runId, record);
          runs.push({
            id: record.runId,
            state,
            lastAdvancedAtIso,
            handOwned: false,
          });
        }
      }
    }
    if (runs.length === 0) {
      return [];
    }
    // `unadvancedMinutes` defaults to 15 (`DEFAULT_STALL_THRESHOLDS`, `stall-rules.ts` lines 96-98)
    // and `driver-not-adopting` compares against it (`stall-rules.ts` line 508). The conductor's
    // operator threshold is the `stallAfterMinutes` argument, already used for parks, and it is
    // `policy.daemon.stallAfterMinutes`. Leaving 15 would list a non-park run inside a window that
    // policy tells the parked view to ignore. The rule body and the default stay unchanged.
    const findings = detectStalls(
      { runs, driverLease: { present: true } },
      { ...DEFAULT_STALL_THRESHOLDS, parkedMinutes: input.stallAfterMinutes, unadvancedMinutes: input.stallAfterMinutes },
      input.nowIso,
    );
    const views: (StalledRunView | IdleStallView)[] = [];
    for (const finding of findings) {
      const runId =
        finding.rule === 'unowned-park' ||
        finding.rule === 'owned-park' ||
        finding.rule === 'driver-not-adopting'
          ? finding.subjectIds[0]
          : undefined;
      const record = runId === undefined ? undefined : byId.get(runId);
      const minutes = finding.evidence.minutes;
      if (finding.rule === 'driver-not-adopting') {
        const lastAdvancedAtIso = finding.evidence.lastAdvancedAtIso;
        if (
          runId === undefined ||
          record === undefined ||
          typeof minutes !== 'number' ||
          typeof lastAdvancedAtIso !== 'string'
        ) {
          continue;
        }
        views.push({
          runId,
          key: stallAttentionKey(runId),
          workOrderId: record.workOrderId,
          state: laneRunJournalState(input.journals.get(runId) ?? [], runId),
          ageMinutes: minutes,
          lastAdvancedAtIso,
        });
        continue;
      }
      const parkedAtIso = finding.evidence.parkedAtIso;
      if (
        runId === undefined ||
        record === undefined ||
        typeof minutes !== 'number' ||
        typeof parkedAtIso !== 'string'
      ) {
        continue;
      }
      views.push({
        runId,
        key: stallAttentionKey(runId),
        workOrderId: record.workOrderId,
        parkClass: parkClassOf(record.parked),
        ageMinutes: minutes,
        parkedAtIso,
      });
    }
    return views.sort(compareViews);
  } catch {
    return [];
  }
}
