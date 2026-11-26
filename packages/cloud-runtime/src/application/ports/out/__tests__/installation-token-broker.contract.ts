import { describe, expect, it } from 'vitest';

import type { IssueInstallationTokenRequest, InstallationTokenBrokerPort } from '../InstallationTokenBrokerPort.out-port.js';
import { MAX_INSTALLATION_TOKEN_TTL_SECONDS } from '../InstallationTokenBrokerPort.out-port.js';

/**
 * The shared contract suite for InstallationTokenBrokerPort. It runs against
 * every implementation of the port (today the in-memory fake, later any real
 * adapter), so implementations cannot drift from one another. It asserts both
 * `{ ok: true }` outcomes (which a constant-refuse broker fails) and
 * `{ ok: false, reason }` outcomes (which a constant-ok broker fails), and it
 * never imports the fake. Holds no `.test.ts` suffix: the runners that import
 * it collect it.
 */

/** Harness options a runner passes when creating its broker. */
export interface InstallationTokenBrokerContractOptions {
  readonly seed?: string;
}

/** The valid in-scope request every other case derives from. */
export function validBrokerRequest(): IssueInstallationTokenRequest {
  return {
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
  };
}

export function describeInstallationTokenBrokerContract(
  label: string,
  create: (options?: InstallationTokenBrokerContractOptions) => InstallationTokenBrokerPort,
): void {
  describe(`InstallationTokenBrokerPort contract (${label})`, () => {
    it('issues a scoped token for a valid in-scope request and reports the exact expiry', async () => {
      const port = create();
      const result = await port.issue(validBrokerRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('unreachable: a valid in-scope request must succeed here');
      }
      expect(result.token).toMatch(/^itk-[0-9a-f]{8}$/);
      expect(result.expiresAtIso).toBe('2026-11-26T11:10:00.000Z');
      expect(result.repository).toBe('octo/repo');
      expect(result.permission).toBe('push');
    });

    it('issues a token at the exact 3600-second TTL ceiling (now + 3600s)', async () => {
      const port = create();
      const result = await port.issue({ ...validBrokerRequest(), ttlSeconds: MAX_INSTALLATION_TOKEN_TTL_SECONDS });
      expect(result).toEqual({
        ok: true,
        token: expect.stringMatching(/^itk-[0-9a-f]{8}$/),
        expiresAtIso: '2026-11-26T12:00:00.000Z',
        repository: 'octo/repo',
        permission: 'push',
      });
    });

    it('issues deterministic tokens: two identically-seeded brokers issue the same token for the same request', async () => {
      const first = await create({ seed: 'contract-seed' }).issue(validBrokerRequest());
      const second = await create({ seed: 'contract-seed' }).issue(validBrokerRequest());
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error('unreachable: valid in-scope requests must succeed here');
      }
      // No randomness may enter issuance: the same seed and the same request
      // must yield the very same token, which a random implementation fails.
      expect(second.token).toBe(first.token);
    });

    it('refuses ttlSeconds above 3600 with ttl-too-long', async () => {
      const port = create();
      for (const ttlSeconds of [MAX_INSTALLATION_TOKEN_TTL_SECONDS + 1, 100_000]) {
        const result = await port.issue({ ...validBrokerRequest(), ttlSeconds });
        expect(result, `ttlSeconds ${String(ttlSeconds)}`).toEqual({ ok: false, reason: 'ttl-too-long' });
      }
    });

    it('refuses organization or repository outside credential scope with scope-denied', async () => {
      const port = create();
      const wrongOrganization = await port.issue({ ...validBrokerRequest(), organization: 'other' });
      expect(wrongOrganization).toEqual({ ok: false, reason: 'scope-denied' });
      const wrongRepository = await port.issue({ ...validBrokerRequest(), repository: 'octo/other' });
      expect(wrongRepository).toEqual({ ok: false, reason: 'scope-denied' });
    });

    it('refuses a requested permission outside credential scope with scope-denied', async () => {
      const port = create();
      const result = await port.issue({ ...validBrokerRequest(), permission: 'merge' });
      expect(result).toEqual({ ok: false, reason: 'scope-denied' });
    });

    it('refuses an expired credential at nowIso with credential-expired (including the exact expiry instant)', async () => {
      const port = create();
      const atExpiry = await port.issue({
        ...validBrokerRequest(),
        nowIso: '2026-11-26T12:00:00.000Z',
      });
      expect(atExpiry).toEqual({ ok: false, reason: 'credential-expired' });
      const afterExpiry = await port.issue({
        ...validBrokerRequest(),
        nowIso: '2026-11-26T12:00:01.000Z',
      });
      expect(afterExpiry).toEqual({ ok: false, reason: 'credential-expired' });
    });

    it('refuses null, undefined, and wrong primitives with invalid-request', async () => {
      const port = create();
      for (const [name, request] of [
        ['null', null],
        ['undefined', undefined],
        ['number', 42],
        ['string', 'request'],
        ['boolean', true],
      ] as Array<[string, unknown]>) {
        const result = await port.issue(request as IssueInstallationTokenRequest);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses arrays, sparse arrays with holes, array-likes, and non-iterables with invalid-request', async () => {
      const port = create();
      const sparseArray: Array<unknown> = new Array(2);
      sparseArray[1] = 'x';
      for (const [name, request] of [
        ['array', ['octo', 'push']],
        ['sparse array', sparseArray],
        ['array-like', { 0: 'octo', length: 1 }],
        ['enormous array-like', { length: 1e9 }],
        ['nested array credential', { ...validBrokerRequest(), credential: ['octo/repo'] }],
      ] as Array<[string, unknown]>) {
        const result = await port.issue(request as IssueInstallationTokenRequest);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses getter properties without invoking the getter', async () => {
      const port = create();
      let getterRuns = 0;
      const request = { ...validBrokerRequest() };
      Reflect.deleteProperty(request, 'nowIso');
      Object.defineProperty(request, 'nowIso', {
        enumerable: true,
        get: () => {
          getterRuns += 1;
          return '2026-11-26T11:00:00.000Z';
        },
      });
      const result = await port.issue(request);
      expect(result).toEqual({ ok: false, reason: 'invalid-request' });
      expect(getterRuns).toBe(0);
    });

    it('refuses Proxy inputs via isProxy without running traps', async () => {
      const port = create();
      let trapRuns = 0;
      const countingProxy = new Proxy(validBrokerRequest(), {
        get(target, key, receiver) {
          trapRuns += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const result = await port.issue(countingProxy as IssueInstallationTokenRequest);
      expect(result).toEqual({ ok: false, reason: 'invalid-request' });
      expect(trapRuns).toBe(0);

      const revokedProxy = new Proxy(validBrokerRequest(), {
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
      const revokedResult = await port.issue(revokedProxy as IssueInstallationTokenRequest);
      expect(revokedResult).toEqual({ ok: false, reason: 'invalid-request' });
    });

    it('refuses prototype-polluting, extra, missing, symbol, and non-enumerable keys without echoing', async () => {
      const port = create();
      const valid = validBrokerRequest();
      const withOwnKey = (key: string, value: unknown): IssueInstallationTokenRequest => {
        const out: Record<string, unknown> = { ...valid };
        Object.defineProperty(out, key, { enumerable: true, value });
        return out as unknown as IssueInstallationTokenRequest;
      };
      const cases: Array<[string, unknown]> = [
        ['__proto__ key', withOwnKey('__proto__', 'octo')],
        ['constructor key', withOwnKey('constructor', 'octo')],
        ['prototype key', withOwnKey('prototype', 'octo')],
        ['extra key', withOwnKey('extra', 'x')],
        ['missing key', { ...valid, organization: undefined }],
        [
          'non-enumerable key',
          Object.defineProperty({ ...valid }, 'permission', { enumerable: false, value: 'push' }),
        ],
        ['symbol key', { ...valid, [Symbol('extra')]: 'x' }],
        ['credential extra key', { ...valid, credential: { ...valid.credential, extra: 'x' } }],
        [
          'credential polluting key',
          {
            ...valid,
            credential: Object.defineProperty({ ...valid.credential }, 'constructor', {
              enumerable: true,
              value: 'x',
            }),
          },
        ],
      ];
      for (const [name, request] of cases) {
        const result = await port.issue(request as IssueInstallationTokenRequest);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });

    it('refuses oversized strings, enormous lengths, and invalid TTLs in O(1)', async () => {
      const port = create();
      const cases: Array<[string, IssueInstallationTokenRequest]> = [
        [
          'oversized organization',
          { ...validBrokerRequest(), organization: `o${'x'.repeat(2000)}` },
        ],
        [
          'over-limit repository',
          { ...validBrokerRequest(), repository: 'octo/repo', organization: 'a'.repeat(301) },
        ],
        [
          'wildcard repository',
          { ...validBrokerRequest(), repository: 'octo/*' },
        ],
        [
          'url-scheme repository',
          { ...validBrokerRequest(), repository: 'https://octo/repo' },
        ],
        ['zero ttlSeconds', { ...validBrokerRequest(), ttlSeconds: 0 }],
        ['negative ttlSeconds', { ...validBrokerRequest(), ttlSeconds: -5 }],
        ['fractional ttlSeconds', { ...validBrokerRequest(), ttlSeconds: 1.5 }],
        ['NaN ttlSeconds', { ...validBrokerRequest(), ttlSeconds: Number.NaN }],
        ['Infinity ttlSeconds', { ...validBrokerRequest(), ttlSeconds: Number.POSITIVE_INFINITY }],
        [
          'malformed nowIso',
          { ...validBrokerRequest(), nowIso: 'not-a-date' },
        ],
        [
          'impossible calendar nowIso',
          { ...validBrokerRequest(), nowIso: '2026-02-30T11:00:00.000Z' },
        ],
        [
          'malformed credential expiresAtIso',
          { ...validBrokerRequest(), credential: { ...validBrokerRequest().credential, expiresAtIso: 'yesterday' } },
        ],
        [
          'oversized credential repository',
          {
            ...validBrokerRequest(),
            credential: { ...validBrokerRequest().credential, repository: `o/${'x'.repeat(2000)}` },
          },
        ],
      ];
      for (const [name, request] of cases) {
        const result = await port.issue(request);
        expect(result, name).toEqual({ ok: false, reason: 'invalid-request' });
      }
    });
  });
}
