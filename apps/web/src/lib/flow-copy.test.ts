import { describe, expect, it } from 'vitest';
import { loadForbiddenNames } from '../../eslint-rules/no-working-name.js';
import { ONBOARDING_FLOW_STEPS } from './flow-copy.js';

function findForbidden(text: string, names: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return names.filter((name) => lower.includes(name));
}

describe('onboarding flow copy', () => {
  it('exports frozen neutral onboarding flow steps', () => {
    expect(ONBOARDING_FLOW_STEPS).toEqual({
      connectSource: 'connect source',
      pickRepositories: 'pick repositories',
      reviewProcedures: 'review procedures',
      confirm: 'confirm',
      dryRun: 'dry run',
    });
    expect(Object.isFrozen(ONBOARDING_FLOW_STEPS)).toBe(true);
  });

  it('no onboarding flow label contains a forbidden word', () => {
    const names = [...loadForbiddenNames(), 'zzforbiddenzz'];
    // the checker itself must detect a planted word, so an always-empty result cannot pass
    expect(findForbidden('a zzforbiddenzz b', names)).toEqual(['zzforbiddenzz']);
    for (const label of Object.values(ONBOARDING_FLOW_STEPS)) {
      expect(findForbidden(label, names)).toEqual([]);
    }
  });
});
