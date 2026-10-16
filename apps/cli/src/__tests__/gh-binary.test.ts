// Unit tests for the pure gh binary resolver (S4036): the composition root
// must only ever spawn an absolute gh path from the fixed candidate list,
// never a PATH lookup.
import { describe, expect, it } from 'vitest';

import { GH_BINARY_CANDIDATES, resolveGhBinary } from '../gh-binary.js';

describe('resolveGhBinary', () => {
  it('returns the first candidate when it is executable', () => {
    expect(resolveGhBinary(GH_BINARY_CANDIDATES, () => true)).toBe('/opt/homebrew/bin/gh');
  });

  it('returns a later candidate when earlier ones are not executable', () => {
    const isExecutable = (candidate: string) => candidate === '/usr/bin/gh';
    expect(resolveGhBinary(GH_BINARY_CANDIDATES, isExecutable)).toBe('/usr/bin/gh');
  });

  it('returns undefined when no candidate is executable', () => {
    expect(resolveGhBinary(GH_BINARY_CANDIDATES, () => false)).toBeUndefined();
  });
});
