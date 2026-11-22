/**
 * Unit tests for the RP1 `defaultBranch` mapping in ProjectProfileReadAdapter.
 */

import { describe, expect, it } from 'vitest';

import { ProjectProfileReadAdapter } from '../ProjectProfileReadAdapter.adapter.js';

function foundAnswer(profile: Record<string, unknown>): unknown {
  return { outcome: 'found', profile };
}

function baseProfile(): Record<string, unknown> {
  return {
    projectId: 'proj-1',
    status: 'active',
    repository: 'git@example.org:acme/app.git',
    clones: {},
    gateProcedures: [],
    revision: 1,
  };
}

async function readProfile(profile: Record<string, unknown>): Promise<unknown> {
  const adapter = new ProjectProfileReadAdapter({
    inspect: async () => foundAnswer(profile),
  });
  return adapter.readProjectProfile('proj-1');
}

describe('ProjectProfileReadAdapter defaultBranch (RP1)', () => {
  it('maps an absent, undefined, or null defaultBranch to null', async () => {
    expect(await readProfile(baseProfile())).toMatchObject({ defaultBranch: null });
    expect(await readProfile({ ...baseProfile(), defaultBranch: undefined })).toMatchObject({
      defaultBranch: null,
    });
    expect(await readProfile({ ...baseProfile(), defaultBranch: null })).toMatchObject({
      defaultBranch: null,
    });
  });

  it('maps a safe declared branch such as staging through unchanged', async () => {
    expect(await readProfile({ ...baseProfile(), defaultBranch: 'staging' })).toMatchObject({
      defaultBranch: 'staging',
    });
  });

  it('throws malformed for empty, non-string, oversized, and unsafe defaultBranch values', async () => {
    for (const defaultBranch of ['', '   ', 42, true, '../x', '-x', 'a..b', 'x.lock', 'a//b', 'a'.repeat(201)]) {
      await expect(readProfile({ ...baseProfile(), defaultBranch })).rejects.toThrow(
        'ProjectProfileReadAdapter received a malformed profile for proj-1',
      );
    }
  });

  it('throws malformed for a non-object answer, a null profile, and a rejected outcome', async () => {
    const adapter = new ProjectProfileReadAdapter({ inspect: async () => 42 });
    await expect(adapter.readProjectProfile('proj-1')).rejects.toThrow('malformed profile');
    const nullProfile = new ProjectProfileReadAdapter({
      inspect: async () => ({ outcome: 'found', profile: null }),
    });
    await expect(nullProfile.readProjectProfile('proj-1')).rejects.toThrow('malformed profile');
    const rejected = new ProjectProfileReadAdapter({
      inspect: async () => ({ outcome: 'rejected', reason: 'denied' }),
    });
    await expect(rejected.readProjectProfile('proj-1')).rejects.toThrow('denied');
  });

  it('throws malformed when defaultBranch is an accessor, without invoking it', async () => {
    let called = false;
    const profile = baseProfile();
    Object.defineProperty(profile, 'defaultBranch', {
      enumerable: true,
      configurable: true,
      get() {
        called = true;
        throw new Error('getter must never run');
      },
    });
    await expect(readProfile(profile)).rejects.toThrow('malformed profile');
    expect(called).toBe(false);
  });

  it('throws malformed when the profile carries a prototype-polluting own key', async () => {
    const profile = baseProfile();
    Object.defineProperty(profile, '__proto__', {
      value: {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
    await expect(readProfile(profile)).rejects.toThrow('malformed profile');
    await expect(readProfile({ ...baseProfile(), constructor: Object })).rejects.toThrow(
      'malformed profile',
    );
    await expect(readProfile({ ...baseProfile(), prototype: {} })).rejects.toThrow(
      'malformed profile',
    );
  });
});
