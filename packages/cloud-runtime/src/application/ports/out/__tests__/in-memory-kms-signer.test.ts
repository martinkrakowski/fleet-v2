import { describe, expect, it } from 'vitest';

import { MAX_SIGN_PAYLOAD_BYTES } from '../KmsSignerPort.out-port.js';
import { InMemoryKmsSigner } from './in-memory-kms-signer.js';
import { describeKmsSignerContract } from './kms-signer.contract.js';

describeKmsSignerContract('in-memory', (options) => {
  return new InMemoryKmsSigner({
    health: options?.health,
    seed: options?.seed,
  });
});

describe('InMemoryKmsSigner fake-specific behaviour', () => {
  it('registers only the configured keys, so an unconfigured keyId is unknown-key even when well-formed', async () => {
    const signer = new InMemoryKmsSigner({
      keys: [{ keyId: 'custom-key', algorithm: 'ECDSA-P256' }],
    });
    const signed = await signer.sign(
      { keyId: 'custom-key', algorithm: 'ECDSA-P256', health: 'healthy' },
      { content: 'payload-bytes' },
    );
    expect(signed).toEqual({
      ok: true,
      signature: expect.stringMatching(/^sig-[0-9a-f]{8}$/),
      keyId: 'custom-key',
      algorithm: 'ECDSA-P256',
    });

    // The default key-1 registration is not present on this instance.
    const unknown = await signer.sign(
      { keyId: 'key-1', algorithm: 'Ed25519', health: 'healthy' },
      { content: 'payload-bytes' },
    );
    expect(unknown).toEqual({ ok: false, reason: 'unknown-key' });
  });

  it('signs deterministically from the injected seed: identical seeds and inputs yield identical signatures', async () => {
    const first = new InMemoryKmsSigner({ seed: 'fixed-seed' });
    const second = new InMemoryKmsSigner({ seed: 'fixed-seed' });
    const handle = { keyId: 'key-1', algorithm: 'Ed25519', health: 'healthy' as const };
    const a = await first.sign(handle, { content: 'payload-bytes' });
    const b = await second.sign(handle, { content: 'payload-bytes' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      throw new Error('unreachable: valid signing inputs must succeed here');
    }
    expect(b.signature).toBe(a.signature);
  });

  it('serialises the fake and every signature result without exposing the seed (JSON.stringify reveals no key bytes)', async () => {
    const seed = 'super-secret-kms-seed-bytes';
    const signer = new InMemoryKmsSigner({ seed });
    const signed = await signer.sign(
      { keyId: 'key-1', algorithm: 'Ed25519', health: 'healthy' },
      { content: 'x'.repeat(MAX_SIGN_PAYLOAD_BYTES) },
    );
    expect(signed.ok).toBe(true);
    expect(JSON.stringify(signer)).not.toContain(seed);
    expect(JSON.stringify(signed)).not.toContain(seed);
    // The fake serialises to an empty object: nothing but the ES #private
    // fields exists on it.
    expect(JSON.stringify(signer)).toBe('{}');
  });
});
