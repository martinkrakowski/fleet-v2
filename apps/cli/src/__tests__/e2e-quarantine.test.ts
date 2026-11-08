// Lane S6: unit tests for the e2e scenario quarantine helper. They run in the
// normal suite (no FLEET_E2E_SSH needed) against a fixed clock.
import { describe, expect, it } from 'vitest';

import {
  E2E_QUARANTINE_MAX_DAYS,
  quarantineState,
  quarantined,
  type E2eQuarantineMarker,
} from './e2e/quarantine.js';

/** Fixed clock: 2026-10-31 12:00 UTC. */
const NOW_MS = Date.UTC(2026, 9, 31, 12);

function marker(overrides?: Partial<E2eQuarantineMarker>): E2eQuarantineMarker {
  return { until: '2026-11-07', issue: '#12', ...overrides };
}

describe('quarantineState', () => {
  it('decides active/expired/invalid on the fixed clock', () => {
    expect(E2E_QUARANTINE_MAX_DAYS).toBe(14);
    expect(quarantineState(marker({ until: '2026-10-31' }), NOW_MS)).toEqual({ kind: 'active' });
    expect(quarantineState(marker({ until: '2026-11-14' }), NOW_MS)).toEqual({ kind: 'active' });
    expect(quarantineState(marker({ until: '2026-11-15' }), NOW_MS).kind).toBe('invalid');

    const expired = quarantineState(marker({ until: '2026-10-30' }), NOW_MS);
    expect(expired.kind).toBe('expired');
    if (expired.kind === 'expired') {
      expect(expired.message).toContain('2026-10-30');
      expect(expired.message).toContain('#12');
      expect(expired.message).toContain('remove or renew');
    }
  });

  it('rejects malformed markers as invalid', () => {
    const cases: E2eQuarantineMarker[] = [
      marker({ until: '2026-1-5' }),
      marker({ until: '2026-02-30' }),
      marker({ until: 'tomorrow' }),
      marker({ issue: '12' }),
      marker({ issue: '#0' }),
      marker({ issue: '#12 extra' }),
    ];
    for (const m of cases) {
      expect(quarantineState(m, NOW_MS).kind).toBe('invalid');
    }
  });
});

describe('quarantined', () => {
  // Every `quarantined(...)` here pins the clock to NOW_MS. Without it the wrapper falls back to Date.now,
  // so these tests depended on the wall clock and the default marker's `until: '2026-11-07'`: they passed
  // until that date and then failed for everyone, which is what turned main red on 2026-11-08. The expiry
  // behaviour is still asserted — by the tests below that pass an `until` in the past against NOW_MS.
  const linesOf = () => {
    const lines: string[] = [];
    return { lines, write: (line: string) => void lines.push(line) };
  };

  it('resolves when an active body passes, running it once without writing', async () => {
    const { lines, write } = linesOf();
    let runs = 0;
    const fn = quarantined(marker(), 1000, async () => { runs += 1; }, { now: () => NOW_MS, write });
    await fn();
    expect(runs).toBe(1);
    expect(lines).toEqual([]);
  });

  it('resolves when an active body throws, writing one first-line warning', async () => {
    const { lines, write } = linesOf();
    let runs = 0;
    const fn = quarantined(
      marker(),
      1000,
      async () => {
        runs += 1;
        throw new Error('port race\nsecond line');
      },
      { now: () => NOW_MS, write },
    );
    await fn();
    expect(runs).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^::warning title=e2e quarantine::#12 failed while quarantined until 2026-11-07: port race/,
    );
    expect(lines[0]).not.toContain('second line');
  });

  it('resolves when an active body throws synchronously, writing one warning', async () => {
    const { lines, write } = linesOf();
    const fn = quarantined(
      marker(),
      1000,
      (() => {
        throw new Error('sync throw');
      }) as () => Promise<void>,
      { now: () => NOW_MS, write },
    );
    await fn();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sync throw');
  });

  it('resolves when an active body hangs, writing a warning on the budget', async () => {
    const { lines, write } = linesOf();
    const fn = quarantined(marker(), 50, () => new Promise<void>(() => {}), { now: () => NOW_MS, write });
    await fn();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('#12');
  });

  it('rejects with the expiry message and never runs an expired body', async () => {
    const { lines, write } = linesOf();
    let runs = 0;
    const fn = quarantined(
      marker({ until: '2026-10-30' }),
      1000,
      async () => { runs += 1; },
      { now: () => NOW_MS, write },
    );
    await expect(fn()).rejects.toThrow(
      'e2e quarantine expired on 2026-10-30 (#12): remove or renew the marker',
    );
    expect(runs).toBe(0);
    expect(lines).toEqual([]);
  });

  it('rejects an invalid marker and never runs the body', async () => {
    const { lines, write } = linesOf();
    let runs = 0;
    const fn = quarantined(marker({ issue: '12' }), 1000, async () => { runs += 1; }, { now: () => NOW_MS, write });
    await expect(fn()).rejects.toThrow(/invalid e2e quarantine marker/);
    expect(runs).toBe(0);
    expect(lines).toEqual([]);
  });
});
