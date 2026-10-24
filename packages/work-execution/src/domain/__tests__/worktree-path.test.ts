import { describe, expect, it } from 'vitest';

import { validateWorktreeRelativePath } from '../worktree-path.js';

describe('validateWorktreeRelativePath', () => {
  it('accepts plain relative paths', () => {
    expect(validateWorktreeRelativePath('.lane/brief.md')).toBeNull();
    // `a/b/../c` normalises to `a/c`, staying inside the worktree.
    expect(validateWorktreeRelativePath('a/b/../c')).toBeNull();
  });

  it('refuses absolute paths', () => {
    expect(validateWorktreeRelativePath('/etc/passwd')).toBe(
      'worktree-relative path must be relative',
    );
    expect(validateWorktreeRelativePath('C:\\x')).toBe(
      'worktree-relative path must not contain backslashes',
    );
  });

  it('refuses drive-letter forms with or without a following slash', () => {
    expect(validateWorktreeRelativePath('C:secret')).toBe('worktree-relative path must be relative');
    expect(validateWorktreeRelativePath('c:/x')).toBe('worktree-relative path must be relative');
    expect(validateWorktreeRelativePath('C:\\x')).toBe(
      'worktree-relative path must not contain backslashes',
    );
  });

  it('refuses any path containing a backslash', () => {
    expect(validateWorktreeRelativePath('..\\outside')).toBe(
      'worktree-relative path must not contain backslashes',
    );
    expect(validateWorktreeRelativePath('foo\\..\\..\\secret')).toBe(
      'worktree-relative path must not contain backslashes',
    );
    expect(validateWorktreeRelativePath('a\\b')).toBe(
      'worktree-relative path must not contain backslashes',
    );
  });

  it('refuses paths that escape the worktree root', () => {
    expect(validateWorktreeRelativePath('../x')).toBe(
      'worktree-relative path must not escape the worktree root',
    );
    expect(validateWorktreeRelativePath('a/../../x')).toBe(
      'worktree-relative path must not escape the worktree root',
    );
    expect(validateWorktreeRelativePath('..')).toBe(
      'worktree-relative path must not escape the worktree root',
    );
  });

  it('refuses empty strings', () => {
    expect(validateWorktreeRelativePath('')).toEqual(expect.any(String));
  });

  it('refuses strings containing NUL bytes', () => {
    expect(validateWorktreeRelativePath('a\0b')).toBe(
      'worktree-relative path must not contain NUL bytes',
    );
  });

  it('refuses non-strings', () => {
    expect(validateWorktreeRelativePath(null)).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath(undefined)).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath(42)).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath(['a'])).toEqual(expect.any(String));
  });
});
