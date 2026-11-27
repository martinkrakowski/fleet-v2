import { describe, expect, it } from 'vitest';

import { buildLaneRunStepKey, buildMergeKey, laneRunPremergeKey, type MergeKeyOneWayAction } from '../lane-run-keys.js';
import { countedRunsForDay, evaluateShadowMergeSet, SHADOW_DAY_BOUNDARY_GRACE_MS } from '../shadow-day-merge-set.js';

const DAY = '2026-11-10';
const DIGEST = '0123456789ab';
const OTHER_DIGEST = 'ffeeddccbbaa';
const HEAD_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const HEAD_B = 'b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7';
const HEAD_C = 'f0e9d8c7b6a5f4e3d2c1b0a99887766554433221';

function inDayIso(minutes: number, second = 0): string {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `${DAY}T${hour}:${minute}:${String(second).padStart(2, '0')}.000Z`;
}

function mergeKey(digest: string, pullRequest: number, head12: string, action: MergeKeyOneWayAction = 'merge-pr'): string {
  const built = buildMergeKey({ repoDigest: digest, pullRequest, head12, action, attemptOrdinal: null, retry: null });
  if (!built.ok) {
    throw new Error('fixture key refused');
  }
  return built.key;
}

function shellEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    line: 1,
    atIso: inDayIso(600),
    kind: 'result',
    outcome: 'merged',
    pullRequest: 7,
    headOid: HEAD_A,
    detailCode: 'none',
    fromHeadOid: null,
    ...overrides,
  };
}

function fleetResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: mergeKey(DIGEST, 7, HEAD_A.slice(0, 12)),
    outcome: 'dry-run',
    reasonCode: 'would-merge',
    recordedAtIso: inDayIso(599, 50),
    ...overrides,
  };
}

function fleetEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pullRequest: 7, headOid: HEAD_A, ...overrides };
}

function dayInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: DAY,
    repoDigest: DIGEST,
    excludeBatchMerges: false,
    shell: { events: [shellEvent()], unknownLines: 0 },
    fleet: { results: [fleetResult()], entries: [fleetEntry()] },
    ...overrides,
  };
}

const PASS_DAY = { status: 'pass', reason: 'merge-set-equal', mergesCompared: 1, excludedBatchMerges: 0, compared: 1, divergences: 0 };

describe('evaluateShadowMergeSet (S1)', () => {
  it('passes a day where the shell and fleet sets are equal, with the correct mergesCompared count', () => {
    const input = dayInput({
      shell: { events: [shellEvent(), shellEvent({ line: 2, atIso: inDayIso(700), pullRequest: 8, headOid: HEAD_C })], unknownLines: 0 },
      fleet: {
        results: [fleetResult(), fleetResult({ key: mergeKey(DIGEST, 8, HEAD_C.slice(0, 12)), recordedAtIso: inDayIso(699, 50) })],
        entries: [fleetEntry(), fleetEntry({ pullRequest: 8, headOid: HEAD_C })],
      },
    });
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, mergesCompared: 2, compared: 2 });
  });

  it('fails with merge-set-divergence for a shell merge with no corresponding fleet would-merge', () => {
    const input = dayInput({ fleet: { results: [], entries: [fleetEntry()] } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('an own symbol key on events is invalid-input (Object.keys used to ignore it)', () => {
    const events = [shellEvent()];
    Object.defineProperty(events, Symbol('extra'), { value: 1, enumerable: true });
    const input = dayInput({ shell: { events, unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toEqual({ status: 'unknown', reason: 'invalid-input', mergesCompared: 0, excludedBatchMerges: 0, compared: 0, divergences: 0 });
  });

  it('a non-enumerable extra own key on results is invalid-input (Object.keys used to ignore it)', () => {
    const results = [fleetResult()];
    Object.defineProperty(results, 'extra', { value: 1, enumerable: false });
    const input = dayInput({ fleet: { results, entries: [fleetEntry()] } });
    expect(evaluateShadowMergeSet(input)).toEqual({ status: 'unknown', reason: 'invalid-input', mergesCompared: 0, excludedBatchMerges: 0, compared: 0, divergences: 0 });
  });

  it('an accessor element refuses the whole entries list before any element reader runs', () => {
    let calls = 0;
    const accessorList: unknown[] = [];
    Object.defineProperty(accessorList, 0, {
      enumerable: true,
      get() {
        calls += 1;
        return fleetEntry();
      },
    });
    accessorList.length = 1;
    const input = dayInput({ fleet: { results: [fleetResult()], entries: accessorList } });
    expect(evaluateShadowMergeSet(input)).toEqual({ status: 'unknown', reason: 'invalid-input', mergesCompared: 0, excludedBatchMerges: 0, compared: 0, divergences: 0 });
    expect(calls).toBe(0);
  });

  it('fails with merge-set-divergence for a fleet would-merge the shell never actually merged', () => {
    const input = dayInput({ shell: { events: [], unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('fails with merge-set-divergence for a head mismatch between the merged head and the resolved head', () => {
    const input = dayInput({
      fleet: {
        results: [fleetResult({ key: mergeKey(DIGEST, 7, HEAD_C.slice(0, 12)) })],
        entries: [fleetEntry({ headOid: HEAD_C })],
      },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence' });
  });

  it('passes a boundary-crossing pair: a fleet would-merge at 23:59:55 UTC on day D and its shell merge at 00:00:05 the next day', () => {
    const input = dayInput({
      shell: { events: [shellEvent({ atIso: '2026-11-11T00:00:05Z' })], unknownLines: 0 },
      fleet: { results: [fleetResult({ recordedAtIso: `${DAY}T23:59:55Z` })], entries: [fleetEntry()] },
    });
    // The shell merge's own time falls on the NEXT day, so it does not count
    // toward `mergesCompared` — but the pair still compares, and the fleet
    // row (earlier) precedes the shell merge (later), so the day passes.
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, mergesCompared: 0 });
  });

  it('passes when a divergence falls ONLY inside the grace margin, not within the day itself', () => {
    const input = dayInput({
      shell: {
        events: [
          shellEvent(),
          shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C, atIso: '2026-11-09T23:59:55Z' }),
          shellEvent({ line: 3, pullRequest: 10, headOid: 'b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7', atIso: '2026-11-11T00:00:05Z' }),
        ],
        unknownLines: 0,
      },
      fleet: { results: [fleetResult()], entries: [fleetEntry()] },
    });
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, mergesCompared: 1 });
  });

  it('counts an unmatched batch-member merge as a normal divergence with excludeBatchMerges false', () => {
    const batchEvent = shellEvent({ pullRequest: 9, headOid: HEAD_C, detailCode: 'batch-member' });
    const input = dayInput({ shell: { events: [shellEvent(), batchEvent], unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence' });
  });

  it('passes the same batch fixture with excludeBatchMerges true, with excludedBatchMerges 1', () => {
    const batchEvent = shellEvent({ pullRequest: 9, headOid: HEAD_C, detailCode: 'batch-member' });
    const input = dayInput({
      excludeBatchMerges: true,
      shell: { events: [shellEvent(), batchEvent], unknownLines: 0 },
    });
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, excludedBatchMerges: 1 });
  });

  it('fails live-action-in-shadow for a live merge-pr result inside day D, before the set comparison runs', () => {
    const input = dayInput({
      fleet: { results: [fleetResult({ outcome: 'merged' })], entries: [fleetEntry()] },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'live-action-in-shadow' });
  });

  it('fails live-action-in-shadow for a live update-branch result even when the sets also diverge', () => {
    const input = dayInput({
      fleet: {
        results: [fleetResult({ key: mergeKey(DIGEST, 9, 'bbbbbbbbbbbb', 'update-branch'), outcome: 'merged', reasonCode: 'would-update-branch' })],
        entries: [fleetEntry()],
      },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'live-action-in-shadow' });
  });

  it('fails fleet-head-unresolved for a would-merge whose head12 matches no entry record', () => {
    const input = dayInput({ fleet: { results: [fleetResult({ key: mergeKey(DIGEST, 99, '999999999999') })], entries: [fleetEntry()] } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'fleet-head-unresolved' });
  });

  it('fails fleet-head-ambiguous when two entries for the same PR carry different full heads sharing a 12-char prefix', () => {
    const sharedPrefix = 'a1b2c3d4e5f6';
    const headX = `${sharedPrefix}${'1'.repeat(28)}`;
    const headY = `${sharedPrefix}${'2'.repeat(28)}`;
    const input = dayInput({
      fleet: {
        results: [fleetResult({ key: mergeKey(DIGEST, 7, sharedPrefix) })],
        entries: [fleetEntry({ headOid: headX }), fleetEntry({ headOid: headY })],
      },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'fleet-head-ambiguous' });
  });

  it('resolves correctly through the index for a single matching entry (the normal case, indexing unchanged)', () => {
    const input = dayInput();
    expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
  });

  it('is not ambiguous when the same PR has two entries with DIFFERENT 12-char prefixes (indexed by PR+prefix, not PR alone)', () => {
    const input = dayInput({
      fleet: {
        results: [fleetResult()],
        entries: [fleetEntry(), fleetEntry({ headOid: HEAD_C })],
      },
    });
    expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
  });

  it('ignores results belonging to a DIFFERENT repo digest entirely', () => {
    const input = dayInput({
      fleet: {
        results: [
          fleetResult(),
          fleetResult({ key: mergeKey(OTHER_DIGEST, 7, HEAD_C.slice(0, 12)), outcome: 'merged' }),
          fleetResult({ key: mergeKey(OTHER_DIGEST, 8, HEAD_C.slice(0, 12)) }),
        ],
        entries: [fleetEntry()],
      },
    });
    expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
  });

  it('passes a day with zero shell merges and zero fleet would-merges, with mergesCompared 0', () => {
    expect(evaluateShadowMergeSet(dayInput({ shell: { events: [], unknownLines: 0 }, fleet: { results: [], entries: [] } })))
      .toEqual({ ...PASS_DAY, mergesCompared: 0, compared: 0 });
  });

  it('returns shell-events-incomplete when the shell record is not a full day', () => {
    expect(evaluateShadowMergeSet(dayInput({ shell: { events: [], unknownLines: 3 } })))
      .toMatchObject({ status: 'unknown', reason: 'shell-events-incomplete' });
  });

  it('uses the declared grace constant on both ends of the day window', () => {
    expect(SHADOW_DAY_BOUNDARY_GRACE_MS).toBe(600_000);
  });

  it('a constant verdict would fail: an equal day and a divergent day never share one status', () => {
    const pass = evaluateShadowMergeSet(dayInput());
    const fail = evaluateShadowMergeSet(dayInput({ shell: { events: [], unknownLines: 0 } }));
    expect(pass.status).toBe('pass');
    expect(fail.status).toBe('fail');
  });

  it('an identity echo of the input would fail: the result carries no input value', () => {
    const result = evaluateShadowMergeSet(dayInput());
    const text = JSON.stringify(result) ?? '';
    expect(text).not.toContain(DAY);
    expect(text).not.toContain(HEAD_A);
    expect(Object.keys(result).sort()).toEqual(['compared', 'divergences', 'excludedBatchMerges', 'mergesCompared', 'reason', 'status']);
  });

  it('judges a fleet result by its instant, not its written date: an offset-carried instant on day D fails live-action-in-shadow', () => {
    const input = dayInput({
      fleet: { results: [fleetResult({ outcome: 'merged', recordedAtIso: '2026-11-09T23:00:00.000-02:00' })], entries: [fleetEntry()] },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'live-action-in-shadow' });
  });

  it('judges a divergence by its instant, not its written date: a would-merge written on the previous day but landing on day D counts', () => {
    const input = dayInput({
      fleet: { results: [fleetResult({ recordedAtIso: '2026-11-09T23:05:00.000-01:00' })], entries: [fleetEntry()] },
      shell: { events: [], unknownLines: 0 },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('does not certify a pass when the comparator truncated its divergence list', () => {
    const graceHead = (pullRequest: number): string => pullRequest.toString(16).padStart(8, '0').repeat(5);
    const graceEvents = [1, ...Array.from({ length: 10 }, (_, i) => 10 + i), ...Array.from({ length: 40 }, (_, i) => 100 + i)]
      .map((pullRequest, index) => shellEvent({
        line: index + 1,
        pullRequest,
        headOid: graceHead(pullRequest),
        atIso: '2026-11-09T23:59:55Z',
      }));
    const events = [...graceEvents, shellEvent({ line: 99, pullRequest: 2, headOid: HEAD_C })];
    const input = dayInput({ shell: { events, unknownLines: 0 }, fleet: { results: [], entries: [] } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'unknown', reason: 'merge-set-comparison-truncated', mergesCompared: 1 });
  });

  it('fails with merge-set-divergence and divergences 1 when the fleet would-merge is recorded 1 s AFTER the shell merge of the same PR and head', () => {
    const input = dayInput({ fleet: { results: [fleetResult({ recordedAtIso: inDayIso(600, 1) })], entries: [fleetEntry()] } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('surfaces S1 divergenceDetails with parsed pr, head12, side and code for every divergence kind, sorted by pr', () => {
    const input = dayInput({
      shell: {
        events: [
          // pr 7 matches the fleet pair, but the fleet row is recorded 1 s
          // after the shell merge: an ordering divergence on the fleet side.
          shellEvent(),
          // pr 9 is merged on the shell and never on the fleet:
          // `missing-in-fleet`, so the divergence sits on the shell side.
          shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C }),
        ],
        unknownLines: 0,
      },
      fleet: {
        results: [
          fleetResult({ recordedAtIso: inDayIso(600, 1) }),
          // pr 8 has a fleet would-merge the shell never merged:
          // `missing-in-shell`, so the divergence sits on the fleet side.
          fleetResult({ key: mergeKey(DIGEST, 8, HEAD_B.slice(0, 12)) }),
        ],
        entries: [fleetEntry(), fleetEntry({ pullRequest: 8, headOid: HEAD_B })],
      },
    });
    const result = evaluateShadowMergeSet(input);
    expect(result.status).toBe('fail');
    expect(result.divergences).toBe(3);
    expect(result.divergenceDetails).toEqual({
      totalCount: 3,
      items: [
        { pr: 7, head12: HEAD_A.slice(0, 12), side: 'fleet', code: 'fleet-recorded-after-merge' },
        { pr: 8, head12: HEAD_B.slice(0, 12), side: 'fleet', code: 'missing-in-shell' },
        { pr: 9, head12: HEAD_C.slice(0, 12), side: 'shell', code: 'missing-in-fleet' },
      ],
    });
  });

  it('caps S1 divergenceDetails at 20 sorted items while preserving totalCount', () => {
    const head = (pullRequest: number): string => pullRequest.toString(16).padStart(8, '0').repeat(5);
    const events = Array.from({ length: 25 }, (_, index) => shellEvent({
      line: index + 1,
      pullRequest: 100 + index,
      headOid: head(100 + index),
      atIso: inDayIso(600 + index),
    }));
    const input = dayInput({ shell: { events, unknownLines: 0 }, fleet: { results: [], entries: [] } });
    const result = evaluateShadowMergeSet(input);
    expect(result.status).toBe('fail');
    expect(result.divergences).toBe(25);
    expect(result.divergenceDetails?.totalCount).toBe(25);
    expect(result.divergenceDetails?.items).toHaveLength(20);
    expect(result.divergenceDetails?.items.map((item) => item.pr)).toEqual(Array.from({ length: 20 }, (_, index) => 100 + index));
    expect(result.divergenceDetails?.items.every((item) => item.side === 'shell' && item.code === 'missing-in-fleet')).toBe(true);
  });

  it('passes with merge-set-equal when the same pair has the fleet row recorded 1 s BEFORE the shell merge', () => {
    const input = dayInput({ fleet: { results: [fleetResult({ recordedAtIso: inDayIso(599, 59) })], entries: [fleetEntry()] } });
    expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
  });

  it('passes when the fleet row and the shell merge carry EQUAL whole-second instants', () => {
    const input = dayInput({ fleet: { results: [fleetResult({ recordedAtIso: inDayIso(600) })], entries: [fleetEntry()] } });
    expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
  });

  it('counts the EARLIEST of two fleet rows for one pair, so one before and one after the shell merge still passes', () => {
    const input = dayInput({
      fleet: {
        results: [
          fleetResult({ recordedAtIso: inDayIso(600, 5) }),
          fleetResult({ recordedAtIso: inDayIso(599, 30) }),
        ],
        entries: [fleetEntry()],
      },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'pass', reason: 'merge-set-equal', divergences: 0 });
  });

  it('fails with merge-set-divergence when the only fleet rows are would-already-merged for the shell-merged heads', () => {
    const input = dayInput({
      fleet: { results: [fleetResult({ reasonCode: 'would-already-merged' })], entries: [fleetEntry()] },
    });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('a batch-member merge with no fleet row passes with excludedBatchMerges 1 under excludeBatchMerges true, while a non-batch merge with no fleet row still fails', () => {
    const excluded = dayInput({
      excludeBatchMerges: true,
      shell: { events: [shellEvent(), shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C, detailCode: 'batch-member' })], unknownLines: 0 },
    });
    expect(evaluateShadowMergeSet(excluded)).toEqual({ ...PASS_DAY, excludedBatchMerges: 1 });
    const notExcluded = dayInput({
      shell: { events: [shellEvent(), shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C })], unknownLines: 0 },
    });
    expect(evaluateShadowMergeSet(notExcluded)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence' });
  });

  it("a batch PR's own merge with no fleet row passes under excludeBatchMerges true when its batch/opened event exists, counting in excludedBatchMerges, and fails without the opened event", () => {
    const opened = shellEvent({ line: 1, kind: 'batch', outcome: 'opened', pullRequest: 9, headOid: HEAD_C, detailCode: 'none' });
    const ownMerge = shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C });
    const withOpened = dayInput({ excludeBatchMerges: true, shell: { events: [shellEvent(), opened, ownMerge], unknownLines: 0 } });
    expect(evaluateShadowMergeSet(withOpened)).toEqual({ ...PASS_DAY, excludedBatchMerges: 1 });
    const withoutOpened = dayInput({ excludeBatchMerges: true, shell: { events: [shellEvent(), ownMerge], unknownLines: 0 } });
    expect(evaluateShadowMergeSet(withoutOpened)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence' });
  });

  it("a batch PR's own merge whose merged headOid differs from the opened event's headOid is still excluded, matched on PR number alone", () => {
    const openedHead = 'b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7';
    const opened = shellEvent({ line: 1, kind: 'batch', outcome: 'opened', pullRequest: 9, headOid: openedHead, detailCode: 'none' });
    const ownMerge = shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C });
    const input = dayInput({ excludeBatchMerges: true, shell: { events: [shellEvent(), opened, ownMerge], unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, excludedBatchMerges: 1 });
  });

  it('an excluded batch member that DOES have a fleet would-merge row passes, the row dropped on the fleet side too (no missing-in-shell)', () => {
    const batchMerge = shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C, detailCode: 'batch-member' });
    const input = dayInput({
      excludeBatchMerges: true,
      shell: { events: [shellEvent(), batchMerge], unknownLines: 0 },
      fleet: {
        results: [fleetResult(), fleetResult({ key: mergeKey(DIGEST, 9, HEAD_C.slice(0, 12)), recordedAtIso: inDayIso(599, 40) })],
        entries: [fleetEntry(), fleetEntry({ pullRequest: 9, headOid: HEAD_C })],
      },
    });
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, excludedBatchMerges: 1 });
  });

  it('a fleet row at 00:00:00.900Z against a shell merge stamped 00:00:00Z passes (fleet instant floored to the second), and a row at 00:00:01.000Z fails', () => {
    const shellAtMidnight = shellEvent({ atIso: `${DAY}T00:00:00Z` });
    const run = (fleetAt: string) => evaluateShadowMergeSet(dayInput({
      shell: { events: [shellAtMidnight], unknownLines: 0 },
      fleet: { results: [fleetResult({ recordedAtIso: fleetAt })], entries: [fleetEntry()] },
    }));
    expect(run(`${DAY}T00:00:00.900Z`)).toEqual(PASS_DAY);
    expect(run(`${DAY}T00:00:01.000Z`)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('compares offset-carried instants by instant, not by text: a +02:00 row equal in instant passes, and a -02:00 row textually earlier but instantially later fails', () => {
    const passing = dayInput({
      fleet: { results: [fleetResult({ recordedAtIso: `${DAY}T12:00:00.000+02:00` })], entries: [fleetEntry()] },
    });
    expect(evaluateShadowMergeSet(passing)).toEqual(PASS_DAY);
    const failing = dayInput({
      fleet: { results: [fleetResult({ recordedAtIso: `${DAY}T09:00:00.000-02:00` })], entries: [fleetEntry()] },
    });
    expect(evaluateShadowMergeSet(failing)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
  });

  it('an excluded batch PR with a fleet would-merge on a DIFFERENT head than its shell merge passes, the fleet row dropped by PR number (no missing-in-shell)', () => {
    const otherHead = 'b0a9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7';
    const batchMerge = shellEvent({ line: 2, pullRequest: 9, headOid: HEAD_C, detailCode: 'batch-member' });
    const input = dayInput({
      excludeBatchMerges: true,
      shell: { events: [shellEvent(), batchMerge], unknownLines: 0 },
      fleet: {
        results: [fleetResult(), fleetResult({ key: mergeKey(DIGEST, 9, otherHead.slice(0, 12)), recordedAtIso: inDayIso(599, 40) })],
        entries: [fleetEntry(), fleetEntry({ pullRequest: 9, headOid: otherHead })],
      },
    });
    expect(evaluateShadowMergeSet(input)).toEqual({ ...PASS_DAY, excludedBatchMerges: 1 });
  });

  describe('superseded old-head fleet rows', () => {
    const supersededInput = (oldRows: { head: string; at: string }[]): Record<string, unknown> => dayInput({
      shell: { events: [shellEvent({ headOid: HEAD_C })], unknownLines: 0 },
      fleet: {
        results: [
          ...oldRows.map((row) => fleetResult({ key: mergeKey(DIGEST, 7, row.head.slice(0, 12)), recordedAtIso: row.at })),
          fleetResult({ key: mergeKey(DIGEST, 7, HEAD_C.slice(0, 12)), recordedAtIso: inDayIso(599, 50) }),
        ],
        entries: [...new Set([...oldRows.map((row) => row.head), HEAD_C])].map((head) => fleetEntry({ headOid: head })),
      },
    });

    it('drops an old-head row when the shell merged the PR at a newer head that has its own fleet row', () => {
      const input = supersededInput([{ head: HEAD_A, at: inDayIso(599, 30) }]);
      expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
    });

    it('drops every old-head row of one PR, not just the first', () => {
      const input = supersededInput([
        { head: HEAD_A, at: inDayIso(598, 10) },
        { head: HEAD_B, at: inDayIso(599, 10) },
      ]);
      expect(evaluateShadowMergeSet(input)).toEqual(PASS_DAY);
    });

    it('keeps a wrong-head row recorded after the shell merged the PR at the newer head', () => {
      const input = supersededInput([{ head: HEAD_A, at: inDayIso(600, 1) }]);
      expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence', divergences: 1 });
    });

    it('floors the old-head row to the whole second: 0.9 s into the merge second is dropped, the next whole second is kept', () => {
      const within = supersededInput([{ head: HEAD_A, at: inDayIso(600).replace('.000Z', '.900Z') }]);
      expect(evaluateShadowMergeSet(within)).toEqual(PASS_DAY);
      const after = supersededInput([{ head: HEAD_A, at: inDayIso(600, 1) }]);
      expect(evaluateShadowMergeSet(after)).toMatchObject({ status: 'fail', divergences: 1 });
    });

    it('keeps an old-head row when the newer shell-merged head has no fleet row of its own', () => {
      const input = dayInput({
        shell: { events: [shellEvent({ headOid: HEAD_C })], unknownLines: 0 },
        fleet: { results: [fleetResult({ recordedAtIso: inDayIso(599, 30) })], entries: [fleetEntry()] },
      });
      expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'fail', reason: 'merge-set-divergence' });
    });
  });
});

describe('evaluateShadowMergeSet hostile input', () => {
  const INVALID = { status: 'unknown', reason: 'invalid-input', mergesCompared: 0, excludedBatchMerges: 0, compared: 0, divergences: 0 };

  it('null is refused as invalid-input', () => {
    expect(evaluateShadowMergeSet(null)).toEqual(INVALID);
  });

  it('refuses null input with invalid-input and no divergenceDetails', () => {
    const result = evaluateShadowMergeSet(null);
    expect(result).toEqual(INVALID);
    expect(result).not.toHaveProperty('divergenceDetails');
  });

  it('returns invalid-input without divergenceDetails on a malformed S1 record', () => {
    const result = evaluateShadowMergeSet(dayInput({ day: 20261110 }));
    expect(result).toEqual(INVALID);
    expect(result).not.toHaveProperty('divergenceDetails');
  });

  it('never invokes a throwing getter on S1 input and returns invalid-input without divergenceDetails', () => {
    let calls = 0;
    const input: Record<string, unknown> = dayInput();
    Object.defineProperty(input, 'shell', {
      enumerable: true,
      get() {
        calls += 1;
        return { events: [], unknownLines: 0 };
      },
    });
    const result = evaluateShadowMergeSet(input);
    expect(result).toEqual(INVALID);
    expect(calls).toBe(0);
    expect(result).not.toHaveProperty('divergenceDetails');
  });

  it('omits malformed divergence keys from S1 divergenceDetails items while still counting them in totalCount and divergences', () => {
    // Two shell merges for the same pair duplicate one comparator key, so the
    // comparator emits one `invalid-item` divergence: it always counts toward
    // `divergences` and `totalCount`, but its key is not a parseable
    // `<pr>@<head>` divergence and carries no side, so `items` omits it.
    const input = dayInput({ shell: { events: [shellEvent(), shellEvent({ line: 2, atIso: inDayIso(601) })], unknownLines: 0 } });
    const result = evaluateShadowMergeSet(input);
    expect(result.status).toBe('fail');
    expect(result.reason).toBe('merge-set-divergence');
    expect(result.divergences).toBe(1);
    expect(result.divergenceDetails).toEqual({ totalCount: 1, items: [] });
  });

  it('undefined is refused as invalid-input', () => {
    expect(evaluateShadowMergeSet(undefined)).toEqual(INVALID);
  });

  it('a wrong primitive (a number where a string is due) is refused', () => {
    expect(evaluateShadowMergeSet(dayInput({ day: 20261110 }))).toEqual(INVALID);
  });

  it('a string unknownLines ("0") is refused as invalid-input, never treated as the number 0 or as shell-events-incomplete', () => {
    const input = dayInput({ shell: { events: [], unknownLines: '0' } });
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
  });

  it('a genuine positive integer unknownLines still produces shell-events-incomplete, not invalid-input', () => {
    const input = dayInput({ shell: { events: [], unknownLines: 1 } });
    expect(evaluateShadowMergeSet(input)).toMatchObject({ status: 'unknown', reason: 'shell-events-incomplete' });
  });

  it('a string where a list is due is refused', () => {
    const input = dayInput();
    (input.shell as Record<string, unknown>).events = 'merged';
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
  });

  it('a non-iterable object where a list is due is refused', () => {
    const input = dayInput();
    (input.fleet as Record<string, unknown>).entries = { pullRequest: 7, headOid: HEAD_A };
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
  });

  it('a sparse array with a hole is refused', () => {
    const events = [shellEvent()] as unknown[];
    delete events[0];
    const input = dayInput({ shell: { events, unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
  });

  it('an array-like object is refused', () => {
    const arrayLike = { length: 1, 0: shellEvent() };
    const input = dayInput({ shell: { events: arrayLike, unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
  });

  it('an enormous sparse length is refused before any traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    const input = dayInput({ shell: { events: enormous, unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
  });

  it('a getter on the root never runs and is refused', () => {
    let calls = 0;
    const input: Record<string, unknown> = dayInput();
    Object.defineProperty(input, 'shell', {
      enumerable: true,
      get() {
        calls += 1;
        return { events: [], unknownLines: 0 };
      },
    });
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('a getter on an item never runs and is refused', () => {
    let calls = 0;
    const event: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shellEvent())) {
      event[key] = value;
    }
    Object.defineProperty(event, 'outcome', {
      enumerable: true,
      get() {
        calls += 1;
        return 'merged';
      },
    });
    const input = dayInput({ shell: { events: [event], unknownLines: 0 } });
    expect(evaluateShadowMergeSet(input)).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('a Proxy over a valid input yields exactly the plain data result with no get trap run', () => {
    let gets = 0;
    const valid = dayInput();
    const proxied = new Proxy(valid, {
      get(target, property, receiver) {
        gets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(evaluateShadowMergeSet(proxied)).toEqual(PASS_DAY);
    expect(gets).toBe(0);
  });

  it('a Proxy over an invalid input is refused exactly like the plain invalid data', () => {
    const proxied = new Proxy(new Date(0), {});
    expect(evaluateShadowMergeSet(proxied)).toEqual(INVALID);
  });

  it('a JSON-parsed __proto__ own key is refused', () => {
    const parsed: Record<string, unknown> = JSON.parse(JSON.stringify(dayInput()));
    Object.defineProperty(parsed, '__proto__', { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
    expect(evaluateShadowMergeSet(parsed)).toEqual(INVALID);
  });

  it('a JSON-parsed constructor own key on a nested record is refused', () => {
    const parsed: Record<string, unknown> = JSON.parse(JSON.stringify(dayInput()));
    Object.defineProperty(parsed.fleet, 'constructor', { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
    expect(evaluateShadowMergeSet(parsed)).toEqual(INVALID);
  });
});

// --- SR3: countedRunsForDay (cut-over certification streak) ---

function streakRunId(n: number): string {
  return `run-0${String(n).padStart(25, '0')}`;
}

function streakHead(n: number): string {
  return `${n.toString(16).padStart(12, 'b')}${'c'.repeat(28)}`;
}

function gateKeyFor(runId: string, headOid: string): string {
  const built = buildLaneRunStepKey({
    runId,
    round: 0,
    step: 'gate',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: headOid.slice(0, 12),
    retry: null,
  });
  if (!built.ok) throw new Error('fixture gate key refused');
  return built.key;
}

function premergeKeyFor(runId: string, headOid: string): string {
  const built = laneRunPremergeKey(runId, 0, headOid.slice(0, 12));
  if (!built.ok) throw new Error('fixture premerge key refused');
  return built.key;
}

/** A conducted run that passes every S6 rule against a merge of its own head. */
function conformingStreakRun(n: number, tier: 1 | 2, pullRequest: number, headOid: string, mergeAtIso: string): Record<string, unknown> {
  const runId = streakRunId(n);
  const recordedAtIso = new Date(Date.parse(mergeAtIso) - 3_600_000).toISOString();
  const receipts = tier === 1
    ? [{ kind: 'brief-check', result: 'pass' }, { kind: 'code-review', result: 'pass' }]
    : [{ kind: 'brief-check', result: 'pass' }, { kind: 'code-review', result: 'pass' }, { kind: 'pre-merge', result: 'pass' }];
  const journal = [
    { kind: 'result', key: gateKeyFor(runId, headOid), recordedAtIso, outcome: 'completed', reasonCode: 'gate-passed', state: null },
    { kind: 'result', key: premergeKeyFor(runId, headOid), recordedAtIso, outcome: 'completed', reasonCode: 'premerge-success', state: null },
  ];
  return { runId, tier, pullRequest, headOid, reviewReceipts: receipts, journal };
}

interface StreakPair {
  readonly pullRequest: number;
  readonly tier: 1 | 2;
  readonly run: Record<string, unknown>;
  readonly shellEvent: Record<string, unknown>;
  readonly fleetResult: Record<string, unknown>;
  readonly fleetEntry: Record<string, unknown>;
}

function streakPair(n: number, tier: 1 | 2, line: number, hour: number, runOverrides: Record<string, unknown> = {}): StreakPair {
  const pullRequest = 4000 + n;
  const headOid = streakHead(n);
  const atIso = inDayIso(hour * 60);
  return {
    pullRequest,
    tier,
    run: { ...conformingStreakRun(n, tier, pullRequest, headOid, atIso), ...runOverrides },
    shellEvent: shellEvent({ line, atIso, pullRequest, headOid }),
    fleetResult: fleetResult({ key: mergeKey(DIGEST, pullRequest, headOid.slice(0, 12)), recordedAtIso: inDayIso(hour * 60 - 10, 50) }),
    fleetEntry: fleetEntry({ pullRequest, headOid }),
  };
}

function countedInputFor(pairs: readonly StreakPair[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: DAY,
    repoDigest: DIGEST,
    shell: { events: pairs.map((pair) => pair.shellEvent), unknownLines: 0 },
    fleet: { results: pairs.map((pair) => pair.fleetResult), entries: pairs.map((pair) => pair.fleetEntry) },
    runs: pairs.map((pair) => pair.run),
    headMoves: [],
    headMovesIncompleteFor: [],
    ...overrides,
  };
}

function refusedWith(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

describe('countedRunsForDay (cut-over certification streak)', () => {
  it('counts conforming S1-matched non-batch Tier 1 and Tier 2 runs, with countedTier2 split out', () => {
    const pairs = [streakPair(1, 1, 1, 10), streakPair(2, 1, 2, 11), streakPair(3, 2, 3, 12)];
    expect(countedRunsForDay(countedInputFor(pairs))).toEqual({ ok: true, countedRuns: 3, countedTier2: 1 });
  });

  it('excludes batch merges from the count while still counting the non-batch run', () => {
    const batch = streakPair(9, 1, 2, 12);
    const openedEvent = shellEvent({ line: 1, atIso: inDayIso(9 * 60), kind: 'batch', outcome: 'opened', pullRequest: batch.pullRequest, headOid: streakHead(9), detailCode: 'none' });
    const batchedShell = { ...batch.shellEvent, detailCode: 'batch-member' };
    const nonBatch = streakPair(1, 1, 3, 10);
    const input = countedInputFor([nonBatch], {
      shell: { events: [openedEvent, batchedShell, nonBatch.shellEvent], unknownLines: 0 },
      fleet: {
        results: [batch.fleetResult, nonBatch.fleetResult],
        entries: [batch.fleetEntry, nonBatch.fleetEntry],
      },
    });
    expect(countedRunsForDay(input)).toEqual({ ok: true, countedRuns: 1, countedTier2: 0 });
  });

  it('a batch-excluded PR with an unresolved fleet head neither counts nor breaks the day', () => {
    // Batches neither count nor break: the excluded batch merge's fleet
    // would-merge row must be dropped before fleet resolution, so its
    // unresolvable head cannot refuse the day for the non-batch run.
    const batch = streakPair(9, 1, 2, 12);
    const openedEvent = shellEvent({ line: 1, atIso: inDayIso(9 * 60), kind: 'batch', outcome: 'opened', pullRequest: batch.pullRequest, headOid: streakHead(9), detailCode: 'none' });
    const batchedShell = { ...batch.shellEvent, detailCode: 'batch-member' };
    const nonBatch = streakPair(1, 1, 3, 10);
    const unresolvedBatchRow = fleetResult({ key: mergeKey(DIGEST, batch.pullRequest, '999999999999') });
    const input = countedInputFor([nonBatch], {
      shell: { events: [openedEvent, batchedShell, nonBatch.shellEvent], unknownLines: 0 },
      fleet: {
        results: [batch.fleetResult, unresolvedBatchRow, nonBatch.fleetResult],
        entries: [batch.fleetEntry, nonBatch.fleetEntry],
      },
    });
    expect(countedRunsForDay(input)).toEqual({ ok: true, countedRuns: 1, countedTier2: 0 });
  });

  it('a conducted run matched by two same-day shell merges is counted once, not twice', () => {
    const pair = streakPair(1, 1, 2, 10);
    const secondMerge = shellEvent({ line: 3, atIso: inDayIso(15 * 60), pullRequest: pair.pullRequest, headOid: streakHead(1) });
    const secondFleetRow = fleetResult({ key: mergeKey(DIGEST, pair.pullRequest, streakHead(1).slice(0, 12)), recordedAtIso: inDayIso(14 * 60, 50) });
    const input = countedInputFor([pair], {
      shell: { events: [pair.shellEvent, secondMerge], unknownLines: 0 },
      fleet: { results: [pair.fleetResult, secondFleetRow], entries: [pair.fleetEntry] },
    });
    expect(countedRunsForDay(input)).toEqual({ ok: true, countedRuns: 1, countedTier2: 0 });
  });

  it('a later merge for the same PR that would judge unknown refuses the day instead of being skipped', () => {
    // The first merge conforms, but the second same-day merge moves to a head
    // with no linking head move while the pull request is listed in
    // `headMovesIncompleteFor`; every (run, merge) pairing must be evaluated,
    // so the later unknown verdict refuses the day rather than the earlier
    // conforming pairing counting the run.
    const pair = streakPair(1, 1, 1, 10);
    const laterMerge = shellEvent({ line: 3, atIso: inDayIso(15 * 60), pullRequest: pair.pullRequest, headOid: streakHead(7) });
    const laterFleetRow = fleetResult({ key: mergeKey(DIGEST, pair.pullRequest, streakHead(7).slice(0, 12)), recordedAtIso: inDayIso(14 * 60, 50) });
    const input = countedInputFor([pair], {
      shell: { events: [pair.shellEvent, laterMerge], unknownLines: 0 },
      fleet: { results: [pair.fleetResult, laterFleetRow], entries: [pair.fleetEntry, fleetEntry({ pullRequest: pair.pullRequest, headOid: streakHead(7) })] },
      headMovesIncompleteFor: [pair.pullRequest],
    });
    expect(countedRunsForDay(input)).toEqual(refusedWith('head-moves-incomplete'));
  });

  it('a nonconforming S6 run (no gate result) is not counted', () => {
    const broken = streakPair(1, 1, 1, 10, { journal: [] });
    expect(countedRunsForDay(countedInputFor([broken]))).toEqual({ ok: true, countedRuns: 0, countedTier2: 0 });
  });

  it('refuses a batch-marked Tier 2 merge with tier2-batch-merge', () => {
    const batch = streakPair(9, 2, 2, 12);
    const openedEvent = shellEvent({ line: 1, atIso: inDayIso(9 * 60), kind: 'batch', outcome: 'opened', pullRequest: batch.pullRequest, headOid: streakHead(9), detailCode: 'none' });
    const batchedShell = { ...batch.shellEvent, detailCode: 'batch-member' };
    const input = countedInputFor([batch], {
      shell: { events: [openedEvent, batchedShell], unknownLines: 0 },
    });
    expect(countedRunsForDay(input)).toEqual(refusedWith('tier2-batch-merge'));
  });

  it('refuses a null-head shell merge event with unpaired-log before the set walk runs', () => {
    const pair = streakPair(1, 1, 1, 10);
    const input = countedInputFor([pair], {
      shell: { events: [pair.shellEvent, shellEvent({ line: 2, atIso: inDayIso(11 * 60), headOid: null })], unknownLines: 0 },
    });
    expect(countedRunsForDay(input)).toEqual(refusedWith('unpaired-log'));
  });

  it('refuses a shell merge on the day with no conducted run with unpaired-log', () => {
    const pair = streakPair(1, 1, 1, 10);
    const input = countedInputFor([pair], { runs: [] });
    expect(countedRunsForDay(input)).toEqual(refusedWith('unpaired-log'));
  });

  it('refuses a shell merge unmatched by a fleet would-merge row with unmatched-record', () => {
    const pair = streakPair(1, 1, 1, 10);
    const input = countedInputFor([pair], { fleet: { results: [], entries: [pair.fleetEntry] } });
    expect(countedRunsForDay(input)).toEqual(refusedWith('unmatched-record'));
  });

  it('refuses a fleet would-merge recorded at a later whole second than the shell merge with unmatched-record', () => {
    const pair = streakPair(1, 1, 1, 10);
    const lateResult = fleetResult({ key: mergeKey(DIGEST, pair.pullRequest, streakHead(1).slice(0, 12)), recordedAtIso: inDayIso(10 * 60, 1) });
    const input = countedInputFor([pair], { fleet: { results: [lateResult], entries: [pair.fleetEntry] } });
    expect(countedRunsForDay(input)).toEqual(refusedWith('unmatched-record'));
  });

  it('refuses an incomplete shell log with shell-events-incomplete', () => {
    const pair = streakPair(1, 1, 1, 10);
    const input = countedInputFor([pair], { shell: { events: [pair.shellEvent], unknownLines: 1 } });
    expect(countedRunsForDay(input)).toEqual(refusedWith('shell-events-incomplete'));
  });

  it('refuses a live fleet merge action on the day with live-action-in-shadow', () => {
    const pair = streakPair(1, 1, 1, 10);
    const liveResult = fleetResult({ key: mergeKey(DIGEST, pair.pullRequest, streakHead(1).slice(0, 12)), outcome: 'merged' });
    const input = countedInputFor([pair], { fleet: { results: [liveResult], entries: [pair.fleetEntry] } });
    expect(countedRunsForDay(input)).toEqual(refusedWith('live-action-in-shadow'));
  });

  it('refuses an unresolved and an ambiguous fleet head', () => {
    const pair = streakPair(1, 1, 1, 10);
    const unresolved = fleetResult({ key: mergeKey(DIGEST, 99, '999999999999') });
    expect(countedRunsForDay(countedInputFor([pair], { fleet: { results: [pair.fleetResult, unresolved], entries: [pair.fleetEntry] } })))
      .toEqual(refusedWith('fleet-head-unresolved'));
    const sharedPrefix = streakHead(2).slice(0, 12);
    const headX = `${sharedPrefix}${'1'.repeat(28)}`;
    const headY = `${sharedPrefix}${'2'.repeat(28)}`;
    const ambiguous = streakPair(2, 1, 2, 11);
    const ambiguousInput = countedInputFor([pair, ambiguous], {
      fleet: {
        results: [pair.fleetResult, ambiguous.fleetResult],
        entries: [pair.fleetEntry, fleetEntry({ pullRequest: ambiguous.pullRequest, headOid: headX }), fleetEntry({ pullRequest: ambiguous.pullRequest, headOid: headY })],
      },
    });
    expect(countedRunsForDay(ambiguousInput)).toEqual(refusedWith('fleet-head-ambiguous'));
  });

  it('refuses a conflicting duplicate runId with duplicate-run-conflict and two runs on one PR with pull-request-has-several-runs', () => {
    const pair = streakPair(1, 1, 1, 10);
    const conflicting = { ...pair.run, headOid: streakHead(50) };
    expect(countedRunsForDay(countedInputFor([pair], { runs: [pair.run, conflicting] })))
      .toEqual(refusedWith('duplicate-run-conflict'));
    const secondRunOnSamePr = conformingStreakRun(7, 1, pair.pullRequest, streakHead(7), inDayIso(10 * 60));
    expect(countedRunsForDay(countedInputFor([pair], { runs: [pair.run, secondRunOnSamePr] })))
      .toEqual(refusedWith('pull-request-has-several-runs'));
  });

  it('refuses an unlinked run whose pull request is in headMovesIncompleteFor with head-moves-incomplete', () => {
    const pair = streakPair(1, 1, 1, 10);
    const otherHead = streakHead(77);
    const unlinkedRun = conformingStreakRun(1, 1, pair.pullRequest, otherHead, inDayIso(10 * 60));
    const input = countedInputFor([pair], { runs: [unlinkedRun], headMovesIncompleteFor: [pair.pullRequest] });
    expect(countedRunsForDay(input)).toEqual(refusedWith('head-moves-incomplete'));
  });

  it('refuses a run with an absent or unknown tier with invalid-tier', () => {
    const pair = streakPair(1, 1, 1, 10);
    const withoutTier: Record<string, unknown> = { ...pair.run };
    delete withoutTier.tier;
    expect(countedRunsForDay(countedInputFor([pair], { runs: [withoutTier] }))).toEqual(refusedWith('invalid-tier'));
    expect(countedRunsForDay(countedInputFor([pair], { runs: [{ ...pair.run, tier: 3 }] }))).toEqual(refusedWith('invalid-tier'));
  });

  it('refuses a run with a missing or unreadable journal with unreadable-journal', () => {
    const pair = streakPair(1, 1, 1, 10);
    const withoutJournal: Record<string, unknown> = { ...pair.run };
    delete withoutJournal.journal;
    expect(countedRunsForDay(countedInputFor([pair], { runs: [withoutJournal] }))).toEqual(refusedWith('unreadable-journal'));
    expect(countedRunsForDay(countedInputFor([pair], { runs: [{ ...pair.run, journal: [{ kind: 'intent' }] }] })))
      .toEqual(refusedWith('unreadable-journal'));
  });

  it('refuses a run with missing or malformed reviewReceipts with missing-review-receipts', () => {
    const pair = streakPair(1, 1, 1, 10);
    const withoutReceipts: Record<string, unknown> = { ...pair.run };
    delete withoutReceipts.reviewReceipts;
    expect(countedRunsForDay(countedInputFor([pair], { runs: [withoutReceipts] }))).toEqual(refusedWith('missing-review-receipts'));
    expect(countedRunsForDay(countedInputFor([pair], { runs: [{ ...pair.run, reviewReceipts: [{ kind: 'code-review' }] }] })))
      .toEqual(refusedWith('missing-review-receipts'));
  });

  it('refuses hostile and malformed inputs with invalid-input', () => {
    for (const hostile of [null, undefined, 5, 'day', true, [], { length: 1, 0: {} }]) {
      expect(countedRunsForDay(hostile)).toEqual(refusedWith('invalid-input'));
    }
    const pair = streakPair(1, 1, 1, 10);
    const base = countedInputFor([pair]);
    expect(countedRunsForDay({ ...base, day: 'not-a-day' })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, repoDigest: 'zz' })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, extra: 1 })).toEqual(refusedWith('invalid-input'));
    const missingRuns = { ...base };
    delete missingRuns.runs;
    expect(countedRunsForDay(missingRuns)).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, runs: 'not-a-list' })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, shell: { events: 'no', unknownLines: 0 } })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, fleet: { results: [], entries: {} } })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, headMoves: [null] })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, headMovesIncompleteFor: [0] })).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay({ ...base, shell: { events: [shellEvent()], unknownLines: 'none' } })).toEqual(refusedWith('invalid-input'));
    // An array hole in runs is refused before any element is read.
    const holed = [pair.run];
    holed.length = 3;
    expect(countedRunsForDay({ ...base, runs: holed })).toEqual(refusedWith('invalid-input'));
    // An over-cap runs list is refused from its length alone.
    expect(countedRunsForDay({ ...base, runs: new Array(2001).fill(pair.run) })).toEqual(refusedWith('invalid-input'));
    // A getter on the root never runs and is refused.
    let calls = 0;
    const getterInput: Record<string, unknown> = { ...base };
    delete getterInput.day;
    Object.defineProperty(getterInput, 'day', {
      enumerable: true,
      get() {
        calls += 1;
        return DAY;
      },
    });
    expect(countedRunsForDay(getterInput)).toEqual(refusedWith('invalid-input'));
    expect(calls).toBe(0);
    // A revoked Proxy and a throwing-trap Proxy are refused.
    const { proxy, revoke } = Proxy.revocable(base, {});
    revoke();
    expect(countedRunsForDay(proxy)).toEqual(refusedWith('invalid-input'));
    expect(countedRunsForDay(new Proxy(base, { ownKeys() { throw new Error('ownKeys trap'); } }))).toEqual(refusedWith('invalid-input'));
    // Prototype-polluting own keys are refused.
    const pollutedInput = { ...base };
    Object.defineProperty(pollutedInput, 'constructor', { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
    expect(countedRunsForDay(pollutedInput)).toEqual(refusedWith('invalid-input'));
    const protoInput = { ...base };
    Object.defineProperty(protoInput, '__proto__', { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
    expect(countedRunsForDay(protoInput)).toEqual(refusedWith('invalid-input'));
    const prototypeInput = { ...base };
    Object.defineProperty(prototypeInput, 'prototype', { value: { polluted: true }, enumerable: true, writable: true, configurable: true });
    expect(countedRunsForDay(prototypeInput)).toEqual(refusedWith('invalid-input'));
  });

  it('a transparent Proxy over a valid input yields exactly the plain data result with no get trap run', () => {
    const pairs = [streakPair(1, 1, 1, 10), streakPair(2, 2, 2, 11)];
    let gets = 0;
    const proxied = new Proxy(countedInputFor(pairs), {
      get(target, property, receiver) {
        gets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(countedRunsForDay(proxied)).toEqual({ ok: true, countedRuns: 2, countedTier2: 1 });
    expect(gets).toBe(0);
  });

  it('groups headMoves once, not per run: 2,000 runs and 200,000 head moves are read in a single scan and match the per-run path', () => {
    const pairs: StreakPair[] = [];
    const headMoves: Record<string, unknown>[] = [];
    for (let n = 1; n <= 2_000; n += 1) {
      const tier: 1 | 2 = n <= 1_500 ? 1 : 2;
      pairs.push(streakPair(n, tier, n, 10 + (n % 8)));
      const pullRequest = 4000 + n;
      let fromN = 500_000 + n * 100;
      for (let hop = 0; hop < 100; hop += 1) {
        headMoves.push({
          pullRequest,
          fromHeadOid: streakHead(fromN),
          toHeadOid: streakHead(fromN + 1),
          atIso: `${DAY}T${String(Math.floor(hop / 60)).padStart(2, '0')}:${String(hop % 60).padStart(2, '0')}:00.000Z`,
        });
        fromN += 1;
      }
    }
    let descriptorCalls = 0;
    let ownKeysCalls = 0;
    const instrumentedMoves = new Proxy(headMoves, {
      getOwnPropertyDescriptor(target, property) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      get() {
        throw new Error('a get trap must never run on headMoves');
      },
    });
    const input = countedInputFor(pairs, { headMoves: instrumentedMoves });
    expect(countedRunsForDay(input)).toEqual({ ok: true, countedRuns: 2_000, countedTier2: 500 });
    // One length descriptor plus one descriptor per element: the 200,000-move
    // list was read and grouped exactly once, never once per run.
    expect(ownKeysCalls).toBe(1);
    expect(descriptorCalls).toBe(headMoves.length + 1);
  }, 120_000);
});
