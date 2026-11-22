// RP1: `isSafeWorkOrderBranchName` and `resolveProfileDefaultBranch`.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_BRANCH,
  isSafeWorkOrderBranchName,
  resolveProfileDefaultBranch,
} from '../base-branch.js';

/** Secret-shaped fakes are assembled from inert pieces (lane-run.test.ts precedent). */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

describe('isSafeWorkOrderBranchName', () => {
  it.each(['main', 'staging', 'chain/example-1', 'release/2026.11', 'a.b_c'])('accepts %j', (branch) => {
    expect(isSafeWorkOrderBranchName(branch)).toBe(true);
  });

  it.each([
    '',
    '-x',
    '/x',
    'x/',
    'x.',
    'x.lock',
    'a..b',
    'a//b',
    '../x',
    'has space',
    42,
    null,
    undefined,
    fakeSecretShape(),
  ])('refuses %j', (branch) => {
    expect(isSafeWorkOrderBranchName(branch)).toBe(false);
  });

  it('accepts exactly 200 characters and refuses 201', () => {
    expect(isSafeWorkOrderBranchName('a'.repeat(200))).toBe(true);
    expect(isSafeWorkOrderBranchName('a'.repeat(201))).toBe(false);
  });
});

describe('resolveProfileDefaultBranch', () => {
  it('falls back to main when defaultBranch is absent, undefined, or null', () => {
    expect(resolveProfileDefaultBranch({ status: 'active' })).toEqual({
      ok: true,
      baseBranch: DEFAULT_BASE_BRANCH,
    });
    expect(resolveProfileDefaultBranch({ defaultBranch: undefined })).toEqual({
      ok: true,
      baseBranch: DEFAULT_BASE_BRANCH,
    });
    expect(resolveProfileDefaultBranch({ defaultBranch: null })).toEqual({
      ok: true,
      baseBranch: DEFAULT_BASE_BRANCH,
    });
  });

  it('refuses a safe but unsupported defaultBranch such as staging with unsupported-profile-base', () => {
    expect(resolveProfileDefaultBranch({ defaultBranch: 'staging' })).toEqual({
      ok: false,
      reason: 'unsupported-profile-base',
    });
    expect(resolveProfileDefaultBranch({ defaultBranch: 'release/2026.11' })).toEqual({
      ok: false,
      reason: 'unsupported-profile-base',
    });
  });

  it('refuses empty, non-string, oversized, and unsafe profile defaultBranch values', () => {
    const holey: unknown[] = [1];
    delete holey[0];
    for (const value of [
      '',
      '   ',
      42,
      true,
      Symbol('x'),
      holey,
      { length: 1, 0: 'staging' },
      'a'.repeat(1_000_000),
      '../x',
      '-x',
      'a..b',
      'x.lock',
      'a//b',
      fakeSecretShape(),
    ]) {
      expect(resolveProfileDefaultBranch({ defaultBranch: value })).toEqual({
        ok: false,
        reason: 'malformed-profile',
      });
    }
  });

  it('refuses non-plain profile values with malformed-profile', () => {
    class Profile {
      defaultBranch = 'staging';
    }
    const holey: unknown[] = [1];
    delete holey[0];
    for (const profile of [null, undefined, 42, true, 'staging', Symbol('x'), holey, new Profile()]) {
      expect(resolveProfileDefaultBranch(profile)).toEqual({
        ok: false,
        reason: 'malformed-profile',
      });
    }
    const arrayLike = Object.assign(Object.create(null), { length: 1, 0: 'staging' });
    expect(resolveProfileDefaultBranch(arrayLike)).toEqual({ ok: true, baseBranch: DEFAULT_BASE_BRANCH });
  });

  it('refuses own __proto__, constructor, and prototype keys individually', () => {
    const withProto: Record<string, unknown> = { defaultBranch: 'staging' };
    Object.defineProperty(withProto, '__proto__', {
      value: {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(resolveProfileDefaultBranch(withProto)).toEqual({ ok: false, reason: 'malformed-profile' });

    expect(resolveProfileDefaultBranch({ constructor: Object })).toEqual({
      ok: false,
      reason: 'malformed-profile',
    });
    expect(resolveProfileDefaultBranch({ prototype: {} })).toEqual({
      ok: false,
      reason: 'malformed-profile',
    });
  });

  it('refuses accessor or throwing getter on defaultBranch without invoking it', () => {
    let called = false;
    const profile: Record<string, unknown> = {};
    Object.defineProperty(profile, 'defaultBranch', {
      enumerable: true,
      configurable: true,
      get() {
        called = true;
        throw new Error('getter must never run');
      },
    });
    expect(resolveProfileDefaultBranch(profile)).toEqual({ ok: false, reason: 'malformed-profile' });
    expect(called).toBe(false);
  });

  it('refuses an over-long defaultBranch by length before any scan', () => {
    // A 1,000,000-character string of safe-looking characters is still refused.
    expect(resolveProfileDefaultBranch({ defaultBranch: 'a'.repeat(1_000_000) })).toEqual({
      ok: false,
      reason: 'malformed-profile',
    });
  });
});
