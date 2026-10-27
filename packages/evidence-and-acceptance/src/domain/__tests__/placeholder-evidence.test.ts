import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_PREFIXES,
  PLACEHOLDER_WHOLE_TEXTS,
  isPlaceholderEvidence,
  isWholeValuePlaceholder,
  placeholderEvidenceRefusal,
  placeholderFindingDispositionField,
  placeholderReviewReceiptField,
  placeholderVerificationReceiptField,
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

describe('write-side field checks (A2, D1)', () => {
  it('refuses a whole placeholder evidenceRef on a review receipt', () => {
    expect(placeholderReviewReceiptField({ evidenceRef: 'n/a', findings: [] })).toBe('evidenceRef');
  });

  it('names the second finding summary when it is a whole placeholder', () => {
    const receipt = {
      evidenceRef: 'evidence://review-asm-1@' + 'a'.repeat(64),
      findings: [
        {
          findingId: 'f-0',
          severity: 'major',
          summary: 'ordering fixed at queue.ts:40',
          filePath: null,
          line: null,
          state: 'unresolved',
          dispositionReason: null,
          dispositionEvidenceRef: null,
        },
        {
          findingId: 'f-1',
          severity: 'major',
          summary: 'TBD',
          filePath: null,
          line: null,
          state: 'unresolved',
          dispositionReason: null,
          dispositionEvidenceRef: null,
        },
      ] as const,
    };
    expect(placeholderReviewReceiptField(receipt)).toBe('findings[1].summary');
  });

  it('accepts real archive references on verification receipts', () => {
    expect(
      placeholderVerificationReceiptField({
        evidenceRef: 'evidence://verification-asm-1-lint-' + '1'.repeat(40) + '@' + 'b'.repeat(64),
      }),
    ).toBeNull();
    expect(placeholderVerificationReceiptField({ evidenceRef: 'ref-review-asm-1' })).toBeNull();
    expect(placeholderVerificationReceiptField({ evidenceRef: 'sha256:' + 'c'.repeat(64) })).toBeNull();
  });

  it('accepts D2 sentences as a finding summary and a disposition reason', () => {
    expect(
      placeholderReviewReceiptField({
        evidenceRef: 'ref-1',
        findings: [
          {
            findingId: 'f-1',
            severity: 'major',
            summary: 'Seems the lock is released twice at line 40',
            filePath: null,
            line: null,
            state: 'unresolved',
            dispositionReason: null,
            dispositionEvidenceRef: null,
          },
        ],
      }),
    ).toBeNull();
    expect(placeholderFindingDispositionField({ reason: 'None of the tests passed at line 40', evidenceRef: 'ref-1' })).toBeNull();
  });

  it('prefers reason, then evidenceRef, on a finding disposition', () => {
    expect(placeholderFindingDispositionField({ reason: 'lgtm', evidenceRef: 'ref-1' })).toBe('reason');
    expect(
      placeholderFindingDispositionField({
        reason: 'Fixed the off-by-one at line 12',
        evidenceRef: 'N/A',
      }),
    ).toBe('evidenceRef');
  });

  it('builds the refusal message from the record and field names only', () => {
    expect(placeholderEvidenceRefusal('Review receipt', 'evidenceRef')).toBe(
      'Review receipt evidenceRef is placeholder text, not evidence',
    );
  });
});

describe('isWholeValuePlaceholder (amendment D-a/D-b)', () => {
  it.each(['n/a', 'TBD', 'none.', '', '   ', 'tbd', 'todo', 'should work', 'lgtm', 'seems', 'probably', 'i think', 'N/A', 'na', 'none', 'looks right', 'looks good'])(
    'refuses %j',
    (text) => {
      expect(isWholeValuePlaceholder(text)).toBe(true);
    },
  );

  it.each([
    'todo.ts:40',
    'tbd-notes.md',
    'na-123',
    'evidence://review-asm-1@' + 'a'.repeat(64),
    'TODO: null check missing at line 40',
    'NA values crash parse()',
    'Seems the lock is released twice at line 40',
  ])('accepts %j', (text) => {
    expect(isWholeValuePlaceholder(text)).toBe(false);
  });
});
