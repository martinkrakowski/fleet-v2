import { describe, expect, it } from 'vitest';

import { WorktreePathRefusedError } from '../../../application/ports/out/WorkspacePort.out-port.js';
import { resolveWorktreeTarget } from '../WorkspaceAdapter.adapter.js';

describe('resolveWorktreeTarget', () => {
  it('resolves an absolute candidate inside the worktree under a trailing-slash root', () => {
    expect(resolveWorktreeTarget('/wt/', '/wt/.lane/brief.md')).toBe('/wt/.lane/brief.md');
  });

  it('joins a relative candidate under the worktree root', () => {
    expect(resolveWorktreeTarget('/wt', '.lane/brief.md')).toBe('/wt/.lane/brief.md');
  });

  it('refuses a candidate that is exactly the worktree root', () => {
    expect(() => resolveWorktreeTarget('/wt', '/wt')).toThrow(WorktreePathRefusedError);
  });

  it('refuses a candidate that is only a dot (the worktree itself is not a file)', () => {
    expect(() => resolveWorktreeTarget('/wt', '.')).toThrow(WorktreePathRefusedError);
  });

  it('refuses absolute candidates outside or beside the worktree', () => {
    for (const candidate of ['/wtx/a', '/wt/../etc/passwd', '/etc/passwd']) {
      expect(() => resolveWorktreeTarget('/wt', candidate)).toThrow(WorktreePathRefusedError);
    }
  });

  it('refuses escaping, backslash and NUL relative candidates', () => {
    for (const candidate of ['../x', 'a\\b', 'a/b\0/c']) {
      expect(() => resolveWorktreeTarget('/wt', candidate)).toThrow(WorktreePathRefusedError);
    }
  });

  it('refuses root, slash-only and empty worktree paths, and relative worktree paths', () => {
    for (const worktreePath of ['/', '//', '', 'wt']) {
      expect(() => resolveWorktreeTarget(worktreePath, '.lane/brief.md')).toThrow(
        WorktreePathRefusedError,
      );
    }
  });
});
