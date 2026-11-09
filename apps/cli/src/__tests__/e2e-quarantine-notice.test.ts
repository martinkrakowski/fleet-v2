// Lane U6: unit tests for the e2e quarantine approaching-expiry notice. They
// run in the normal suite (no FLEET_E2E_SSH needed) against a fixed clock and
// always inject `now` and `write`, so no test depends on the wall clock or the
// real stdout.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  E2E_QUARANTINE_MAX_DAYS,
  E2E_QUARANTINE_NOTICE_DAYS,
  isQuarantineApproachingExpiry,
  quarantineState,
  quarantined,
  type E2eQuarantineMarker,
} from './e2e/quarantine.js';

/** Fixed clock: 2026-10-31 12:00 UTC. */
const NOW_MS = Date.UTC(2026, 9, 31, 12);

afterEach(() => {
  vi.restoreAllMocks();
});

function marker(overrides?: Partial<E2eQuarantineMarker>): E2eQuarantineMarker {
  return { until: '2026-11-07', issue: '#12', ...overrides };
}

const linesOf = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
};

describe('isQuarantineApproachingExpiry', () => {
  it('is true within the final 0..3 active UTC days', () => {
    for (const until of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']) {
      const m = marker({ until });
      expect(isQuarantineApproachingExpiry(m, NOW_MS)).toBe(true);
      expect(quarantineState(m, NOW_MS)).toEqual({ kind: 'active' });
    }
  });

  it('is false outside the notice window and for non-active markers', () => {
    for (const until of ['2026-11-04', '2026-11-07', '2026-11-14']) {
      const m = marker({ until });
      expect(isQuarantineApproachingExpiry(m, NOW_MS)).toBe(false);
      expect(quarantineState(m, NOW_MS)).toEqual({ kind: 'active' });
    }
    expect(isQuarantineApproachingExpiry(marker({ until: '2026-10-30' }), NOW_MS)).toBe(false);
    expect(isQuarantineApproachingExpiry(marker({ until: '2026-11-15' }), NOW_MS)).toBe(false);
    for (const m of [
      marker({ until: '2026-1-5' }),
      marker({ until: '2026-02-30' }),
      marker({ until: 'tomorrow' }),
      marker({ issue: '12' }),
      marker({ issue: '#0' }),
      marker({ issue: '#12 extra' }),
    ]) {
      expect(isQuarantineApproachingExpiry(m, NOW_MS)).toBe(false);
    }
  });
});

describe('quarantined notice', () => {
  it('reports approaching expiry and does not fail while the body passes', async () => {
    for (const until of ['2026-11-03', '2026-10-31']) {
      const { lines, write } = linesOf();
      let runs = 0;
      const fn = quarantined(
        marker({ until }),
        1000,
        async () => {
          runs += 1;
        },
        { now: () => NOW_MS, write },
      );
      await expect(fn()).resolves.toBeUndefined();
      expect(runs).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^::warning title=e2e quarantine::#12 quarantine approaching expiry on /);
      expect(lines[0]).toContain(until);
      expect(lines[0]).toContain('approaching expiry');
      expect(lines[0]).toContain('remove or renew the marker');
    }
  });

  it('still resolves when the body throws inside the notice window, emitting both warnings', async () => {
    const { lines, write } = linesOf();
    const fn = quarantined(
      marker({ until: '2026-11-03' }),
      1000,
      async () => {
        throw new Error('flaky failure');
      },
      { now: () => NOW_MS, write },
    );
    await expect(fn()).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('approaching expiry');
    expect(lines[1]).toMatch(
      /^::warning title=e2e quarantine::#12 failed while quarantined until 2026-11-03: flaky failure/,
    );
  });

  it('writes nothing outside the notice window', async () => {
    for (const until of ['2026-11-04', '2026-11-14']) {
      const { lines, write } = linesOf();
      let runs = 0;
      const fn = quarantined(
        marker({ until }),
        1000,
        async () => {
          runs += 1;
        },
        { now: () => NOW_MS, write },
      );
      await expect(fn()).resolves.toBeUndefined();
      expect(runs).toBe(1);
      expect(lines).toEqual([]);
    }
  });

  it('rejects an expired marker exactly as before, never running the body', async () => {
    const { lines, write } = linesOf();
    let runs = 0;
    const fn = quarantined(
      marker({ until: '2026-10-30' }),
      1000,
      async () => {
        runs += 1;
      },
      { now: () => NOW_MS, write },
    );
    await expect(fn()).rejects.toThrow(
      'e2e quarantine expired on 2026-10-30 (#12): remove or renew the marker',
    );
    expect(runs).toBe(0);
    expect(lines).toEqual([]);
  });

  it('keeps the 14-day bound and rejects beyond it', async () => {
    expect(E2E_QUARANTINE_MAX_DAYS).toBe(14);
    expect(E2E_QUARANTINE_NOTICE_DAYS).toBe(3);
    const m = marker({ until: '2026-11-15' });
    expect(quarantineState(m, NOW_MS).kind).toBe('invalid');
    const { lines, write } = linesOf();
    let runs = 0;
    const fn = quarantined(
      m,
      1000,
      async () => {
        runs += 1;
      },
      { now: () => NOW_MS, write },
    );
    await expect(fn()).rejects.toThrow(
      /invalid e2e quarantine marker: until "2026-11-15" is more than 14 days after today/,
    );
    expect(runs).toBe(0);
    expect(lines).toEqual([]);
  });

  it('writes the notice through the injected write, never the real stdout', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { lines, write } = linesOf();
    const fn = quarantined(
      marker({ until: '2026-11-01' }),
      1000,
      async () => {},
      { now: () => NOW_MS, write },
    );
    await expect(fn()).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('approaching expiry');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
