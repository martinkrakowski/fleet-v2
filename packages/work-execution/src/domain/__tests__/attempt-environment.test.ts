import { describe, expect, it } from 'vitest';

import {
  type AttemptEnvironmentEvent,
  type AttemptEnvironmentState,
  INITIAL_ATTEMPT_ENVIRONMENT_STATE,
  decideEnvironmentStep,
} from '../attempt-environment.js';

const ATTEMPT_ID = 'attempt-1';
const ENVIRONMENT_ID = 'env-1';
const OTHER_ATTEMPT_ID = 'attempt-2';
const OTHER_ENVIRONMENT_ID = 'env-2';
const WORKTREE_REF = 'worktrees/attempt-1';

function createdState(overrides?: Partial<AttemptEnvironmentState>): AttemptEnvironmentState {
  return {
    status: 'created',
    attemptId: ATTEMPT_ID,
    environmentId: ENVIRONMENT_ID,
    isolation: 'microvm',
    worktreeRef: null,
    ...overrides,
  };
}

function createEvent(overrides?: Partial<Extract<AttemptEnvironmentEvent, { kind: 'create' }>>): AttemptEnvironmentEvent {
  return { kind: 'create', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, isolation: 'microvm', ...overrides };
}

function injectEvent(overrides?: Partial<Extract<AttemptEnvironmentEvent, { kind: 'inject-worktree' }>>): AttemptEnvironmentEvent {
  return { kind: 'inject-worktree', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, worktreeRef: WORKTREE_REF, ...overrides };
}

function sealEvent(overrides?: Partial<Extract<AttemptEnvironmentEvent, { kind: 'seal' }>>): AttemptEnvironmentEvent {
  return { kind: 'seal', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, ...overrides };
}

function destroyEvent(overrides?: Partial<Extract<AttemptEnvironmentEvent, { kind: 'destroy' }>>): AttemptEnvironmentEvent {
  return { kind: 'destroy', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, ...overrides };
}

function failEvent(overrides?: Partial<Extract<AttemptEnvironmentEvent, { kind: 'fail' }>>): AttemptEnvironmentEvent {
  return { kind: 'fail', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, ...overrides };
}

/** The hostile key is built at runtime, never written as a literal. */
function pollutingKey(kind: 'proto' | 'constructor' | 'prototype'): string {
  if (kind === 'proto') {
    return '_' + '_proto';
  }
  return kind;
}

describe('decideEnvironmentStep', () => {
  describe('legal forward transitions', () => {
    it('creates an environment from the initial none state and records the handle', () => {
      const result = decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, createEvent());
      expect(result).toEqual({
        ok: true,
        state: { status: 'created', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, isolation: 'microvm', worktreeRef: null },
      });
    });

    it('loads a created environment by injecting a worktree reference', () => {
      const result = decideEnvironmentStep(createdState(), injectEvent());
      expect(result).toEqual({
        ok: true,
        state: { status: 'loaded', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, isolation: 'microvm', worktreeRef: WORKTREE_REF },
      });
    });

    it('seals a loaded environment and keeps the injected worktree reference', () => {
      const loaded = createdState({ status: 'loaded', worktreeRef: WORKTREE_REF });
      const result = decideEnvironmentStep(loaded, sealEvent());
      expect(result).toEqual({
        ok: true,
        state: { status: 'sealed', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, isolation: 'microvm', worktreeRef: WORKTREE_REF },
      });
    });

    it('destroys a sealed environment', () => {
      const sealed = createdState({ status: 'sealed', worktreeRef: WORKTREE_REF });
      const result = decideEnvironmentStep(sealed, destroyEvent());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.status).toBe('destroyed');
      expect(result.state.attemptId).toBe(ATTEMPT_ID);
      expect(result.state.environmentId).toBe(ENVIRONMENT_ID);
    });

    it('supports the user-space-kernel isolation on create', () => {
      const result = decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, createEvent({ isolation: 'user-space-kernel' }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.isolation).toBe('user-space-kernel');
    });
  });

  describe('destroy and fail legality', () => {
    it('destroys from created, loaded, sealed and failed states', () => {
      for (const status of ['created', 'loaded', 'sealed', 'failed'] as const) {
        const state = createdState(status === 'loaded' || status === 'sealed' ? { status, worktreeRef: WORKTREE_REF } : { status });
        const result = decideEnvironmentStep(state, destroyEvent());
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.state.status).toBe('destroyed');
      }
    });

    it('fails from created, loaded and sealed states into failed', () => {
      for (const status of ['created', 'loaded', 'sealed'] as const) {
        const state = createdState(status === 'loaded' || status === 'sealed' ? { status, worktreeRef: WORKTREE_REF } : { status });
        const result = decideEnvironmentStep(state, failEvent());
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.state.status).toBe('failed');
      }
    });

    it('allows only destroy out of the failed state and refuses every other event there', () => {
      const failed = createdState({ status: 'failed' });
      expect(decideEnvironmentStep(failed, createEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(failed, injectEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(failed, sealEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(failed, failEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(failed, destroyEvent()).ok).toBe(true);
    });
  });

  describe('refusals from the none and destroyed states', () => {
    it('refuses inject-worktree, seal, destroy and fail in the none state with invalid-transition', () => {
      expect(decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, injectEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, sealEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, destroyEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, failEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
    });

    it('refuses every event including destroy in the destroyed state with invalid-transition', () => {
      const destroyed = createdState({ status: 'destroyed' });
      expect(decideEnvironmentStep(destroyed, injectEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(destroyed, sealEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(destroyed, destroyEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(destroyed, failEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(destroyed, createEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
    });
  });

  describe('duplicate and re-creation refusals', () => {
    it('refuses a second environment for an active attempt with duplicate-attempt', () => {
      for (const status of ['created', 'loaded', 'sealed'] as const) {
        const state = createdState(status === 'loaded' || status === 'sealed' ? { status, worktreeRef: WORKTREE_REF } : { status });
        expect(decideEnvironmentStep(state, createEvent())).toEqual({ ok: false, reason: 'duplicate-attempt' });
      }
    });

    it('refuses create after failed or destroyed with invalid-transition', () => {
      expect(decideEnvironmentStep(createdState({ status: 'failed' }), createEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(decideEnvironmentStep(createdState({ status: 'destroyed' }), createEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
    });
  });

  describe('seal and handle-mismatch refusals', () => {
    it('refuses inject-worktree after seal with the sealed reason', () => {
      const sealed = createdState({ status: 'sealed', worktreeRef: WORKTREE_REF });
      expect(decideEnvironmentStep(sealed, injectEvent())).toEqual({ ok: false, reason: 'sealed' });
    });

    it('refuses events with an unknown environmentId without mutating state', () => {
      const state = createdState({ status: 'loaded', worktreeRef: WORKTREE_REF });
      for (const event of [injectEvent({ environmentId: OTHER_ENVIRONMENT_ID }), sealEvent({ environmentId: OTHER_ENVIRONMENT_ID }), destroyEvent({ environmentId: OTHER_ENVIRONMENT_ID }), failEvent({ environmentId: OTHER_ENVIRONMENT_ID })]) {
        expect(decideEnvironmentStep(state, event)).toEqual({ ok: false, reason: 'handle-mismatch' });
      }
      expect(state.status).toBe('loaded');
    });

    it('refuses events with a mismatched attemptId without mutating state', () => {
      const state = createdState({ status: 'sealed', worktreeRef: WORKTREE_REF });
      for (const event of [injectEvent({ attemptId: OTHER_ATTEMPT_ID }), sealEvent({ attemptId: OTHER_ATTEMPT_ID }), destroyEvent({ attemptId: OTHER_ATTEMPT_ID }), failEvent({ attemptId: OTHER_ATTEMPT_ID })]) {
        expect(decideEnvironmentStep(state, event)).toEqual({ ok: false, reason: 'handle-mismatch' });
      }
      expect(state.status).toBe('sealed');
    });
  });

  describe('illegal transitions and unknown states', () => {
    it('refuses illegal transitions and unknown states without mutating state', () => {
      const unknownStatus = { status: 'detached', attemptId: null, environmentId: null, isolation: null, worktreeRef: null };
      expect(decideEnvironmentStep(unknownStatus, createEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      const loaded = createdState({ status: 'loaded', worktreeRef: WORKTREE_REF });
      expect(decideEnvironmentStep(loaded, injectEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      const created = createdState();
      expect(decideEnvironmentStep(created, sealEvent())).toEqual({ ok: false, reason: 'invalid-transition' });
      expect(created.status).toBe('created');
    });
  });

  describe('status-field consistency', () => {
    it('refuses a loaded state without an injected worktree, so seal can never succeed without injection', () => {
      const loadedWithoutWorktree = createdState({ status: 'loaded', worktreeRef: null });
      expect(decideEnvironmentStep(loadedWithoutWorktree, sealEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      expect(decideEnvironmentStep(loadedWithoutWorktree, injectEvent())).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a sealed state without an injected worktree', () => {
      const sealedWithoutWorktree = createdState({ status: 'sealed', worktreeRef: null });
      expect(decideEnvironmentStep(sealedWithoutWorktree, destroyEvent())).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a created state that already carries a worktree reference', () => {
      const createdWithWorktree = createdState({ worktreeRef: WORKTREE_REF });
      expect(decideEnvironmentStep(createdWithWorktree, injectEvent())).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a none state that carries any handle field', () => {
      for (const key of ['attemptId', 'environmentId', 'isolation', 'worktreeRef'] as const) {
        const polluted: Record<string, unknown> = { status: 'none', attemptId: null, environmentId: null, isolation: null, worktreeRef: null };
        polluted[key] = key === 'worktreeRef' ? WORKTREE_REF : key === 'isolation' ? 'microvm' : ATTEMPT_ID;
        expect(decideEnvironmentStep(polluted, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      }
    });

    it('refuses an active status whose handle fields are missing', () => {
      for (const status of ['created', 'loaded', 'sealed', 'failed', 'destroyed'] as const) {
        for (const key of ['attemptId', 'environmentId', 'isolation'] as const) {
          const incomplete: Record<string, unknown> = {
            status,
            attemptId: status === 'loaded' || status === 'sealed' ? ATTEMPT_ID : ATTEMPT_ID,
            environmentId: ENVIRONMENT_ID,
            isolation: 'microvm',
            worktreeRef: status === 'loaded' || status === 'sealed' ? WORKTREE_REF : null,
          };
          incomplete[key] = null;
          expect(decideEnvironmentStep(incomplete, sealEvent())).toEqual({ ok: false, reason: 'invalid-input' });
        }
      }
    });
  });

  describe('hostile inputs', () => {
    it('refuses hostile non-plain, null, undefined, primitive, array-like, and oversized inputs without throwing', () => {
      const sparse = new Array(3);
      sparse[0] = 1;
      const arrayLike = { length: 1e9, 0: 'x', status: 'none', attemptId: null, environmentId: null, isolation: null, worktreeRef: null };
      const oversized = { status: 'none', attemptId: null, environmentId: null, isolation: null, worktreeRef: null, extra: 'x', extra2: 'y', extra3: 'z', extra4: 'w' };
      const hostileStates: unknown[] = [null, undefined, 'none', 7, true, [], sparse, arrayLike, oversized];
      for (const state of hostileStates) {
        expect(decideEnvironmentStep(state, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      }
      const goodState = createdState();
      const hostileEvents: unknown[] = [null, undefined, 'seal', 42, [], sparse, { kind: 'seal' }, { kind: 'seal', attemptId: ATTEMPT_ID, environmentId: ENVIRONMENT_ID, worktreeRef: WORKTREE_REF }];
      for (const event of hostileEvents) {
        expect(decideEnvironmentStep(goodState, event)).toEqual({ ok: false, reason: 'invalid-input' });
      }
    });

    it('refuses getters without invoking them and refuses Proxy inputs', () => {
      let getterRuns = 0;
      const stateWithGetter: Record<string, unknown> = {};
      Object.defineProperty(stateWithGetter, 'status', { enumerable: true, get() { getterRuns += 1; return 'none'; } });
      Object.defineProperty(stateWithGetter, 'attemptId', { enumerable: true, value: null });
      Object.defineProperty(stateWithGetter, 'environmentId', { enumerable: true, value: null });
      Object.defineProperty(stateWithGetter, 'isolation', { enumerable: true, value: null });
      Object.defineProperty(stateWithGetter, 'worktreeRef', { enumerable: true, value: null });
      expect(decideEnvironmentStep(stateWithGetter, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      expect(getterRuns).toBe(0);

      const eventWithGetter: Record<string, unknown> = {};
      Object.defineProperty(eventWithGetter, 'kind', { enumerable: true, get() { getterRuns += 1; return 'create'; } });
      Object.defineProperty(eventWithGetter, 'attemptId', { enumerable: true, value: ATTEMPT_ID });
      Object.defineProperty(eventWithGetter, 'environmentId', { enumerable: true, value: ENVIRONMENT_ID });
      Object.defineProperty(eventWithGetter, 'isolation', { enumerable: true, value: 'microvm' });
      expect(decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, eventWithGetter)).toEqual({ ok: false, reason: 'invalid-input' });
      expect(getterRuns).toBe(0);

      const throwingGet = (): never => {
        throw new Error('trap must never run');
      };
      const lyingProxy = new Proxy({ status: 'none', attemptId: null, environmentId: null, isolation: null, worktreeRef: null }, {
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true, get: throwingGet };
        },
      });
      expect(decideEnvironmentStep(lyingProxy, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      expect(decideEnvironmentStep(createdState(), new Proxy([1, 2, 3], {}))).toEqual({ ok: false, reason: 'invalid-input' });
      expect(decideEnvironmentStep(createdState(), new Proxy(function proxyTarget() { /* hostile */ }, {}))).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses a revoked Proxy and a Proxy with throwing reflection traps without throwing', () => {
      const stateShape = { status: 'none', attemptId: null, environmentId: null, isolation: null, worktreeRef: null };
      const revokedState = Proxy.revocable(stateShape, {});
      revokedState.revoke();
      expect(decideEnvironmentStep(revokedState.proxy, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      const revokedEvent = Proxy.revocable(createEvent(), {});
      revokedEvent.revoke();
      expect(decideEnvironmentStep(createdState(), revokedEvent.proxy)).toEqual({ ok: false, reason: 'invalid-input' });

      const trap = (): never => {
        throw new Error('trap must never escape');
      };
      const throwingOwnKeysState = new Proxy(stateShape, { ownKeys: trap });
      expect(decideEnvironmentStep(throwingOwnKeysState, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      const throwingPrototypeState = new Proxy(stateShape, { getPrototypeOf: trap });
      expect(decideEnvironmentStep(throwingPrototypeState, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      const throwingDescriptorState = new Proxy(stateShape, { getOwnPropertyDescriptor: trap });
      expect(decideEnvironmentStep(throwingDescriptorState, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      const throwingOwnKeysEvent = new Proxy(createEvent(), { ownKeys: trap });
      expect(decideEnvironmentStep(createdState(), throwingOwnKeysEvent)).toEqual({ ok: false, reason: 'invalid-input' });
      const throwingDescriptorEvent = new Proxy(createEvent(), { getOwnPropertyDescriptor: trap });
      expect(decideEnvironmentStep(createdState(), throwingDescriptorEvent)).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses prototype-polluting keys and extra keys', () => {
      for (const key of [pollutingKey('proto'), pollutingKey('constructor'), pollutingKey('prototype')]) {
        const pollutedState: Record<string, unknown> = { status: 'none', attemptId: null, environmentId: null, isolation: null, worktreeRef: null };
        Object.defineProperty(pollutedState, key, { enumerable: true, value: 'x', configurable: true, writable: true });
        expect(decideEnvironmentStep(pollutedState, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      }
      const stateWithExtra = { ...createdState(), extra: 'x' };
      expect(decideEnvironmentStep(stateWithExtra, createEvent())).toEqual({ ok: false, reason: 'invalid-input' });
      const eventWithExtra = { ...createEvent(), attemptId2: ATTEMPT_ID };
      expect(decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, eventWithExtra)).toEqual({ ok: false, reason: 'invalid-input' });
    });

    it('refuses invalid attemptId values without echoing them', () => {
      const invalid = ['', 'a b', 'a/b', 'a'.repeat(129), 'bad!', 7, null];
      for (const attemptId of invalid) {
        const result = decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, createEvent({ attemptId: attemptId as string }));
        expect(result).toEqual({ ok: false, reason: 'invalid-attempt-id' });
        expect(JSON.stringify(result)).not.toContain('a b');
        expect(JSON.stringify(result)).not.toContain('bad!');
      }
    });

    it('refuses invalid environmentId values without echoing them', () => {
      const invalid = ['', 'e n v', '../env', 'e'.repeat(129), 'bad#', 7, null];
      for (const environmentId of invalid) {
        const result = decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, createEvent({ environmentId: environmentId as string }));
        expect(result).toEqual({ ok: false, reason: 'invalid-environment-id' });
        expect(JSON.stringify(result)).not.toContain('e n v');
        expect(JSON.stringify(result)).not.toContain('bad#');
      }
    });

    it('refuses invalid worktreeRef values with control chars, traversal, or excessive length', () => {
      const invalid = ['', 'a/'.repeat(300), 'worktrees/../../etc', 'bad\tref', 'bad\nref', 'bad\u007fref', 7, null];
      for (const worktreeRef of invalid) {
        const result = decideEnvironmentStep(createdState(), injectEvent({ worktreeRef: worktreeRef as string }));
        expect(result).toEqual({ ok: false, reason: 'invalid-worktree-ref' });
        expect(JSON.stringify(result)).not.toContain('worktrees/../../etc');
        expect(JSON.stringify(result)).not.toContain('bad\tref');
      }
    });

    it('refuses unsupported isolation without silent downgrade', () => {
      for (const isolation of ['chroot', 'none', '', 'MICROVM', 7, null]) {
        const result = decideEnvironmentStep(INITIAL_ATTEMPT_ENVIRONMENT_STATE, createEvent({ isolation: isolation as string as 'microvm' }));
        expect(result).toEqual({ ok: false, reason: 'unsupported-isolation' });
      }
    });

    it('never mutates the state object on any refusal', () => {
      const state = createdState({ status: 'loaded', worktreeRef: WORKTREE_REF });
      const before = { ...state };
      decideEnvironmentStep(state, createEvent());
      decideEnvironmentStep(state, injectEvent({ environmentId: OTHER_ENVIRONMENT_ID }));
      decideEnvironmentStep(state, sealEvent({ attemptId: OTHER_ATTEMPT_ID }));
      decideEnvironmentStep(state, destroyEvent());
      decideEnvironmentStep(state, null);
      expect(state).toEqual(before);
    });
  });
});
