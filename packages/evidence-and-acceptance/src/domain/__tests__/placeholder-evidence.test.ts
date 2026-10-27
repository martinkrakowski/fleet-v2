import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_PREFIXES,
  PLACEHOLDER_WHOLE_TEXTS,
  isPlaceholderEvidence,
} from '../placeholder-evidence.js';

describe('isPlaceholderEvidence (A1, plan §3.1)', () => {
  it.each([
    '',
    '   ',
    '\t\n',
    'TBD',
    'tbd',
    'tbd-later',
    'n/a.',
    'N/A',
    'na',
    'NA - not run',
    'LGTM!',
    'lgtm, ship it',
    '  todo: fix later',
    'TODO',
    'should work',
    'Should work after the rebase',
    'should   work',
    'looks right',
    'Looks good to me',
    '\tlgtm\n',
    'seems',
    'Seems.',
    'none',
    'None!',
    'probably',
    'Probably...',
    'i think',
    'I think?',
    '  seems ! ',
    '...',
  ])('refuses %j', (text) => {
    expect(isPlaceholderEvidence(text)).toBe(true);
  });

  it.each([
    'Seems the lock is released twice at line 40',
    'None of the tests passed at line 40',
    'todos are done',
    'tbdx',
    'nana',
    'national suite passed, run 991',
    'lgtmx',
    'n/ab',
    'Probably fine',
    'I think the race is in drain() at queue.ts:88',
    'nonexistent path refused at line 12',
    'should',
    'should be fine',
    'looks rightish',
    'looks at lock order: fixed in a1b2c3d',
    'Reviewed: no TODO left in queue.ts',
    'gate log at evidence/run-42.txt',
    'All 214 tests pass; CI run 991 green',
    '- tbd',
    'seemsless',
  ])('accepts %j', (text) => {
    expect(isPlaceholderEvidence(text)).toBe(false);
  });

  it('exports the expected phrase lists', () => {
    expect(PLACEHOLDER_PREFIXES).toEqual([
      'tbd',
      'todo',
      'n/a',
      'na',
      'should work',
      'looks right',
      'looks good',
      'lgtm',
    ]);
    expect(PLACEHOLDER_WHOLE_TEXTS).toEqual(['none', 'seems', 'probably', 'i think']);
  });

  it('refuses every entry of both lists on its own', () => {
    for (const phrase of [...PLACEHOLDER_PREFIXES, ...PLACEHOLDER_WHOLE_TEXTS]) {
      expect(isPlaceholderEvidence(phrase)).toBe(true);
    }
  });
});
