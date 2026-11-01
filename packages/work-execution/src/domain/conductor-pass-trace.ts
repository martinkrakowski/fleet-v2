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

function isNullableToken(value: unknown): boolean {
  return value === null || isToken(value);
}

function isLaneRunKey(value: unknown): boolean {
  return typeof value === 'string' && parseLaneRunKey(value) !== null;
}

/** Optional step fields: validated when present, only fixed names copied. */
const TRACE_STEP_FIELDS: readonly (readonly [keyof TraceStepBuilder, (value: unknown) => boolean])[] = [
  ['state', isToken],
  ['reason', isToken],
  ['qualifier', isNullableToken],
  ['step', isToken],
  ['key', isLaneRunKey],
  ['result', isToken],
  ['reasonCode', isNullableToken],
  ['detail', isNullableToken],
  ['decision', isToken],
];

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
  for (const [field, validate] of TRACE_STEP_FIELDS) {
    const raw = value[field];
    if (raw === undefined) {
      continue;
    }
    if (!validate(raw)) {
      return null;
    }
    step[field] = raw as never;
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

/** Header fields validated as plain malformed; read once each, in order. */
const TRACE_HEADER_FIELDS: readonly (readonly [field: string, validate: (value: unknown) => boolean])[] = [
  ['passId', (value) => typeof value === 'string' && PASS_ID_PATTERN.test(value)],
  ['nowIso', isZonedIsoDateTime],
  ['holderId', (value) => typeof value === 'string' && value.length >= 1 && value.length <= 256],
  ['halted', (value) => typeof value === 'boolean'],
  ['progressed', (value) => typeof value === 'boolean'],
  ['maxActiveRuns', (value) => Number.isSafeInteger(value) && (value as number) >= 1],
  ['passConcurrency', (value) => Number.isSafeInteger(value) && (value as number) >= 1],
  ['dispatchStaggerMs', (value) => Number.isSafeInteger(value) && (value as number) >= 0],
  ['runs', Array.isArray],
  ['attention', Array.isArray],
];

function readHeader(
  input: Record<string, unknown>,
): { ok: true; fields: ReadonlyMap<string, unknown> } | { ok: false; reason: 'malformed' } {
  const fields = new Map<string, unknown>();
  for (const [field, validate] of TRACE_HEADER_FIELDS) {
    const raw = input[field];
    if (!validate(raw)) {
      return { ok: false, reason: 'malformed' };
    }
    fields.set(field, raw);
  }
  return { ok: true, fields };
}

function readAdvancedSteps(stepsRaw: readonly unknown[]): ConductorTraceStep[] | null {
  const steps: ConductorTraceStep[] = [];
  for (const stepRaw of stepsRaw) {
    const step = readTraceStep(stepRaw);
    if (step === null) {
      return null;
    }
    steps.push(step);
  }
  return steps;
}

function readRunReport(report: Record<string, unknown>): ConductorTraceRunReport | null {
  const outcome = report.outcome;
  if (outcome === 'advanced') {
    const stepsRaw = report.steps;
    if (!Array.isArray(stepsRaw) || stepsRaw.length > CONDUCTOR_PASS_TRACE_MAX_STEPS) {
      return null;
    }
    const steps = readAdvancedSteps(stepsRaw);
    if (steps === null) {
      return null;
    }
    return { outcome: 'advanced', steps };
  }
  if (outcome === 'skipped' || outcome === 'resume-refused') {
    const reason = report.reason;
    if (!isToken(reason)) {
      return null;
    }
    return { outcome, reason };
  }
  return null;
}

function readRunEntries(runsRaw: readonly unknown[]): { runId: string; report: ConductorTraceRunReport }[] | null {
  const runs: { runId: string; report: ConductorTraceRunReport }[] = [];
  for (const item of runsRaw) {
    if (!isPlainRecord(item)) {
      return null;
    }
    const runId = item.runId;
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
      return null;
    }
    const report = item.report;
    if (!isPlainRecord(report)) {
      return null;
    }
    const readReport = readRunReport(report);
    if (readReport === null) {
      return null;
    }
    runs.push({ runId, report: readReport });
  }
  return runs;
}

function readAttentionEntries(
  attentionRaw: readonly unknown[],
): { readonly runId: string; readonly kind: string }[] | null {
  const attention: { readonly runId: string; readonly kind: string }[] = [];
  for (const item of attentionRaw) {
    if (!isPlainRecord(item)) {
      return null;
    }
    const runId = item.runId;
    const kind = item.kind;
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || !isToken(kind)) {
      return null;
    }
    attention.push({ runId, kind });
  }
  return attention;
}

function readConductorPassTraceUnchecked(input: unknown): ConductorPassTraceRead {
  if (!isPlainRecord(input)) {
    return malformed();
  }
  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== CONDUCTOR_PASS_TRACE_SCHEMA_VERSION) {
    return { ok: false, reason: 'unknown-schema-version' };
  }
  const header = readHeader(input);
  if (!header.ok) {
    return malformed();
  }
  const runs = readRunEntries(header.fields.get('runs') as readonly unknown[]);
  if (runs === null) {
    return malformed();
  }
  const attention = readAttentionEntries(header.fields.get('attention') as readonly unknown[]);
  if (attention === null) {
    return malformed();
  }
  return {
    ok: true,
    record: {
      schemaVersion: CONDUCTOR_PASS_TRACE_SCHEMA_VERSION,
      passId: header.fields.get('passId') as string,
      nowIso: header.fields.get('nowIso') as string,
      holderId: header.fields.get('holderId') as string,
      halted: header.fields.get('halted') as boolean,
      progressed: header.fields.get('progressed') as boolean,
      maxActiveRuns: header.fields.get('maxActiveRuns') as number,
      passConcurrency: header.fields.get('passConcurrency') as number,
      dispatchStaggerMs: header.fields.get('dispatchStaggerMs') as number,
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

/**
 * VZ5a: the pass-trace builder. Takes a completed RunConductorPassResult's
 * structural shape plus the limits the pass honoured, and returns the frozen
 * record the ring stores. Pure: it never throws, never echoes a value and
 * drops every field the stored step and record shapes do not allow.
 */
export interface ConductorPassTraceLimits {
  readonly maxActiveRuns: number;
  readonly passConcurrency: number;
  readonly dispatchStaggerMs: number;
}

/** Structural: a RunConductorPassResult's completed fields fit it without importing application types. */
export interface ConductorPassTraceInput {
  readonly passId: string;
  readonly nowIso: string;
  readonly holderId: string;
  readonly halted: boolean;
  readonly progressed: boolean;
  readonly runs: readonly {
    readonly runId: string;
    readonly outcome: string;
    readonly steps?: readonly object[];
    readonly reason?: string;
  }[];
  readonly attention: readonly { readonly runId: string; readonly kind: string }[];
}

export function conductorPassTraceOf(
  input: ConductorPassTraceInput,
  limits: ConductorPassTraceLimits,
): ConductorPassTraceRead {
  try {
    const runs = input.runs.map((run) => {
      if (run.outcome === 'advanced') {
        return {
          runId: run.runId,
          report: {
            outcome: 'advanced' as const,
            steps: (run.steps ?? []).slice(0, CONDUCTOR_PASS_TRACE_MAX_STEPS),
          },
        };
      }
      return { runId: run.runId, report: { outcome: run.outcome, reason: run.reason } };
    });
    return readConductorPassTrace({
      schemaVersion: CONDUCTOR_PASS_TRACE_SCHEMA_VERSION,
      passId: input.passId,
      nowIso: input.nowIso,
      holderId: input.holderId,
      halted: input.halted,
      progressed: input.progressed,
      ...limits,
      runs,
      attention: input.attention,
    });
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
