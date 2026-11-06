import { describe, expect, it } from 'vitest';

import { deriveLaneHistory } from '../lane-history.js';
import type { LaneHistory, LaneHistoryResult } from '../lane-history.js';

const BASE_TIME = '2026-10-27T10:00:00.000Z';

function attempt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1',
    kind: 'initial',
    fixNumber: 1,
    priorAttemptId: null,
    state: 'collected',
    createdAtIso: BASE_TIME,
    artifacts: { headCommit: 'abcdef1234567' },
    seatSelection: null,
    runner: null,
    usage: null,
    ...overrides,
  };
}

function reading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: 'a1',
    outcome: 'found',
    review: [],
    ...overrides,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const findings: Record<string, unknown> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const key of ['blocker', 'major', 'minor', 'nit']) {
    if (overrides[key] !== undefined) {
      findings[key] = overrides[key];
    }
  }
  Object.assign(findings, overrides.findings ?? {});
  const row: Record<string, unknown> = {
    receiptId: 'ignored-receipt-id',
    kind: 'code-review',
    result: 'pass',
    findings,
    completedAtIso: '2026-10-27T11:00:00.000Z',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'findings') {
      row[key] = value;
    }
  }
  return row;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function historyOf(attempts: unknown, receipts: unknown): LaneHistory {
  const result = deriveLaneHistory(attempts, receipts);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('expected a history');
  }
  return result.history;
}

function expectedRefusal(attempts: unknown, receipts: unknown, reason: Extract<LaneHistoryResult, { ok: false }>['reason']): void {
  expect(deriveLaneHistory(attempts, receipts)).toEqual({ ok: false, reason });
}

describe('deriveLaneHistory', () => {
  it('orders attempts by time then id and keeps fix metadata', () => {
    const attempts = [
      attempt({ id: 'b', createdAtIso: '2026-10-27T10:00:01.000Z' }),
      attempt({ id: 'a', createdAtIso: '2026-10-27T10:00:01.000Z' }),
      attempt({ id: 'fix1', kind: 'fix', fixNumber: 2, priorAttemptId: 'a', createdAtIso: '2026-10-27T09:59:00.000Z' }),
    ];
    const history = historyOf(attempts, []);
    expect(history.attempts.map((entry) => entry.attemptId)).toEqual(['fix1', 'a', 'b']);
    expect(history.attempts[0]).toMatchObject({ kind: 'fix', fixNumber: 2, priorAttemptId: 'a' });
  });

  it('defaults a missing or undeclared stopReason to unknown and keeps declared ones', () => {
    const attempts = [
      attempt({ id: 'no-stop' }),
      attempt({ id: 'undeclared', stopReason: 'something-weird' }),
      attempt({ id: 'declared', stopReason: 'timeout' }),
    ];
    const history = historyOf(attempts, []);
    const byId = new Map(history.attempts.map((entry) => [entry.attemptId, entry]));
    expect(byId.get('no-stop')?.stopReason).toBe('unknown');
    expect(byId.get('undeclared')?.stopReason).toBe('unknown');
    expect(byId.get('declared')?.stopReason).toBe('timeout');
  });

  it('keeps absent usage as not-measured, unavailable as unavailable, and a null costUsd as null', () => {
    const attempts = [
      attempt({ id: 'absent' }),
      attempt({ id: 'unavail', usage: { source: 'unavailable' } }),
      attempt({ id: 'measured', usage: { source: 'opencode-db', costUsd: null, steps: 3 } }),
    ];
    const history = historyOf(attempts, []);
    const byId = new Map(history.attempts.map((entry) => [entry.attemptId, entry]));
    expect(byId.get('absent')?.usage).toEqual({ status: 'not-measured' });
    expect(byId.get('unavail')?.usage).toEqual({ status: 'unavailable' });
    expect(byId.get('measured')?.usage).toEqual({
      status: 'measured',
      costUsd: null,
      steps: 3,
      tokensInput: null,
      tokensOutput: null,
      runnerMinutes: null,
    });
  });

  it('keeps a plain seat role and model', () => {
    const attempts = [attempt({ id: 'a', seatSelection: { role: 'fix', model: 'gpt-4o' } })];
    const history = historyOf(attempts, []);
    expect(history.attempts[0].seatRole).toBe('fix');
    expect(history.attempts[0].model).toBe('gpt-4o');
  });

  it('replaces a secret-shaped model with null and never echoes it', () => {
    const secret = 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345';
    const attempts = [attempt({ id: 'a', seatSelection: { role: 'fix', model: secret } })];
    const history = historyOf(attempts, []);
    expect(history.attempts[0].model).toBeNull();
    expect(JSON.stringify(history)).not.toContain(secret);
  });

  it('keeps an attempt without a head in attempts and out of every head', () => {
    const attempts = [attempt({ id: 'a', artifacts: null }), attempt({ id: 'b' })];
    const history = historyOf(attempts, []);
    expect(history.attempts.map((entry) => entry.attemptId)).toEqual(['a', 'b']);
    expect(history.heads).toHaveLength(1);
    expect(history.heads[0].attemptIds).toEqual(['b']);
  });

  it('collects found review rounds in completion order with their finding counts', () => {
    const attempts = [attempt({ id: 'a' })];
    const receipts = [
      reading({
        attemptId: 'a',
        outcome: 'found',
        review: [
          reviewRow({
            kind: 'brief-check',
            result: 'fail',
            blocker: 1,
            major: 2,
            minor: 3,
            nit: 4,
            completedAtIso: '2026-10-27T12:00:00.000Z',
          }),
          reviewRow({ kind: 'code-review', result: 'pass', completedAtIso: '2026-10-27T11:30:00.000Z' }),
        ],
      }),
    ];
    const history = historyOf(attempts, receipts);
    expect(history.heads).toHaveLength(1);
    expect(history.heads[0].reviewStatus).toBe('read');
    expect(history.heads[0].rounds.map((round) => round.kind)).toEqual(['code-review', 'brief-check']);
    expect(history.heads[0].rounds[1]).toMatchObject({
      kind: 'brief-check',
      result: 'fail',
      blocker: 1,
      major: 2,
      minor: 3,
      nit: 4,
    });
  });

  it('reports unknown when a reading is unavailable, not none', () => {
    const attempts = [attempt({ id: 'a' })];
    const receipts = [reading({ attemptId: 'a', outcome: 'unavailable' })];
    const history = historyOf(attempts, receipts);
    expect(history.heads[0].reviewStatus).toBe('unknown');
  });

  it('reports unknown when an attempt has no reading', () => {
    const history = historyOf([attempt({ id: 'a' })], []);
    expect(history.heads[0].reviewStatus).toBe('unknown');
  });

  it('reports none when a reading carries an empty review list', () => {
    const attempts = [attempt({ id: 'a' })];
    const receipts = [reading({ attemptId: 'a', outcome: 'found', review: [] })];
    const history = historyOf(attempts, receipts);
    expect(history.heads[0].reviewStatus).toBe('none');
  });

  it('ignores readings for unknown attempt ids', () => {
    const attempts = [attempt({ id: 'a' })];
    const receipts = [reading({ attemptId: 'nope', outcome: 'found', review: [reviewRow()] })];
    const history = historyOf(attempts, receipts);
    expect(history.heads[0].reviewStatus).toBe('unknown');
  });

  it('works with deep-frozen input without mutating it', () => {
    const record = attempt({ id: 'a' });
    const attempts = deepFreeze([record]);
    const receipts = deepFreeze([reading({ attemptId: 'a', outcome: 'found', review: [reviewRow()] })]);
    const history = historyOf(attempts, receipts);
    expect(history.attempts).toHaveLength(1);
    expect(history.heads[0].reviewStatus).toBe('read');
    expect(attempts[0]).toEqual(record);
  });

  it('is deterministic across calls on the same input', () => {
    const attempts = [attempt({ id: 'a' }), attempt({ id: 'b' })];
    const receipts = [reading({ attemptId: 'a', outcome: 'found', review: [reviewRow()] })];
    expect(deriveLaneHistory(attempts, receipts)).toEqual(deriveLaneHistory(attempts, receipts));
  });

  it('never echoes a worktree path', () => {
    const attempts = [attempt({ id: 'a', worktreePath: '/mnt/secret/worktree' })];
    const history = historyOf(attempts, []);
    expect(JSON.stringify(history)).not.toContain('/mnt/secret/worktree');
  });

  describe('robustness refusals', () => {
    it('refuses null attempts', () => {
      expectedRefusal(null, [], 'invalid-input');
    });

    it('refuses a non-array attempts value', () => {
      expectedRefusal({}, [], 'invalid-input');
    });

    it('refuses a sparse attempts array', () => {
      const sparse: unknown[] = [];
      sparse[1] = attempt({ id: 'a' });
      expectedRefusal(sparse, [], 'invalid-input');
    });

    it('refuses a null attempt element', () => {
      expectedRefusal([null], [], 'invalid-input');
    });

    it('refuses an unknown attempt state', () => {
      expectedRefusal([attempt({ state: 'running-ish' })], [], 'invalid-input');
    });

    it('returns unreadable-input when a getter throws', () => {
      const record: Record<string, unknown> = { id: 'a', kind: 'initial', fixNumber: 1, createdAtIso: BASE_TIME, artifacts: null };
      Object.defineProperty(record, 'state', {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error('boom');
        },
      });
      expectedRefusal([record], [], 'unreadable-input');
    });

    it('refuses null receipts', () => {
      expectedRefusal([attempt()], null, 'invalid-input');
    });

    it('refuses a receipt whose review row kind is undeclared', () => {
      const receipts = [reading({ attemptId: 'a', outcome: 'found', review: [reviewRow({ kind: 'other' })] })];
      expectedRefusal([attempt({ id: 'a' })], receipts, 'invalid-input');
    });

    it('refuses a negative finding count', () => {
      const receipts = [reading({ attemptId: 'a', outcome: 'found', review: [reviewRow({ blocker: -1 })] })];
      expectedRefusal([attempt({ id: 'a' })], receipts, 'invalid-input');
    });
  });

  describe('size bounds', () => {
    it('refuses more than 500 attempts', () => {
      const many = Array.from({ length: 501 }, (_, index) => attempt({ id: 'a' + String(index) }));
      expectedRefusal(many, [], 'too-large');
    });

    it('refuses more than 100 review rows for one attempt', () => {
      const manyRows = Array.from({ length: 101 }, () =>
        reviewRow({ completedAtIso: '2026-10-27T10:00:00.000Z' }),
      );
      const receipts = [reading({ attemptId: 'a', outcome: 'found', review: manyRows })];
      expectedRefusal([attempt({ id: 'a' })], receipts, 'too-large');
    });
  });

  it('refuses a reading with no review array, whatever the outcome', () => {
    for (const outcome of ['found', 'none', 'unavailable']) {
      const bad = reading({ outcome });
      delete bad.review;
      expect(deriveLaneHistory([attempt()], [bad])).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('validates review rows of none and unavailable readings too', () => {
    for (const outcome of ['none', 'unavailable']) {
      const result = deriveLaneHistory([attempt()], [reading({ outcome, review: [reviewRow({ kind: 'other' })] })]);
      expect(result).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('drops an unknown or secret-shaped seat role and keeps a declared one', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const result = deriveLaneHistory(
      [attempt({ id: 'a', seatSelection: { role: secret } }), attempt({ id: 'b', createdAtIso: '2026-10-27T11:00:00.000Z', artifacts: null, seatSelection: { role: 'review' } })],
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.history.attempts.map((a) => a.seatRole)).toEqual([null, 'review']);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
