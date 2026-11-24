import { describe, expect, it } from 'vitest';

import { buildLaneRunStepKey, head12Of, laneRunPremergeKey, laneRunResumeKey } from '../lane-run-keys.js';
import {
  SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
  SHADOW_CONFORMANCE_MAX_HOPS,
  SHADOW_CONFORMANCE_MAX_RUNS,
  SHADOW_CONFORMANCE_MAX_SHELL_FACTS,
  SHADOW_CONFORMANCE_MIN_RUNS,
  SHADOW_CONFORMANCE_MIN_TIER1,
  SHADOW_CONFORMANCE_MIN_TIER2,
  SHADOW_NONCONFORMANCE_CODES,
  SHADOW_ONE_WAY_STEP_STATES,
  evaluateShadowConductedConformance,
} from '../shadow-day-conformance.js';
import type { ShadowNonconformanceCode } from '../shadow-day-conformance.js';
import { LANE_RUN_STATES } from '../value-objects/LaneRunState.vo.js';

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

interface MoveRecord {
  readonly pullRequest: number;
  readonly fromHeadOid: string;
  readonly toHeadOid: string;
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
  readonly headMoves?: readonly MoveRecord[];
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
  status: 'unknown' | 'fail' | 'pass',
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

type OneWayFixtureStep = 'prepare' | 'dispatch' | 'open-pr' | 'push' | 'merge' | 'park';

function move(pullRequest: number, fromN: number, toN: number, atIso: string): MoveRecord {
  return { pullRequest, fromHeadOid: headFor(fromN), toHeadOid: headFor(toN), atIso };
}

function retarget(fixture: Fixture, headOid: string): Fixture {
  const merge = fixture.merge;
  if (merge === null) throw new Error('fixture merge missing');
  return { run: fixture.run, merge: { ...merge, headOid } };
}

function oneWayKey(
  runId: string,
  step: OneWayFixtureStep,
  headOid: string | null,
  attemptOrdinal: number | null,
  seatIndex = 0,
): string {
  const built = buildLaneRunStepKey({
    runId,
    round: 0,
    step,
    seatIndex,
    attemptOrdinal,
    head12: headOid === null ? null : head12(headOid),
    retry: null,
  });
  if (!built.ok) throw new Error('fixture one-way key refused');
  return built.key;
}

/**
 * Resume keys come from the builder. `via` defaults to `web`. A crashed
 * escalation settles its marker on this key.
 */
function resumeKey(runId: string, parkOrdinal = 1, via: 'web' | 'cli' = 'web'): string {
  const built = laneRunResumeKey(runId, parkOrdinal, via);
  if (!built.ok) throw new Error('fixture resume key refused');
  return built.key;
}

function intentAt(key: string, recordedAtIso: string): JournalEntry {
  return { kind: 'intent', key, recordedAtIso, outcome: null, reasonCode: null, state: null };
}

function conductAt(state: string, recordedAtIso: string): JournalEntry {
  return { kind: 'conduct', key: null, recordedAtIso, outcome: null, reasonCode: null, state };
}

function extendJournal(fixture: Fixture, entries: readonly JournalEntry[]): Fixture {
  return withJournal(fixture, [...fixture.run.journal, ...entries]);
}

function hopChain(pullRequest: number, hops: number, atIso: string): { moves: MoveRecord[]; end: string } {
  const moves: MoveRecord[] = [];
  let fromN = 6;
  let end = headFor(6);
  for (let hop = 0; hop < hops; hop += 1) {
    const toN = 1000 + hop;
    moves.push(move(pullRequest, fromN, toN, atIso));
    fromN = toN;
    end = headFor(toN);
  }
  return { moves, end };
}

function withMoves(fixture: Fixture, moves: readonly MoveRecord[], incomplete: readonly number[] = []): Record<string, unknown> {
  return inputFrom([...passing(), fixture], { headMoves: moves, headMovesIncompleteFor: incomplete });
}

function expectCodesOnly(result: unknown, ...forbidden: readonly string[]): void {
  const json = JSON.stringify(result);
  for (const value of forbidden) expect(json).not.toContain(value);
}

const SIX_PASS: ScoreCounts = { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 };
const SIX_WINDOW: ScoreCounts = { ...PASSING_COUNTS, mergedRuns: 6 };
const SIX_FAIL: ScoreCounts = { ...SIX_WINDOW, nonconformingOnDay: 1 };

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

  it('3 Tier 1 and 2 Tier 2 conforming runs merged across D-2..D yield pass/conducted-runs-conform', () => {
    const fixtures = passing();
    for (const fixture of fixtures) {
      if (fixture.run.tier !== 1) continue;
      expect(fixture.run.reviewReceipts.some((item) => item.kind === 'pre-merge')).toBe(false);
    }
    expect(evaluate(inputFrom(fixtures))).toEqual(scored('pass', 'conducted-runs-conform', PASSING_COUNTS));
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
      scored('pass', 'conducted-runs-conform', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
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
      scored('pass', 'conducted-runs-conform', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
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
      scored('pass', 'conducted-runs-conform', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
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
        'pass',
        'conducted-runs-conform',
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
      scored('pass', 'conducted-runs-conform', PASSING_COUNTS),
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
    expect(evaluate(inputFrom([...passing(), unmerged]))).toEqual(scored('pass', 'conducted-runs-conform', PASSING_COUNTS));
  });

  it('a merge at 23:59:59Z on D-3 is outside W', () => {
    const outside = conforming(6, 2, iso(DAY_MINUS_3, 23, 59, 59));
    expect(evaluate(inputFrom([...passing(), outside]))).toEqual(scored('pass', 'conducted-runs-conform', PASSING_COUNTS));
  });

  it('a merge at 00:00:00Z on D-2 is inside W', () => {
    const early = conforming(6, 1, iso(DAY_MINUS_2, 0, 0, 0));
    expect(evaluate(onTop(early))).toEqual(
      scored('pass', 'conducted-runs-conform', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
    );
  });

  it('a merge at 00:00:00Z on D+1 is outside W', () => {
    const late = conforming(6, 1, '2026-11-17T00:00:00.000Z');
    expect(evaluate(onTop(late))).toEqual(scored('pass', 'conducted-runs-conform', PASSING_COUNTS));
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
      scored('pass', 'conducted-runs-conform', PASSING_COUNTS),
    );
  });

  it('places a merge by its UTC instant when the offset shifts the calendar day', () => {
    const shiftedDay = conforming(6, 1, '2026-11-17T01:30:00.000+02:00');
    expect(evaluate(onTop(shiftedDay))).toEqual(
      scored('pass', 'conducted-runs-conform', { mergedRuns: 6, conforming: 6, conformingTier1: 4, conformingTier2: 2 }),
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
      scored('pass', 'conducted-runs-conform', PASSING_COUNTS),
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

  it('refuses a symbol own key on the runs list', () => {
    const runs: unknown[] = [conforming(1, 1, iso(DAY, 12)).run];
    Object.defineProperty(runs, Symbol('tag'), { value: 1, enumerable: false, configurable: true });
    expect(evaluate(shell({ runs }))).toEqual(refused());
  });

  it('refuses a non-enumerable extra own key on the runs list', () => {
    const runs: unknown[] = [conforming(1, 1, iso(DAY, 12)).run];
    Object.defineProperty(runs, 'hidden', { value: 1, enumerable: false, configurable: true, writable: true });
    expect(evaluate(shell({ runs }))).toEqual(refused());
  });

  it('refuses a list-level accessor element on the runs list', () => {
    let calls = 0;
    const runs: unknown[] = [conforming(1, 1, iso(DAY, 12)).run];
    Object.defineProperty(runs, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return conforming(1, 1, iso(DAY, 12)).run;
      },
    });
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
    expect(plainResult.reason).toBe('conducted-runs-conform');
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
    expect(five.reason).toBe('conducted-runs-conform');
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
    expect(result.reason).toBe('conducted-runs-conform');
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

  it('each non-passing input set (rule 2-5 breakage, merge ambiguity, a stray on D, null) does not pass', () => {
    // A floor-meeting day now passes, including one with a D-1 break added
    // on top. This loop keeps only sets that must not pass.
    const base = conforming(6, 1, iso(DAY, 16));
    const tier2 = conforming(6, 2, iso(DAY, 16));
    const first = conforming(1, 1, iso(DAY, 12));
    const second = conforming(2, 2, iso(DAY, 14));
    const shared: Fixture = { run: { ...second.run, pullRequest: first.run.pullRequest }, merge: null };
    const d1Kept = passing().filter((fixture) => fixture.merge?.atIso.startsWith(DAY_MINUS_1) !== true);
    const d1Breakage = inputFrom([...d1Kept, withoutGate(conforming(2, 1, iso(DAY_MINUS_1, 12)))]);
    const d1Alone = inputFrom([withoutGate(conforming(6, 1, iso(DAY_MINUS_1, 18)))]);
    const severalRuns = inputFrom([first, shared]);
    const inputs = [
      inputFrom(passing().slice(0, 4)),
      inputFrom([1, 2, 3, 4, 5].map((n) => conforming(n, 1, iso(DAY, 8)))),
      onTop(withoutGate(base)),
      onTop(gateFailedOnly(base)),
      onTop(gateAt(base, headFor(90))),
      onTop(noCodeReview(tier2)),
      onTop(failedCodeReview(tier2)),
      onTop(noPreMergeReceipt(tier2)),
      onTop(premergeAt(base, shifted(iso(DAY, 16), 1000))),
      onTop(premergeAt(base, shifted(iso(DAY, 16), -60 * 60 * 1000), 'premerge-failure')),
      inputFrom([conforming(1, 1, iso(DAY, 12))], {
        extraMerges: [{ pullRequest: pullFor(1), headOid: headFor(1), atIso: iso(DAY, 18) }],
      }),
      d1Breakage,
      d1Alone,
      severalRuns,
      null,
    ];
    for (const input of inputs) {
      const result = evaluate(input);
      expect(result.status).not.toBe('pass');
      expect(result.reason).not.toBe('conducted-runs-conform');
    }
  });

});

/**
 * A field-by-field copy. Reference equality must not be what makes two
 * records the same run.
 */
function copiedRun(run: RunRecord): RunRecord {
  return {
    runId: run.runId,
    tier: run.tier,
    pullRequest: run.pullRequest,
    headOid: run.headOid,
    reviewReceipts: run.reviewReceipts.map((item) => ({ kind: item.kind, result: item.result })),
    journal: run.journal.map((entry) => ({
      kind: entry.kind,
      key: entry.key,
      recordedAtIso: entry.recordedAtIso,
      outcome: entry.outcome,
      reasonCode: entry.reasonCode,
      state: entry.state,
    })),
  };
}

describe('duplicate runId dedupe and superseded attempts (S6d)', () => {
  it('two identical entries for one runId count once and do not yield pull-request-has-several-runs', () => {
    const added = conforming(6, 1, iso(DAY, 16));
    const once = evaluate(onTop(added));
    const twice = evaluate(inputFrom([...passing(), added, { run: copiedRun(added.run), merge: null }]));
    expect(once).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
    expect(twice).toEqual(once);
    expect(twice.mergedRuns).toBe(6);
    expect(twice.conforming).toBe(6);
    expect(twice.conformingTier1).toBe(4);
    expect(twice.reason).not.toBe('pull-request-has-several-runs');
    expectCodesOnly(twice, added.run.runId, added.run.headOid, head12(added.run.headOid), String(added.run.pullRequest));
  });

  it.each([
    {
      field: 'headOid',
      run: (base: RunRecord): RunRecord => ({ ...base, headOid: headFor(90) }),
    },
    {
      field: 'tier',
      run: (base: RunRecord): RunRecord => ({ ...base, tier: 2 }),
    },
    {
      field: 'pullRequest',
      run: (base: RunRecord): RunRecord => ({ ...base, pullRequest: pullFor(90) }),
    },
    {
      field: 'receipt result',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        reviewReceipts: base.reviewReceipts.map((item) =>
          item.kind === 'code-review' ? { kind: item.kind, result: 'fail' as const } : item,
        ),
      }),
    },
    {
      field: 'journal recordedAtIso',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        journal: base.journal.map((entry, index) =>
          index === 0 ? { ...entry, recordedAtIso: shifted(entry.recordedAtIso, -1000) } : entry,
        ),
      }),
    },
    {
      field: 'journal kind',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        journal: base.journal.map((entry, index) => (index === 0 ? { ...entry, kind: 'intent' } : entry)),
      }),
    },
    {
      field: 'journal key',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        journal: base.journal.map((entry, index) => (index === 0 ? { ...entry, key: 'journal-key-twin' } : entry)),
      }),
    },
    {
      // Gate entry only: outcome 'completed' vs 'failed'. Dropping the outcome
      // comparison collapses this twin onto the conforming record (first-wins)
      // and the day passes.
      field: 'journal outcome',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        journal: base.journal.map((entry, index) => (index === 0 ? { ...entry, outcome: 'failed' } : entry)),
      }),
    },
    {
      field: 'journal reasonCode',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        journal: base.journal.map((entry, index) => (index === 0 ? { ...entry, reasonCode: 'gate-failed' } : entry)),
      }),
    },
    {
      field: 'journal state',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        journal: base.journal.map((entry, index) => (index === 0 ? { ...entry, state: 'running' } : entry)),
      }),
    },
    {
      field: 'receipt kind',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        reviewReceipts: base.reviewReceipts.map((item) =>
          item.kind === 'code-review' ? { kind: 'brief-check', result: item.result } : item,
        ),
      }),
    },
    {
      field: 'reviewReceipts length',
      run: (base: RunRecord): RunRecord => ({
        ...base,
        reviewReceipts: [...base.reviewReceipts, receipt('pre-merge', 'pass')],
      }),
    },
    {
      field: 'journal length',
      run: (base: RunRecord): RunRecord => {
        const first = base.journal[0];
        if (first === undefined) throw new Error('fixture journal missing');
        return {
          ...base,
          journal: [...base.journal, resultEntry('journal-length-twin', 'gate-passed', first.recordedAtIso)],
        };
      },
    },
  ])('duplicate runIds differing in $field yield unknown/duplicate-run-conflict', ({ run }) => {
    const added = conforming(6, 1, iso(DAY, 16));
    const base = copiedRun(added.run);
    const conflict = run(copiedRun(added.run));
    expect(conflict).not.toEqual(base);
    const result = evaluate(inputFrom([...passing(), added, { run: conflict, merge: null }]));
    expect(result).toEqual(scored('unknown', 'duplicate-run-conflict'));
    expect(result.status).not.toBe('pass');
    expect(result.reason).toBe('duplicate-run-conflict');
    expect(result.mergedRuns).toBe(0);
    expect(result.conforming).toBe(0);
    expectCodesOnly(
      result,
      added.run.runId,
      added.run.headOid,
      conflict.headOid,
      head12(added.run.headOid),
      String(added.run.pullRequest),
      String(conflict.pullRequest),
    );
  });

  it('a superseded attempt with gate only at an older head does not count as conforming', () => {
    const current = conforming(6, 1, iso(DAY, 16));
    const olderHead = headFor(90);
    const recordedAtIso = shifted(iso(DAY, 16), -60 * 60 * 1000);
    const superseded = withJournal(current, [
      resultEntry(gateKey(current.run.runId, olderHead), 'gate-passed', recordedAtIso),
      resultEntry(postedKey(current.run.runId, olderHead), 'premerge-success', recordedAtIso),
    ]);
    expect(superseded.run.headOid).not.toBe(olderHead);
    const result = evaluate(onTop(superseded));
    expect(result).toEqual(
      scored('fail', 'gate-not-passed', { ...PASSING_COUNTS, mergedRuns: 6, nonconformingOnDay: 1 }, { 'gate-not-passed': 1 }),
    );
    expect(result.conforming).toBe(PASSING_COUNTS.conforming);
    expect(result.status).not.toBe('pass');
    expectCodesOnly(
      result,
      superseded.run.runId,
      superseded.run.headOid,
      olderHead,
      head12(olderHead),
      String(superseded.run.pullRequest),
    );
  });

  it('a constant verdict cannot describe both an identical duplicate and a conflicting duplicate', () => {
    const added = conforming(6, 1, iso(DAY, 16));
    const identical = evaluate(inputFrom([...passing(), added, { run: copiedRun(added.run), merge: null }]));
    const conflicting = evaluate(
      inputFrom([...passing(), added, { run: { ...copiedRun(added.run), headOid: headFor(90) }, merge: null }]),
    );
    expect(identical.status).toBe('pass');
    expect(identical.reason).toBe('conducted-runs-conform');
    expect(conflicting.status).toBe('unknown');
    expect(conflicting.reason).toBe('duplicate-run-conflict');
    expect(identical.status).not.toBe(conflicting.status);
    expect(identical.reason).not.toBe(conflicting.reason);
  });

  it('an identity echo of a duplicate-run input would fail and the result echoes no run id, head or pull request', () => {
    const added = conforming(6, 1, iso(DAY, 16));
    const input = inputFrom([...passing(), added, { run: copiedRun(added.run), merge: null }]);
    const result = evaluate(input);
    expect(result).not.toBe(input);
    expect(result).not.toEqual(input);
    expect(result.reason).toBe('conducted-runs-conform');
    const json = JSON.stringify(result);
    expect(json).not.toContain(added.run.runId);
    expect(json).not.toContain(added.run.headOid);
    expect(json).not.toContain(String(added.run.pullRequest));
    for (const fixture of passing()) {
      expect(json).not.toContain(fixture.run.runId);
      expect(json).not.toContain(fixture.run.headOid);
      expect(json).not.toContain(String(fixture.run.pullRequest));
    }
  });
});

describe('rule 1 head linkage and rule 6 one-way discipline (SH12b)', () => {
  const at = iso(DAY, 15);

  function added(): Fixture {
    return conforming(6, 1, iso(DAY, 16));
  }

  it('the merged head reached through two shell head moves is linked', () => {
    const base = added();
    const linked = retarget(base, headFor(61));
    const moves = [
      move(base.run.pullRequest, 6, 60, at),
      move(base.run.pullRequest, 60, 61, '2026-11-16T18:00:00.000+02:00'),
    ];
    expect(evaluate(withMoves(linked, moves))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('a linked head stays conforming when its pull request is also in headMovesIncompleteFor', () => {
    const base = added();
    const linked = retarget(base, headFor(61));
    const moves = [move(base.run.pullRequest, 6, 60, at), move(base.run.pullRequest, 60, 61, iso(DAY, 16))];
    expect(evaluate(withMoves(linked, moves, [base.run.pullRequest]))).toEqual(
      scored('pass', 'conducted-runs-conform', SIX_PASS),
    );
  });

  it('the same head conforms even when the pull request is in headMovesIncompleteFor', () => {
    const base = added();
    expect(evaluate(withMoves(base, [], [base.run.pullRequest]))).toEqual(
      scored('pass', 'conducted-runs-conform', SIX_PASS),
    );
  });

  it('moves out of order in time (a move after the merge) yield fail/merged-head-unlinked', () => {
    const base = added();
    const linked = retarget(base, headFor(61));
    const moves = [
      move(base.run.pullRequest, 6, 60, at),
      move(base.run.pullRequest, 60, 61, '2026-11-16T15:30:00.000-02:00'),
    ];
    const result = evaluate(withMoves(linked, moves));
    expect(result).toEqual(scored('fail', 'merged-head-unlinked', SIX_FAIL, { 'merged-head-unlinked': 1 }));
    expectCodesOnly(result, base.run.runId, base.run.headOid, headFor(60), headFor(61), String(base.run.pullRequest));
  });

  it('a broken chain whose pull request is in headMovesIncompleteFor yields unknown/head-moves-incomplete', () => {
    const base = added();
    const linked = retarget(base, headFor(61));
    const result = evaluate(withMoves(linked, [move(base.run.pullRequest, 6, 60, at)], [base.run.pullRequest]));
    expect(result).toEqual(scored('unknown', 'head-moves-incomplete', SIX_WINDOW));
    expectCodesOnly(result, base.run.runId, base.run.headOid, headFor(61), String(base.run.pullRequest));
  });

  it('a two-move cycle is unlinked and does not loop', () => {
    const base = added();
    const linked = retarget(base, headFor(61));
    const moves = [
      move(base.run.pullRequest, 6, 60, at),
      move(base.run.pullRequest, 60, 6, iso(DAY, 15, 30)),
    ];
    expect(evaluate(withMoves(linked, moves))).toEqual(
      scored('fail', 'merged-head-unlinked', SIX_FAIL, { 'merged-head-unlinked': 1 }),
    );
  });

  it('a path longer than SHADOW_CONFORMANCE_MAX_HOPS yields fail/merged-head-unlinked', () => {
    const base = added();
    const chain = hopChain(base.run.pullRequest, SHADOW_CONFORMANCE_MAX_HOPS + 1, at);
    expect(evaluate(withMoves(retarget(base, chain.end), chain.moves))).toEqual(
      scored('fail', 'merged-head-unlinked', SIX_FAIL, { 'merged-head-unlinked': 1 }),
    );
  });

  it('a path of SHADOW_CONFORMANCE_MAX_HOPS head moves is linked', () => {
    const base = added();
    const chain = hopChain(base.run.pullRequest, SHADOW_CONFORMANCE_MAX_HOPS, at);
    expect(evaluate(withMoves(retarget(base, chain.end), chain.moves))).toEqual(
      scored('pass', 'conducted-runs-conform', SIX_PASS),
    );
  });

  it('head moves of another pull request never link', () => {
    const base = added();
    const linked = retarget(base, headFor(61));
    const moves = [move(pullFor(99), 6, 60, at), move(pullFor(99), 60, 61, iso(DAY, 15, 30))];
    expect(evaluate(withMoves(linked, moves))).toEqual(
      scored('fail', 'merged-head-unlinked', SIX_FAIL, { 'merged-head-unlinked': 1 }),
    );
  });

  it('a second open-pr intent with the same key yields fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'open-pr', base.run.headOid, null);
    const once = extendJournal(base, [conductAt('opening-pr', at), intentAt(key, at)]);
    const twice = extendJournal(base, [conductAt('opening-pr', at), intentAt(key, at), intentAt(key, at)]);
    expect(evaluate(onTop(once))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
    const result = evaluate(onTop(twice));
    expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
    expectCodesOnly(result, base.run.runId, key, String(base.run.pullRequest));
  });

  it('an open-pr intent while the state is gating yields fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'open-pr', base.run.headOid, null);
    const broken = extendJournal(base, [conductAt('gating', at), intentAt(key, at)]);
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }),
    );
  });

  it('a merge intent while the state is not merging yields fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'merge', base.run.headOid, null);
    const broken = extendJournal(base, [conductAt('gating', at), intentAt(key, at)]);
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }),
    );
  });

  it('a conduct entry with state null makes a following one-way intent stray', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'open-pr', base.run.headOid, null);
    const broken = extendJournal(base, [
      { kind: 'conduct', key: null, recordedAtIso: at, outcome: null, reasonCode: null, state: null },
      intentAt(key, at),
    ]);
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }),
    );
  });

  it('a push intent while opening-pr yields fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'push', base.run.headOid, null);
    const broken = extendJournal(base, [conductAt('opening-pr', at), intentAt(key, at)]);
    expect(evaluate(onTop(broken))).toEqual(
      scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }),
    );
  });

  it('a prepare intent from ready and a dispatch intent from dispatching conforms', () => {
    const base = added();
    const prepare = oneWayKey(base.run.runId, 'prepare', null, 1);
    const dispatch = oneWayKey(base.run.runId, 'dispatch', null, 1);
    const run = extendJournal(base, [intentAt(prepare, at), conductAt('dispatching', at), intentAt(dispatch, at)]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('two park intents sharing one key are not stray', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const run = extendJournal(base, [conductAt('running', at), intentAt(key, at), intentAt(key, at)]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('a park intent while the state is merged or stopped yields fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null);
    for (const state of ['merged', 'stopped']) {
      const broken = extendJournal(base, [conductAt(state, at), intentAt(key, at)]);
      expect(evaluate(onTop(broken))).toEqual(
        scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }),
      );
    }
  });

  it('a park intent while the state is parked conforms', () => {
    // CE1w: the commit-pending escalation journals its one-way park intent
    // from `parked`. CE1w2: it conforms only with a later `park-escalated`
    // result. Any key and any outcome count; a crash settles on the resume key.
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null);
    const marker = resultEntry(resumeKey(base.run.runId), 'park-escalated', at, 'reconciled');
    const run = extendJournal(base, [conductAt('parked', at), intentAt(key, at), marker]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('one park-from-parked escalation with a later park-escalated result returns pass/conducted-runs-conform', () => {
    // The park step key's seat index is the run's parkCount. The normal path
    // conducts onward, then writes the marker on the park key.
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const run = extendJournal(base, [
      conductAt('parked', at),
      intentAt(key, at),
      conductAt('fixing', at),
      resultEntry(key, 'park-escalated', at, 'completed'),
    ]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('a later park-escalated result with a null key and a null outcome returns pass/conducted-runs-conform', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const marker: JournalEntry = {
      kind: 'result',
      key: null,
      recordedAtIso: at,
      outcome: null,
      reasonCode: 'park-escalated',
      state: null,
    };
    const run = extendJournal(base, [conductAt('parked', at), intentAt(key, at), marker]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('a park-from-parked intent with no later park-escalated result returns fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const parked = conductAt('parked', at);
    const intent = intentAt(key, at);
    const resumed = resumeKey(base.run.runId);
    const decoys: JournalEntry[] = [
      resultEntry(resumed, 'resumed', at),
      resultEntry(resumed, 'fix-no-progress', at),
      resultEntry(resumed, '', at),
      { kind: 'result', key: null, recordedAtIso: at, outcome: null, reasonCode: null, state: null },
      { kind: 'conduct', key: null, recordedAtIso: at, outcome: 'completed', reasonCode: 'park-escalated', state: 'fixing' },
      { kind: 'intent', key: resumed, recordedAtIso: at, outcome: null, reasonCode: 'park-escalated', state: null },
    ];
    const cases = [extendJournal(base, [parked, intent]), ...decoys.map((decoy) => extendJournal(base, [parked, intent, decoy]))];
    for (const broken of cases) {
      const result = evaluate(onTop(broken));
      expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
      expectCodesOnly(result, base.run.runId, key, resumed, String(base.run.pullRequest), 'park-escalated');
    }
  });

  it('a second park-from-parked intent with a distinct parkCount key returns fail/stray-one-way-action', () => {
    const base = added();
    const firstKey = oneWayKey(base.run.runId, 'park', null, null, 1);
    const secondKey = oneWayKey(base.run.runId, 'park', null, null, 2);
    expect(firstKey).not.toBe(secondKey);
    const firstMarker = resultEntry(firstKey, 'park-escalated', at, 'completed');
    const secondMarker = resultEntry(resumeKey(base.run.runId, 2), 'park-escalated', at, 'reconciled');
    const once = extendJournal(base, [
      conductAt('parked', at),
      intentAt(firstKey, at),
      conductAt('fixing', at),
      firstMarker,
    ]);
    expect(evaluate(onTop(once))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
    const twice = extendJournal(base, [
      conductAt('parked', at),
      intentAt(firstKey, at),
      conductAt('fixing', at),
      firstMarker,
      conductAt('parked', at),
      intentAt(secondKey, at),
      secondMarker,
    ]);
    const result = evaluate(onTop(twice));
    expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
    expectCodesOnly(result, base.run.runId, firstKey, secondKey, String(base.run.pullRequest));
  });

  it('a second park-from-parked intent with a repeated key returns fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const marker = resultEntry(resumeKey(base.run.runId, 1), 'park-escalated', at, 'reconciled');
    const once = extendJournal(base, [conductAt('parked', at), intentAt(key, at), marker]);
    expect(evaluate(onTop(once))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
    const twice = extendJournal(base, [conductAt('parked', at), intentAt(key, at), intentAt(key, at), marker]);
    const result = evaluate(onTop(twice));
    expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
    expectCodesOnly(result, base.run.runId, key, String(base.run.pullRequest));
  });

  it('a park-escalated result placed before the park-from-parked intent returns fail/stray-one-way-action', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const marker = resultEntry(resumeKey(base.run.runId), 'park-escalated', at, 'completed');
    const broken = extendJournal(base, [marker, conductAt('parked', at), intentAt(key, at)]);
    const result = evaluate(onTop(broken));
    expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
    expectCodesOnly(result, base.run.runId, key, String(base.run.pullRequest), 'park-escalated');
  });

  it('a repeated park key issued before parked does not make the one parked escalation stray', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'park', null, null, 1);
    const marker = resultEntry(resumeKey(base.run.runId), 'park-escalated', at, 'reconciled');
    const run = extendJournal(base, [
      conductAt('running', at),
      intentAt(key, at),
      intentAt(key, at),
      conductAt('parked', at),
      intentAt(key, at),
      marker,
    ]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('resume-then-advance double escalation yields fail/stray-one-way-action', () => {
    // The resume path writes park-escalated on the resume key and no park
    // intent. A later advance writes it on the next park step key. Either
    // marker alone conforms; the two ordinals together are stray.
    const base = added();
    const resume = resumeKey(base.run.runId, 1, 'web');
    const advance = oneWayKey(base.run.runId, 'park', null, null, 2);
    expect(resume).not.toBe(advance);
    const resumeMarker = resultEntry(resume, 'park-escalated', at, 'reconciled');
    const advanceMarker = resultEntry(advance, 'park-escalated', at, 'completed');
    const markers = [resumeMarker, advanceMarker];
    const result = evaluate(onTop(extendJournal(base, markers)));
    expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
    expectCodesOnly(result, base.run.runId, resume, advance, String(base.run.pullRequest), 'park-escalated');
    for (const dropped of [0, 1]) {
      const one = markers.filter((_, index) => index !== dropped);
      expect(evaluate(onTop(extendJournal(base, one)))).toEqual(
        scored('pass', 'conducted-runs-conform', SIX_PASS),
      );
    }
  });

  it('resume-then-resume double escalation yields fail/stray-one-way-action', () => {
    const base = added();
    const web = resumeKey(base.run.runId, 1, 'web');
    const cli = resumeKey(base.run.runId, 2, 'cli');
    expect(web).not.toBe(cli);
    const webMarker = resultEntry(web, 'park-escalated', at, 'reconciled');
    const cliMarker = resultEntry(cli, 'park-escalated', at, 'reconciled');
    const markers = [webMarker, cliMarker];
    const result = evaluate(onTop(extendJournal(base, markers)));
    expect(result).toEqual(scored('fail', 'stray-one-way-action', SIX_FAIL, { 'stray-one-way-action': 1 }));
    expectCodesOnly(result, base.run.runId, web, cli, String(base.run.pullRequest), 'park-escalated');
    for (const dropped of [0, 1]) {
      const one = markers.filter((_, index) => index !== dropped);
      expect(evaluate(onTop(extendJournal(base, one)))).toEqual(
        scored('pass', 'conducted-runs-conform', SIX_PASS),
      );
    }
  });

  it('a single escalation via either park or resume key conforms', () => {
    const base = added();
    const park = oneWayKey(base.run.runId, 'park', null, null, 1);
    const resume = resumeKey(base.run.runId, 1, 'web');
    const viaPark = extendJournal(base, [resultEntry(park, 'park-escalated', at, 'completed')]);
    const viaResume = extendJournal(base, [resultEntry(resume, 'park-escalated', at, 'reconciled')]);
    expect(evaluate(onTop(viaPark))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
    expect(evaluate(onTop(viaResume))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('a crashed escalation that settled once on the same park ordinal conforms', () => {
    // One escalation written on both the resume key and the park step key,
    // or twice on the resume key after crash recovery, is one ordinal.
    const base = added();
    const resume = resumeKey(base.run.runId, 1, 'web');
    const park = oneWayKey(base.run.runId, 'park', null, null, 1);
    expect(resume).not.toBe(park);
    const bothShapes = extendJournal(base, [
      resultEntry(resume, 'park-escalated', at, 'reconciled'),
      resultEntry(park, 'park-escalated', at, 'completed'),
    ]);
    const repeatedResume = extendJournal(base, [
      resultEntry(resume, 'park-escalated', at, 'reconciled'),
      resultEntry(resume, 'park-escalated', at, 'reconciled'),
    ]);
    expect(evaluate(onTop(bothShapes))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
    expect(evaluate(onTop(repeatedResume))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('an entry with an unparseable key is ignored', () => {
    const base = added();
    const run = extendJournal(base, [intentAt('not-a-lane-run-key', at)]);
    expect(evaluate(onTop(run))).toEqual(scored('pass', 'conducted-runs-conform', SIX_PASS));
  });

  it('rule 1 and rule 6 failing together on D yield fail/merged-head-unlinked', () => {
    const base = added();
    const key = oneWayKey(base.run.runId, 'open-pr', base.run.headOid, null);
    const extended = extendJournal(base, [conductAt('opening-pr', at), intentAt(key, at), intentAt(key, at)]);
    const broken = retarget(extended, headFor(61));
    expect(evaluate(withMoves(broken, []))).toEqual(
      scored('fail', 'merged-head-unlinked', SIX_FAIL, { 'merged-head-unlinked': 1 }),
    );
  });

  it('a rule-1 failure plus a rule-2 failure yields fail/merged-head-unlinked', () => {
    const broken = retarget(withoutGate(added()), headFor(61));
    expect(evaluate(withMoves(broken, []))).toEqual(
      scored('fail', 'merged-head-unlinked', SIX_FAIL, { 'merged-head-unlinked': 1 }),
    );
  });

  it('a stray one-way action on a run merged on D-1 is not a failure of D and is excluded from the counts', () => {
    const base = conforming(6, 1, iso(DAY_MINUS_1, 18));
    const key = oneWayKey(base.run.runId, 'push', base.run.headOid, null);
    const broken = extendJournal(base, [
      conductAt('opening-pr', iso(DAY_MINUS_1, 17)),
      intentAt(key, iso(DAY_MINUS_1, 17)),
    ]);
    expect(evaluate(onTop(broken))).toEqual(
      scored('pass', 'conducted-runs-conform', SIX_WINDOW, { 'stray-one-way-action': 1 }),
    );
  });

  it('SHADOW_ONE_WAY_STEP_STATES is frozen and its park row has exactly the allowed states', () => {
    expect(Object.isFrozen(SHADOW_ONE_WAY_STEP_STATES)).toBe(true);
    const steps = ['prepare', 'dispatch', 'open-pr', 'push', 'merge', 'park'] as const;
    for (const step of steps) expect(Object.isFrozen(SHADOW_ONE_WAY_STEP_STATES[step])).toBe(true);
    expect([...SHADOW_ONE_WAY_STEP_STATES.prepare]).toEqual(['ready', 'dispatching', 'seat-failed', 'fixing']);
    expect([...SHADOW_ONE_WAY_STEP_STATES.dispatch]).toEqual(['ready', 'dispatching', 'seat-failed', 'fixing']);
    expect([...SHADOW_ONE_WAY_STEP_STATES['open-pr']]).toEqual(['opening-pr']);
    expect([...SHADOW_ONE_WAY_STEP_STATES.push]).toEqual(['pushing']);
    expect([...SHADOW_ONE_WAY_STEP_STATES.merge]).toEqual(['merging']);
    const blocked = ['merged', 'stopped'];
    const park = [...SHADOW_ONE_WAY_STEP_STATES.park];
    expect(park).toEqual(LANE_RUN_STATES.filter((state) => !blocked.includes(state)));
    expect(park).toHaveLength(LANE_RUN_STATES.length - blocked.length);
    expect(park).toContain('parked');
    for (const state of blocked) expect(park).not.toContain(state);
  });
});

describe('hostile headMoves and journal (rule 1 and rule 6)', () => {
  function shell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { day: DAY, runs: [], merges: [], headMoves: [], headMovesIncompleteFor: [], ...overrides };
  }

  function runWith(journal: unknown): Record<string, unknown> {
    return { ...conforming(1, 1, iso(DAY, 12)).run, journal };
  }

  function validMove(): MoveRecord {
    return move(pullFor(1), 1, 2, iso(DAY, 9));
  }

  function enormousList(): { readonly list: unknown[]; readonly calls: () => number } {
    let calls = 0;
    const list: unknown[] = [];
    Object.defineProperty(list, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    list[2 ** 32 - 2] = true;
    return { list, calls: () => calls };
  }

  function jsonOwnKey(key: '__proto__' | 'constructor' | 'prototype', fields: string): unknown {
    return JSON.parse(`{"${key}":{"admin":true},${fields}}`);
  }

  const moveFields =
    `"pullRequest":${pullFor(1)},"fromHeadOid":"${headFor(1)}","toHeadOid":"${headFor(2)}","atIso":"${iso(DAY, 9)}"`;
  const journalFields =
    `"kind":"intent","key":"not-a-key","recordedAtIso":"${iso(DAY, 9)}","outcome":null,"reasonCode":null,"state":null`;

  it('refuses null headMoves', () => {
    expect(evaluate(shell({ headMoves: null }))).toEqual(refused());
  });

  it('refuses undefined headMoves', () => {
    expect(evaluate(shell({ headMoves: undefined }))).toEqual(refused());
  });

  it('refuses a number where a head-move string is due', () => {
    const item = { ...validMove(), fromHeadOid: 12 };
    expect(evaluate(shell({ headMoves: [item] }))).toEqual(refused());
  });

  it('refuses a string where the headMoves list is due', () => {
    expect(evaluate(shell({ headMoves: 'headMoves' }))).toEqual(refused());
  });

  it('refuses a non-iterable object where the headMoves list is due', () => {
    expect(evaluate(shell({ headMoves: { nested: true } }))).toEqual(refused());
  });

  it('refuses an array hole in headMoves', () => {
    const headMoves = [validMove()];
    delete headMoves[0];
    expect(evaluate(shell({ headMoves }))).toEqual(refused());
  });

  it('refuses an array-like object where the headMoves list is due', () => {
    const headMoves = { length: 1, 0: validMove() };
    expect(evaluate(shell({ headMoves }))).toEqual(refused());
  });

  it('refuses an enormous sparse headMoves length before any traversal', () => {
    const probe = enormousList();
    expect(evaluate(shell({ headMoves: probe.list }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('never runs a getter on a headMoves item', () => {
    let calls = 0;
    const headMoves: unknown[] = [];
    Object.defineProperty(headMoves, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return validMove();
      },
    });
    headMoves.length = 1;
    expect(evaluate(shell({ headMoves }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on a head-move field', () => {
    let calls = 0;
    const record = { ...validMove() } as Record<string, unknown>;
    const fromHeadOid = record.fromHeadOid;
    delete record.fromHeadOid;
    Object.defineProperty(record, 'fromHeadOid', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return fromHeadOid;
      },
    });
    expect(evaluate(shell({ headMoves: [record] }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on the root headMoves property', () => {
    let calls = 0;
    const input = shell();
    Object.defineProperty(input, 'headMoves', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    expect(evaluate(input)).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('a Proxy over a valid headMoves list yields the plain result and runs no get trap', () => {
    const plain = inputFrom(passing());
    let gets = 0;
    const headMoves = new Proxy([] as unknown[], {
      get(target, prop, receiver) {
        gets += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    const proxied = evaluate({ ...plain, headMoves });
    const plainResult = evaluate(plain);
    const same = JSON.stringify(proxied) === JSON.stringify(plainResult);
    const rejected = proxied.status === 'unknown' && proxied.reason === 'invalid-input';
    expect(same || rejected).toBe(true);
    expect(gets).toBe(0);
    expect(plainResult.reason).toBe('conducted-runs-conform');
  });

  it('refuses a prototype-polluting __proto__ key on a head move produced by JSON.parse', () => {
    const input = shell({ headMoves: [jsonOwnKey('__proto__', moveFields)] });
    expect(evaluate(input)).toEqual(refused());
    expect(Object.prototype).not.toHaveProperty('admin');
  });

  it('refuses a prototype-polluting constructor key on a head move produced by JSON.parse', () => {
    expect(evaluate(shell({ headMoves: [jsonOwnKey('constructor', moveFields)] }))).toEqual(refused());
  });

  it('refuses a prototype-polluting prototype key on a head move produced by JSON.parse', () => {
    expect(evaluate(shell({ headMoves: [jsonOwnKey('prototype', moveFields)] }))).toEqual(refused());
  });

  it('refuses null journal', () => {
    expect(evaluate(shell({ runs: [runWith(null)] }))).toEqual(refused());
  });

  it('refuses undefined journal', () => {
    expect(evaluate(shell({ runs: [runWith(undefined)] }))).toEqual(refused());
  });

  it('refuses a number where a journal key string is due', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0], key: 12 };
    expect(evaluate(shell({ runs: [runWith([entry])] }))).toEqual(refused());
  });

  it('refuses a string where the journal list is due', () => {
    expect(evaluate(shell({ runs: [runWith('journal')] }))).toEqual(refused());
  });

  it('refuses a non-iterable object where the journal list is due', () => {
    expect(evaluate(shell({ runs: [runWith({ nested: true })] }))).toEqual(refused());
  });

  it('refuses an array hole in a journal', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const journal = [...base.run.journal];
    delete journal[0];
    expect(evaluate(shell({ runs: [runWith(journal)] }))).toEqual(refused());
  });

  it('refuses an array-like object where the journal list is due', () => {
    const base = conforming(1, 1, iso(DAY, 12));
    const journal = { length: 1, 0: base.run.journal[0] };
    expect(evaluate(shell({ runs: [runWith(journal)] }))).toEqual(refused());
  });

  it('refuses an enormous sparse journal length before any traversal', () => {
    const probe = enormousList();
    expect(evaluate(shell({ runs: [runWith(probe.list)] }))).toEqual(refused());
    expect(probe.calls()).toBe(0);
  });

  it('never runs a getter on a journal item', () => {
    let calls = 0;
    const journal: unknown[] = [];
    Object.defineProperty(journal, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return conforming(1, 1, iso(DAY, 12)).run.journal[0];
      },
    });
    journal.length = 1;
    expect(evaluate(shell({ runs: [runWith(journal)] }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on a journal field', () => {
    let calls = 0;
    const base = conforming(1, 1, iso(DAY, 12));
    const entry = { ...base.run.journal[0] } as Record<string, unknown>;
    const key = entry.key;
    delete entry.key;
    Object.defineProperty(entry, 'key', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return key;
      },
    });
    expect(evaluate(shell({ runs: [runWith([entry])] }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('never runs a getter on a run journal property', () => {
    let calls = 0;
    const run = { ...conforming(1, 1, iso(DAY, 12)).run } as Record<string, unknown>;
    const journal = run.journal;
    delete run.journal;
    Object.defineProperty(run, 'journal', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return journal;
      },
    });
    expect(evaluate(shell({ runs: [run] }))).toEqual(refused());
    expect(calls).toBe(0);
  });

  it('a Proxy over a valid journal yields the plain result and runs no get trap', () => {
    const plain = inputFrom(passing());
    const runs = [...(plain.runs as RunRecord[])];
    const first = runs[0];
    if (first === undefined) throw new Error('fixture missing');
    let gets = 0;
    const journal = new Proxy([...first.journal], {
      get(target, prop, receiver) {
        gets += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    runs[0] = { ...first, journal: journal as unknown as RunRecord['journal'] };
    const proxied = evaluate({ ...plain, runs });
    const plainResult = evaluate(plain);
    const same = JSON.stringify(proxied) === JSON.stringify(plainResult);
    const rejected = proxied.status === 'unknown' && proxied.reason === 'invalid-input';
    expect(same || rejected).toBe(true);
    expect(gets).toBe(0);
  });

  it('refuses a prototype-polluting __proto__ key on a journal entry produced by JSON.parse', () => {
    const entry = jsonOwnKey('__proto__', journalFields);
    expect(evaluate(shell({ runs: [runWith([entry])] }))).toEqual(refused());
    expect(Object.prototype).not.toHaveProperty('admin');
  });

  it('refuses a prototype-polluting constructor key on a journal entry produced by JSON.parse', () => {
    const entry = jsonOwnKey('constructor', journalFields);
    expect(evaluate(shell({ runs: [runWith([entry])] }))).toEqual(refused());
  });

  it('refuses a prototype-polluting prototype key on a journal entry produced by JSON.parse', () => {
    const entry = jsonOwnKey('prototype', journalFields);
    expect(evaluate(shell({ runs: [runWith([entry])] }))).toEqual(refused());
  });
});

describe('capped list length, density and prototype guards', () => {
  function shell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { day: DAY, runs: [], merges: [], headMoves: [], headMovesIncompleteFor: [], ...overrides };
  }

  function withRunList(
    run: RunRecord,
    key: 'journal' | 'reviewReceipts',
    list: readonly unknown[],
  ): Record<string, unknown> {
    return { ...run, [key]: list } as Record<string, unknown>;
  }

  interface CappedList {
    readonly name: string;
    readonly cap: number;
    readonly element: unknown;
    readonly place: (list: readonly unknown[]) => Record<string, unknown>;
  }

  function cappedLists(): readonly CappedList[] {
    const run = conforming(1, 1, iso(DAY, 12)).run;
    const entry = run.journal[0];
    if (entry === undefined) throw new Error('fixture journal missing');
    const merge = { pullRequest: pullFor(1), headOid: headFor(1), atIso: iso(DAY, 12) };
    return [
      { name: 'runs', cap: SHADOW_CONFORMANCE_MAX_RUNS, element: run, place: (list) => shell({ runs: list }) },
      { name: 'merges', cap: SHADOW_CONFORMANCE_MAX_SHELL_FACTS, element: merge, place: (list) => shell({ merges: list }) },
      {
        name: 'headMoves',
        cap: SHADOW_CONFORMANCE_MAX_SHELL_FACTS,
        element: move(pullFor(1), 1, 2, iso(DAY, 9)),
        place: (list) => shell({ headMoves: list }),
      },
      {
        name: 'headMovesIncompleteFor',
        cap: SHADOW_CONFORMANCE_MAX_SHELL_FACTS,
        element: pullFor(1),
        place: (list) => shell({ headMovesIncompleteFor: list }),
      },
      {
        name: 'journal',
        cap: SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
        element: entry,
        place: (list) => shell({ runs: [withRunList(run, 'journal', list)] }),
      },
      {
        name: 'reviewReceipts',
        cap: SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
        element: { kind: 'code-review', result: 'pass' },
        place: (list) => shell({ runs: [withRunList(run, 'reviewReceipts', list)] }),
      },
    ];
  }

  for (const spec of cappedLists()) {
    it(`refuses a dense ${spec.name} list of cap + 1 with invalid-input`, () => {
      const list = Array(spec.cap + 1).fill(spec.element);
      expect(list).toHaveLength(spec.cap + 1);
      expect(evaluate(spec.place(list))).toEqual(refused());
    });

    it(`does not refuse a dense ${spec.name} list of exactly the cap for length`, () => {
      const list = Array(spec.cap).fill(spec.element);
      expect(list).toHaveLength(spec.cap);
      expect(evaluate(spec.place(list))).toEqual(scored('fail', 'too-few-conforming-runs'));
    });
  }

  it('refuses an array with an extra own non-index property under the cap', () => {
    const merge = { pullRequest: pullFor(1), headOid: headFor(1), atIso: iso(DAY, 12) };
    expect(evaluate(shell({ merges: [merge] })).reason).not.toBe('invalid-input');
    const merges = [merge];
    Object.defineProperty(merges, 'note', { value: true, enumerable: true, configurable: true });
    expect(merges.length).toBeLessThanOrEqual(SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
    expect(Object.keys(merges).length).not.toBe(merges.length);
    expect(evaluate(shell({ merges }))).toEqual(refused());
  });

  it('refuses an array hole under the cap', () => {
    const merge = { pullRequest: pullFor(1), headOid: headFor(1), atIso: iso(DAY, 12) };
    expect(evaluate(shell({ merges: [merge, merge] })).reason).not.toBe('invalid-input');
    const merges = [merge, merge];
    delete merges[1];
    expect(merges.length).toBeLessThanOrEqual(SHADOW_CONFORMANCE_MAX_SHELL_FACTS);
    expect(Object.keys(merges).length).not.toBe(merges.length);
    expect(evaluate(shell({ merges }))).toEqual(refused());
  });

  it('refuses an Array subclass instance under the cap with invalid-input', () => {
    const run = conforming(1, 1, iso(DAY, 12)).run;
    expect(evaluate(shell({ runs: [run] })).reason).not.toBe('invalid-input');
    class RunList extends Array {}
    const runs = RunList.from([run]);
    expect(runs.length).toBeLessThanOrEqual(SHADOW_CONFORMANCE_MAX_RUNS);
    expect(Object.getPrototypeOf(runs)).not.toBe(Array.prototype);
    expect(evaluate(shell({ runs }))).toEqual(refused());
  });

  it('refuses a null-prototype array under the cap with invalid-input', () => {
    const run = conforming(1, 1, iso(DAY, 12)).run;
    const runs = [run];
    Object.setPrototypeOf(runs, null);
    expect(runs.length).toBeLessThanOrEqual(SHADOW_CONFORMANCE_MAX_RUNS);
    expect(Object.getPrototypeOf(runs)).toBeNull();
    expect(evaluate(shell({ runs }))).toEqual(refused());
  });

  it('a revoked Proxy passed as a list yields invalid-input', () => {
    const { proxy, revoke } = Proxy.revocable([conforming(1, 1, iso(DAY, 12)).run], {});
    revoke();
    expect(evaluate(shell({ runs: proxy }))).toEqual(refused());
  });

  it('a Proxy whose ownKeys trap throws, passed as a list, yields invalid-input', () => {
    const runs = new Proxy([conforming(1, 1, iso(DAY, 12)).run], {
      ownKeys() {
        throw new Error('ownKeys trap');
      },
    });
    expect(evaluate(shell({ runs }))).toEqual(refused());
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
