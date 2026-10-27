/**
 * Pure view helpers for the work-order sidebar. No React, no imports from
 * the server loader except types.
 */

import type { RecordedAttemptWire } from "../../lib/attempt-wire";
import type { HeldSlot } from "./map-work-order";
import type { WorkOrderPanel } from "./live-context";

export function chainOrder(
  attempts: readonly RecordedAttemptWire[],
): readonly RecordedAttemptWire[] {
  return [...attempts].sort((a, b) => {
    const fixDiff = a.fixNumber - b.fixNumber;
    if (fixDiff !== 0) {
      return fixDiff;
    }
    const createdDiff = a.createdAtIso.localeCompare(b.createdAtIso);
    if (createdDiff !== 0) {
      return createdDiff;
    }
    return a.id.localeCompare(b.id);
  });
}

export function chainLabel(attempt: RecordedAttemptWire): string {
  return attempt.kind === "initial" ? "first pass" : `fix ${attempt.fixNumber}`;
}

export function prerequisitesText(ids: readonly string[]): string {
  return ids.length === 0 ? "none recorded" : ids.join(", ");
}

export function heldSlotText(slot: HeldSlot): string {
  const base = `slot ${slot.slotIndex} held for ${slot.attemptId}`;
  return slot.seatTool !== null ? `${base} · ${slot.seatTool}` : base;
}

export function workOrderAnnouncement(panel: WorkOrderPanel): string {
  switch (panel.panel) {
    case "found":
      return `Work order ${panel.workOrder.id}: recorded state ${panel.workOrder.state}`;
    case "not-found":
      return `Work order ${panel.workOrderId} is not recorded on this station`;
    case "error":
      return "The work order read did not answer as expected";
    case "not-read":
      return "Work order not read";
  }
}
