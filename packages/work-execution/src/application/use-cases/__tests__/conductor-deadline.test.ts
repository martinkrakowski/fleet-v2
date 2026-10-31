/**
 * Unit tests for lane SEC-5c-2: `conductorTimeLimitSeconds`, the pure
 * precedence function behind the conductor's lane deadline. Precedence is
 * the limit dispatch recorded on the attempt over a verified frozen manifest
 * limit over the conductor-owned fallback (3600 s); a recorded value counts
 * only when it is a positive safe integer.
 */

import { describe, expect, it } from 'vitest';

import {
  CONDUCTOR_FALLBACK_TIME_LIMIT_SECONDS,
  conductorTimeLimitSeconds,
} from '../advance-lane-run/frozen-manifest.js';

describe('conductorTimeLimitSeconds (SEC-5c-2)', () => {
  it.each([
    ['recorded 2700 beats a different manifest limit', 2700, 360000, { seconds: 2700, source: 'recorded' }],
    ['recorded undefined uses the manifest limit', undefined, 1800, { seconds: 1800, source: 'manifest' }],
    ['recorded undefined and null manifest use the fallback', undefined, null, { seconds: 3600, source: 'fallback' }],
    ['recorded 0 counts as absent', 0, null, { seconds: 3600, source: 'fallback' }],
    ['recorded -5 counts as absent', -5, null, { seconds: 3600, source: 'fallback' }],
    ['recorded 1.5 counts as absent', 1.5, null, { seconds: 3600, source: 'fallback' }],
    ["recorded '2700' counts as absent", '2700', null, { seconds: 3600, source: 'fallback' }],
    ['recorded NaN counts as absent', NaN, null, { seconds: 3600, source: 'fallback' }],
  ])('%s', (_label, recorded, manifestLimit, expected) => {
    expect(conductorTimeLimitSeconds(recorded, manifestLimit)).toEqual(expected);
  });

  it('the fallback is the conductor-owned 60-minute constant', () => {
    expect(CONDUCTOR_FALLBACK_TIME_LIMIT_SECONDS).toBe(3600);
    expect(conductorTimeLimitSeconds(undefined, null).seconds).toBe(CONDUCTOR_FALLBACK_TIME_LIMIT_SECONDS);
  });
});
