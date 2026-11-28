import { describe, expect, it } from 'vitest';

import {
  UNCERTAIN_STEPS,
  classifyInterruptedIntent,
  isUncertainStep,
} from '../lane-run-uncertain.js';

describe('uncertain steps (UN1)', () => {
  it('UNCERTAIN_STEPS is exactly dispatch, push, merge-enqueue and premerge', () => {
    expect([...UNCERTAIN_STEPS]).toEqual(['dispatch', 'push', 'merge-enqueue', 'premerge']);
    for (const step of UNCERTAIN_STEPS) {
      expect(isUncertainStep(step)).toBe(true);
    }
    for (const notUncertain of ['gate', 'prepare', 'collect', 'reconcile', null, 42]) {
      expect(isUncertainStep(notUncertain)).toBe(false);
    }
  });
});

describe('classifyInterruptedIntent', () => {
  it('classifyInterruptedIntent reconciles only when the observation proves the effect done', () => {
    expect(classifyInterruptedIntent({ step: 'push', observation: 'proves-done' })).toEqual({
      outcome: 'reconciled',
      reasonCode: 'observed-done',
    });
    // The other observations never reconcile.
    expect(classifyInterruptedIntent({ step: 'push', observation: 'proves-not-done' })?.outcome).toBe('uncertain');
    expect(classifyInterruptedIntent({ step: 'push', observation: 'unavailable' })?.outcome).toBe('uncertain');
  });

  it('classifyInterruptedIntent keeps proves-not-done uncertain so nothing re-runs automatically', () => {
    expect(classifyInterruptedIntent({ step: 'dispatch', observation: 'proves-not-done' })).toEqual({
      outcome: 'uncertain',
      reasonCode: 'observed-not-done',
    });
    expect(classifyInterruptedIntent({ step: 'merge-enqueue', observation: 'unavailable' })).toEqual({
      outcome: 'uncertain',
      reasonCode: 'unobservable',
    });
  });

  it('classifyInterruptedIntent returns null for a step that is not uncertain', () => {
    expect(classifyInterruptedIntent({ step: 'gate', observation: 'proves-done' })).toBeNull();
    expect(classifyInterruptedIntent({ step: 'reconcile', observation: 'unavailable' })).toBeNull();
    // The same observation on an uncertain step is NOT null, so a constant-null classifier fails.
    expect(classifyInterruptedIntent({ step: 'dispatch', observation: 'proves-done' })).toEqual({
      outcome: 'reconciled',
      reasonCode: 'observed-done',
    });
  });

  it('classifyInterruptedIntent refuses a getter-backed input', () => {
    const getterBacked = {
      get step(): string {
        throw new Error('a getter must never run');
      },
      observation: 'proves-done',
    };
    expect(classifyInterruptedIntent(getterBacked)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('classifyInterruptedIntent refuses null, non-objects, proxies and prototype-polluting keys', () => {
    expect(classifyInterruptedIntent(null)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(classifyInterruptedIntent(undefined)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(classifyInterruptedIntent(42)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(classifyInterruptedIntent('push')).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(classifyInterruptedIntent(['push', 'proves-done'])).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    const hostileProxy = new Proxy({}, {
      get(): never {
        throw new Error('a proxy trap must never run');
      },
      getOwnPropertyDescriptor(): never {
        throw new Error('a proxy trap must never run');
      },
      ownKeys(): never {
        throw new Error('a proxy trap must never run');
      },
    });
    expect(classifyInterruptedIntent(hostileProxy)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    const polluted: Record<string, unknown> = { step: 'push', observation: 'proves-done' };
    Object.defineProperty(polluted, '__proto__', { value: 'push', enumerable: true, writable: true });
    expect(classifyInterruptedIntent(polluted)).toEqual({ outcome: 'refused', reason: 'invalid-input' });
  });

  it('classifyInterruptedIntent refuses an unknown observation value', () => {
    expect(classifyInterruptedIntent({ step: 'push', observation: 'looked-fine' })).toEqual({
      outcome: 'refused',
      reason: 'unknown-observation',
    });
    expect(classifyInterruptedIntent({ step: 'push', observation: null })).toEqual({
      outcome: 'refused',
      reason: 'unknown-observation',
    });
  });

  it('classifyInterruptedIntent refuses an unknown step value', () => {
    expect(classifyInterruptedIntent({ step: 'frobnicate', observation: 'proves-done' })).toEqual({
      outcome: 'refused',
      reason: 'unknown-step',
    });
    expect(classifyInterruptedIntent({ observation: 'proves-done' })).toEqual({
      outcome: 'refused',
      reason: 'unknown-step',
    });
  });
});
