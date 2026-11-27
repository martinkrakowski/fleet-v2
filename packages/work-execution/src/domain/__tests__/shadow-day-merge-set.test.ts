import { describe, expect, it } from 'vitest';

import { buildMergeKey, type MergeKeyOneWayAction } from '../lane-run-keys.js';
import { evaluateShadowMergeSet, SHADOW_DAY_BOUNDARY_GRACE_MS } from '../shadow-day-merge-set.js';

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
