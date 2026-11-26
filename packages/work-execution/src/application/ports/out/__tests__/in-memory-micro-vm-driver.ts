/**
 * Shared in-memory fake of MicroVmDriverPort for contract tests (lane FC8D2).
 * It mirrors the port's guarded semantics: every input is refused with a
 * fixed typed reason, never a throw and never a pass; the per-attempt
 * lifecycle is decided by `decideEnvironmentStep` so the fake cannot drift
 * from the domain state machine; and a handle is bound to the exact
 * `(environmentId, attemptId, isolation)` recorded at `create`.
 *
 * Cost bound: O(1) per step. The key count is bounded
 * (`Reflect.ownKeys(value).length <= 8`) before any descriptor read; ids are
 * length-checked (1..128) before the bounded id pattern runs; `worktreeRef`
 * is length-checked (1..512) before the single control-character scan and
 * the segment split. Nothing here spawns, opens a socket or names a vendor,
 * and no worktree content is ever stored — only call metadata.
 *
 * This file holds no `describe`/`it`: vitest only collects `*.test.ts`.
 */

import {
  INITIAL_ATTEMPT_ENVIRONMENT_STATE,
  decideEnvironmentStep,
  type AttemptEnvironmentState,
} from '../../../../domain/attempt-environment.js';
import type {
  MicroVmDriverPort,
  MicroVmHandle,
  MicroVmIsolation,
} from '../MicroVmDriverPort.out-port.js';

export interface InMemoryMicroVmDriverConfig {
  /** The isolation kinds this driver accepts; anything else is refused, never downgraded. */
  readonly supportedIsolations?: readonly MicroVmIsolation[];
  /** A step configured here always fails with `failureReason`. */
  readonly failOnStep?: 'create' | 'injectWorktree' | 'seal' | 'destroy';
  /** The reason a configured-failure step reports. */
  readonly failureReason?: 'unavailable' | 'refused';
}

/** One recorded call, for test inspection only. Never carries worktree contents. */
export interface InMemoryMicroVmDriverCall {
  readonly step: 'create' | 'injectWorktree' | 'seal' | 'destroy';
  readonly attemptId: string | null;
  readonly environmentId: string | null;
  readonly ok: boolean;
  readonly reason: string | null;
}

const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OBJECT_KEYS = 8;
const MAX_ID_LENGTH = 128;
const MAX_WORKTREE_REF_LENGTH = 512;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// eslint-disable-next-line no-control-regex -- the validator's job is refusing control characters, not matching text containing them
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;
const ISOLATIONS: ReadonlySet<string> = new Set(['microvm', 'user-space-kernel']);
const DEFAULT_SUPPORTED_ISOLATIONS: readonly MicroVmIsolation[] = ['microvm', 'user-space-kernel'];

/**
 * Read a plain object whose own enumerable string data keys are all in
 * `allowedKeys`, values taken from their own descriptors so no getter ever
 * runs; null for anything else (wrong type, array, array-like, foreign
 * prototype, key count over the bound, a polluting, extra, symbol or
 * non-enumerable key, or a getter or a setter). A Proxy detectable through
 * its reported descriptors, prototype or a throwing trap is refused; a Proxy
 * lying consistently in every trap is an accepted residual.
 */
function readPlainDataRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | null {
  // The reflective reads below can throw out of a revoked Proxy or a Proxy
  // with a throwing `getPrototypeOf`/`ownKeys`/`getOwnPropertyDescriptor`
  // trap. Any such failure is a refusal, never an exception escaping this
  // function. Cost stays O(1): the key-count bound still runs before any
  // descriptor read.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_OBJECT_KEYS) {
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== 'string' || POLLUTING_KEYS.has(key) || !allowedKeys.includes(key)) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

/** A non-empty string of at most 128 characters matching the bounded id pattern. */
function isValidId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_ID_LENGTH) {
    return false;
  }
  return ID_PATTERN.test(value);
}

/** A non-empty relative string of at most 512 characters with no control
 * character and no `..` path segment on either separator.
 */
function isValidWorktreeRef(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_WORKTREE_REF_LENGTH) {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  // A worktree reference is relative: an absolute host path must never cross the port.
  if (/^(?:[\\/]|[A-Za-z]:)/.test(value)) {
    return false;
  }
  const segments = value.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '..') {
      return false;
    }
  }
  return true;
}

export class InMemoryMicroVmDriver implements MicroVmDriverPort {
  private readonly supportedIsolations: ReadonlySet<string>;
  private readonly failOnStep: InMemoryMicroVmDriverConfig['failOnStep'];
  private readonly failureReason: 'unavailable' | 'refused';
  /** Per-attempt environment state, decided by the domain state machine. */
  private readonly states = new Map<string, AttemptEnvironmentState>();
  /** The handle recorded for each issued environmentId. */
  private readonly handles = new Map<string, MicroVmHandle>();
  private readonly calls: InMemoryMicroVmDriverCall[] = [];
  private nextEnvironmentNumber = 0;

  constructor(config: InMemoryMicroVmDriverConfig = {}) {
    this.supportedIsolations = new Set(config.supportedIsolations ?? DEFAULT_SUPPORTED_ISOLATIONS);
    this.failOnStep = config.failOnStep;
    this.failureReason = config.failureReason ?? 'unavailable';
  }

  /** Recorded call metadata, for test inspection. Copies; no worktree content exists to leak. */
  recordedCalls(): readonly InMemoryMicroVmDriverCall[] {
    return this.calls.map((call) => ({ ...call }));
  }

  async create(request: { readonly attemptId: string; readonly isolation: MicroVmIsolation }) {
    const record = readPlainDataRecord(request, ['attemptId', 'isolation']);
    if (record === null || !Object.hasOwn(record, 'attemptId') || !Object.hasOwn(record, 'isolation')) {
      return this.refuse('create', null, null);
    }
    if (!isValidId(record['attemptId'])) {
      return this.refuse('create', null, null);
    }
    const attemptId = record['attemptId'];
    const isolationValue = record['isolation'];
    if (typeof isolationValue !== 'string' || !ISOLATIONS.has(isolationValue)) {
      return this.refuse('create', attemptId, null);
    }
    if (!this.supportedIsolations.has(isolationValue)) {
      return this.refuse('create', attemptId, null, 'unsupported-isolation');
    }
    const configured = this.configuredFailure('create');
    if (configured !== null) {
      return this.refuse('create', attemptId, null, configured);
    }
    // The environmentId is issued here, never supplied, so it is well formed by construction.
    const environmentId = this.issueEnvironmentId();
    const state = this.states.get(attemptId) ?? INITIAL_ATTEMPT_ENVIRONMENT_STATE;
    const step = decideEnvironmentStep(state, {
      kind: 'create',
      attemptId,
      environmentId,
      isolation: isolationValue,
    });
    if (!step.ok) {
      return this.refuse('create', attemptId, null);
    }
    this.states.set(attemptId, step.state);
    const handle: MicroVmHandle = { environmentId, attemptId, isolation: isolationValue };
    this.handles.set(environmentId, handle);
    this.record('create', attemptId, environmentId, true, null);
    return { ok: true as const, handle };
  }

  async injectWorktree(handle: MicroVmHandle, request: { readonly worktreeRef: string }) {
    const bound = this.resolveBoundState(handle, 'injectWorktree');
    if (!bound.ok) {
      return bound.result;
    }
    const record = readPlainDataRecord(request, ['worktreeRef']);
    if (record === null || !Object.hasOwn(record, 'worktreeRef') || !isValidWorktreeRef(record['worktreeRef'])) {
      return this.refuse('injectWorktree', bound.attemptId, bound.environmentId);
    }
    const configured = this.configuredFailure('injectWorktree');
    if (configured !== null) {
      return this.refuse('injectWorktree', bound.attemptId, bound.environmentId, configured);
    }
    const step = decideEnvironmentStep(bound.state, {
      kind: 'inject-worktree',
      attemptId: bound.attemptId,
      environmentId: bound.environmentId,
      worktreeRef: record['worktreeRef'],
    });
    if (!step.ok) {
      return this.refuse('injectWorktree', bound.attemptId, bound.environmentId);
    }
    this.states.set(bound.attemptId, step.state);
    this.record('injectWorktree', bound.attemptId, bound.environmentId, true, null);
    return { ok: true as const };
  }

  async seal(handle: MicroVmHandle) {
    const bound = this.resolveBoundState(handle, 'seal');
    if (!bound.ok) {
      return bound.result;
    }
    const configured = this.configuredFailure('seal');
    if (configured !== null) {
      return this.refuse('seal', bound.attemptId, bound.environmentId, configured);
    }
    const step = decideEnvironmentStep(bound.state, {
      kind: 'seal',
      attemptId: bound.attemptId,
      environmentId: bound.environmentId,
    });
    if (!step.ok) {
      return this.refuse('seal', bound.attemptId, bound.environmentId);
    }
    this.states.set(bound.attemptId, step.state);
    this.record('seal', bound.attemptId, bound.environmentId, true, null);
    return { ok: true as const };
  }

  async destroy(handle: MicroVmHandle) {
    const bound = this.resolveBoundState(handle, 'destroy');
    if (!bound.ok) {
      return bound.result;
    }
    // Destroying an already destroyed handle is idempotent (port contract):
    // the state machine refuses the repeat, so the fake short-circuits it
    // after the same handle binding checks as every other step.
    if (bound.state.status === 'destroyed') {
      this.record('destroy', bound.attemptId, bound.environmentId, true, null);
      return { ok: true as const };
    }
    const configured = this.configuredFailure('destroy');
    if (configured !== null) {
      return this.refuse('destroy', bound.attemptId, bound.environmentId, configured);
    }
    const step = decideEnvironmentStep(bound.state, {
      kind: 'destroy',
      attemptId: bound.attemptId,
      environmentId: bound.environmentId,
    });
    if (!step.ok) {
      return this.refuse('destroy', bound.attemptId, bound.environmentId);
    }
    this.states.set(bound.attemptId, step.state);
    this.record('destroy', bound.attemptId, bound.environmentId, true, null);
    return { ok: true as const };
  }

  /** The reason a configured-failure step reports, or null when the step is not configured to fail. */
  private configuredFailure(step: 'create' | 'injectWorktree' | 'seal' | 'destroy'): 'unavailable' | 'refused' | null {
    return this.failOnStep === step ? this.failureReason : null;
  }

  /**
   * Validate `handle` and bind it to the recorded environment: the handle's
   * `environmentId` must be known, its `attemptId` must be known, and its
   * `(environmentId, attemptId, isolation)` must match the recorded handle
   * exactly. A refusal leaves stored state unchanged.
   */
  private resolveBoundState(
    handle: unknown,
    step: 'injectWorktree' | 'seal' | 'destroy',
  ):
    | { readonly ok: true; readonly state: AttemptEnvironmentState; readonly attemptId: string; readonly environmentId: string }
    | { readonly ok: false; readonly result: { readonly ok: false; readonly reason: 'unavailable' | 'refused' | 'unsupported-isolation' } } {
    const record = readPlainDataRecord(handle, ['environmentId', 'attemptId', 'isolation']);
    if (record === null
      || !Object.hasOwn(record, 'environmentId')
      || !Object.hasOwn(record, 'attemptId')
      || !Object.hasOwn(record, 'isolation')
      || !isValidId(record['environmentId'])
      || !isValidId(record['attemptId'])
      || typeof record['isolation'] !== 'string'
      || !ISOLATIONS.has(record['isolation'])) {
      return { ok: false, result: this.refuse(step, null, null) };
    }
    const attemptId = record['attemptId'];
    const environmentId = record['environmentId'];
    const recordedHandle = this.handles.get(environmentId);
    if (recordedHandle === undefined
      || recordedHandle.attemptId !== attemptId
      || recordedHandle.isolation !== record['isolation']
      || !this.states.has(attemptId)) {
      return { ok: false, result: this.refuse(step, attemptId, environmentId) };
    }
    const state = this.states.get(attemptId)!;
    if (state.environmentId !== environmentId) {
      return { ok: false, result: this.refuse(step, attemptId, environmentId) };
    }
    return { ok: true, state, attemptId, environmentId };
  }

  private issueEnvironmentId(): string {
    this.nextEnvironmentNumber += 1;
    return `env-${this.nextEnvironmentNumber}`;
  }

  /** A typed refusal with a fixed constant reason; the supplied value is never echoed. */
  private refuse(
    step: 'create' | 'injectWorktree' | 'seal' | 'destroy',
    attemptId: string | null,
    environmentId: string | null,
    reason: 'unavailable' | 'refused' | 'unsupported-isolation' = 'refused',
  ): { readonly ok: false; readonly reason: 'unavailable' | 'refused' | 'unsupported-isolation' } {
    this.record(step, attemptId, environmentId, false, reason);
    return { ok: false, reason };
  }

  private record(
    step: 'create' | 'injectWorktree' | 'seal' | 'destroy',
    attemptId: string | null,
    environmentId: string | null,
    ok: boolean,
    reason: string | null,
  ): void {
    this.calls.push({ step, attemptId, environmentId, ok, reason });
  }
}
