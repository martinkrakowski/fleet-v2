import {
  attempts,
  workOrders,
  type AttemptSummary,
  type WorkOrderSummary,
} from "./fixture";

export const STATE_ORDER: Record<string, number> = {
  unknown: 0,
  blocked: 1,
  active: 2,
  queued: 3,
  accepted: 4,
  failed: 5,
  ended: 6
};
export const STATE_FILTERS = [
  "",
  "unknown",
  "blocked",
  "active",
  "queued",
  "accepted",
  "failed",
  "ended"
];

/**
 * The recorded-row state table. A recorded row is a journal statement, never
 * a runner observation: unknown states stay unknown and ended states never
 * claim collected artifacts that were not recorded.
 */
function recordedSummary(a: AttemptSummary): [word: string, note: string] {
  switch (a.recordedState) {
    case "intent-recorded":
      return [
        "queued",
        a.capacity === "held"
          ? "intent recorded · slot reserved · not yet dispatching"
          : "intent recorded · waiting for a slot",
      ];
    case "dispatching":
      return ["active", "dispatching · recorded, not observed"];
    case "running":
      return ["active", "running · recorded, not observed"];
    case "reconciling":
      return ["unknown", "reconciling · no runner answer recorded yet"];
    case "blocked":
      return ["blocked", "blocked · recorded"];
    case "ended":
      return ["ended", "ended · artifacts not collected"];
    case "collected":
      return ["ended", "ended · collected"];
    case "cancelled":
      return ["ended", "cancelled"];
    default:
      return ["unknown", `unrecognised recorded state ${a.recordedState}`];
  }
}

export function summary(a: AttemptSummary): [word: string, note: string] {
  if (a.receipts.decision && a.receipts.decision.pending) {
    return ["blocked", `waiting on decision ${a.receipts.decision.id}`];
  }
  if (a.basis === "recorded") {
    return recordedSummary(a);
  }
  if (a.facts.reachable === "unknown" || a.facts.ended === "unknown") {
    return [
      "unknown",
      a.lastKnown ? `runner silent since ${a.lastKnown.at}` : "runner silent"
    ];
  }
  if (a.capacity === "pending") {
    return ["queued", "intent recorded · waiting for a slot"];
  }
  if (a.receipts.acceptance) {
    return ["accepted", `accepted at ${a.receipts.acceptance.head}`];
  }
  if (a.receipts.verification && !a.receipts.verification.pass) {
    return ["failed", `check failed at ${a.receipts.verification.head}`];
  }
  if (a.facts.active === "yes") {
    return [
      "active",
      `running · ${a.cost ? `${a.cost.minutes} lane min` : ""}`
    ];
  }
  if (a.facts.ended === "yes") {
    return [
      "ended",
      a.facts.collected === "yes" ? "ended · collected" : "ended · artifacts not collected"
    ];
  }
  return ["ended", "ended"];
}

export const woOf = (
  a: AttemptSummary,
  woMap: Record<string, WorkOrderSummary> = workOrders,
): WorkOrderSummary =>
  Object.hasOwn(woMap, a.wo)
    ? woMap[a.wo]
    : {
        project: "(unknown)",
        task: `work order ${a.wo} (record missing)`,
        lane: "",
      };

export const attemptsOf = (wo: string, list: AttemptSummary[] = attempts) =>
  list.filter((a) => a.wo === wo);
export const attemptHref = (a: AttemptSummary) =>
  `/attempt?id=${encodeURIComponent(a.id)}`;
export function liveViewHref(a: AttemptSummary): string | null {
  return a.basis === "recorded" ? null : attemptHref(a);
}
export function observedLine(a: AttemptSummary, note: string): string {
  const verb = a.basis === "recorded" ? "recorded" : "observed";
  return `${verb} ${a.observedAt} · ${a.observedFrom} · ${note}`;
}
export const isLive = (a: AttemptSummary) =>
  a.basis !== "recorded" && a.facts.active === "yes" && a.facts.ended === "no";

export function queuePos(
  a: AttemptSummary,
  list: AttemptSummary[] = attempts,
): number {
  const q = list
    .filter((x) => x.capacity === "pending")
    .sort((x, y) => (x.queuedAt ?? "").localeCompare(y.queuedAt ?? ""));
  return q.findIndex((x) => x.id === a.id) + 1;
}

export function laneIdLine(
  a: AttemptSummary,
  list: AttemptSummary[] = attempts,
): string {
  const portPart = a.port !== null ? ` · port ${a.port}` : "";
  const slotPart = a.slot !== null ? ` · slot ${a.slot}` : "";
  const base =
    a.capacity === "pending"
      ? `queued #${queuePos(a, list)} · ${
          a.queueBound !== null ? `${a.queueBound} bound · ` : ""
        }no session`
      : a.session
        ? `${a.session}${portPart}${slotPart}`
        : a.capacity === "held"
          ? `no session recorded${slotPart}`
          : a.capacity === "unrecorded" ||
              (a.basis === "recorded" &&
                a.recordedState !== "ended" &&
                a.recordedState !== "collected" &&
                a.recordedState !== "cancelled")
            ? "no session recorded · no slot recorded"
            : a.basis === "recorded"
              ? "ended · no slot held"
              : "ended · slot released";
  const silent =
    a.facts.reachable === "unknown" && a.lastKnown
      ? ` · silent since ${a.lastKnown.at}`
      : "";
  return `${a.id} · ${base}${silent} · ${a.wo}`;
}
