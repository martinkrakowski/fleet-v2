/**
 * RunAttemptEnvironmentUseCase (lane FC8J): drives MicroVmDriverPort through
 * one attempt's lifecycle, in an implementation environment and then a FRESH
 * gate environment. Fake driver only: no real VM, no subprocess, no network,
 * no clock and no randomness; timestamps, ids and digests are inputs.
 *
 * A green run against the fake micro-VM driver is NOT evidence of isolation: the fake driver provides no real virtual machine, kernel or network boundary, so nothing here verifies containment of any kind.
 *
 * Hostile-input rule: every untrusted value (the request, the `create`
 * outcome, and the `injectWorktree`, `seal`, `runWork`, `runGate` and
 * `destroy` outcomes) goes through `snapshotPlainData` (with the positional
 * `isProxy` detector) BEFORE any property is read; only the frozen plain
 * copy is inspected, and an own `__proto__`/`constructor`/`prototype` key, an
 * extra key or a missing key is a refusal. A throwing or rejecting step is a
 * refusal of that step. No rejected value is ever stringified or echoed.
 *
 * Cost bounds: the request snapshot visits at most 8 nodes (depth 2, 8 keys,
 * no arrays, strings up to 512); the `create` snapshot at most 8 nodes (depth
 * 2, 4 keys, strings up to 128); every step outcome at most 4 nodes (depth 1,
 * 2 keys). Key-set checks are O(8). Id, worktreeRef and nowIso checks are
 * length-checked before any regex or split, so each is O(1) in the bounded
 * length. The seen-environment-id set is O(1) per check and holds one entry
 * per environment this instance created.
 */

import { snapshotPlainData, type IsProxy } from '@fleet/shared';
import {
  DISCLAIMER,
  type DeclaredIsolationLabel,
  type RunAttemptEnvironmentFailureReason,
  type RunAttemptEnvironmentPort,
  type RunAttemptEnvironmentRequest,
  type RunAttemptEnvironmentResult,
} from '../ports/in/RunAttemptEnvironmentPort.in-port.js';
import type { MicroVmDriverPort, MicroVmHandle, MicroVmIsolation } from '../ports/out/MicroVmDriverPort.out-port.js';

export { DISCLAIMER };

export type AttemptEnvironmentStepOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type AttemptEnvironmentStep = (handle: MicroVmHandle) => Promise<AttemptEnvironmentStepOutcome>;

export interface RunAttemptEnvironmentDependencies {
  readonly driver: MicroVmDriverPort;
  readonly runGate: AttemptEnvironmentStep;
  readonly runWork?: AttemptEnvironmentStep;
}

const RESERVED_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
const REQUEST_KEYS: readonly string[] = ['attemptId', 'worktreeRef', 'isolation', 'nowIso'];
const CREATE_OK_KEYS: readonly string[] = ['ok', 'handle'];
const CREATE_FAILED_KEYS: readonly string[] = ['ok', 'reason'];
const HANDLE_KEYS: readonly string[] = ['environmentId', 'attemptId', 'isolation'];
const STEP_OK_KEYS: readonly string[] = ['ok'];
const STEP_FAILED_KEYS: readonly string[] = ['ok', 'reason'];

const REQUEST_LIMITS = { maxDepth: 2, maxKeys: 8, maxArrayLength: 0, maxNodes: 8, maxStringLength: 512 } as const;
const CREATE_LIMITS = { maxDepth: 2, maxKeys: 4, maxArrayLength: 0, maxNodes: 8, maxStringLength: 128 } as const;
const STEP_LIMITS = { maxDepth: 1, maxKeys: 2, maxArrayLength: 0, maxNodes: 4, maxStringLength: 128 } as const;

const MAX_ATTEMPT_ID_LENGTH = 123;
const MAX_HANDLE_ID_LENGTH = 128;
const MAX_WORKTREE_REF_LENGTH = 512;
const MAX_NOW_ISO_LENGTH = 64;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._-]{1,123}$/;
const HANDLE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ISOLATIONS: ReadonlySet<string> = new Set(['microvm', 'user-space-kernel']);

/** True when any character has a char code below 0x20 or equal to 0x7f. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

type Phase = 'impl' | 'gate';

type ValidatedRequest = Readonly<RunAttemptEnvironmentRequest>;

/** The label every result carries: a declaration, never a verification. */
function declaredIsolation(): DeclaredIsolationLabel {
  return { source: 'declared', label: 'fake-driver' };
}

function refuse(reason: RunAttemptEnvironmentFailureReason): RunAttemptEnvironmentResult {
  return { ok: false, reason, isolation: declaredIsolation(), disclaimer: DISCLAIMER };
}

/**
 * Read a SNAPSHOTTED value as an exact record: a non-null non-array object
 * whose own string keys are all in `allowedKeys` (never a reserved key) and
 * which carries every key in `requiredKeys`. Only ever called on the frozen
 * plain copy `snapshotPlainData` returns, so `Array.isArray` and
 * `Reflect.ownKeys` cannot meet a Proxy; the `try/catch` is a second guard.
 * Cost: O(keys), at most the snapshot's key bound.
 */
function readExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || RESERVED_KEYS.includes(key) || !allowedKeys.includes(key)) {
        return null;
      }
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(value, key)) {
        return null;
      }
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when `path` names `field` or one of its descendants. */
function pathIsWithin(path: string, field: string): boolean {
  return path === field || path.startsWith(`${field}.`);
}

function refusalForSnapshotPath(path: string | null): RunAttemptEnvironmentFailureReason {
  if (path === null) {
    return 'invalid-input';
  }
  if (pathIsWithin(path, 'attemptId')) {
    return 'invalid-attempt-id';
  }
  if (pathIsWithin(path, 'worktreeRef')) {
    return 'invalid-worktree-ref';
  }
  if (pathIsWithin(path, 'isolation')) {
    return 'unsupported-isolation';
  }
  if (pathIsWithin(path, 'nowIso')) {
    return 'invalid-now-iso';
  }
  return 'invalid-input';
}

function isValidAttemptId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_ATTEMPT_ID_LENGTH) {
    return false;
  }
  return ATTEMPT_ID_PATTERN.test(value);
}

function isValidHandleId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_HANDLE_ID_LENGTH) {
    return false;
  }
  return HANDLE_ID_PATTERN.test(value);
}

/** A non-empty relative string of at most 512 characters with no control character and no `..` segment. */
function isValidWorktreeRef(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_WORKTREE_REF_LENGTH) {
    return false;
  }
  if (hasControlCharacter(value)) {
    return false;
  }
  if (/^(?:[\\/]|[A-Za-z]:)/.test(value)) {
    return false;
  }
  for (const segment of value.split(/[\\/]/)) {
    if (segment === '..') {
      return false;
    }
  }
  return true;
}

function isValidNowIso(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_NOW_ISO_LENGTH) {
    return false;
  }
  return !hasControlCharacter(value);
}

function isIsolation(value: unknown): value is MicroVmIsolation {
  return typeof value === 'string' && ISOLATIONS.has(value);
}

function readRequest(
  raw: unknown,
  isProxy: IsProxy,
): { readonly ok: true; readonly request: ValidatedRequest } | { readonly ok: false; readonly reason: RunAttemptEnvironmentFailureReason } {
  const snapshot = snapshotPlainData(raw, isProxy, REQUEST_LIMITS);
  if (!snapshot.ok) {
    return { ok: false, reason: refusalForSnapshotPath(snapshot.path) };
  }
  const record = readExactRecord(snapshot.value, [], REQUEST_KEYS);
  if (record === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  const attemptId = Object.hasOwn(record, 'attemptId') ? record['attemptId'] : undefined;
  if (!isValidAttemptId(attemptId)) {
    return { ok: false, reason: 'invalid-attempt-id' };
  }
  const worktreeRef = Object.hasOwn(record, 'worktreeRef') ? record['worktreeRef'] : undefined;
  if (!isValidWorktreeRef(worktreeRef)) {
    return { ok: false, reason: 'invalid-worktree-ref' };
  }
  const isolation = Object.hasOwn(record, 'isolation') ? record['isolation'] : undefined;
  if (!isIsolation(isolation)) {
    return { ok: false, reason: 'unsupported-isolation' };
  }
  const nowIso = Object.hasOwn(record, 'nowIso') ? record['nowIso'] : undefined;
  if (!isValidNowIso(nowIso)) {
    return { ok: false, reason: 'invalid-now-iso' };
  }
  return { ok: true, request: { attemptId, worktreeRef, isolation, nowIso } };
}

/**
 * The one shared validator for the `injectWorktree`, `seal`, `runWork`,
 * `runGate` and `destroy` outcomes: snapshot first, then an exact `{ ok: true }`
 * or `{ ok: false, reason: <non-empty string> }`; null for anything else.
 * Nothing is read from `raw` before the snapshot succeeds.
 */
export function readStepOutcome(raw: unknown, isProxy: IsProxy): AttemptEnvironmentStepOutcome | null {
  const snapshot = snapshotPlainData(raw, isProxy, STEP_LIMITS);
  if (!snapshot.ok) {
    return null;
  }
  const record = readExactRecord(snapshot.value, ['ok'], STEP_FAILED_KEYS);
  if (record === null) {
    return null;
  }
  const ok = record['ok'];
  if (ok === true) {
    return readExactRecord(record, STEP_OK_KEYS, STEP_OK_KEYS) === null ? null : { ok: true };
  }
  if (ok === false) {
    if (readExactRecord(record, STEP_FAILED_KEYS, STEP_FAILED_KEYS) === null) {
      return null;
    }
    const reason = record['reason'];
    if (typeof reason !== 'string' || reason.length === 0) {
      return null;
    }
    return { ok: false, reason };
  }
  return null;
}

/** Validate the whole `create` outcome and rebuild a clean handle; null for anything else. */
function readCreatedHandle(
  raw: unknown,
  isProxy: IsProxy,
  expectedAttemptId: string,
  expectedIsolation: MicroVmIsolation,
): MicroVmHandle | null {
  const snapshot = snapshotPlainData(raw, isProxy, CREATE_LIMITS);
  if (!snapshot.ok) {
    return null;
  }
  const record = readExactRecord(snapshot.value, ['ok'], CREATE_OK_KEYS.concat(CREATE_FAILED_KEYS));
  if (record === null || typeof record['ok'] !== 'boolean') {
    return null;
  }
  if (record['ok'] === false) {
    // A well-formed refusal and a malformed one are both `create-failed`; the
    // shape is still checked so nothing unread is ever treated as a reason.
    return null;
  }
  if (readExactRecord(record, CREATE_OK_KEYS, CREATE_OK_KEYS) === null) {
    return null;
  }
  const handle = readExactRecord(record['handle'], HANDLE_KEYS, HANDLE_KEYS);
  if (handle === null) {
    return null;
  }
  const environmentId = handle['environmentId'];
  const attemptId = handle['attemptId'];
  const isolation = handle['isolation'];
  if (!isValidHandleId(environmentId) || !isValidHandleId(attemptId) || attemptId !== expectedAttemptId) {
    return null;
  }
  if (!isIsolation(isolation) || isolation !== expectedIsolation) {
    return null;
  }
  return Object.freeze({ environmentId, attemptId, isolation });
}

export class RunAttemptEnvironmentUseCase implements RunAttemptEnvironmentPort {
  private readonly driver: MicroVmDriverPort;
  private readonly runGate: AttemptEnvironmentStep;
  private readonly runWork: AttemptEnvironmentStep | undefined;
  /** Every environment id this instance has seen created, across phases and attempts. */
  private readonly seenEnvironmentIds = new Set<string>();

  constructor(
    dependencies: RunAttemptEnvironmentDependencies,
    private readonly isProxy: IsProxy = () => false,
  ) {
    this.driver = dependencies.driver;
    this.runGate = dependencies.runGate;
    this.runWork = dependencies.runWork;
  }

  async execute(request: unknown): Promise<RunAttemptEnvironmentResult> {
    try {
      const parsed = readRequest(request, this.isProxy);
      if (!parsed.ok) {
        return refuse(parsed.reason);
      }
      if (!this.portsAvailable()) {
        return refuse('unavailable');
      }
      const implementation = await this.runPhase('impl', parsed.request, this.runWork);
      if (!implementation.ok) {
        return refuse(implementation.reason);
      }
      const gate = await this.runPhase('gate', parsed.request, this.runGate);
      if (!gate.ok) {
        return refuse(gate.reason);
      }
      return {
        ok: true,
        attemptId: parsed.request.attemptId,
        implementationEnvironmentId: implementation.environmentId,
        gateEnvironmentId: gate.environmentId,
        isolation: declaredIsolation(),
        disclaimer: DISCLAIMER,
      };
    } catch {
      // Nothing above is expected to throw; an unexpected throw is a refusal, never an escape.
      return refuse('unavailable');
    }
  }

  /** Every required driver and gate method is present; a present but non-function `runWork` is unavailable. */
  private portsAvailable(): boolean {
    try {
      const driver = this.driver as unknown as Record<string, unknown> | null | undefined;
      if (driver === null || driver === undefined) {
        return false;
      }
      for (const method of ['create', 'injectWorktree', 'seal', 'destroy']) {
        if (typeof driver[method] !== 'function') {
          return false;
        }
      }
      if (typeof this.runGate !== 'function') {
        return false;
      }
      return this.runWork === undefined || typeof this.runWork === 'function';
    } catch {
      return false;
    }
  }

  /**
   * One environment: create, inject, seal, the phase's own step (work or gate;
   * work is skipped when absent), and a destroy that runs once for every
   * created handle on every path. A create failure or an invalid/mismatched
   * handle never reaches a later step and is never destroyed.
   */
  private async runPhase(
    phase: Phase,
    request: ValidatedRequest,
    runStep: AttemptEnvironmentStep | undefined,
  ): Promise<
    | { readonly ok: true; readonly environmentId: string }
    | { readonly ok: false; readonly reason: RunAttemptEnvironmentFailureReason }
  > {
    const phaseAttemptId = `${request.attemptId}.${phase}`;
    let createRaw: unknown;
    try {
      createRaw = await this.driver.create({ attemptId: phaseAttemptId, isolation: request.isolation });
    } catch {
      return { ok: false, reason: 'create-failed' };
    }
    const handle = readCreatedHandle(createRaw, this.isProxy, phaseAttemptId, request.isolation);
    if (handle === null) {
      return { ok: false, reason: 'create-failed' };
    }
    if (this.seenEnvironmentIds.has(handle.environmentId)) {
      return { ok: false, reason: 'environment-id-reused' };
    }
    this.seenEnvironmentIds.add(handle.environmentId);

    let failure: RunAttemptEnvironmentFailureReason | null = null;
    let destroyed = false;
    try {
      failure = await this.driveSteps(phase, handle, request, runStep);
    } finally {
      destroyed = await this.destroyHandle(handle);
    }
    if (failure !== null) {
      return { ok: false, reason: failure };
    }
    if (!destroyed) {
      // A success whose environment may still exist is not a success; the
      // reason set has no destroy-specific code, so it is `unavailable`.
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, environmentId: handle.environmentId };
  }

  private async driveSteps(
    phase: Phase,
    handle: MicroVmHandle,
    request: ValidatedRequest,
    runStep: AttemptEnvironmentStep | undefined,
  ): Promise<RunAttemptEnvironmentFailureReason | null> {
    if (!(await this.callStep(() => this.driver.injectWorktree(handle, { worktreeRef: request.worktreeRef })))) {
      return 'inject-failed';
    }
    if (!(await this.callStep(() => this.driver.seal(handle)))) {
      return 'seal-failed';
    }
    if (runStep !== undefined && !(await this.callStep(() => runStep(handle)))) {
      return phase === 'gate' ? 'gate-failed' : 'work-failed';
    }
    return null;
  }

  /** Destroy once; the outcome is validated like every step and never throws. */
  private async destroyHandle(handle: MicroVmHandle): Promise<boolean> {
    return this.callStep(() => this.driver.destroy(handle));
  }

  /** One step: a throw, a rejection, a malformed outcome or `ok: false` is `false`; never throws. */
  private async callStep(call: () => Promise<unknown>): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await call();
    } catch {
      return false;
    }
    const outcome = readStepOutcome(raw, this.isProxy);
    return outcome !== null && outcome.ok;
  }
}
