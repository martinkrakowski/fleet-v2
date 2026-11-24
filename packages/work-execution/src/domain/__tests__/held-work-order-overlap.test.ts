// VB29: direct domain unit tests for the held-work-order overlap screening
// primitives: `screenRepoRelativePath`, `screenBriefRequestRef`, `overlapPathCode`,
// `pathsOverlap` and `findFirstOverlappingOwnedPathCode`. Pure domain only: no
// filesystem, no subprocess, no Node builtins. Every secret-shaped fixture below
// is synthesized by string concatenation so this file itself never carries a
// credential-shaped literal.
import { describe, expect, it } from 'vitest';

import {
  MAX_OWNED_PATHS,
  PATH_CODE_PATTERN,
  screenBriefRequestRef,
  screenRepoRelativePath,
  findFirstOverlappingOwnedPathCode,
  overlapPathCode,
  pathsOverlap,
} from '../held-work-order.js';

/** A GitHub-token-shaped string, assembled so no literal ever appears in source. */
const secretShapedToken = ['g', 'h', 'p'].join('') + '_' + 'a'.repeat(20);
/** An OpenAI-style-key-shaped string, likewise synthesized. */
const secretShapedKey = ['s', 'k'].join('') + '-' + 'a'.repeat(20);

/** An object whose every trap counts invocations; a lying Proxy for refusal tests. */
function lyingProxy(): { proxy: object; trapCount(): number } {
  let traps = 0;
  const proxy = new Proxy(
    { toString() {
      traps += 1;
      return 'src/a';
    } },
    {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      has() {
        traps += 1;
        return false;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
    },
  );
  return { proxy, trapCount: () => traps };
}

describe('pathsOverlap', () => {
  it('returns true for identical non-shared paths', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('returns true when a directory overlaps a nested file or directory, in both argument orders', () => {
    expect(pathsOverlap('src/a', 'src/a/b.ts')).toBe(true);
    expect(pathsOverlap('src/a/b.ts', 'src/a')).toBe(true);
    expect(pathsOverlap('src/a', 'src/a/b/c')).toBe(true);
    expect(pathsOverlap('src/a/b/c', 'src/a')).toBe(true);
  });

  it('returns false for prefix siblings in both argument orders', () => {
    expect(pathsOverlap('src/a', 'src/ab')).toBe(false);
    expect(pathsOverlap('src/ab', 'src/a')).toBe(false);
    expect(pathsOverlap('src/a.ts', 'src/a')).toBe(false);
    expect(pathsOverlap('src/a', 'src/a.ts')).toBe(false);
  });

  it('returns false only when both paths are the exact same shared-append path', () => {
    expect(pathsOverlap('yarn.lock', 'yarn.lock')).toBe(false);
    expect(pathsOverlap('.architecture/manifest.yaml', '.architecture/manifest.yaml')).toBe(false);
    expect(pathsOverlap('index.ts', 'index.ts')).toBe(false);
    expect(pathsOverlap('packages/a/src/index.ts', 'packages/a/src/index.ts')).toBe(false);
  });

  it('keeps the shared-append exemption exact: a nested or distinct form still overlaps', () => {
    // A shared file under its parent directory overlaps that directory.
    expect(pathsOverlap('.architecture', '.architecture/manifest.yaml')).toBe(true);
    expect(pathsOverlap('.architecture/manifest.yaml', '.architecture')).toBe(true);
    expect(pathsOverlap('packages', 'packages/yarn.lock')).toBe(true);
    // A barrel file whose name also prefixes a directory still overlaps it.
    expect(pathsOverlap('src/index.ts', 'src/index.ts/x')).toBe(true);
    expect(pathsOverlap('src/index.ts/x', 'src/index.ts')).toBe(true);
    // Globs are never shared.
    expect(pathsOverlap('yarn.lock*', 'yarn.lock*')).toBe(true);
    // Directories are never shared.
    expect(pathsOverlap('packages/a/src', 'packages/a/src')).toBe(true);
  });
});

describe('screenRepoRelativePath', () => {
  it('trims surrounding whitespace and strips trailing slashes', () => {
    expect(screenRepoRelativePath('  src/a//  ')).toBe('src/a');
    expect(screenRepoRelativePath('src/b/')).toBe('src/b');
    expect(screenRepoRelativePath('src/c')).toBe('src/c');
  });

  it('refuses non-strings and hostile objects without invoking getters', () => {
    const getterReads: string[] = [];
    const withThrowingGetter = {
      get value(): string {
        getterReads.push('value');
        throw new Error('getter must never run');
      },
      toString(): string {
        getterReads.push('toString');
        throw new Error('toString must never run');
      },
    };
    for (const raw of [null, undefined, 123, true, {}, [], withThrowingGetter, { length: 1, 0: 'src/a' }]) {
      expect(screenRepoRelativePath(raw)).toBeNull();
    }
    const { proxy, trapCount } = lyingProxy();
    expect(screenRepoRelativePath(proxy)).toBeNull();
    expect(getterReads).toEqual([]);
    expect(trapCount()).toBe(0);
  });

  it('refuses empty, dot-segment, double-slash, absolute, Windows, backslash, and control-character paths', () => {
    for (const raw of [
      '',
      '   ',
      '.',
      '..',
      './a',
      'a/./b',
      'a/../b',
      'a/..',
      'a//b',
      '/src/a',
      'C:a',
      'C:/a',
      'a\\b',
      'a\0b',
      'a\x07b',
      'a\nb',
      'a\x7fb',
    ]) {
      expect(screenRepoRelativePath(raw)).toBeNull();
    }
  });

  it('refuses over-long, over-512-UTF-8-byte, enormous, and secret-shaped paths', () => {
    expect(screenRepoRelativePath('a'.repeat(513))).toBeNull();
    expect(screenRepoRelativePath('あ'.repeat(200))).toBeNull(); // 200 chars, 600 UTF-8 bytes
    expect(screenRepoRelativePath('a'.repeat(100_000))).toBeNull();
    expect(screenRepoRelativePath('src/' + secretShapedToken)).toBeNull();
  });

  it('accepts a valid path exactly at the 512-byte boundary', () => {
    expect(screenRepoRelativePath('a'.repeat(512))).toBe('a'.repeat(512));
  });
});

describe('screenBriefRequestRef', () => {
  it('accepts alphanumeric-start tokens of allowed characters up to 128 characters', () => {
    expect(screenBriefRequestRef('a')).toBe('a');
    expect(screenBriefRequestRef('req-1.2_3:4')).toBe('req-1.2_3:4');
    expect(screenBriefRequestRef('A'.repeat(128))).toBe('A'.repeat(128));
  });

  it('refuses non-strings, invalid characters, over-long, prototype-polluting, and secret-shaped refs', () => {
    const getterReads: string[] = [];
    const withThrowingGetter = {
      get value(): string {
        getterReads.push('value');
        throw new Error('getter must never run');
      },
      toString(): string {
        getterReads.push('toString');
        throw new Error('toString must never run');
      },
    };
    for (const raw of [
      null,
      undefined,
      42,
      false,
      {},
      withThrowingGetter,
      '.',
      '..',
      'A'.repeat(129),
      'a'.repeat(100_000),
      '-req',
      '__proto__',
      'req 1',
      secretShapedKey,
    ]) {
      expect(screenBriefRequestRef(raw)).toBeNull();
    }
    const { proxy, trapCount } = lyingProxy();
    expect(screenBriefRequestRef(proxy)).toBeNull();
    expect(getterReads).toEqual([]);
    expect(trapCount()).toBe(0);
  });
});

describe('overlapPathCode', () => {
  it('returns path- plus 12 lowercase hex characters, deterministically', () => {
    const first = overlapPathCode('src/a');
    const second = overlapPathCode('src/a');
    expect(first).toMatch(PATH_CODE_PATTERN);
    expect(second).toBe(first);
  });

  it('codes different paths differently and never echoes the input path text', () => {
    const codeA = overlapPathCode('src/a');
    const codeB = overlapPathCode('src/b');
    expect(codeA).not.toBe(codeB);
    expect(codeA).not.toContain('src');
    expect(codeA).not.toContain('/');
  });

  it('uses an injected digest function when one is supplied', () => {
    const calls: string[] = [];
    const code = overlapPathCode('src/a', (text) => {
      calls.push(text);
      return 'f'.repeat(64);
    });
    expect(calls).toEqual(['src/a']);
    expect(code).toBe('path-' + 'f'.repeat(12));
  });
});

describe('findFirstOverlappingOwnedPathCode', () => {
  it('returns the code of the first owned path, in caller order, that overlaps any candidate', () => {
    const parent = overlapPathCode('src/parent');
    const nested = overlapPathCode('src/parent/nested');
    const candidates = ['src/parent/nested/file.ts'];
    // Both owned paths overlap the candidate, so caller order decides the code.
    expect(findFirstOverlappingOwnedPathCode(['src/parent', 'src/parent/nested'], candidates)).toBe(parent);
    expect(findFirstOverlappingOwnedPathCode(['src/parent/nested', 'src/parent'], candidates)).toBe(nested);
  });

  it('returns null for empty inputs or non-overlapping paths', () => {
    expect(findFirstOverlappingOwnedPathCode([], ['src/a'])).toBeNull();
    expect(findFirstOverlappingOwnedPathCode(['src/a'], [])).toBeNull();
    expect(findFirstOverlappingOwnedPathCode(['src/a'], ['src/b'])).toBeNull();
    expect(findFirstOverlappingOwnedPathCode([], [])).toBeNull();
  });

  it('stays fast and exact over the full 256 x 256 cost bound, with and without a late overlap', () => {
    const owned = Array.from({ length: MAX_OWNED_PATHS }, (_, i) => `src/owned-${i}`);
    const candidates = Array.from({ length: MAX_OWNED_PATHS }, (_, i) => `src/candidate-${i}`);
    const startedNoOverlap = performance.now();
    expect(findFirstOverlappingOwnedPathCode(owned, candidates)).toBeNull();
    const noOverlapMs = performance.now() - startedNoOverlap;
    expect(noOverlapMs).toBeLessThan(500);

    const lateOwned = [...owned.slice(0, MAX_OWNED_PATHS - 1), 'src/candidate-255/nested'];
    const startedLate = performance.now();
    const lateCode = findFirstOverlappingOwnedPathCode(lateOwned, candidates);
    const lateMs = performance.now() - startedLate;
    expect(lateCode).toBe(overlapPathCode('src/candidate-255/nested'));
    expect(lateMs).toBeLessThan(500);
  });
});
