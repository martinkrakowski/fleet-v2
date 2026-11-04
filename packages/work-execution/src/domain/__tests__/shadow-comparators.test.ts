// Lane CO31: pure shadow comparators for the cutover shadow period.
import { describe, expect, it } from 'vitest';

import {
  compareShadowBriefVerdicts,
  compareShadowChainMembers,
  compareShadowEnqueueSets,
  compareShadowGateVerdicts,
  compareShadowMergeSets,
  compareShadowPremergeStatuses,
} from '../shadow-comparators.js';
import type { ShadowMergeSetItem } from '../shadow-comparators.js';

/** Secret-shaped fakes are assembled from inert pieces (CO4 test precedent). */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const FIRST_HEAD = '0123456789abcdef0123456789abcdef01234567';
const SECOND_HEAD = '0123456789abcdef0123456789abcdef01234568';

describe('shadow comparators', () => {
  it('merge sets: equal sets are equal with no divergences', () => {
    const fleet = [{ pullRequest: 42, headOid: FIRST_HEAD }];
    const shell = [{ pullRequest: 42, headOid: FIRST_HEAD }];
    expect(compareShadowMergeSets({ fleet, shell })).toEqual({
      kind: 'merge-set',
      equal: true,
      compared: 1,
      fleetCount: 1,
      shellCount: 1,
      divergences: [],
      truncated: false,
    });
  });

  it('merge sets: a one-sided key is missing-in-shell or missing-in-fleet', () => {
    const onlyFleet = compareShadowMergeSets({
      fleet: [{ pullRequest: 1, headOid: FIRST_HEAD }],
      shell: [],
    });
    expect(onlyFleet.equal).toBe(false);
    expect(onlyFleet.divergences).toEqual([
      { key: `1@${FIRST_HEAD}`, code: 'missing-in-shell', fleet: 'would-merge', shell: null },
    ]);

    const onlyShell = compareShadowMergeSets({
      fleet: [],
      shell: [{ pullRequest: 2, headOid: SECOND_HEAD }],
    });
    expect(onlyShell.divergences).toEqual([
      { key: `2@${SECOND_HEAD}`, code: 'missing-in-fleet', fleet: null, shell: 'merged' },
    ]);
  });

  it('enqueue sets: the same pull request, head and base compare equal and a different base is one-sided', () => {
    const same = compareShadowEnqueueSets({
      fleet: [{ pullRequest: 7, headOid: FIRST_HEAD, base: 'main' }],
      shell: [{ pullRequest: 7, headOid: FIRST_HEAD, base: 'main' }],
    });
    expect(same.equal).toBe(true);
    expect(same.compared).toBe(1);

    const differentBase = compareShadowEnqueueSets({
      fleet: [{ pullRequest: 7, headOid: FIRST_HEAD, base: 'main' }],
      shell: [{ pullRequest: 7, headOid: FIRST_HEAD, base: 'chain/a' }],
    });
    expect(differentBase.divergences).toEqual([
      { key: `7@${FIRST_HEAD}@chain/a`, code: 'missing-in-fleet', fleet: null, shell: 'queued' },
      { key: `7@${FIRST_HEAD}@main`, code: 'missing-in-shell', fleet: 'queued', shell: null },
    ]);
  });

  it('gate verdicts: a fleet pass against a shell fail is false-pass', () => {
    const result = compareShadowGateVerdicts({
      fleet: [{ headOid: FIRST_HEAD, predicate: 'checks', verdict: 'pass' }],
      shell: [{ headOid: FIRST_HEAD, predicate: 'checks', verdict: 'fail' }],
    });
    expect(result.divergences).toEqual([
      { key: `${FIRST_HEAD}#checks`, code: 'false-pass', fleet: 'pass', shell: 'fail' },
    ]);
  });

  it('gate verdicts: a fleet fail against a shell pass is stricter-fail', () => {
    const result = compareShadowGateVerdicts({
      fleet: [{ headOid: FIRST_HEAD, predicate: 'checks', verdict: 'fail' }],
      shell: [{ headOid: FIRST_HEAD, predicate: 'checks', verdict: 'pass' }],
    });
    expect(result.divergences).toEqual([
      { key: `${FIRST_HEAD}#checks`, code: 'stricter-fail', fleet: 'fail', shell: 'pass' },
    ]);
  });

  it('gate verdicts: any other verdict difference is value-differs', () => {
    const result = compareShadowGateVerdicts({
      fleet: [{ headOid: FIRST_HEAD, predicate: 'checks', verdict: 'unknown' }],
      shell: [{ headOid: FIRST_HEAD, predicate: 'checks', verdict: 'fail' }],
    });
    expect(result.divergences).toEqual([
      { key: `${FIRST_HEAD}#checks`, code: 'value-differs', fleet: 'unknown', shell: 'fail' },
    ]);
  });

  it('premerge status: the same state per head compares equal and a one-sided state is reported', () => {
    const same = compareShadowPremergeStatuses({
      fleet: [{ headOid: FIRST_HEAD, state: 'success' }],
      shell: [{ headOid: FIRST_HEAD, state: 'success' }],
    });
    expect(same.equal).toBe(true);
    expect(same.compared).toBe(1);

    const oneSided = compareShadowPremergeStatuses({
      fleet: [{ headOid: FIRST_HEAD, state: 'failure' }],
      shell: [{ headOid: SECOND_HEAD, state: 'success' }],
    });
    expect(oneSided.divergences).toEqual([
      { key: FIRST_HEAD, code: 'missing-in-shell', fleet: 'failure', shell: null },
      { key: SECOND_HEAD, code: 'missing-in-fleet', fleet: null, shell: 'success' },
    ]);
  });

  it('chain members: the same member compares equal and a one-sided member is reported', () => {
    const same = compareShadowChainMembers({
      fleet: [{ chain: 'example-1', pullRequest: 7, headOid: FIRST_HEAD }],
      shell: [{ chain: 'example-1', pullRequest: 7, headOid: FIRST_HEAD }],
    });
    expect(same.equal).toBe(true);
    expect(same.compared).toBe(1);

    const oneSided = compareShadowChainMembers({
      fleet: [{ chain: 'example-1', pullRequest: 7, headOid: FIRST_HEAD }],
      shell: [],
    });
    expect(oneSided.divergences).toEqual([
      { key: `example-1@7@${FIRST_HEAD}`, code: 'missing-in-shell', fleet: 'member', shell: null },
    ]);
  });

  it('brief verdicts: the same code compares equal and a different code is value-differs', () => {
    const same = compareShadowBriefVerdicts({
      fleet: [{ briefId: 'CO31', verdict: 'ok' }],
      shell: [{ briefId: 'CO31', verdict: 'ok' }],
    });
    expect(same.equal).toBe(true);
    expect(same.compared).toBe(1);

    const different = compareShadowBriefVerdicts({
      fleet: [{ briefId: 'CO31', verdict: 'ok' }],
      shell: [{ briefId: 'CO31', verdict: 'rejected' }],
    });
    expect(different.divergences).toEqual([
      { key: 'CO31', code: 'value-differs', fleet: 'ok', shell: 'rejected' },
    ]);
  });

  it('an invalid item is invalid-item and its value is never echoed', () => {
    const rejected = 'not-a-hex-head';
    const result = compareShadowMergeSets({
      fleet: [{ pullRequest: 1, headOid: rejected }],
      shell: [],
    });
    expect(result.equal).toBe(false);
    expect(result.divergences).toEqual([
      { key: 'invalid-fleet-0', code: 'invalid-item', fleet: null, shell: null },
    ]);
    expect(JSON.stringify(result)).not.toContain(rejected);
  });

  it('a secret-shaped id is invalid-item and never echoed', () => {
    const secret = fakeSecretShape();
    const result = compareShadowBriefVerdicts({
      fleet: [{ briefId: secret, verdict: 'ok' }],
      shell: [],
    });
    expect(result.divergences).toEqual([
      { key: 'invalid-fleet-0', code: 'invalid-item', fleet: null, shell: null },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('a duplicated key on one side is invalid-item', () => {
    const result = compareShadowMergeSets({
      fleet: [
        { pullRequest: 1, headOid: FIRST_HEAD },
        { pullRequest: 1, headOid: FIRST_HEAD },
      ],
      shell: [{ pullRequest: 1, headOid: FIRST_HEAD }],
    });
    expect(result.equal).toBe(false);
    expect(result.compared).toBe(0);
    expect(result.divergences).toEqual([
      { key: `1@${FIRST_HEAD}`, code: 'invalid-item', fleet: null, shell: null },
    ]);
  });

  it('the divergences are sorted by key and capped at 50 with truncated set', () => {
    const fleet = Array.from({ length: 51 }, (_, index) => ({
      pullRequest: index + 1,
      headOid: FIRST_HEAD,
    }));
    const result = compareShadowMergeSets({ fleet, shell: [] });
    const expectedKeys = fleet.map((item) => `${item.pullRequest}@${FIRST_HEAD}`).sort();
    expect(result.truncated).toBe(true);
    expect(result.divergences).toHaveLength(50);
    expect(result.fleetCount).toBe(51);
    expect(result.shellCount).toBe(0);
    expect(result.compared).toBe(0);
    expect(result.divergences.map((divergence) => divergence.key)).toEqual(expectedKeys.slice(0, 50));
    expect(result.divergences.every((divergence) => divergence.code === 'missing-in-shell')).toBe(true);
  });

  it('the result exposes only the documented keys and is frozen', () => {
    const result = compareShadowMergeSets({ fleet: [], shell: [] });
    expect(Object.keys(result)).toEqual([
      'kind',
      'equal',
      'compared',
      'fleetCount',
      'shellCount',
      'divergences',
      'truncated',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.divergences)).toBe(true);
  });

  it('a non-array side is invalid-item and the comparator never throws', () => {
    const result = compareShadowMergeSets({
      fleet: undefined as unknown as readonly ShadowMergeSetItem[],
      shell: [],
    });
    expect(result.equal).toBe(false);
    expect(result.divergences).toEqual([
      { key: 'invalid-fleet-list', code: 'invalid-item', fleet: null, shell: null },
    ]);
    expect(result.fleetCount).toBe(0);

    const shellSide = compareShadowMergeSets({
      fleet: [],
      shell: 'not-an-array' as unknown as readonly ShadowMergeSetItem[],
    });
    expect(shellSide.divergences).toEqual([
      { key: 'invalid-shell-list', code: 'invalid-item', fleet: null, shell: null },
    ]);
  });
  it('a github_pat_ brief id is invalid-item and never echoed (both registries are checked)', () => {
    const secret = `github${'_pat_'}${'A'.repeat(24)}`;
    const result = compareShadowBriefVerdicts({ fleet: [{ briefId: secret, verdict: 'ok' }], shell: [] });
    expect(result.divergences).toEqual([
      { key: 'invalid-fleet-0', code: 'invalid-item', fleet: null, shell: null },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('a secret-shaped brief verdict is invalid-item and never echoed', () => {
    const secret = `s${'k-'}${'a'.repeat(22)}`;
    const result = compareShadowBriefVerdicts({
      fleet: [{ briefId: 'brief-1', verdict: secret }],
      shell: [{ briefId: 'brief-1', verdict: 'ok' }],
    });
    expect(result.divergences.map((divergence) => divergence.code)).toContain('invalid-item');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('an item with an accessor property is invalid-item and the getter never runs', () => {
    let calls = 0;
    const item = {};
    Object.defineProperty(item, 'headOid', { enumerable: true, get: () => { calls += 1; return FIRST_HEAD; } });
    Object.defineProperty(item, 'pullRequest', { enumerable: true, value: 1 });
    const result = compareShadowMergeSets({ fleet: [item as ShadowMergeSetItem], shell: [] });
    expect(result.divergences).toEqual([
      { key: 'invalid-fleet-0', code: 'invalid-item', fleet: null, shell: null },
    ]);
    expect(calls).toBe(0);
  });
  it('a secret-shaped base is invalid-item and never echoed', () => {
    const base = `chain/${'antigravity-oauth'}-token`;
    const result = compareShadowEnqueueSets({ fleet: [{ pullRequest: 1, headOid: FIRST_HEAD, base }], shell: [] });
    expect(JSON.stringify(result)).not.toContain('oauth');
  });

  it('an inherited field is never read: a prototype getter does not make an item valid', () => {
    let calls = 0;
    Object.defineProperty(Object.prototype, 'headOid', { configurable: true, get: () => { calls += 1; return FIRST_HEAD; } });
    try {
      const result = compareShadowMergeSets({ fleet: [{ pullRequest: 1 } as unknown as ShadowMergeSetItem], shell: [] });
      expect(result.divergences).toEqual([
        { key: 'invalid-fleet-0', code: 'invalid-item', fleet: null, shell: null },
      ]);
      expect(calls).toBe(0);
    } finally {
      delete (Object.prototype as Record<string, unknown>).headOid;
    }
  });
});
