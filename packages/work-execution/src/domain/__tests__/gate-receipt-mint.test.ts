/**
 * FC8H hostile-input and behaviour tests for the pure seal-then-gate receipt
 * mint and the attempt-token append scope guard. Every call passes
 * `types.isProxy` from `node:util` as the required positional detector
 * (matching how infrastructure callers pass it). No network, no clock, no
 * randomness.
 */

import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_TOKEN_LIMITS,
  authorizeAttemptTokenAppend,
  mintGateReceiptFromVmExit,
} from '../gate-receipt-mint.js';

const isProxy = types.isProxy;

const DIGEST = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8';
const OTHER_DIGEST = 'b'.repeat(64);
const VM_ID = 'vm-fc8h-0001';
const ATTEMPT_ID = 'attempt-fc8h-0001';
const NONCE = 'seal-nonce-fc8h-2026-11-27';

/** A revoked Proxy throws on every trap, including [[GetPrototypeOf]]. */
function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A Proxy whose `get` trap records that it was reached. */
function countingGetProxy(target: Record<string, unknown>): { proxy: unknown; trapRuns: () => number } {
  let runs = 0;
  const proxy = new Proxy(target, {
    get(_innerTarget, prop) {
      runs += 1;
      return Reflect.get(target, prop);
    },
  });
  return { proxy, trapRuns: () => runs };
}

/** An own enumerable getter on `key` that records every run. */
function withCountingGetter(record: Record<string, unknown>, key: string): { value: unknown; getterRuns: () => number } {
  let runs = 0;
  const value = Object.defineProperty({ ...record }, key, {
    enumerable: true,
    configurable: true,
    get() {
      runs += 1;
      return record[key];
    },
  });
  return { value, getterRuns: () => runs };
}

/** A valid sealed host observation; overrides replace whole keys. */
function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vmId: VM_ID,
    attemptId: ATTEMPT_ID,
    sealedDigest: DIGEST,
    gateExit: 0,
    sealNonce: NONCE,
    ...overrides,
  };
}

/** A matching sealed host-side freshness and seal source. */
function freshnessSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environmentState: {
      status: 'sealed',
      attemptId: ATTEMPT_ID,
      environmentId: VM_ID,
      isolation: 'microvm',
      worktreeRef: 'wt-fc8h-0001',
    },
    expectedSealedDigest: DIGEST,
    expectedSealNonce: NONCE,
    consumedVmIds: [],
    ...overrides,
  };
}

/** A valid attempt-scoped token holding the candidate-note scope. */
function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'attempt-scoped',
    attemptId: ATTEMPT_ID,
    vmId: VM_ID,
    scopes: ['candidate-note'],
    ...overrides,
  };
}

describe('mintGateReceiptFromVmExit', () => {
  it('mints a pass receipt bound to sealedDigest, vmId and attemptId when a fresh sealed vm gateExit is 0', () => {
    expect(mintGateReceiptFromVmExit(observation(), freshnessSource(), isProxy)).toEqual({
      ok: true,
      receipt: {
        attemptId: ATTEMPT_ID,
        vmId: VM_ID,
        sealedDigest: DIGEST,
        exitCode: 0,
        result: 'pass',
        source: 'fresh-vm-exit',
        authoritative: true,
      },
    });
  });

  it('mints a fail receipt with the matching exitCode when a fresh sealed vm gateExit is nonzero (1, 2, 137)', () => {
    for (const exitCode of [1, 2, 137]) {
      expect(mintGateReceiptFromVmExit(observation({ gateExit: exitCode }), freshnessSource(), isProxy)).toEqual({
        ok: true,
        receipt: {
          attemptId: ATTEMPT_ID,
          vmId: VM_ID,
          sealedDigest: DIGEST,
          exitCode,
          result: 'fail',
          source: 'fresh-vm-exit',
          authoritative: true,
        },
      });
    }
  });

  it('refuses a caller-supplied fresh flag on hostObservation and on freshnessSource instead of trusting it', () => {
    for (const fresh of [true, false]) {
      expect(mintGateReceiptFromVmExit(observation({ fresh }), freshnessSource(), isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
      expect(mintGateReceiptFromVmExit(observation(), freshnessSource({ fresh }), isProxy)).toEqual({
        ok: false,
        reason: 'invalid-freshness-source',
      });
    }
  });

  it('refuses unlisted-path snapshot refusals (fresh: NaN, fresh: undefined, polluting key holding undefined) with invalid-input on hostObservation', () => {
    expect(mintGateReceiptFromVmExit(observation({ fresh: Number.NaN }), freshnessSource(), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(mintGateReceiptFromVmExit(observation({ fresh: undefined }), freshnessSource(), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    let getterRuns = 0;
    const freshGetter = Object.defineProperty({ ...observation() }, 'fresh', {
      enumerable: true,
      configurable: true,
      get() {
        getterRuns += 1;
        return true;
      },
    });
    expect(mintGateReceiptFromVmExit(freshGetter, freshnessSource(), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(getterRuns).toBe(0);
    const pollutingUndefined = Object.defineProperty({ ...observation() }, '__proto__', {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(mintGateReceiptFromVmExit(pollutingUndefined, freshnessSource(), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('refuses unlisted-path snapshot refusals (fresh: NaN, fresh: undefined, polluting key holding undefined) with invalid-freshness-source on freshnessSource', () => {
    expect(mintGateReceiptFromVmExit(observation(), freshnessSource({ fresh: Number.NaN }), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-freshness-source',
    });
    expect(mintGateReceiptFromVmExit(observation(), freshnessSource({ fresh: undefined }), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-freshness-source',
    });
    const pollutingUndefined = Object.defineProperty({ ...freshnessSource() }, 'constructor', {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(mintGateReceiptFromVmExit(observation(), pollutingUndefined, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-freshness-source',
    });
  });

  it('refuses minting when host environmentState status is not sealed (none, created, loaded, destroyed, failed) with vm-not-sealed', () => {
    for (const status of ['none', 'created', 'loaded', 'destroyed', 'failed']) {
      const source = freshnessSource();
      (source['environmentState'] as Record<string, unknown>)['status'] = status;
      expect(mintGateReceiptFromVmExit(observation(), source, isProxy), status).toEqual({
        ok: false,
        reason: 'vm-not-sealed',
      });
    }
  });

  it('refuses an invalid environmentState status value with invalid-freshness-source', () => {
    for (const status of ['sealed ', 'SEALED', 'bogus', 7, null, undefined]) {
      const source = freshnessSource();
      (source['environmentState'] as Record<string, unknown>)['status'] = status;
      expect(mintGateReceiptFromVmExit(observation(), source, isProxy), String(status)).toEqual({
        ok: false,
        reason: 'invalid-freshness-source',
      });
    }
  });

  it('refuses stale or replayed VM observations via consumedVmIds with stale-vm', () => {
    expect(
      mintGateReceiptFromVmExit(observation(), freshnessSource({ consumedVmIds: [VM_ID] }), isProxy),
    ).toEqual({ ok: false, reason: 'stale-vm' });
    expect(
      mintGateReceiptFromVmExit(observation(), freshnessSource({ consumedVmIds: ['vm-other', VM_ID] }), isProxy),
    ).toEqual({ ok: false, reason: 'stale-vm' });
  });

  it('refuses a mismatched sealNonce against the host expectedSealNonce with stale-vm', () => {
    expect(
      mintGateReceiptFromVmExit(observation({ sealNonce: 'stale-nonce-0001' }), freshnessSource(), isProxy),
    ).toEqual({ ok: false, reason: 'stale-vm' });
    expect(
      mintGateReceiptFromVmExit(observation(), freshnessSource({ expectedSealNonce: 'newer-nonce-0001' }), isProxy),
    ).toEqual({ ok: false, reason: 'stale-vm' });
  });

  it('refuses when hostObservation vmId or attemptId does not match the sealed environmentState with vm-identity-mismatch', () => {
    const otherEnvironment = freshnessSource();
    (otherEnvironment['environmentState'] as Record<string, unknown>)['environmentId'] = 'vm-fc8h-0002';
    expect(mintGateReceiptFromVmExit(observation(), otherEnvironment, isProxy)).toEqual({
      ok: false,
      reason: 'vm-identity-mismatch',
    });
    const otherAttempt = freshnessSource();
    (otherAttempt['environmentState'] as Record<string, unknown>)['attemptId'] = 'attempt-fc8h-0002';
    expect(mintGateReceiptFromVmExit(observation(), otherAttempt, isProxy)).toEqual({
      ok: false,
      reason: 'vm-identity-mismatch',
    });
    expect(
      mintGateReceiptFromVmExit(observation({ vmId: 'vm-fc8h-0002' }), freshnessSource(), isProxy),
    ).toEqual({ ok: false, reason: 'vm-identity-mismatch' });
    expect(
      mintGateReceiptFromVmExit(observation({ attemptId: 'attempt-fc8h-0002' }), freshnessSource(), isProxy),
    ).toEqual({ ok: false, reason: 'vm-identity-mismatch' });
  });

  it('refuses when sealedDigest does not match the host expectedSealedDigest with digest-mismatch', () => {
    expect(
      mintGateReceiptFromVmExit(observation({ sealedDigest: OTHER_DIGEST }), freshnessSource(), isProxy),
    ).toEqual({ ok: false, reason: 'digest-mismatch' });
    expect(
      mintGateReceiptFromVmExit(observation(), freshnessSource({ expectedSealedDigest: OTHER_DIGEST }), isProxy),
    ).toEqual({ ok: false, reason: 'digest-mismatch' });
  });

  it('refuses missing, hostile, unlisted-path NaN or undefined, or malformed freshnessSource without invoking getters or Proxy traps', () => {
    const hostileSources: unknown[] = [
      null,
      undefined,
      7,
      'freshness',
      true,
      [],
      { length: 4, environmentState: 'x' }, // array-like
      revokedProxy(),
      new Map(),
      {}, // missing every key
      { environmentState: freshnessSource()['environmentState'], expectedSealedDigest: DIGEST, expectedSealNonce: NONCE }, // missing consumedVmIds
      { ...freshnessSource(), extra: 1 }, // unexpected key
      { ...freshnessSource(), environmentState: null },
      { ...freshnessSource(), environmentState: [] },
      { ...freshnessSource(), environmentState: 7 },
      { ...freshnessSource(), environmentState: { status: 'sealed' } }, // missing environmentState fields
      (() => {
        const environment = freshnessSource();
        (environment['environmentState'] as Record<string, unknown>)['isolation'] = 'docker';
        return environment;
      })(),
      (() => {
        const environment = freshnessSource();
        (environment['environmentState'] as Record<string, unknown>)['worktreeRef'] = '';
        return environment;
      })(),
      (() => {
        const environment = freshnessSource();
        (environment['environmentState'] as Record<string, unknown>)['worktreeRef'] = 'wt\nfc8h';
        return environment;
      })(),
      (() => {
        const environment = freshnessSource();
        (environment['environmentState'] as Record<string, unknown>)['worktreeRef'] = 'w'.repeat(513);
        return environment;
      })(),
      (() => {
        const environment = freshnessSource();
        (environment['environmentState'] as Record<string, unknown>)['attemptId'] = null;
        return environment;
      })(),
      { ...freshnessSource(), expectedSealedDigest: 'nothex' },
      { ...freshnessSource(), expectedSealedDigest: 'A'.repeat(64) }, // uppercase hex
      { ...freshnessSource(), expectedSealedDigest: undefined },
      { ...freshnessSource(), expectedSealNonce: 7 },
      { ...freshnessSource(), consumedVmIds: 'none' },
      { ...freshnessSource(), consumedVmIds: ['bad id'] },
      { ...freshnessSource(), consumedVmIds: ['ok-id', undefined] },
    ];
    for (const source of hostileSources) {
      expect(mintGateReceiptFromVmExit(observation(), source, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-freshness-source',
      });
    }
    // 65 consumed ids exceed the snapshot bound and the 64-entry validation cap.
    const overlongConsumed = Array.from({ length: 65 }, (_, index) => `vm-${index}`);
    expect(
      mintGateReceiptFromVmExit(observation(), freshnessSource({ consumedVmIds: overlongConsumed }), isProxy),
    ).toEqual({ ok: false, reason: 'invalid-freshness-source' });
    // A getter on a freshnessSource key never runs.
    const { value: getterSource, getterRuns } = withCountingGetter(freshnessSource(), 'expectedSealedDigest');
    expect(mintGateReceiptFromVmExit(observation(), getterSource, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-freshness-source',
    });
    expect(getterRuns()).toBe(0);
    // A root-level Proxy is refused with no trap run.
    const { proxy: trapProxy, trapRuns } = countingGetProxy(freshnessSource());
    expect(mintGateReceiptFromVmExit(observation(), trapProxy, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-freshness-source',
    });
    expect(trapRuns()).toBe(0);
    // A prototype-polluting key is refused.
    const polluting = Object.defineProperty({ ...freshnessSource() }, 'prototype', {
      value: 'pollution',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(mintGateReceiptFromVmExit(observation(), polluting, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-freshness-source',
    });
  });

  it('refuses missing, malformed or non-hex sealedDigest values with invalid-sealed-digest', () => {
    for (const digest of [
      undefined,
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64), // uppercase
      'z'.repeat(64), // non-hex
      7,
      null,
      `${DIGEST}0`, // 65 lowercase hex
    ]) {
      const bad = { ...observation() };
      if (digest === undefined) {
        delete bad['sealedDigest'];
      } else {
        bad['sealedDigest'] = digest;
      }
      expect(mintGateReceiptFromVmExit(bad, freshnessSource(), isProxy)).toEqual({
        ok: false,
        reason: 'invalid-sealed-digest',
      });
    }
  });

  it('refuses missing, empty, overlong, control-character and secret-shaped sealNonce with invalid-seal-nonce', () => {
    for (const nonce of [
      undefined,
      '',
      'n'.repeat(129),
      'seal\tnonce',
      `xox${'p'}-aaaaaaaaaa`, // slack-token shape, assembled so no credential-shaped literal lands in the file
      7,
      null,
    ]) {
      const bad = { ...observation() };
      if (nonce === undefined) {
        delete bad['sealNonce'];
      } else {
        bad['sealNonce'] = nonce;
      }
      expect(mintGateReceiptFromVmExit(bad, freshnessSource(), isProxy)).toEqual({
        ok: false,
        reason: 'invalid-seal-nonce',
      });
    }
  });

  it('refuses missing, empty, 129-char, overlong, control-character and secret-shaped vmId and attemptId with invalid-vm-id or invalid-attempt-id', () => {
    for (const [field, reason] of [
      ['vmId', 'invalid-vm-id'],
      ['attemptId', 'invalid-attempt-id'],
    ] as const) {
      for (const value of [undefined, '', 'a'.repeat(129), 'id\twith-tab', `gh${'p'}_${'a'.repeat(20)}`, 7, null]) {
        const bad = { ...observation() };
        if (value === undefined) {
          delete bad[field];
        } else {
          bad[field] = value;
        }
        expect(mintGateReceiptFromVmExit(bad, freshnessSource(), isProxy), `${field}: ${String(value)}`).toEqual({
          ok: false,
          reason,
        });
      }
    }
  });

  it('refuses missing, non-integer, negative, out-of-range, NaN, Infinity, -0, undefined and non-number gateExit values with invalid-gate-exit', () => {
    for (const gateExit of [undefined, -1, 256, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0.5, '0', null, [0], true]) {
      const bad = { ...observation() };
      if (gateExit === undefined) {
        delete bad['gateExit'];
      } else {
        bad['gateExit'] = gateExit;
      }
      expect(mintGateReceiptFromVmExit(bad, freshnessSource(), isProxy), String(gateExit)).toEqual({
        ok: false,
        reason: 'invalid-gate-exit',
      });
    }
  });

  it('refuses null, undefined, primitives, non-iterables, arrays, sparse holes, array-likes, root Proxies, oversized inputs, prototype-polluting keys and unexpected keys on hostObservation with invalid-input', () => {
    const sparse: unknown[] = [1, 2, 3];
    delete sparse[1];
    const arrayLike = Object.defineProperties(Object.create(Object.prototype), {
      length: { value: 1, enumerable: true },
      vmId: { value: VM_ID, enumerable: true },
    });
    const { proxy: rootProxy, trapRuns } = countingGetProxy(observation());
    const nineKeys = {
      ...observation(),
      fresh: true,
      note: 'a',
      runner: 'b',
      extra: 'c',
    };
    const constructorKey = Object.defineProperty({ ...observation() }, 'constructor', {
      value: 'pollution',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const prototypeKey = Object.defineProperty({ ...observation() }, 'prototype', {
      value: 'pollution',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const hostileObservations: unknown[] = [
      null,
      undefined,
      7,
      'observation',
      true,
      [],
      sparse,
      arrayLike,
      rootProxy,
      new Map(),
      revokedProxy(),
      nineKeys, // 9 keys > VM_OBSERVATION_LIMITS.maxKeys
      { ...observation(), extra: 1 },
      constructorKey,
      prototypeKey,
    ];
    for (const bad of hostileObservations) {
      expect(mintGateReceiptFromVmExit(bad, freshnessSource(), isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    expect(trapRuns()).toBe(0);
  });

  it('refuses getters and Proxies on named hostObservation fields with the field-specific reason without invoking them', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['vmId', 'invalid-vm-id'],
      ['attemptId', 'invalid-attempt-id'],
      ['sealedDigest', 'invalid-sealed-digest'],
      ['gateExit', 'invalid-gate-exit'],
      ['sealNonce', 'invalid-seal-nonce'],
    ];
    for (const [field, reason] of cases) {
      const { value: getterObservation, getterRuns } = withCountingGetter(observation(), field);
      expect(mintGateReceiptFromVmExit(getterObservation, freshnessSource(), isProxy), `getter on ${field}`).toEqual({
        ok: false,
        reason,
      });
      expect(getterRuns()).toBe(0);
      const { proxy: fieldProxy, trapRuns } = countingGetProxy({});
      expect(
        mintGateReceiptFromVmExit(observation({ [field]: fieldProxy }), freshnessSource(), isProxy),
        `Proxy on ${field}`,
      ).toEqual({ ok: false, reason });
      expect(trapRuns()).toBe(0);
    }
  });

  it('refuses missing or throwing isProxy detectors on the mint without throwing', () => {
    const throwingDetector = () => {
      throw new Error('detector must never be trusted');
    };
    for (const detector of [undefined, 'nope', throwingDetector]) {
      // The observation is read first, so a broken detector is refused there.
      expect(
        mintGateReceiptFromVmExit(observation(), freshnessSource(), detector as unknown as typeof isProxy),
      ).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('never echoes a rejected input value into the mint refusal', () => {
    const secret = 'super-secret-should-never-appear';
    const result = mintGateReceiptFromVmExit(
      observation({ attemptId: secret }),
      freshnessSource(),
      isProxy,
    );
    expect(result).toEqual({ ok: false, reason: 'vm-identity-mismatch' });
    expect(JSON.stringify(result)).not.toContain(secret);
    const hostile = mintGateReceiptFromVmExit(null, freshnessSource(), isProxy);
    expect(JSON.stringify(hostile)).not.toContain(secret);
  });
});

describe('authorizeAttemptTokenAppend', () => {
  it('allows candidate-note append bound to attemptId and vmId when the token scopes include candidate-note', () => {
    expect(authorizeAttemptTokenAppend(token(), 'candidate-note', isProxy)).toEqual({
      ok: true,
      allowed: true,
      targetKind: 'candidate-note',
      attemptId: ATTEMPT_ID,
      vmId: VM_ID,
    });
    expect(authorizeAttemptTokenAppend(token({ scopes: ['candidate-note', 'other-scope'] }), 'candidate-note', isProxy)).toEqual({
      ok: true,
      allowed: true,
      targetKind: 'candidate-note',
      attemptId: ATTEMPT_ID,
      vmId: VM_ID,
    });
  });

  it('refuses attempt-scoped token append for candidate-note with missing-candidate-note-scope when the scope is absent', () => {
    expect(authorizeAttemptTokenAppend(token({ scopes: [] }), 'candidate-note', isProxy)).toEqual({
      ok: false,
      reason: 'missing-candidate-note-scope',
    });
    expect(authorizeAttemptTokenAppend(token({ scopes: ['other-scope'] }), 'candidate-note', isProxy)).toEqual({
      ok: false,
      reason: 'missing-candidate-note-scope',
    });
  });

  it('refuses attempt-scoped token append for receipt even when scopes claim receipt', () => {
    expect(authorizeAttemptTokenAppend(token({ scopes: ['receipt'] }), 'receipt', isProxy)).toEqual({
      ok: false,
      reason: 'attempt-token-cannot-append-receipt',
    });
    expect(authorizeAttemptTokenAppend(token({ scopes: ['candidate-note', 'receipt'] }), 'receipt', isProxy)).toEqual({
      ok: false,
      reason: 'attempt-token-cannot-append-receipt',
    });
  });

  it('refuses attempt-scoped token append for usage-row even when scopes claim usage-row', () => {
    expect(authorizeAttemptTokenAppend(token({ scopes: ['usage-row'] }), 'usage-row', isProxy)).toEqual({
      ok: false,
      reason: 'attempt-token-cannot-append-usage-row',
    });
    expect(authorizeAttemptTokenAppend(token({ scopes: ['candidate-note', 'usage-row'] }), 'usage-row', isProxy)).toEqual({
      ok: false,
      reason: 'attempt-token-cannot-append-usage-row',
    });
  });

  it('refuses attempt-scoped token append for grant even when scopes claim grant, wildcard, AuthorizedActionKind or ForgeCredentialPermission values', () => {
    const forgedScopes: string[][] = [
      ['grant'],
      ['*'],
      ['push-and-open-pr', 'push-to-pr', 'merge-pr', 'post-status'],
      ['release-install', 'release-swap', 'release-rollback'],
      ['read', 'push', 'status', 'merge'],
      ['candidate-note', 'grant', '*'],
    ];
    for (const scopes of forgedScopes) {
      expect(authorizeAttemptTokenAppend(token({ scopes }), 'grant', isProxy), scopes.join(',')).toEqual({
        ok: false,
        reason: 'attempt-token-cannot-append-grant',
      });
    }
  });

  it('refuses unknown targetKind values on the token append check with invalid-input', () => {
    for (const targetKind of ['note', '', 'RECEIPT', 'candidate-notes', 7, null, undefined, true, ['receipt']]) {
      expect(
        authorizeAttemptTokenAppend(token(), targetKind, isProxy),
        String(typeof targetKind === 'string' ? targetKind : 'non-string'),
      ).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('refuses hostile tokens (null, undefined, primitives, non-iterables, arrays, sparse holes, array-likes, root Proxies, getters on unlisted keys, oversized scopes, too many keys, prototype-polluting keys and unexpected keys) with invalid-input', () => {
    const sparseScopes: unknown[] = ['candidate-note'];
    delete sparseScopes[0];
    const { proxy: rootProxy, trapRuns } = countingGetProxy(token());
    const { value: extraKeyGetter, getterRuns } = withCountingGetter(token(), 'fresh');
    const polluting = Object.defineProperty({ ...token() }, '__proto__', {
      value: 'pollution',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const hostileTokens: unknown[] = [
      null,
      undefined,
      7,
      'token',
      true,
      [],
      ['candidate-note'],
      sparseScopes,
      { length: 4, kind: 'attempt-scoped' }, // array-like
      rootProxy,
      new Map(),
      revokedProxy(),
      { ...token(), fresh: true }, // unexpected key
      { ...token(), extra: 1 },
      { kind: 'attempt-scoped', attemptId: ATTEMPT_ID, vmId: VM_ID }, // missing scopes
      { kind: 'attempt-scoped', attemptId: ATTEMPT_ID, scopes: ['candidate-note'] }, // missing vmId
      { kind: 'attempt-scoped', vmId: VM_ID, scopes: ['candidate-note'] }, // missing attemptId
      { attemptId: ATTEMPT_ID, vmId: VM_ID, scopes: ['candidate-note'] }, // missing kind
      extraKeyGetter,
      polluting,
    ];
    for (const bad of hostileTokens) {
      expect(authorizeAttemptTokenAppend(bad, 'candidate-note', isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    expect(trapRuns()).toBe(0);
    expect(getterRuns()).toBe(0);
    // 17 scopes exceed ATTEMPT_TOKEN_LIMITS.maxArrayLength.
    const tooManyScopes = Array.from({ length: ATTEMPT_TOKEN_LIMITS.maxArrayLength + 1 }, (_, index) => `scope-${index}`);
    expect(authorizeAttemptTokenAppend(token({ scopes: tooManyScopes }), 'candidate-note', isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    // Exactly 16 scopes at the cap are accepted.
    const atCap = [...Array.from({ length: 15 }, (_, index) => `scope-${index}`), 'candidate-note'];
    expect(authorizeAttemptTokenAppend(token({ scopes: atCap }), 'candidate-note', isProxy)).toEqual({
      ok: true,
      allowed: true,
      targetKind: 'candidate-note',
      attemptId: ATTEMPT_ID,
      vmId: VM_ID,
    });
  });

  it('refuses invalid token fields (wrong kind, invalid attemptId or vmId, non-array scopes, non-string or hostile scope entries) with invalid-input', () => {
    for (const kind of ['global', 'attempt', 'attempt-scoped ', 7, null]) {
      expect(authorizeAttemptTokenAppend(token({ kind }), 'candidate-note', isProxy), String(kind)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    for (const attemptId of ['', 'a'.repeat(129), 'id\ttab', `gh${'p'}_${'a'.repeat(20)}`, null, 7]) {
      expect(authorizeAttemptTokenAppend(token({ attemptId }), 'candidate-note', isProxy), String(attemptId)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    for (const vmId of ['', 'a'.repeat(129), null, 7]) {
      expect(authorizeAttemptTokenAppend(token({ vmId }), 'candidate-note', isProxy), String(vmId)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    for (const scopes of ['candidate-note', 7, null, {}]) {
      expect(authorizeAttemptTokenAppend(token({ scopes }), 'candidate-note', isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    for (const scopes of [[7], [null], [{}], [''], ['a\tb'], ['candidate-note', undefined]]) {
      expect(authorizeAttemptTokenAppend(token({ scopes }), 'candidate-note', isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
  });

  it('refuses missing or throwing isProxy detectors on the token append check without throwing', () => {
    const throwingDetector = () => {
      throw new Error('detector must never be trusted');
    };
    for (const detector of [undefined, 'nope', throwingDetector]) {
      expect(authorizeAttemptTokenAppend(token(), 'candidate-note', detector as unknown as typeof isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
  });

  it('never echoes a rejected token or scope value into the append refusal', () => {
    const secret = `xox${'p'}-${'a'.repeat(20)}`;
    const result = authorizeAttemptTokenAppend(token({ attemptId: secret }), 'candidate-note', isProxy);
    expect(result).toEqual({ ok: false, reason: 'invalid-input' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
