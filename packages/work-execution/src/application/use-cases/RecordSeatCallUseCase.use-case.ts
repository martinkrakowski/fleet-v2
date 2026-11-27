// Implemented for lane TEL-SEAT — record one plan-billed seat call as a telemetry span.
/**
 * RecordSeatCallUseCase records one seat call (`agy`, `grok` or `claude`) as a
 * single metadata-only `seat-call` span through the run telemetry port. Every
 * untrusted value (the request, its deadline, the send result, each
 * disposition) is snapshotted through own data descriptors inside try/catch
 * before it is read, so no getter runs and a revoked Proxy reads as invalid.
 * The call id is minted by an injected function (this layer imports no
 * `node:*` module). `execute` never throws or rejects on any path, including
 * when constructed without dependencies or with hostile dependency getters.
 */

import type {
  RecordSeatCallPort,
  RecordSeatCallResult,
} from '../ports/in/RecordSeatCallPort.in-port.js';
import type { RunTelemetryPort, RunTelemetrySendDeadline } from '../ports/out/RunTelemetryPort.out-port.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import { isTelemetryZonedInstant, type TelemetrySpan } from '../../domain/run-telemetry.js';
import { TELEMETRY_PLAN_SEAT_TOOLS, TELEMETRY_SEAT_CALL_OUTCOMES } from '../../domain/run-telemetry-attributes.js';
import {
  TELEMETRY_ERROR_KINDS,
  spanDispositionText,
  telemetryHashInput,
  type TelemetryErrorKind,
  type TelemetryHmac,
} from '../../domain/run-telemetry-ids.js';
import { seatCallSpan } from '../../domain/run-telemetry-spans.js';

export interface RecordSeatCallDependencies {
  readonly telemetry?: RunTelemetryPort;
  readonly hmac: TelemetryHmac;
  /** Mints one opaque call id per call; injected so this layer imports no `node:*` module. */
  readonly mintCallId: () => string;
}

const REQUEST_KEYS: readonly string[] = ['tool', 'outcome', 'wallSeconds', 'label', 'mode', 'deadline', 'nowIso'];
const DEADLINE_KEYS: readonly string[] = ['atMs'];
const SENT_KEYS: readonly string[] = ['dispositions', 'errorKind'];
const ENTRY_KEYS: readonly string[] = ['spanId', 'disposition'];
/** How many prototypes a data-property lookup walks before it gives up. */
const MAX_PROTOTYPE_DEPTH = 16;

type RefusalReason = Extract<RecordSeatCallResult, { outcome: 'refused' }>['reason'];

interface ParsedRequest {
  readonly tool: string;
  readonly outcome: string;
  readonly wallSeconds: number;
  readonly label: string | null;
  readonly mode: 'send' | 'dry-run';
  readonly deadline: RunTelemetrySendDeadline;
  readonly nowIso: string;
}

function refused(reason: RefusalReason): RecordSeatCallResult {
  return { outcome: 'refused', reason };
}

function sendFailed(errorKind: TelemetryErrorKind | 'unknown'): RecordSeatCallResult {
  return { outcome: 'send-failed', errorKind };
}

/** True when the snapshot's own keys are exactly `expected`: equal length plus membership, O(ownKeys). */
function hasExactKeys(snapshot: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(snapshot);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

/**
 * The value of a data property read through property descriptors only, so no
 * getter or setter ever runs: own first, then up the prototype chain below
 * `Object.prototype` (an adapter's methods live on its prototype), at most
 * MAX_PROTOTYPE_DEPTH steps. An accessor, a missing property or a non-object
 * target reads as `undefined`. May throw on a hostile Proxy: callers catch.
 */
function dataPropertyOf(target: unknown, name: string): unknown {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
    return undefined;
  }
  let current: object | null = target;
  for (let depth = 0; depth < MAX_PROTOTYPE_DEPTH && current !== null && current !== Object.prototype; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

interface ResolvedDependencies {
  readonly hmac: TelemetryHmac;
  readonly mintCallId: () => string;
  readonly telemetry: unknown;
}

/** The required dependencies as function data properties; null when either is missing, an accessor or a throw. */
function resolveDependencies(deps: unknown): ResolvedDependencies | null {
  try {
    const hmac = dataPropertyOf(deps, 'hmac');
    const mintCallId = dataPropertyOf(deps, 'mintCallId');
    if (typeof hmac !== 'function' || typeof mintCallId !== 'function') {
      return null;
    }
    return {
      hmac: hmac as TelemetryHmac,
      mintCallId: mintCallId as () => string,
      telemetry: dataPropertyOf(deps, 'telemetry'),
    };
  } catch {
    return null;
  }
}

/** `{ atMs }` with a finite number, or null itself; `undefined` marks an invalid deadline. */
function parseDeadline(value: unknown): RunTelemetrySendDeadline | undefined {
  if (value === null) {
    return null;
  }
  const snapshot = snapshotPlainDataRecord(value);
  if (snapshot === null || !hasExactKeys(snapshot, DEADLINE_KEYS)) {
    return undefined;
  }
  const atMs = snapshot.atMs;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    return undefined;
  }
  return { atMs };
}

/**
 * Every request field validated from one null-prototype snapshot; null on any
 * defect (a throw, such as a revoked Proxy, reads as a defect). Cost: one key
 * enumeration of the request and one of the deadline.
 */
function parseRequest(request: unknown): ParsedRequest | null {
  try {
    const snapshot = snapshotPlainDataRecord(request);
    if (snapshot === null || !hasExactKeys(snapshot, REQUEST_KEYS)) {
      return null;
    }
    const { tool, outcome, wallSeconds, label, mode, deadline, nowIso } = snapshot;
    if (typeof tool !== 'string' || !(TELEMETRY_PLAN_SEAT_TOOLS as readonly string[]).includes(tool)) {
      return null;
    }
    if (typeof outcome !== 'string' || !(TELEMETRY_SEAT_CALL_OUTCOMES as readonly string[]).includes(outcome)) {
      return null;
    }
    if (typeof wallSeconds !== 'number' || !Number.isFinite(wallSeconds) || wallSeconds < 0) {
      return null;
    }
    if (label !== null && (typeof label !== 'string' || telemetryHashInput(label) === null)) {
      return null;
    }
    if (mode !== 'send' && mode !== 'dry-run') {
      return null;
    }
    if (!isTelemetryZonedInstant(nowIso)) {
      return null;
    }
    const parsedDeadline = parseDeadline(deadline);
    if (parsedDeadline === undefined) {
      return null;
    }
    // Validated above: `label` is null or a string, `mode` is one of the two literals.
    return {
      tool,
      outcome,
      wallSeconds,
      label: label as string | null,
      mode: mode === 'send' ? 'send' : 'dry-run',
      deadline: parsedDeadline,
      nowIso,
    };
  } catch {
    return null;
  }
}

/** One minted call id: a string accepted as a hash input, or null (a throw reads as null). */
function mintId(mintCallId: () => string): string | null {
  try {
    const id: unknown = mintCallId();
    return typeof id === 'string' && telemetryHashInput(id) !== null ? id : null;
  } catch {
    return null;
  }
}

/** A dense array of exactly one own enumerable data element and nothing else; its element, or undefined. */
function onlyElementOf(dispositions: unknown): unknown {
  if (!Array.isArray(dispositions) || Object.getPrototypeOf(dispositions) !== Array.prototype) {
    return undefined;
  }
  const length = Object.getOwnPropertyDescriptor(dispositions, 'length');
  if (length === undefined || !Object.hasOwn(length, 'value') || length.value !== 1) {
    return undefined;
  }
  const keys = Reflect.ownKeys(dispositions);
  if (keys.length !== 2 || keys[0] !== '0' || keys[1] !== 'length') {
    return undefined;
  }
  const element = Object.getOwnPropertyDescriptor(dispositions, '0');
  if (element === undefined || !element.enumerable || !Object.hasOwn(element, 'value')) {
    return undefined;
  }
  return element.value;
}

/** True when the one disposition entry is for `span` and is exactly `exported@<route>`. */
function isExportedEntryFor(entry: unknown, span: TelemetrySpan): boolean {
  const entrySnapshot = snapshotPlainDataRecord(entry);
  if (entrySnapshot === null || !hasExactKeys(entrySnapshot, ENTRY_KEYS)) {
    return false;
  }
  if (typeof entrySnapshot.spanId !== 'string' || entrySnapshot.spanId !== span.spanId) {
    return false;
  }
  const dispositionSnapshot = snapshotPlainDataRecord(entrySnapshot.disposition);
  if (dispositionSnapshot === null) {
    return false;
  }
  return spanDispositionText(dispositionSnapshot)?.startsWith('exported@') === true;
}

/**
 * The result of one send, validated: `exported` only for a snapshot with
 * exactly `dispositions` and `errorKind`, a null or known error kind, one
 * dispositions entry for this span and that entry exactly `exported@<route>`.
 * Anything else is `send-failed`, with the send's own error kind once it has
 * been validated and `unknown` before that. Never throws.
 */
function judgeSent(sent: unknown, span: TelemetrySpan): RecordSeatCallResult {
  let errorKind: TelemetryErrorKind | null = null;
  try {
    const snapshot = snapshotPlainDataRecord(sent);
    if (snapshot === null || !hasExactKeys(snapshot, SENT_KEYS)) {
      return sendFailed('unknown');
    }
    const kind = snapshot.errorKind;
    if (kind !== null) {
      if (typeof kind !== 'string' || !(TELEMETRY_ERROR_KINDS as readonly string[]).includes(kind)) {
        return sendFailed('unknown');
      }
      errorKind = kind as TelemetryErrorKind;
    }
    const entry = onlyElementOf(snapshot.dispositions);
    if (entry === undefined || !isExportedEntryFor(entry, span) || errorKind !== null) {
      return sendFailed(errorKind ?? 'unknown');
    }
    return { outcome: 'exported', spanId: span.spanId };
  } catch {
    return sendFailed(errorKind ?? 'unknown');
  }
}

/** Send the one span: a missing telemetry or `send`, an accessor, a throw or a rejection is `send-failed` unknown. */
async function sendSpan(
  telemetry: unknown,
  span: TelemetrySpan,
  deadline: RunTelemetrySendDeadline,
): Promise<RecordSeatCallResult> {
  let sent: unknown;
  try {
    const send = dataPropertyOf(telemetry, 'send');
    if (typeof send !== 'function') {
      return sendFailed('unknown');
    }
    sent = await Reflect.apply(send, telemetry, [[span], deadline]);
  } catch {
    return sendFailed('unknown');
  }
  return judgeSent(sent, span);
}

export class RecordSeatCallUseCase implements RecordSeatCallPort {
  private readonly deps?: RecordSeatCallDependencies;

  constructor(deps?: RecordSeatCallDependencies) {
    this.deps = deps;
  }

  async execute(request: unknown): Promise<RecordSeatCallResult> {
    try {
      return await this.record(request);
    } catch {
      // Unreachable by construction (every step above is guarded); fail closed all the same.
      return refused('invalid-request');
    }
  }

  private async record(request: unknown): Promise<RecordSeatCallResult> {
    const deps = resolveDependencies(this.deps);
    if (deps === null) {
      return refused('not-configured');
    }
    const parsed = parseRequest(request);
    if (parsed === null) {
      return refused('invalid-request');
    }
    const callId = mintId(deps.mintCallId);
    if (callId === null) {
      return refused('span-build-failed');
    }
    const span = seatCallSpan(deps.hmac, {
      callId,
      tool: parsed.tool,
      outcome: parsed.outcome,
      wallSeconds: parsed.wallSeconds,
      label: parsed.label,
      nowIso: parsed.nowIso,
    });
    if (span === null) {
      return refused('span-build-failed');
    }
    if (parsed.mode === 'dry-run') {
      return { outcome: 'dry-run', span };
    }
    return sendSpan(deps.telemetry, span, parsed.deadline);
  }
}
