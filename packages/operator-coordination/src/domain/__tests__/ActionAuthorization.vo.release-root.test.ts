import { describe, expect, it } from 'vitest';
import { ActionAuthorization } from '../value-objects/ActionAuthorization.vo.js';

const base = {
  grantId: 'g-1',
  projectId: 'p',
  actionScope: 'release:install',
  expectedHeadSha: 'a'.repeat(40),
  policyRevision: 'pol-1',
  decisionRevision: 'dec-1',
  consumed: false,
};

describe('ActionAuthorization releaseRoot', () => {
  it('accepts an absent or valid root', () => {
    expect(ActionAuthorization.create(base).success).toBe(true);
    expect(ActionAuthorization.create({ ...base, releaseRoot: '/srv/fleet/releases' }).success).toBe(true);
  });

  it('rejects, never throws, a throwing or value-returning releaseRoot accessor and invalid values', () => {
    const throwing = Object.defineProperty({ ...base }, 'releaseRoot', {
      enumerable: true,
      get() {
        throw new Error('hostile getter ran');
      },
    });
    const returning = Object.defineProperty({ ...base }, 'releaseRoot', {
      enumerable: true,
      get: () => '/srv/fleet/releases',
    });
    const trapped = new Proxy(
      { ...base },
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    for (const props of [
      throwing,
      returning,
      trapped,
      { ...base, releaseRoot: 7 },
      { ...base, releaseRoot: null },
      { ...base, releaseRoot: '' },
      { ...base, releaseRoot: '/a/../b' },
    ]) {
      const created = ActionAuthorization.create(props as never);
      expect(created.success).toBe(false);
      expect(created.error).toBeInstanceOf(Error);
    }
  });
});
