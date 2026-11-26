import { describe, expect, it } from 'vitest';

import type {
  CloudProviderPort,
  DrainHostRequest,
  ProvisionHostRequest,
  TerminateHostRequest,
} from '../CloudProviderPort.out-port.js';

/**
 * The shared contract suite for CloudProviderPort. It runs against every
 * implementation of the port (today the in-memory fake, later any real
 * adapter), so implementations cannot drift from one another. It asserts both
 * `{ ok: true }` outcomes (which a constant-refuse provider fails) and
 * `{ ok: false, reason }` outcomes (which a constant-ok provider fails).
 * Holds no `.test.ts` suffix: the runners that import it collect it.
 */

/** Harness options a runner passes when creating its provider. */
export interface CloudProviderContractOptions {
  readonly quota?: number;
  readonly unavailable?: boolean;
  readonly clock?: () => string;
}

export function describeCloudProviderContract(
  label: string,
  create: (options?: CloudProviderContractOptions) => CloudProviderPort,
): void {
  describe(`CloudProviderPort contract (${label})`, () => {
    it('provisions, drains and terminates a host through the full lifecycle', async () => {
      const port = create({ quota: 2 });
      const provisioned = await port.provision({
        requestId: 'req-1',
        hostClass: 'standard',
      });
      expect(provisioned).toEqual({
        ok: true,
        hostId: expect.stringMatching(ID_PATTERN),
        hostClass: 'standard',
      });
      if (!provisioned.ok) {
        throw new Error('unreachable: provision must succeed here');
      }

      const drained = await port.drain({ hostId: provisioned.hostId });
      expect(drained).toEqual({ ok: true, hostId: provisioned.hostId });

      const terminated = await port.terminate({ hostId: provisioned.hostId });
      expect(terminated).toEqual({ ok: true, hostId: provisioned.hostId });
    });

    it('replays the same hostId for a repeated requestId with the same hostClass even at quota 1', async () => {
      const port = create({ quota: 1 });
      const first = await port.provision({
        requestId: 'req-1',
        hostClass: 'large',
      });
      expect(first).toEqual({ ok: true, hostId: expect.stringMatching(ID_PATTERN), hostClass: 'large' });
      if (!first.ok) {
        throw new Error('unreachable: first provision must succeed here');
      }

      const replay = await port.provision({
        requestId: 'req-1',
        hostClass: 'large',
      });
      // Quota was 1 and is now spent: the replay must still succeed and must
      // return the same hostId, not a refusal and not a second host.
      expect(replay).toEqual({ ok: true, hostId: first.hostId, hostClass: 'large' });
    });

    it('refuses provision when an existing requestId is reused with a different hostClass', async () => {
      const port = create({ quota: 2 });
      const first = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(first.ok).toBe(true);

      const replay = await port.provision({ requestId: 'req-1', hostClass: 'large' });
      expect(replay).toEqual({ ok: false, reason: 'invalid-request' });
    });

    it('refuses new provision when quota is exhausted', async () => {
      const port = create({ quota: 1 });
      const first = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(first.ok).toBe(true);

      const second = await port.provision({ requestId: 'req-2', hostClass: 'standard' });
      expect(second).toEqual({ ok: false, reason: 'quota' });
    });

    it('refuses the first provision when quota is 0', async () => {
      const port = create({ quota: 0 });
      const first = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(first).toEqual({ ok: false, reason: 'quota' });

      // A refused provision consumed nothing: the requestId is not provisioned.
      const again = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(again).toEqual({ ok: false, reason: 'quota' });
    });

    it('refuses provision when provider is unavailable', async () => {
      const port = create({ quota: 2, unavailable: true });
      const refused = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(refused).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('refuses drain and terminate for an unknown host with unknown-host', async () => {
      const port = create({ quota: 2 });
      expect(await port.drain({ hostId: 'host-absent' })).toEqual({
        ok: false,
        reason: 'unknown-host',
      });
      expect(await port.terminate({ hostId: 'host-absent' })).toEqual({
        ok: false,
        reason: 'unknown-host',
      });
    });

    it('refuses terminate of a host that was never drained with not-drained', async () => {
      const port = create({ quota: 2 });
      const provisioned = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) {
        throw new Error('unreachable: provision must succeed here');
      }

      const terminated = await port.terminate({ hostId: provisioned.hostId });
      expect(terminated).toEqual({ ok: false, reason: 'not-drained' });
    });

    it('drains an already-draining host idempotently', async () => {
      const port = create({ quota: 2 });
      const provisioned = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) {
        throw new Error('unreachable: provision must succeed here');
      }

      const first = await port.drain({ hostId: provisioned.hostId });
      expect(first).toEqual({ ok: true, hostId: provisioned.hostId });

      const second = await port.drain({ hostId: provisioned.hostId });
      expect(second).toEqual({ ok: true, hostId: provisioned.hostId });
    });

    it('refuses second terminate and post-terminate drain with unknown-host', async () => {
      const port = create({ quota: 2 });
      const provisioned = await port.provision({ requestId: 'req-1', hostClass: 'standard' });
      expect(provisioned.ok).toBe(true);
      if (!provisioned.ok) {
        throw new Error('unreachable: provision must succeed here');
      }
      expect(await port.drain({ hostId: provisioned.hostId })).toEqual({
        ok: true,
        hostId: provisioned.hostId,
      });
      expect(await port.terminate({ hostId: provisioned.hostId })).toEqual({
        ok: true,
        hostId: provisioned.hostId,
      });

      expect(await port.terminate({ hostId: provisioned.hostId })).toEqual({
        ok: false,
        reason: 'unknown-host',
      });
      expect(await port.drain({ hostId: provisioned.hostId })).toEqual({
        ok: false,
        reason: 'unknown-host',
      });
    });

    it('refuses hostile and malformed provision requests with invalid-request without invoking getters', async () => {
      const port = create({ quota: 2 });
      let getterRuns = 0;
      const getterRequest = defineGetter(
        { requestId: 'req-1', hostClass: 'standard' as const },
        'requestId',
        () => {
          getterRuns += 1;
          return 'req-1';
        },
      );

      for (const [name, request] of provisionHostileRequests(getterRequest)) {
        expect(await port.provision(request), name).toEqual({
          ok: false,
          reason: 'invalid-request',
        });
      }
      // The getter was never run: the value was read through its descriptor.
      expect(getterRuns).toBe(0);
    });

    it('refuses hostile and malformed drain and terminate requests with invalid-request without invoking getters', async () => {
      const port = create({ quota: 2 });
      let getterRuns = 0;
      const getterRequest = defineGetter({ hostId: 'host-0001' }, 'hostId', () => {
        getterRuns += 1;
        return 'host-0001';
      });

      for (const [name, request] of hostIdHostileRequests(getterRequest)) {
        expect(await port.drain(request as DrainHostRequest), `drain ${name}`).toEqual({
          ok: false,
          reason: 'invalid-request',
        });
        expect(await port.terminate(request as TerminateHostRequest), `terminate ${name}`).toEqual({
          ok: false,
          reason: 'invalid-request',
        });
      }
      expect(getterRuns).toBe(0);
    });
  });
}

/** The exact id/hostId shape the contract demands. */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** An object with one own key made an enumerable getter (never invoked by a conforming port). */
function defineGetter<T extends object>(source: T, key: keyof T, get: () => unknown): T {
  const out = { ...source };
  Reflect.deleteProperty(out, key as string);
  Object.defineProperty(out, key, {
    enumerable: true,
    get,
  });
  return out;
}

/** A proxy whose traps throw (a revoked-style hostile proxy). */
function throwingProxy(target: object): object {
  return new Proxy(target, {
    getPrototypeOf() {
      throw new Error('revoked');
    },
    ownKeys() {
      throw new Error('revoked');
    },
    getOwnPropertyDescriptor() {
      throw new Error('revoked');
    },
    get() {
      throw new Error('revoked');
    },
  });
}

function provisionHostileRequests(
  getterRequest: ProvisionHostRequest,
): Array<[string, ProvisionHostRequest]> {
  const valid = {
    requestId: 'req-1',
    hostClass: 'standard' as const,
  } satisfies ProvisionHostRequest;
  const withOwnKey = (key: string, value: unknown): ProvisionHostRequest => {
    const out = { ...valid };
    Object.defineProperty(out, key, { enumerable: true, value });
    return out;
  };
  const sparseArray = ['req-1', 'standard'];
  delete sparseArray[0];
  return [
    ['null', null as unknown as ProvisionHostRequest],
    ['undefined', undefined as unknown as ProvisionHostRequest],
    ['number', 42 as unknown as ProvisionHostRequest],
    ['string', 'request' as unknown as ProvisionHostRequest],
    ['boolean', true as unknown as ProvisionHostRequest],
    ['array', ['req-1', 'standard'] as unknown as ProvisionHostRequest],
    ['sparse array', sparseArray as unknown as ProvisionHostRequest],
    ['array-like', { 0: 'req-1', length: 1 } as unknown as ProvisionHostRequest],
    ['throwing getter', getterRequest],
    ['revoked-style proxy', throwingProxy({ ...valid }) as unknown as ProvisionHostRequest],
    ['__proto__ key', withOwnKey('__proto__', 'req-1')],
    ['constructor key', withOwnKey('constructor', 'req-1')],
    ['prototype key', withOwnKey('prototype', 'req-1')],
    ['extra key', withOwnKey('extra', 'x')],
    ['missing key', { requestId: 'req-1' } as unknown as ProvisionHostRequest],
    [
      'non-enumerable key',
      Object.defineProperty(
        { requestId: 'req-1', hostClass: 'standard' },
        'hostClass',
        { enumerable: false, value: 'standard' },
      ) as unknown as ProvisionHostRequest,
    ],
    ['symbol key', { ...valid, [Symbol('extra')]: 'x' } as unknown as ProvisionHostRequest],
    ['invalid requestId characters', { ...valid, requestId: 'bad id!' } as ProvisionHostRequest],
    ['empty requestId', { ...valid, requestId: '' } as ProvisionHostRequest],
    [
      'overlong requestId',
      { ...valid, requestId: `a${'b'.repeat(128)}` } as ProvisionHostRequest,
    ],
    ['invalid hostClass', { ...valid, hostClass: 'small' } as unknown as ProvisionHostRequest],
    ['numeric hostClass', { ...valid, hostClass: 2 } as unknown as ProvisionHostRequest],
  ];
}

function hostIdHostileRequests(getterRequest: DrainHostRequest): Array<[string, unknown]> {
  const valid = { hostId: 'host-0001' } as DrainHostRequest;
  const withOwnKey = (key: string, value: unknown): DrainHostRequest => {
    const out = { ...valid };
    Object.defineProperty(out, key, { enumerable: true, value });
    return out;
  };
  const sparseArray = ['host-0001'];
  delete sparseArray[0];
  return [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'host-0001'],
    ['boolean', true],
    ['array', ['host-0001']],
    ['sparse array', sparseArray],
    ['array-like', { 0: 'host-0001', length: 1 }],
    ['throwing getter', getterRequest],
    ['revoked-style proxy', throwingProxy({ ...valid })],
    ['__proto__ key', withOwnKey('__proto__', 'host-0001')],
    ['constructor key', withOwnKey('constructor', 'host-0001')],
    ['prototype key', withOwnKey('prototype', 'host-0001')],
    ['extra key', withOwnKey('extra', 'x')],
    ['missing key', {}],
    [
      'non-enumerable key',
      Object.defineProperty({ hostId: 'host-0001' }, 'hostId', {
        enumerable: false,
        value: 'host-0001',
      }),
    ],
    ['symbol key', { ...valid, [Symbol('extra')]: 'x' }],
    ['invalid hostId characters', { hostId: 'bad host!' }],
    ['empty hostId', { hostId: '' }],
    ['overlong hostId', { hostId: `a${'b'.repeat(128)}` }],
  ];
}
