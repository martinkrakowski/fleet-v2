// Unit tests for the pure ssh binary resolver (S4036): the composition root
// must only ever spawn an absolute ssh path from the fixed candidate list,
// never a PATH lookup.
import { describe, expect, it } from 'vitest';

import { SSH_BINARY_CANDIDATES, resolveSshBinary } from '../ssh-binary.js';

describe('resolveSshBinary', () => {
  it('names only absolute candidates', () => {
    for (const candidate of SSH_BINARY_CANDIDATES) {
      expect(candidate.startsWith('/')).toBe(true);
    }
  });

  it('returns the first candidate when it is executable', () => {
    expect(resolveSshBinary(SSH_BINARY_CANDIDATES, () => true)).toBe('/usr/bin/ssh');
  });

  it('returns a later candidate when earlier ones are not executable', () => {
    const isExecutable = (candidate: string) => candidate === '/opt/homebrew/bin/ssh';
    expect(resolveSshBinary(SSH_BINARY_CANDIDATES, isExecutable)).toBe('/opt/homebrew/bin/ssh');
  });

  it('returns undefined when no candidate is executable', () => {
    expect(resolveSshBinary(SSH_BINARY_CANDIDATES, () => false)).toBeUndefined();
  });
});
