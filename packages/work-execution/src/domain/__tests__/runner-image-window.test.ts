import { describe, expect, it } from 'vitest';

import {
  decideImageSchedulable,
  parseRunnerImageVersion,
  type RunnerImageVersion,
} from '../runner-image-window.js';

function window(min: RunnerImageVersion, max: RunnerImageVersion): Record<string, unknown> {
  return { min: { ...min }, max: { ...max } };
}

const WINDOW = window({ major: 3, minor: 4 }, { major: 5, minor: 2 });

describe('decideImageSchedulable', () => {
  it('accepts a version equal to the window min and max', () => {
    expect(decideImageSchedulable(WINDOW, { major: 3, minor: 4 })).toEqual({ schedulable: true });
    expect(decideImageSchedulable(WINDOW, { major: 5, minor: 2 })).toEqual({ schedulable: true });
  });

  it('accepts versions strictly inside the window', () => {
    expect(decideImageSchedulable(WINDOW, { major: 4, minor: 0 })).toEqual({ schedulable: true });
    expect(decideImageSchedulable(WINDOW, { major: 3, minor: 5 })).toEqual({ schedulable: true });
    expect(decideImageSchedulable(WINDOW, { major: 5, minor: 1 })).toEqual({ schedulable: true });
  });

  it('pins the lower boundary: one minor below min is below-window, one major below is below-window', () => {
    expect(decideImageSchedulable(WINDOW, { major: 3, minor: 3 })).toEqual({
      schedulable: false,
      reason: 'below-window',
    });
    expect(decideImageSchedulable(WINDOW, { major: 2, minor: 999 })).toEqual({
      schedulable: false,
      reason: 'below-window',
    });
  });

  it('pins the upper boundary: one minor above max is above-window, one major above is above-window', () => {
    expect(decideImageSchedulable(WINDOW, { major: 5, minor: 3 })).toEqual({
      schedulable: false,
      reason: 'above-window',
    });
    expect(decideImageSchedulable(WINDOW, { major: 6, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'above-window',
    });
  });

  it('compares major before minor across the boundaries', () => {
    // 4.999 > 5.0? No: major 4 < major 5, so inside despite the large minor.
    expect(decideImageSchedulable(WINDOW, { major: 4, minor: 999 })).toEqual({ schedulable: true });
    // 6.0 > 5.999 by major even though its minor is smaller.
    expect(decideImageSchedulable(WINDOW, { major: 6, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'above-window',
    });
  });

  it.each([
    null,
    undefined,
    42,
    'window',
    true,
    [],
    [1, 2],
    { length: 2, 0: { major: 3, minor: 4 }, 1: { major: 5, minor: 2 } },
    new Date(0),
    new (class NotPlain {})(),
  ])('refuses window %j as invalid-input', (badWindow) => {
    expect(decideImageSchedulable(badWindow, { major: 4, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
  });

  it.each([
    null,
    undefined,
    '1.2',
    42,
    true,
    [],
    { length: 2, 0: 4, 1: 0 },
    new Date(0),
    new (class NotPlain {})(),
  ])('refuses imageVersion %j as invalid-input', (badVersion) => {
    expect(decideImageSchedulable(WINDOW, badVersion)).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
  });

  it('refuses getter and non-enumerable properties without invoking the getter', () => {
    const accessor: Record<string, unknown> = { major: 4 };
    Object.defineProperty(accessor, 'minor', {
      get() {
        throw new Error('the decider must never run a getter');
      },
      enumerable: true,
    });
    expect(decideImageSchedulable(WINDOW, accessor)).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });

    const nonEnumerable: Record<string, unknown> = { major: 4, minor: 0 };
    Object.defineProperty(nonEnumerable, 'minor', { value: 0, enumerable: false });
    expect(decideImageSchedulable(WINDOW, nonEnumerable)).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });

    const windowAccessor: Record<string, unknown> = { min: { major: 3, minor: 4 } };
    Object.defineProperty(windowAccessor, 'max', {
      get() {
        throw new Error('the decider must never run a getter');
      },
      enumerable: true,
    });
    expect(decideImageSchedulable(windowAccessor, { major: 4, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
  });

  it('refuses throwing Proxy traps without throwing', () => {
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    expect(decideImageSchedulable(throwingProxy, { major: 4, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    expect(decideImageSchedulable(WINDOW, throwingProxy)).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
  });

  it('refuses missing, extra, symbol, and prototype-polluting keys as invalid-input', () => {
    expect(decideImageSchedulable(WINDOW, { major: 4 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    expect(decideImageSchedulable({ min: { major: 3, minor: 4 } }, { major: 4, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    expect(decideImageSchedulable(WINDOW, { major: 4, minor: 0, extra: 1 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    expect(decideImageSchedulable({ ...WINDOW, extra: true }, { major: 4, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    const symbolKeyed: Record<string, unknown> & { [key: symbol]: unknown } = { major: 4, minor: 0 };
    symbolKeyed[Symbol('tag')] = 1;
    expect(decideImageSchedulable(WINDOW, symbolKeyed)).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    const polluting = JSON.parse('{"major": 4, "minor": 0, "__proto__": {}}') as Record<string, unknown>;
    expect(decideImageSchedulable(WINDOW, polluting)).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
    const pollutingWindow = JSON.parse(
      '{"min": {"major": 3, "minor": 4}, "max": {"major": 5, "minor": 2}, "constructor": 1}',
    ) as Record<string, unknown>;
    expect(decideImageSchedulable(pollutingWindow, { major: 4, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
  });

  it.each([1.5, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '4', null, undefined])(
    'refuses a major/minor of %j as invalid-input',
    (bad) => {
      expect(decideImageSchedulable(WINDOW, { major: bad, minor: 0 })).toEqual({
        schedulable: false,
        reason: 'invalid-input',
      });
      expect(decideImageSchedulable(WINDOW, { major: 4, minor: bad })).toEqual({
        schedulable: false,
        reason: 'invalid-input',
      });
    },
  );

  it('refuses a version beyond Number.MAX_SAFE_INTEGER as invalid-input', () => {
    expect(decideImageSchedulable(WINDOW, { major: Number.MAX_SAFE_INTEGER + 1, minor: 0 })).toEqual({
      schedulable: false,
      reason: 'invalid-input',
    });
  });

  it('refuses an inverted compatibility window where min exceeds max as invalid-input', () => {
    expect(
      decideImageSchedulable(window({ major: 5, minor: 2 }, { major: 3, minor: 4 }), { major: 4, minor: 0 }),
    ).toEqual({ schedulable: false, reason: 'invalid-input' });
    expect(
      decideImageSchedulable(window({ major: 3, minor: 5 }, { major: 3, minor: 4 }), { major: 3, minor: 4 }),
    ).toEqual({ schedulable: false, reason: 'invalid-input' });
  });

  it('never mutates the window or the image version', () => {
    const windowCopy = JSON.parse(JSON.stringify(WINDOW)) as Record<string, unknown>;
    const version = { major: 4, minor: 0 };
    const versionCopy = { ...version };
    decideImageSchedulable(WINDOW, version);
    expect(WINDOW).toEqual(windowCopy);
    expect(version).toEqual(versionCopy);
  });
});

describe('parseRunnerImageVersion', () => {
  it('parses a well-formed version into exact major and minor integers', () => {
    expect(parseRunnerImageVersion('0.0')).toEqual({ ok: true, version: { major: 0, minor: 0 } });
    expect(parseRunnerImageVersion('1.2')).toEqual({ ok: true, version: { major: 1, minor: 2 } });
    expect(parseRunnerImageVersion('123456.654321')).toEqual({
      ok: true,
      version: { major: 123456, minor: 654321 },
    });
  });

  it.each([null, undefined, 42, { major: 1, minor: 2 }, ['1.2'], true, new Proxy({}, {})])(
    'refuses non-string input %j with invalid-type without throwing',
    (value) => {
      expect(parseRunnerImageVersion(value)).toEqual({ ok: false, reason: 'invalid-type' });
    },
  );

  it('refuses strings longer than 32 characters with too-long', () => {
    expect(parseRunnerImageVersion('1.2'.repeat(11) + 'x')).toEqual({ ok: false, reason: 'too-long' });
    // 33 characters of otherwise-valid shape still refuse on length.
    expect(parseRunnerImageVersion(`${'9'.repeat(16)}.${'9'.repeat(16)}`)).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it.each(['\x00', '\x1f1.2', '1\x1f.2', '1.\x7f', '1.2\n', '1.2\t'])(
    'refuses the control-character string %j with control-character',
    (value) => {
      expect(parseRunnerImageVersion(value)).toEqual({ ok: false, reason: 'control-character' });
    },
  );

  it.each([
    '',
    '1',
    '1.2.3',
    '1.',
    '.2',
    '01.2',
    '1.02',
    '+1.2',
    '-1.2',
    ' 1.2',
    '1.2 ',
    '1..2',
    'a.b',
    '1234567.1',
    '1.1234567',
    '1.2 ',
  ])('refuses the malformed version string %j with invalid-format', (value) => {
    expect(parseRunnerImageVersion(value)).toEqual({ ok: false, reason: 'invalid-format' });
  });
});
