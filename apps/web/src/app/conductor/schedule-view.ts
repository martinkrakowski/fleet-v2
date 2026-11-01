/**
 * Pure view helpers for the Conductor page. Copy text only: no guessed wait
 * reason, and every placement has a spelled-out line so colour never carries
 * meaning alone.
 */

import type { ScheduleRowView, ScheduleView } from "./map-schedule";

export function placementText(row: ScheduleRowView): string {
  if (row.admissionWait === "cap") {
    return "admission wait (cap)";
  }
  if (row.admissionWait === "package-overlap") {
    return "admission wait (package overlap)";
  }
  if (row.placement === "running") {
    return "running";
  }
  if (row.placement === "halted") {
    return "halted";
  }
  if (row.placement === "parked") {
    return row.park === null ? "parked" : `parked · ${row.park.reason}`;
  }
  return "waiting (reason recorded per pass once traces exist)";
}

export function slotText(row: ScheduleRowView): string {
  if (row.slot === null) {
    return "no slot";
  }
  return `${row.slot.hostName} · slot ${row.slot.slotIndex}`;
}

export function packagesText(row: ScheduleRowView): string {
  if (row.packageKeys === null) {
    return "work order unreadable";
  }
  if (row.packageKeys.length === 0) {
    return "none";
  }
  return row.packageKeys.join(", ");
}

export interface AdmissionCount {
  readonly active: number;
  readonly inFlight: number;
  readonly maxActiveRuns: number | null;
}

export function gaugeText(admission: AdmissionCount): string {
  const held = admission.active + admission.inFlight;
  if (admission.maxActiveRuns === null) {
    return `${admission.active} active + ${admission.inFlight} in flight · cap not recorded`;
  }
  return `${held} of ${admission.maxActiveRuns} held (${admission.active} active, ${admission.inFlight} in flight)`;
}

export function gaugeFraction(admission: AdmissionCount): number | null {
  if (admission.maxActiveRuns === null) {
    return null;
  }
  if (admission.maxActiveRuns <= 0) {
    return 0;
  }
  const held = admission.active + admission.inFlight;
  return Math.min(1, held / admission.maxActiveRuns);
}

export function gaugeValue(admission: AdmissionCount): number {
  const held = admission.active + admission.inFlight;
  if (admission.maxActiveRuns === null) {
    return held;
  }
  return Math.min(held, admission.maxActiveRuns);
}

export function capNote(schedule: ScheduleView): string {
  if (schedule.caps === null) {
    if (schedule.trace === "unreadable") {
      return "cap not recorded · pass trace unreadable";
    }
    return "cap not recorded";
  }
  return `cap recorded ${schedule.caps.recordedAtIso}`;
}

export const PLACEMENT_FILTERS = [
  "all",
  "running",
  "waiting",
  "parked",
  "halted",
] as const;

export type PlacementFilter = (typeof PLACEMENT_FILTERS)[number];

export function filterRows(
  rows: readonly ScheduleRowView[],
  filter: PlacementFilter,
): readonly ScheduleRowView[] {
  if (filter === "all") {
    return rows;
  }
  return rows.filter((row) => row.placement === filter);
}
