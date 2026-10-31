/**
 * The conductor pass trace record (plan §4, lane VZ1): the frozen ring record
 * the driver appends after each pass — what ran, what was skipped and what
 * refused, plus the caps it honoured. Version 1. The reader is pure: it never
 * throws, never echoes a value and never reads a clock. An unreadable or
 * unknown-version record answers a fixed reason, never a thrown error.
 */

import { isZonedIsoDateTime } from './conductor-halt.js';
import { parseLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';

export const CONDUCTOR_PASS_TRACE_SCHEMA_VERSION = 1 as const;
export const CONDUCTOR_PASS_TRACE_RING_LENGTH = 32;
export const CONDUCTOR_PASS_TRACE_MAX_STEPS = 8;

/** One advance step as stored: its outcome and only these fixed-token fields. */
export interface ConductorTraceStep {
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

export type ConductorTraceRunReport =
  | { readonly outcome: 'advanced'; readonly steps: readonly ConductorTraceStep[] }
  | { readonly outcome: 'skipped'; readonly reason: string }
  | { readonly outcome: 'resume-refused'; readonly reason: string };

export interface ConductorPassTraceRecord {
  readonly schemaVersion: typeof CONDUCTOR_PASS_TRACE_SCHEMA_VERSION;
  readonly passId: string;
  readonly nowIso: string;
  readonly holderId: string; // stored, never sent
  readonly halted: boolean;
  readonly progressed: boolean;
  readonly maxActiveRuns: number;
  readonly passConcurrency: number;
  readonly dispatchStaggerMs: number;
  readonly runs: readonly { readonly runId: string; readonly report: ConductorTraceRunReport }[];
  readonly attention: readonly { readonly runId: string; readonly kind: string }[];
}

export type ConductorPassTraceRead =
  | { readonly ok: true; readonly record: ConductorPassTraceRecord }
  | { readonly ok: false; readonly reason: 'unknown-schema-version' | 'malformed' };

const PASS_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function malformed(): ConductorPassTraceRead {
  return { ok: false, reason: 'malformed' };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The mutable build shape of a stored step; read-only on the exported interface. */
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

/** One stored step: outcome a token, and only the ten fixed names copied when present. */
function readTraceStep(value: unknown): ConductorTraceStep | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const outcome = value.outcome;
  if (!isToken(outcome)) {
    return null;
  }
  const step: TraceStepBuilder = { outcome };
  if (value.state !== undefined) {
    if (!isToken(value.state)) {
      return null;
    }
    step.state = value.state;
  }
  if (value.reason !== undefined) {
    if (!isToken(value.reason)) {
      return null;
    }
    step.reason = value.reason;
  }
  if (value.qualifier !== undefined) {
    if (value.qualifier !== null && !isToken(value.qualifier)) {
      return null;
    }
    step.qualifier = value.qualifier;
  }
  if (value.step !== undefined) {
    if (!isToken(value.step)) {
      return null;
    }
    step.step = value.step;
  }
  if (value.key !== undefined) {
    if (typeof value.key !== 'string' || parseLaneRunKey(value.key) === null) {
      return null;
    }
    step.key = value.key;
  }
  if (value.result !== undefined) {
    if (!isToken(value.result)) {
      return null;
    }
    step.result = value.result;
  }
  if (value.reasonCode !== undefined) {
    if (value.reasonCode !== null && !isToken(value.reasonCode)) {
      return null;
    }
    step.reasonCode = value.reasonCode;
  }
  if (value.detail !== undefined) {
    if (value.detail !== null && !isToken(value.detail)) {
      return null;
    }
    step.detail = value.detail;
  }
  if (value.decision !== undefined) {
    if (!isToken(value.decision)) {
      return null;
    }
    step.decision = value.decision;
  }
  return step;
}


export function readConductorPassTrace(input: unknown): ConductorPassTraceRead {
  try {
    return readConductorPassTraceUnchecked(input);
  } catch {
    return malformed();
  }
}

function readConductorPassTraceUnchecked(input: unknown): ConductorPassTraceRead {
  if (!isPlainRecord(input)) {
    return malformed();
  }
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== CONDUCTOR_PASS_TRACE_SCHEMA_VERSION) {
    return { ok: false, reason: 'unknown-schema-version' };
  }
  const passId = input.passId;
  if (typeof passId !== 'string' || !PASS_ID_PATTERN.test(passId)) {
    return malformed();
  }
  const nowIso = input.nowIso;
  if (!isZonedIsoDateTime(nowIso)) {
    return malformed();
  }
  const holderId = input.holderId;
  if (typeof holderId !== 'string' || holderId.length < 1 || holderId.length > 256) {
    return malformed();
  }
  const halted = input.halted;
  const progressed = input.progressed;
  if (typeof halted !== 'boolean' || typeof progressed !== 'boolean') {
    return malformed();
  }
  const maxActiveRuns = input.maxActiveRuns;
  const passConcurrency = input.passConcurrency;
  const dispatchStaggerMs = input.dispatchStaggerMs;
  if (
    !Number.isSafeInteger(maxActiveRuns) ||
    (maxActiveRuns as number) < 1 ||
    !Number.isSafeInteger(passConcurrency) ||
    (passConcurrency as number) < 1 ||
    !Number.isSafeInteger(dispatchStaggerMs) ||
    (dispatchStaggerMs as number) < 0
  ) {
    return malformed();
  }
  const runsRaw = input.runs;
  if (!Array.isArray(runsRaw)) {
    return malformed();
  }
  const runs: { readonly runId: string; readonly report: ConductorTraceRunReport }[] = [];
  for (const item of runsRaw) {
    if (!isPlainRecord(item)) {
      return malformed();
    }
    const runId = item.runId;
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
      return malformed();
    }
    const report = item.report;
    if (!isPlainRecord(report)) {
      return malformed();
    }
    const outcome = report.outcome;
    if (outcome === 'advanced') {
      const stepsRaw = report.steps;
      if (!Array.isArray(stepsRaw) || stepsRaw.length > CONDUCTOR_PASS_TRACE_MAX_STEPS) {
        return malformed();
      }
      const steps: ConductorTraceStep[] = [];
      for (const stepRaw of stepsRaw) {
        const step = readTraceStep(stepRaw);
        if (step === null) {
          return malformed();
        }
        steps.push(step);
      }
      runs.push({ runId, report: { outcome: 'advanced', steps } });
    } else if (outcome === 'skipped') {
      const reason = report.reason;
      if (!isToken(reason)) {
        return malformed();
      }
      runs.push({ runId, report: { outcome: 'skipped', reason } });
    } else if (outcome === 'resume-refused') {
      const reason = report.reason;
      if (!isToken(reason)) {
        return malformed();
      }
      runs.push({ runId, report: { outcome: 'resume-refused', reason } });
    } else {
      return malformed();
    }
  }
  const attentionRaw = input.attention;
  if (!Array.isArray(attentionRaw)) {
    return malformed();
  }
  const attention: { readonly runId: string; readonly kind: string }[] = [];
  for (const item of attentionRaw) {
    if (!isPlainRecord(item)) {
      return malformed();
    }
    const runId = item.runId;
    const kind = item.kind;
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || !isToken(kind)) {
      return malformed();
    }
    attention.push({ runId, kind });
  }
  return {
    ok: true,
    record: {
      schemaVersion: CONDUCTOR_PASS_TRACE_SCHEMA_VERSION,
      passId,
      nowIso,
      holderId,
      halted,
      progressed,
      maxActiveRuns: maxActiveRuns as number,
      passConcurrency: passConcurrency as number,
      dispatchStaggerMs: dispatchStaggerMs as number,
      runs,
      attention,
    },
  };
}

/** The trace record when readable, else undefined (VZ5's adapter and `state check` use it). */
export function parseConductorPassTraceStateRecord(raw: unknown): ConductorPassTraceRecord | undefined {
  const read = readConductorPassTrace(raw);
  return read.ok ? read.record : undefined;
}
