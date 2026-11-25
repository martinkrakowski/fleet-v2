// Direct unit tests for the pure path helpers of GitShelfProvider.adapter:
// `pathPrefixProblemIn` (validation refusals and check order) and
// `shelfFilePath` (file name construction, unvalidated). Test-only unit: no
// production file is touched, no git or filesystem call is made, and
// `isFleetV2Checkout` is never invoked — both helpers are pure string
// functions, so no I/O, port, command, file or budget exists here.
//
// Cost bounds: `pathPrefixProblemIn` performs one `split('/')` over the input
// and one pass over the segments, linear O(n) in input length. `shelfFilePath`
// performs a single string interpolation, O(n) in the combined lengths.
import { describe, expect, it } from 'vitest';
import { pathPrefixProblemIn, shelfFilePath } from '../GitShelfProvider.adapter.js';

describe('pathPrefixProblemIn', () => {
  it('returns null for an empty prefix so keepers at the tree root are allowed', () => {
    expect(pathPrefixProblemIn('')).toBeNull();
  });

  it('returns null for the safe relative prefixes docs, a/b, .gitignore, ... and a/..b', () => {
    // '.gitignore' and '...' are single segments that merely resemble the
    // refused ones; 'a/..b' has a segment starting with dots but not equal
    // to '..' — none of them may be refused.
    for (const safe of ['docs', 'a/b', '.gitignore', '...', 'a/..b']) {
      expect(pathPrefixProblemIn(safe)).toBeNull();
    }
  });

  it('refuses a leading slash on /docs and / with "must be relative (no leading /)"', () => {
    expect(pathPrefixProblemIn('/docs')).toBe('must be relative (no leading /)');
    expect(pathPrefixProblemIn('/')).toBe('must be relative (no leading /)');
  });

  it('refuses a ".." segment on .. and a/../b with "must not contain a \\"..\\" segment"', () => {
    expect(pathPrefixProblemIn('..')).toBe('must not contain a ".." segment');
    expect(pathPrefixProblemIn('a/../b')).toBe('must not contain a ".." segment');
  });

  it('refuses a ".git" segment case-insensitively on .git, a/.git/b and a/.GIT', () => {
    expect(pathPrefixProblemIn('.git')).toBe('must not contain a ".git" segment');
    expect(pathPrefixProblemIn('a/.git/b')).toBe('must not contain a ".git" segment');
    expect(pathPrefixProblemIn('a/.GIT')).toBe('must not contain a ".git" segment');
  });

  it('refuses an empty segment on a//b and a/ with "must not contain an empty segment"', () => {
    expect(pathPrefixProblemIn('a//b')).toBe('must not contain an empty segment');
    expect(pathPrefixProblemIn('a/')).toBe('must not contain an empty segment');
  });

  it('checks the leading-slash rule before ".." and the empty-segment rule before ".."', () => {
    // Order is pinned: on '/..' the leading-slash refusal wins even though a
    // '..' segment is also present; on 'a//..' the empty segment (index 1)
    // precedes the '..' segment (index 2); on '../a//b' the '..' segment
    // (index 0) precedes the empty segment (index 3).
    expect(pathPrefixProblemIn('/..')).toBe('must be relative (no leading /)');
    expect(pathPrefixProblemIn('a//..')).toBe('must not contain an empty segment');
    expect(pathPrefixProblemIn('../a//b')).toBe('must not contain a ".." segment');
  });
});

describe('shelfFilePath', () => {
  it('returns "<entryId>.md" for an empty prefix, e.g. k1 -> k1.md', () => {
    expect(shelfFilePath('', 'k1')).toBe('k1.md');
  });

  it('returns "docs/k1.md" for prefix docs and entry k1', () => {
    expect(shelfFilePath('docs', 'k1')).toBe('docs/k1.md');
  });

  it('returns "a/b/x.md" for a two-segment prefix a/b and entry x', () => {
    expect(shelfFilePath('a/b', 'x')).toBe('a/b/x.md');
  });

  // shelfFilePath does not validate: the '..' refusal lives entirely in
  // pathPrefixProblemIn, so callers must run pathPrefixProblemIn on the
  // prefix first. This test pins today's unvalidated behaviour, not an
  // endorsement of it.
  it('does not validate and returns ../x/id.md for prefix ../x', () => {
    expect(shelfFilePath('../x', 'id')).toBe('../x/id.md');
  });
});
