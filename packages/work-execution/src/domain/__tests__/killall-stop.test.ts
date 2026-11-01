import { describe, expect, it } from 'vitest';

import {
  KILLALL_STOP_REPORT_RECORD_VERSION,
  isKillallMarkerHalted,
  isKillallSweepConfirmed,
  killallStopReportConfirmed,
  readKillallLaneStop,
  readKillallMarkerState,
  readKillallStopReportRecord,
  readKillallTrainPause,
  reopenOnLateStart,
} from '../killall-stop.js';
import type { KillallStopReportRecord } from '../killall-stop.js';

const HALTED_AT = '2026-11-01T10:00:00.000Z';
const CONFIRMED_AT = '2026-11-01T10:05:00.000Z';
const LATE_START_AT = '2026-11-01T10:06:00.000Z';

function lane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'project-1',
    laneId: 'lane-1',
    confirmed: true,
    unconfirmedReason: null,
    cleanSweeps: 2,
    confirmedAtIso: CONFIRMED_AT,
    sessionResults: [],
    ...overrides,
  };
}

function unconfirmedLane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return lane({
    confirmed: false,
    unconfirmedReason: 'unknown',
    cleanSweeps: 0,
    confirmedAtIso: null,
    ...overrides,
  });
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: KILLALL_STOP_REPORT_RECORD_VERSION,
    haltedAtIso: HALTED_AT,
    marker: 'halted',
    cleanSweeps: 2,
    lanes: [lane()],
    train: { paused: true, acknowledged: true, unconfirmedReason: null },
    ...overrides,
  };
}

function parsed(input: unknown): KillallStopReportRecord {
  const read = readKillallStopReportRecord(input);
  if (!read.ok) {
    throw new Error(`fixture should parse: ${read.error}`);
  }
  return read.record;
}

describe('report read', () => {
  it('accepts an ordinary plain object with the exact keys', () => {
    expect(readKillallStopReportRecord(report())).toMatchObject({ ok: true });
    expect(parsed(report()).version).toBe(KILLALL_STOP_REPORT_RECORD_VERSION);
  });

  it('names the rule without echoing a supplied value', () => {
    const result = readKillallStopReportRecord(report({ haltedAtIso: 'SENTINEL-VALUE' }));
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('SENTINEL-VALUE');
  });

  it('refuses an extra or missing key', () => {
    expect(readKillallStopReportRecord(report({ extra: 'x' }))).toMatchObject({ ok: false });
    const missingKey = report();
    delete missingKey.train;
    expect(readKillallStopReportRecord(missingKey)).toMatchObject({ ok: false });
  });

  it('refuses an object with a custom prototype', () => {
    const prototyped = report();
    Object.setPrototypeOf(prototyped, Object.create({}));
    expect(readKillallStopReportRecord(prototyped)).toMatchObject({ ok: false });
  });

  it('refuses version 2 with an error naming the version rule', () => {
    const read = readKillallStopReportRecord(report({ version: 2 }));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toContain('version');
    }
  });

  it('refuses a non-zoned haltedAtIso', () => {
    expect(readKillallStopReportRecord(report({ haltedAtIso: '2026-11-01T10:00:00' }))).toMatchObject({ ok: false });
  });

  it('refuses a non-integer cleanSweeps', () => {
    expect(readKillallStopReportRecord(report({ cleanSweeps: 1.5 }))).toMatchObject({ ok: false });
  });
});

describe('confirmed lane shape', () => {
  it('refuses a session reference that is not an opaque identifier', () => {
    for (const sessionRef of ['/clients/acme/transcript', 'free text', '', 'x'.repeat(129)]) {
      const input = lane({ sessionResults: [{ sessionRef, stopped: true }] });
      expect(readKillallLaneStop(input)).toBeNull();
    }
  });

  it('accepts a confirmed lane with a null reason, cleanSweeps >= 2 and a zoned time', () => {
    expect(readKillallLaneStop(lane())).toEqual({
      projectId: 'project-1',
      laneId: 'lane-1',
      confirmed: true,
      unconfirmedReason: null,
      cleanSweeps: 2,
      confirmedAtIso: CONFIRMED_AT,
      sessionResults: [],
    });
  });

  it('refuses cleanSweeps below 2', () => {
    expect(readKillallLaneStop(lane({ cleanSweeps: 1 }))).toBeNull();
    expect(readKillallStopReportRecord(report({ lanes: [lane({ cleanSweeps: 1 })] }))).toMatchObject({ ok: false });
  });

  it('refuses a naive time as confirmedAtIso', () => {
    expect(readKillallLaneStop(lane({ confirmedAtIso: '2026-11-01T10:05:00' }))).toBeNull();
  });

  it('refuses a confirmed lane that carries a reason', () => {
    expect(readKillallLaneStop(lane({ unconfirmedReason: 'not-stopped' }))).toBeNull();
  });

  it('refuses a confirmed lane that lists a session that did not stop', () => {
    expect(
      readKillallLaneStop(
        lane({
          sessionResults: [{ sessionRef: 'ses-1', stopped: false }],
        }),
      ),
    ).toBeNull();
  });
});

describe('unconfirmed lane shape', () => {
  it('accepts a well-formed unconfirmed lane', () => {
    expect(readKillallLaneStop(unconfirmedLane())).toMatchObject({
      confirmed: false,
      unconfirmedReason: 'unknown',
      cleanSweeps: 0,
      confirmedAtIso: null,
    });
  });

  it('refuses a set confirmedAtIso when unconfirmed', () => {
    expect(readKillallLaneStop(unconfirmedLane({ confirmedAtIso: CONFIRMED_AT }))).toBeNull();
  });

  it('refuses an unknown reason token (no free text)', () => {
    expect(readKillallLaneStop(unconfirmedLane({ unconfirmedReason: 'write-in free text' }))).toBeNull();
    expect(readKillallLaneStop(unconfirmedLane({ unconfirmedReason: '' }))).toBeNull();
  });

  it('refuses a negative cleanSweeps', () => {
    expect(readKillallLaneStop(unconfirmedLane({ cleanSweeps: -1 }))).toBeNull();
  });
});

describe('sweep confirmation rule', () => {
  it('confirms only when stopped and cleanSweeps is an integer of at least 2', () => {
    expect(isKillallSweepConfirmed(2, true)).toBe(true);
    expect(isKillallSweepConfirmed(3, true)).toBe(true);
    expect(isKillallSweepConfirmed(1, true)).toBe(false);
    expect(isKillallSweepConfirmed(2, false)).toBe(false);
    expect(isKillallSweepConfirmed(0, false)).toBe(false);
    expect(isKillallSweepConfirmed(1.5, true)).toBe(false);
    expect(isKillallSweepConfirmed(Infinity, true)).toBe(false);
    expect(isKillallSweepConfirmed(NaN, true)).toBe(false);
  });
});

describe('whole-report confirmation', () => {
  it('confirms when marker is halted, train is paused and acknowledged, and every lane is confirmed', () => {
    expect(killallStopReportConfirmed(parsed(report()))).toBe(true);
  });

  it('cannot confirm with a clear or unreadable marker', () => {
    expect(killallStopReportConfirmed(parsed(report({ marker: 'clear' })))).toBe(false);
    expect(killallStopReportConfirmed(parsed(report({ marker: 'unreadable' })))).toBe(false);
  });

  it('cannot confirm when the train is unacknowledged or carries a reason', () => {
    expect(
      killallStopReportConfirmed(parsed(report({ train: { paused: true, acknowledged: false, unconfirmedReason: 'not-stopped' } }))),
    ).toBe(false);
    const withReason: KillallStopReportRecord = {
      ...parsed(report()),
      train: { paused: true, acknowledged: true, unconfirmedReason: 'unknown' },
    };
    expect(killallStopReportConfirmed(withReason)).toBe(false);
  });

  it('cannot confirm when any lane is unconfirmed', () => {
    expect(
      killallStopReportConfirmed(
        parsed(
          report({
            lanes: [lane(), lane({ confirmed: false, unconfirmedReason: 'unknown', cleanSweeps: 0, confirmedAtIso: null })],
          }),
        ),
      ),
    ).toBe(false);
  });

  it('cannot confirm when a hand-built report has a confirmed lane with an unstopped session', () => {
    const handBuilt: KillallStopReportRecord = {
      version: KILLALL_STOP_REPORT_RECORD_VERSION,
      haltedAtIso: HALTED_AT,
      marker: 'halted',
      cleanSweeps: 2,
      lanes: [
        {
          projectId: 'project-1',
          laneId: 'lane-1',
          confirmed: true,
          unconfirmedReason: null,
          cleanSweeps: 2,
          confirmedAtIso: CONFIRMED_AT,
          sessionResults: [{ sessionRef: 'ses-1', stopped: false }],
        },
      ],
      train: { paused: true, acknowledged: true, unconfirmedReason: null },
    };
    expect(killallStopReportConfirmed(handBuilt)).toBe(false);
  });

  it('cannot confirm with fewer than two whole clean sweeps', () => {
    expect(killallStopReportConfirmed(parsed(report({ cleanSweeps: 1 })))).toBe(false);
    const fractional: KillallStopReportRecord = { ...parsed(report()), cleanSweeps: 1.5 };
    expect(killallStopReportConfirmed(fractional)).toBe(false);
  });

  it('confirms an empty lanes list only after two clean sweeps', () => {
    expect(killallStopReportConfirmed(parsed(report({ lanes: [], cleanSweeps: 1 })))).toBe(false);
    expect(killallStopReportConfirmed(parsed(report({ lanes: [], cleanSweeps: 2 })))).toBe(true);
  });
});

describe('late start reopens', () => {
  it('turns a confirmed lane back to unconfirmed with zero clean sweeps', () => {
    const original = parsed(report());
    const reopened = reopenOnLateStart(original, 'project-1', 'lane-1', LATE_START_AT);
    expect(reopened).not.toBe(original);
    expect(reopened.lanes[0]).toEqual({
      projectId: 'project-1',
      laneId: 'lane-1',
      confirmed: false,
      unconfirmedReason: 'not-stopped',
      cleanSweeps: 0,
      confirmedAtIso: null,
      sessionResults: [],
    });
    expect(reopened.haltedAtIso).toBe(HALTED_AT);
    expect(reopened.marker).toBe('halted');
    expect(reopened.train).toEqual({ paused: true, acknowledged: true, unconfirmedReason: null });
  });

  it('never mutates the input', () => {
    const original = parsed(report());
    reopenOnLateStart(original, 'project-1', 'lane-1', LATE_START_AT);
    expect(original.lanes[0].confirmed).toBe(true);
    expect(original.lanes[0].cleanSweeps).toBe(2);
  });

  it('leaves unknown lanes and already-unconfirmed lanes unchanged', () => {
    const original = parsed(report());
    expect(reopenOnLateStart(original, 'project-9', 'lane-9', LATE_START_AT)).toBe(original);
    const alreadyOpen = parsed(
      report({
        lanes: [lane({ confirmed: false, unconfirmedReason: 'unknown', cleanSweeps: 0, confirmedAtIso: null })],
      }),
    );
    expect(reopenOnLateStart(alreadyOpen, 'project-1', 'lane-1', LATE_START_AT)).toBe(alreadyOpen);
  });

  it('ignores an invalid atIso', () => {
    const original = parsed(report());
    expect(reopenOnLateStart(original, 'project-1', 'lane-1', '2026-11-01T10:06:00')).toBe(original);
    expect(reopenOnLateStart(original, 'project-1', 'lane-1', 'not-a-time')).toBe(original);
  });
});

describe('train pause read', () => {
  it('accepts a confirmed pause with a null reason', () => {
    expect(readKillallTrainPause({ paused: true, acknowledged: true, unconfirmedReason: null })).toEqual({
      paused: true,
      acknowledged: true,
      unconfirmedReason: null,
    });
  });

  it('accepts an unconfirmed pause with a bounded reason', () => {
    expect(readKillallTrainPause({ paused: true, acknowledged: false, unconfirmedReason: 'not-stopped' })).toEqual({
      paused: true,
      acknowledged: false,
      unconfirmedReason: 'not-stopped',
    });
  });

  it('rejects a missing reason', () => {
    expect(readKillallTrainPause({ paused: true, acknowledged: false, unconfirmedReason: null })).toBeNull();
    expect(readKillallTrainPause({ paused: true, acknowledged: false })).toBeNull();
  });

  it('rejects inconsistent paused:false with acknowledged:true', () => {
    expect(readKillallTrainPause({ paused: false, acknowledged: true, unconfirmedReason: 'not-stopped' })).toBeNull();
    expect(readKillallTrainPause({ paused: false, acknowledged: true, unconfirmedReason: null })).toBeNull();
  });

  it('rejects non-boolean fields, extra keys and free-text reasons', () => {
    expect(readKillallTrainPause({ paused: 1, acknowledged: true, unconfirmedReason: null })).toBeNull();
    expect(readKillallTrainPause({ paused: true, acknowledged: true, unconfirmedReason: null, extra: true })).toBeNull();
    expect(readKillallTrainPause({ paused: true, acknowledged: false, unconfirmedReason: 'because why not' })).toBeNull();
  });
});

describe('marker rules', () => {
  it('reads clear, halted and unreadable and folds failures to unreadable', () => {
    expect(readKillallMarkerState('clear')).toBe('clear');
    expect(readKillallMarkerState('halted')).toBe('halted');
    expect(readKillallMarkerState('unreadable')).toBe('unreadable');
    expect(readKillallMarkerState('')).toBe('unreadable');
    expect(readKillallMarkerState(undefined)).toBe('unreadable');
    expect(readKillallMarkerState(null)).toBe('unreadable');
    expect(readKillallMarkerState(42)).toBe('unreadable');
    expect(readKillallMarkerState({})).toBe('unreadable');
    expect(readKillallMarkerState('half')).toBe('unreadable');
  });

  it('treats halted and unreadable as halted (fail closed)', () => {
    expect(isKillallMarkerHalted('halted')).toBe(true);
    expect(isKillallMarkerHalted('unreadable')).toBe(true);
    expect(isKillallMarkerHalted('clear')).toBe(false);
  });

  it('includes marker state in the stop report', () => {
    expect(parsed(report()).marker).toBe('halted');
    expect(parsed(report({ marker: 'clear' })).marker).toBe('clear');
    expect(parsed(report({ marker: 'unreadable' })).marker).toBe('unreadable');
  });

  it('rejects a marker outside the contract', () => {
    expect(readKillallStopReportRecord(report({ marker: 'half' }))).toMatchObject({ ok: false });
  });
});

describe('session results', () => {
  it('preserves non-content session references and stop outcomes', () => {
    const laneRead = readKillallLaneStop(
      unconfirmedLane({
        sessionResults: [
          { sessionRef: 'ses-interactive-1', stopped: true },
          { sessionRef: 'ses-interactive-2', stopped: false },
        ],
      }),
    );
    expect(laneRead).not.toBeNull();
    expect(laneRead?.sessionResults).toEqual([
      { sessionRef: 'ses-interactive-1', stopped: true },
      { sessionRef: 'ses-interactive-2', stopped: false },
    ]);
    expect(
      readKillallStopReportRecord(
        report({
          lanes: [lane({ sessionResults: [{ sessionRef: 'ses-interactive-1', stopped: true }] })],
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('rejects a confirmed lane with an unstopped session in report read', () => {
    expect(
      readKillallStopReportRecord(
        report({
          lanes: [lane({ sessionResults: [{ sessionRef: 'ses-1', stopped: false }] })],
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('rejects malformed session-result entries', () => {
    // transcript, prompt and path shapes are content and are refused as extra keys
    expect(readKillallLaneStop(lane({ sessionResults: [{ sessionRef: 's-1', stopped: true, transcript: 'secret' }] }))).toBeNull();
    expect(readKillallLaneStop(lane({ sessionResults: [{ sessionRef: 's-1', stopped: true, prompt: 'p' }] }))).toBeNull();
    expect(readKillallLaneStop(lane({ sessionResults: [{ sessionRef: 's-1', stopped: true, path: '/etc/config' }] }))).toBeNull();
    // non-string reference
    expect(readKillallLaneStop(lane({ sessionResults: [{ sessionRef: 12, stopped: true }] }))).toBeNull();
    // non-boolean stop status
    expect(readKillallLaneStop(lane({ sessionResults: [{ sessionRef: 's-1', stopped: 'yes' }] }))).toBeNull();
    // non-object entry
    expect(readKillallLaneStop(lane({ sessionResults: ['s-1'] }))).toBeNull();
    // missing key
    expect(readKillallLaneStop(lane({ sessionResults: [{ stopped: true }] }))).toBeNull();
  });
});

describe('revoked proxy input', () => {
  it('refuses and does not throw when passed to each exported reader', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => readKillallMarkerState(proxy)).not.toThrow();
    expect(readKillallMarkerState(proxy)).toBe('unreadable');

    expect(() => readKillallTrainPause(proxy)).not.toThrow();
    expect(readKillallTrainPause(proxy)).toBeNull();

    expect(() => readKillallLaneStop(proxy)).not.toThrow();
    expect(readKillallLaneStop(proxy)).toBeNull();

    expect(() => readKillallStopReportRecord(proxy)).not.toThrow();
    expect(readKillallStopReportRecord(proxy)).toMatchObject({ ok: false });
  });
});
