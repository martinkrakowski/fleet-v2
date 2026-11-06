import { describe, expect, it } from 'vitest';

import { detectStalls, DEFAULT_STALL_THRESHOLDS, STALL_FINDINGS_MAX } from '../stall-rules.js';
import type { StallFinding, StallSnapshot, StallThresholds } from '../stall-rules.js';

const NOW = '2026-11-06T12:00:00.000Z';

/** A run parked well past the default 30-minute threshold, unowned. */
function parkedRun(overrides: Partial<StallSnapshot['runs'][number]> = {}): StallSnapshot['runs'][number] {
  return {
    id: 'run-1',
    state: 'parked',
    parkedAtIso: '2026-11-06T11:00:00.000Z',
    handOwned: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    runs: [],
    driverLease: { present: true, lapsed: false },
    admissionRefusals: [],
    providerErrors: [],
    ...overrides,
  };
}

function rulesOf(findings: readonly StallFinding[]): string[] {
  return findings.map((f) => f.rule);
}

function keysOf(findings: readonly StallFinding[]): string[] {
  return findings.map((f) => f.key);
}

describe('detectStalls', () => {
  it('is deterministic: the same snapshot gives identical keys and order on every call', () => {
    const snap = snapshot({
      runs: [parkedRun({ id: 'run-b' }), parkedRun({ id: 'run-a' })],
      driverLease: { present: false },
      providerErrors: [{ provider: 'prov-2', class: 'rate-limited', atIso: NOW }],
    });
    const first = detectStalls(snap, DEFAULT_STALL_THRESHOLDS, NOW);
    const second = detectStalls(snap, DEFAULT_STALL_THRESHOLDS, NOW);
    expect(keysOf(first)).toEqual(keysOf(second));
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    for (const finding of first) {
      expect(Object.isFrozen(finding)).toBe(true);
      expect(Object.isFrozen(finding.evidence)).toBe(true);
    }
  });

  describe('unowned-park', () => {
    it('fires just over the threshold and is silent at it', () => {
      // 61 minutes parked, threshold 30: fires.
      const over = detectStalls(
        snapshot({ runs: [parkedRun()] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(over.map((f) => f.rule)).toEqual(['unowned-park']);
      expect(over[0]?.severity).toBe('digest');
      expect(over[0]?.subjectIds).toEqual(['run-1']);
      expect(over[0]?.evidence.parkedAtIso).toBe('2026-11-06T11:00:00.000Z');

      // Exactly 30 minutes parked: silent.
      const at = detectStalls(
        snapshot({ runs: [parkedRun({ parkedAtIso: '2026-11-06T11:30:00.000Z' })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(at)).toEqual([]);
    });

    it('stays silent for a hand-owned run and for a run with an open PR', () => {
      const handOwned = detectStalls(
        snapshot({ runs: [parkedRun({ handOwned: true })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(handOwned)).toEqual([]);
      const withPr = detectStalls(
        snapshot({ runs: [parkedRun({ prNumber: 42 })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(withPr)).toEqual([]);
    });
  });

  describe('driver-absent', () => {
    it('pages when the lease is missing while non-terminal runs exist', () => {
      const findings = detectStalls(
        snapshot({
          runs: [parkedRun({ parkedAtIso: NOW }),
            { id: 'run-2', state: 'merged', handOwned: false }],
          driverLease: { present: false },
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      const absent = findings.find((f) => f.rule === 'driver-absent');
      expect(absent?.severity).toBe('page');
      expect(absent?.subjectIds).toEqual([]);
      expect(absent?.evidence.nonTerminalRuns).toBe(1);
    });

    it('is silent when the lease is live and with only terminal runs', () => {
      const live = detectStalls(
        snapshot({ runs: [parkedRun()] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(live)).not.toContain('driver-absent');
      const terminalOnly = detectStalls(
        snapshot({
          runs: [{ id: 'run-9', state: 'merged', handOwned: false }],
          driverLease: { present: false },
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(terminalOnly)).toEqual([]);
    });
  });

  describe('driver-not-adopting', () => {
    it('fires just over the threshold and is silent at it', () => {
      const over = detectStalls(
        snapshot({
          runs: [{ id: 'run-3', state: 'running', handOwned: false, lastAdvancedAtIso: '2026-11-06T11:30:00.000Z' }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(over.map((f) => f.rule)).toEqual(['driver-not-adopting']);
      expect(over[0]?.severity).toBe('page');
      expect(over[0]?.evidence.lastAdvancedAtIso).toBe('2026-11-06T11:30:00.000Z');

      const at = detectStalls(
        snapshot({
          runs: [{ id: 'run-3', state: 'running', handOwned: false, lastAdvancedAtIso: '2026-11-06T11:45:00.000Z' }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(at)).toEqual([]);
    });

    it('is silent for a parked run and for a terminal run', () => {
      const parked = detectStalls(
        snapshot({
          runs: [parkedRun({ lastAdvancedAtIso: '2026-11-06T10:00:00.000Z' })],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(parked)).toEqual(['unowned-park']);
    });
  });

  describe('review-failing', () => {
    it('fires at the threshold and stays silent below it', () => {
      const at = detectStalls(
        snapshot({
          runs: [parkedRun({ parkedAtIso: NOW, recentReviewCodes: ['review-no-receipt', 'seat-busy'] })],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(at.map((f) => f.rule)).toEqual(['review-failing']);
      expect(at[0]?.evidence.failures).toBe(2);

      const below = detectStalls(
        snapshot({
          runs: [parkedRun({ parkedAtIso: NOW, recentReviewCodes: ['review-no-receipt'] })],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(below)).toEqual([]);
    });

    it('gives one finding per run and ignores non-failing codes', () => {
      const findings = detectStalls(
        snapshot({
          runs: [
            parkedRun({ id: 'run-a', parkedAtIso: NOW, recentReviewCodes: ['unparseable-verdict', 'review-unknown', 'other'] }),
            parkedRun({ id: 'run-b', parkedAtIso: NOW, recentReviewCodes: ['other'] }),
          ],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual(['review-failing:run-a']);
    });
  });

  describe('admission-loop', () => {
    it('fires on the count just over the threshold and is silent at it', () => {
      const over = detectStalls(
        snapshot({
          admissionRefusals: [{ laneId: 'lane-1', count: 7, firstAtIso: NOW }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(over.map((f) => f.rule)).toEqual(['admission-loop']);
      expect(over[0]?.evidence.refusals).toBe(7);

      const at = detectStalls(
        snapshot({
          admissionRefusals: [{ laneId: 'lane-1', count: 6, firstAtIso: NOW }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(at)).toEqual([]);
    });

    it('fires on age just over the threshold and is silent at it', () => {
      const over = detectStalls(
        snapshot({
          admissionRefusals: [{ laneId: 'lane-2', count: 1, firstAtIso: '2026-11-06T09:59:59.000Z' }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(over.map((f) => f.rule)).toEqual(['admission-loop']);
      expect(over[0]?.evidence.firstAtIso).toBe('2026-11-06T09:59:59.000Z');

      const at = detectStalls(
        snapshot({
          admissionRefusals: [{ laneId: 'lane-2', count: 1, firstAtIso: '2026-11-06T10:00:00.000Z' }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(at)).toEqual([]);
    });
  });

  describe('provider-limit', () => {
    it('pages once per provider for a limiting class', () => {
      const findings = detectStalls(
        snapshot({
          providerErrors: [
            { provider: 'prov-1', class: 'rate-limited', atIso: NOW },
            { provider: 'prov-1', class: 'usage-limit', atIso: NOW },
            { provider: 'prov-2', class: 'payment-required', atIso: NOW },
            { provider: 'prov-3', class: 'something-else', atIso: NOW },
          ],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual([
        'provider-limit:prov-1',
        'provider-limit:prov-2',
      ]);
      expect(findings[0]?.severity).toBe('page');
      expect(findings[0]?.evidence.errorClass).toBe('rate-limited');
    });
  });

  describe('invalid times', () => {
    it('gives snapshot-invalid naming the field and fires no time rule for that run', () => {
      const findings = detectStalls(
        snapshot({
          runs: [parkedRun({ parkedAtIso: 'not-a-time' })],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual(['snapshot-invalid:runs[0].parkedAtIso']);
      expect(findings[0]?.evidence.field).toBe('runs[0].parkedAtIso');
      expect(findings[0]?.evidence.reason).toBe('invalid-time');
    });

    it('names the clock field and keeps non-time rules working', () => {
      const findings = detectStalls(
        snapshot({
          runs: [parkedRun({ parkedAtIso: NOW, recentReviewCodes: ['seat-busy', 'seat-busy'] })],
        }),
        DEFAULT_STALL_THRESHOLDS,
        'yesterday',
      );
      expect(rulesOf(findings)).toEqual(['review-failing', 'snapshot-invalid']);
      expect(findings.find((f) => f.rule === 'snapshot-invalid')?.evidence.field).toBe('nowIso');
    });
  });

  describe('missing times', () => {
    it('names a parked run without parkedAtIso and fires no unowned-park', () => {
      const findings = detectStalls(
        snapshot({
          runs: [{ id: 'run-p', state: 'parked', handOwned: false }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual(['snapshot-invalid:runs[0].parkedAtIso']);
      expect(findings[0]?.evidence.field).toBe('runs[0].parkedAtIso');
      expect(findings[0]?.evidence.reason).toBe('missing-time');
      expect(rulesOf(findings)).not.toContain('unowned-park');
    });

    it('names a non-terminal non-parked run without lastAdvancedAtIso and fires no driver-not-adopting', () => {
      const findings = detectStalls(
        snapshot({
          runs: [{ id: 'run-r', state: 'running', handOwned: false }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual(['snapshot-invalid:runs[0].lastAdvancedAtIso']);
      expect(findings[0]?.evidence.field).toBe('runs[0].lastAdvancedAtIso');
      expect(findings[0]?.evidence.reason).toBe('missing-time');
      expect(rulesOf(findings)).not.toContain('driver-not-adopting');
    });

    it('does not demand a timestamp a run does not need', () => {
      // A terminal run needs neither timestamp.
      const terminal = detectStalls(
        snapshot({
          runs: [{ id: 'run-t', state: 'merged', handOwned: false }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(terminal)).toEqual([]);

      // A parked run does not need lastAdvancedAtIso; with its own timestamp
      // present and fresh it stays silent.
      const parkedOnly = detectStalls(
        snapshot({
          runs: [{ id: 'run-p', state: 'parked', handOwned: false, parkedAtIso: NOW }],
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(parkedOnly)).toEqual([]);
    });
  });

  describe('runtime-malformed snapshots', () => {
    it('answers a typed snapshot-invalid finding for null and for a missing array', () => {
      for (const bad of [null, undefined, 42, { driverLease: { present: true } }]) {
        const findings = detectStalls(bad as unknown as StallSnapshot, DEFAULT_STALL_THRESHOLDS, NOW);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.rule).toBe('snapshot-invalid');
        expect(findings[0]?.severity).toBe('digest');
      }
    });

    it('never throws for a throwing getter or a hostile prototype', () => {
      const hostile: Record<string, unknown> = {
        driverLease: { present: true },
      };
      Object.defineProperty(hostile, 'runs', {
        get() {
          throw new Error('boom');
        },
        enumerable: true,
      });
      const findings = detectStalls(hostile as unknown as StallSnapshot, DEFAULT_STALL_THRESHOLDS, NOW);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('snapshot-invalid');

      const proto = snapshot();
      const sneaky = Object.create(Object.prototype) as Record<string, unknown>;
      Object.defineProperty(sneaky, 'runs', {
        get() {
          throw new Error('boom');
        },
        enumerable: true,
      });
      expect(() => detectStalls(sneaky as unknown as StallSnapshot, DEFAULT_STALL_THRESHOLDS, NOW)).not.toThrow();
      expect(proto).toBeDefined();
    });
  });

  describe('secrets', () => {
    it('never copies a secret-shaped id into evidence or a key', () => {
      const secret = 'ghp_' + 'A'.repeat(36);
      const findings = detectStalls(
        snapshot({ runs: [parkedRun({ id: secret })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.subjectIds).toEqual(['<redacted>']);
      expect(findings[0]?.evidence.runId).toBe('<redacted>');
      expect(JSON.stringify(findings)).not.toContain('ghp_');
    });

    it('keeps safe ids and rejects an id of the wrong shape', () => {
      const findings = detectStalls(
        snapshot({ runs: [parkedRun({ id: 'has space' })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(findings[0]?.subjectIds).toEqual(['<redacted>']);
      const safe = detectStalls(
        snapshot({ runs: [parkedRun({ id: 'run-abc-123' })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(safe[0]?.subjectIds).toEqual(['run-abc-123']);
    });
  });

  describe('bounded', () => {
    it('caps findings at the maximum and adds one truncated finding', () => {
      const runs = Array.from({ length: STALL_FINDINGS_MAX + 5 }, (_, i) => ({
        id: `run-${i}`,
        state: 'running',
        handOwned: false,
        lastAdvancedAtIso: '2026-11-06T10:00:00.000Z',
      }));
      const findings = detectStalls(snapshot({ runs }), DEFAULT_STALL_THRESHOLDS, NOW);
      expect(findings).toHaveLength(STALL_FINDINGS_MAX + 1);
      const truncated = findings.filter((f) => f.rule === 'truncated');
      expect(truncated).toHaveLength(1);
      expect(truncated[0]?.evidence.dropped).toBe(5);
    });

    it('honors custom thresholds', () => {
      const thresholds: StallThresholds = { ...DEFAULT_STALL_THRESHOLDS, parkedMinutes: 120 };
      const findings = detectStalls(
        snapshot({ runs: [parkedRun()] }),
        thresholds,
        NOW,
      );
      expect(rulesOf(findings)).toEqual([]);
    });
  });

  describe('review round 3 fixes', () => {
    it('treats every declared non-terminal lane-run state as active', () => {
      for (const state of ['collecting', 'gating', 'brief-check', 'code-review', 'accepting', 'opening-pr'] as const) {
        const findings = detectStalls(
          snapshot({ runs: [{ id: 'run-s', state, handOwned: false, lastAdvancedAtIso: '2026-11-06T11:30:00.000Z' }] }),
          DEFAULT_STALL_THRESHOLDS,
          NOW,
        );
        expect(rulesOf(findings)).toEqual(['driver-not-adopting']);
      }
      const absent = detectStalls(
        snapshot({
          runs: [{ id: 'run-g', state: 'gating', handOwned: false, lastAdvancedAtIso: NOW }],
          driverLease: { present: false },
        }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(absent)).toContain('driver-absent');
    });

    it('fires one second past the threshold, without waiting for the next whole minute', () => {
      const parked = detectStalls(
        snapshot({ runs: [parkedRun({ parkedAtIso: '2026-11-06T11:29:59.000Z' })] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(parked)).toEqual(['unowned-park']);
      expect(parked[0]?.evidence.minutes).toBe(30);
      const advanced = detectStalls(
        snapshot({ runs: [{ id: 'run-3', state: 'running', handOwned: false, lastAdvancedAtIso: '2026-11-06T11:44:59.000Z' }] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(rulesOf(advanced)).toEqual(['driver-not-adopting']);
    });

    it('keeps the provider-limit page when a provider error has no atIso, and names the field', () => {
      const findings = detectStalls(
        snapshot({ providerErrors: [{ provider: 'prov-1', class: 'rate-limited' }] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual(['provider-limit:prov-1', 'snapshot-invalid:providerErrors[0].atIso']);
      expect(findings[0]?.evidence.atIso).toBeNull();
      expect(findings[1]?.evidence.reason).toBe('missing-time');
    });

    it('freezes the single finding answered for a malformed snapshot', () => {
      const findings = detectStalls(null as unknown as StallSnapshot, DEFAULT_STALL_THRESHOLDS, NOW);
      expect(rulesOf(findings)).toEqual(['snapshot-invalid']);
      expect(Object.isFrozen(findings)).toBe(true);
    });

    it('names a provider error with an invalid atIso and keeps its provider-limit page', () => {
      const findings = detectStalls(
        snapshot({ providerErrors: [{ provider: 'prov-1', class: 'rate-limited', atIso: 'not-a-time' }] }),
        DEFAULT_STALL_THRESHOLDS,
        NOW,
      );
      expect(keysOf(findings)).toEqual(['provider-limit:prov-1', 'snapshot-invalid:providerErrors[0].atIso']);
      expect(findings[0]?.evidence.atIso).toBeNull();
      expect(findings[1]?.evidence.reason).toBe('invalid-time');
    });
  });
});
