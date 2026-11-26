/**
 * RecordSeatCallUseCase: one plan-billed seat call (`agy`, `grok` or `claude`)
 * recorded as a metadata-only OpenInference span (plan §3.2). The span is
 * built by the pure `seatCallSpan` mapper through the run telemetry ids and
 * the installation's HMAC: `fleet.seat.billing = 'plan'`, the tool, the
 * outcome, the wall seconds and, when a label was given, its `seat-label`
 * digest — never a raw label, token, cost, model id or any other identifier.
 * `dry-run` mode returns the span without sending; `send` mode sends the one
 * span through the run telemetry port and verifies its single disposition is
 * `exported` with no error kind. This use case never throws: every invalid
 * request, failing span build or failing send is a typed refused or failed
 * result (fail closed), and no input value is ever echoed back.
 */

import type {
  RecordSeatCallPort,
  RecordSeatCallResult,
} from '../ports/in/RecordSeatCallPort.in-port.js';
import type { RunTelemetryPort, RunTelemetrySendDeadline, RunTelemetrySendResult } from '../ports/out/RunTelemetryPort.out-port.js';
import { seatCallSpan } from '../../domain/run-telemetry-spans.js';
import { TELEMETRY_ERROR_KINDS, TELEMETRY_ROUTES, type TelemetryErrorKind, type TelemetryHmac, type TelemetryRoute } from '../../domain/run-telemetry-ids.js';
import { TELEMETRY_PLAN_SEAT_TOOLS, TELEMETRY_SEAT_CALL_OUTCOMES } from '../../domain/run-telemetry-attributes.js';
import { isCalendarDateTime } from '../../domain/plain-record-reads.js';

/** The dependencies composition wires: the send port, the HMAC and the call-id mint. */
export interface RecordSeatCallDependencies {
  readonly telemetry: RunTelemetryPort;
  readonly hmac: TelemetryHmac;
  /** Mints a fresh call id for the span's trace root (one call per execute). */
  readonly mintCallId: () => string;
}

const ZONED_ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A plain object (prototype Object.prototype or null), never an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One field as an own data property: no getter ever runs; a throw reads as absent. */
function ownDataField(value: Record<string, unknown>, field: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false };
    }
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

/** A zoned ISO-8601 string naming a real calendar instant. */
function isZonedIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !ZONED_ISO_INSTANT_PATTERN.test(value)) {
    return false;
  }
  return isCalendarDateTime(value) && Number.isFinite(Date.parse(value));
}

/** A deadline the send port accepts: null or a plain object with a finite `atMs`. */
function parseDeadline(value: unknown): { ok: true; deadline: RunTelemetrySendDeadline } | { ok: false } {
  if (value === null) {
    return { ok: true, deadline: null };
  }
  if (!isPlainObject(value)) {
    return { ok: false };
  }
  const atMs = ownDataField(value, 'atMs');
  if (!atMs.ok || typeof atMs.value !== 'number' || !Number.isFinite(atMs.value)) {
    return { ok: false };
  }
  return { ok: true, deadline: { atMs: atMs.value } };
}

/** The send port's result, validated before use; anything else reads as null. */
function parseSendResult(sent: unknown): RunTelemetrySendResult | null {
  try {
    if (!isPlainObject(sent)) {
      return null;
    }
    const dispositions = ownDataField(sent, 'dispositions');
    const errorKind = ownDataField(sent, 'errorKind');
    if (!dispositions.ok || !Array.isArray(dispositions.value) || !errorKind.ok) {
      return null;
    }
    const list = dispositions.value as unknown[];
    if (list.length !== 1) {
      return null;
    }
    const entry = list[0];
    if (!isPlainObject(entry)) {
      return null;
    }
    const spanId = ownDataField(entry, 'spanId');
    const disposition = ownDataField(entry, 'disposition');
    if (!spanId.ok || typeof spanId.value !== 'string' || spanId.value.length === 0 || !disposition.ok) {
      return null;
    }
    if (!isPlainObject(disposition.value)) {
      return null;
    }
    const state = ownDataField(disposition.value, 'state');
    if (!state.ok || state.value !== 'exported') {
      return null;
    }
    const route = ownDataField(disposition.value, 'route');
    if (!route.ok || typeof route.value !== 'string' || !(TELEMETRY_ROUTES as readonly string[]).includes(route.value)) {
      return null;
    }
    if (errorKind.value !== null) {
      return null;
    }
    return {
      dispositions: [{ spanId: spanId.value, disposition: { state: 'exported', route: route.value as TelemetryRoute } }],
      errorKind: null,
    };
  } catch {
    return null;
  }
}

/** A valid `errorKind` from a failed send, else `unknown`. */
function errorKindOf(value: unknown): TelemetryErrorKind | 'unknown' {
  return typeof value === 'string' && (TELEMETRY_ERROR_KINDS as readonly string[]).includes(value)
    ? (value as TelemetryErrorKind)
    : 'unknown';
}

interface ParsedRequest {
  readonly tool: string;
  readonly outcome: string;
  readonly wallSeconds: number;
  readonly label: string | null;
  readonly mode: 'send' | 'dry-run';
  readonly deadline: RunTelemetrySendDeadline;
  readonly nowIso: string;
}

/**
 * The request is unknown input: every field is read as an own data property
 * and validated against its closed set or bounded range; anything else is
 * null. The whole parse is wrapped so no getter or descriptor read can make
 * `execute()` reject: any throw reads as `invalid-request` (fail closed).
 */
function parseRequest(value: unknown): ParsedRequest | null {
  try {
    if (!isPlainObject(value)) {
      return null;
    }
    const fields = new Map<string, unknown>();
    for (const field of ['tool', 'outcome', 'wallSeconds', 'label', 'mode', 'deadline', 'nowIso']) {
      const own = ownDataField(value, field);
      if (!own.ok) {
        return null;
      }
      fields.set(field, own.value);
    }
    const tool = fields.get('tool');
    if (typeof tool !== 'string' || !(TELEMETRY_PLAN_SEAT_TOOLS as readonly string[]).includes(tool)) {
      return null;
    }
    const outcome = fields.get('outcome');
    if (typeof outcome !== 'string' || !(TELEMETRY_SEAT_CALL_OUTCOMES as readonly string[]).includes(outcome)) {
      return null;
    }
    const wallSeconds = fields.get('wallSeconds');
    if (typeof wallSeconds !== 'number' || !Number.isFinite(wallSeconds) || wallSeconds < 0) {
      return null;
    }
    const label = fields.get('label');
    if (label !== null && typeof label !== 'string') {
      return null;
    }
    const mode = fields.get('mode');
    if (mode !== 'send' && mode !== 'dry-run') {
      return null;
    }
    const deadline = parseDeadline(fields.get('deadline'));
    if (!deadline.ok) {
      return null;
    }
    if (mode === 'send' && deadline.deadline === null) {
      return null;
    }
    const nowIso = fields.get('nowIso');
    if (!isZonedIsoInstant(nowIso)) {
      return null;
    }
    return {
      tool,
      outcome,
      wallSeconds,
      label: label as string | null,
      mode,
      deadline: deadline.deadline,
      nowIso,
    };
  } catch {
    return null;
  }
}

/** One port call, never a throw: a rejection or a throw reads as `ok: false` (fail closed). */
async function tryPort<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch {
    return { ok: false };
  }
}

export class RecordSeatCallUseCase implements RecordSeatCallPort {
  private readonly deps?: RecordSeatCallDependencies;

  constructor(deps?: RecordSeatCallDependencies) {
    this.deps = deps;
  }

  async execute(request: unknown): Promise<RecordSeatCallResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RecordSeatCallUseCase');
    }
    // Never rejects once wired: anything that escapes the steps below (a
    // revoked proxy as the request, a hostile port result) reads as a
    // send failure, and nothing more is sent.
    try {
      return await this.executeWired(this.deps, request);
    } catch {
      return { outcome: 'send-failed', errorKind: 'unknown' };
    }
  }

  private async executeWired(deps: RecordSeatCallDependencies, request: unknown): Promise<RecordSeatCallResult> {
    // Step 1: validate the request; anything unknown is refused before any send.
    const parsed = parseRequest(request);
    if (parsed === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    // Step 2: build the span. A null here is a span-build failure (the HMAC
    // may throw, return too few bytes, or the label may fail its hash input).
    const span = seatCallSpan(deps.hmac, {
      callId: deps.mintCallId(),
      tool: parsed.tool,
      outcome: parsed.outcome,
      wallSeconds: parsed.wallSeconds,
      nowIso: parsed.nowIso,
      label: parsed.label,
    });
    if (span === null) {
      return { outcome: 'refused', reason: 'span-build-failed' };
    }

    // Step 3: dry-run stops here with the span exactly as it would be sent.
    if (parsed.mode === 'dry-run') {
      return { outcome: 'dry-run', span };
    }

    // Step 4: the send. A missing send method, a throw or a rejection is a
    // send failure; the result is validated before use.
    if (typeof deps.telemetry.send !== 'function') {
      return { outcome: 'send-failed', errorKind: 'unknown' };
    }
    const sent = await tryPort(() => deps.telemetry.send([span], parsed.deadline));
    if (!sent.ok) {
      return { outcome: 'send-failed', errorKind: 'unknown' };
    }
    const parsedSent = parseSendResult(sent.value);
    if (parsedSent === null) {
      return { outcome: 'send-failed', errorKind: errorKindOf(ownDataFieldQuiet(sent.value, 'errorKind')) };
    }
    return { outcome: 'exported', spanId: parsedSent.dispositions[0]!.spanId };
  }
}

/** The `errorKind` field of a send result read quietly, for the failed-send error kind. */
function ownDataFieldQuiet(value: unknown, field: string): unknown {
  try {
    if (!isPlainObject(value)) {
      return undefined;
    }
    const own = ownDataField(value, field);
    return own.ok ? own.value : undefined;
  } catch {
    return undefined;
  }
}
