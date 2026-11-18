// SH20: unit tests for the `readCurrentReleaseSha` helper — every refusal
// path returns `null` and the single positive path returns `current` only
// when it names a verified build.
import { describe, expect, it } from 'vitest';

import type { ReleaseBuildRecord, ReleaseStoreListing, ReleaseStorePort } from '@fleet/work-execution';

import { readCurrentReleaseSha } from '../shadow-release-sha.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function build(sha: string): ReleaseBuildRecord {
  return { sha, builtAtIso: '2026-06-01T00:00:00.000Z' };
}

function storeOf(list: () => ReleaseStoreListing | Promise<ReleaseStoreListing>): Pick<ReleaseStorePort, 'list'> {
  return {
    list: async () => {
      const listing = await list();
      return listing;
    },
  };
}

describe('readCurrentReleaseSha (SH20)', () => {
  it('returns null for an empty releaseRoot without calling list', async () => {
    let calls = 0;
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => {
        calls += 1;
        throw new Error('list must not be called');
      }),
      releaseRoot: '',
    });
    expect(sha).toBeNull();
    expect(calls).toBe(0);
  });

  it('returns null when list reports the root unreadable', async () => {
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => ({ outcome: 'unreadable' })),
      releaseRoot: '/srv/fleet',
    });
    expect(sha).toBeNull();
  });

  it('returns null when list throws', async () => {
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => {
        throw new Error('disk exploded');
      }),
      releaseRoot: '/srv/fleet',
    });
    expect(sha).toBeNull();
  });

  it('returns null when the installed current is absent', async () => {
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => ({ outcome: 'read', current: null, builds: [build(SHA)] })),
      releaseRoot: '/srv/fleet',
    });
    expect(sha).toBeNull();
  });

  it('returns null when current does not match the release sha pattern', async () => {
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => ({ outcome: 'read', current: 'not-a-sha', builds: [] })),
      releaseRoot: '/srv/fleet',
    });
    expect(sha).toBeNull();
  });

  it('returns null when current names a sha absent from the verified builds', async () => {
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => ({ outcome: 'read', current: SHA, builds: [build(OTHER_SHA)] })),
      releaseRoot: '/srv/fleet',
    });
    expect(sha).toBeNull();
  });

  it('returns current when it matches the pattern and names a verified build', async () => {
    const sha = await readCurrentReleaseSha({
      releaseStore: storeOf(() => ({ outcome: 'read', current: SHA, builds: [build(OTHER_SHA), build(SHA)] })),
      releaseRoot: '/srv/fleet',
    });
    expect(sha).toBe(SHA);
  });
});
