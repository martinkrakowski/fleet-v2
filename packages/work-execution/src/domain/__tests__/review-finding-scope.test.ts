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
