// CO13 dispatch-stagger tests: the pure per-runner-endpoint dispatch-stagger rule.
/**
 * Pure: the clock arrives as an argument; no timers, no wall-clock
 * assertions, no files, no environment.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRunnerRecord } from '../execution-records.js';
import {
  DEFAULT_DISPATCH_STAGGER_MS,
  decideDispatchStagger,
  dispatchEndpointFactsOf,
  dispatchEndpointKey,
} from '../dispatch-stagger.js';

const NOW = '2026-10-27T10:00:00.000Z';

function at(ms: number): string {
  return new Date(Date.parse(NOW) + ms).toISOString();
}

describe('decideDispatchStagger', () => {
  it('no last start is granted', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: null, minIntervalMs: 20_000 })).toEqual({ ok: true });
  });

  it('5 s after the last start with a 20 000 ms interval waits 15 000 ms', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: at(-5_000), minIntervalMs: 20_000 })).toEqual({
      ok: false,
      retryAfterMs: 15_000,
    });
  });

  it('exactly at the interval is granted', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: at(-20_000), minIntervalMs: 20_000 })).toEqual({ ok: true });
  });

  it('a last start in the future waits one full interval', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: at(1_000), minIntervalMs: 20_000 })).toEqual({
      ok: false,
      retryAfterMs: 20_000,
    });
  });

  it('a zero interval never blocks', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: at(-5_000), minIntervalMs: 0 })).toEqual({ ok: true });
  });

  it('an invalid interval falls back to the default', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: at(-5_000), minIntervalMs: Number.NaN })).toEqual({
      ok: false,
      retryAfterMs: DEFAULT_DISPATCH_STAGGER_MS - 5_000,
    });
  });

  it('an unparseable clock never blocks', () => {
    expect(decideDispatchStagger({ nowIso: 'not-a-date', lastStartIso: at(-5_000), minIntervalMs: 20_000 })).toEqual({
      ok: true,
    });
    expect(decideDispatchStagger({ nowIso: 'not-a-date', lastStartIso: 'not-a-date', minIntervalMs: 20_000 })).toEqual({
      ok: true,
    });
  });

  it('an unparseable last-start seed waits one full interval', () => {
    expect(decideDispatchStagger({ nowIso: NOW, lastStartIso: 'not-a-date', minIntervalMs: 20_000 })).toEqual({
      ok: false,
      retryAfterMs: 20_000,
    });
  });
});

describe('dispatchEndpointKey', () => {
  const base: AttemptRunnerRecord = {
    kind: 'opencode',
    remotePort: 4166,
    host: 'lane-alias-example',
    hostName: 'lane-host-example',
    agent: null,
    model: null,
    variant: null,
  };

  it('the same host name and port give the same key', () => {
    expect(dispatchEndpointKey(dispatchEndpointFactsOf(base))).toBe('opencode:lane-host-example:4166');
    expect(
      dispatchEndpointKey(dispatchEndpointFactsOf({ ...base, host: 'another-alias' })),
    ).toBe('opencode:lane-host-example:4166');
  });

  it('a different host name gives a different key', () => {
    const a = dispatchEndpointKey(dispatchEndpointFactsOf(base));
    const b = dispatchEndpointKey(dispatchEndpointFactsOf({ ...base, hostName: 'lane-host-other' }));
    expect(a).not.toBe(b);
  });

  it('a record without a host name uses the alias', () => {
    expect(dispatchEndpointKey(dispatchEndpointFactsOf({ ...base, hostName: null }))).toBe('opencode:lane-alias-example:4166');
    expect(dispatchEndpointKey(dispatchEndpointFactsOf({ ...base, hostName: undefined }))).toBe(
      'opencode:lane-alias-example:4166',
    );
  });

  it('a null runner gives unknown:local:0', () => {
    expect(dispatchEndpointKey(dispatchEndpointFactsOf(null))).toBe('unknown:local:0');
    expect(dispatchEndpointKey(null)).toBe('unknown:local:0');
  });
});
