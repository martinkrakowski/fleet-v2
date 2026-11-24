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
 *    result maps to `refused`. A throw, a rejection, an unconfirmed answer or
 *    a malformed result maps to `unknown` and marks the attempt
 *    indeterminate; a later `startSession` for the same `attemptId` answers
 *    `blocked` with zero further `create` calls.
 *  - **Driver results are untrusted.** They pass the same hostile-input guard
 *    as requests: a `sessionId` that is not a non-empty string of at most 128
 *    characters makes the result `unknown`, and a `completionReceipt` whose
 *    `attemptId` or `sessionId` differs from the session's is reported as
 *    `null`. Every `reason` is an adapter-fixed constant; driver error text
 *    is never forwarded, so no supplied value of 8 or more characters is ever
 *    echoed.
 *  - **Capability is declared, never inferred.** The six fixed capability
 *    keys are read through the hostile-input guard at construction time, not
 *    spread: a non-boolean becomes `false`, an invalid `filesystemScope`
 *    becomes `'unknown'` with `source: 'undeclared'`, and an adapter scope of
 *    `'unknown'` always refuses.
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

/** Why a hostile-input guard refused a value. */
type GuardFailure =
  | 'not-an-object'
  | 'proxy'
  | 'array-like'
  | 'getter'
  | 'prototype-polluting-key'
  | 'unknown-key'
  | 'symbol-key';

/**
 * Guard one supposedly plain object: refuse non-objects, `Proxy` values,
 * array-likes, own getters (inspected with `Object.getOwnPropertyDescriptor`,
 * never invoked), prototype-polluting own keys, symbol keys and any own key
 * outside the declared set. `O(k)` over the object's own keys.
 */
function guardObject(value: unknown, allowedKeys: ReadonlySet<string>): GuardFailure | 'ok' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'not-an-object';
  }
  if (types.isProxy(value)) {
    return 'proxy';
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (length !== undefined && typeof length.value === 'number') {
    return 'array-like';
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    if (PROTO_POLLUTING_KEYS.has(name)) {
      return 'prototype-polluting-key';
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor !== undefined && descriptor.get !== undefined) {
      return 'getter';
    }
    if (!allowedKeys.has(name)) {
      return 'unknown-key';
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return 'symbol-key';
  }
  return 'ok';
}

/** True when a reference string is unusable. Length first: `O(min(n, 4096))`. */
function isInvalidReference(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return true;
  }
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    return true;
  }
  return value.split(/[\\/]/).some((segment) => segment === '..');
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

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
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

/** Read the driver's declared capability profile through the guard, not a spread. */
function declaredCapabilities(capabilities: RunnerIsolationCapabilities): RunnerIsolationCapabilities {
  const scope =
    capabilities.filesystemScope === 'scoped-worktree' ||
    capabilities.filesystemScope === 'inherited-directory'
      ? capabilities.filesystemScope
      : 'unknown';
  const booleans = {} as Record<(typeof CAPABILITY_BOOLEAN_KEYS)[number], boolean>;
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    booleans[key] = capabilities[key] === true;
  }
  if (scope === 'unknown') {
    return { filesystemScope: 'unknown', ...booleans, source: 'undeclared' };
  }
  return { filesystemScope: scope, ...booleans, source: 'declared' };
}

/** Runtime shape check for a driver inspect result; anything else is unreachable. */
function isTrustedInspectResult(value: unknown): value is SandboxInspectResult {
  if (guardObject(value, new Set(Object.keys({
    runnerReachable: true,
    workspacePreparation: true,
    workerCommand: true,
    completionReceipt: true,
    artifactsCollected: true,
  }))) !== 'ok') {
    return false;
  }
  const result = value as SandboxInspectResult;
  return (
    (result.runnerReachable === 'reachable' || result.runnerReachable === 'unreachable') &&
    ['unprepared', 'preparing', 'prepared', 'failed'].includes(result.workspacePreparation) &&
    ['not-started', 'active', 'ended'].includes(result.workerCommand) &&
    (result.completionReceipt === null || typeof result.completionReceipt === 'object') &&
    typeof result.artifactsCollected === 'boolean'
  );
}

/** One attempt's sandbox bookkeeping inside this adapter. */
type EnvironmentRecord =
  | { readonly state: 'live'; readonly sessionId: string }
  | { readonly state: 'indeterminate' };

export class SandboxRunnerAdapter implements ExecutionRunnerPort {
  private readonly environments = new Map<string, EnvironmentRecord>();

  constructor(private readonly options: SandboxRunnerAdapterOptions) {}

  describeCapabilities(): RunnerIsolationCapabilities {
    return declaredCapabilities(this.options.capabilities);
  }

  async startSession(request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult> {
    if (guardObject(request, START_REQUEST_KEYS) !== 'ok') {
      return { outcome: 'refused', reason: REASON_MALFORMED_START };
    }
    if (
      guardObject(request.requiredCapabilities, CAPABILITY_KEYS) !== 'ok' ||
      (request.seatOverride !== undefined &&
        guardObject(request.seatOverride, SEAT_OVERRIDE_KEYS) !== 'ok') ||
      (request.modelAssignment !== undefined &&
        guardObject(request.modelAssignment, MODEL_ASSIGNMENT_KEYS) !== 'ok')
    ) {
      return { outcome: 'refused', reason: REASON_MALFORMED_NESTED };
    }
    const required = request.requiredCapabilities;
    if (
      !['scoped-worktree', 'inherited-directory', 'unknown'].includes(required.filesystemScope) ||
      CAPABILITY_BOOLEAN_KEYS.some((key) => typeof required[key] !== 'boolean') ||
      (required.source !== undefined &&
        required.source !== 'declared' &&
        required.source !== 'undeclared' &&
        required.source !== 'legacy-asserted')
    ) {
      return { outcome: 'refused', reason: REASON_MALFORMED_NESTED };
    }
    if (
      !isValidAttemptId(request.attemptId) ||
      isInvalidReference(request.worktreePath) ||
      isInvalidReference(request.briefPackagePath) ||
      isInvalidReference(request.baseCommit)
    ) {
      return { outcome: 'refused', reason: REASON_INVALID_REFERENCE };
    }
    if (!isFinitePositive(request.stepLimit) || !isFinitePositive(request.timeLimitSeconds)) {
      return { outcome: 'refused', reason: REASON_INVALID_LIMITS };
    }
    const seatOverride = request.seatOverride;
    const model = seatOverride?.model ?? request.model ?? request.modelAssignment?.model;
    if (!isValidSeatValue(model) || !AGY_MODEL_PATTERN.test(model)) {
      return { outcome: 'refused', reason: REASON_INVALID_MODEL };
    }
    const agent = seatOverride?.agent ?? request.agent ?? request.modelAssignment?.agent;
    const variant = seatOverride?.variant ?? request.variant ?? request.modelAssignment?.variant;
    if ((agent !== undefined && !isValidSeatValue(agent)) || (variant !== undefined && !isValidSeatValue(variant))) {
      return { outcome: 'refused', reason: REASON_INVALID_SEAT_VALUE };
    }
    const capabilities = this.describeCapabilities();
    if (
      capabilities.filesystemScope === 'unknown' ||
      required.filesystemScope !== capabilities.filesystemScope ||
      CAPABILITY_BOOLEAN_KEYS.some(
        (key) => required[key] === true && capabilities[key] === false,
      )
    ) {
      return { outcome: 'refused', reason: REASON_CAPABILITIES };
    }
    if (this.environments.has(request.attemptId)) {
      return { outcome: 'blocked', reason: REASON_LIVE };
    }

    const payload: SandboxCreatePayload = {
      attemptId: request.attemptId,
      worktreePath: request.worktreePath,
      briefPackagePath: request.briefPackagePath,
      baseCommit: request.baseCommit,
      stepLimit: request.stepLimit,
      timeLimitSeconds: request.timeLimitSeconds,
      model,
      ...(agent !== undefined ? { agent } : {}),
      ...(variant !== undefined ? { variant } : {}),
    };

    let result: unknown;
    try {
      result = await this.options.driver.create(payload);
    } catch {
      this.environments.set(request.attemptId, { state: 'indeterminate' });
      return { outcome: 'unknown', reason: REASON_CREATE_UNKNOWN };
    }

    if (
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      (result as { outcome?: unknown }).outcome === 'confirmed'
    ) {
      const sessionId = (result as { sessionId?: unknown }).sessionId;
      if (isValidSessionId(sessionId)) {
        this.environments.set(request.attemptId, { state: 'live', sessionId });
        return { outcome: 'started', sessionId };
      }
    }
    if (
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      (result as { outcome?: unknown }).outcome === 'refused'
    ) {
      return { outcome: 'refused', reason: REASON_CREATE_REFUSED };
    }

    this.environments.set(request.attemptId, { state: 'indeterminate' });
    return { outcome: 'unknown', reason: REASON_CREATE_UNKNOWN };
  }

  async inspectSession(session: RunnerSessionRef): Promise<RunnerSessionStatus> {
    if (
      guardObject(session, SESSION_REF_KEYS) !== 'ok' ||
      !isValidAttemptId(session.attemptId) ||
      !isValidSessionId(session.sessionId) ||
      (session.worktreePath !== undefined && isInvalidReference(session.worktreePath)) ||
      (session.runner !== undefined &&
        session.runner !== null &&
        guardObject(session.runner, RUNNER_RECORD_KEYS) !== 'ok')
    ) {
      return unreachableStatus();
    }

    let result: unknown;
    try {
      result = await this.options.driver.inspect(session.sessionId);
    } catch {
      return unreachableStatus();
    }
    if (!isTrustedInspectResult(result)) {
      return unreachableStatus();
    }

    const receipt = result.completionReceipt;
    const trustedReceipt =
      receipt !== null &&
      typeof receipt === 'object' &&
      !Array.isArray(receipt) &&
      (receipt as CommandCompletionReceipt).attemptId === session.attemptId &&
      (receipt as CommandCompletionReceipt).sessionId === session.sessionId
        ? (receipt as CommandCompletionReceipt)
        : null;

    return {
      runnerReachable: result.runnerReachable,
      workspacePreparation: result.workspacePreparation,
      workerCommand: result.workerCommand,
      completionReceipt: trustedReceipt,
      artifactsCollected: result.artifactsCollected,
    };
  }

  async stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
    if (
      guardObject(request, STOP_REQUEST_KEYS) !== 'ok' ||
      !isValidAttemptId(request.attemptId) ||
      !isValidSessionId(request.sessionId) ||
      !isFiniteNonNegative(request.gracePeriodSeconds) ||
      (request.worktreePath !== undefined && isInvalidReference(request.worktreePath)) ||
      (request.runner !== undefined &&
        request.runner !== null &&
        guardObject(request.runner, RUNNER_RECORD_KEYS) !== 'ok')
    ) {
      return { outcome: 'refused', reason: REASON_MALFORMED_STOP };
    }

    const record = this.environments.get(request.attemptId);
    if (record === undefined || (record.state === 'live' && record.sessionId !== request.sessionId)) {
      return { outcome: 'refused', reason: REASON_UNKNOWN_SESSION };
    }

    let result: unknown;
    try {
      result = await this.options.driver.destroy(request.sessionId);
    } catch {
      return { outcome: 'unknown', reason: REASON_DESTROY_UNKNOWN };
    }

    if (
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      (result as { outcome?: unknown }).outcome === 'destroyed'
    ) {
      this.environments.delete(request.attemptId);
      const endedAt = (this.options.now ?? (() => new Date()))().toISOString();
      return {
        outcome: 'terminated',
        receipt: {
          attemptId: request.attemptId,
          sessionId: request.sessionId,
          endedAtIso: endedAt,
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: true,
        },
      };
    }
    if (
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      (result as { outcome?: unknown }).outcome === 'still-present'
    ) {
      return { outcome: 'still-running', reason: REASON_STILL_PRESENT };
    }
    return { outcome: 'unknown', reason: REASON_DESTROY_UNKNOWN };
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
