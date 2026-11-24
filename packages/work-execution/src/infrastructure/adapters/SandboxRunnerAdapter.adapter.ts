// Implemented adapter — lane FC8A.
/**
 * SandboxRunnerAdapter is an unwired third implementation of
 * `ExecutionRunnerPort` backed by an injected `SandboxDriver`: a process that
 * owns a disposable sandbox environment for one attempt. Nothing here spawns,
 * opens a socket or reads configuration: the adapter is pure validation,
 * capability accounting and outcome mapping on top of the driver contract it
 * declares below. It is deliberately not registered in `RunnerSelectorAdapter`
 * or in any composition root — `RunnerKind` stays `'opencode' | 'agy'` and
 * started results carry no `runner` field, because a sandbox seat has no
 * runner kind until one is declared.
 *
 * Behaviour rules this adapter enforces:
 *
 *  - **Fail-closed starts.** Only a typed driver `{ outcome: 'refused' }`
 *    result with that exact key maps to `refused`. A throw, a rejection, an
 *    unconfirmed answer, a proxy, a getter or any other shape maps to
 *    `unknown` and marks the attempt indeterminate; a later `startSession`
 *    for the same `attemptId` answers `blocked` with zero further `create`
 *    calls. The attempt is reserved synchronously before `create` is awaited,
 *    so two overlapping starts cannot both create.
 *  - **Driver results are untrusted.** Create, destroy and inspect answers
 *    pass the same guard as requests: own data descriptors only, a prototype
 *    of `Object.prototype` or `null`, and the exact key set. A `sessionId`
 *    that is not a non-empty string of at most 128 characters makes a create
 *    result `unknown`. A nested `completionReceipt` is guarded before its
 *    ids are read; a mismatch or a hostile receipt is reported as `null`.
 *    Every `reason` is an adapter-fixed constant; driver error text is never
 *    forwarded, so no supplied value of 8 or more characters is ever echoed.
 *  - **No confirmed session, no destroy.** `destroy` runs only for a live
 *    environment whose stored `sessionId` matches the request. An unknown,
 *    in-flight or indeterminate attempt is refused, and `destroy` is not
 *    called with a session id the driver never confirmed.
 *  - **Capability is declared, never inferred.** The six fixed capability
 *    keys are read through the hostile-input guard, not spread and not from
 *    inherited accessors. A non-boolean data value becomes `false`. A getter,
 *    a proxy or any other non-plain profile becomes `filesystemScope:
 *    'unknown'` with `source: 'undeclared'`. An adapter scope of `'unknown'`
 *    always refuses.
 *  - **No side doors.** No filesystem, subprocess, network or environment
 *    access appears in this file; `worktreePath`, `briefPackagePath` and
 *    `baseCommit` are opaque references, validated and passed unchanged,
 *    never resolved or opened.
 */

import { types } from 'node:util';

import type { CommandCompletionReceipt } from '../../domain/execution-records.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionRef,
  RunnerSessionStatus,
  StartRunnerSessionRequest,
  StartRunnerSessionResult,
  StopRunnerSessionRequest,
  StopRunnerSessionResult,
  WorkspacePreparationState,
  WorkerCommandPhase,
} from '../../application/ports/out/ExecutionRunnerPort.out-port.js';
import { AGY_MODEL_PATTERN } from './AgyRunnerAdapter.adapter.js';

/** The exact payload handed to `SandboxDriver.create` — and nothing else. */
export interface SandboxCreatePayload {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly briefPackagePath: string;
  readonly baseCommit: string;
  readonly stepLimit: number;
  readonly timeLimitSeconds: number;
  readonly model: string;
  readonly agent?: string;
  readonly variant?: string;
}

/**
 * The typed answer a sandbox driver must give for a create. Any other shape —
 * including a throw, a rejection or extra fields on these shapes — is treated
 * as unconfirmed by the adapter.
 */
export type SandboxCreateResult =
  | { readonly outcome: 'confirmed'; readonly sessionId: string }
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unconfirmed' };

/** The separately tracked states a sandbox driver reports for one session. */
export interface SandboxInspectResult {
  readonly runnerReachable: 'reachable' | 'unreachable';
  readonly workspacePreparation: WorkspacePreparationState;
  readonly workerCommand: WorkerCommandPhase;
  readonly completionReceipt: CommandCompletionReceipt | null;
  readonly artifactsCollected: boolean;
}

/** The typed answer a sandbox driver must give for a destroy. */
export type SandboxDestroyResult =
  | { readonly outcome: 'destroyed' }
  | { readonly outcome: 'still-present' }
  | { readonly outcome: 'unconfirmed' };

/**
 * The sandbox driver contract this adapter is built on. Implementations own
 * every real effect; the adapter never performs one itself.
 */
export interface SandboxDriver {
  create(payload: SandboxCreatePayload): Promise<SandboxCreateResult>;
  inspect(sessionId: string): Promise<SandboxInspectResult>;
  destroy(sessionId: string): Promise<SandboxDestroyResult>;
}

export interface SandboxRunnerAdapterOptions {
  readonly driver: SandboxDriver;
  readonly capabilities: RunnerIsolationCapabilities;
  /** Clock for completion receipts; injectable so tests stay deterministic. */
  readonly now?: () => Date;
}

/** Fixed refusal reasons: adapter-owned constants, never driver text. */
const REASON_MALFORMED_START = 'Runner start request is malformed or hostile';
const REASON_MALFORMED_NESTED = 'Runner start request carries a malformed nested record';
const REASON_INVALID_REFERENCE = 'Runner start request carries an invalid reference or identity';
const REASON_INVALID_LIMITS = 'Runner start request carries non-positive or non-finite limits';
const REASON_INVALID_MODEL = 'Model is missing or malformed';
const REASON_INVALID_SEAT_VALUE = 'Agent or variant is missing or malformed';
const REASON_CAPABILITIES = 'Runner does not satisfy required isolation capabilities';
const REASON_LIVE = 'Attempt already has a live or indeterminate sandbox environment';
const REASON_CREATE_REFUSED = 'Sandbox driver refused to create the environment';
const REASON_CREATE_UNKNOWN = 'Sandbox driver result was unconfirmed or malformed';
const REASON_MALFORMED_STOP = 'Stop request is malformed or hostile';
const REASON_UNKNOWN_SESSION = 'Session is not known to this sandbox runner';
const REASON_DESTROY_UNKNOWN = 'Sandbox driver did not answer the destroy request';
const REASON_STILL_PRESENT = 'Sandbox driver reports the environment still present';

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PROTO_POLLUTING_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const CAPABILITY_BOOLEAN_KEYS = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'authoritativeCompletion',
  'artifactPersistence',
] as const;

const START_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'attemptId',
  'worktreePath',
  'briefPackagePath',
  'baseCommit',
  'stepLimit',
  'timeLimitSeconds',
  'requiredCapabilities',
  'agent',
  'model',
  'variant',
  'seatOverride',
  'modelAssignment',
]);

const CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  'filesystemScope',
  ...CAPABILITY_BOOLEAN_KEYS,
  'source',
]);

const SEAT_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'agent',
  'variant',
  'reason',
  'setBy',
  'expiresAtIso',
]);

const MODEL_ASSIGNMENT_KEYS: ReadonlySet<string> = new Set([
  'model',
  'variant',
  'fallbackModel',
  'agent',
]);

const SESSION_REF_KEYS: ReadonlySet<string> = new Set([
  'attemptId',
  'sessionId',
  'worktreePath',
  'runner',
]);

const STOP_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'attemptId',
  'sessionId',
  'gracePeriodSeconds',
  'worktreePath',
  'runner',
]);

const RUNNER_RECORD_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'remotePort',
  'host',
  'hostName',
  'agent',
  'model',
  'variant',
  'useFreeSeats',
]);

/** Own-key cap. Every guarded record's declared key set is at most this big. */
const MAX_OWN_KEYS = 16;

type ReadFailure =
  | 'not-an-object'
  | 'proxy'
  | 'bad-prototype'
  | 'array-like'
  | 'getter'
  | 'prototype-polluting-key'
  | 'unknown-key'
  | 'symbol-key';

type ReadResult =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly failure: ReadFailure };

/**
 * Copy one supposedly plain object into a null-prototype record.
 *
 * Refuses non-objects, `Proxy` values (checked before any trap can run),
 * prototypes other than `Object.prototype` or `null`, array-likes, own
 * getters (the descriptor is inspected, never invoked), prototype-polluting
 * own keys, symbol keys and any own key outside `allowedKeys`. Values are
 * taken only from those own data descriptors. Own-key inspection stops at
 * `MAX_OWN_KEYS`.
 */
function readPlain(value: unknown, allowedKeys: ReadonlySet<string>): ReadResult {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, failure: 'not-an-object' };
    }
    if (types.isProxy(value)) {
      return { ok: false, failure: 'proxy' };
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, failure: 'bad-prototype' };
    }
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      length !== undefined &&
      length.get === undefined &&
      length.set === undefined &&
      typeof length.value === 'number'
    ) {
      return { ok: false, failure: 'array-like' };
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_OWN_KEYS || names.length > allowedKeys.size) {
      return { ok: false, failure: 'unknown-key' };
    }
    const data: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      if (PROTO_POLLUTING_KEYS.has(name)) {
        return { ok: false, failure: 'prototype-polluting-key' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !('value' in descriptor)
      ) {
        return { ok: false, failure: 'getter' };
      }
      if (!allowedKeys.has(name)) {
        return { ok: false, failure: 'unknown-key' };
      }
      Object.defineProperty(data, name, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { ok: false, failure: 'symbol-key' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, failure: 'not-an-object' };
  }
}

function hasExactOwnKeys(data: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(data);
  if (own.length !== keys.length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.hasOwn(data, key)) {
      return false;
    }
  }
  return true;
}

/**
 * Read an optional nested record from an already-copied parent.
 * `null` is absent when `nullIsAbsent` and hostile otherwise.
 */
function readNested(
  data: Record<string, unknown>,
  key: string,
  allowedKeys: ReadonlySet<string>,
  nullIsAbsent: boolean,
): { readonly ok: true; readonly value: Record<string, unknown> | undefined } | { readonly ok: false } {
  if (!Object.hasOwn(data, key) || data[key] === undefined) {
    return { ok: true, value: undefined };
  }
  if (data[key] === null) {
    return nullIsAbsent ? { ok: true, value: undefined } : { ok: false };
  }
  const read = readPlain(data[key], allowedKeys);
  if (!read.ok) {
    return { ok: false };
  }
  return { ok: true, value: read.data };
}

/**
 * An opaque path or commit reference, or `null` when it is unusable.
 * Length is checked before any scan: `O(min(n, 4096))`.
 */
function asReference(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return null;
  }
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    return null;
  }
  if (value.split(/[\\/]/).some((segment) => segment === '..')) {
    return null;
  }
  return value;
}

/** An optional plain seat value: short, printable, never flag-shaped. */
function isValidSeatValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !value.startsWith('-') &&
    !/\s/.test(value) &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

/** A present seat string, `undefined` when absent, or `null` when present but unusable. */
function optionalSeat(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return isValidSeatValue(value) ? value : null;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidAttemptId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return false;
  }
  return ATTEMPT_ID_PATTERN.test(value);
}

function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Nothing observed, nothing concluded: the fail-closed unreachable status. */
function unreachableStatus(): RunnerSessionStatus {
  return {
    runnerReachable: 'unreachable',
    workspacePreparation: 'unprepared',
    workerCommand: 'not-started',
    completionReceipt: null,
    artifactsCollected: false,
  };
}

function failClosedCapabilities(): RunnerIsolationCapabilities {
  return {
    filesystemScope: 'unknown',
    networkEgressRestricted: false,
    cpuAndMemoryLimited: false,
    processTreeTermination: false,
    authoritativeCompletion: false,
    artifactPersistence: false,
    source: 'undeclared',
  };
}

/** Read the driver's declared capability profile through the guard, not a spread. */
function declaredCapabilities(capabilities: unknown): RunnerIsolationCapabilities {
  const read = readPlain(capabilities, CAPABILITY_KEYS);
  if (!read.ok) {
    return failClosedCapabilities();
  }
  const scopeValue = read.data.filesystemScope;
  let scope: 'scoped-worktree' | 'inherited-directory' | 'unknown' = 'unknown';
  if (scopeValue === 'scoped-worktree' || scopeValue === 'inherited-directory') {
    scope = scopeValue;
  }
  const networkEgressRestricted = read.data.networkEgressRestricted === true;
  const cpuAndMemoryLimited = read.data.cpuAndMemoryLimited === true;
  const processTreeTermination = read.data.processTreeTermination === true;
  const authoritativeCompletion = read.data.authoritativeCompletion === true;
  const artifactPersistence = read.data.artifactPersistence === true;
  if (scope === 'unknown') {
    return {
      filesystemScope: 'unknown',
      networkEgressRestricted,
      cpuAndMemoryLimited,
      processTreeTermination,
      authoritativeCompletion,
      artifactPersistence,
      source: 'undeclared',
    };
  }
  return {
    filesystemScope: scope,
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    authoritativeCompletion,
    artifactPersistence,
    source: 'declared',
  };
}

function isWellTypedRequired(data: Record<string, unknown>): boolean {
  const scope = data.filesystemScope;
  if (scope !== 'scoped-worktree' && scope !== 'inherited-directory' && scope !== 'unknown') {
    return false;
  }
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    if (typeof data[key] !== 'boolean') {
      return false;
    }
  }
  if (!Object.hasOwn(data, 'source')) {
    return true;
  }
  return data.source === 'declared' || data.source === 'undeclared' || data.source === 'legacy-asserted';
}

const CREATE_ALLOWED_KEYS: ReadonlySet<string> = new Set(['outcome', 'sessionId']);
const CREATE_CONFIRMED_KEYS = ['outcome', 'sessionId'] as const;
const CREATE_REFUSED_KEYS = ['outcome'] as const;
const DESTROY_KEYS = ['outcome'] as const;
const DESTROY_ALLOWED_KEYS: ReadonlySet<string> = new Set(DESTROY_KEYS);
const INSPECT_KEY_LIST = [
  'runnerReachable',
  'workspacePreparation',
  'workerCommand',
  'completionReceipt',
  'artifactsCollected',
] as const;
const INSPECT_KEYS: ReadonlySet<string> = new Set(INSPECT_KEY_LIST);
const RECEIPT_KEY_LIST = [
  'attemptId',
  'sessionId',
  'endedAtIso',
  'authoritative',
  'exitStatus',
  'stoppedByRequest',
] as const;
const RECEIPT_KEYS: ReadonlySet<string> = new Set(RECEIPT_KEY_LIST);

type ClassifiedCreate =
  | { readonly kind: 'started'; readonly sessionId: string }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unknown' };

/** Exact create shapes only. Anything else, including a throw, is unconfirmed. */
function classifyCreate(value: unknown): ClassifiedCreate {
  try {
    const read = readPlain(value, CREATE_ALLOWED_KEYS);
    if (!read.ok) {
      return { kind: 'unknown' };
    }
    if (
      read.data.outcome === 'confirmed' &&
      hasExactOwnKeys(read.data, CREATE_CONFIRMED_KEYS) &&
      isValidSessionId(read.data.sessionId)
    ) {
      return { kind: 'started', sessionId: read.data.sessionId };
    }
    if (read.data.outcome === 'refused' && hasExactOwnKeys(read.data, CREATE_REFUSED_KEYS)) {
      return { kind: 'refused' };
    }
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function classifyDestroy(value: unknown): 'destroyed' | 'still-present' | 'unknown' {
  try {
    const read = readPlain(value, DESTROY_ALLOWED_KEYS);
    if (!read.ok || !hasExactOwnKeys(read.data, DESTROY_KEYS)) {
      return 'unknown';
    }
    if (read.data.outcome === 'destroyed') {
      return 'destroyed';
    }
    if (read.data.outcome === 'still-present') {
      return 'still-present';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function isWorkspaceState(value: unknown): value is WorkspacePreparationState {
  return value === 'unprepared' || value === 'preparing' || value === 'prepared' || value === 'failed';
}

function isWorkerPhase(value: unknown): value is WorkerCommandPhase {
  return value === 'not-started' || value === 'active' || value === 'ended';
}

/**
 * A receipt is trusted only when its own data matches this session.
 * A mismatch or a hostile value is `null` and never throws.
 */
function trustedReceipt(
  value: unknown,
  attemptId: string,
  sessionId: string,
): CommandCompletionReceipt | null {
  if (value === null) {
    return null;
  }
  try {
    const read = readPlain(value, RECEIPT_KEYS);
    if (!read.ok || !hasExactOwnKeys(read.data, RECEIPT_KEY_LIST)) {
      return null;
    }
    if (read.data.attemptId !== attemptId || read.data.sessionId !== sessionId) {
      return null;
    }
    const endedAtIso = read.data.endedAtIso;
    const authoritative = read.data.authoritative;
    const exitStatus = read.data.exitStatus;
    const stoppedByRequest = read.data.stoppedByRequest;
    if (typeof endedAtIso !== 'string' || endedAtIso.length === 0 || endedAtIso.length > 128) {
      return null;
    }
    if (endedAtIso.includes('\0') || endedAtIso.includes('\r') || endedAtIso.includes('\n')) {
      return null;
    }
    if (typeof authoritative !== 'boolean' || typeof stoppedByRequest !== 'boolean') {
      return null;
    }
    let exit: number | null;
    if (exitStatus === null) {
      exit = null;
    } else if (typeof exitStatus === 'number' && Number.isFinite(exitStatus)) {
      exit = exitStatus;
    } else {
      return null;
    }
    return {
      attemptId,
      sessionId,
      endedAtIso,
      authoritative,
      exitStatus: exit,
      stoppedByRequest,
    };
  } catch {
    return null;
  }
}

/** A driver inspect answer, or `null` when the answer itself is unusable. */
function parseInspect(value: unknown, attemptId: string, sessionId: string): RunnerSessionStatus | null {
  try {
    const read = readPlain(value, INSPECT_KEYS);
    if (!read.ok || !hasExactOwnKeys(read.data, INSPECT_KEY_LIST)) {
      return null;
    }
    const runnerReachable = read.data.runnerReachable;
    const workspacePreparation = read.data.workspacePreparation;
    const workerCommand = read.data.workerCommand;
    const artifactsCollected = read.data.artifactsCollected;
    if (runnerReachable !== 'reachable' && runnerReachable !== 'unreachable') {
      return null;
    }
    if (!isWorkspaceState(workspacePreparation) || !isWorkerPhase(workerCommand)) {
      return null;
    }
    if (typeof artifactsCollected !== 'boolean') {
      return null;
    }
    return {
      runnerReachable,
      workspacePreparation,
      workerCommand,
      completionReceipt: trustedReceipt(read.data.completionReceipt, attemptId, sessionId),
      artifactsCollected,
    };
  } catch {
    return null;
  }
}

function completionInstant(now: (() => Date) | undefined): string | null {
  try {
    const instant = (now ?? (() => new Date()))();
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
      return null;
    }
    return instant.toISOString();
  } catch {
    return null;
  }
}

/** One attempt's sandbox bookkeeping inside this adapter. */
type EnvironmentRecord =
  | { readonly state: 'in-flight' }
  | { readonly state: 'live'; readonly sessionId: string }
  | { readonly state: 'indeterminate' };

export class SandboxRunnerAdapter implements ExecutionRunnerPort {
  private readonly environments = new Map<string, EnvironmentRecord>();

  constructor(private readonly options: SandboxRunnerAdapterOptions) {}

  describeCapabilities(): RunnerIsolationCapabilities {
    try {
      return declaredCapabilities(this.options.capabilities);
    } catch {
      return failClosedCapabilities();
    }
  }

  async startSession(request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult> {
    const guarded = readPlain(request, START_REQUEST_KEYS);
    if (!guarded.ok) {
      return { outcome: 'refused', reason: REASON_MALFORMED_START };
    }
    const data = guarded.data;
    const requiredRead = readPlain(data.requiredCapabilities, CAPABILITY_KEYS);
    if (!requiredRead.ok || !isWellTypedRequired(requiredRead.data)) {
      return { outcome: 'refused', reason: REASON_MALFORMED_NESTED };
    }
    const seatRead = readNested(data, 'seatOverride', SEAT_OVERRIDE_KEYS, false);
    const assignmentRead = readNested(data, 'modelAssignment', MODEL_ASSIGNMENT_KEYS, false);
    if (!seatRead.ok || !assignmentRead.ok) {
      return { outcome: 'refused', reason: REASON_MALFORMED_NESTED };
    }
    const required = requiredRead.data;
    const seat = seatRead.value;
    const assignment = assignmentRead.value;

    const attemptId = data.attemptId;
    const worktreePath = asReference(data.worktreePath);
    const briefPackagePath = asReference(data.briefPackagePath);
    const baseCommit = asReference(data.baseCommit);
    if (!isValidAttemptId(attemptId) || worktreePath === null || briefPackagePath === null || baseCommit === null) {
      return { outcome: 'refused', reason: REASON_INVALID_REFERENCE };
    }
    const stepLimit = data.stepLimit;
    const timeLimitSeconds = data.timeLimitSeconds;
    if (!isFinitePositive(stepLimit) || !isFinitePositive(timeLimitSeconds)) {
      return { outcome: 'refused', reason: REASON_INVALID_LIMITS };
    }
    const model = firstPresent(seat?.model, data.model, assignment?.model);
    if (!isValidSeatValue(model) || !AGY_MODEL_PATTERN.test(model)) {
      return { outcome: 'refused', reason: REASON_INVALID_MODEL };
    }
    const agent = optionalSeat(firstPresent(seat?.agent, data.agent, assignment?.agent));
    const variant = optionalSeat(firstPresent(seat?.variant, data.variant, assignment?.variant));
    if (agent === null || variant === null) {
      return { outcome: 'refused', reason: REASON_INVALID_SEAT_VALUE };
    }

    const capabilities = this.describeCapabilities();
    if (
      capabilities.filesystemScope === 'unknown' ||
      required.filesystemScope !== capabilities.filesystemScope ||
      CAPABILITY_BOOLEAN_KEYS.some((key) => required[key] === true && capabilities[key] === false)
    ) {
      return { outcome: 'refused', reason: REASON_CAPABILITIES };
    }
    if (this.environments.has(attemptId)) {
      return { outcome: 'blocked', reason: REASON_LIVE };
    }

    const payload: SandboxCreatePayload = {
      attemptId,
      worktreePath,
      briefPackagePath,
      baseCommit,
      stepLimit,
      timeLimitSeconds,
      model,
      ...(agent !== undefined ? { agent } : {}),
      ...(variant !== undefined ? { variant } : {}),
    };
    // Reserve before the first await. A second start cannot pass the check above
    // until this call has recorded a confirmed refusal or a terminal state.
    this.environments.set(attemptId, { state: 'in-flight' });

    let raw: unknown;
    try {
      raw = await this.options.driver.create(payload);
    } catch {
      this.environments.set(attemptId, { state: 'indeterminate' });
      return { outcome: 'unknown', reason: REASON_CREATE_UNKNOWN };
    }

    const classified = classifyCreate(raw);
    if (classified.kind === 'started') {
      this.environments.set(attemptId, { state: 'live', sessionId: classified.sessionId });
      return { outcome: 'started', sessionId: classified.sessionId };
    }
    if (classified.kind === 'refused') {
      this.environments.delete(attemptId);
      return { outcome: 'refused', reason: REASON_CREATE_REFUSED };
    }
    this.environments.set(attemptId, { state: 'indeterminate' });
    return { outcome: 'unknown', reason: REASON_CREATE_UNKNOWN };
  }

  async inspectSession(session: RunnerSessionRef): Promise<RunnerSessionStatus> {
    const guarded = readPlain(session, SESSION_REF_KEYS);
    if (!guarded.ok) {
      return unreachableStatus();
    }
    const data = guarded.data;
    const attemptId = data.attemptId;
    const sessionId = data.sessionId;
    if (!isValidAttemptId(attemptId) || !isValidSessionId(sessionId)) {
      return unreachableStatus();
    }
    if (Object.hasOwn(data, 'worktreePath') && data.worktreePath !== undefined && asReference(data.worktreePath) === null) {
      return unreachableStatus();
    }
    const runner = readNested(data, 'runner', RUNNER_RECORD_KEYS, true);
    if (!runner.ok) {
      return unreachableStatus();
    }

    let raw: unknown;
    try {
      raw = await this.options.driver.inspect(sessionId);
    } catch {
      return unreachableStatus();
    }
    return parseInspect(raw, attemptId, sessionId) ?? unreachableStatus();
  }

  async stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
    const guarded = readPlain(request, STOP_REQUEST_KEYS);
    if (!guarded.ok) {
      return { outcome: 'refused', reason: REASON_MALFORMED_STOP };
    }
    const data = guarded.data;
    const attemptId = data.attemptId;
    const sessionId = data.sessionId;
    if (
      !isValidAttemptId(attemptId) ||
      !isValidSessionId(sessionId) ||
      !isFiniteNonNegative(data.gracePeriodSeconds)
    ) {
      return { outcome: 'refused', reason: REASON_MALFORMED_STOP };
    }
    if (Object.hasOwn(data, 'worktreePath') && data.worktreePath !== undefined && asReference(data.worktreePath) === null) {
      return { outcome: 'refused', reason: REASON_MALFORMED_STOP };
    }
    const runner = readNested(data, 'runner', RUNNER_RECORD_KEYS, true);
    if (!runner.ok) {
      return { outcome: 'refused', reason: REASON_MALFORMED_STOP };
    }

    const record = this.environments.get(attemptId);
    if (record === undefined || record.state !== 'live' || record.sessionId !== sessionId) {
      return { outcome: 'refused', reason: REASON_UNKNOWN_SESSION };
    }
    const confirmedSessionId = record.sessionId;

    let raw: unknown;
    try {
      raw = await this.options.driver.destroy(confirmedSessionId);
    } catch {
      return { outcome: 'unknown', reason: REASON_DESTROY_UNKNOWN };
    }

    const kind = classifyDestroy(raw);
    if (kind === 'destroyed') {
      const endedAtIso = completionInstant(this.options.now);
      if (endedAtIso === null) {
        return { outcome: 'unknown', reason: REASON_DESTROY_UNKNOWN };
      }
      this.environments.delete(attemptId);
      return {
        outcome: 'terminated',
        receipt: {
          attemptId,
          sessionId: confirmedSessionId,
          endedAtIso,
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: true,
        },
      };
    }
    if (kind === 'still-present') {
      return { outcome: 'still-running', reason: REASON_STILL_PRESENT };
    }
    return { outcome: 'unknown', reason: REASON_DESTROY_UNKNOWN };
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
