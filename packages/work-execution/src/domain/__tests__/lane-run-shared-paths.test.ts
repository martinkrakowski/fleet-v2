import { describe, expect, it } from 'vitest';

import {
  SHARED_APPEND_PATHS,
  isSharedAppendPath,
  laneRunOwnedPathsOverlap,
} from '../lane-run-packages.js';

describe('isSharedAppendPath (CG2)', () => {
  it('is true for the shared append files and a barrel', () => {
    expect(isSharedAppendPath('.architecture/manifest.yaml')).toBe(true);
    expect(isSharedAppendPath('yarn.lock')).toBe(true);
    expect(isSharedAppendPath('packages/a/src/index.ts')).toBe(true);
    expect(isSharedAppendPath('index.ts')).toBe(true);
  });

  it('is false for directories, globs, dot segments and non-matching names', () => {
    expect(isSharedAppendPath('packages/a/src')).toBe(false);
    expect(isSharedAppendPath('yarn.lock*')).toBe(false);
    expect(isSharedAppendPath('./yarn.lock')).toBe(false);
    expect(isSharedAppendPath('../yarn.lock')).toBe(false);
    expect(isSharedAppendPath('/yarn.lock')).toBe(false);
    expect(isSharedAppendPath('packages/a/src/index.tsx')).toBe(false);
    expect(isSharedAppendPath('')).toBe(false);
  });
});

describe('SHARED_APPEND_PATHS (CG2)', () => {
  it('lists exactly the shared append files', () => {
    expect(SHARED_APPEND_PATHS).toEqual(['.architecture/manifest.yaml', 'yarn.lock']);
  });
});

describe('laneRunOwnedPathsOverlap shared append exemption (CG2)', () => {
  const repo = (ownedPaths: readonly string[]) => ({ repository: 'repo-example-1', ownedPaths });

  it('two lanes sharing only the manifest plus disjoint packages do not overlap', () => {
    expect(
      laneRunOwnedPathsOverlap(
        repo(['.architecture/manifest.yaml', 'packages/a/src']),
        repo(['.architecture/manifest.yaml', 'packages/b/src']),
      ),
    ).toBe(false);
  });

  it('two lanes sharing only yarn.lock plus disjoint packages do not overlap', () => {
    expect(
      laneRunOwnedPathsOverlap(repo(['yarn.lock', 'packages/a/src']), repo(['yarn.lock', 'packages/b/src'])),
    ).toBe(false);
  });

  it('two lanes sharing only the same barrel do not overlap', () => {
    expect(
      laneRunOwnedPathsOverlap(
        repo(['packages/a/src/index.ts']),
        repo(['packages/a/src/index.ts']),
      ),
    ).toBe(false);
  });

  it('a directory still overlaps its nested barrel', () => {
    expect(laneRunOwnedPathsOverlap(repo(['packages/a/src']), repo(['packages/a/src/index.ts']))).toBe(true);
  });

  it('a directory still overlaps a file inside it (the manifest)', () => {
    expect(laneRunOwnedPathsOverlap(repo(['.architecture']), repo(['.architecture/manifest.yaml']))).toBe(true);
  });

  it('a glob is not shared', () => {
    expect(laneRunOwnedPathsOverlap(repo(['yarn.lock*']), repo(['yarn.lock']))).toBe(true);
  });

  it('a shared file listed next to a glob of itself still overlaps (the glob is not exempt)', () => {
    expect(laneRunOwnedPathsOverlap(repo(['yarn.lock', 'yarn.lock*']), repo(['yarn.lock']))).toBe(true);
  });

  it('equal non-shared directories still overlap', () => {
    expect(laneRunOwnedPathsOverlap(repo(['packages/a/src']), repo(['packages/a/src']))).toBe(true);
  });

  it('a dot segment fails closed even for a shared file', () => {
    expect(laneRunOwnedPathsOverlap(repo(['./yarn.lock']), repo(['yarn.lock']))).toBe(true);
  });

  it('different repositories never overlap', () => {
    expect(
      laneRunOwnedPathsOverlap(
        { repository: 'repo-a', ownedPaths: ['.architecture/manifest.yaml'] },
        { repository: 'repo-b', ownedPaths: ['.architecture/manifest.yaml'] },
      ),
    ).toBe(false);
  });
});
