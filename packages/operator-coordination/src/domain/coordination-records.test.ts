/**
 * KEY0c2 unit tests for the domain helpers `isSignedDecisionRequired` and
 * `verifySignedDecisionBinding`: the closed-kind exemptions, the binding
 * equality, and the hostile-input battery (every exported function takes
 * `unknown` at its boundary and never throws — each refusal is a typed result
 * carrying a named error code).
 */

import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from './coordination-records.js';
import { isSignedDecisionRequired, verifySignedDecisionBinding } from './coordination-records.js';

function requestRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return {
    id: 'request-1',
    projectId: 'project-atlas',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'release:install',
    expectedHeadSha: 'abc123',
    proposalDigest: 'digest-1',
    policyRevision: 'policy-7',
    decisionRevision: 'decision-3',
    grantId: 'grant-9',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-11-18T00:00:00.000Z',
    updatedAtIso: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('isSignedDecisionRequired', () => {
  it('requires a signed decision for an owner-gated release record', () => {
    expect(isSignedDecisionRequired(requestRecord())).toBe(true);
  });

  it('requires a signed decision for a merge:import-shadow record', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({ actionScope: 'merge:import-shadow' }),
      ),
    ).toBe(true);
  });

  it('requires a signed decision for an owner-decision record', () => {
    expect(
      isSignedDecisionRequired(requestRecord({ actionScope: 'owner-decision:request-1' })),
    ).toBe(true);
  });

  it('exempts a valid policy grant bound to its own forge kind and source', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({
          actionScope: 'forge:merge-pr',
          decisionRevision: 'policy:autoMerge@0123456789ab',
          policyGrant: { workOrderId: 'wo-1', attemptId: 'att-1', acceptanceReceiptId: 'r-1' },
        }),
      ),
    ).toBe(false);
  });

  it('exempts a valid attempt-less merge grant bound to a merge forge kind', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({
          actionScope: 'forge:update-branch',
          decisionRevision: 'policy:merge@0123456789ab',
          mergeGrant: { repository: { owner: 'o', repo: 'r' }, pullRequestNumber: 1 },
        }),
      ),
    ).toBe(false);
  });

  it('never exempts a policyGrant present on an unrelated scope such as release:*', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({
          policyGrant: { workOrderId: 'wo-1', attemptId: 'att-1', acceptanceReceiptId: 'r-1' },
        }),
      ),
    ).toBe(true);
  });

  it('never exempts a policyGrant on a forge scope whose setting source does not match', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({
          actionScope: 'forge:merge-pr',
          decisionRevision: 'policy:conductor@0123456789ab',
          policyGrant: { workOrderId: 'wo-1', attemptId: 'att-1', acceptanceReceiptId: 'r-1' },
        }),
      ),
    ).toBe(true);
  });

  it('never exempts a mergeGrant on an unrelated scope such as release:*', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({
          mergeGrant: { repository: { owner: 'o', repo: 'r' }, pullRequestNumber: 1 },
        }),
      ),
    ).toBe(true);
  });

  it('never exempts a mergeGrant whose revision is malformed', () => {
    expect(
      isSignedDecisionRequired(
        requestRecord({
          actionScope: 'forge:merge-pr',
          decisionRevision: 'policy:merge@short',
          mergeGrant: { repository: { owner: 'o', repo: 'r' }, pullRequestNumber: 1 },
        }),
      ),
    ).toBe(true);
  });
});

describe('verifySignedDecisionBinding', () => {
  function validAnswer(): Record<string, unknown> {
    return {
      state: 'approved',
      requestId: 'request-1',
      actionScope: 'release:install',
      grantId: 'grant-9',
      decisionRevision: 'decision-3',
    };
  }

  it('binds a matching record and answer', () => {
    expect(verifySignedDecisionBinding(requestRecord(), validAnswer())).toEqual({ ok: true });
  });

  it('binds when the answer carries no own requestId or actionScope', () => {
    const { requestId, actionScope, ...answer } = validAnswer();
    void requestId;
    void actionScope;
    expect(verifySignedDecisionBinding(requestRecord(), answer)).toEqual({ ok: true });
  });

  it('refuses a record with an empty actionScope even when the answer omits actionScope', () => {
    const { actionScope, ...answer } = validAnswer();
    void actionScope;
    expect(
      verifySignedDecisionBinding(requestRecord({ actionScope: '' }), answer),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
    expect(
      verifySignedDecisionBinding(requestRecord({ actionScope: null as never }), answer),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses a non-approved answer with decision-binding-not-approved', () => {
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), state: 'declined' }),
    ).toEqual({ ok: false, code: 'decision-binding-not-approved' });
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), state: 'awaiting-decision' }),
    ).toEqual({ ok: false, code: 'decision-binding-not-approved' });
  });

  it('refuses a mismatched requestId with decision-binding-mismatch', () => {
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), requestId: 'request-2' }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses a mismatched actionScope with decision-binding-mismatch', () => {
    expect(
      verifySignedDecisionBinding(requestRecord(), {
        ...validAnswer(),
        actionScope: 'release:swap',
      }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses a mismatched grantId with decision-binding-mismatch', () => {
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), grantId: 'grant-8' }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses a mismatched decisionRevision with decision-binding-mismatch', () => {
    expect(
      verifySignedDecisionBinding(requestRecord(), {
        ...validAnswer(),
        decisionRevision: 'decision-4',
      }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses a missing grantId or decisionRevision on either side', () => {
    expect(
      verifySignedDecisionBinding(requestRecord({ grantId: null }), validAnswer()),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), grantId: undefined }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), decisionRevision: null }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses an oversized bound field before any comparison', () => {
    const long = 'a'.repeat(513);
    expect(
      verifySignedDecisionBinding(requestRecord({ grantId: long }), validAnswer()),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
    expect(
      verifySignedDecisionBinding(requestRecord(), { ...validAnswer(), grantId: long }),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('binds a field exactly at the length cap', () => {
    const atCap = 'a'.repeat(512);
    expect(
      verifySignedDecisionBinding(
        requestRecord({ grantId: atCap }),
        { ...validAnswer(), grantId: atCap },
      ),
    ).toEqual({ ok: true });
  });

  it('refuses a null record input with decision-binding-invalid-input and never throws', () => {
    expect(verifySignedDecisionBinding(null, validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses an undefined answer input with decision-binding-invalid-input', () => {
    expect(verifySignedDecisionBinding(requestRecord(), undefined)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses a wrong primitive where an object is due with decision-binding-invalid-input', () => {
    expect(verifySignedDecisionBinding(7, validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
    expect(verifySignedDecisionBinding(requestRecord(), 'approved')).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses an array where an object is due with decision-binding-invalid-input', () => {
    expect(verifySignedDecisionBinding([requestRecord()], validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses a sparse array with a hole before any traversal', () => {
    const sparse: unknown[] = [];
    sparse[0] = requestRecord();
    sparse[2] = validAnswer();
    expect(verifySignedDecisionBinding(sparse, validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses a custom-prototype record before any comparison', () => {
    class HostileRecord {}
    const record = Object.assign(new HostileRecord(), requestRecord());
    const answer = Object.assign(new HostileRecord(), validAnswer());
    expect(verifySignedDecisionBinding(record, answer)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses an array-like object { length: 1, 0: ... } with a typed refusal', () => {
    const arrayLike = { length: 1, 0: requestRecord() };
    // A plain array-like object is not an array, but it carries no bound
    // `id` field: the binding refuses it with the field code, never throws.
    expect(verifySignedDecisionBinding(arrayLike, validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-mismatch',
    });
  });

  it('refuses an enormous sparse array of length 2**32 - 1 before any traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    enormous[0] = requestRecord();
    expect(verifySignedDecisionBinding(enormous, validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('never runs a getter on the root or on an item and refuses it as invalid-input', () => {
    let rootCalls = 0;
    const root: Record<string, unknown> = { ...requestRecord() };
    Object.defineProperty(root, 'grantId', {
      get() {
        rootCalls += 1;
        return 'grant-9';
      },
      enumerable: true,
    });
    expect(verifySignedDecisionBinding(root, validAnswer())).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
    expect(rootCalls).toBe(0);

    let answerCalls = 0;
    const answer: Record<string, unknown> = validAnswer();
    Object.defineProperty(answer, 'grantId', {
      get() {
        answerCalls += 1;
        return 'grant-9';
      },
      enumerable: true,
    });
    expect(verifySignedDecisionBinding(requestRecord(), answer)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
    expect(answerCalls).toBe(0);
  });

  it('yields exactly the plain-data result for a Proxy over a valid input with no get trap run', () => {
    let traps = 0;
    const proxy = new Proxy(validAnswer(), {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = verifySignedDecisionBinding(requestRecord(), proxy);
    expect(result).toEqual({ ok: true });
    expect(traps).toBe(0);

    let hostileTraps = 0;
    const hostile = new Proxy(validAnswer(), {
      getOwnPropertyDescriptor() {
        hostileTraps += 1;
        throw new Error('hostile proxy descriptor');
      },
    });
    expect(verifySignedDecisionBinding(requestRecord(), hostile)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
    expect(hostileTraps).toBe(1);
  });

  it('refuses a prototype-polluting own key produced by JSON.parse before any comparison', () => {
    const polluting = JSON.parse(
      '{"state":"approved","grantId":"grant-9","decisionRevision":"decision-3","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    expect(verifySignedDecisionBinding(requestRecord(), polluting)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a constant-verdict implementation could not satisfy this function (mismatch is refused)', () => {
    // A function returning a constant `{ ok: true }` would authorize the
    // mismatched pair below; the real binding refuses it.
    expect(
      verifySignedDecisionBinding(
        requestRecord({ grantId: 'grant-8' }),
        validAnswer(),
      ),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('an identity echo of the input could not satisfy this function (an answer echoed as the record is refused)', () => {
    // `verify(answer, answer)` — an identity echo — is refused: the answer
    // carries no bound record `id` field, so a constant-echo implementation
    // would have to fail here while the real binding refuses it.
    expect(
      verifySignedDecisionBinding(validAnswer(), validAnswer()),
    ).toEqual({ ok: false, code: 'decision-binding-mismatch' });
  });

  it('refuses a revoked Proxy without throwing and reports it as invalid-input', () => {
    const revoked = Proxy.revocable(validAnswer(), {});
    revoked.revoke();
    expect(() => verifySignedDecisionBinding(requestRecord(), revoked.proxy)).not.toThrow();
    expect(verifySignedDecisionBinding(requestRecord(), revoked.proxy)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses a throwing getPrototypeOf trap without throwing and reports it as invalid-input', () => {
    const throwing = new Proxy(validAnswer(), {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf trap');
      },
    });
    expect(() => verifySignedDecisionBinding(requestRecord(), throwing)).not.toThrow();
    expect(verifySignedDecisionBinding(requestRecord(), throwing)).toEqual({
      ok: false,
      code: 'decision-binding-invalid-input',
    });
  });

  it('refuses a present own requestId with value null instead of treating it as absent', () => {
    const answer: Record<string, unknown> = { ...validAnswer(), requestId: null };
    expect(verifySignedDecisionBinding(requestRecord(), answer)).toEqual({
      ok: false,
      code: 'decision-binding-mismatch',
    });
  });

  it('refuses a present own actionScope with value null instead of treating it as absent', () => {
    const answer: Record<string, unknown> = { ...validAnswer(), actionScope: null };
    expect(verifySignedDecisionBinding(requestRecord(), answer)).toEqual({
      ok: false,
      code: 'decision-binding-mismatch',
    });
  });

  it('refuses a present own identity field with any other non-string value', () => {
    const answer: Record<string, unknown> = { ...validAnswer(), requestId: 42 };
    expect(verifySignedDecisionBinding(requestRecord(), answer)).toEqual({
      ok: false,
      code: 'decision-binding-mismatch',
    });
    const blank: Record<string, unknown> = { ...validAnswer(), actionScope: '' };
    expect(verifySignedDecisionBinding(requestRecord(), blank)).toEqual({
      ok: false,
      code: 'decision-binding-mismatch',
    });
  });
});
