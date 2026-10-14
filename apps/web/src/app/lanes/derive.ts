import { attempts, workOrders, type AttemptSummary } from "./fixture";

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

export function summary(a: AttemptSummary): [word: string, note: string] {
  if (a.receipts.decision && a.receipts.decision.pending) {
    return ["blocked", `waiting on decision ${a.receipts.decision.id}`];
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

export const woOf = (a: AttemptSummary) => workOrders[a.wo];
export const attemptsOf = (wo: string) => attempts.filter((a) => a.wo === wo);
export const attemptHref = (a: AttemptSummary) => `/attempt?id=${a.id}`;
export const isLive = (a: AttemptSummary) =>
  a.facts.active === "yes" && a.facts.ended === "no";

export function queuePos(a: AttemptSummary): number {
  const q = attempts
    .filter((x) => x.capacity === "pending")
    .sort((x, y) => (x.queuedAt ?? "").localeCompare(y.queuedAt ?? ""));
  return q.findIndex((x) => x.id === a.id) + 1;
}

export function laneIdLine(a: AttemptSummary): string {
  const base =
    a.capacity === "pending"
      ? `queued #${queuePos(a)} · ${a.queueBound} bound · no session`
      : a.session
        ? `${a.session} · port ${a.port}${a.slot ? ` · slot ${a.slot}` : ""}`
        : "ended · slot released";
  const silent =
    a.facts.reachable === "unknown" && a.lastKnown
      ? ` · silent since ${a.lastKnown.at}`
      : "";
  return `${a.id} · ${base}${silent} · ${a.wo}`;
}