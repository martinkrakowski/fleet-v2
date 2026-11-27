/**
 * FC13B hostile-input and behaviour tests for the weekly SLO report builder
 * and plain-text renderer: every function takes `unknown` plus a required
 * `isProxy` detector, never throws, and every refusal is the typed reason —
 * an unknown state is never an implicit pass.
 */

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import { MAX_SLO_SAMPLES } from '../slo-calculators.js';
import { buildWeeklySloReport, renderSloReportText } from '../slo-report.js';

const isProxy = types.isProxy;

const T0 = '2026-11-23T00:00:00.000Z';
const T7 = '2026-11-30T00:00:00.000Z';

const t = (seconds: number): string =>
  `2026-11-23T00:00:${String(seconds).padStart(2, '0')}.000Z`;

function admissionSample(requestedAtIso: string, admittedAtIso: string): unknown {
  return { requestedAtIso, admittedAtIso };
}

function parkSample(parkedAtIso: string, notifiedAtIso: string | null): unknown {
  return { parkedAtIso, notifiedAtIso };
}

const OBJECTIVE_MS = 45_000;

function healthyInput(): Record<string, unknown> {
  return {
    weekStartIso: T0,
    admission: {
      samplesMs: [admissionSample(t(0), t(10)), admissionSample(t(0), t(20))],
      objectiveMs: OBJECTIVE_MS,
    },
    parkNotify: {
      samplesMs: [parkSample(t(0), t(30))],
      objectiveMs: OBJECTIVE_MS,
    },
  };
}

function validRenderableReport(): Record<string, unknown> {
  return {
    weekStartIso: T0,
    weekEndIso: T7,
    admission: { ok: true, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 20_000, met: true },
    parkNotify: { ok: true, count: 1, invalid: 0, unnotified: 0, p50Ms: 30_000, p95Ms: 30_000, met: true },
    breaches: [],
  };
}

/** A getter whose every read is recorded; the code under test must never read it. */
function getterOver(value: unknown, log: string[], name: string): unknown {
  return Object.defineProperty({}, name, {
    get() {
      log.push(name);
      return value;
    },
    enumerable: true,
    configurable: true,
  });
}

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

describe('buildWeeklySloReport', () => {
  it('builds a healthy week report: derived weekEndIso, calculator summaries reused verbatim, empty breaches', () => {
    const result = buildWeeklySloReport(healthyInput(), isProxy);
    expect(result).toEqual({
      ok: true,
      report: {
        weekStartIso: T0,
        weekEndIso: T7,
        admission: { ok: true, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 20_000, met: true },
        parkNotify: { ok: true, count: 1, invalid: 0, unnotified: 0, p50Ms: 30_000, p95Ms: 30_000, met: true },
        breaches: [],
      },
    });
  });

  it('reports an admission breach when p95 misses the objective, naming only admission', () => {
    const input = healthyInput();
    (input.admission as Record<string, unknown>).samplesMs = [admissionSample(t(0), t(50))];
    const result = buildWeeklySloReport(input, isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.admission).toEqual({ ok: true, count: 1, invalid: 0, p50Ms: 50_000, p95Ms: 50_000, met: false });
      expect(result.report.breaches).toEqual(['admission']);
    }
  });

  it('reports breaches via invalid > 0 and unnotified > 0 even when count is 0, and both SLOs together', () => {
    const invalidOnly = buildWeeklySloReport(
      {
        weekStartIso: T0,
        admission: { samplesMs: [admissionSample('not-iso', t(1))], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(invalidOnly.ok).toBe(true);
    if (invalidOnly.ok) {
      expect(invalidOnly.report.admission).toEqual({ ok: true, count: 0, invalid: 1, p50Ms: null, p95Ms: null, met: false });
      expect(invalidOnly.report.breaches).toEqual(['admission']);
    }

    const unnotifiedOnly = buildWeeklySloReport(
      {
        weekStartIso: T0,
        admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [parkSample(t(0), null)], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(unnotifiedOnly.ok).toBe(true);
    if (unnotifiedOnly.ok) {
      expect(unnotifiedOnly.report.parkNotify).toEqual({ ok: true, count: 0, invalid: 0, unnotified: 1, p50Ms: null, p95Ms: null, met: false });
      expect(unnotifiedOnly.report.breaches).toEqual(['park-notify']);
    }

    const both = buildWeeklySloReport(
      {
        weekStartIso: T0,
        admission: { samplesMs: [admissionSample(t(0), t(90))], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [parkSample(t(0), t(90))], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.report.breaches).toEqual(['admission', 'park-notify']);
    }
  });

  it('propagates admission calculator refusal reasons without echoing samples or objective values', () => {
    const sparse: unknown[] = [admissionSample(t(0), t(1)), admissionSample(t(1), t(2))];
    delete sparse[1];
    const withGetter = Object.defineProperty([admissionSample(t(0), t(1))], '0', {
      get() {
        throw new Error('the samples getter must never run');
      },
      enumerable: true,
      configurable: true,
    });
    const cases: Array<[unknown, string]> = [
      [{ samplesMs: [], objectiveMs: '5' }, 'invalid-objective'],
      [{ samplesMs: [], objectiveMs: -1 }, 'invalid-objective'],
      [{ samplesMs: {}, objectiveMs: OBJECTIVE_MS }, 'invalid-samples-list'],
      [{ samplesMs: sparse, objectiveMs: OBJECTIVE_MS }, 'invalid-samples-list'],
      [{ samplesMs: withGetter, objectiveMs: OBJECTIVE_MS }, 'invalid-samples-list'],
      [{ samplesMs: new Array(MAX_SLO_SAMPLES + 1), objectiveMs: OBJECTIVE_MS }, 'too-many-samples'],
    ];
    for (const [wrapper, calculatorReason] of cases) {
      const result = buildWeeklySloReport(
        { weekStartIso: T0, admission: wrapper, parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS } },
        isProxy,
      );
      // Exact shape: only `ok`, `reason` and `calculatorReason` — no echoed values.
      expect(result).toEqual({ ok: false, reason: 'admission-refused', calculatorReason });
    }
  });

  it('propagates park-notify calculator refusal reasons without echoing samples or objective values', () => {
    const sparse: unknown[] = [parkSample(t(0), t(1)), parkSample(t(1), t(2))];
    delete sparse[0];
    const cases: Array<[unknown, string]> = [
      [{ samplesMs: [], objectiveMs: null }, 'invalid-objective'],
      [{ samplesMs: [], objectiveMs: Number.NaN }, 'invalid-objective'],
      [{ samplesMs: 7, objectiveMs: OBJECTIVE_MS }, 'invalid-samples-list'],
      [{ samplesMs: sparse, objectiveMs: OBJECTIVE_MS }, 'invalid-samples-list'],
      [{ samplesMs: new Array(MAX_SLO_SAMPLES + 1), objectiveMs: OBJECTIVE_MS }, 'too-many-samples'],
    ];
    for (const [wrapper, calculatorReason] of cases) {
      const result = buildWeeklySloReport(
        { weekStartIso: T0, admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS }, parkNotify: wrapper },
        isProxy,
      );
      expect(result).toEqual({ ok: false, reason: 'park-notify-refused', calculatorReason });
    }
  });

  it('maps an unexpected root key holding an over-limit array to invalid-week rather than park-notify-refused', () => {
    const overLimit = { ...healthyInput(), extra: new Array(MAX_SLO_SAMPLES + 1) };
    expect(buildWeeklySloReport(overLimit, isProxy)).toEqual({ ok: false, reason: 'invalid-week' });
    const smallExtra = { ...healthyInput(), extra: 1 };
    expect(buildWeeklySloReport(smallExtra, isProxy)).toEqual({ ok: false, reason: 'invalid-week' });
    const nestedExtra = { ...healthyInput(), extra: { parkNotify: { samplesMs: [], objectiveMs: 1 } } };
    expect(buildWeeklySloReport(nestedExtra, isProxy)).toEqual({ ok: false, reason: 'invalid-week' });
  });

  it('refuses malformed or hostile admission wrapper with admission-refused and invalid-slo-input', () => {
    const getterLog: string[] = [];
    const cases: unknown[] = [
      { objectiveMs: OBJECTIVE_MS },
      { samplesMs: [] },
      { samplesMs: [], objectiveMs: OBJECTIVE_MS, extra: 1 },
      getterOver({ samplesMs: [], objectiveMs: OBJECTIVE_MS }, getterLog, 'admission'),
      new Proxy({ samplesMs: [], objectiveMs: OBJECTIVE_MS }, {}),
      revokedProxy(),
      [],
      null,
    ];
    for (const wrapper of cases) {
      const result = buildWeeklySloReport(
        { weekStartIso: T0, admission: wrapper, parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS } },
        isProxy,
      );
      expect(result).toEqual({ ok: false, reason: 'admission-refused', calculatorReason: 'invalid-slo-input' });
    }
    // An own `__proto__` key on the wrapper (copied as data by the snapshot).
    const polluted = JSON.parse(
      `{"weekStartIso":"${T0}","admission":{"__proto__":{},"samplesMs":[],"objectiveMs":45000},"parkNotify":{"samplesMs":[],"objectiveMs":45000}}`,
    );
    expect(buildWeeklySloReport(polluted, isProxy)).toEqual({
      ok: false,
      reason: 'admission-refused',
      calculatorReason: 'invalid-slo-input',
    });
    expect(getterLog).toEqual([]);
  });

  it('refuses malformed or hostile parkNotify wrapper with park-notify-refused and invalid-slo-input', () => {
    const cases: unknown[] = [
      { samplesMs: [] },
      { samplesMs: [], objectiveMs: OBJECTIVE_MS, extra: true },
      new Proxy({ samplesMs: [], objectiveMs: OBJECTIVE_MS }, {}),
      revokedProxy(),
      'admission',
    ];
    for (const wrapper of cases) {
      const result = buildWeeklySloReport(
        { weekStartIso: T0, admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS }, parkNotify: wrapper },
        isProxy,
      );
      expect(result).toEqual({ ok: false, reason: 'park-notify-refused', calculatorReason: 'invalid-slo-input' });
    }
  });

  it('treats empty sample arrays identically to the calculators with no breaches', () => {
    const result = buildWeeklySloReport(
      {
        weekStartIso: T0,
        admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      report: {
        weekStartIso: T0,
        weekEndIso: T7,
        admission: { ok: true, count: 0, invalid: 0, p50Ms: null, p95Ms: null, met: false },
        parkNotify: { ok: true, count: 0, invalid: 0, unnotified: 0, p50Ms: null, p95Ms: null, met: false },
        breaches: [],
      },
    });
  });

  it('computes weekEndIso exactly seven UTC days after weekStartIso across a month and a DST boundary', () => {
    const monthBoundary = buildWeeklySloReport(
      {
        weekStartIso: '2026-01-28T12:00:00Z',
        admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(monthBoundary.ok).toBe(true);
    if (monthBoundary.ok) {
      expect(monthBoundary.report.weekEndIso).toBe('2026-02-04T12:00:00.000Z');
    }
    const dstBoundary = buildWeeklySloReport(
      {
        weekStartIso: '2026-03-08T23:30:00Z',
        admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(dstBoundary.ok).toBe(true);
    if (dstBoundary.ok) {
      expect(dstBoundary.report.weekEndIso).toBe('2026-03-15T23:30:00.000Z');
    }
  });

  it('refuses non-zoned, non-string, and calendar-rollover weekStartIso values with invalid-week', () => {
    const wrapper = { samplesMs: [], objectiveMs: OBJECTIVE_MS };
    const cases: unknown[] = [
      '2026-11-23T00:00:00',
      '2026-11-23',
      '2026-02-31T00:00:00Z',
      '2026-11-23T24:00:00Z',
      '2026-11-23T00:00:00+24:00',
      '2026-11-23T00:00:00+05:99',
      '2026-13-01T00:00:00Z',
      'not-a-timestamp',
      42,
      null,
      undefined,
      true,
    ];
    for (const weekStartIso of cases) {
      const result = buildWeeklySloReport({ weekStartIso, admission: wrapper, parkNotify: wrapper }, isProxy);
      expect(result).toEqual({ ok: false, reason: 'invalid-week' });
    }
  });

  it('refuses hostile, malformed, or unexpected-root-key report inputs with invalid-week without invoking getters', () => {
    const getterLog: string[] = [];
    const missingWeekStart = { admission: { samplesMs: [], objectiveMs: OBJECTIVE_MS }, parkNotify: { samplesMs: [], objectiveMs: OBJECTIVE_MS } };
    const cases: unknown[] = [
      null,
      undefined,
      7,
      'x',
      true,
      [],
      [1, 2, 3],
      { length: 1, 0: 'x' },
      () => 1,
      new Date(),
      new Proxy({}, {}),
      revokedProxy(),
      getterOver(healthyInput(), getterLog, 'weekStartIso'),
      missingWeekStart,
      { ...healthyInput(), weekStartIso: undefined },
    ];
    for (const input of cases) {
      expect(buildWeeklySloReport(input, isProxy)).toEqual({ ok: false, reason: 'invalid-week' });
    }
    // Prototype-polluting own keys at the root, copied as data by the snapshot.
    const protoKey = JSON.parse(
      `{"__proto__":{},"weekStartIso":"${T0}","admission":{"samplesMs":[],"objectiveMs":45000},"parkNotify":{"samplesMs":[],"objectiveMs":45000}}`,
    );
    expect(buildWeeklySloReport(protoKey, isProxy)).toEqual({ ok: false, reason: 'invalid-week' });
    const constructorKey = JSON.parse(
      `{"constructor":1,"weekStartIso":"${T0}","admission":{"samplesMs":[],"objectiveMs":45000},"parkNotify":{"samplesMs":[],"objectiveMs":45000}}`,
    );
    expect(buildWeeklySloReport(constructorKey, isProxy)).toEqual({ ok: false, reason: 'invalid-week' });
    // A non-function detector is `detector-threw` at the root, mapped to invalid-week.
    expect(buildWeeklySloReport(healthyInput(), undefined as unknown as typeof isProxy)).toEqual({
      ok: false,
      reason: 'invalid-week',
    });
    expect(getterLog).toEqual([]);
  });
});

describe('renderSloReportText', () => {
  it('renders a healthy report as a deterministic block naming each SLO and its sample count', () => {
    const result = renderSloReportText(validRenderableReport(), isProxy);
    expect(result).toEqual({
      ok: true,
      text: [
        'week 2026-11-23T00:00:00.000Z to 2026-11-30T00:00:00.000Z',
        'breaches none',
        'slo admission count=2 invalid=0 p50Ms=10000 p95Ms=20000 met=true',
        'slo park-notify count=1 invalid=0 unnotified=0 p50Ms=30000 p95Ms=30000 met=true',
        '',
      ].join('\n'),
    });
  });

  it('starts every breached SLO line with the word BREACH and lists the breach names', () => {
    const report = {
      weekStartIso: T0,
      weekEndIso: T7,
      admission: { ok: true, count: 2, invalid: 1, p50Ms: 10_000, p95Ms: 50_000, met: false },
      parkNotify: { ok: true, count: 1, invalid: 0, unnotified: 1, p50Ms: 30_000, p95Ms: 30_000, met: false },
      breaches: ['admission', 'park-notify'],
    };
    const result = renderSloReportText(report, isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.text.split('\n');
      expect(lines[0]).toBe(`week ${T0} to ${T7}`);
      expect(lines[1]).toBe('breaches admission,park-notify');
      expect(lines[2].startsWith('BREACH ')).toBe(true);
      expect(lines[2]).toContain('slo admission');
      expect(lines[2]).toContain('count=2');
      expect(lines[3].startsWith('BREACH ')).toBe(true);
      expect(lines[3]).toContain('slo park-notify');
      expect(lines[3]).toContain('count=1');
    }
  });

  it('renders identical text across two calls and stays stable under input key order', () => {
    const report = validRenderableReport();
    const first = renderSloReportText(report, isProxy);
    const second = renderSloReportText(report, isProxy);
    expect(first).toEqual(second);
    const reordered = {
      breaches: report.breaches,
      parkNotify: report.parkNotify,
      admission: report.admission,
      weekEndIso: report.weekEndIso,
      weekStartIso: report.weekStartIso,
    };
    expect(renderSloReportText(reordered, isProxy)).toEqual(first);
  });

  it('refuses reports whose weekEndIso is not exactly seven days after weekStartIso with invalid-report', () => {
    const cases: string[] = [
      '2026-11-29T23:59:59.999Z',
      '2026-11-30T00:00:00.001Z',
      '2026-12-01T00:00:00.000Z',
      '2026-11-23T00:00:00.000Z',
      '2026-11-29T00:00:00Z',
    ];
    for (const weekEndIso of cases) {
      const report = { ...validRenderableReport(), weekEndIso };
      expect(renderSloReportText(report, isProxy)).toEqual({ ok: false, reason: 'invalid-report' });
    }
  });

  it('refuses reports whose summary fields or breaches contradict calculator outcomes with invalid-report', () => {
    const cases: Array<(report: Record<string, unknown>) => void> = [
      // invalid > 0 with met: true.
      (r) => {
        r.admission = { ok: true, count: 2, invalid: 1, p50Ms: 10_000, p95Ms: 20_000, met: true };
      },
      // unnotified > 0 with met: true.
      (r) => {
        r.parkNotify = { ok: true, count: 2, invalid: 0, unnotified: 1, p50Ms: 10_000, p95Ms: 20_000, met: true };
      },
      // count === 0 with a non-null percentile.
      (r) => {
        r.admission = { ok: true, count: 0, invalid: 0, p50Ms: 10_000, p95Ms: null, met: false };
      },
      // count === 0 with met: true.
      (r) => {
        r.parkNotify = { ok: true, count: 0, invalid: 0, unnotified: 0, p50Ms: null, p95Ms: null, met: true };
      },
      // count > 0 with a null percentile.
      (r) => {
        r.admission = { ok: true, count: 1, invalid: 0, p50Ms: null, p95Ms: 20_000, met: true };
      },
      // count > 0 with p50Ms > p95Ms.
      (r) => {
        r.parkNotify = { ok: true, count: 2, invalid: 0, unnotified: 0, p50Ms: 30_000, p95Ms: 20_000, met: true };
      },
      // breaches omits a breached SLO.
      (r) => {
        r.admission = { ok: true, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 50_000, met: false };
        r.breaches = [];
      },
      // breaches names a met SLO.
      (r) => {
        r.breaches = ['admission'];
      },
      // breaches in the wrong order when both are breached.
      (r) => {
        r.admission = { ok: true, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 50_000, met: false };
        r.parkNotify = { ok: true, count: 1, invalid: 0, unnotified: 1, p50Ms: 30_000, p95Ms: 30_000, met: false };
        r.breaches = ['park-notify', 'admission'];
      },
      // duplicate breach entries.
      (r) => {
        r.admission = { ok: true, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 50_000, met: false };
        r.breaches = ['admission', 'admission'];
      },
      // a breach name outside the two SLOs.
      (r) => {
        r.breaches = ['other'];
      },
      // an unmet summary with no observations is not a breach, but claims one.
      (r) => {
        r.admission = { ok: true, count: 0, invalid: 0, p50Ms: null, p95Ms: null, met: false };
        r.breaches = ['admission'];
      },
    ];
    for (const mutate of cases) {
      const report = validRenderableReport();
      mutate(report);
      expect(renderSloReportText(report, isProxy)).toEqual({ ok: false, reason: 'invalid-report' });
    }
  });

  it('refuses hostile, sparse, getter-bearing, Proxy, or malformed report inputs in renderSloReportText with invalid-report', () => {
    const getterLog: string[] = [];
    const holeBreaches: unknown[] = ['admission', 'park-notify'];
    delete holeBreaches[0];
    const getterBreaches = Object.defineProperty(['admission'], '0', {
      get() {
        getterLog.push('breaches[0]');
        return 'admission';
      },
      enumerable: true,
      configurable: true,
    });
    const cases: unknown[] = [
      null,
      undefined,
      7,
      'x',
      [],
      [1, 2],
      () => 1,
      new Proxy({}, {}),
      revokedProxy(),
      { length: 1, 0: 'x' },
      getterOver(validRenderableReport(), getterLog, 'weekStartIso'),
      { ...validRenderableReport(), breaches: holeBreaches },
      { ...validRenderableReport(), breaches: getterBreaches },
      { ...validRenderableReport(), breaches: new Array(1000) },
      { ...validRenderableReport(), breaches: 'admission' },
      { ...validRenderableReport(), extra: 1 },
      { ...validRenderableReport(), weekStartIso: '2026-11-23T00:00:00' },
      { ...validRenderableReport(), weekEndIso: '2026-02-31T00:00:00.000Z' },
      { ...validRenderableReport(), admission: { ok: true, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 20_000 } },
      { ...validRenderableReport(), admission: { ok: false, count: 2, invalid: 0, p50Ms: 10_000, p95Ms: 20_000, met: true } },
      { ...validRenderableReport(), parkNotify: { ok: true, count: 1, invalid: 0, unnotified: 0, p50Ms: 30_000, p95Ms: 30_000, met: 'true' } },
      { ...validRenderableReport(), admission: { ok: true, count: -1, invalid: 0, p50Ms: null, p95Ms: null, met: false } },
      { ...validRenderableReport(), parkNotify: { ok: true, count: 1, invalid: 0, unnotified: 0, p50Ms: 'x', p95Ms: 30_000, met: true } },
    ];
    for (const report of cases) {
      expect(renderSloReportText(report, isProxy)).toEqual({ ok: false, reason: 'invalid-report' });
    }
    // Prototype-polluting own keys at the root or inside a summary.
    const protoRoot = JSON.parse(
      `{"__proto__":{},"weekStartIso":"${T0}","weekEndIso":"${T7}","admission":{"ok":true,"count":0,"invalid":0,"p50Ms":null,"p95Ms":null,"met":false},"parkNotify":{"ok":true,"count":0,"invalid":0,"unnotified":0,"p50Ms":null,"p95Ms":null,"met":false},"breaches":[]}`,
    );
    expect(renderSloReportText(protoRoot, isProxy)).toEqual({ ok: false, reason: 'invalid-report' });
    const constructorSummary = JSON.parse(
      `{"weekStartIso":"${T0}","weekEndIso":"${T7}","admission":{"constructor":1,"ok":true,"count":0,"invalid":0,"p50Ms":null,"p95Ms":null,"met":false},"parkNotify":{"ok":true,"count":0,"invalid":0,"unnotified":0,"p50Ms":null,"p95Ms":null,"met":false},"breaches":[]}`,
    );
    expect(renderSloReportText(constructorSummary, isProxy)).toEqual({ ok: false, reason: 'invalid-report' });
    // A non-function detector is `detector-threw` at the root, mapped to invalid-report.
    expect(renderSloReportText(validRenderableReport(), undefined as unknown as typeof isProxy)).toEqual({
      ok: false,
      reason: 'invalid-report',
    });
    expect(getterLog).toEqual([]);
  });

  it('renders a round-tripped built report to the same text as its hand-written equivalent', () => {
    const breached = buildWeeklySloReport(
      {
        weekStartIso: T0,
        admission: { samplesMs: [admissionSample(t(0), t(50))], objectiveMs: OBJECTIVE_MS },
        parkNotify: { samplesMs: [parkSample(t(0), null)], objectiveMs: OBJECTIVE_MS },
      },
      isProxy,
    );
    expect(breached.ok).toBe(true);
    if (breached.ok) {
      const rendered = renderSloReportText(breached.report, isProxy);
      expect(rendered).toEqual({
        ok: true,
        text: [
          `week ${T0} to ${T7}`,
          'breaches admission,park-notify',
          'BREACH slo admission count=1 invalid=0 p50Ms=50000 p95Ms=50000 met=false',
          'BREACH slo park-notify count=0 invalid=0 unnotified=1 p50Ms=null p95Ms=null met=false',
          '',
        ].join('\n'),
      });
    }
  });
});
