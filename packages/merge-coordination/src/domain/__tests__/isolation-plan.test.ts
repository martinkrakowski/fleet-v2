import { describe, expect, it } from 'vitest';

import { planIsolationSplit } from '../isolation-plan.js';
import { decideIsolationStep } from '../isolation-plan.js';
import type { IsolationDecision } from '../isolation-plan.js';
import type { GateOutcomeInput } from '../failure-classification.js';
import type { BatchMemberRecord } from '../entities/BatchRecord.js';

/** Build one batch member with a deterministic 40-hex head sha. */
function member(prNumber: number, hex: string): BatchMemberRecord {
  return { prNumber, headSha: hex.repeat(40) };
}

/** Members 1..count in order, frozen so no planner can mutate them. */
function members(count: number): readonly BatchMemberRecord[] {
  const hex = 'abcdefghij';
  return Object.freeze(Array.from({ length: count }, (_, index) => member(index + 1, hex[index])));
}

/** A gate outcome over the given members. */
function outcome(
  result: GateOutcomeInput['result'],
  list: readonly BatchMemberRecord[],
  retriesUsed = 0,
  maxRetries = 2,
): GateOutcomeInput {
  return { result, members: list, infrastructureRetriesUsed: retriesUsed, maxInfrastructureRetries: maxRetries };
}

describe('planIsolationSplit', () => {
  it('splits four members into [1,2] and [3,4] on the right bases', () => {
    const result = planIsolationSplit(members(4));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.first.members.map((m) => m.prNumber)).toEqual([1, 2]);
      expect(result.value.first.base).toBe('current-base');
      expect(result.value.second.members.map((m) => m.prNumber)).toEqual([3, 4]);
      expect(result.value.second.base).toBe('after-first-half');
    }
  });

  it('splits three members into two and one, keeping order', () => {
    const result = planIsolationSplit(members(3));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.first.members.map((m) => m.prNumber)).toEqual([1, 2]);
      expect(result.value.second.members.map((m) => m.prNumber)).toEqual([3]);
    }
  });

  it('splits two members into one and one', () => {
    const result = planIsolationSplit(members(2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.first.members.map((m) => m.prNumber)).toEqual([1]);
      expect(result.value.second.members.map((m) => m.prNumber)).toEqual([2]);
    }
  });

  it('refuses a single member: it is already isolated', () => {
    const result = planIsolationSplit(members(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('already isolated');
    }
  });

  it('refuses a repeated pull request number', () => {
    const result = planIsolationSplit([member(3, 'c'), member(3, 'c')]);
    expect(result.ok).toBe(false);
  });

  it('refuses a malformed member with prNumber 0', () => {
    const result = planIsolationSplit([
      { prNumber: 0, headSha: 'a'.repeat(40) },
      member(2, 'b'),
    ]);
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
  });

  it('refuses a malformed member with invalid headSha', () => {
    const result = planIsolationSplit([
      member(1, 'a'),
      { prNumber: 2, headSha: '' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'batch member headSha must be 40 lower-case hex characters' });
  });

  it('accepts a frozen input', () => {
    const result = planIsolationSplit(members(2));
    expect(result.ok).toBe(true);
  });

  it('never puts the second half on the current base, for sizes 2 to 8', () => {
    for (let size = 2; size <= 8; size += 1) {
      const result = planIsolationSplit(members(size));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.second.base).toBe('after-first-half');
      }
    }
  });
});

describe('decideIsolationStep', () => {
  it('promotes all members on a passed gate', () => {
    const result = decideIsolationStep(outcome('passed', members(4)));
    expect(result).toEqual({ ok: true, value: { action: 'promote', members: members(4) } });
  });

  it('retries the same members on an infrastructure failure', () => {
    const result = decideIsolationStep(outcome('infrastructure-failure', members(4)));
    expect(result).toEqual({ ok: true, value: { action: 'retry', members: members(4) } });
  });

  it('halts without blaming any PR once retries are exhausted', () => {
    const result = decideIsolationStep(outcome('infrastructure-failure', members(4), 2, 2));
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'halt') {
      expect(result.value.reason).toContain('exhausted');
      expect(result.value.reason).not.toMatch(/pull request \d+/);
    }
  });

  it('blocks the one failed member with a non-empty reason naming it', () => {
    const single: readonly BatchMemberRecord[] = [member(7, 'e')];
    const result = decideIsolationStep(outcome('failed', single));
    expect(result).toEqual({
      ok: true,
      value: {
        action: 'block',
        prNumber: 7,
        headSha: 'e'.repeat(40),
        reason: 'pull request 7 at head eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee failed the gate; it stays available for remediation',
      },
    });
  });

  it('splits a failed multi-member batch', () => {
    const result = decideIsolationStep(outcome('failed', members(4)));
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'split') {
      expect(result.value.split.first.members.map((m) => m.prNumber)).toEqual([1, 2]);
      expect(result.value.split.second.base).toBe('after-first-half');
    }
  });

  it('passes a refusal through', () => {
    const result = decideIsolationStep(outcome('passed', []));
    expect(result.ok).toBe(false);
  });

  it('refuses a failed gate with a malformed member { prNumber: 0, headSha: "" } rather than blocking an invalid PR', () => {
    const result = decideIsolationStep({
      result: 'failed',
      members: [{ prNumber: 0, headSha: '' }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
  });

  it('refuses a failed gate with an invalid headSha', () => {
    const result = decideIsolationStep({
      result: 'failed',
      members: [{ prNumber: 1, headSha: 'bad-sha' }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member headSha must be 40 lower-case hex characters' });
  });

  it('refuses a passed gate with a malformed member', () => {
    const result = decideIsolationStep({
      result: 'passed',
      members: [{ prNumber: 0, headSha: 'a'.repeat(40) }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
  });

  it('refuses a multi-member batch containing a malformed member', () => {
    const result = decideIsolationStep({
      result: 'failed',
      members: [member(1, 'a'), { prNumber: 2, headSha: '' }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member headSha must be 40 lower-case hex characters' });
  });
});

describe('plan §5 worked example', () => {
  /** Decide one run's gate result by its member numbers: a run containing
   * both 3 and 4 fails; run 3 alone fails; everything else passes. */
  function runResult(run: readonly BatchMemberRecord[]): GateOutcomeInput['result'] {
    const numbers = run.map((m) => m.prNumber);
    if (numbers.includes(3) && numbers.includes(4)) {
      return 'failed';
    }
    if (numbers.length === 1 && numbers[0] === 3) {
      return 'failed';
    }
    return 'passed';
  }

  /** Drive the pure §5 loop from one member list to a sequence of decisions. */
  function walk(start: readonly BatchMemberRecord[]): IsolationDecision[] {
    const decisions: IsolationDecision[] = [];
    let queue: readonly { run: readonly BatchMemberRecord[]; base: 'current-base' | 'after-first-half' }[] = [
      { run: start, base: 'current-base' },
    ];
    while (queue.length > 0) {
      const current = queue[0];
      queue = queue.slice(1);
      const step = decideIsolationStep(outcome(runResult(current.run), current.run));
      if (!step.ok) {
        decisions.push({ action: 'halt', reason: step.reason });
        break;
      }
      decisions.push(step.value);
      if (step.value.action === 'split') {
        queue = [
          { run: step.value.split.first.members, base: step.value.split.first.base },
          { run: step.value.split.second.members, base: step.value.split.second.base },
          ...queue,
        ];
      }
    }
    return decisions;
  }

  it('splits, promotes [1,2], splits [3,4], blocks PR 3 and promotes [4]', () => {
    const decisions = walk(members(4));
    expect(decisions).toHaveLength(5);
    expect(decisions[0].action).toBe('split');
    expect(decisions[1]).toEqual({ action: 'promote', members: members(2) });
    expect(decisions[2].action).toBe('split');
    if (decisions[2].action === 'split') {
      expect(decisions[2].split.second.base).toBe('after-first-half');
    }
    expect(decisions[3]).toEqual({
      action: 'block',
      prNumber: 3,
      headSha: 'c'.repeat(40),
      reason: 'pull request 3 at head cccccccccccccccccccccccccccccccccccccccc failed the gate; it stays available for remediation',
    });
    expect(decisions[4]).toEqual({ action: 'promote', members: [member(4, 'd')] });
  });

  it('never blocks a good PR; promotes run 1,2 before 4', () => {
    const decisions = walk(members(4));
    const blocked = decisions.filter((d): d is Extract<IsolationDecision, { action: 'block' }> => d.action === 'block');
    expect(blocked.map((d) => d.prNumber)).toEqual([3]);
    const promoted = decisions.filter((d): d is Extract<IsolationDecision, { action: 'promote' }> => d.action === 'promote');
    expect(promoted.map((d) => d.members.map((m) => m.prNumber))).toEqual([[1, 2], [4]]);
  });

  it('retries, and never splits, on an infrastructure failure of four members', () => {
    const decisions: IsolationDecision[] = [];
    const step = decideIsolationStep(outcome('infrastructure-failure', members(4)));
    expect(step.ok).toBe(true);
    if (step.ok) {
      decisions.push(step.value);
    }
    expect(decisions).toEqual([{ action: 'retry', members: members(4) }]);
    expect(decisions.some((d) => d.action === 'split')).toBe(false);
  });
});
