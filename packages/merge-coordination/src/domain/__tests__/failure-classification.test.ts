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

  it('refuses a malformed member such as { prNumber: 0, headSha: "" }', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [{ prNumber: 0, headSha: '' }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
  });

  it('refuses a member with prNumber 0', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [{ prNumber: 0, headSha: 'a'.repeat(40) }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
  });

  it('refuses a member with a negative prNumber', () => {
    const result = classifyGateOutcome({
      result: 'passed',
      members: [{ prNumber: -1, headSha: 'a'.repeat(40) }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
  });

  it('refuses a member with an empty headSha', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [{ prNumber: 1, headSha: '' }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member headSha must be 40 lower-case hex characters' });
  });

  it('refuses a member with an invalid headSha', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [{ prNumber: 1, headSha: 'not-a-valid-sha' }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member headSha must be 40 lower-case hex characters' });
  });

  it('refuses when one member in a multi-member batch is malformed', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [member(1, 'a'), { prNumber: 0, headSha: 'b'.repeat(40) }],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'batch member prNumber must be a positive integer' });
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

  it('refuses a repeated pull request on a passed outcome', () => {
    const result = classifyGateOutcome({
      result: 'passed',
      members: [member(1, 'a'), member(1, 'b')],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'gate outcome lists pull request 1 more than once' });
  });

  it('refuses a repeated pull request on a failed outcome', () => {
    const result = classifyGateOutcome({
      result: 'failed',
      members: [member(1, 'a'), member(1, 'b')],
      infrastructureRetriesUsed: 0,
      maxInfrastructureRetries: 2,
    });
    expect(result).toEqual({ ok: false, reason: 'gate outcome lists pull request 1 more than once' });
  });

  it('refuses null input without throwing', () => {
    const result = classifyGateOutcome(null as unknown as GateOutcomeInput);
    expect(result).toEqual({ ok: false, reason: 'gate outcome must be a plain object' });
  });

  it('refuses undefined input without throwing', () => {
    const result = classifyGateOutcome(undefined as unknown as GateOutcomeInput);
    expect(result).toEqual({ ok: false, reason: 'gate outcome must be a plain object' });
  });

  it('refuses members null', () => {
    const result = classifyGateOutcome({ members: null } as unknown as GateOutcomeInput);
    expect(result).toEqual({ ok: false, reason: 'gate outcome members must be an array' });
  });

  it('refuses members undefined', () => {
    const result = classifyGateOutcome({} as unknown as GateOutcomeInput);
    expect(result).toEqual({ ok: false, reason: 'gate outcome members must be an array' });
  });

  it('refuses members a string', () => {
    const result = classifyGateOutcome({ members: 'x' } as unknown as GateOutcomeInput);
    expect(result).toEqual({ ok: false, reason: 'gate outcome members must be an array' });
  });
});
