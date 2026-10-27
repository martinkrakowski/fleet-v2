// @generated entity stub — refined for lane O1b-1.
/**
 * OrchestratorRequest is a pure domain aggregate for one web request in the
 * orchestrator mailbox: a closed, ids-only entry — a client-minted ULID,
 * one of five kinds, the project, the one target id its kind names, the
 * requesting web session, creation and 30-minute expiry, and the lifecycle
 * fields (state, fence, lost-claim count, claim, deferral, typed reason,
 * dispatch link).
 *
 * It is its own aggregate — never a CoordinationKind — and a record grants
 * nothing: the claimant acts under its own existing authority. `requestedBy`
 * comes only from the caller's session, never from the payload. Validation
 * returns a result (`{ success: true, value } | { success: false, error,
 * code }`), never throws, and never echoes an input value; secret-shaped
 * text is refused.
 */

import { containsSecretShape } from '@fleet/shared';
import { ORCHESTRATOR_REQUEST_KINDS } from '../orchestrator-session-records.js';
import type { OrchestratorRequestKind } from '../orchestrator-session-records.js';
import {
  ORCHESTRATOR_REQUEST_LINK_KEY,
  ORCHESTRATOR_REQUEST_REASON_KINDS,
  ORCHESTRATOR_REQUEST_STATES,
  ORCHESTRATOR_REQUEST_TARGET_KEY,
  ORCHESTRATOR_REQUEST_TERMINAL_STATES,
} from '../orchestrator-request-records.js';
import type {
  OrchestratorRequestLinkRecord,
  OrchestratorRequestReasonKind,
  OrchestratorRequestRecord,
  OrchestratorRequestState,
  OrchestratorRequestTargetRecord,
  OrchestratorRequestVia,
} from '../orchestrator-request-records.js';

export const ORCHESTRATOR_REQUEST_TTL_SECONDS = 30 * 60;        // D6 default and maximum
export const ORCHESTRATOR_REQUEST_CLAIM_LEASE_SECONDS = 120;    // D6 claim lease (used by O1b-2)
export const ORCHESTRATOR_REQUEST_MAX_CLAIM_LEASE_SECONDS = 300;
export const ORCHESTRATOR_REQUEST_MAX_LOST_CLAIMS = 2;          // then stalled
export const ORCHESTRATOR_REQUEST_DETAIL_MAX_BYTES = 1024;
/** Crockford base32 ULID, upper case, 26 characters, first character 0–7. */
export const ORCHESTRATOR_REQUEST_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID_MAX_BYTES = 256;  // projectId, every target and link id, sessionId, orchestratorId

const RECORD_KEYS: readonly string[] = [
  'requestId',
  'revision',
  'kind',
  'projectId',
  'target',
  'requestedBy',
  'createdAtIso',
  'expiresAtIso',
  'updatedAtIso',
  'state',
  'fence',
  'claimCount',
  'claim',
  'deferredUntilIso',
  'reason',
  'linked',
];

/** Control characters other than `\n` and `\t` are not plain text. */
// eslint-disable-next-line no-control-regex
const NON_PLAIN_TEXT_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export type OrchestratorRequestRefusalCode = 'invalid' | 'state' | 'revision' | 'holder' | 'lease' | 'expired';
export type OrchestratorRequestResult =
  | { readonly success: true; readonly value: OrchestratorRequest }
  | { readonly success: false; readonly error: Error; readonly code: OrchestratorRequestRefusalCode };

export class OrchestratorRequest {
  private constructor(private readonly record: OrchestratorRequestRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): OrchestratorRequestResult {
    try {
      return OrchestratorRequest.createUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  /**
   * Body of create. Hostile input (a throwing getter or proxy trap) may throw
   * out of this body; the public wrapper turns that into the fixed failure
   * result, never the exception's message. Only a plain object with exactly
   * the allowed own enumerable string keys is accepted, and every field is
   * read through its own property descriptor so no getter ever runs. Each
   * nested object is then snapshotted once the same way, and the stored
   * record is built only from those snapshots — the original nested objects
   * are never read again, so a proxy cannot show validation one value and
   * store another.
   */
  private static createUnchecked(input: unknown): OrchestratorRequestResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('OrchestratorRequest requires a record');
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return invalid('OrchestratorRequest requires a record');
    }
    const recordInput = readPlainObject(input, RECORD_KEYS);
    if (recordInput === null) {
      return invalid('OrchestratorRequest has an unknown key');
    }

    if (typeof recordInput.requestId !== 'string' || !ORCHESTRATOR_REQUEST_ID_PATTERN.test(recordInput.requestId)) {
      return invalid('OrchestratorRequest requestId must be a ULID');
    }
    if (!Number.isSafeInteger(recordInput.revision) || (recordInput.revision as number) < 1) {
      return invalid('OrchestratorRequest revision must be a positive integer');
    }
    if (!ORCHESTRATOR_REQUEST_KINDS.includes(recordInput.kind as OrchestratorRequestKind)) {
      return invalid(
        'OrchestratorRequest kind is not one of dispatch-attempt, start-lane-run, prepare-fix, request-review, resume-run',
      );
    }
    const kind = recordInput.kind as OrchestratorRequestKind;

    const projectIdError = idFieldError('projectId', recordInput.projectId);
    if (projectIdError !== null) {
      return invalid(projectIdError);
    }

    const target = readPlainObject(recordInput.target, [ORCHESTRATOR_REQUEST_TARGET_KEY[kind]]);
    if (target === null) {
      return invalid('OrchestratorRequest target must hold exactly the one id its kind names');
    }
    const targetError = targetSnapshotError(kind, target);
    if (targetError !== null) {
      return invalid(targetError);
    }

    const requestedBy = readPlainObject(recordInput.requestedBy, ['via', 'sessionId']);
    if (requestedBy === null) {
      return invalid('OrchestratorRequest requestedBy must be { via: web, sessionId }');
    }
    const requestedByError = requestedBySnapshotError(requestedBy);
    if (requestedByError !== null) {
      return invalid(requestedByError);
    }

    const createdAtError = timestampFieldError('createdAtIso', recordInput.createdAtIso, false);
    if (createdAtError !== null) {
      return invalid(createdAtError);
    }
    const expiresAtError = timestampFieldError('expiresAtIso', recordInput.expiresAtIso, false);
    if (expiresAtError !== null) {
      return invalid(expiresAtError);
    }
    const updatedAtError = timestampFieldError('updatedAtIso', recordInput.updatedAtIso, false);
    if (updatedAtError !== null) {
      return invalid(updatedAtError);
    }
    const deferredError = timestampFieldError('deferredUntilIso', recordInput.deferredUntilIso, true);
    if (deferredError !== null) {
      return invalid(deferredError);
    }

    const timesError = timesOrderError(recordInput);
    if (timesError !== null) {
      return invalid(timesError);
    }

    if (!ORCHESTRATOR_REQUEST_STATES.includes(recordInput.state as OrchestratorRequestState)) {
      return invalid('OrchestratorRequest state is not a known lifecycle state');
    }
    const state = recordInput.state as OrchestratorRequestState;

    const fenceError = fenceAndClaimCountError(recordInput);
    if (fenceError !== null) {
      return invalid(fenceError);
    }

    let claim: Record<string, unknown> | null = null;
    if (recordInput.claim !== null) {
      const claimSnapshot = readPlainObject(recordInput.claim, ['orchestratorId', 'fence', 'leaseUntilIso']);
      if (claimSnapshot === null) {
        return invalid('OrchestratorRequest claim must be null or { orchestratorId, fence, leaseUntilIso }');
      }
      const claimError = claimSnapshotError(claimSnapshot);
      if (claimError !== null) {
        return invalid(claimError);
      }
      claim = claimSnapshot;
    }

    let reason: Record<string, unknown> | null = null;
    if (recordInput.reason !== null) {
      const reasonSnapshot = readPlainObject(recordInput.reason, ['reasonKind', 'detail']);
      if (reasonSnapshot === null) {
        return invalid('OrchestratorRequest reason must be null or { reasonKind, detail }');
      }
      const reasonError = reasonSnapshotError(reasonSnapshot);
      if (reasonError !== null) {
        return invalid(reasonError);
      }
      reason = reasonSnapshot;
    }

    let linked: Record<string, unknown> | null = null;
    if (recordInput.linked !== null) {
      const linkKey = ORCHESTRATOR_REQUEST_LINK_KEY[kind];
      const linkedSnapshot = readPlainObject(recordInput.linked, [linkKey, 'journalKey']);
      if (linkedSnapshot === null) {
        return invalid(
          `OrchestratorRequest linked must be null or { ${linkKey}, journalKey: request/${recordInput.requestId as string} }`,
        );
      }
      const linkedError = linkedSnapshotError(kind, recordInput.requestId as string, linkedSnapshot);
      if (linkedError !== null) {
        return invalid(linkedError);
      }
      linked = linkedSnapshot;
    }

    const shapeError = stateShapeError(recordInput, claim, reason, linked);
    if (shapeError !== null) {
      return invalid(shapeError);
    }

    const record: OrchestratorRequestRecord = {
      requestId: recordInput.requestId as string,
      revision: recordInput.revision as number,
      kind,
      projectId: recordInput.projectId as string,
      target: buildTargetRecord(kind, target),
      requestedBy: Object.freeze({
        via: requestedBy.via as OrchestratorRequestVia,
        sessionId: requestedBy.sessionId as string,
      }),
      createdAtIso: new Date(recordInput.createdAtIso as string).toISOString(),
      expiresAtIso: new Date(recordInput.expiresAtIso as string).toISOString(),
      updatedAtIso: new Date(recordInput.updatedAtIso as string).toISOString(),
      state,
      fence: recordInput.fence as number,
      claimCount: recordInput.claimCount as number,
      claim:
        claim === null
          ? null
          : Object.freeze({
              orchestratorId: claim.orchestratorId as string,
              fence: claim.fence as number,
              leaseUntilIso: new Date(claim.leaseUntilIso as string).toISOString(),
            }),
      deferredUntilIso:
        recordInput.deferredUntilIso === null
          ? null
          : new Date(recordInput.deferredUntilIso as string).toISOString(),
      reason:
        reason === null
          ? null
          : Object.freeze({
              reasonKind: reason.reasonKind as OrchestratorRequestReasonKind,
              detail: reason.detail as string | null,
            }),
      linked: linked === null ? null : buildLinkedRecord(kind, linked),
    };
    return { success: true, value: new OrchestratorRequest(Object.freeze(record)) };
  }

  /** A new web request. Never throws. */
  static open(
    payload: unknown,
    requestedBy: unknown,
    nowIso: string,
    ttlSeconds: number = ORCHESTRATOR_REQUEST_TTL_SECONDS,
  ): OrchestratorRequestResult {
    try {
      return OrchestratorRequest.openUnchecked(payload, requestedBy, nowIso, ttlSeconds);
    } catch {
      return unreadableInputResult();
    }
  }

  private static openUnchecked(
    payload: unknown,
    requestedBy: unknown,
    nowIso: string,
    ttlSeconds: number,
  ): OrchestratorRequestResult {
    if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
      return invalid('OrchestratorRequest now must be a valid timestamp');
    }
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > ORCHESTRATOR_REQUEST_TTL_SECONDS) {
      return invalid('OrchestratorRequest ttl must be 1 to 1800 seconds');
    }
    const payloadObj = readPlainObject(payload, ['requestId', 'kind', 'projectId', 'target']);
    if (payloadObj === null) {
      return invalid('OrchestratorRequest payload has an unknown key');
    }
    const target = snapshotOpenTarget(payloadObj);
    const now = new Date(nowIso).toISOString();
    const expiresAtIso = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
    return OrchestratorRequest.create({
      ...payloadObj,
      target,
      revision: 1,
      requestedBy,
      createdAtIso: now,
      expiresAtIso,
      updatedAtIso: now,
      state: 'queued',
      fence: 0,
      claimCount: 0,
      claim: null,
      deferredUntilIso: null,
      reason: null,
      linked: null,
    });
  }

  /** Fresh plain record; nested objects are fresh copies. */
  toRecord(): OrchestratorRequestRecord {
    return {
      requestId: this.record.requestId,
      revision: this.record.revision,
      kind: this.record.kind,
      projectId: this.record.projectId,
      target: { ...this.record.target },
      requestedBy: { ...this.record.requestedBy },
      createdAtIso: this.record.createdAtIso,
      expiresAtIso: this.record.expiresAtIso,
      updatedAtIso: this.record.updatedAtIso,
      state: this.record.state,
      fence: this.record.fence,
      claimCount: this.record.claimCount,
      claim: this.record.claim === null ? null : { ...this.record.claim },
      deferredUntilIso: this.record.deferredUntilIso,
      reason: this.record.reason === null ? null : { ...this.record.reason },
      linked: this.record.linked === null ? null : { ...this.record.linked },
    };
  }

  getId(): string {
    return this.record.requestId;
  }

  getKind(): OrchestratorRequestKind {
    return this.record.kind;
  }

  getState(): OrchestratorRequestState {
    return this.record.state;
  }

  getRevision(): number {
    return this.record.revision;
  }

  getFence(): number {
    return this.record.fence;
  }

  isTerminal(): boolean {
    return (ORCHESTRATOR_REQUEST_TERMINAL_STATES as readonly string[]).includes(this.record.state);
  }
}

function invalid(message: string): OrchestratorRequestResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

/**
 * Fixed failure result for any unexpected exception while reading hostile
 * input. The exception's own message is never echoed.
 */
function unreadableInputResult(): OrchestratorRequestResult {
  return { success: false, error: new Error('OrchestratorRequest input could not be read'), code: 'invalid' };
}

/**
 * A plain object with exactly the given own enumerable string keys, values
 * read through their own property descriptors (so no getter ever runs).
 * Anything else — a non-object, a prototype outside Object.prototype/null, a
 * missing or extra or non-enumerable key, a symbol key — returns null.
 */
function readPlainObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

/**
 * The `target` `open` hands to `create`: the payload's target, snapshotted
 * once the way `readPlainObject` does so the original object is never read
 * again. An unknown kind has no single id key to snapshot with; its target
 * travels on untouched and `create` refuses the kind without ever reading it.
 */
function snapshotOpenTarget(payloadSnapshot: Record<string, unknown>): unknown {
  const kind = payloadSnapshot.kind as OrchestratorRequestKind;
  if (!ORCHESTRATOR_REQUEST_KINDS.includes(kind)) {
    return payloadSnapshot.target;
  }
  return readPlainObject(payloadSnapshot.target, [ORCHESTRATOR_REQUEST_TARGET_KEY[kind]]);
}

function idFieldError(field: string, value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return `OrchestratorRequest ${field} must be a non-empty id of at most 256 bytes`;
  }
  if (containsSecretShape(value)) {
    return `OrchestratorRequest ${field} contains a secret-shaped value and was refused`;
  }
  return null;
}

function timestampFieldError(field: string, value: unknown, nullOk: boolean): string | null {
  if (nullOk && value === null) {
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return nullOk
      ? `OrchestratorRequest ${field} must be null or a valid timestamp`
      : `OrchestratorRequest ${field} must be a valid timestamp`;
  }
  return null;
}

/** The one target id, checked against its snapshot — never the original object. */
function targetSnapshotError(kind: OrchestratorRequestKind, snapshot: Record<string, unknown>): string | null {
  const id = snapshot[ORCHESTRATOR_REQUEST_TARGET_KEY[kind]];
  if (typeof id !== 'string' || id.trim().length === 0 || new TextEncoder().encode(id).byteLength > ID_MAX_BYTES) {
    return 'OrchestratorRequest target must hold exactly the one id its kind names';
  }
  if (containsSecretShape(id)) {
    return 'OrchestratorRequest target contains a secret-shaped value and was refused';
  }
  return null;
}

/** The requesting web session, checked against its snapshot — never the original. */
function requestedBySnapshotError(snapshot: Record<string, unknown>): string | null {
  if (snapshot.via !== 'web') {
    return 'OrchestratorRequest requestedBy must be { via: web, sessionId }';
  }
  const sessionId = snapshot.sessionId;
  if (
    typeof sessionId !== 'string' ||
    sessionId.trim().length === 0 ||
    new TextEncoder().encode(sessionId).byteLength > ID_MAX_BYTES
  ) {
    return 'OrchestratorRequest requestedBy must be { via: web, sessionId }';
  }
  if (containsSecretShape(sessionId)) {
    return 'OrchestratorRequest requestedBy contains a secret-shaped value and was refused';
  }
  return null;
}

function timesOrderError(input: Record<string, unknown>): string | null {
  const createdAt = Date.parse(input.createdAtIso as string);
  const updatedAt = Date.parse(input.updatedAtIso as string);
  const expiresAt = Date.parse(input.expiresAtIso as string);
  if (createdAt > updatedAt || createdAt >= expiresAt) {
    return 'OrchestratorRequest times must satisfy createdAt <= updatedAt and createdAt < expiresAt';
  }
  if (expiresAt - createdAt > ORCHESTRATOR_REQUEST_TTL_SECONDS * 1000) {
    return 'OrchestratorRequest expiry exceeds 1800 seconds past creation';
  }
  return null;
}

function fenceAndClaimCountError(input: Record<string, unknown>): string | null {
  if (!Number.isSafeInteger(input.fence) || (input.fence as number) < 0) {
    return 'OrchestratorRequest fence must be a non-negative integer';
  }
  const claimCount = input.claimCount as number;
  if (!Number.isSafeInteger(claimCount) || claimCount < 0 || claimCount > ORCHESTRATOR_REQUEST_MAX_LOST_CLAIMS) {
    return 'OrchestratorRequest claimCount must be 0, 1 or 2 and never exceed fence';
  }
  if (claimCount > (input.fence as number)) {
    return 'OrchestratorRequest claimCount must be 0, 1 or 2 and never exceed fence';
  }
  return null;
}

/** The claim lease, checked against its snapshot — never the original object. */
function claimSnapshotError(snapshot: Record<string, unknown>): string | null {
  const orchestratorId = snapshot.orchestratorId;
  if (
    typeof orchestratorId !== 'string' ||
    orchestratorId.trim().length === 0 ||
    new TextEncoder().encode(orchestratorId).byteLength > ID_MAX_BYTES
  ) {
    return 'OrchestratorRequest claim must be null or { orchestratorId, fence, leaseUntilIso }';
  }
  if (containsSecretShape(orchestratorId)) {
    return 'OrchestratorRequest claim contains a secret-shaped value and was refused';
  }
  if (!Number.isSafeInteger(snapshot.fence) || (snapshot.fence as number) < 1) {
    return 'OrchestratorRequest claim must be null or { orchestratorId, fence, leaseUntilIso }';
  }
  if (typeof snapshot.leaseUntilIso !== 'string' || Number.isNaN(Date.parse(snapshot.leaseUntilIso as string))) {
    return 'OrchestratorRequest claim must be null or { orchestratorId, fence, leaseUntilIso }';
  }
  return null;
}

/** The typed reason, checked against its snapshot — never the original object. */
function reasonSnapshotError(snapshot: Record<string, unknown>): string | null {
  if (!ORCHESTRATOR_REQUEST_REASON_KINDS.includes(snapshot.reasonKind as OrchestratorRequestReasonKind)) {
    return 'OrchestratorRequest reason must be null or { reasonKind, detail }';
  }
  if (snapshot.detail === null) {
    return null;
  }
  if (
    typeof snapshot.detail !== 'string' ||
    new TextEncoder().encode(snapshot.detail as string).byteLength > ORCHESTRATOR_REQUEST_DETAIL_MAX_BYTES ||
    NON_PLAIN_TEXT_PATTERN.test(snapshot.detail as string)
  ) {
    return 'OrchestratorRequest reason detail must be at most 1024 bytes of plain text';
  }
  if (containsSecretShape(snapshot.detail as string)) {
    return 'OrchestratorRequest reason detail contains a secret-shaped value and was refused';
  }
  return null;
}

/** The dispatch link, checked against its snapshot — never the original object. */
function linkedSnapshotError(
  kind: OrchestratorRequestKind,
  requestId: string,
  snapshot: Record<string, unknown>,
): string | null {
  const linkKey = ORCHESTRATOR_REQUEST_LINK_KEY[kind];
  const id = snapshot[linkKey];
  if (typeof id !== 'string' || id.trim().length === 0 || new TextEncoder().encode(id).byteLength > ID_MAX_BYTES) {
    return `OrchestratorRequest linked must be null or { ${linkKey}, journalKey: request/${requestId} }`;
  }
  if (containsSecretShape(id)) {
    return 'OrchestratorRequest linked contains a secret-shaped value and was refused';
  }
  if (snapshot.journalKey !== `request/${requestId}`) {
    return `OrchestratorRequest linked must be null or { ${linkKey}, journalKey: request/${requestId} }`;
  }
  return null;
}

/** The lifecycle states' field expectations, checked against the snapshots. */
function stateShapeError(
  input: Record<string, unknown>,
  claim: Record<string, unknown> | null,
  reason: Record<string, unknown> | null,
  linked: Record<string, unknown> | null,
): string | null {
  const state = input.state as OrchestratorRequestState;
  const deferredUntilIso = input.deferredUntilIso;
  const claimCount = input.claimCount as number;
  const fence = input.fence as number;

  if (state === 'queued' || state === 'expired' || state === 'cancelled') {
    if (claim !== null || reason !== null || linked !== null || deferredUntilIso !== null || claimCount > 1) {
      return 'OrchestratorRequest fields do not match its state';
    }
    return null;
  }
  if (state === 'claimed' || state === 'cancel-requested') {
    if (claim === null || reason !== null || linked !== null || deferredUntilIso !== null || claimCount > 1) {
      return 'OrchestratorRequest fields do not match its state';
    }
    if ((claim.fence as number) !== fence) {
      return 'OrchestratorRequest fields do not match its state';
    }
    return null;
  }
  if (state === 'deferred') {
    if (claim !== null || reason === null || linked !== null || deferredUntilIso === null || claimCount > 1) {
      return 'OrchestratorRequest fields do not match its state';
    }
    if (Date.parse(deferredUntilIso as string) > Date.parse(input.expiresAtIso as string)) {
      return 'OrchestratorRequest fields do not match its state';
    }
    return null;
  }
  if (state === 'dispatched') {
    if (claim === null || reason !== null || linked === null || deferredUntilIso !== null || claimCount > 1) {
      return 'OrchestratorRequest fields do not match its state';
    }
    if ((claim.fence as number) !== fence) {
      return 'OrchestratorRequest fields do not match its state';
    }
    return null;
  }
  if (state === 'refused') {
    if (claim === null || reason === null || linked !== null || deferredUntilIso !== null || claimCount > 1) {
      return 'OrchestratorRequest fields do not match its state';
    }
    if ((claim.fence as number) !== fence) {
      return 'OrchestratorRequest fields do not match its state';
    }
    return null;
  }
  if (state === 'stalled') {
    if (claim !== null || reason !== null || linked !== null || deferredUntilIso !== null || claimCount !== 2) {
      return 'OrchestratorRequest fields do not match its state';
    }
    return null;
  }
  return null;
}

function buildTargetRecord(kind: OrchestratorRequestKind, snapshot: Record<string, unknown>): OrchestratorRequestTargetRecord {
  if (ORCHESTRATOR_REQUEST_TARGET_KEY[kind] === 'attemptId') {
    return Object.freeze({ attemptId: snapshot.attemptId as string });
  }
  if (ORCHESTRATOR_REQUEST_TARGET_KEY[kind] === 'workOrderId') {
    return Object.freeze({ workOrderId: snapshot.workOrderId as string });
  }
  return Object.freeze({ runId: snapshot.runId as string });
}

function buildLinkedRecord(kind: OrchestratorRequestKind, snapshot: Record<string, unknown>): OrchestratorRequestLinkRecord {
  const journalKey = snapshot.journalKey as string;
  if (ORCHESTRATOR_REQUEST_LINK_KEY[kind] === 'attemptId') {
    return Object.freeze({ attemptId: snapshot.attemptId as string, journalKey });
  }
  return Object.freeze({ runId: snapshot.runId as string, journalKey });
}
