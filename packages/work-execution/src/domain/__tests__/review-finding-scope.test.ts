/**
 * Unit tests for the KF-33a scope rule: which review findings drive a fix
 * round. Pure partitioning only — no store, no reads, no throws.
 */

import { describe, expect, it } from 'vitest';

import { partitionFindingsByScope } from '../review-finding-scope.js';

interface Finding {
  readonly findingId: string;
  readonly filePath: string | null;
}

function finding(findingId: string, filePath: string | null): Finding {
  return { findingId, filePath };
}

describe('partitionFindingsByScope (KF-33a)', () => {
  it('an unreadable changed-path set keeps every finding in scope (fail closed)', () => {
    const findings = [finding('f1', 'src/a.ts'), finding('f2', null)];
    const partition = partitionFindingsByScope(findings, null);
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a finding with no filePath stays in scope', () => {
    const findings = [finding('f1', null)];
    const partition = partitionFindingsByScope(findings, ['src/other.ts']);
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('an exact match with a changed path is in scope', () => {
    const findings = [finding('f1', 'src/a.ts')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts']);
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a ./-prefixed finding path matches its changed path', () => {
    const findings = [finding('f1', './src/a.ts')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts']);
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('an absolute path under the given worktree matches its changed path', () => {
    const findings = [finding('f1', '/tmp/wo/wt/src/a.ts')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts'], '/tmp/wo/wt');
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a backticked finding path matches its changed path', () => {
    const findings = [finding('f1', '`src/a.ts`')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts'], '/tmp/wo/wt');
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a double-quoted finding path matches its changed path', () => {
    const findings = [finding('f1', '"src/a.ts"')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts'], '/tmp/wo/wt');
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a finding path with a trailing slash matches its changed path', () => {
    const findings = [finding('f1', 'src/a.ts/')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts']);
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a foreign absolute path stays in scope (unknown spellings fail closed)', () => {
    const findings = [finding('f1', '/etc/x.ts')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts'], '/tmp/wo/wt');
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a `..`-segment path stays in scope (unknown spellings fail closed)', () => {
    const findings = [finding('f1', '../x.ts')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts'], '/tmp/wo/wt');
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  // KF-33b: a line-range suffix or trailing punctuation is never git's
  // spelling of a changed path; each unknown spelling stays in scope.
  it.each([
    ['a range suffix', 'src/a.ts:4-9'],
    ['a doubled slash', 'src//a.ts'],
    ['an interior ./ segment', 'src/./a.ts'],
    ['a trailing comma', 'src/a.ts,'],
    ['a trailing period', 'src/a.ts.'],
    ['a trailing semicolon', 'src/a.ts;'],
  ])('a path with %s stays in scope (unknown spellings fail closed)', (_label, filePath) => {
    const findings = [finding('f1', filePath)];
    const partition = partitionFindingsByScope(findings, ['src/a.ts']);
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('an empty-after-normalising path stays in scope (unknown spellings fail closed)', () => {
    const findings = [finding('f1', '``')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts'], '/tmp/wo/wt');
    expect(partition.inScope).toEqual(findings);
    expect(partition.outOfScope).toEqual([]);
  });

  it('a file the lane did not change is out of scope', () => {
    const findings = [finding('f1', 'src/other.ts')];
    const partition = partitionFindingsByScope(findings, ['src/a.ts']);
    expect(partition.inScope).toEqual([]);
    expect(partition.outOfScope).toEqual(findings);
  });

  it('a path that is only a prefix of a changed path is out of scope', () => {
    const findings = [finding('f1', 'a/b')];
    const partition = partitionFindingsByScope(findings, ['a/bc.ts']);
    expect(partition.inScope).toEqual([]);
    expect(partition.outOfScope).toEqual(findings);
  });

  it('order is preserved in both lists', () => {
    const findings = [
      finding('f1', 'src/a.ts'),
      finding('f2', 'src/other.ts'),
      finding('f3', null),
      finding('f4', 'src/another.ts'),
    ];
    const partition = partitionFindingsByScope(findings, ['src/a.ts', 'src/another.ts']);
    expect(partition.inScope.map((f) => f.findingId)).toEqual(['f1', 'f3', 'f4']);
    expect(partition.outOfScope.map((f) => f.findingId)).toEqual(['f2']);
  });
});
