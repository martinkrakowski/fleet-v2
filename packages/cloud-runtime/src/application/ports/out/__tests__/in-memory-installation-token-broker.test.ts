import { describe, expect, it } from 'vitest';

import {
  isInstallationTokenExpired,
  MAX_INSTALLATION_TOKEN_TTL_SECONDS,
} from '../InstallationTokenBrokerPort.out-port.js';
import { InMemoryInstallationTokenBroker } from './in-memory-installation-token-broker.js';
import { describeInstallationTokenBrokerContract } from './installation-token-broker.contract.js';

describeInstallationTokenBrokerContract('in-memory', (options) => {
  return new InMemoryInstallationTokenBroker({ seed: options?.seed });
});

describe('InMemoryInstallationTokenBroker fake-specific behaviour', () => {
  it('verifies token use with verifyTokenUse: an issued token before expiry verifies, an expired one is token-expired', async () => {
    const broker = new InMemoryInstallationTokenBroker();
    const issued = await broker.issue({
      organization: 'octo',
      repository: 'octo/repo',
      permission: 'push',
      ttlSeconds: 600,
      nowIso: '2026-11-26T11:00:00.000Z',
      credential: {
        repository: 'octo/repo',
        permission: 'push',
        expiresAtIso: '2026-11-26T12:00:00.000Z',
      },
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      throw new Error('unreachable: a valid in-scope request must succeed here');
    }

    const before = broker.verifyTokenUse(issued.token, '2026-11-26T11:09:59.999Z');
    expect(before).toEqual({ ok: true, repository: 'octo/repo', permission: 'push' });

    // The token is expired at its exact expiresAtIso (now >= expiresAt).
    const atExpiry = broker.verifyTokenUse(issued.token, '2026-11-26T11:10:00.000Z');
    expect(atExpiry).toEqual({ ok: false, reason: 'token-expired' });
    const after = broker.verifyTokenUse(issued.token, '2026-11-26T11:10:01.000Z');
    expect(after).toEqual({ ok: false, reason: 'token-expired' });
  });

  it('refuses unknown and malformed tokens in verifyTokenUse with invalid-request, never a pass', () => {
    const broker = new InMemoryInstallationTokenBroker();
    for (const [name, token] of [
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['empty string', ''],
      ['wrong prefix', 'tok-abcdef01'],
      ['unknown token', 'itk-00000000'],
    ] as Array<[string, unknown]>) {
      expect(broker.verifyTokenUse(token, '2026-11-26T11:00:00.000Z'), name).toEqual({
        ok: false,
        reason: 'invalid-request',
      });
    }
    // A malformed nowIso fails closed: an unparseable instant counts as expired.
    expect(broker.verifyTokenUse('itk-00000000', 'not-a-date')).toEqual({
      ok: false,
      reason: 'invalid-request',
    });
  });

  it('isInstallationTokenExpired returns true for malformed or non-calendar instants and at the exact expiry instant', () => {
    expect(isInstallationTokenExpired('2026-11-26T12:00:00.000Z', '2026-11-26T11:59:59.999Z')).toBe(false);
    expect(isInstallationTokenExpired('2026-11-26T12:00:00.000Z', '2026-11-26T12:00:00.000Z')).toBe(true);
    for (const [expiresAtIso, nowIso] of [
      [null, '2026-11-26T11:00:00.000Z'],
      [undefined, '2026-11-26T11:00:00.000Z'],
      [42, '2026-11-26T11:00:00.000Z'],
      ['', '2026-11-26T11:00:00.000Z'],
      ['not-a-date', '2026-11-26T11:00:00.000Z'],
      ['2026-02-30T12:00:00.000Z', '2026-11-26T11:00:00.000Z'],
      ['2026-11-26T12:00:00.000Z', null],
      ['2026-11-26T12:00:00.000Z', 'yesterday'],
      ['2026-13-01T12:00:00.000Z', '2026-11-26T11:00:00.000Z'],
      ['2026-11-26T25:00:00.000Z', '2026-11-26T11:00:00.000Z'],
    ] as Array<[unknown, unknown]>) {
      expect(isInstallationTokenExpired(expiresAtIso, nowIso), JSON.stringify([expiresAtIso, nowIso])).toBe(true);
    }
  });

  it('serialises the fake and every issued result without exposing the seed (JSON.stringify reveals no key bytes)', async () => {
    const seed = 'super-secret-seed-bytes';
    const broker = new InMemoryInstallationTokenBroker({ seed });
    const issued = await broker.issue({
      organization: 'octo',
      repository: 'octo/repo',
      permission: 'push',
      ttlSeconds: MAX_INSTALLATION_TOKEN_TTL_SECONDS,
      nowIso: '2026-11-26T11:00:00.000Z',
      credential: {
        repository: 'octo/repo',
        permission: 'push',
        expiresAtIso: '2026-12-26T12:00:00.000Z',
      },
    });
    expect(issued.ok).toBe(true);
    expect(JSON.stringify(broker)).not.toContain(seed);
    expect(JSON.stringify(issued)).not.toContain(seed);
    // And the serialisations carry no property that even names a secret.
    expect(JSON.stringify(broker)).toBe('{}');
    if (issued.ok) {
      expect(Object.keys(issued).sort()).toEqual([
        'expiresAtIso',
        'ok',
        'permission',
        'repository',
        'token',
      ]);
    }
  });
});
