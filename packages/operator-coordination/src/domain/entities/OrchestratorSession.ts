// @generated entity stub — refined for lane O1a.
/**
 * OrchestratorSession is a pure domain aggregate recording which agent CLI is
 * registered as an orchestrator: its kind, model, host, coordinated projects,
 * the web request kinds it may claim, its token scopes, its heartbeat lease
 * and the last time it polled the request mailbox.
 *
 * It is its own aggregate — never a CoordinationKind — and a record grants
 * nothing: no authorization use case ever reads it. Validation returns a
 * result (`{ success: true, value } | { success: false, error }`), never
 * throws, and never echoes an input value; secret-shaped text is refused.
 * Attached and attentive are derived pure functions of the injected clock,
 * never stored.
 */

import { containsSecretShape } from '@fleet/shared';
import {
  ORCHESTRATOR_CLI_KINDS,
  ORCHESTRATOR_REQUEST_KINDS,
  ORCHESTRATOR_SESSION_SCOPES,
  ORCHESTRATOR_SESSION_STATUSES,
} from '../orchestrator-session-records.js';
import type {
  OrchestratorCliKind,
  OrchestratorRequestKind,
  OrchestratorSessionRecord,
  OrchestratorSessionScope,
  OrchestratorSessionStatus,
} from '../orchestrator-session-records.js';
import { plainArrayCopy } from '../record-input.js';

export const ORCHESTRATOR_SESSION_LEASE_SECONDS = 90; // D6 default lease
export const ORCHESTRATOR_SESSION_MAX_LEASE_SECONDS = 300; // a lease never reaches further past its heartbeat
export const ORCHESTRATOR_ATTENTIVE_WINDOW_SECONDS = 5 * 60; // §3.6 "attentive"
export const ORCHESTRATOR_SESSION_MAX_PROJECTS = 64;
const ID_MAX_BYTES = 256; // orchestratorId, host, model, each project id
const MAX_VALID_DATE_MS = 8.64e15; // ECMAScript maximum valid date value

const RECORD_KEYS = new Set<string>([
  'orchestratorId',
  'cliKind',
  'model',
  'host',
  'projects',
  'claims',
  'scopes',
  'startedAtIso',
  'lastHeartbeatIso',
  'leaseUntilIso',
  'lastPolledRequestsAtIso',
  'status',
]);

export type OrchestratorSessionResult =
  | { readonly success: true; readonly value: OrchestratorSession }
  | { readonly success: false; readonly error: Error };

export class OrchestratorSession {
  private constructor(private readonly record: OrchestratorSessionRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): OrchestratorSessionResult {
    try {
      return OrchestratorSession.createUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  /**
   * Body of create. Hostile input (a throwing getter or proxy trap) may throw
   * out of this body; the public wrapper turns that into the fixed failure
   * result, never the exception's message. Only a plain object with exactly
   * the allowed own enumerable string keys is accepted, and every field is
   * read through its own property descriptor so no getter ever runs.
   */
  private static createUnchecked(input: unknown): OrchestratorSessionResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { success: false, error: new Error('OrchestratorSession requires a record') };
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return { success: false, error: new Error('OrchestratorSession requires a record') };
    }
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== RECORD_KEYS.size) {
      return { success: false, error: new Error('OrchestratorSession has an unknown key') };
    }
    const recordInput: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !RECORD_KEYS.has(key)) {
        return { success: false, error: new Error('OrchestratorSession has an unknown key') };
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        return { success: false, error: new Error('OrchestratorSession has an unknown key') };
      }
      recordInput[key] = descriptor.value;
    }
    // Array fields are copied by index into fresh plain arrays before any check, and that same copy is
    // validated and stored: an input array with its own iterator or species can then never show the
    // checks one value and store another (Fable, O1a review).
    for (const field of ARRAY_FIELDS) {
      recordInput[field] = plainArrayCopy(recordInput[field]);
    }

    const orchestratorIdError = stringFieldError('orchestratorId', recordInput.orchestratorId, false);
    if (orchestratorIdError !== null) {
      return { success: false, error: new Error(orchestratorIdError) };
    }
    if (!ORCHESTRATOR_CLI_KINDS.includes(recordInput.cliKind as OrchestratorCliKind)) {
      return {
        success: false,
        error: new Error(
          'OrchestratorSession cliKind is not one of claude-code, agy, opencode, codex, conductor, other',
        ),
      };
    }
    const modelError = stringFieldError('model', recordInput.model, true);
    if (modelError !== null) {
      return { success: false, error: new Error(modelError) };
    }
    const hostError = stringFieldError('host', recordInput.host, false);
    if (hostError !== null) {
      return { success: false, error: new Error(hostError) };
    }
    const projectsError = projectsErrorValue(recordInput.projects);
    if (projectsError !== null) {
      return { success: false, error: new Error(projectsError) };
    }
    const claimsError = distinctKindsError(
      'claims',
      recordInput.claims,
      ORCHESTRATOR_REQUEST_KINDS,
      'OrchestratorSession claims must be distinct request kinds',
    );
    if (claimsError !== null) {
      return { success: false, error: new Error(claimsError) };
    }
    const scopesError = distinctKindsError(
      'scopes',
      recordInput.scopes,
      ORCHESTRATOR_SESSION_SCOPES,
      'OrchestratorSession scopes must be distinct session scopes',
    );
    if (scopesError !== null) {
      return { success: false, error: new Error(scopesError) };
    }

    const startedAtError = timestampFieldError('startedAtIso', recordInput.startedAtIso, false);
    if (startedAtError !== null) {
      return { success: false, error: new Error(startedAtError) };
    }
    const lastHeartbeatError = timestampFieldError('lastHeartbeatIso', recordInput.lastHeartbeatIso, false);
    if (lastHeartbeatError !== null) {
      return { success: false, error: new Error(lastHeartbeatError) };
    }
    const leaseUntilError = timestampFieldError('leaseUntilIso', recordInput.leaseUntilIso, false);
    if (leaseUntilError !== null) {
      return { success: false, error: new Error(leaseUntilError) };
    }
    const lastPolledError = timestampFieldError(
      'lastPolledRequestsAtIso',
      recordInput.lastPolledRequestsAtIso,
      true,
    );
    if (lastPolledError !== null) {
      return { success: false, error: new Error(lastPolledError) };
    }
    const timesError = timesOrderError(recordInput);
    if (timesError !== null) {
      return { success: false, error: new Error(timesError) };
    }
    if (!ORCHESTRATOR_SESSION_STATUSES.includes(recordInput.status as OrchestratorSessionStatus)) {
      return {
        success: false,
        error: new Error('OrchestratorSession status is not one of active, retired'),
      };
    }

    const projectIds = (recordInput.projects as readonly string[]).slice();
    const claims = (recordInput.claims as readonly OrchestratorRequestKind[])
      .slice()
      .sort((a, b) => a.localeCompare(b));
    const scopes = (recordInput.scopes as readonly OrchestratorSessionScope[])
      .slice()
      .sort((a, b) => a.localeCompare(b));
    const record: OrchestratorSessionRecord = {
      orchestratorId: recordInput.orchestratorId as string,
      cliKind: recordInput.cliKind as OrchestratorCliKind,
      model: recordInput.model === null ? null : (recordInput.model as string),
      host: recordInput.host as string,
      projects: Object.freeze(projectIds),
      claims: Object.freeze(claims),
      scopes: Object.freeze(scopes),
      startedAtIso: new Date(recordInput.startedAtIso as string).toISOString(),
      lastHeartbeatIso: new Date(recordInput.lastHeartbeatIso as string).toISOString(),
      leaseUntilIso: new Date(recordInput.leaseUntilIso as string).toISOString(),
      lastPolledRequestsAtIso:
        recordInput.lastPolledRequestsAtIso === null
          ? null
          : new Date(recordInput.lastPolledRequestsAtIso as string).toISOString(),
      status: recordInput.status as OrchestratorSessionStatus,
    };
    return { success: true, value: new OrchestratorSession(Object.freeze(record)) };
  }

  /** Fresh plain record; arrays are fresh copies. */
  toRecord(): OrchestratorSessionRecord {
    return {
      orchestratorId: this.record.orchestratorId,
      cliKind: this.record.cliKind,
      model: this.record.model,
      host: this.record.host,
      projects: Object.freeze(this.record.projects.slice()),
      claims: Object.freeze(this.record.claims.slice()),
      scopes: Object.freeze(this.record.scopes.slice()),
      startedAtIso: this.record.startedAtIso,
      lastHeartbeatIso: this.record.lastHeartbeatIso,
      leaseUntilIso: this.record.leaseUntilIso,
      lastPolledRequestsAtIso: this.record.lastPolledRequestsAtIso,
      status: this.record.status,
    };
  }

  getId(): string {
    return this.record.orchestratorId;
  }

  getStatus(): OrchestratorSessionStatus {
    return this.record.status;
  }

  getCliKind(): OrchestratorCliKind {
    return this.record.cliKind;
  }

  getClaims(): readonly OrchestratorRequestKind[] {
    return this.record.claims.slice();
  }

  /** True only for a declared request kind this session claims. Status and lease are checked by O2b. */
  canClaim(kind: string): boolean {
    return (
      ORCHESTRATOR_REQUEST_KINDS.includes(kind as OrchestratorRequestKind) &&
      this.record.claims.includes(kind as OrchestratorRequestKind)
    );
  }

  renewLease(
    nowIso: string,
    leaseSeconds: number = ORCHESTRATOR_SESSION_LEASE_SECONDS,
  ): OrchestratorSessionResult {
    try {
      return this.renewLeaseUnchecked(nowIso, leaseSeconds);
    } catch {
      return unreadableInputResult();
    }
  }

  private renewLeaseUnchecked(
    nowIso: string,
    leaseSeconds: number = ORCHESTRATOR_SESSION_LEASE_SECONDS,
  ): OrchestratorSessionResult {
    if (this.record.status === 'retired') {
      return { success: false, error: new Error('OrchestratorSession is retired and cannot renew its lease') };
    }
    if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
      return { success: false, error: new Error('OrchestratorSession now must be a valid timestamp') };
    }
    if (
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > ORCHESTRATOR_SESSION_MAX_LEASE_SECONDS
    ) {
      return { success: false, error: new Error('OrchestratorSession lease must be 1 to 300 seconds') };
    }
    const nowMs = Date.parse(nowIso);
    if (nowMs < Date.parse(this.record.lastHeartbeatIso)) {
      return { success: false, error: new Error('OrchestratorSession heartbeat must not move backwards') };
    }
    const leaseUntilMs = nowMs + leaseSeconds * 1000;
    if (!Number.isFinite(leaseUntilMs) || leaseUntilMs > MAX_VALID_DATE_MS) {
      return { success: false, error: new Error('lease end is out of range') };
    }
    return OrchestratorSession.create({
      ...this.toRecord(),
      lastHeartbeatIso: new Date(nowMs).toISOString(),
      leaseUntilIso: new Date(leaseUntilMs).toISOString(),
    });
  }

  recordRequestsPoll(nowIso: string): OrchestratorSessionResult {
    try {
      return this.recordRequestsPollUnchecked(nowIso);
    } catch {
      return unreadableInputResult();
    }
  }

  private recordRequestsPollUnchecked(nowIso: string): OrchestratorSessionResult {
    if (this.record.status === 'retired') {
      return { success: false, error: new Error('OrchestratorSession is retired and cannot poll') };
    }
    if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
      return { success: false, error: new Error('OrchestratorSession now must be a valid timestamp') };
    }
    return OrchestratorSession.create({
      ...this.toRecord(),
      lastPolledRequestsAtIso: new Date(nowIso).toISOString(),
    });
  }

  retire(nowIso: string): OrchestratorSessionResult {
    try {
      return this.retireUnchecked(nowIso);
    } catch {
      return unreadableInputResult();
    }
  }

  private retireUnchecked(nowIso: string): OrchestratorSessionResult {
    if (this.record.status === 'retired') {
      return { success: true, value: this };
    }
    if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
      return { success: false, error: new Error('OrchestratorSession now must be a valid timestamp') };
    }
    const nextLeaseMs = Math.min(
      Date.parse(this.record.leaseUntilIso),
      Math.max(Date.parse(nowIso), Date.parse(this.record.lastHeartbeatIso) + 1),
    );
    return OrchestratorSession.create({
      ...this.toRecord(),
      status: 'retired',
      leaseUntilIso: new Date(nextLeaseMs).toISOString(),
    });
  }
}

/**
 * Attached: an active session whose lease is still running at `nowIso`.
 * Invalid `nowIso` is never a pass.
 */
export function isOrchestratorAttached(record: OrchestratorSessionRecord, nowIso: string): boolean {
  if (record.status !== 'active') {
    return false;
  }
  if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
    return false;
  }
  return Date.parse(nowIso) < Date.parse(record.leaseUntilIso);
}

/**
 * Attentive: polled the request mailbox within 5 minutes before `nowIso`
 * (0 ≤ now − polled ≤ 300 s). Never polled, or invalid `nowIso`: false.
 * Independent of attached.
 */
export function isOrchestratorAttentive(record: OrchestratorSessionRecord, nowIso: string): boolean {
  if (record.lastPolledRequestsAtIso === null) {
    return false;
  }
  if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
    return false;
  }
  const sincePollMs = Date.parse(nowIso) - Date.parse(record.lastPolledRequestsAtIso);
  return sincePollMs >= 0 && sincePollMs <= ORCHESTRATOR_ATTENTIVE_WINDOW_SECONDS * 1000;
}

/**
 * Fixed failure result for any unexpected exception while reading hostile
 * input. The exception's own message is never echoed.
 */
function unreadableInputResult(): OrchestratorSessionResult {
  return { success: false, error: new Error('OrchestratorSession input could not be read') };
}

function stringFieldError(field: string, value: unknown, nullOk: boolean): string | null {
  if (nullOk && value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return nullOk
      ? `OrchestratorSession ${field} must be null or a non-empty string of at most 256 bytes`
      : `OrchestratorSession ${field} must be a non-empty id of at most 256 bytes`;
  }
  if (containsSecretShape(value)) {
    return `OrchestratorSession ${field} contains a secret-shaped value and was refused`;
  }
  return null;
}

function projectsErrorValue(projects: unknown): string | null {
  if (!Array.isArray(projects)) {
    return 'OrchestratorSession projects must be an array of at most 64 distinct ids';
  }
  if (projects.length > ORCHESTRATOR_SESSION_MAX_PROJECTS) {
    return 'OrchestratorSession projects must be an array of at most 64 distinct ids';
  }
  const seen = new Set<string>();
  for (const project of projects) {
    const error = stringFieldError('projects', project, false);
    if (error !== null) {
      return error;
    }
    if (seen.has(project as string)) {
      return 'OrchestratorSession projects must be an array of at most 64 distinct ids';
    }
    seen.add(project as string);
  }
  return null;
}

const ARRAY_FIELDS: readonly string[] = ['projects', 'claims', 'scopes'];

function distinctKindsError(
  field: string,
  values: unknown,
  allowed: readonly string[],
  message: string,
): string | null {
  if (!Array.isArray(values)) {
    return message;
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!allowed.includes(value as string) || seen.has(value as string)) {
      return message;
    }
    seen.add(value as string);
  }
  return null;
}

function timestampFieldError(field: string, value: unknown, nullOk: boolean): string | null {
  if (nullOk && value === null) {
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return nullOk
      ? `OrchestratorSession ${field} must be null or a valid timestamp`
      : `OrchestratorSession ${field} must be a valid timestamp`;
  }
  return null;
}

function timesOrderError(input: Record<string, unknown>): string | null {
  const startedAt = Date.parse(input.startedAtIso as string);
  const lastHeartbeat = Date.parse(input.lastHeartbeatIso as string);
  const leaseUntil = Date.parse(input.leaseUntilIso as string);
  if (startedAt > lastHeartbeat || lastHeartbeat >= leaseUntil) {
    return 'OrchestratorSession times must satisfy startedAt <= lastHeartbeat < leaseUntil';
  }
  if (leaseUntil - lastHeartbeat > ORCHESTRATOR_SESSION_MAX_LEASE_SECONDS * 1000) {
    return 'OrchestratorSession lease exceeds 300 seconds past the last heartbeat';
  }
  if (
    input.lastPolledRequestsAtIso !== null &&
    Date.parse(input.lastPolledRequestsAtIso as string) < startedAt
  ) {
    return 'OrchestratorSession lastPolledRequestsAtIso precedes startedAtIso';
  }
  return null;
}
