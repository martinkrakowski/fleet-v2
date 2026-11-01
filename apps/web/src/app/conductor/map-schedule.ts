/**
 * Pure mapping from the `GET /v1/runs` wire envelope to the Conductor view's
 * schedule records. The envelope is untrusted: every listed field must be
 * present with the right primitive type and enum value; one malformed field
 * refuses the whole schedule so the page reports the read as unexpected
 * instead of trusting a shape it cannot read. Unknown extra fields are
 * ignored (the API may add fields).
 */

import { isRecord } from "../../lib/attempt-wire";

export type Placement = "running" | "waiting" | "parked" | "halted";
export type HaltState = "clear" | "halted" | "unreadable";
export type TraceState = "none" | "recorded" | "unreadable";
export type SessionStep = "dispatch" | "brief-check" | "code-review";
export type AdmissionWait = "cap" | "package-overlap";

export interface ScheduleRowView {
  readonly runId: string;
  readonly workOrderId: string;
  readonly tier: number;
  readonly state: string;
  readonly round: number;
  readonly placement: Placement;
  readonly pendingStep: {
    readonly step: string;
    readonly reconciliation: string;
  } | null;
  readonly park: {
    readonly reason: string;
    readonly qualifier: string;
  } | null;
  readonly leaseLapsed: boolean | null;
  readonly packageKeys: readonly string[] | null;
  readonly workOrderUnreadable: boolean;
  readonly overlapsWith: readonly string[];
  readonly slot: { readonly hostName: string; readonly slotIndex: number } | null;
  readonly admissionWait: AdmissionWait | null;
}

export interface ScheduleHostView {
  readonly hostName: string;
  readonly slots: readonly {
    readonly slotIndex: number;
    readonly runId: string | null;
  }[];
}

export interface ScheduleCapsView {
  readonly maxActiveRuns: number;
  readonly passConcurrency: number;
  readonly dispatchStaggerMs: number;
  readonly recordedAtIso: string;
}

export interface SessionMarkView {
  readonly runId: string;
  readonly step: SessionStep;
  readonly recordedAtIso: string;
  readonly gapMs: number | null;
  readonly underStagger: boolean | null;
}

export interface ScheduleAdmissionView {
  readonly active: number;
  readonly inFlight: number;
  readonly maxActiveRuns: number | null;
}

export interface ScheduleView {
  readonly observedAtIso: string;
  readonly halt: HaltState;
  readonly driverLeaseLapsed: boolean | null;
  readonly rows: readonly ScheduleRowView[];
  readonly hosts: readonly ScheduleHostView[];
  readonly admission: ScheduleAdmissionView;
  readonly caps: ScheduleCapsView | null;
  readonly trace: TraceState;
  readonly sessionStarts: readonly SessionMarkView[];
  readonly truncated: boolean;
}

const PLACEMENTS = new Set(["running", "waiting", "parked", "halted"]);
const HALT_STATES = new Set(["clear", "halted", "unreadable"]);
const TRACE_STATES = new Set(["none", "recorded", "unreadable"]);
const SESSION_STEPS = new Set(["dispatch", "brief-check", "code-review"]);
const ADMISSION_WAITS = new Set(["cap", "package-overlap"]);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return typeof value === "boolean" || value === null;
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return parseString(value);
}

function parsePendingStep(
  value: unknown,
): { step: string; reconciliation: string } | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const step = parseString(value.step);
  const reconciliation = parseString(value.reconciliation);
  if (step === undefined || reconciliation === undefined) {
    return undefined;
  }
  return { step, reconciliation };
}

function parsePark(
  value: unknown,
): { reason: string; qualifier: string } | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const reason = parseString(value.reason);
  const qualifier = parseString(value.qualifier);
  if (reason === undefined || qualifier === undefined) {
    return undefined;
  }
  return { reason, qualifier };
}

function parseSlot(
  value: unknown,
): { hostName: string; slotIndex: number } | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const hostName = parseString(value.hostName);
  if (hostName === undefined || !isNonNegativeInteger(value.slotIndex)) {
    return undefined;
  }
  return { hostName, slotIndex: value.slotIndex };
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    const parsed = parseString(item);
    if (parsed === undefined) {
      return undefined;
    }
    items.push(parsed);
  }
  return items;
}

function parsePackageKeys(
  value: unknown,
): readonly string[] | null | undefined {
  if (value === null) {
    return null;
  }
  return parseStringArray(value);
}

function parseRowBase(
  value: Record<string, unknown>,
): {
  runId: string;
  workOrderId: string;
  state: string;
  tier: number;
  round: number;
  placement: Placement;
} | null {
  const runId = parseString(value.runId);
  const workOrderId = parseString(value.workOrderId);
  const state = parseString(value.state);
  if (runId === undefined || workOrderId === undefined || state === undefined) {
    return null;
  }
  if (!isNonNegativeInteger(value.tier) || !isNonNegativeInteger(value.round)) {
    return null;
  }
  const placement = parseString(value.placement);
  if (placement === undefined || !PLACEMENTS.has(placement)) {
    return null;
  }
  return {
    runId,
    workOrderId,
    state,
    tier: value.tier,
    round: value.round,
    placement: placement as Placement,
  };
}

function parseAdmissionWait(
  value: unknown,
): AdmissionWait | null | undefined {
  const admissionWait = parseNullableString(value);
  if (admissionWait === undefined) {
    return undefined;
  }
  if (admissionWait !== null && !ADMISSION_WAITS.has(admissionWait)) {
    return undefined;
  }
  return admissionWait as AdmissionWait | null;
}

function parseRow(value: unknown): ScheduleRowView | null {
  if (!isRecord(value)) {
    return null;
  }
  const base = parseRowBase(value);
  if (base === null) {
    return null;
  }
  const pendingStep = parsePendingStep(value.pendingStep);
  if (pendingStep === undefined) {
    return null;
  }
  const park = parsePark(value.park);
  if (park === undefined) {
    return null;
  }
  if (!isNullableBoolean(value.leaseLapsed)) {
    return null;
  }
  const packageKeys = parsePackageKeys(value.packageKeys);
  if (packageKeys === undefined) {
    return null;
  }
  if (typeof value.workOrderUnreadable !== "boolean") {
    return null;
  }
  const overlapsWith = parseStringArray(value.overlapsWith);
  if (overlapsWith === undefined) {
    return null;
  }
  const slot = parseSlot(value.slot);
  if (slot === undefined) {
    return null;
  }
  const admissionWait = parseAdmissionWait(value.admissionWait);
  if (admissionWait === undefined) {
    return null;
  }
  return {
    runId: base.runId,
    workOrderId: base.workOrderId,
    tier: base.tier,
    state: base.state,
    round: base.round,
    placement: base.placement,
    pendingStep,
    park,
    leaseLapsed: value.leaseLapsed,
    packageKeys,
    workOrderUnreadable: value.workOrderUnreadable,
    overlapsWith,
    slot,
    admissionWait,
  };
}

function parseHost(value: unknown): ScheduleHostView | null {
  if (!isRecord(value)) {
    return null;
  }
  const hostName = parseString(value.hostName);
  if (hostName === undefined || !Array.isArray(value.slots)) {
    return null;
  }
  const slots: { slotIndex: number; runId: string | null }[] = [];
  for (const item of value.slots) {
    if (!isRecord(item)) {
      return null;
    }
    if (!isNonNegativeInteger(item.slotIndex)) {
      return null;
    }
    const runId = parseNullableString(item.runId);
    if (runId === undefined) {
      return null;
    }
    slots.push({ slotIndex: item.slotIndex, runId });
  }
  return { hostName, slots };
}

function parseCaps(value: unknown): ScheduleCapsView | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const recordedAtIso = parseString(value.recordedAtIso);
  if (
    !isNonNegativeInteger(value.maxActiveRuns) ||
    !isNonNegativeInteger(value.passConcurrency) ||
    !isNonNegativeInteger(value.dispatchStaggerMs) ||
    recordedAtIso === undefined
  ) {
    return undefined;
  }
  return {
    maxActiveRuns: value.maxActiveRuns,
    passConcurrency: value.passConcurrency,
    dispatchStaggerMs: value.dispatchStaggerMs,
    recordedAtIso,
  };
}

function parseSessionMark(value: unknown): SessionMarkView | null {
  if (!isRecord(value)) {
    return null;
  }
  const runId = parseString(value.runId);
  const recordedAtIso = parseString(value.recordedAtIso);
  const step = parseString(value.step);
  if (
    runId === undefined ||
    recordedAtIso === undefined ||
    step === undefined ||
    !SESSION_STEPS.has(step)
  ) {
    return null;
  }
  if (!isNullableNumber(value.gapMs) || !isNullableBoolean(value.underStagger)) {
    return null;
  }
  return {
    runId,
    step: step as SessionStep,
    recordedAtIso,
    gapMs: value.gapMs,
    underStagger: value.underStagger,
  };
}

function parseAdmission(value: unknown): ScheduleAdmissionView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isNonNegativeInteger(value.active) ||
    !isNonNegativeInteger(value.inFlight) ||
    (value.maxActiveRuns !== null && !isNonNegativeInteger(value.maxActiveRuns))
  ) {
    return null;
  }
  return {
    active: value.active,
    inFlight: value.inFlight,
    maxActiveRuns: value.maxActiveRuns,
  };
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

function parseEnvelopeResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.code !== "OK") {
    return null;
  }
  const result = value.result;
  if (!isRecord(result) || result.outcome !== "listed") {
    return null;
  }
  return result;
}

function parseScheduleHeader(
  schedule: Record<string, unknown>,
): {
  observedAtIso: string;
  halt: HaltState;
  driverLeaseLapsed: boolean | null;
  trace: TraceState;
} | null {
  const observedAtIso = parseString(schedule.observedAtIso);
  if (observedAtIso === undefined) {
    return null;
  }
  const halt = parseString(schedule.halt);
  if (halt === undefined || !HALT_STATES.has(halt)) {
    return null;
  }
  if (!isNullableBoolean(schedule.driverLeaseLapsed)) {
    return null;
  }
  const trace = parseString(schedule.trace);
  if (trace === undefined || !TRACE_STATES.has(trace)) {
    return null;
  }
  return {
    observedAtIso,
    halt: halt as HaltState,
    driverLeaseLapsed: schedule.driverLeaseLapsed,
    trace: trace as TraceState,
  };
}

export function parseScheduleEnvelope(value: unknown): ScheduleView | null {
  const result = parseEnvelopeResult(value);
  if (result === null) {
    return null;
  }
  const schedule = result.schedule;
  if (!isRecord(schedule)) {
    return null;
  }
  if (typeof result.truncated !== "boolean") {
    return null;
  }
  const header = parseScheduleHeader(schedule);
  if (header === null) {
    return null;
  }
  const admission = parseAdmission(schedule.admission);
  if (admission === null) {
    return null;
  }
  const caps = parseCaps(schedule.caps);
  if (caps === undefined) {
    return null;
  }
  if (
    !Array.isArray(schedule.rows) ||
    !Array.isArray(schedule.hosts) ||
    !Array.isArray(result.sessionStarts)
  ) {
    return null;
  }
  const rows = parseList(schedule.rows, parseRow);
  if (rows === null) {
    return null;
  }
  const hosts = parseList(schedule.hosts, parseHost);
  if (hosts === null) {
    return null;
  }
  const sessionStarts = parseList(result.sessionStarts, parseSessionMark);
  if (sessionStarts === null) {
    return null;
  }
  return {
    observedAtIso: header.observedAtIso,
    halt: header.halt,
    driverLeaseLapsed: header.driverLeaseLapsed,
    rows,
    hosts,
    admission,
    caps,
    trace: header.trace,
    sessionStarts,
    truncated: result.truncated,
  };
}
