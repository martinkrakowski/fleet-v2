import { describe, expect, it } from 'vitest';

import type { KmsKeyHandle, KmsSignerPort, SignPayload } from '../KmsSignerPort.out-port.js';
import { MAX_SIGN_PAYLOAD_BYTES } from '../KmsSignerPort.out-port.js';

/**
 * The shared contract suite for KmsSignerPort. It runs against every
 * implementation of the port (today the in-memory fake, later any real
 * adapter), so implementations cannot drift from one another. It asserts both
 * `{ ok: true }` outcomes (which a constant-refuse signer fails) and
 * `{ ok: false, reason }` outcomes (which a constant-ok signer fails), and it
 * never imports the fake. Holds no `.test.ts` suffix: the runners that import
 * it collect it.
 */

/** Harness options a runner passes when creating its signer. */
export interface KmsSignerContractOptions {
  /** The signer's own health; defaults to `'healthy'`. */
  readonly health?: 'healthy' | 'degraded' | 'down';
  /** Deterministic seed for implementations that derive signatures. */
  readonly seed?: string;
}

/** The valid healthy key handle every other case derives from. */
export function validKeyHandle(): KmsKeyHandle {
  return { keyId: 'key-1', algorithm: 'Ed25519', health: 'healthy' };
}

/** The valid payload every other case derives from. */
export function validPayload(): SignPayload {
  return { content: 'payload-bytes' };
}

export function describeKmsSignerContract(
  label: string,
  create: (options?: KmsSignerContractOptions) => KmsSignerPort,
): void {
  describe(`KmsSignerPort contract (${label})`, () => {
    it('signs a payload with a known healthy key and echoes the key identity', async () => {
      const port = create();
      const result = await port.sign(validKeyHandle(), validPayload());
      expect(result).toEqual({
        ok: true,
        signature: expect.stringMatching(/^sig-[0-9a-f]{8}$/),
        keyId: 'key-1',
        algorithm: 'Ed25519',
      });
    });

    it('signs deterministically: the same inputs yield the same signature', async () => {
      const port = create({ seed: 'contract-seed' });
      const first = await port.sign(validKeyHandle(), validPayload());
      const second = await port.sign(validKeyHandle(), validPayload());
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error('unreachable: valid signing inputs must succeed here');
      }
      // No randomness may enter signing: the same inputs must yield the very
      // same signature, which a random implementation fails.
      expect(second.signature).toBe(first.signature);
    });

    it('signs a payload at the exact 65_536-byte ceiling and refuses one byte more', async () => {
      const port = create();
      const asciiCeiling = 'a'.repeat(MAX_SIGN_PAYLOAD_BYTES);
      expect(await port.sign(validKeyHandle(), { content: asciiCeiling })).toEqual({
        ok: true,
        signature: expect.stringMatching(/^sig-[0-9a-f]{8}$/),
        keyId: 'key-1',
        algorithm: 'Ed25519',
      });
      const oneCharMore = await port.sign(validKeyHandle(), {
        content: `${asciiCeiling}a`,
      });
      expect(oneCharMore).toEqual({ ok: false, reason: 'invalid-request' });

      // The bound is UTF-8 bytes, not characters: multibyte content at the
      // byte ceiling signs, one multibyte unit more is refused.
      const multibyteCeiling = 'é'.repeat(MAX_SIGN_PAYLOAD_BYTES / 2);
      expect(await port.sign(validKeyHandle(), { content: multibyteCeiling }).then((r) => r.ok)).toBe(true);
      const oneUnitMore = await port.sign(validKeyHandle(), {
        content: `${multibyteCeiling}é`,
      });
      expect(oneUnitMore).toEqual({ ok: false, reason: 'invalid-request' });
    });

    it('refuses sign when the keyHandle health is down, degraded, or unrecognised with unavailable', async () => {
      const port = create();
      for (const health of ['down', 'degraded', 'partially-degraded'] as string[]) {
        const result = await port.sign({ ...validKeyHandle(), health } as KmsKeyHandle, validPayload());
        expect(result, `health ${health}`).toEqual({ ok: false, reason: 'unavailable' });
      }
    });

    it('refuses sign with unavailable when the signer itself is not healthy, even for a healthy handle', async () => {
      for (const health of ['degraded', 'down'] as const) {
        const port = create({ health });
        const result = await port.sign(validKeyHandle(), validPayload());
        expect(result, `signer health ${health}`).toEqual({ ok: false, reason: 'unavailable' });
      }
    });

    it('refuses a missing, null, or non-string keyHandle health with invalid-request', async () => {
      const port = create();
      for (const [name, health] of [
        ['missing', undefined],
        ['null', null],
        ['number', 1],
        ['object', { health: 'healthy' }],
      ] as Array<[string, unknown]>) {
        const handle = { ...validKeyHandle(), health } as unknown as KmsKeyHandle;
        const result = await port.sign(handle, validPayload());
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses sign for an unknown or algorithm-mismatched keyHandle with unknown-key', async () => {
      const port = create();
      const unknown = await port.sign({ ...validKeyHandle(), keyId: 'key-404' }, validPayload());
      expect(unknown).toEqual({ ok: false, reason: 'unknown-key' });
      const mismatched = await port.sign(
        { ...validKeyHandle(), algorithm: 'RS256' },
        validPayload(),
      );
      expect(mismatched).toEqual({ ok: false, reason: 'unknown-key' });
    });

    it('refuses null, undefined, and wrong primitives for either argument with invalid-request', async () => {
      const port = create();
      for (const [name, keyHandle, payload] of [
        ['null handle', null, validPayload()],
        ['undefined handle', undefined, validPayload()],
        ['number handle', 42, validPayload()],
        ['string handle', 'key-1', validPayload()],
        ['boolean handle', true, validPayload()],
        ['null payload', validKeyHandle(), null],
        ['undefined payload', validKeyHandle(), undefined],
        ['number payload', validKeyHandle(), 42],
        ['string payload', validKeyHandle(), 'content'],
        ['boolean payload', validKeyHandle(), false],
      ] as Array<[string, unknown, unknown]>) {
        const result = await port.sign(keyHandle as KmsKeyHandle, payload as SignPayload);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses arrays, sparse arrays with holes, array-likes, and non-iterables with invalid-request', async () => {
      const port = create();
      const sparseArray: Array<unknown> = new Array(2);
      sparseArray[1] = 'x';
      for (const [name, keyHandle, payload] of [
        ['array handle', ['key-1'], validPayload()],
        ['sparse array handle', sparseArray, validPayload()],
        ['array-like handle', { 0: 'key-1', length: 1 }, validPayload()],
        ['array payload', validKeyHandle(), ['content']],
        ['sparse array payload', validKeyHandle(), sparseArray],
        ['array-like payload', validKeyHandle(), { 0: 'content', length: 1 }],
        ['enormous array-like payload', validKeyHandle(), { length: 1e9 }],
      ] as Array<[string, unknown, unknown]>) {
        const result = await port.sign(keyHandle as KmsKeyHandle, payload as SignPayload);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses getter properties without invoking the getter', async () => {
      const port = create();
      let getterRuns = 0;
      const handle = validKeyHandle();
      Reflect.deleteProperty(handle, 'health');
      Object.defineProperty(handle, 'health', {
        enumerable: true,
        get: () => {
          getterRuns += 1;
          return 'healthy';
        },
      });
      const payload = { content: 'payload-bytes' };
      Object.defineProperty(payload, 'content', {
        enumerable: true,
        get: () => {
          getterRuns += 1;
          return 'payload-bytes';
        },
      });
      const result = await port.sign(handle, payload);
      expect(result).toEqual({ ok: false, reason: 'invalid-request' });
      expect(getterRuns).toBe(0);
    });

    it('refuses Proxy inputs via isProxy without running traps', async () => {
      const port = create();
      let trapRuns = 0;
      const countingHandle = new Proxy(validKeyHandle(), {
        get(target, key, receiver) {
          trapRuns += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const result = await port.sign(countingHandle, validPayload());
      expect(result).toEqual({ ok: false, reason: 'invalid-request' });
      expect(trapRuns).toBe(0);

      const revokedHandle = new Proxy(validKeyHandle(), {
        getPrototypeOf() {
          throw new Error('revoked');
        },
        ownKeys() {
          throw new Error('revoked');
        },
        getOwnPropertyDescriptor() {
          throw new Error('revoked');
        },
      });
      const revokedResult = await port.sign(revokedHandle, validPayload());
      expect(revokedResult).toEqual({ ok: false, reason: 'invalid-request' });
    });

    it('refuses prototype-polluting, extra, missing, symbol, and non-enumerable keys without echoing', async () => {
      const port = create();
      const withOwnKey = (key: string, value: unknown): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...validKeyHandle() };
        Object.defineProperty(out, key, { enumerable: true, value });
        return out;
      };
      const cases: Array<[string, unknown, unknown]> = [
        ['handle __proto__ key', withOwnKey('__proto__', 'key-1'), validPayload()],
        ['handle constructor key', withOwnKey('constructor', 'key-1'), validPayload()],
        ['handle prototype key', withOwnKey('prototype', 'key-1'), validPayload()],
        ['handle extra key', { ...validKeyHandle(), extra: 'x' }, validPayload()],
        ['handle missing key', { keyId: 'key-1', algorithm: 'Ed25519' }, validPayload()],
        [
          'handle non-enumerable key',
          Object.defineProperty({ ...validKeyHandle() }, 'health', {
            enumerable: false,
            value: 'healthy',
          }),
          validPayload(),
        ],
        ['handle symbol key', { ...validKeyHandle(), [Symbol('extra')]: 'x' }, validPayload()],
        ['payload extra key', validKeyHandle(), { content: 'c', extra: 'x' }],
        ['payload missing key', validKeyHandle(), {}],
        [
          'payload non-enumerable key',
          validKeyHandle(),
          Object.defineProperty({ content: 'c' }, 'content', { enumerable: false, value: 'c' }),
        ],
        ['payload symbol key', validKeyHandle(), { content: 'c', [Symbol('extra')]: 'x' }],
        [
          'payload polluting key',
          validKeyHandle(),
          Object.defineProperty({ content: 'c' } as Record<string, unknown>, 'constructor', {
            enumerable: true,
            value: 'x',
          }),
        ],
      ];
      for (const [name, keyHandle, payload] of cases) {
        const result = await port.sign(keyHandle as KmsKeyHandle, payload as SignPayload);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses oversized strings, empty strings, and enormous lengths in O(1)', async () => {
      const port = create();
      const cases: Array<[string, unknown, unknown]> = [
        ['oversized keyId', { ...validKeyHandle(), keyId: `k${'x'.repeat(2000)}` }, validPayload()],
        [
          'oversized algorithm',
          { ...validKeyHandle(), algorithm: `a${'x'.repeat(2000)}` },
          validPayload(),
        ],
        ['empty keyId', { ...validKeyHandle(), keyId: '' }, validPayload()],
        ['empty algorithm', { ...validKeyHandle(), algorithm: '' }, validPayload()],
        ['empty payload content', validKeyHandle(), { content: '' }],
        ['non-string payload content', validKeyHandle(), { content: 42 }],
        ['null payload content', validKeyHandle(), { content: null }],
      ];
      for (const [name, keyHandle, payload] of cases) {
        const result = await port.sign(keyHandle as KmsKeyHandle, payload as SignPayload);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });
  });
}
