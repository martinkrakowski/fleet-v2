/**
 * Pure mapping from the `GET /v1/runs/passes` wire envelope to the Conductor
 * view's recorded-pass records. The envelope is untrusted: every listed field
 * must be present with the right primitive type and enum value; one malformed
 * field refuses the whole list so the page reports the read as unexpected
 * instead of trusting a shape it cannot read. Unknown extra fields are ignored
 * (the API may add fields), and the five D-VZ3 wire fields never cross the
 * port.
 */

import { isRecord } from "../../lib/attempt-wire";

export type PassStoreState = "readable" | "unreadable";

export interface ConductorTraceStepView {
  readonly outcome: string;
  readonly state?: string;
  readonly reason?: string;
  readonly qualifier?: string | null;
  readonly step?: string;
  readonly key?: string;
  readonly result?: string;
  readonly reasonCode?: string | null;
  readonly detail?: string | null;
  readonly decision?: string;
}

export type ConductorRunReportView =
  | { readonly outcome: "advanced"; readonly steps: readonly ConductorTraceStepView[] }
  | { readonly outcome: "skipped"; readonly reason: string }
  | { readonly outcome: "resume-refused"; readonly reason: string };

export interface ConductorPassView {
  readonly passId: string;
  readonly nowIso: string;
  readonly halted: boolean;
  readonly progressed: boolean;
  readonly maxActiveRuns: number;
  readonly passConcurrency: number;
  readonly dispatchStaggerMs: number;
  readonly runs: readonly {
    readonly runId: string;
    readonly report: ConductorRunReportView;
  }[];
  readonly attention: readonly { readonly runId: string; readonly kind: string }[];
}

export interface PassListView {
  readonly store: PassStoreState;
  readonly passes: readonly ConductorPassView[];
  readonly total: number;
  readonly truncated: boolean;
}

const PASS_SCHEMA_VERSION = 1;
const PASS_MAX_STEPS = 8;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseList<T>(
  items: readonly unknown[],
  parseItem: (item: unknown) => T | null,
): T[] | null {
  const parsed: T[] = [];
  for (const item of items) {
    const value = parseItem(item);
    if (value === null) {
      return null;
    }
    parsed.push(value);
  }
  return parsed;
}

/** Mutable build shape of a trace step; read-only on the exported view. */
interface TraceStepBuilder {
  outcome: string;
  state?: string;
  reason?: string;
  qualifier?: string | null;
  step?: string;
  key?: string;
  result?: string;
  reasonCode?: string | null;
  detail?: string | null;
  decision?: string;
}

const OPTIONAL_STRING_STEP_FIELDS = [
  "state",
  "reason",
  "step",
  "key",
  "result",
  "decision",
] as const;

const OPTIONAL_NULLABLE_STRING_STEP_FIELDS = [
  "qualifier",
  "reasonCode",
  "detail",
] as const;

function parseStep(value: unknown): ConductorTraceStepView | null {
  if (!isRecord(value)) {
    return null;
  }
  const outcome = parseString(value.outcome);
  if (outcome === undefined) {
    return null;
  }
  const step: TraceStepBuilder = { outcome };
  for (const field of OPTIONAL_STRING_STEP_FIELDS) {
    const raw = value[field];
    if (raw === undefined) {
      continue;
    }
    const parsed = parseString(raw);
    if (parsed === undefined) {
      return null;
    }
    step[field] = parsed;
  }
  for (const field of OPTIONAL_NULLABLE_STRING_STEP_FIELDS) {
    const raw = value[field];
    if (raw === undefined) {
      continue;
    }
    if (raw === null) {
      step[field] = null;
    } else {
      const parsed = parseString(raw);
      if (parsed === undefined) {
        return null;
      }
      step[field] = parsed;
    }
  }
  return step;
}

function parseRunReport(report: Record<string, unknown>): ConductorRunReportView | null {
  const outcome = report.outcome;
  if (outcome === "advanced") {
    if (!Array.isArray(report.steps) || report.steps.length > PASS_MAX_STEPS) {
      return null;
    }
    const steps = parseList(report.steps, parseStep);
    if (steps === null) {
      return null;
    }
    return { outcome, steps };
  }
  if (outcome === "skipped" || outcome === "resume-refused") {
    const reason = parseString(report.reason);
    if (reason === undefined) {
      return null;
    }
    return { outcome, reason };
  }
  return null;
}

function parseRunEntry(
  value: unknown,
): { runId: string; report: ConductorRunReportView } | null {
  if (!isRecord(value)) {
    return null;
  }
  const runId = parseString(value.runId);
  if (runId === undefined) {
    return null;
  }
  const report = value.report;
  if (!isRecord(report)) {
    return null;
  }
  const parsedReport = parseRunReport(report);
  if (parsedReport === null) {
    return null;
  }
  return { runId, report: parsedReport };
}

function parseAttention(
  value: unknown,
): { runId: string; kind: string } | null {
  if (!isRecord(value)) {
    return null;
  }
  const runId = parseString(value.runId);
  const kind = parseString(value.kind);
  if (runId === undefined || kind === undefined) {
    return null;
  }
  return { runId, kind };
}

function parsePass(value: unknown): ConductorPassView | null {
  if (!isRecord(value)) {
    return null;
  }
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== PASS_SCHEMA_VERSION) {
    return null;
  }
  const passId = parseString(value.passId);
  const nowIso = parseString(value.nowIso);
  if (
    passId === undefined ||
    nowIso === undefined ||
    typeof value.halted !== "boolean" ||
    typeof value.progressed !== "boolean" ||
    !isNonNegativeInteger(value.maxActiveRuns) ||
    !isNonNegativeInteger(value.passConcurrency) ||
    !isNonNegativeInteger(value.dispatchStaggerMs) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.attention)
  ) {
    return null;
  }
  const runs = parseList(value.runs, parseRunEntry);
  if (runs === null) {
    return null;
  }
  const attention = parseList(value.attention, parseAttention);
  if (attention === null) {
    return null;
  }
  return {
    passId,
    nowIso,
    halted: value.halted,
    progressed: value.progressed,
    maxActiveRuns: value.maxActiveRuns,
    passConcurrency: value.passConcurrency,
    dispatchStaggerMs: value.dispatchStaggerMs,
    runs,
    attention,
  };
}

export function parseConductorPassesEnvelope(value: unknown): PassListView | null {
  if (!isRecord(value) || value.code !== "OK") {
    return null;
  }
  const result = value.result;
  if (!isRecord(result) || result.outcome !== "listed") {
    return null;
  }
  const store = result.store;
  if (store !== "readable" && store !== "unreadable") {
    return null;
  }
  if (
    !Array.isArray(result.passes) ||
    !isNonNegativeInteger(result.total) ||
    typeof result.truncated !== "boolean"
  ) {
    return null;
  }
  const passes = parseList(result.passes, parsePass);
  if (passes === null) {
    return null;
  }
  return {
    store,
    passes,
    total: result.total,
    truncated: result.truncated,
  };
}
