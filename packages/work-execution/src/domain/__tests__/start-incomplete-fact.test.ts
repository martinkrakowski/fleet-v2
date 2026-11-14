// The start-incomplete fact's pure readers and the crashed-start summary.
// Every read is a typed result that never throws; every refusal test also
// re-reads a valid fact afterwards, so a reader that always returns invalid
// fails these tests too.

import { describe, expect, it } from 'vitest';

import {
  crashedStartNoticeSummary,
  readStartIncompleteFact,
  readStartIncompleteFactList,
  startIncompleteReasonCode,
  type StartIncompleteFact,
} from '../start-incomplete-fact.js';

const FACT: StartIncompleteFact = {
  attemptId: 'attempt-example-1',
  runId: 'run-01JB0000000000000000000000',
  step: 'brief',
  reasonCode: 'brief-rejected',
  recordedAtIso: '2026-11-10T03:06:47.000Z',
};

function expectExactFactKeys(fact: StartIncompleteFact): void {
  expect(Object.keys(fact).sort()).toEqual([
    'attemptId',
    'reasonCode',
    'recordedAtIso',
    'runId',
    'step',
  ]);
}

describe('start-incomplete fact readers', () => {
  it('reads a brief-rejected fact as the closed code and drops any detail suffix', () => {
    const read = readStartIncompleteFact(FACT);
    expect(read).toEqual({ ok: true, fact: FACT });
    expectExactFactKeys((read as { ok: true; fact: StartIncompleteFact }).fact);
    expect(startIncompleteReasonCode('brief-rejected: worktreePath is required')).toBe('brief-rejected');
    // The same exact-key assertion must hold for a second fact with
    // `run-exists`, so no constant or identity shortcut can satisfy the body.
    const second = readStartIncompleteFact({
      ...FACT,
      step: 'run',
      reasonCode: 'run-exists',
    });
    expect(second).toEqual({
      ok: true,
      fact: { ...FACT, step: 'run', reasonCode: 'run-exists' },
    });
    expectExactFactKeys((second as { ok: true; fact: StartIncompleteFact }).fact);
  });

  it('refuses null as an invalid typed result', () => {
    expect(readStartIncompleteFact(null)).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });

  it('refuses undefined as an invalid typed result', () => {
    expect(readStartIncompleteFact(undefined)).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });

  it('refuses a non-array fact list as invalid', () => {
    expect(readStartIncompleteFactList('not an array')).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFactList({ 0: FACT, length: 1 })).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFactList([FACT])).toEqual({ ok: true, facts: [FACT] });
  });

  it('refuses an array hole in a fact list as invalid', () => {
    const sparse: StartIncompleteFact[] = [FACT];
    sparse.length = 2;
    expect(readStartIncompleteFactList(sparse)).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFactList([FACT])).toEqual({ ok: true, facts: [FACT] });
  });

  it('refuses a numeric step as invalid', () => {
    expect(readStartIncompleteFact({ ...FACT, step: 3 })).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });

  it('refuses a fact whose step is a getter without invoking the getter', () => {
    const calls: string[] = [];
    const input: Record<string, unknown> = { ...FACT };
    Object.defineProperty(input, 'step', {
      enumerable: true,
      get() {
        calls.push('step');
        return 'brief';
      },
    });
    expect(readStartIncompleteFact(input)).toEqual({ ok: false, code: 'invalid' });
    expect(calls).toEqual([]);
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });

  it('refuses a Proxy whose prototype is not a plain object', () => {
    const exoticTarget = Object.create(Object.create({}));
    Object.assign(exoticTarget, FACT);
    expect(readStartIncompleteFact(new Proxy(exoticTarget, {}))).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });

  it('refuses an array-like object without reading its length', () => {
    const reads: string[] = [];
    const arrayLike: Record<string, unknown> = {
      get length() {
        reads.push('length');
        return Number.MAX_SAFE_INTEGER;
      },
    };
    Object.defineProperty(arrayLike, '0', {
      enumerable: true,
      get() {
        reads.push('0');
        return FACT;
      },
    });
    expect(readStartIncompleteFactList(arrayLike)).toEqual({ ok: false, code: 'invalid' });
    expect(reads).toEqual([]);
    expect(readStartIncompleteFactList([FACT])).toEqual({ ok: true, facts: [FACT] });
  });

  it('refuses a fact that carries a __proto__ own key', () => {
    const polluted = JSON.parse(JSON.stringify(FACT)) as Record<string, unknown>;
    Object.defineProperty(polluted, '__proto__', { enumerable: true, value: { polluted: true } });
    expect(readStartIncompleteFact(polluted)).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });

  it('refuses an attempt id longer than 256 characters', () => {
    expect(
      readStartIncompleteFact({ ...FACT, attemptId: 'attempt-' + 'a'.repeat(256) }),
    ).toEqual({ ok: false, code: 'invalid' });
    expect(readStartIncompleteFact(FACT).ok).toBe(true);
  });
});

describe('crashedStartNoticeSummary', () => {
  it('builds a summary that names the step, the reason code, and the abandon command', () => {
    const summary = crashedStartNoticeSummary({ slotIndex: 0, attemptId: FACT.attemptId, fact: FACT });
    expect(summary).toBe(
      'A lane start crashed at step brief with reason brief-rejected and left capacity slot 0 held ' +
        'for attempt attempt-example-1. ' +
        'Resolve with conductor start --abandon --run-id run-01JB0000000000000000000000 ' +
        '--attempt-id attempt-example-1.',
    );
    expect(summary).not.toContain('/');
    expect(summary.split('\n')).toHaveLength(1);
  });

  it('returns the old summary when no fact was recorded', () => {
    expect(
      crashedStartNoticeSummary({ slotIndex: 3, attemptId: FACT.attemptId, fact: null }),
    ).toBe(`A lane start crashed and left capacity slot 3 held for attempt ${FACT.attemptId}.`);
    expect(
      crashedStartNoticeSummary({ slotIndex: null, attemptId: FACT.attemptId, fact: null }),
    ).toBe(`A lane start crashed and left a capacity slot held for attempt ${FACT.attemptId}.`);
  });
});

describe('startIncompleteReasonCode', () => {
  it('returns null for a reason that is not a closed code', () => {
    expect(startIncompleteReasonCode('worktreePath is required')).toBeNull();
    expect(startIncompleteReasonCode('brief-rejected:worktreePath is required')).toBeNull();
    expect(startIncompleteReasonCode('')).toBeNull();
    expect(startIncompleteReasonCode('brief-rejected: worktreePath is required')).toBe('brief-rejected');
  });
});
