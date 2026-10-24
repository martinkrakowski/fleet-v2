import { describe, expect, it } from 'vitest';

import { validateWorktreeRelativePath } from '../worktree-path.js';

describe('validateWorktreeRelativePath', () => {
  it('accepts plain relative paths', () => {
    expect(validateWorktreeRelativePath('.lane/brief.md')).toBeNull();
    // `a/b/../c` normalises to `a/c`, staying inside the worktree.
    expect(validateWorktreeRelativePath('a/b/../c')).toBeNull();
  });

  it('refuses absolute paths', () => {
    expect(validateWorktreeRelativePath('/etc/passwd')).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath('C:\\x')).toEqual(expect.any(String));
  });

  it('refuses paths that escape the worktree root', () => {
    expect(validateWorktreeRelativePath('../x')).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath('a/../../x')).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath('..')).toEqual(expect.any(String));
  });

  it('refuses empty strings', () => {
    expect(validateWorktreeRelativePath('')).toEqual(expect.any(String));
  });

  it('refuses strings containing NUL bytes', () => {
    expect(validateWorktreeRelativePath('a\0b')).toEqual(expect.any(String));
  });

  it('refuses non-strings', () => {
    expect(validateWorktreeRelativePath(null)).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath(undefined)).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath(42)).toEqual(expect.any(String));
    expect(validateWorktreeRelativePath(['a'])).toEqual(expect.any(String));
  });
});
