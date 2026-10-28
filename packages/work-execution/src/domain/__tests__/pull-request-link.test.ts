import { describe, expect, it } from 'vitest';

import {
  decidePullRequestLink,
  PullRequestLink,
  pullRequestLinkKey,
} from '../entities/PullRequestLink.js';
import { PULL_REQUEST_LINK_SOURCES } from '../lane-plan-records.js';
import type { PullRequestLinkRecord } from '../lane-plan-records.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const VALID: PullRequestLinkRecord = {
  version: 1,
  repository: 'example-org/example-repo',
  number: 251,
  projectId: 'example-project',
  planId: '2026-10-27_example',
  laneId: 'A3',
  source: 'sidecar',
  linkedAtIso: '2026-10-27T12:00:00.000Z',
};

function createError(input: unknown): string {
  const result = PullRequestLink.create(input);
  if (result.success) {
    throw new Error('expected create failure');
  }
  return result.error.message;
}

function patched(patch: (record: Record<string, unknown>) => void): Record<string, unknown> {
  const record = structuredClone(VALID) as unknown as Record<string, unknown>;
  patch(record);
  return record;
}

describe('PullRequestLink.create', () => {
  it('round-trips a valid record', () => {
    const result = PullRequestLink.create(VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.toRecord()).toEqual(VALID);
    expect(result.value.getKey()).toBe('example-org/example-repo#251');
  });

  it('accepts a lane with no plan (planId null)', () => {
    const result = PullRequestLink.create(patched((record) => { record.planId = null; }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.getPlanId()).toBeNull();
  });

  it('accepts every source', () => {
    for (const source of PULL_REQUEST_LINK_SOURCES) {
      const result = PullRequestLink.create(patched((record) => { record.source = source; }));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.value.getSource()).toBe(source);
    }
  });

  it('refuses broken records with their exact messages, never echoing a value', () => {
    expect(createError(patched((record) => { record.number = 0; })))
      .toBe('PullRequestLink number: must be a positive integer');
    expect(createError(patched((record) => { record.number = 1.5; })))
      .toBe('PullRequestLink number: must be a positive integer');
    expect(createError(patched((record) => { record.repository = 'a b'; })))
      .toBe('PullRequestLink repository: must be a repository name');
    expect(createError(patched((record) => { record.source = 'title'; })))
      .toBe('PullRequestLink source must be one of fleet-forge-action, run, sidecar, cli');
    expect(createError(patched((record) => { record.laneId = 'a/b'; })))
      .toBe('PullRequestLink laneId: must be a lane id');
    expect(createError(patched((record) => { record.extra = 1; })))
      .toBe('PullRequestLink must have exactly its record fields');
    expect(createError(patched((record) => { record.version = 2; })))
      .toBe('PullRequestLink version must be 1');
    expect(createError(patched((record) => { record.linkedAtIso = '2026-10-27T12:00:00Z'; })))
      .toBe('PullRequestLink linkedAtIso must be a canonical UTC timestamp');

    const secret = fakeSecretShape();
    const secretMessage = createError(patched((record) => { record.repository = secret; }));
    expect(secretMessage).toBe('PullRequestLink repository: contains a secret-shaped value and was refused');
    expect(secretMessage).not.toContain(secret);
  });
});

describe('pullRequestLinkKey', () => {
  it('joins repository and number with #', () => {
    expect(pullRequestLinkKey({ repository: 'example-org/example-repo', number: 251 }))
      .toBe('example-org/example-repo#251');
  });
});

describe('decidePullRequestLink', () => {
  it('creates when nothing is stored', () => {
    expect(decidePullRequestLink(null, VALID)).toBe('create');
  });

  it('repeats are a no-op whatever the source or time', () => {
    expect(
      decidePullRequestLink(VALID, {
        ...VALID,
        source: 'cli',
        linkedAtIso: '2026-10-27T13:30:00.000Z',
      }),
    ).toBe('no-op');
  });

  it('refuses a second lane on the same pull request', () => {
    expect(
      decidePullRequestLink(VALID, { ...VALID, laneId: 'A1' }),
    ).toBe('pr-already-linked');
  });

  it('refuses a link whose planId differs (null against a plan)', () => {
    expect(
      decidePullRequestLink(VALID, { ...VALID, planId: null }),
    ).toBe('pr-already-linked');
  });

  it('refuses a stored link for another pull request number', () => {
    expect(
      decidePullRequestLink({ ...VALID, number: 252 }, VALID),
    ).toBe('pr-already-linked');
  });
});
