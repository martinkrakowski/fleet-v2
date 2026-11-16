// ARFIX1a relaunch-step-ledger tests: the pure relaunch step ledger.
/**
 * Pure: no timers, no files, no environment; every case feeds plain values
 * (or a Proxy where a trap is the subject) and asserts a typed result.
 */

import { describe, expect, it } from 'vitest';

import { MAX_RELAUNCH_LEDGER_ENTRIES, relaunchLaneProgress, relaunchStepStatus } from '../relaunch-step-ledger.js';

const KEY = 'relaunch/aaaaaaa/lane-1/abort';
const intent = { key: KEY, kind: 'intent' };
const result = (outcome: unknown) => ({ key: KEY, kind: 'result', outcome });
const other = { key: 'relaunch/aaaaaaa/lane-2/abort', kind: 'intent' };

describe('relaunchStepStatus', () => {
  it('T1: entries matching only another step key are absent for the asked key', () => {
    expect(relaunchStepStatus([other], KEY)).toBe('absent');
  });

  it('T2: the intent alone is intent-only', () => {
    expect(relaunchStepStatus([other, intent], KEY)).toBe('intent-only');
  });

  it('T3: intent plus only ambiguous results is ambiguous', () => {
    expect(relaunchStepStatus([intent, result('ambiguous'), result('ambiguous')], KEY)).toBe('ambiguous');
  });

  it('T4: the first final result wins over earlier ambiguous results', () => {
    expect(relaunchStepStatus([intent, result('completed')], KEY)).toBe('completed');
    expect(relaunchStepStatus([intent, result('ambiguous'), result('completed')], KEY)).toBe('completed');
  });

  it('T5: intent and a final refused result is refused', () => {
    expect(relaunchStepStatus([intent, result('refused')], KEY)).toBe('refused');
  });

  it('T6: every journal grammar violation is inconsistent, not a success status', () => {
    const cases: unknown[][] = [
      [intent, intent],
      [result('completed')],
      [intent, result('completed'), result('refused')],
      [intent, result('ambiguous'), intent],
      [intent, result(undefined)],
      [intent, result('done')],
      [intent, { key: KEY, kind: 'note' }],
    ];
    for (const entries of cases) {
      expect(relaunchStepStatus(entries, KEY)).toBe('inconsistent');
    }
  });

  it('T7: every unreadable entries value or key is inconsistent', () => {
    const holed = new Array<unknown>(3);
    holed[0] = intent;
    holed[2] = result('completed');
    const entriesCases: unknown[] = [
      null,
      undefined,
      'x',
      7,
      {},
      { length: 1, 0: intent },
      holed,
      [intent, null],
      [intent, 7],
      [{ key: 1, kind: 'intent' }, intent],
    ];
    for (const entries of entriesCases) {
      expect(relaunchStepStatus(entries, KEY)).toBe('inconsistent');
    }
    for (const key of ['', null, 7]) {
      expect(relaunchStepStatus([intent], key)).toBe('inconsistent');
    }
  });

  it('T8: a kind getter that throws gives inconsistent and the call itself does not throw', () => {
    const entries = [{ key: KEY, get kind(): string { throw new Error('boom'); } }];
    expect(relaunchStepStatus(entries, KEY)).toBe('inconsistent');
  });

  it('T9: a kind getter is read exactly once per call', () => {
    let reads = 0;
    const entries = [
      {
        key: KEY,
        get kind(): string {
          reads += 1;
          return 'intent';
        },
      },
    ];
    expect(relaunchStepStatus(entries, KEY)).toBe('intent-only');
    expect(reads).toBe(1);
  });

  it('T10: an enormous length is refused before any element is read, while exactly the maximum is allowed', () => {
    let reads = 0;
    const huge = new Proxy<unknown[]>([], {
      get: (_target, prop) => {
        if (prop === 'length') return MAX_RELAUNCH_LEDGER_ENTRIES + 1;
        reads += 1;
        return other;
      },
      has: () => {
        reads += 1;
        return true;
      },
    });
    expect(relaunchStepStatus(huge, KEY)).toBe('inconsistent');
    expect(reads).toBe(0);
    expect(relaunchStepStatus(Array.from({ length: MAX_RELAUNCH_LEDGER_ENTRIES }, () => other), KEY)).toBe('absent');
  });

  it('T11: a Proxy is read like any other array: transparent when well-formed, inconsistent when its trap throws', () => {
    expect(relaunchStepStatus(new Proxy([intent, result('completed')], {}), KEY)).toBe('completed');
    const throwing = new Proxy([intent], {
      get(): unknown {
        throw new Error('boom');
      },
    });
    expect(relaunchStepStatus(throwing, KEY)).toBe('inconsistent');
  });

  it('T12: prototype-polluting keys are ordinary strings and leave Object.prototype unchanged', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(relaunchStepStatus([{ key: name, kind: 'intent' }], name)).toBe('intent-only');
      expect(Object.keys(Object.prototype)).toEqual([]);
    }
  });

  it('T13: a key that is a prefix of another key does not match that longer key', () => {
    expect(
      relaunchStepStatus([{ key: 'relaunch/aaaaaaa/lane-1/adopt/run', kind: 'intent' }], 'relaunch/aaaaaaa/lane-1/adopt'),
    ).toBe('absent');
  });
});

describe('relaunchLaneProgress', () => {
  const completed = (step: string) => ({ step, status: 'completed' });
  const absent = (step: string) => ({ step, status: 'absent' });

  it('T14: an empty lane, an all-completed lane and a full 16-step completed lane are done', () => {
    expect(relaunchLaneProgress([])).toEqual({ kind: 'done' });
    expect(relaunchLaneProgress([completed('save'), completed('abort'), completed('adopt')])).toEqual({ kind: 'done' });
    expect(
      relaunchLaneProgress(Array.from({ length: 16 }, (_unused, index) => completed(`s${index}`))),
    ).toEqual({ kind: 'done' });
  });

  it('T15: a first absent step after completed steps is run at that step', () => {
    expect(relaunchLaneProgress([completed('save'), absent('abort'), absent('adopt')])).toEqual({
      kind: 'run',
      step: 'abort',
    });
  });

  it('T16: a first non-completed step that is intent-only or ambiguous is reconcile at that step, never run', () => {
    expect(relaunchLaneProgress([completed('save'), { step: 'abort', status: 'intent-only' }, absent('adopt')])).toEqual({
      kind: 'reconcile',
      step: 'abort',
      status: 'intent-only',
    });
    expect(relaunchLaneProgress([completed('save'), { step: 'abort', status: 'ambiguous' }, absent('adopt')])).toEqual({
      kind: 'reconcile',
      step: 'abort',
      status: 'ambiguous',
    });
  });

  it('T17: a first non-completed step that is refused or inconsistent stops at that step', () => {
    expect(relaunchLaneProgress([{ step: 'save', status: 'refused' }, absent('abort')])).toEqual({
      kind: 'stopped',
      step: 'save',
      reason: 'refused',
    });
    expect(relaunchLaneProgress([{ step: 'save', status: 'inconsistent' }, absent('abort')])).toEqual({
      kind: 'stopped',
      step: 'save',
      reason: 'inconsistent',
    });
  });

  it('T18: any non-absent status after the first non-completed step stops out-of-order at that first step, even when that step would reconcile', () => {
    expect(relaunchLaneProgress([absent('save'), completed('abort')])).toEqual({
      kind: 'stopped',
      step: 'save',
      reason: 'out-of-order',
    });
    expect(relaunchLaneProgress([{ step: 'save', status: 'inconsistent' }, { step: 'abort', status: 'intent-only' }])).toEqual({
      kind: 'stopped',
      step: 'save',
      reason: 'out-of-order',
    });
  });

  it('T19: every invalid steps input is exactly stopped invalid-steps with a null step', () => {
    const holed = new Array<unknown>(2);
    holed[1] = { step: 'save', status: 'absent' };
    const elementWithThrowingStepGetter = {
      get step(): string {
        throw new Error('boom');
      },
      status: 'absent',
    };
    const cases: unknown[] = [
      null,
      undefined,
      'x',
      {},
      { length: 0 },
      Array.from({ length: 17 }, (_unused, index) => ({ step: `s${index}`, status: 'absent' })),
      holed,
      [null],
      [{ step: 'Save', status: 'absent' }],
      [{ step: 'save\n', status: 'absent' }],
      [{ step: 7, status: 'absent' }],
      [{ step: 'save', status: 'done' }],
      [absent('save'), absent('save')],
      [elementWithThrowingStepGetter],
    ];
    for (const steps of cases) {
      expect(relaunchLaneProgress(steps)).toEqual({ kind: 'stopped', step: null, reason: 'invalid-steps' });
    }
  });
});
