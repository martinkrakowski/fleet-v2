/**
 * Pure view helpers for the live attempt page: CLI copy hints, runner/usage/
 * completion row tables, relative times and the live-region announcement.
 * No React, no imports from the server loader except types.
 */

import type { AttemptPageData } from "./live";
import type { RecordedCompletion } from "./map-inspect";
import type { RecordedRunner, RecordedUsage } from "../../lib/attempt-wire";

export type AttemptOp = "reconcile" | "stop" | "collect" | "usage";

export interface CliHint {
  readonly op: AttemptOp;
  readonly label: string;
  readonly does: string;
  readonly doesNot: string;
  readonly command: string;
  /** Why the hint is disabled, or null. Never a legality claim: the CLI and the API decide. */
  readonly disabledReason: string | null;
}

const SAFE_UNQUOTED = /^[A-Za-z0-9._:@/=+-]+$/;

export function shellQuote(value: string): string {
  if (SAFE_UNQUOTED.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function cliCommand(op: AttemptOp, attemptId: string): string {
  return `fleet-v2 attempt ${op} --attempt-id ${shellQuote(attemptId)}`;
}

const OP_CATALOG: ReadonlyArray<
  Omit<CliHint, "command" | "disabledReason">
> = [
  {
    op: "reconcile",
    label: "Reconcile",
    does:
      "Asks the runner for the session's state and records the answer; it can end the record when the runner reports the session ended.",
    doesNot:
      "It does not stop the worker, collect artifacts or release a slot on a guess.",
  },
  {
    op: "stop",
    label: "Stop",
    does: "Asks the runner to stop the worker command and records the result.",
    doesNot: "It is not undone, and it does not collect artifacts.",
  },
  {
    op: "collect",
    label: "Collect artifacts",
    does:
      "Records the head commit and the sealed artifact manifest after a completion receipt.",
    doesNot:
      "It refuses without a recorded completion receipt (reconcile first), and it never merges.",
  },
  {
    op: "usage",
    label: "Usage",
    does: "Reads the session's usage from the runner host and records it.",
    doesNot: "It does not change the attempt's state.",
  },
];

function disabledReasonFor(view: AttemptPageData["view"]): string | null {
  switch (view) {
    case "found":
      return null;
    case "unknown":
      return "The recorded host cannot be resolved: this attempt holds its slot, and no operation is offered until the host resolves.";
    case "sample":
      return "Sample data: there is no attempt on this station to act on.";
    default:
      return null;
  }
}

export function cliHints(data: AttemptPageData): readonly CliHint[] {
  if (data.view !== "found" && data.view !== "unknown" && data.view !== "sample") {
    return [];
  }
  const disabledReason = disabledReasonFor(data.view);
  return OP_CATALOG.map((hint) => ({
    ...hint,
    command: cliCommand(hint.op, data.attemptId),
    disabledReason,
  }));
}

export function runnerRows(
  runner: RecordedRunner | null,
): ReadonlyArray<readonly [term: string, value: string]> {
  if (runner === null) {
    return [];
  }
  return [
    ["kind", runner.kind],
    ["agent", runner.agent ?? "not recorded"],
    ["model", runner.model ?? "not recorded"],
    ["variant", runner.variant ?? "not recorded"],
  ];
}

export function usageSummary(
  usage: RecordedUsage | null,
): {
  readonly status: "measured" | "unavailable" | "not-measured";
  readonly note: string;
  readonly rows: ReadonlyArray<readonly [term: string, value: string]>;
} {
  if (usage === null) {
    return {
      status: "not-measured",
      note: "Not measured: no usage is recorded on this attempt.",
      rows: [],
    };
  }
  if (usage.source === "unavailable") {
    return {
      status: "unavailable",
      note: `Not measured: ${usage.reason ?? "no reason recorded"}`,
      rows: [["read at", usage.readAtIso]],
    };
  }
  return {
    status: "measured",
    note:
      "Cost as opencode recorded it: a free seat records $0.00; a plan-billed seat's figure is an estimate, not spend.",
    rows: [
      ["steps", usage.steps === null ? "not recorded" : String(usage.steps)],
      [
        "lane minutes",
        usage.wallSeconds === null
          ? "not recorded"
          : String(Math.round(usage.wallSeconds / 60)),
      ],
      [
        "tokens in",
        usage.tokensInput === null ? "not recorded" : String(usage.tokensInput),
      ],
      [
        "tokens out",
        usage.tokensOutput === null ? "not recorded" : String(usage.tokensOutput),
      ],
      [
        "cost",
        usage.costUsd === null
          ? "unreadable (not 0)"
          : `$${usage.costUsd.toFixed(2)}`,
      ],
      ["model", usage.model ?? "not recorded"],
      ["read at", usage.readAtIso],
    ],
  };
}

export function completionRows(
  c: RecordedCompletion | null,
): ReadonlyArray<readonly [term: string, value: string]> {
  if (c === null) {
    return [["completion", "no completion receipt recorded"]];
  }
  return [
    ["ended at", c.endedAtIso],
    ["exit status", c.exitStatus === null ? "not recorded" : String(c.exitStatus)],
    ["authoritative", c.authoritative ? "yes" : "no"],
    ["stopped by request", c.stoppedByRequest ? "yes" : "no"],
  ];
}

export function decisionRefsText(refs: readonly string[] | null): string {
  if (refs === null) {
    return "unknown: not recorded on this attempt, which blocks acceptance";
  }
  if (refs.length === 0) {
    return "none recorded";
  }
  return refs.join(", ");
}

export function relativeTime(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) {
    return "";
  }
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 0) {
    return "";
  }
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
}

export function announcementFor(data: AttemptPageData): string {
  switch (data.view) {
    case "found": {
      const base = `Attempt ${data.attemptId}: recorded state ${data.attempt.state}`;
      return data.attempt.outcome !== null
        ? `${base}, outcome ${data.attempt.outcome}`
        : base;
    }
    case "unknown":
      return `Attempt ${data.attemptId}: unknown, recorded host cannot be resolved`;
    case "not-found":
      return `Attempt ${data.attemptId} is not recorded`;
    case "error":
      return "The API did not answer as expected";
    case "missing-id":
      return "No attempt selected";
    case "sample":
      return "Sample data";
  }
}
