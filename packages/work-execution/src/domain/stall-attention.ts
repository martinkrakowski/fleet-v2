/**
 * PT1a (SN2/SN3): the runs the conductor holds parked for longer than the
 * stall threshold, derived from the run records and their keyed journals by
 * the SN1 rule set (`detectStalls`), never by a second threshold check. The
 * conductor pass raises one attention item per stalled run, keyed
 * `stall:<runId>`, and `conductor status --stalled` lists the same views.
 * Pure: no I/O and no clock (`nowIso` comes in); ids, codes and counts only,
 * never a finding text or a path. Total: never throws.
 */

import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import type { LaneRunRecord } from './lane-run-records.js';
import { laneRunJournalState } from './lane-run-journal.js';
import { parkClassOf } from './park-class.js';
import type { LaneRunParkClass } from './park-class.js';
import { DEFAULT_STALL_THRESHOLDS, detectStalls } from './stall-rules.js';
import type { StallRun } from './stall-rules.js';

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

/** The oldest-first order: larger age first, then run id bytewise. */
function compareViews(a: StalledRunView, b: StalledRunView): number {
  if (a.ageMinutes !== b.ageMinutes) {
    return a.ageMinutes > b.ageMinutes ? -1 : 1;
  }
  if (a.runId === b.runId) {
    return 0;
  }
  return a.runId < b.runId ? -1 : 1;
}

/**
 * The stalled runs at `nowIso`: every run the journal projects as `parked`
 * for more than `stallAfterMinutes`, as the SN1 `unowned-park` rule decides.
 * A parked run without a usable park time is left out (unknown stays
 * unknown; SN1 names the missing field), and a run that is not parked never
 * appears.
 */
export function stalledRunsOf(input: {
  readonly records: readonly LaneRunRecord[];
  readonly journals: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  readonly stallAfterMinutes: number;
  readonly nowIso: string;
}): StalledRunView[] {
  try {
    const byId = new Map<string, LaneRunRecord>();
    const runs: StallRun[] = [];
    for (const record of input.records) {
      const entries = input.journals.get(record.runId) ?? [];
      if (record.parked === null || laneRunJournalState(entries, record.runId) !== 'parked') {
        continue;
      }
      byId.set(record.runId, record);
      const parkedAtIso = parkedAtIsoOf(entries, record.runId);
      runs.push({
        id: record.runId,
        state: 'parked',
        ...(parkedAtIso === null ? {} : { parkedAtIso }),
        ...(record.prNumber === null ? {} : { prNumber: record.prNumber }),
        handOwned: false,
      });
    }
    if (runs.length === 0) {
      return [];
    }
    const findings = detectStalls(
      { runs, driverLease: { present: true } },
      { ...DEFAULT_STALL_THRESHOLDS, parkedMinutes: input.stallAfterMinutes },
      input.nowIso,
    );
    const views: StalledRunView[] = [];
    for (const finding of findings) {
      const runId = finding.rule === 'unowned-park' ? finding.subjectIds[0] : undefined;
      const record = runId === undefined ? undefined : byId.get(runId);
      const minutes = finding.evidence.minutes;
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
