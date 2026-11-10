import { describe, expect, it } from 'vitest';

import {
  classifyFindingCitation,
  uncitedFindingIds,
  type DiffCitationFile,
  type DiffCitationIndex,
} from './finding-citations.js';
import type { ReviewFindingRecord } from './evidence-records.js';

function finding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    findingId: 'f-1',
    severity: 'blocker',
    summary: 'a finding',
    filePath: null,
    line: null,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
    ...overrides,
  };
}

function diffIndex(files: readonly DiffCitationFile[]): DiffCitationIndex {
  return { files };
}

describe('classifyFindingCitation', () => {
  it('classifies a null filePath as no-file whatever the line is', () => {
    expect(classifyFindingCitation(finding({ filePath: null, line: null }), diffIndex([]))).toBe(
      'no-file',
    );
    expect(classifyFindingCitation(finding({ filePath: null, line: 7 }), diffIndex([]))).toBe(
      'no-file',
    );
  });

  it('classifies an empty or whitespace-only filePath as no-file', () => {
    const diff = diffIndex([{ path: '', lines: [1] }]);
    for (const filePath of ['', '   ', '\t', ' \n ']) {
      expect(classifyFindingCitation(finding({ filePath, line: 3 }), diff)).toBe('no-file');
    }
  });

  it('classifies a non-blank path absent from the diff as file-not-in-diff', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2] }]);
    expect(classifyFindingCitation(finding({ filePath: 'x/y.ts', line: 1 }), diff)).toBe(
      'file-not-in-diff',
    );
  });

  it('classifies a line not among the file’s diff lines as line-not-in-diff', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2] }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 9 }), diff)).toBe(
      'line-not-in-diff',
    );
  });

  it('classifies a null line as line-not-in-diff even when the file is in the diff', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2] }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: null }), diff)).toBe(
      'line-not-in-diff',
    );
  });

  it('classifies a file and line that are in the diff as cited', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2] }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 2 }), diff)).toBe('cited');
  });

  it('strips one leading ./ from each side for comparison and nothing else', () => {
    const diff = diffIndex([{ path: './a/b.ts', lines: [1] }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff)).toBe('cited');
    expect(classifyFindingCitation(finding({ filePath: './a/b.ts', line: 1 }), diff)).toBe('cited');
  });

  it('does not treat a leading / as the same path as no leading slash', () => {
    // `/a/b.ts` is not the same file as `a/b.ts`, in either direction.
    expect(
      classifyFindingCitation(finding({ filePath: '/a/b.ts', line: 5 }), diffIndex([{ path: 'a/b.ts', lines: [1] }])),
    ).toBe('file-not-in-diff');
    expect(
      classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diffIndex([{ path: '/a/b.ts', lines: [5] }])),
    ).toBe('file-not-in-diff');
    // A leading-slash path can still be cited when the diff actually names it.
    expect(
      classifyFindingCitation(finding({ filePath: '/a/b.ts', line: 5 }), diffIndex([{ path: '/a/b.ts', lines: [5] }])),
    ).toBe('cited');
  });

  it('does not strip a trailing slash', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1] }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts/', line: 1 }), diff)).toBe(
      'file-not-in-diff',
    );
  });

  it('counts a line as in the diff when either duplicate path entry names it', () => {
    const diff = diffIndex([
      { path: 'a/b.ts', lines: [1] },
      { path: './a/b.ts', lines: [9] },
    ]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 9 }), diff)).toBe('cited');
    expect(classifyFindingCitation(finding({ filePath: './a/b.ts', line: 1 }), diff)).toBe('cited');
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 5 }), diff)).toBe(
      'line-not-in-diff',
    );
  });

  it('treats a line that is not a positive safe integer as no line without throwing', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2] }]);
    for (const line of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => classifyFindingCitation(finding({ filePath: 'a/b.ts', line }), diff)).not.toThrow();
      expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line }), diff)).toBe(
        'line-not-in-diff',
      );
    }
  });
});

describe('uncitedFindingIds', () => {
  it('returns uncited ids in input order, each at most once', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1] }]);
    const findings = [
      finding({ findingId: 'a', filePath: 'a/b.ts', line: 1 }),
      finding({ findingId: 'b', filePath: null, line: null }),
      finding({ findingId: 'c', filePath: 'a/b.ts', line: 99 }),
      finding({ findingId: 'd', filePath: 'x/y.ts', line: 1 }),
      finding({ findingId: 'd', filePath: 'x/y.ts', line: 2 }),
      finding({ findingId: 'e', filePath: 'a/b.ts', line: 1 }),
    ];
    expect(uncitedFindingIds(findings, diff)).toEqual(['b', 'c', 'd']);
  });

  it('returns empty for empty input', () => {
    expect(uncitedFindingIds([], diffIndex([]))).toEqual([]);
  });
});

describe('purity', () => {
  it('never throws for input of the declared types and never mutates its arguments', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2] }]);
    const findings = [
      finding({ findingId: 'a', filePath: null, line: null }),
      finding({ findingId: 'b', filePath: 'a/b.ts', line: 1 }),
      finding({ findingId: 'c', filePath: 'a/b.ts', line: 5 }),
      finding({ findingId: 'd', filePath: 'a/b.ts', line: Number.NaN }),
    ];
    const diffBefore = JSON.stringify(diff);
    const findingsBefore = JSON.stringify(findings);
    for (const f of findings) {
      expect(() => classifyFindingCitation(f, diff)).not.toThrow();
    }
    expect(() => uncitedFindingIds(findings, diff)).not.toThrow();
    expect(JSON.stringify(diff)).toBe(diffBefore);
    expect(JSON.stringify(findings)).toBe(findingsBefore);
  });
});
