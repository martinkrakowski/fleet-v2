import { describe, expect, it } from 'vitest';

import {
  MAX_DECISION_GRANT_ID_LENGTH,
  MAX_SIGN_DECISION_RECORD_KEYS,
  buildSignableDecisionFields,
  parseSignDecisionInput,
} from './decision-signing.js';

const REQUEST_ID = 'req-sign-1';
const PROJECT_ID = 'proj-1';
const SCOPE = 'forge:tests:run';
const HEAD = 'a'.repeat(40);

/** A real-shape `CoordinationRequestRecord` with 17 own keys. */
function awaitingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    projectId: PROJECT_ID,
    kind: 'action-decision',
    state: 'awaiting-decision',
    actionScope: SCOPE,
    expectedHeadSha: HEAD,
    proposalDigest: 'sha256-proposal',
    policyRevision: 'pol-rev-1',
    decisionRevision: null,
    grantId: null,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-11-18T00:00:00Z',
    updatedAtIso: '2026-11-18T00:00:00Z',
    ...overrides,
  };
}

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: REQUEST_ID, answer: 'approve', ...overrides };
}

describe('parseSignDecisionInput hostile inputs', () => {
  it('refuses null', () => {
    expect(parseSignDecisionInput(null)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses undefined', () => {
    expect(parseSignDecisionInput(undefined)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses a wrong primitive (a number where an object is due)', () => {
    expect(parseSignDecisionInput(7)).toEqual({ ok: false, code: 'invalid-sign-decision-input' });
  });

  it('refuses an array (a non-iterable-hostile object where an object is due)', () => {
    expect(parseSignDecisionInput([validInput()])).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses an array hole (a sparse array)', () => {
    const sparse: unknown[] = new Array(3);
    sparse[1] = validInput();
    expect(parseSignDecisionInput(sparse)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses an array-like object', () => {
    expect(parseSignDecisionInput({ length: 1, 0: validInput() })).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses an enormous length (a sparse array of length 2**32 - 1) before any traversal', () => {
    const enormous: unknown[] = new Array(2 ** 32 - 1);
    enormous[0] = validInput();
    expect(parseSignDecisionInput(enormous)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('never runs a getter on the root (the call counter stays 0)', () => {
    let getterRuns = 0;
    const input: Record<string, unknown> = {
      get requestId() {
        getterRuns += 1;
        return REQUEST_ID;
      },
      answer: 'approve',
    };
    expect(parseSignDecisionInput(input)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
    expect(getterRuns).toBe(0);
  });

  it('never runs a getter on an item', () => {
    let getterRuns = 0;
    const inner = {
      get answer() {
        getterRuns += 1;
        return 'approve';
      },
    };
    const input = { requestId: REQUEST_ID, extra: inner };
    expect(parseSignDecisionInput(input)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
    expect(getterRuns).toBe(0);
  });

  it('refuses a Proxy over a valid input without running a get trap', () => {
    let getTraps = 0;
    const valid = validInput();
    const proxied = new Proxy(valid, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = parseSignDecisionInput(proxied);
    // The Proxy yields exactly the result of the plain data...
    expect(result).toEqual({ ok: true, input: { requestId: REQUEST_ID, answer: 'approve' } });
    // ...and no `get` trap ever ran (only ownKeys/getOwnPropertyDescriptor traps).
    expect(getTraps).toBe(0);
  });

  it('refuses a prototype-polluting own key', () => {
    // `JSON.parse` produces `__proto__` as an ordinary own data property.
    const polluted: Record<string, unknown> = JSON.parse(
      JSON.stringify({ ...validInput() }),
    ) as Record<string, unknown>;
    Object.defineProperty(polluted, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(parseSignDecisionInput(polluted)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses a constant verdict (a distinct invalid input is not accepted)', () => {
    // A function returning a constant "ok" verdict would pass both of these;
    // the real parser separates them.
    expect(parseSignDecisionInput(validInput()).ok).toBe(true);
    expect(parseSignDecisionInput(validInput({ answer: 'maybe' })).ok).toBe(false);
  });

  it('refuses an identity echo of the input (missing required keys are not the input)', () => {
    // An identity echo of any unknown input would be "accepted"; the parser
    // refuses an input carrying only unexpected keys.
    expect(parseSignDecisionInput({ something: 'else' })).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });
});

describe('parseSignDecisionInput field validation', () => {
  it('accepts the minimal approve input', () => {
    expect(parseSignDecisionInput(validInput())).toEqual({
      ok: true,
      input: { requestId: REQUEST_ID, answer: 'approve' },
    });
  });

  it('accepts decline with explicit grantId and decisionRevision', () => {
    expect(
      parseSignDecisionInput(
        validInput({ answer: 'decline', grantId: 'grant-1', decisionRevision: '2' }),
      ),
    ).toEqual({
      ok: true,
      input: { requestId: REQUEST_ID, answer: 'decline', grantId: 'grant-1', decisionRevision: '2' },
    });
  });

  it('refuses an unsafe requestId (path traversal, dot-only, over-long)', () => {
    for (const requestId of ['../escape', '..', 'a/b', `${'x'.repeat(129)}`, '']) {
      expect(parseSignDecisionInput(validInput({ requestId }))).toEqual({
        ok: false,
        code: 'invalid-sign-decision-input',
      });
    }
  });

  it('refuses an unknown answer', () => {
    expect(parseSignDecisionInput(validInput({ answer: 'maybe' }))).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses a grantId getter (the accessor is never treated as absent and never runs)', () => {
    const input: Record<string, unknown> = { requestId: REQUEST_ID, answer: 'approve' };
    let getterRuns = 0;
    Object.defineProperty(input, 'grantId', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return 'grant-1';
      },
    });
    expect(parseSignDecisionInput(input)).toEqual({ ok: false, code: 'invalid-sign-decision-input' });
    expect(getterRuns).toBe(0);
  });

  it('refuses a decisionRevision getter (the accessor is never treated as absent and never runs)', () => {
    const input: Record<string, unknown> = {
      requestId: REQUEST_ID,
      answer: 'approve',
      grantId: 'grant-1',
    };
    let getterRuns = 0;
    Object.defineProperty(input, 'decisionRevision', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return '1';
      },
    });
    expect(parseSignDecisionInput(input)).toEqual({ ok: false, code: 'invalid-sign-decision-input' });
    expect(getterRuns).toBe(0);
  });

  it('refuses surrounding whitespace in grantId and decisionRevision', () => {
    expect(parseSignDecisionInput(validInput({ grantId: ' grant-1' }))).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
    expect(parseSignDecisionInput(validInput({ decisionRevision: '1\n' }))).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses control characters and over-long optional fields', () => {
    expect(parseSignDecisionInput(validInput({ grantId: 'grant\u00001' })).ok).toBe(false);
    expect(
      parseSignDecisionInput(validInput({ grantId: 'g'.repeat(MAX_DECISION_GRANT_ID_LENGTH + 1) }))
        .ok,
    ).toBe(false);
    expect(parseSignDecisionInput(validInput({ decisionRevision: 'r'.repeat(129) })).ok).toBe(false);
  });
});

describe('buildSignableDecisionFields', () => {
  it('builds approve fields with the defaulted grant id and revision, in canonical key order', () => {
    const built = buildSignableDecisionFields(awaitingRecord(), validInput());
    expect(built).toEqual({
      ok: true,
      fields: {
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        decisionRevision: '1',
        grantId: `grant-${REQUEST_ID}`,
        state: 'approved',
      },
      canonicalJson:
        `{"requestId":"${REQUEST_ID}","projectId":"${PROJECT_ID}","actionScope":"${SCOPE}",` +
        `"expectedHeadSha":"${HEAD}","decisionRevision":"1","grantId":"grant-${REQUEST_ID}",` +
        `"state":"approved"}`,
    });
  });

  it('keeps expectedHeadSha null as null in the canonical JSON', () => {
    const built = buildSignableDecisionFields(
      awaitingRecord({ expectedHeadSha: null }),
      validInput({ answer: 'decline' }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.fields).toEqual({
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        actionScope: SCOPE,
        expectedHeadSha: null,
        decisionRevision: '1',
        grantId: null,
        state: 'declined',
      });
      expect(built.canonicalJson).toContain('"expectedHeadSha":null');
      expect(built.canonicalJson).toContain('"grantId":null');
    }
  });

  it('honours an explicit grantId and decisionRevision on approve', () => {
    const built = buildSignableDecisionFields(
      awaitingRecord(),
      validInput({ grantId: 'grant-custom', decisionRevision: '7' }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.fields.grantId).toBe('grant-custom');
      expect(built.fields.decisionRevision).toBe('7');
    }
  });

  it('forces grantId to null on decline even when one is supplied', () => {
    const built = buildSignableDecisionFields(
      awaitingRecord(),
      validInput({ answer: 'decline', grantId: 'grant-custom' }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.fields.grantId).toBeNull();
      expect(built.fields.state).toBe('declined');
    }
  });

  it('refuses with grant-id-too-long when the default grantId exceeds 128 characters', () => {
    // `grant-${requestId}` is 6 + requestId characters, so a requestId longer
    // than 122 characters overflows the 128-character grant cap.
    const longId = `req-${'x'.repeat(119)}`; // 124 characters
    expect(longId.length).toBeGreaterThan(122);
    const built = buildSignableDecisionFields(
      awaitingRecord({ id: longId }),
      validInput({ requestId: longId }),
    );
    expect(built).toEqual({ ok: false, code: 'grant-id-too-long' });
  });

  it('accepts a 122-character requestId with the defaulted grant id', () => {
    const maxId = `req-${'x'.repeat(118)}`; // 122 characters
    const built = buildSignableDecisionFields(
      awaitingRecord({ id: maxId }),
      validInput({ requestId: maxId }),
    );
    expect(built.ok).toBe(true);
  });

  it('refuses a request not in awaiting-decision state', () => {
    expect(
      buildSignableDecisionFields(awaitingRecord({ state: 'approved' }), validInput()),
    ).toEqual({ ok: false, code: 'request-not-awaiting-decision' });
  });

  it('refuses an invalid stored record', () => {
    expect(buildSignableDecisionFields(null, validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
    expect(buildSignableDecisionFields(awaitingRecord({ id: 7 }), validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
    expect(buildSignableDecisionFields(awaitingRecord(), validInput({ requestId: 'other' }))).toEqual(
      { ok: false, code: 'invalid-coordination-record' },
    );
  });

  it('refuses a record carrying more than MAX_SIGN_DECISION_RECORD_KEYS own keys', () => {
    const bloated = awaitingRecord();
    for (let index = 0; index < 16; index += 1) {
      bloated[`extraKey${index}`] = index;
    }
    expect(Object.keys(bloated).length).toBeGreaterThan(MAX_SIGN_DECISION_RECORD_KEYS);
    expect(buildSignableDecisionFields(bloated, validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
  });

  it('never runs a getter on the stored record', () => {
    let getterRuns = 0;
    const record: Record<string, unknown> = {
      get id() {
        getterRuns += 1;
        return REQUEST_ID;
      },
      state: 'awaiting-decision',
    };
    expect(buildSignableDecisionFields(record, validInput()).ok).toBe(false);
    expect(getterRuns).toBe(0);
  });

  it('refuses a Proxy get trap on the decision input (no get trap ran, same result as plain data)', () => {
    let getTraps = 0;
    const valid = validInput();
    const proxied = new Proxy(valid, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const plain = buildSignableDecisionFields(awaitingRecord(), valid);
    const proxiedResult = buildSignableDecisionFields(awaitingRecord(), proxied);
    expect(proxiedResult).toEqual(plain);
    expect(getTraps).toBe(0);
  });

  it('refuses a prototype-polluting key on the decision input', () => {
    const polluted = { ...validInput() };
    Object.defineProperty(polluted, 'constructor', {
      value: 'evil',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(buildSignableDecisionFields(awaitingRecord(), polluted)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });
});

describe('never-throw on hostile reflective operations', () => {
  it('refuses a Proxy with a throwing getPrototypeOf trap in buildSignableDecisionFields', () => {
    const hostile = new Proxy(awaitingRecord(), {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf trap');
      },
    });
    expect(buildSignableDecisionFields(hostile, validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
  });

  it('refuses a Proxy with a throwing getOwnPropertyDescriptor trap in buildSignableDecisionFields', () => {
    const hostile = new Proxy(awaitingRecord(), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile getOwnPropertyDescriptor trap');
      },
    });
    expect(buildSignableDecisionFields(hostile, validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
  });

  it('refuses a Proxy with a throwing ownKeys trap in buildSignableDecisionFields', () => {
    const hostile = new Proxy(awaitingRecord(), {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(buildSignableDecisionFields(hostile, validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
  });

  it('refuses a Proxy with a throwing getPrototypeOf trap in parseSignDecisionInput', () => {
    const hostile = new Proxy(validInput(), {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf trap');
      },
    });
    expect(parseSignDecisionInput(hostile)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses a Proxy with a throwing getOwnPropertyDescriptor trap in parseSignDecisionInput', () => {
    const hostile = new Proxy(validInput(), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile getOwnPropertyDescriptor trap');
      },
    });
    expect(parseSignDecisionInput(hostile)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses a Proxy with a throwing ownKeys trap in parseSignDecisionInput', () => {
    const hostile = new Proxy(validInput(), {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(parseSignDecisionInput(hostile)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
  });

  it('refuses a revoked Proxy in both buildSignableDecisionFields and parseSignDecisionInput', () => {
    const { proxy, revoke } = Proxy.revocable(validInput(), {});
    revoke();
    expect(() => parseSignDecisionInput(proxy)).not.toThrow();
    expect(parseSignDecisionInput(proxy)).toEqual({
      ok: false,
      code: 'invalid-sign-decision-input',
    });
    expect(() => buildSignableDecisionFields(proxy, validInput())).not.toThrow();
    expect(buildSignableDecisionFields(proxy, validInput())).toEqual({
      ok: false,
      code: 'invalid-coordination-record',
    });
  });
});
