import { describe, expect, it } from 'vitest';

import { classifyGateOutcome } from '../failure-classification.js';
import type { GateOutcomeInput } from '../failure-classification.js';
import type { BatchMemberRecord } from '../entities/BatchRecord.js';

/** Build one batch member with a deterministic 40-hex head sha. */
function member(prNumber: number, hex: string): BatchMemberRecord {
  return { prNumber, headSha: hex.repeat(40) };
}

/** Four frozen members; the array must never be mutated by classification. */
const FOUR: readonly BatchMemberRecord[] = Object.freeze([
  member(1, 'a'),
  member(2, 'b'),
  member(3, 'c'),
  member(4, 'd'),
]);

/** A gate outcome against the four frozen members. */
function outcome(result: GateOutcomeInput['result'], retriesUsed = 0, maxRetries = 2): GateOutcomeInput {
  return { result, members: FOUR, infrastructureRetriesUsed: retriesUsed, maxInfrastructureRetries: maxRetries };
}

describe('classifyGateOutcome', () => {
  it('classifies a passed gate with one member', () => {
    const result = classifyGateOutcome({
      result: 'passed',
      members: [member(1, 'a')],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: true, value: { kind: 'passed' } });
  });

  it('classifies a passed gate with four members', () => {
    const result = classifyGateOutcome(outcome('passed'));
    expect(result).toEqual({ ok: true, value: { kind: 'passed' } });
  });

  it('retries the same candidate while retries remain', () => {
    const result = classifyGateOutcome(outcome('infrastructure-failure', 0, 2));
    expect(result).toEqual({ ok: true, value: { kind: 'infrastructure', action: 'retry-same-candidate' } });
  });

  it('reports retries exhausted once the budget is spent', () => {
    const result = classifyGateOutcome(outcome('infrastructure-failure', 2, 2));
    expect(result).toEqual({ ok: true, value: { kind: 'infrastructure', action: 'retries-exhausted' } });
  });

  it('never splits or blames a PR for an infrastructure failure', () => {
    const result = classifyGateOutcome(outcome('infrastructure-failure'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).not.toBe('batch-failure');
      expect(result.value.kind).not.toBe('member-failure');
    }
  });

  it('blames the one failed member with its pull request number', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [member(7, 'e')],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: true, value: { kind: 'member-failure', prNumber: 7 } });
  });

  it('classifies a failed gate on four members as a batch failure', () => {
    const result = classifyGateOutcome(outcome('failed'));
    expect(result).toEqual({ ok: true, value: { kind: 'batch-failure' } });
  });

  it('refuses an empty member list', () => {
    const result = classifyGateOutcome({ result: 'passed', members: [], infrastructureRetriesUsed: 0, maxInfrastructureRetries: 2 });
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown result string', () => {
    const result = classifyGateOutcome(outcome('exploded' as GateOutcomeInput['result']));
    expect(result).toEqual({ ok: false, reason: 'gate outcome result must be "passed", "failed" or "infrastructure-failure"' });
  });

  it('refuses a negative retries-used count', () => {
    const result = classifyGateOutcome(outcome('infrastructure-failure', -1, 2));
    expect(result.ok).toBe(false);
  });

  it('refuses a non-integer retries-used count', () => {
    const result = classifyGateOutcome(outcome('infrastructure-failure', 0.5, 2));
    expect(result.ok).toBe(false);
  });

  it('refuses a NaN max retry count', () => {
    const result = classifyGateOutcome(outcome('infrastructure-failure', 0, Number.NaN));
    expect(result.ok).toBe(false);
  });

  it('does not mutate the frozen member list', () => {
    classifyGateOutcome(outcome('failed'));
    expect(FOUR).toHaveLength(4);
    expect(Object.isFrozen(FOUR)).toBe(true);
  });
});
