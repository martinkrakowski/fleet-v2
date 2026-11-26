/**
 * `withStopAuthorityEvents`: the thin stop-only emission wrapper of the
 * authority audit trail (FC12B). It wraps a stop use case without modifying
 * it, and after the use case's own success outcomes forwards exactly one
 * derived stop event to the injected sink.
 *
 * Emission is stop-only and success-only: `stop-recorded` for the lane-run
 * stop, `terminated` or `cancelled` for the attempt stop. Every other
 * outcome (`already-requested`, `not-found`, `refused`, `still-running`,
 * `unknown`) emits nothing and reports no audit gap — the record already
 * says what happened, or nothing was stopped.
 *
 * The wrapper holds no state: no deduplication set or map lives here. The
 * `eventId` is derived deterministically from the result's own key or attempt
 * id, so a retry forwards the same event id to the sink, which is idempotent
 * on `eventId` (its contract).
 *
 * The result is returned UNCHANGED — same object, same shape — with a
 * boolean `auditGap` beside it: `true` when the sink is missing, unusable,
 * refuses or throws, or when no valid event can be built from the request's
 * `nowIso`, the context and the derived event id; `false` otherwise. The
 * wrapper never throws on the emission half and never echoes an untrusted
 * value; the wrapped use case's own failures propagate unchanged, exactly as
 * they would without the wrapper.
 */

import type {
  RequestLaneRunStopPort,
  RequestLaneRunStopRequest,
  RequestLaneRunStopResult,
} from '../ports/in/RequestLaneRunStopPort.in-port.js';
import type {
  StopAttemptPort,
  StopAttemptRequest,
  StopAttemptResult,
} from '../ports/in/StopAttemptPort.in-port.js';
import type { AuthorityEventSinkPort } from '../ports/out/AuthorityEventSinkPort.out-port.js';
import {
  authorityEventForStop,
} from '../../domain/authority-event-mapping.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';

/** Who the audit trail names as the stop's actor, frozen at composition. */
export interface StopAuthorityEventContext {
  readonly actor: string;
  /** `null` means the default organisation. */
  readonly organizationId: string | null;
}

/** One audited call's outcome: the use case's own result, unchanged, plus the gap flag. */
export interface AuditedStopOutcome<TResult> {
  readonly result: TResult;
  readonly auditGap: boolean;
}

/** The lane-run stop use case with stop-event emission wrapped around it. */
export interface AuditedRequestLaneRunStopPort {
  requestLaneRunStop(
    request: RequestLaneRunStopRequest,
  ): Promise<AuditedStopOutcome<RequestLaneRunStopResult>>;
}

/** The attempt stop use case with stop-event emission wrapped around it. */
export interface AuditedStopAttemptPort {
  stopAttempt(request: StopAttemptRequest): Promise<AuditedStopOutcome<StopAttemptResult>>;
}

/** The sink an audited use case emits through, or a absent/unusable stand-in. */
export type StopAuthorityEventSink = AuthorityEventSinkPort | null | undefined;

/**
 * Wraps one stop use case with stop-only authority event emission. The sink
 * may be absent or incomplete: every such gap is reported through
 * `auditGap: true` and never blocks or alters the wrapped result.
 */
export function withStopAuthorityEvents(
  useCase: RequestLaneRunStopPort,
  sink: StopAuthorityEventSink,
  context: StopAuthorityEventContext,
): AuditedRequestLaneRunStopPort;
export function withStopAuthorityEvents(
  useCase: StopAttemptPort,
  sink: StopAuthorityEventSink,
  context: StopAuthorityEventContext,
): AuditedStopAttemptPort;
export function withStopAuthorityEvents(
  useCase: RequestLaneRunStopPort | StopAttemptPort,
  sink: StopAuthorityEventSink,
  context: StopAuthorityEventContext,
): AuditedRequestLaneRunStopPort | AuditedStopAttemptPort {
  // The use case is a program-provided port, not untrusted input; the method
  // probe is still guarded so a throwing accessor cannot escape the choice.
  let isRunStop = false;
  try {
    isRunStop = typeof (useCase as RequestLaneRunStopPort).requestLaneRunStop === 'function';
  } catch {
    isRunStop = false;
  }
  if (isRunStop) {
    return wrapRequestLaneRunStop(useCase as RequestLaneRunStopPort, sink, context);
  }
  return wrapStopAttempt(useCase as StopAttemptPort, sink, context);
}

function wrapRequestLaneRunStop(
  useCase: RequestLaneRunStopPort,
  sink: StopAuthorityEventSink,
  context: StopAuthorityEventContext,
): AuditedRequestLaneRunStopPort {
  return {
    requestLaneRunStop: async (
      request: RequestLaneRunStopRequest,
    ): Promise<AuditedStopOutcome<RequestLaneRunStopResult>> => {
      const result = await useCase.requestLaneRunStop(request);
      if (result.outcome !== 'stop-recorded') {
        return { result, auditGap: false };
      }
      // Deterministic from the recorded stop key: a retry of the same
      // recorded stop derives the same event id with no wrapper state.
      const key = readOwnText(result, 'key');
      const auditGap =
        key === null
          ? true
          : !(await emitStopEvent(mapperInput(`stop:${key}`, request, context), sink));
      return { result, auditGap };
    },
  };
}

function wrapStopAttempt(
  useCase: StopAttemptPort,
  sink: StopAuthorityEventSink,
  context: StopAuthorityEventContext,
): AuditedStopAttemptPort {
  return {
    stopAttempt: async (
      request: StopAttemptRequest,
    ): Promise<AuditedStopOutcome<StopAttemptResult>> => {
      const result = await useCase.stopAttempt(request);
      if (result.outcome !== 'terminated' && result.outcome !== 'cancelled') {
        return { result, auditGap: false };
      }
      // Deterministic from the attempt's own id; `nowIso` is optional on this
      // request, and an absent or invalid one is a gap, never a throw.
      const attemptId = readOwnText(result.attempt, 'id');
      const auditGap =
        attemptId === null
          ? true
          : !(await emitStopEvent(
              mapperInput(`stop-attempt/${attemptId}`, request, context),
              sink,
            ));
      return { result, auditGap };
    },
  };
}

/** The mapper input of one stop event: exactly the four keys the mapper accepts. */
function mapperInput(
  eventId: string,
  request: unknown,
  context: StopAuthorityEventContext,
): unknown {
  return {
    eventId,
    actor: readOwnText(context, 'actor'),
    organizationId: readOrganizationId(context),
    atIso: readOwnText(request, 'nowIso'),
  };
}

/**
 * Reads one own string data property through its descriptor snapshot, so no
 * getter ever runs and a hostile shape reads as absent (`null`).
 */
function readOwnText(value: unknown, key: string): string | null {
  try {
    const snapshot = snapshotPlainDataRecord(value);
    const read = snapshot === null ? undefined : snapshot[key];
    return typeof read === 'string' ? read : null;
  } catch {
    return null;
  }
}

/** Reads `organizationId` preserving `null` (the default organisation) from a descriptor snapshot. */
function readOrganizationId(context: unknown): string | null {
  try {
    const snapshot = snapshotPlainDataRecord(context);
    if (snapshot === null) {
      return null;
    }
    const read = snapshot['organizationId'];
    if (read === null) {
      return null;
    }
    return typeof read === 'string' ? read : null;
  } catch {
    return null;
  }
}

/**
 * Maps and records one stop event. Every failure — a refused mapping, a
 * missing or unusable sink, a refused or throwing write — is `false` (the
 * caller reports `auditGap: true`), never a throw. `true` only when the sink
 * answered `'recorded'`.
 */
async function emitStopEvent(
  input: unknown,
  sink: StopAuthorityEventSink,
): Promise<boolean> {
  const mapped = authorityEventForStop(input);
  if (!mapped.ok) {
    return false;
  }
  if (!isUsableSink(sink)) {
    return false;
  }
  try {
    const outcome = (await sink.record(mapped.event)) as unknown;
    return isRecordedOutcome(outcome);
  } catch {
    return false;
  }
}

/** True only for exactly `{ outcome: 'recorded' }`; anything else is a gap. */
function isRecordedOutcome(outcome: unknown): boolean {
  try {
    const snapshot = snapshotPlainDataRecord(outcome);
    return snapshot !== null && Object.keys(snapshot).length === 1 && snapshot['outcome'] === 'recorded';
  } catch {
    return false;
  }
}

/**
 * True when `sink` is an object with a callable `record` method. The sink is
 * a program-provided port, not untrusted input; reading `record` is guarded
 * so a throwing accessor still reads as unusable, and a getter that lies
 * about a function is an accepted residual of that program boundary.
 */
function isUsableSink(sink: unknown): sink is AuthorityEventSinkPort {
  if (sink === null || typeof sink !== 'object') {
    return false;
  }
  let record: unknown;
  try {
    record = (sink as { readonly record?: unknown }).record;
  } catch {
    return false;
  }
  return typeof record === 'function';
}
