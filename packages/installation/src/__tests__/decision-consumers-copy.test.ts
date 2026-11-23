import { describe, expect, it } from 'vitest';

import { copyDecisionConsumers, copyDecisions } from '../decision-consumers.js';
import type { DecisionConsumers, DecisionsSectionV2 } from '../types.js';

/** Cast without narrowing checks: the unit under test re-reads every key itself. */
const asConsumers = (value: unknown): DecisionConsumers =>
  value as DecisionConsumers;
const asDecisions = (value: unknown): DecisionsSectionV2 =>
  value as DecisionsSectionV2;

describe('copyDecisionConsumers', () => {
  it('omits absent consumer keys and unknown top-level keys', () => {
    const out = copyDecisionConsumers(
      asConsumers({ 'no-such-consumer': {} } as unknown as Record<string, never>),
    );
    expect(out).toEqual({});
    // An empty-but-valid input stays empty: no key is invented.
    expect(copyDecisionConsumers(asConsumers({}))).toEqual({});
  });

  it('omits non-plain-record consumer entries and never invokes getters', () => {
    let getterRuns = 0;
    const source = asConsumers({
      'knowledge-ranking': undefined,
      'claim-triage': null,
      'merge-veto': [],
      // A consumer entry on a custom prototype is not a plain record.
      ...(Object.create({ minConfidence: 0.5 }) as Record<string, never>),
      get broken(): never {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
    } as unknown as DecisionConsumers);
    expect(copyDecisionConsumers(source)).toEqual({});
    expect(getterRuns).toBe(0);
  });

  it('omits unknown keys and getters inside consumer settings while preserving empty plain blocks', () => {
    const source = asConsumers({
      'knowledge-ranking': JSON.parse(
        '{"__proto__":{"polluted":true},"minConfidence":0.5,"extra":1}',
      ),
      'claim-triage': {},
      // A settings getter is never invoked and its key omitted.
      get 'merge-veto'(): never {
        throw new Error('getter must never run');
      },
    } as unknown as DecisionConsumers);
    const out = copyDecisionConsumers(source) as Record<string, unknown>;
    expect(out).toEqual({
      'knowledge-ranking': { minConfidence: 0.5 },
      'claim-triage': {},
    });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(out, 'merge-veto')).toBe(false);
    // The settings blocks are fresh objects, not the source references.
    expect((out['knowledge-ranking'] as object)).not.toBe(
      source['knowledge-ranking'],
    );
  });

  it('copies the declared settings keys only, per consumer', () => {
    const source = asConsumers({
      'knowledge-ranking': { minConfidence: 0.9, monthlyBudgetUsd: 5, extra: 1 },
      'claim-triage': {
        minConfidence: 0.8,
        monthlyBudgetUsd: 6,
        acknowledgeCandidateClaimsLeaveHost: true,
        extra: 2,
      },
      'merge-veto': {
        monthlyBudgetUsd: 7,
        acknowledgePullRequestTitleAndPathsLeaveHost: true,
        extra: 3,
      },
    } as unknown as DecisionConsumers);
    expect(copyDecisionConsumers(source)).toEqual({
      'knowledge-ranking': { minConfidence: 0.9, monthlyBudgetUsd: 5 },
      'claim-triage': {
        minConfidence: 0.8,
        monthlyBudgetUsd: 6,
        acknowledgeCandidateClaimsLeaveHost: true,
      },
      'merge-veto': {
        monthlyBudgetUsd: 7,
        acknowledgePullRequestTitleAndPathsLeaveHost: true,
      },
    });
  });
});

describe('copyDecisions', () => {
  it('copies provider none with only provider key', () => {
    let getterRuns = 0;
    const out = copyDecisions(
      asDecisions({
        provider: 'none',
        extra: 'must not survive',
        get expensive(): never {
          getterRuns += 1;
          throw new Error('getter must never run');
        },
      } as unknown as Record<string, unknown>),
    );
    expect(out).toEqual({ provider: 'none' });
    expect(getterRuns).toBe(0);
  });

  it('copies provider answer-file omitting absent keys, unknown keys, and getters', () => {
    const out = copyDecisions(
      asDecisions({
        provider: 'answer-file',
        answerFile: '/tmp/answers.json',
        consumers: { 'knowledge-ranking': { minConfidence: 0.5 } },
        unknown: 'must not survive',
        get providerless(): never {
          throw new Error('getter must never run');
        },
      } as unknown as Record<string, unknown>),
    );
    expect(out).toEqual({
      provider: 'answer-file',
      answerFile: '/tmp/answers.json',
      consumers: { 'knowledge-ranking': { minConfidence: 0.5 } },
    });
  });

  it('copies provider jev, shallow-copies disabledProjects array, and never runs getters', () => {
    let getterRuns = 0;
    const disabledProjects = ['alpha', 'beta'];
    const source = {
      provider: 'jev',
      model: 'example-model',
      disabledProjects,
      consumers: { 'merge-veto': { monthlyBudgetUsd: 3 } },
      unknown: 'must not survive',
      get consumersGettersOnly(): never {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
    } as unknown as Record<string, unknown>;
    const out = copyDecisions(asDecisions(source)) as unknown as Record<
      string,
      unknown
    >;

    expect(out).toEqual({
      provider: 'jev',
      model: 'example-model',
      disabledProjects: ['alpha', 'beta'],
      consumers: { 'merge-veto': { monthlyBudgetUsd: 3 } },
    });
    expect(getterRuns).toBe(0);
    expect(Object.hasOwn(out, 'unknown')).toBe(false);

    // disabledProjects is a fresh shallow copy either way.
    expect(out.disabledProjects).not.toBe(disabledProjects);
    (out.disabledProjects as string[]).push('gamma');
    expect(disabledProjects).toEqual(['alpha', 'beta']);
    disabledProjects.push('delta');
    expect(out.disabledProjects).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('treats an accessor or absent provider as the jev branch without reading the getter', () => {
    let getterRuns = 0;
    const withThrowingProvider = {
      get provider(): never {
        getterRuns += 1;
        throw new Error('getter must never run');
      },
      disabledProjects: ['x'],
    } as unknown as Record<string, unknown>;
    expect(copyDecisions(asDecisions(withThrowingProvider))).toEqual({
      disabledProjects: ['x'],
    });
    expect(getterRuns).toBe(0);

    // Absent provider: default jev branch, no provider key invented.
    expect(copyDecisions(asDecisions({ disabledProjects: ['y'] }))).toEqual({
      disabledProjects: ['y'],
    });
  });

  it('rejects a constant or identity implementation through omission of undeclared keys', () => {
    const source = {
      provider: 'answer-file',
      answerFile: 'a',
      consumers: { 'claim-triage': { minConfidence: 0.1 } },
      poisoned: 'extra',
    } as unknown as Record<string, unknown>;
    // A constant return or identity pass-through would carry `poisoned`.
    expect(copyDecisions(asDecisions(source))).not.toHaveProperty('poisoned');
    expect(Object.keys(copyDecisions(asDecisions(source))).sort()).toEqual([
      'answerFile',
      'consumers',
      'provider',
    ]);
  });
});
