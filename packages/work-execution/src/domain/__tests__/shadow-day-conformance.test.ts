import { describe, expect, it } from 'vitest';

import { buildLaneRunStepKey, head12Of, laneRunPremergeKey } from '../lane-run-keys.js';
import {
  SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
  SHADOW_CONFORMANCE_MAX_HOPS,
  SHADOW_CONFORMANCE_MAX_RUNS,
  SHADOW_CONFORMANCE_MAX_SHELL_FACTS,
  SHADOW_CONFORMANCE_MIN_RUNS,
  SHADOW_CONFORMANCE_MIN_TIER1,
  SHADOW_CONFORMANCE_MIN_TIER2,
  SHADOW_NONCONFORMANCE_CODES,
  evaluateShadowConductedConformance,
} from '../shadow-day-conformance.js';
import type { ShadowNonconformanceCode } from '../shadow-day-conformance.js';

const DAY = '2026-11-16';
const DAY_MINUS_1 = '2026-11-15';
const DAY_MINUS_2 = '2026-11-14';
const DAY_MINUS_3 = '2026-11-13';

type Tier = 1 | 2;
type ReceiptKind = 'brief-check' | 'code-review' | 'pre-merge';
type ReceiptResult = 'pending' | 'pass' | 'fail' | 'unknown' | 'not-applicable';

interface Receipt {
  readonly kind: ReceiptKind;
  readonly result: ReceiptResult;
}

interface JournalEntry {
  readonly kind: 'intent' | 'result' | 'conduct';
  readonly key: string | null;
  readonly recordedAtIso: string;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
  readonly state: string | null;
}

interface RunRecord {
  readonly runId: string;
  readonly tier: Tier;
  readonly pullRequest: number;
  readonly headOid: string;
  readonly reviewReceipts: readonly Receipt[];
  readonly journal: readonly JournalEntry[];
}

interface MergeRecord {
  readonly pullRequest: number;
  readonly headOid: string;
  readonly atIso: string;
}

interface Fixture {
  readonly run: RunRecord;
  readonly merge: MergeRecord | null;
}

function iso(day: string, hour: number, minute = 0, second = 0): string {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return `${day}T${hh}:${mm}:${ss}.000Z`;
}

function shifted(isoTime: string, milliseconds: number): string {
  return new Date(Date.parse(isoTime) + milliseconds).toISOString();
}

function runIdFor(n: number): string {
  return `run-0${String(n).padStart(25, '0')}`;
}

function headFor(n: number): string {
  return `${n.toString(16).padStart(12, 'b')}${'c'.repeat(28)}`;
}

function pullFor(n: number): number {
  return 4000 + n;
}

function head12(headOid: string): string {
  const head = head12Of(headOid);
  if (head === null) throw new Error('fixture head refused');
  return head;
}

/** Gate step keys come from the builder, never a hand-written key string. */
function gateKey(runId: string, headOid: string): string {
  const built = buildLaneRunStepKey({
    runId,
    round: 0,
    step: 'gate',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: head12(headOid),
    retry: null,
  });
  if (!built.ok) throw new Error('fixture gate key refused');
  return built.key;
}

/** Premerge keys come from the builder, never a hand-written key string. */
function postedKey(runId: string, headOid: string): string {
  const built = laneRunPremergeKey(runId, 0, head12(headOid));
  if (!built.ok) throw new Error('fixture premerge key refused');
  return built.key;
}

function receipt(kind: ReceiptKind, result: ReceiptResult): Receipt {
  return { kind, result };
}

function resultEntry(key: string, reasonCode: string, recordedAtIso: string, outcome = 'completed'): JournalEntry {
  return { kind: 'result', key, recordedAtIso, outcome, reasonCode, state: null };
}

function receiptsFor(tier: Tier): Receipt[] {
  const receipts = [receipt('brief-check', 'pass'), receipt('code-review', 'pass')];
  if (tier === 2) receipts.push(receipt('pre-merge', 'pass'));
  return receipts;
}

/** A run that passes rules 2-5. Tier 1 carries no pre-merge receipt and no one-way intent. */
function conforming(n: number, tier: Tier, mergeAt: string): Fixture {
  const runId = runIdFor(n);
  const headOid = headFor(n);
  const recordedAtIso = shifted(mergeAt, -60 * 60 * 1000);
  return {
    run: {
      runId,
      tier,
      pullRequest: pullFor(n),
      headOid,
      reviewReceipts: receiptsFor(tier),
      journal: [
        resultEntry(gateKey(runId, headOid), 'gate-passed', recordedAtIso),
        resultEntry(postedKey(runId, headOid), 'premerge-success', recordedAtIso),
      ],
    },
    merge: { pullRequest: pullFor(n), headOid, atIso: mergeAt },
  };
}

function withJournal(fixture: Fixture, journal: readonly JournalEntry[]): Fixture {
  return { run: { ...fixture.run, journal }, merge: fixture.merge };
}

function withReceipts(fixture: Fixture, reviewReceipts: readonly Receipt[]): Fixture {
  return { run: { ...fixture.run, reviewReceipts }, merge: fixture.merge };
}

function withoutGate(fixture: Fixture): Fixture {
  const recordedAtIso = shifted(fixture.merge?.atIso ?? iso(DAY, 12), -60 * 60 * 1000);
  return withJournal(fixture, [resultEntry(postedKey(fixture.run.runId, fixture.run.headOid), 'premerge-success', recordedAtIso)]);
}

function gateFailedOnly(fixture: Fixture): Fixture {
  const recordedAtIso = shifted(fixture.merge?.atIso ?? iso(DAY, 12), -60 * 60 * 1000);
  return withJournal(fixture, [
    resultEntry(gateKey(fixture.run.runId, fixture.run.headOid), 'gate-failed', recordedAtIso),
    resultEntry(postedKey(fixture.run.runId, fixture.run.headOid), 'premerge-success', recordedAtIso),
  ]);
}

function gateAt(fixture: Fixture, headOid: string): Fixture {
  const recordedAtIso = shifted(fixture.merge?.atIso ?? iso(DAY, 12), -60 * 60 * 1000);
  return withJournal(fixture, [
    resultEntry(gateKey(fixture.run.runId, headOid), 'gate-passed', recordedAtIso),
    resultEntry(postedKey(fixture.run.runId, fixture.run.headOid), 'premerge-success', recordedAtIso),
  ]);
}

function noCodeReview(fixture: Fixture): Fixture {
  return withReceipts(fixture, fixture.run.reviewReceipts.filter((item) => item.kind !== 'code-review'));
}

function failedCodeReview(fixture: Fixture): Fixture {
  return withReceipts(
    fixture,
    fixture.run.reviewReceipts.map((item) => (item.kind === 'code-review' ? receipt('code-review', 'fail') : item)),
  );
}

function noPreMergeReceipt(fixture: Fixture): Fixture {
  return withReceipts(fixture, fixture.run.reviewReceipts.filter((item) => item.kind !== 'pre-merge'));
}

function premergeAt(fixture: Fixture, recordedAtIso: string, reasonCode = 'premerge-success', headOid = fixture.run.headOid): Fixture {
  const gateAtIso = shifted(fixture.merge?.atIso ?? iso(DAY, 12), -60 * 60 * 1000);
  return withJournal(fixture, [
    resultEntry(gateKey(fixture.run.runId, fixture.run.headOid), 'gate-passed', gateAtIso),
    resultEntry(postedKey(fixture.run.runId, headOid), reasonCode, recordedAtIso),
  ]);
}

function passing(): Fixture[] {
  return [
    conforming(1, 1, iso(DAY_MINUS_2, 12)),
    conforming(2, 1, iso(DAY_MINUS_1, 12)),
    conforming(3, 1, iso(DAY, 10)),
    conforming(4, 2, iso(DAY, 12)),
    conforming(5, 2, iso(DAY, 14)),
  ];
}

function inputFrom(fixtures: readonly Fixture[], extras?: {
  readonly day?: string;
  readonly extraMerges?: readonly MergeRecord[];
  readonly headMoves?: readonly Record<string, unknown>[];
  readonly headMovesIncompleteFor?: readonly number[];
}): Record<string, unknown> {
  const merges: MergeRecord[] = [];
  for (const fixture of fixtures) {
    if (fixture.merge !== null) merges.push(fixture.merge);
  }
  return {
    day: extras?.day ?? DAY,
    runs: fixtures.map((fixture) => fixture.run),
    merges: [...merges, ...(extras?.extraMerges ?? [])],
    headMoves: extras?.headMoves ?? [],
    headMovesIncompleteFor: extras?.headMovesIncompleteFor ?? [],
  };
}

function onTop(broken: Fixture): Record<string, unknown> {
  return inputFrom([...passing(), broken]);
}

function dayBroken(tier: Tier, make: (fixture: Fixture) => Fixture): Fixture {
  return make(conforming(6, tier, iso(DAY, 16)));
}

interface ScoreCounts {
  readonly mergedRuns?: number;
  readonly conforming?: number;
  readonly conformingTier1?: number;
  readonly conformingTier2?: number;
  readonly nonconformingOnDay?: number;
}

function zeroCodes(overrides: Partial<Record<ShadowNonconformanceCode, number>> = {}): Record<ShadowNonconformanceCode, number> {
  const byCode = {} as Record<ShadowNonconformanceCode, number>;
  for (const code of SHADOW_NONCONFORMANCE_CODES) byCode[code] = overrides[code] ?? 0;
  return byCode;
}

function scored(
  status: 'unknown' | 'fail',
  reason: string,
  counts: ScoreCounts = {},
  codes: Partial<Record<ShadowNonconformanceCode, number>> = {},
) {
  return {
    status,
    reason,
    mergedRuns: counts.mergedRuns ?? 0,
    conforming: counts.conforming ?? 0,
    conformingTier1: counts.conformingTier1 ?? 0,
    conformingTier2: counts.conformingTier2 ?? 0,
    nonconformingOnDay: counts.nonconformingOnDay ?? 0,
    byCode: zeroCodes(codes),
  };
}

function refused() {
  return scored('unknown', 'invalid-input');
}

const PASSING_COUNTS: ScoreCounts = { mergedRuns: 5, conforming: 5, conformingTier1: 3, conformingTier2: 2 };

function evaluate(input: unknown) {
  return evaluateShadowConductedConformance(input);
}

describe('S6\' conformance evaluator (SH12a)', () => {
  it('exports the floor minimums, the six codes and the input caps', () => {
    expect(SHADOW_CONFORMANCE_MIN_RUNS).toBe(5);
    expect(SHADOW_CONFORMANCE_MIN_TIER1).toBe(3);
    expect(SHADOW_CONFORMANCE_MIN_TIER2).toBe(2);
    expect(SHADOW_CONFORMANCE_MAX_RUNS).toBe(2_000);
    expect(SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN).toBe(10_000);
    expect(SHADOW_CONFORMANCE_MAX_SHELL_FACTS).toBe(200_000);
    expect(SHADOW_CONFORMANCE_MAX_HOPS).toBe(32);
    expect([...SHADOW_NONCONFORMANCE_CODES]).toEqual([
      'merged-head-unlinked',
      'gate-not-passed',
      'code-review-missing',
      'pre-merge-missing',
      'premerge-not-posted-before-merge',
      'stray-one-way-action',
    ]);
  });

  it('3 Tier 1 and 2 Tier 2 conforming runs merged across D-2..D yield unknown/rules-incomplete', () => {
    const fixtures = passing();
    for (const fixture of fixtures) {
      if (fixture.run.tier !== 1) continue;
      expect(fixture.run.reviewReceipts.some((item) => item.kind === 'pre-merge')).toBe(false);
    }
    expect(evaluate(inputFrom(fixtures))).toEqual(scored('unknown', 'rules-incomplete', PASSING_COUNTS));
  });

  it('4 conforming runs yield fail/too-few-conforming-runs', () => {
    expect(evaluate(inputFrom(passing().slice(0, 4)))).toEqual(
      scored('fail', 'too-few-conforming-runs', { mergedRuns: 4, conforming: 4, conformingTier1: 3, conformingTier2: 1 }),
    );
  });

  it('5 runs all Tier 1 yield fail/too-few-conforming-runs', () => {
    const fixtures = [1, 2, 3, 4, 5].map((n, index) => conforming(n, 1, iso(index < 2 ? DAY_MINUS_2 : DAY, 8 + index)));
    expect(evaluate(inputFrom(fixtures))).toEqual(
      scored('fail', 'too-few-conforming-runs', { mergedRuns: 5, conforming: 5, conformingTier1: 5, conformingTier2: 0 }),
    );
  });

  it('5 conforming runs with only 2 Tier 1 yield fail/too-few-conforming-runs', () => {
    const fixtures = [
      conforming(1, 1, iso(DAY_MINUS_2, 12)),
      conforming(2, 1, iso(DAY_MINUS_1, 12)),
      conforming(3, 2, iso(DAY, 8)),
      conforming(4, 2, iso(DAY, 10)),
      conforming(5, 2, iso(DAY, 12)),
    ];
    expect(evaluate(inputFrom(fixtures))).toEqual(
      scored('fail', 'too-few-conforming-runs', { mergedRuns: 5, conforming: 5, conformingTier1: 2, conformingTier2: 3 }),
    );
  });

  it('no gate result on a run merged on D yields fail/gate-not-passed', () => {
    expect(evaluate(onTop(dayBroken(1, withoutGate)))).toEqual(
      scored('fail', 'gate-not-passed', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'gate-not-passed': 1 }),
    );
  });

  it('a gate-failed gate result only yields fail/gate-not-passed', () => {
    expect(evaluate(onTop(dayBroken(1, gateFailedOnly)))).toEqual(
      scored('fail', 'gate-not-passed', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'gate-not-passed': 1 }),
    );
  });

  it('a gate passed at a different head12 yields fail/gate-not-passed', () => {
    const broken = gateAt(conforming(6, 1, iso(DAY, 16)), headFor(90));
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'gate-not-passed', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'gate-not-passed': 1 }),
    );
  });

  it('a gate-failed result does not hide a gate-passed result at the same head', () => {
    const base = conforming(6, 1, iso(DAY, 16));
    const recordedAtIso = shifted(iso(DAY, 16), -60 * 60 * 1000);
    const both = withJournal(base, [
      resultEntry(gateKey(base.run.runId, base.run.headOid), 'gate-failed', recordedAtIso),
      ...base.run.journal,
    ]);
    expect(evaluate(onTop(both))).toEqual(
      scored('unknown', 'rules-incomplete', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
    );
  });

  it('no code-review receipt yields fail/code-review-missing', () => {
    const broken = dayBroken(2, noCodeReview);
    expect(broken.run.reviewReceipts.some((item) => item.kind === 'brief-check' && item.result === 'pass')).toBe(true);
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'code-review-missing', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'code-review-missing': 1 }),
    );
  });

  it('a code-review receipt fail yields fail/code-review-missing', () => {
    expect(evaluate(onTop(dayBroken(2, failedCodeReview)))).toEqual(
      scored('fail', 'code-review-missing', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'code-review-missing': 1 }),
    );
  });

  it('a Tier 2 run without a pre-merge receipt yields fail/pre-merge-missing', () => {
    expect(evaluate(onTop(dayBroken(2, noPreMergeReceipt)))).toEqual(
      scored('fail', 'pre-merge-missing', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'pre-merge-missing': 1 }),
    );
  });

  it('a Tier 1 run without a pre-merge receipt still counts as conforming', () => {
    const added = conforming(6, 1, iso(DAY, 16));
    expect(added.run.reviewReceipts.some((item) => item.kind === 'pre-merge')).toBe(false);
    expect(evaluate(onTop(added))).toEqual(
      scored('unknown', 'rules-incomplete', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
    );
  });

  it('a premerge success recorded after the merge time yields fail/premerge-not-posted-before-merge', () => {
    const base = conforming(6, 1, iso(DAY, 16));
    const broken = premergeAt(base, shifted(base.merge?.atIso ?? iso(DAY, 16), 1000));
    expect(evaluate(onTop(broken))).toEqual(
      scored(
        'fail',
        'premerge-not-posted-before-merge',
        { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 },
        { 'premerge-not-posted-before-merge': 1 },
      ),
    );
  });

  it('a premerge success recorded at the merge instant yields fail/premerge-not-posted-before-merge', () => {
    const base = conforming(6, 1, iso(DAY, 16));
    const broken = premergeAt(base, base.merge?.atIso ?? iso(DAY, 16));
    expect(evaluate(onTop(broken)).reason).toBe('premerge-not-posted-before-merge');
  });

  it('a premerge premerge-failure yields fail/premerge-not-posted-before-merge', () => {
    const base = conforming(6, 1, iso(DAY, 16));
    const broken = premergeAt(base, shifted(iso(DAY, 16), -60 * 60 * 1000), 'premerge-failure');
    expect(evaluate(onTop(broken)).reason).toBe('premerge-not-posted-before-merge');
  });

  it('a premerge success at a different head12 yields fail/premerge-not-posted-before-merge', () => {
    const base = conforming(6, 1, iso(DAY, 16));
    const broken = premergeAt(base, shifted(iso(DAY, 16), -60 * 60 * 1000), 'premerge-success', headFor(90));
    expect(evaluate(onTop(broken)).reason).toBe('premerge-not-posted-before-merge');
  });

  it('a premerge whose clock is later but whose instant is before the merge conforms', () => {
    const base = conforming(6, 1, iso(DAY, 12));
    const broken = premergeAt(base, '2026-11-16T13:00:00.000+02:00');
    expect(evaluate(onTop(broken))).toEqual(
      scored('unknown', 'rules-incomplete', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
    );
  });

  it('a run that breaks two rules takes the earlier code only', () => {
    const broken = noPreMergeReceipt(withoutGate(conforming(6, 2, iso(DAY, 16))));
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'gate-not-passed', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'gate-not-passed': 1 }),
    );
  });

  it('two failures on D with different codes yield the code earlier in the fixed order', () => {
    const reviewFirst = noCodeReview(conforming(6, 2, iso(DAY, 16)));
    const gateSecond = withoutGate(conforming(7, 1, iso(DAY, 18)));
    expect(evaluate(inputFrom([...passing(), reviewFirst, gateSecond]))).toEqual(
      scored(
        'fail',
        'gate-not-passed',
        { ...PASSING_COUNTS, mergedRuns: 7, nonconformingOnDay: 2 },
        { 'gate-not-passed': 1, 'code-review-missing': 1 },
      ),
    );
  });

  it('a nonconforming run on D fails with its code before the floor is considered', () => {
    expect(evaluate(inputFrom([withoutGate(conforming(1, 1, iso(DAY, 12)))]))).toEqual(
      scored('fail', 'gate-not-passed', { mergedRuns: 1, nonconformingOnDay: 1 }, { 'gate-not-passed': 1 }),
    );
  });

  it('the same rule broken on a run merged on D-1 is not a failure of D and that run is excluded from the counts', () => {
    const broken = withoutGate(conforming(6, 1, iso(DAY_MINUS_1, 18)));
    expect(evaluate(onTop(broken))).toEqual(
      scored(
        'unknown',
        'rules-incomplete',
        { mergedRuns: 6, conforming: 5, conformingTier1: 3, conformingTier2: 2 },
        { 'gate-not-passed': 1 },
      ),
    );
  });

  it('a pull request merged twice in W yields unknown/merge-ambiguous', () => {
    const run = conforming(1, 1, iso(DAY, 12));
    const second = { pullRequest: run.run.pullRequest, headOid: run.run.headOid, atIso: iso(DAY, 18) };
    expect(evaluate(inputFrom([run], { extraMerges: [second] }))).toEqual(scored('unknown', 'merge-ambiguous'));
  });

  it('a second merge of the same pull request outside W does not make the run merge-ambiguous', () => {
    const fixtures = passing();
    const outside = {
      pullRequest: fixtures[0]?.run.pullRequest ?? 0,
      headOid: fixtures[0]?.run.headOid ?? headFor(1),
      atIso: iso(DAY_MINUS_3, 23, 59, 59),
    };
    expect(evaluate(inputFrom(fixtures, { extraMerges: [outside] }))).toEqual(
      scored('unknown', 'rules-incomplete', PASSING_COUNTS),
    );
  });

  it('two runs on one merged pull request yield unknown/pull-request-has-several-runs', () => {
    const first = conforming(1, 1, iso(DAY, 12));
    const second = conforming(2, 2, iso(DAY, 14));
    const shared: Fixture = { run: { ...second.run, pullRequest: first.run.pullRequest }, merge: null };
    expect(evaluate(inputFrom([first, shared]))).toEqual(scored('unknown', 'pull-request-has-several-runs'));
  });

  it('a run whose pull request did not merge in W is ignored', () => {
    const unmerged: Fixture = { ...conforming(6, 2, iso(DAY, 16)), merge: null };
    expect(evaluate(inputFrom([...passing(), unmerged]))).toEqual(scored('unknown', 'rules-incomplete', PASSING_COUNTS));
  });

  it('a merge at 23:59:59Z on D-3 is outside W', () => {
    const outside = conforming(6, 2, iso(DAY_MINUS_3, 23, 59, 59));
    expect(evaluate(inputFrom([...passing(), outside]))).toEqual(scored('unknown', 'rules-incomplete', PASSING_COUNTS));
  });

  it('a merge at 00:00:00Z on D-2 is inside W', () => {
    const early = conforming(6, 1, iso(DAY_MINUS_2, 0, 0, 0));
    expect(evaluate(onTop(early))).toEqual(
      scored('unknown', 'rules-incomplete', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
    );
  });

  it('a merge at 00:00:00Z on D+1 is outside W', () => {
    const late = conforming(6, 1, '2026-11-17T00:00:00.000Z');
    expect(evaluate(onTop(late))).toEqual(scored('unknown', 'rules-incomplete', PASSING_COUNTS));
  });

  it('counts a merge on D-2 when that day falls in the previous month', () => {
    const fixtures = [
      conforming(1, 1, '2026-02-27T12:00:00.000Z'),
      conforming(2, 1, '2026-02-28T12:00:00.000Z'),
      conforming(3, 1, '2026-03-01T08:00:00.000Z'),
      conforming(4, 2, '2026-03-01T10:00:00.000Z'),
      conforming(5, 2, '2026-03-01T12:00:00.000Z'),
      conforming(6, 1, '2026-02-26T23:59:59.000Z'),
    ];
    expect(evaluate(inputFrom(fixtures, { day: '2026-03-01' }))).toEqual(
      scored('unknown', 'rules-incomplete', PASSING_COUNTS),
    );
  });

  it('places a merge by its UTC instant when the offset shifts the calendar day', () => {
    const shiftedDay = conforming(6, 1, '2026-11-17T01:30:00.000+02:00');
    expect(evaluate(onTop(shiftedDay))).toEqual(
      scored('unknown', 'rules-incomplete', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
    );
  });
});

describe('validation', () => {
  function shell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { day: DAY, runs: [], merges: [], headMoves: [], headMovesIncompleteFor: [], ...overrides };
  }

  function validRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...conforming(1, 1, iso(DAY, 12)).run, ...overrides };
  }

  it('refuses a day that is not YYYY-MM-DD', () => {
    expect(evaluate(shell({ day: '16 November 2026' }))).toEqual(refused());
  });

  it('refuses a day whose year is outside 2000-9999', () => {
    expect(evaluate(shell({ day: '1999-12-31' }))).toEqual(refused());
  });

  it('refuses a day that is not a real calendar date', () => {
    expect(evaluate(shell({ day: '2026-02-31' }))).toEqual(refused());
    expect(evaluate(shell({ day: '2026-11-31' }))).toEqual(refused());
  });

  it('refuses a runId that does not match LANE_RUN_ID_PATTERN', () => {
    expect(evaluate(shell({ runs: [validRun({ runId: 'run-not-a-ulid' })] }))).toEqual(refused());
  });

  it('refuses a tier other than 1 or 2', () => {
    expect(evaluate(shell({ runs: [validRun({ tier: 0 })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [validRun({ tier: '2' })] }))).toEqual(refused());
  });

  it('refuses a pullRequest that is not a safe integer of at least 1', () => {
    expect(evaluate(shell({ runs: [validRun({ pullRequest: 0 })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [validRun({ pullRequest: -1 })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [validRun({ pullRequest: 1.5 })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [validRun({ pullRequest: Number.MAX_SAFE_INTEGER + 1 })] }))).toEqual(refused());
  });

  it('refuses a merge pullRequest that is not a safe integer of at least 1', () => {
    const merge = { pullRequest: 0, headOid: headFor(1), atIso: iso(DAY, 12) };
    expect(evaluate(shell({ merges: [merge] }))).toEqual(refused());
  });

  it('refuses a head oid that is not 40 lowercase hex', () => {
    expect(evaluate(shell({ runs: [validRun({ headOid: headFor(1).toUpperCase() })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [validRun({ headOid: 'a'.repeat(64) })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [validRun({ headOid: 'abc' })] }))).toEqual(refused());
  });

  it('refuses a merge headOid that is not 40 lowercase hex', () => {
    const merge = { pullRequest: pullFor(1), headOid: 'ab', atIso: iso(DAY, 12) };
    expect(evaluate(shell({ merges: [merge] }))).toEqual(refused());
  });

  it('refuses a head move fromHeadOid that is not 40 lowercase hex', () => {
    const move = { pullRequest: pullFor(1), fromHeadOid: 'zz', toHeadOid: headFor(2), atIso: iso(DAY, 9) };
    expect(evaluate(shell({ headMoves: [move] }))).toEqual(refused());
  });

  it('refuses a head move toHeadOid that is not 40 lowercase hex', () => {
    const move = { pullRequest: pullFor(1), fromHeadOid: headFor(1), toHeadOid: headFor(2).slice(0, 39), atIso: iso(DAY, 9) };
    expect(evaluate(shell({ headMoves: [move] }))).toEqual(refused());
  });

  it('refuses a merge atIso that is not a zoned ISO time', () => {
    const merge = { pullRequest: pullFor(1), headOid: headFor(1), atIso: '2026-11-16T12:00:00' };
    expect(evaluate(shell({ merges: [merge] }))).toEqual(refused());
  });

  it('refuses a head-move atIso that is not a zoned ISO time', () => {
    const move = { pullRequest: pullFor(1), fromHeadOid: headFor(1), toHeadOid: headFor(2), atIso: 'not-a-time' };
    expect(evaluate(shell({ headMoves: [move] }))).toEqual(refused());
  });

  it('refuses a journal recordedAtIso that is not a zoned ISO time', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], recordedAtIso: '2026-02-31T00:00:00.000Z' };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [entry] }] }))).toEqual(refused());
  });

  it('refuses a journal kind outside intent, result and conduct', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], kind: 'note' };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [entry] }] }))).toEqual(refused());
  });

  it('refuses a journal key that is not null or a string of at most 256', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const numbered = { ...base.run.journal[0], key: 12 };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [numbered] }] }))).toEqual(refused());
    const overlong = { ...base.run.journal[0], key: 'k'.repeat(257) };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [overlong] }] }))).toEqual(refused());
  });

  it('accepts a journal key of 256 characters', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const recordedAtIso = shifted(iso(DAY, 12), -60 * 60 * 1000);
    const within = withJournal(base, [
      resultEntry('k'.repeat(256), 'gate-passed', recordedAtIso),
      resultEntry(postedKey(base.run.runId, base.run.headOid), 'premerge-success', recordedAtIso),
    ]);
    expect(evaluate(inputFrom([within])).reason).toBe('gate-not-passed');
  });

  it('refuses a journal outcome that is not null or a string of at most 64', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const numbered = { ...base.run.journal[0], outcome: 1 };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [numbered] }] }))).toEqual(refused());
    const overlong = { ...base.run.journal[0], outcome: 'o'.repeat(65) };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [overlong] }] }))).toEqual(refused());
  });

  it('accepts a journal outcome of 64 characters', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const recordedAtIso = shifted(iso(DAY, 12), -60 * 60 * 1000);
    const within = withJournal(base, [
      resultEntry(gateKey(base.run.runId, base.run.headOid), 'gate-passed', recordedAtIso, 'x'.repeat(64)),
      resultEntry(postedKey(base.run.runId, base.run.headOid), 'premerge-success', recordedAtIso),
    ]);
    expect(evaluate(inputFrom([within])).reason).toBe('gate-not-passed');
  });

  it('refuses a journal reasonCode longer than 64', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], reasonCode: 'r'.repeat(65) };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [entry] }] }))).toEqual(refused());
  });

  it('accepts a journal reasonCode of 64 characters', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], reasonCode: 'r'.repeat(64) };
    const within = withJournal(base, [entry, base.run.journal[1] ?? entry]);
    expect(evaluate(inputFrom([within])).reason).toBe('gate-not-passed');
  });

  it('refuses a journal state longer than 64', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], state: 's'.repeat(65) };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [entry] }] }))).toEqual(refused());
  });

  it('accepts a journal state of 64 characters', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], state: 's'.repeat(64) };
    const within = withJournal(base, [entry, base.run.journal[1] ?? entry]);
    expect(evaluate(inputFrom([within])).reason).toBe('too-few-conforming-runs');
  });

  it('accepts a conduct journal entry whose key, outcome, reasonCode and state are null', () => {
    const fixtures = passing();
    const first = fixtures[0];
    if (first === undefined) throw new Error('fixture missing');
    const withConduct = withJournal(first, [
      ...first.run.journal,
      { kind: 'conduct', key: null, recordedAtIso: iso(DAY_MINUS_2, 11), outcome: null, reasonCode: null, state: null },
    ]);
    expect(evaluate(inputFrom([withConduct, ...fixtures.slice(1)]))).toEqual(
      scored('unknown', 'rules-incomplete', PASSING_COUNTS),
    );
  });

  it('refuses a malformed headMoves entry', () => {
    const move = { pullRequest: pullFor(1), fromHeadOid: headFor(1), toHeadOid: headFor(2) };
    expect(evaluate(shell({ headMoves: [move] }))).toEqual(refused());
  });

  it('refuses a malformed headMovesIncompleteFor entry', () => {
    expect(evaluate(shell({ headMovesIncompleteFor: ['12'] }))).toEqual(refused());
    expect(evaluate(shell({ headMovesIncompleteFor: [0] }))).toEqual(refused());
    expect(evaluate(shell({ headMovesIncompleteFor: [1.5] }))).toEqual(refused());
  });

  it('refuses a malformed journal entry', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0] } as Record<string, unknown>;
    delete entry.state;
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [entry] }] }))).toEqual(refused());
  });

  it('refuses an input that is not an exact plain record', () => {
    expect(evaluate(shell({ extra: true }))).toEqual(refused());
    const missing = shell();
    delete missing.day;
    expect(evaluate(missing)).toEqual(refused());
  });

  it('refuses a run that is not an exact plain record', () => {
    expect(evaluate(shell({ runs: [validRun({ extra: true })] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [1] }))).toEqual(refused());
    const missing = validRun();
    delete missing.journal;
    expect(evaluate(shell({ runs: [missing] }))).toEqual(refused());
  });

  it('refuses a journal entry with an extra own key', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], note: 'x' };
    expect(evaluate(shell({ runs: [{ ...base.run, journal: [entry] }] }))).toEqual(refused());
  });

  it('refuses a merge that is not an exact plain record', () => {
    const merge = { pullRequest: pullFor(1), headOid: headFor(1), atIso: iso(DAY, 12), note: 'x' };
    expect(evaluate(shell({ merges: [merge] }))).toEqual(refused());
  });

  it('refuses a review receipt whose kind or result is outside the unions', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const badKind = { ...base.run, reviewReceipts: [{ kind: 'gate', result: 'pass' }] };
    const badResult = { ...base.run, reviewReceipts: [{ kind: 'code-review', result: 'yes' }] };
    expect(evaluate(shell({ runs: [badKind] }))).toEqual(refused());
    expect(evaluate(shell({ runs: [badResult] }))).toEqual(refused());
  });

  it('refuses an over-cap runs list before reading any element', () => {
    const probe = overCap(SHADOW_CONFORMANCE_MAX_RUNS);
    expect(evaluate(shell({ runs: probe.list }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('refuses an over-cap journal before reading any entry', () => {
    const probe = overCap(SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN);
    expect(evaluate(shell({ runs: [validRun({ journal: probe.list })] }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('refuses an over-cap review-receipt list before reading any entry', () => {
    const probe = overCap(SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN);
    expect(evaluate(shell({ runs: [validRun({ reviewReceipts: probe.list })] }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('refuses an over-cap merges list before reading any element', () => {
    const probe = overCap(SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
    expect(evaluate(shell({ merges: probe.list }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('refuses an over-cap headMoves list before reading any element', () => {
    const probe = overCap(SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
    expect(evaluate(shell({ headMoves: probe.list }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('refuses an over-cap headMovesIncompleteFor list before reading any element', () => {
    const probe = overCap(SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
    expect(evaluate(shell({ headMovesIncompleteFor: probe.list }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });
});

describe('hostile input', () => {
  function shell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { day: DAY, runs: [], merges: [], headMoves: [], headMovesIncompleteFor: [], ...overrides };
  }

  it('refuses null', () => {
    expect(evaluate(null)).toEqual(refused());
  });

  it('refuses undefined', () => {
    expect(evaluate(undefined)).toEqual(refused());
  });

  it('refuses a number where a string is due', () => {
    expect(evaluate(shell({ day: 20261116 }))).toEqual(refused());
  });

  it('refuses a string where a list is due', () => {
    expect(evaluate(shell({ runs: 'runs' }))).toEqual(refused());
  });

  it('refuses a non-iterable object where a list is due', () => {
    expect(evaluate(shell({ runs: { nested: true } }))).toEqual(refused());
  });

  it('refuses an array hole', () => {
    const runs = [conforming(1, 1, iso(DAY, 12)).run];
    delete runs[0];
    expect(evaluate(shell({ runs }))).toEqual(refused());
  });

  it('refuses an array-like object { length: 1, 0: … }', () => {
    const runs = { length: 1, 0: conforming(1, 1, iso(DAY, 12)).run };
    expect(evaluate(shell({ runs }))).toEqual(refused());
  });

  it('refuses an enormous sparse length before any traversal', () => {
    let calls = 0;
    const runs: unknown[] = [];
    Object.defineProperty(runs, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    runs[2 ** 32 - 2] = true;
    expect(evaluate(shell({ runs }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on the root', () => {
    let calls = 0;
    const input = shell();
    Object.defineProperty(input, 'day', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return DAY;
      },
    });
    expect(evaluate(input)).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on an item', () => {
    let calls = 0;
    const runs: unknown[] = [];
    Object.defineProperty(runs, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return conforming(1, 1, iso(DAY, 12)).run;
      },
    });
    runs.length = 1;
    expect(evaluate(shell({ runs }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on a run field', () => {
    let calls = 0;
    const run = { ...conforming(1, 1, iso(DAY, 12)).run } as Record<string, unknown>;
    const headOid = run.headOid;
    delete run.headOid;
    Object.defineProperty(run, 'headOid', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return headOid;
      },
    });
    expect(evaluate(shell({ runs: [run] }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('a Proxy over a valid input yields the plain result and runs no get trap', () => {
    const plain = inputFrom(passing());
    let gets = 0;
    const proxy = new Proxy(plain, {
      get(target, prop, receiver) {
        gets += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const plainResult = evaluate(plain);
    const proxied = evaluate(proxy);
    const same = JSON.stringify(proxied) === JSON.stringify(plainResult);
    const rejected = proxied.status === 'unknown' && proxied.reason === 'invalid-input';
    expect(same || rejected).toBe(true);
    expect(gets).toBe(0);
    expect(plainResult.reason).toBe('rules-incomplete');
  });

  it('refuses a prototype-polluting __proto__ key produced by JSON.parse', () => {
    const input = JSON.parse(
      `{"__proto__":{"admin":true},"day":"${DAY}","runs":[],"merges":[],"headMoves":[],"headMovesIncompleteFor":[]}`,
    );
    expect(evaluate(input)).toEqual(refused());
    expect(Object.prototype).not.toHaveProperty('admin');
  });

  it('refuses a prototype-polluting constructor key produced by JSON.parse', () => {
    const input = JSON.parse(
      `{"constructor":{"admin":true},"day":"${DAY}","runs":[],"merges":[],"headMoves":[],"headMovesIncompleteFor":[]}`,
    );
    expect(evaluate(input)).toEqual(refused());
  });

  it('refuses a prototype-polluting prototype key produced by JSON.parse', () => {
    const input = JSON.parse(
      `{"prototype":{"admin":true},"day":"${DAY}","runs":[],"merges":[],"headMoves":[],"headMovesIncompleteFor":[]}`,
    );
    expect(evaluate(input)).toEqual(refused());
  });

  it('a constant verdict would fail', () => {
    const five = evaluate(inputFrom(passing()));
    const four = evaluate(inputFrom(passing().slice(0, 4)));
    expect(five.reason).toBe('rules-incomplete');
    expect(four.reason).toBe('too-few-conforming-runs');
    expect(five.reason).not.toBe(four.reason);
    expect(five.status).not.toBe(four.status);
  });

  it('an identity echo of the input would fail', () => {
    const input = inputFrom(passing());
    const result = evaluate(input);
    expect(result).not.toBe(input);
    expect(result).not.toEqual(input);
    const run = passing()[0];
    expect(JSON.stringify(result)).not.toContain(run?.run.runId ?? 'missing');
  });

  it('JSON.stringify(result) contains no run id, head oid, key or pull request number', () => {
    const fixtures = passing();
    const input = inputFrom(fixtures, {
      headMoves: [{
        pullRequest: pullFor(1),
        fromHeadOid: headFor(1),
        toHeadOid: headFor(2),
        atIso: iso(DAY, 9),
      }],
      headMovesIncompleteFor: [pullFor(8)],
    });
    const result = evaluate(input);
    expect(result.reason).toBe('rules-incomplete');
    const json = JSON.stringify(result);
    expect(Object.keys(result).sort()).toEqual([
      'byCode',
      'conforming',
      'conformingTier1',
      'conformingTier2',
      'mergedRuns',
      'nonconformingOnDay',
      'reason',
      'status',
    ]);
    for (const fixture of fixtures) {
      expect(json).not.toContain(fixture.run.runId);
      expect(json).not.toContain(fixture.run.headOid);
      expect(json).not.toContain(head12(fixture.run.headOid));
      expect(json).not.toContain(String(fixture.run.pullRequest));
      for (const entry of fixture.run.journal) {
        if (entry.key !== null) expect(json).not.toContain(entry.key);
      }
    }
    expect(json).not.toContain(headFor(2));
    expect(json).not.toContain(String(pullFor(8)));
  });

  it('no input yields pass in this unit', () => {
    const base = conforming(6, 1, iso(DAY, 16));
    const tier2 = conforming(6, 2, iso(DAY, 16));
    const inputs = [
      inputFrom(passing()),
      inputFrom(passing().slice(0, 4)),
      inputFrom([1, 2, 3, 4, 5].map((n) => conforming(n, 1, iso(DAY, 8)))),
      onTop(withoutGate(base)),
      onTop(gateFailedOnly(base)),
      onTop(gateAt(base, headFor(90))),
      onTop(noCodeReview(tier2)),
      onTop(failedCodeReview(tier2)),
      onTop(noPreMergeReceipt(tier2)),
      onTop(conforming(7, 1, iso(DAY, 18))),
      onTop(premergeAt(base, shifted(iso(DAY, 16), 1000))),
      onTop(premergeAt(base, shifted(iso(DAY, 16), -60 * 60 * 1000), 'premerge-failure')),
      inputFrom([conforming(1, 1, iso(DAY, 12))], {
        extraMerges: [{ pullRequest: pullFor(1), headOid: headFor(1), atIso: iso(DAY, 18) }],
      }),
      null,
    ];
    for (const input of inputs) {
      const result = evaluate(input);
      expect(result.status).not.toBe('pass');
      expect(result.reason).not.toBe('conducted-runs-conform');
    }
  });
});

function overCap(cap: number): { readonly list: unknown[]; readonly calls: () => number } {
  let calls = 0;
  const list: unknown[] = [];
  Object.defineProperty(list, '0', {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return { marker: true };
    },
  });
  list.length = cap + 1;
  return { list, calls: () => calls };
}
