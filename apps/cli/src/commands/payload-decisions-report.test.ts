// VC09 — unit tests for the ranking-trial report formatters.
/**
 * Pure synchronous in-memory coverage of `latencyText` and
 * `decisionsReportLine`, with hand-built `RankingTrialContextFigures`
 * fixtures. No composition root, no runtime, no filesystem, subprocess or
 * network I/O, and no production changes.
 */

import { describe, expect, it } from 'vitest';

import { FIGURE_NOT_PERSISTED, type RankingTrialContextFigures } from '@fleet/brief-knowledge';

import { decisionsReportLine, latencyText } from './payload.js';

const makeFigure = (overrides?: Partial<RankingTrialContextFigures>): RankingTrialContextFigures => ({
  contextRef: 'context-0001',
  calls: 3,
  orderChanged: true,
  top1Changed: false,
  kendallTau: 0.75,
  unknownRateByReason: { timeout: 0.25 },
  lowestConfidence: 0.8,
  latencyP50Ms: 40,
  latencyP95Ms: 120,
  costUsd: 0.012,
  estimatedCalls: 1,
  selectionRecorded: true,
  selectionKendallTauDecided: 0.5,
  selectionKendallTauLexical: 0.4,
  selectionAgreesWithDecided: true,
  selectionAgreesWithLexical: false,
  ...overrides,
});

describe('latencyText', () => {
  it('formats numeric milliseconds and preserves zero', () => {
    expect(latencyText(250)).toBe('250ms');
    expect(latencyText(0)).toBe('0ms');
  });

  it('returns not-persisted sentinel unchanged', () => {
    expect(latencyText(FIGURE_NOT_PERSISTED)).toBe(FIGURE_NOT_PERSISTED);
    expect(latencyText(FIGURE_NOT_PERSISTED)).toBe('n/a (not persisted)');
  });
});

describe('decisionsReportLine', () => {
  it('formats all fields space-separated in exact order', () => {
    const line = decisionsReportLine(
      makeFigure({
        contextRef: 'ctx-full',
        orderChanged: true,
        top1Changed: false,
        kendallTau: 0.75,
        unknownRateByReason: { timeout: 0.25 },
        lowestConfidence: 0.8,
        latencyP50Ms: 40,
        latencyP95Ms: 120,
        costUsd: 0.012,
        estimatedCalls: 1,
        selectionRecorded: true,
        selectionAgreesWithDecided: true,
        selectionAgreesWithLexical: false,
      }),
    );
    expect(line).toBe(
      'ctx-full calls=3 orderChanged=yes top1Changed=no kendallTau=0.75 ' +
        'unknown=timeout:0.25 lowestConfidence=0.8 latencyP50=40ms latencyP95=120ms ' +
        'costUsd=0.012 estimatedCalls=1 selectionRecorded=yes agreesDecided=yes agreesLexical=no',
    );
  });

  it('renders n/a for null tau, confidence, and agreement fields', () => {
    const line = decisionsReportLine(
      makeFigure({
        kendallTau: null,
        lowestConfidence: null,
        selectionAgreesWithDecided: null,
        selectionAgreesWithLexical: null,
      }),
    );
    expect(line).toContain('kendallTau=n/a');
    expect(line).toContain('lowestConfidence=n/a');
    expect(line).toContain('agreesDecided=n/a');
    expect(line).toContain('agreesLexical=n/a');
    // Null must never coerce to 0 or false.
    expect(line).not.toContain('kendallTau=0');
    expect(line).not.toContain('lowestConfidence=0');
    expect(line).not.toContain('agreesDecided=no');
    expect(line).not.toContain('agreesLexical=no');
  });

  it('renders yes, no, and tie for agreement fields', () => {
    expect(decisionsReportLine(makeFigure({ selectionAgreesWithDecided: true }))).toContain('agreesDecided=yes');
    expect(decisionsReportLine(makeFigure({ selectionAgreesWithDecided: false }))).toContain('agreesDecided=no');
    expect(decisionsReportLine(makeFigure({ selectionAgreesWithDecided: 'tie' }))).toContain('agreesDecided=tie');
    expect(decisionsReportLine(makeFigure({ selectionAgreesWithLexical: true }))).toContain('agreesLexical=yes');
    expect(decisionsReportLine(makeFigure({ selectionAgreesWithLexical: false }))).toContain('agreesLexical=no');
  });

  it('renders unknown=none when unknownRateByReason is empty', () => {
    expect(decisionsReportLine(makeFigure({ unknownRateByReason: {} }))).toContain('unknown=none');
  });

  it('joins multiple unknownRateByReason entries in key order with no space', () => {
    expect(decisionsReportLine(makeFigure({ unknownRateByReason: { alpha: 0.2, beta: 0.5 } }))).toContain(
      'unknown=alpha:0.2,beta:0.5',
    );
  });

  it('renders not-persisted sentinel in latency fields', () => {
    const line = decisionsReportLine(makeFigure({ latencyP50Ms: FIGURE_NOT_PERSISTED, latencyP95Ms: 120 }));
    expect(line).toContain('latencyP50=n/a (not persisted) latencyP95=120ms');
  });
});

describe('hostile inputs', () => {
  it('decisionsReportLine ignores prototype-polluting keys on unknownRateByReason', () => {
    // JSON.parse defines `__proto__` as an own data property, so the parsed
    // input itself is passed to the formatter unchanged — no Object.assign,
    // which would route `leaked` onto the prototype instead of its own keys.
    const parsed = JSON.parse('{"__proto__":{"leaked":1}}') as unknown as Record<string, number>;
    expect(Object.keys(parsed)).toEqual(['__proto__']);
    expect(Object.entries(parsed).length).toBe(1);
    // This formatter enumerates own keys, so it reports the entry as
    // `unknown=__proto__:[object Object]`; the nested `leaked` value never
    // reaches the prototype and its label never appears in the line.
    const line = decisionsReportLine(makeFigure({ unknownRateByReason: parsed }));
    expect(line).toContain('unknown=__proto__:[object Object]');
    expect(line).not.toContain('leaked');
  });

  it('decisionsReportLine propagates throwing getter on accessed field and skips unused getters', () => {
    let unusedReads = 0;
    const figure = makeFigure();
    const hostile = {
      ...figure,
      // An unused field must never be read by the formatter.
      get selectionKendallTauDecided(): number | null {
        unusedReads += 1;
        return 0.5;
      },
      // An accessed field must propagate its getter's error synchronously.
      get kendallTau(): number | null {
        throw new Error('getter exploded');
      },
    } as unknown as RankingTrialContextFigures;
    expect(() => decisionsReportLine(hostile)).toThrow('getter exploded');
    expect(unusedReads).toBe(0);
  });

  it('decisionsReportLine propagates throwing Proxy get trap synchronously', () => {
    const bomb = new Proxy({} as unknown as RankingTrialContextFigures, {
      get() {
        throw new Error('proxy trap exploded');
      },
    });
    expect(() => decisionsReportLine(bomb)).toThrow('proxy trap exploded');
  });

  it('decisionsReportLine formats an empty object with enormous length in O(1)', () => {
    const arrayLike = { length: 1e9 } as unknown as Record<string, number>;
    const start = Date.now();
    const line = decisionsReportLine(makeFigure({ unknownRateByReason: arrayLike }));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(line).toContain('unknown=length:1000000000');
    expect(line).not.toContain('unknown=none');
  });
});
