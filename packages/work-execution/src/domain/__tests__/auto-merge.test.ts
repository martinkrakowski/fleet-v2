import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_REASONS,
  AUTO_MERGE_ROUTE_RULE,
  AUTO_MERGE_DECISION_PREFIX,
  AUTO_MERGE_REVISION_PATTERN,
  AUTO_MERGE_HEAD_PATTERN,
  AUTHORIZED_BY_PATTERN,
  autoMergeActionId,
  autoMergeForgeEntryPrefix,
  autoMergeFirstLookEntryId,
  autoMergeRoutingKey,
  autoMergeDecisionRevision,
  readAutoMergeSettingsAnswer,
  autoMergeBlockersOf,
  isCiPendingOnly,
  autoMergeDoorsOf,
  autoMergeIneligibility,
  type AutoMergeReason,
} from '../auto-merge.js';

describe('AUTO_MERGE_ROUTE_RULE', () => {
  it('maps every reason to a route rule', () => {
    for (const reason of AUTO_MERGE_REASONS) {
      expect(AUTO_MERGE_ROUTE_RULE[reason]).toBeDefined();
    }
  });

  it('declares unique reasons', () => {
    expect(new Set(AUTO_MERGE_REASONS).size).toBe(AUTO_MERGE_REASONS.length);
  });

  it('pins forge-refused as owner-question and the three second-look reasons as on-blocked', () => {
    expect(AUTO_MERGE_ROUTE_RULE['forge-refused']).toBe('owner-question');
    expect(AUTO_MERGE_ROUTE_RULE['gate-not-passed']).toBe('on-blocked');
    expect(AUTO_MERGE_ROUTE_RULE['acceptance-blocked']).toBe('on-blocked');
    expect(AUTO_MERGE_ROUTE_RULE['ci-pending-second-look']).toBe('on-blocked');
  });

  it('keeps owner-question reserved for forge-refused alone', () => {
    const ownerQuestionReasons: AutoMergeReason[] = AUTO_MERGE_REASONS.filter(
      (reason) => AUTO_MERGE_ROUTE_RULE[reason] === 'owner-question',
    );
    expect(ownerQuestionReasons).toEqual(['forge-refused']);
  });
});

describe('readAutoMergeSettingsAnswer', () => {
  const validEnabled = {
    outcome: 'read',
    enabled: true,
    allowHighRisk: true,
    onBlocked: 'hold',
    revision: '0123456789ab',
    forgeMode: 'github',
  } as const;

  it('returns off when enabled is false whatever the rest says', () => {
    const answer = {
      outcome: 'read',
      enabled: false,
      allowHighRisk: true,
      onBlocked: 'hold',
      revision: 'abc',
      forgeMode: 'none',
    } as const;
    expect(readAutoMergeSettingsAnswer(answer)).toEqual({ kind: 'off' });
  });

  it('returns on for a valid enabled block', () => {
    expect(readAutoMergeSettingsAnswer(validEnabled)).toEqual({
      kind: 'on',
      settings: {
        allowHighRisk: true,
        onBlocked: 'hold',
        revision: '0123456789ab',
        forgeMode: 'github',
      },
    });
  });

  it('returns unreadable naming each malformed field of an enabled block', () => {
    expect(readAutoMergeSettingsAnswer({ ...validEnabled, allowHighRisk: 'yes' })).toEqual({
      kind: 'unreadable',
      reason: 'allowHighRisk is not a boolean',
    });
    expect(readAutoMergeSettingsAnswer({ ...validEnabled, onBlocked: 'maybe' })).toEqual({
      kind: 'unreadable',
      reason: 'onBlocked is not ask-owner or hold',
    });
    expect(readAutoMergeSettingsAnswer({ ...validEnabled, revision: 'abc' })).toEqual({
      kind: 'unreadable',
      reason: 'revision does not match the 12-hex pattern',
    });
    expect(readAutoMergeSettingsAnswer({ ...validEnabled, forgeMode: 'gitlab' })).toEqual({
      kind: 'unreadable',
      reason: 'forgeMode is not github, none or unknown',
    });
  });

  it('treats a non-boolean enabled as unreadable', () => {
    expect(readAutoMergeSettingsAnswer({ ...validEnabled, enabled: 'yes' })).toEqual({
      kind: 'unreadable',
      reason: 'enabled is not a boolean',
    });
  });

  it('treats extra keys, getter-bearing objects, null and unreadable answers as unreadable without copying the text', () => {
    expect(readAutoMergeSettingsAnswer({ ...validEnabled, extra: 1 })).toEqual({
      kind: 'unreadable',
      reason: 'settings answer is not a plain record',
    });
    const getterBearing: Record<string, unknown> = {};
    Object.defineProperty(getterBearing, 'outcome', { enumerable: true, get: () => 'read' });
    Object.defineProperty(getterBearing, 'enabled', { enumerable: true, get: () => true });
    expect(readAutoMergeSettingsAnswer(getterBearing)).toEqual({
      kind: 'unreadable',
      reason: 'settings answer is not a plain record',
    });
    expect(readAutoMergeSettingsAnswer(null)).toEqual({
      kind: 'unreadable',
      reason: 'settings answer is not a plain record',
    });
    expect(readAutoMergeSettingsAnswer({ outcome: 'unreadable', reason: 'x' })).toEqual({
      kind: 'unreadable',
      reason: 'settings could not be read',
    });
  });
});

describe('autoMergeBlockersOf and isCiPendingOnly', () => {
  it('validates every entry before the cap: a failing check after 20 pending ones is never read as pending-only', () => {
    const pending = Array.from({ length: 20 }, () => ({ kind: 'ci-pending', text: 'a' }));
    const withFailure = autoMergeBlockersOf([...pending, { kind: 'ci-failed', text: 'b' }], 'fallback');
    expect(withFailure).toHaveLength(20);
    expect(withFailure[19]).toEqual({ kind: 'other', text: '2 more blockers' });
    expect(isCiPendingOnly(withFailure)).toBe(false);
    expect(autoMergeBlockersOf([...pending, 42], 'fallback')).toEqual([{ kind: 'other', text: 'fallback' }]);
    const exactlyTwenty = autoMergeBlockersOf(pending, 'fallback');
    expect(exactlyTwenty).toHaveLength(20);
    expect(isCiPendingOnly(exactlyTwenty)).toBe(true);
  });

  const fallback = 'fallback text';

  it('reads absent, empty, non-array and record-less lists as one other blocker', () => {
    expect(autoMergeBlockersOf(undefined, fallback)).toEqual([{ kind: 'other', text: fallback }]);
    expect(autoMergeBlockersOf([], fallback)).toEqual([{ kind: 'other', text: fallback }]);
    expect(autoMergeBlockersOf('x', fallback)).toEqual([{ kind: 'other', text: fallback }]);
    expect(autoMergeBlockersOf([{ kind: 'ci-pending' }], fallback)).toEqual([
      { kind: 'other', text: fallback },
    ]);
  });

  it('classifies pending-only lists with some, never every', () => {
    expect(isCiPendingOnly(autoMergeBlockersOf([{ kind: 'ci-pending', text: 'a' }], fallback))).toBe(true);
    expect(isCiPendingOnly(autoMergeBlockersOf([], fallback))).toBe(false);
    expect(isCiPendingOnly(autoMergeBlockersOf([{ kind: 'ci-pending', text: 'a' }, { kind: 'ci-failed', text: 'b' }], fallback))).toBe(false);
    expect(isCiPendingOnly(autoMergeBlockersOf([{ kind: 'ci-pendingx', text: 'a' }], fallback))).toBe(false);
  });

  it('caps the list at 20 entries and each text at 300 characters', () => {
    const many = Array.from({ length: 25 }, () => ({ kind: 'ci-pending', text: 'x'.repeat(400) }));
    const blockers = autoMergeBlockersOf(many, fallback);
    expect(blockers).toHaveLength(20);
    expect(blockers[0].text).toBe('x'.repeat(300));
  });
});

describe('autoMergeDoorsOf', () => {
  it('reads recorded answers: empty as none, strings as named count', () => {
    expect(autoMergeDoorsOf({ outcome: 'recorded', ownerDecisionReferences: [] })).toEqual({ kind: 'none' });
    expect(autoMergeDoorsOf({ outcome: 'recorded', ownerDecisionReferences: ['d1'] })).toEqual({
      kind: 'named',
      count: 1,
    });
    expect(autoMergeDoorsOf(['d1'])).toEqual({ kind: 'named', count: 1 });
  });

  it('reads unknown answers, non-string lists and malformed values as unreadable', () => {
    expect(autoMergeDoorsOf({ outcome: 'unknown', reason: 'r' })).toEqual({ kind: 'unreadable' });
    expect(autoMergeDoorsOf(['d1', 3])).toEqual({ kind: 'unreadable' });
    expect(autoMergeDoorsOf(undefined)).toEqual({ kind: 'unreadable' });
  });
});

describe('autoMergeIneligibility', () => {
  it('flags unreadable doors before high risk', () => {
    expect(
      autoMergeIneligibility({ doors: { kind: 'unreadable' }, risk: 'high', allowHighRisk: false, forgeMode: 'github' }),
    ).toBe('doors-unreadable');
  });

  it('flags a named door', () => {
    expect(
      autoMergeIneligibility({ doors: { kind: 'named', count: 1 }, risk: 'standard', allowHighRisk: true, forgeMode: 'github' }),
    ).toBe('door-named');
  });

  it('flags high risk without the opt-in', () => {
    expect(
      autoMergeIneligibility({ doors: { kind: 'none' }, risk: 'high', allowHighRisk: false, forgeMode: 'github' }),
    ).toBe('high-risk');
  });

  it('allows high risk with the opt-in on github with no doors', () => {
    expect(
      autoMergeIneligibility({ doors: { kind: 'none' }, risk: 'high', allowHighRisk: true, forgeMode: 'github' }),
    ).toBeNull();
  });

  it('flags a non-github forge mode even at standard risk', () => {
    expect(
      autoMergeIneligibility({ doors: { kind: 'none' }, risk: 'standard', allowHighRisk: true, forgeMode: 'unknown' }),
    ).toBe('forge-mode');
  });
});

describe('auto-merge keys', () => {
  const attemptId = 'attempt-example-1';
  const head = 'a'.repeat(40);

  it('builds the action id and forge entry prefix', () => {
    expect(autoMergeActionId(attemptId, head)).toBe('auto-merge:' + attemptId + ':' + head);
    expect(autoMergeForgeEntryPrefix(attemptId, head)).toBe(
      'forge:auto-merge:' + attemptId + ':' + head + ':',
    );
  });

  it('builds the first-look id outside the accept-entry prefix', () => {
    const id = autoMergeFirstLookEntryId(attemptId, head);
    expect(id).toBe(attemptId + ':auto-merge-first-look:' + head);
    expect(id.startsWith(attemptId + ':accept:' + head + ':')).toBe(false);
  });

  it('builds routing keys with and without a head', () => {
    expect(autoMergeRoutingKey(attemptId, head, 'forge-refused')).toBe(
      'auto-merge/' + attemptId + '/' + head.slice(0, 12) + '/forge-refused',
    );
    expect(autoMergeRoutingKey(attemptId, null, 'forge-refused')).toBe(
      'auto-merge/' + attemptId + '/no-head/forge-refused',
    );
  });

  it('builds the decision revision', () => {
    expect(AUTO_MERGE_DECISION_PREFIX).toBe('policy:autoMerge@');
    expect(autoMergeDecisionRevision('0123456789ab')).toBe('policy:autoMerge@0123456789ab');
  });

  it('matches authorized-by patterns strictly', () => {
    expect(AUTHORIZED_BY_PATTERN.test('policy:autoMerge@0123456789ab')).toBe(true);
    expect(AUTHORIZED_BY_PATTERN.test('policy:conductor@0123456789ab')).toBe(true);
    expect(AUTHORIZED_BY_PATTERN.test('owner-decision')).toBe(false);
    expect(AUTHORIZED_BY_PATTERN.test('policy:autoMerge@0123456789AB')).toBe(false);
    expect(AUTHORIZED_BY_PATTERN.test('policy:autoMerge@0123456789abc')).toBe(false);
  });

  it('declares the head and revision patterns', () => {
    expect(AUTO_MERGE_HEAD_PATTERN.test('a'.repeat(40))).toBe(true);
    expect(AUTO_MERGE_HEAD_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(AUTO_MERGE_HEAD_PATTERN.test('a'.repeat(41))).toBe(false);
    expect(AUTO_MERGE_REVISION_PATTERN.test('0123456789ab')).toBe(true);
    expect(AUTO_MERGE_REVISION_PATTERN.test('0123456789abc')).toBe(false);
  });
});
