import { describe, expect, it } from 'vitest';

import type { OrganizationRecord } from '../../../../domain/entities/Organization.js';
import type {
  OrganizationRepositoryPort,
  OrganizationWriteOutcome,
} from '../OrganizationRepositoryPort.out-port.js';

/**
 * The shared contract suite for OrganizationRepositoryPort. It runs against
 * the real adapter in every persistence mode, so no mode can drift from the
 * port. Holds no `.test.ts` suffix: the runners that import it collect it.
 *
 * Every title states what the test asserts and every body proves it; each
 * test here fails against a constant or identity-function implementation
 * because each observes a stored effect (a read-back value, a refusal reason
 * or an unchanged stored record) rather than only the call's own input.
 */
export function describeOrganizationRepositoryContract(
  label: string,
  createPort: () => OrganizationRepositoryPort,
): void {
  describe(`OrganizationRepositoryPort contract (${label})`, () => {
    it('stores a new organization at revision 0 and reads it back unchanged', async () => {
      const port = createPort();
      const outcome = await port.createOrganization(makeOrg());
      expect(outcome.status).toBe('saved');
      if (outcome.status !== 'saved') {
        return;
      }
      expect(outcome.revision).toBe(0);
      expect(outcome.record).toEqual(makeOrg());
      const found = await port.findOrganization('org-1');
      expect(found).not.toBeNull();
      expect(found?.record).toEqual(outcome.record);
      expect(found?.revision).toBe(0);
    });

    it('refuses createOrganization with already-exists when the id is taken and keeps the stored record', async () => {
      const port = createPort();
      expect((await port.createOrganization(makeOrg())).status).toBe('saved');
      const second = await port.createOrganization(makeOrg({ displayName: 'Other Name' }));
      expect(second).toEqual({ status: 'refused', reason: 'already-exists' });
      const found = await port.findOrganization('org-1');
      expect(found?.record.displayName).toBe('Org One');
      expect(found?.revision).toBe(0);
    });

    it('returns null for a missing organization and lists only stored ones in insertion order', async () => {
      const port = createPort();
      expect(await port.findOrganization('org-absent')).toBeNull();
      expect(await port.listOrganizations()).toEqual([]);
      await port.createOrganization(makeOrg({ organizationId: 'org-a' }));
      await port.createOrganization(makeOrg({ organizationId: 'org-b' }));
      const list = await port.listOrganizations();
      expect(list.map((stored) => stored.record.organizationId)).toEqual(['org-a', 'org-b']);
      expect(list.every((stored) => stored.revision === 0)).toBe(true);
    });

    it('saveOrganization stores at expectedRevision + 1 and reads the new record back', async () => {
      const port = createPort();
      await port.createOrganization(makeOrg());
      const outcome = await port.saveOrganization(makeOrg({ displayName: 'Renamed' }), 0);
      expect(outcome).toEqual({
        status: 'saved',
        record: makeOrg({ displayName: 'Renamed' }),
        revision: 1,
      });
      const found = await port.findOrganization('org-1');
      expect(found?.record.displayName).toBe('Renamed');
      expect(found?.revision).toBe(1);
    });

    it('refuses saveOrganization with not-found when the record does not exist', async () => {
      const port = createPort();
      const outcome = await port.saveOrganization(makeOrg({ organizationId: 'org-absent' }), 0);
      expect(outcome).toEqual({ status: 'refused', reason: 'not-found' });
      expect(await port.listOrganizations()).toEqual([]);
    });

    it('refuses saveOrganization with stale-revision when expectedRevision does not match and keeps the stored record', async () => {
      const port = createPort();
      await port.createOrganization(makeOrg());
      await port.saveOrganization(makeOrg({ displayName: 'Second' }), 0);
      const stale = await port.saveOrganization(makeOrg({ displayName: 'Third' }), 0);
      expect(stale).toEqual({ status: 'refused', reason: 'stale-revision' });
      const found = await port.findOrganization('org-1');
      expect(found?.record.displayName).toBe('Second');
      expect(found?.revision).toBe(1);
    });

    it('refuses saveOrganization with invalid-record when expectedRevision is not a non-negative safe integer', async () => {
      const port = createPort();
      await port.createOrganization(makeOrg());
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        const outcome = await port.saveOrganization(makeOrg({ displayName: 'Never' }), bad);
        expect(outcome).toEqual({ status: 'refused', reason: 'invalid-record' });
      }
      const found = await port.findOrganization('org-1');
      expect(found?.record.displayName).toBe('Org One');
      expect(found?.revision).toBe(0);
    });

    it('isolates returned and stored records from caller-retained mutable aliases', async () => {
      const port = createPort();
      await port.createOrganization(makeOrg());
      const found = (await port.findOrganization('org-1'))!;
      const mutable = { ...found.record } as { -readonly [K in keyof OrganizationRecord]: OrganizationRecord[K] };
      mutable.displayName = 'Mutated';
      mutable.status = 'retired';
      (found as { revision: number }).revision = 99;
      const again = await port.findOrganization('org-1');
      expect(again?.record).toEqual(makeOrg());
      expect(again?.revision).toBe(0);
      expect((await port.listOrganizations())[0]?.record).toEqual(makeOrg());
      expect(mutable.displayName).toBe('Mutated');
    });

    it('refuses invalid records and hostile inputs (null, undefined, primitives, arrays, getters, Proxies, prototype-polluting keys) with invalid-record without throwing or invoking getters', async () => {
      const port = createPort();
      let getterCalls = 0;
      const getterRecord = {};
      Object.defineProperty(getterRecord, 'organizationId', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 'org-1';
        },
      });
      const pollutingKey = ['__', 'proto', '__'].join('');
      const withPollutingKey: Record<string, unknown> = { ...makeOrg() };
      Object.defineProperty(withPollutingKey, pollutingKey, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const holey: unknown[] = new Array(3);
      holey[1] = makeOrg();
      const oversized = makeOrg({ organizationId: 'org-' + 'a'.repeat(5000) });
      const proxyRecord = new Proxy({ ...makeOrg() }, {
        get(target, key) {
          if (key === 'organizationId') {
            getterCalls += 1;
            return Reflect.get(target, key);
          }
          return Reflect.get(target, key);
        },
      });
      const badInputs: readonly unknown[] = [
        null,
        undefined,
        'org-1',
        7,
        [],
        [makeOrg()],
        getterRecord,
        proxyRecord,
        withPollutingKey,
        holey,
        oversized,
        { ...makeOrg(), organizationId: 7 },
        { ...makeOrg(), status: 'paused' },
        { ...makeOrg(), extraKey: 'x' },
      ];
      for (const bad of badInputs) {
        const created = await port.createOrganization(bad as OrganizationRecord);
        expect(created.status).toBe('refused');
        if (created.status === 'refused') {
          expect(created.reason).toBe('invalid-record');
        }
        const saved = await port.saveOrganization(bad as OrganizationRecord, 0);
        expect(saved.status).toBe('refused');
        if (saved.status === 'refused') {
          expect(saved.reason).toBe('invalid-record');
        }
      }
      // Neither the getter property nor the Proxy's get trap was ever invoked.
      expect(getterCalls).toBe(0);
      expect(await port.listOrganizations()).toEqual([]);
    });

    it('refuses a non-string or empty id on findOrganization with a named error instead of answering absence', async () => {
      const port = createPort();
      await port.createOrganization(makeOrg());
      for (const bad of [null, undefined, 7, ['org-1'], '']) {
        await expect(
          port.findOrganization(bad as string),
        ).rejects.toThrow('OrganizationRepositoryAdapter refuses an unsafe organization id');
      }
      expect(await port.findOrganization('org-1')).not.toBeNull();
    });
  });
}

export function makeOrg(overrides: Partial<OrganizationRecord> = {}): OrganizationRecord {
  return {
    organizationId: 'org-1',
    displayName: 'Org One',
    status: 'active',
    createdAtIso: '2026-11-01T00:00:00.000Z',
    retiredAtIso: null,
    ...overrides,
  };
}

/** Type guard helper for outcomes in tests that assert a refusal shape. */
export function expectRefused(
  outcome: OrganizationWriteOutcome,
  reason: 'already-exists' | 'not-found' | 'stale-revision' | 'invalid-record',
): void {
  expect(outcome).toEqual({ status: 'refused', reason });
}
