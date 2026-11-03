import { describe, expect, it } from 'vitest';

import { readClockIso } from '../../application/use-cases/train-lease.js';
import { SystemClockAdapter } from './SystemClockAdapter.adapter.js';

describe('SystemClockAdapter', () => {
  it('returns a zoned ISO-8601 string between two Date readings', () => {
    const adapter = new SystemClockAdapter();
    const before = new Date();
    const value = adapter.nowIso();
    const after = new Date();
    expect(readClockIso(value)).not.toBeNull();
    const parsed = Date.parse(value);
    expect(parsed).toBeGreaterThanOrEqual(before.getTime());
    expect(parsed).toBeLessThanOrEqual(after.getTime());
  });
});
