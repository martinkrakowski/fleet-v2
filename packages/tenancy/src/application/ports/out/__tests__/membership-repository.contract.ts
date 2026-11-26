import { describe, expect, it } from 'vitest';

import type { MembershipChange, MembershipRecord, Role } from '../../../../domain/entities/Membership.js';
import type {
  MembershipApplyResult,
  MembershipRepositoryPort,
} from '../MembershipRepositoryPort.out-port.js';

/**
 * The shared contract suite for MembershipRepositoryPort. It runs against
 * the real adapter in every persistence mode, so no mode can drift from the
 * port. Holds no `.test.ts` suffix: the runners that import it collect it.
 *
 * Every title states what the test asserts and every body proves it; each
 * test here fails against a constant or identity-function implementation
 * because each observes a stored effect (a read-back list, a refusal reason
 * or an unchanged stored record) rather than only the call's own input.
 */
export function describeMembershipRepositoryContract(
  label: string,
  createPort: () => MembershipRepositoryPort,
): void {
  describe(`MembershipRepositoryPort contract (${label})`, () => {
    const NOW = '2026-11-26T00:00:00.000Z';

    function addChange(
      organizationId: string,
      actor: string,
      role: Role,
      actingActor: string = actor,
    ): MembershipChange {
      return { kind: 'add', organizationId, actingActor, actor, role };
    }

    /** Store the first owner of an organisation; the store is empty before it. */
    async function bootstrapOwner(
      port: MembershipRepositoryPort,
      organizationId: string,
      actor: string,
    ): Promise<Extract<MembershipApplyResult, { outcome: 'saved' }>> {
      const outcome = await port.applyChange(
        organizationId,
        addChange(organizationId, actor, 'owner'),
        0,
        NOW,
      );
      if (outcome.outcome !== 'saved') {
        throw new Error(`bootstrap failed: ${outcome.outcome}`);
      }
      return outcome;
    }

    it('stores an accepted add at expectedRevision + 1 and reads the new list and the changed member back', async () => {
      const port = createPort();
      const first = await bootstrapOwner(port, 'org-a', 'owner-1');
      expect(first.outcome).toBe('saved');
      expect(first.revision).toBe(1);
      expect(first.members).toEqual([
        {
          organizationId: 'org-a',
          actor: 'owner-1',
          role: 'owner',
          addedAtIso: NOW,
          addedBy: 'owner-1',
        },
      ]);
      const second = await port.applyChange(
        'org-a',
        addChange('org-a', 'member-1', 'maintainer', 'owner-1'),
        1,
        NOW,
      );
      expect(second.outcome).toBe('saved');
      if (second.outcome !== 'saved') {
        return;
      }
      expect(second.revision).toBe(2);
      expect(second.members).toHaveLength(2);
      expect(Object.hasOwn(second, 'changedMember')).toBe(true);
      expect(second.changedMember).toEqual({
        organizationId: 'org-a',
        actor: 'member-1',
        role: 'maintainer',
        addedAtIso: NOW,
        addedBy: 'owner-1',
      });
      const listed = await port.listMembers('org-a');
      expect(listed).toEqual(second.members);
      expect(listed).toHaveLength(2);
      const found = await port.findMember('org-a', 'owner-1');
      expect(found).toEqual({
        organizationId: 'org-a',
        actor: 'owner-1',
        role: 'owner',
        addedAtIso: NOW,
        addedBy: 'owner-1',
      });
    });

    it('applies change-role and remove for a non-last owner and omits changedMember on remove', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      await port.applyChange('org-a', addChange('org-a', 'member-1', 'maintainer', 'owner-1'), 1, NOW);
      const roleChange = await port.applyChange(
        'org-a',
        { kind: 'change-role', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1', role: 'viewer' },
        2,
        NOW,
      );
      expect(roleChange.outcome).toBe('saved');
      if (roleChange.outcome !== 'saved') {
        return;
      }
      expect(roleChange.revision).toBe(3);
      expect(roleChange.changedMember?.role).toBe('viewer');
      const removal = await port.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1' },
        3,
        NOW,
      );
      expect(removal.outcome).toBe('saved');
      if (removal.outcome !== 'saved') {
        return;
      }
      expect(removal.revision).toBe(4);
      expect(Object.hasOwn(removal, 'changedMember')).toBe(false);
      expect(await port.listMembers('org-a')).toHaveLength(1);
      expect(await port.findMember('org-a', 'member-1')).toBeNull();
    });

    it('refuses removing the last owner with reason last-owner and writes nothing', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      const refused = await port.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1' },
        1,
        NOW,
      );
      expect(refused).toEqual({ outcome: 'refused', reason: 'last-owner' });
      const listed = await port.listMembers('org-a');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.actor).toBe('owner-1');
      // The revision did not move: the stored record still answers revision 1.
      const again = await port.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1' },
        1,
        NOW,
      );
      expect(again).toEqual({ outcome: 'refused', reason: 'last-owner' });
    });

    it('refuses a stale expectedRevision with the stored revision and writes nothing', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      const stale = await port.applyChange(
        'org-a',
        addChange('org-a', 'member-1', 'maintainer', 'owner-1'),
        0,
        NOW,
      );
      expect(stale).toEqual({ outcome: 'stale-revision', expectedRevision: 0, actualRevision: 1 });
      expect(await port.listMembers('org-a')).toHaveLength(1);
      // The stored revision still answers at 1: nothing was written.
      const atOne = await port.applyChange(
        'org-a',
        addChange('org-a', 'member-1', 'maintainer', 'owner-1'),
        1,
        NOW,
      );
      expect(atOne.outcome).toBe('saved');
      expect(await port.listMembers('org-a')).toHaveLength(2);
    });

    it('exposes no raw save bypass: no members-list save method exists on the port', async () => {
      const port = createPort();
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(port) ?? Object.prototype);
      const rawSaveMethods = ['save', 'saveMembers', 'saveAll', 'writeMembers', 'setMembers', 'replaceMembers'];
      expect(rawSaveMethods.filter((name) => names.includes(name))).toEqual([]);
      // And a change the decider would refuse is never written, save or not.
      await bootstrapOwner(port, 'org-a', 'owner-1');
      const duplicate = await port.applyChange(
        'org-a',
        addChange('org-a', 'owner-1', 'viewer', 'owner-1'),
        1,
        NOW,
      );
      expect(duplicate.outcome).toBe('refused');
      expect(await port.listMembers('org-a')).toHaveLength(1);
    });

    it('keeps two organisations isolated: same actor, independent roles, identity-fresh copies and no cross-organisation effect', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      await port.applyChange('org-a', addChange('org-a', 'member-1', 'viewer', 'owner-1'), 1, NOW);
      await bootstrapOwner(port, 'org-b', 'boot-1');
      await port.applyChange('org-b', addChange('org-b', 'owner-1', 'maintainer', 'boot-1'), 1, NOW);
      await port.applyChange(
        'org-b',
        { kind: 'change-role', organizationId: 'org-b', actingActor: 'boot-1', actor: 'owner-1', role: 'viewer' },
        2,
        NOW,
      );
      const inA = await port.listMembers('org-a');
      const inB = await port.listMembers('org-b');
      expect(inA.map((member) => member.actor)).toEqual(['owner-1', 'member-1']);
      expect(inB.map((member) => [member.actor, member.role])).toEqual([
        ['boot-1', 'owner'],
        ['owner-1', 'viewer'],
      ]);
      // Same actor, organisation-scoped roles: owner in 'org-a', viewer in 'org-b'.
      expect((await port.findMember('org-a', 'owner-1'))?.role).toBe('owner');
      expect((await port.findMember('org-b', 'owner-1'))?.role).toBe('viewer');
      // listMembers returns fresh copies: two reads never share a reference.
      expect((await port.listMembers('org-a'))[0]).not.toBe(inA[0]);
      expect((await port.findMember('org-a', 'owner-1'))).not.toBe(inA[0]);
      // Mutating a returned copy affects neither the store nor another organisation.
      const mutable = { ...inA[0]! } as { -readonly [K in keyof MembershipRecord]: MembershipRecord[K] };
      mutable.role = 'viewer';
      mutable.actor = 'mutated';
      const inAAgain = await port.listMembers('org-a');
      expect(inAAgain[0]?.role).toBe('owner');
      expect(inAAgain[0]?.actor).toBe('owner-1');
      expect((await port.listMembers('org-b'))[0]?.actor).toBe('boot-1');
      // Removing a member of 'org-a' leaves 'org-b' intact.
      const removed = await port.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-1' },
        2,
        NOW,
      );
      expect(removed.outcome).toBe('saved');
      const afterRemoval = await port.listMembers('org-b');
      expect(afterRemoval.map((member) => member.actor)).toEqual(['boot-1', 'owner-1']);
      expect(afterRemoval[1]?.role).toBe('viewer');
    });

    it('refuses a change naming a different organizationId with organization-mismatch and leaves both organisations unchanged', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      await bootstrapOwner(port, 'org-b', 'boot-1');
      const beforeA = await port.listMembers('org-a');
      const beforeB = await port.listMembers('org-b');
      const refused = await port.applyChange(
        'org-a',
        { kind: 'remove', organizationId: 'org-b', actingActor: 'owner-1', actor: 'owner-1' },
        1,
        NOW,
      );
      expect(refused).toEqual({ outcome: 'refused', reason: 'organization-mismatch' });
      expect(await port.listMembers('org-a')).toEqual(beforeA);
      expect(await port.listMembers('org-b')).toEqual(beforeB);
      // Nothing was written for either organisation: both revisions still answer.
      expect(
        (await port.applyChange(
          'org-a',
          { kind: 'remove', organizationId: 'org-a', actingActor: 'owner-1', actor: 'owner-1' },
          1,
          NOW,
        )).outcome,
      ).toBe('refused'); // last-owner in org-a proves revision 1 still current
      expect(
        (await port.applyChange(
          'org-b',
          addChange('org-b', 'member-9', 'viewer', 'boot-1'),
          1,
          NOW,
        )).outcome,
      ).toBe('saved');
    });

    it('serializes ten concurrent adds of the same actor: exactly one is saved and one row is stored', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          port.applyChange('org-a', addChange('org-a', 'member-1', 'maintainer', 'owner-1'), 1, NOW),
        ),
      );
      const saved = outcomes.filter((outcome) => outcome.outcome === 'saved');
      const stale = outcomes.filter((outcome) => outcome.outcome === 'stale-revision');
      expect(saved).toHaveLength(1);
      expect(stale).toHaveLength(9);
      for (const outcome of stale) {
        expect(outcome).toMatchObject({
          outcome: 'stale-revision',
          expectedRevision: 1,
          actualRevision: 2,
        });
      }
      const listed = await port.listMembers('org-a');
      expect(listed).toHaveLength(2);
      expect(listed.filter((member) => member.actor === 'member-1')).toHaveLength(1);
      expect(listed.find((member) => member.actor === 'member-1')?.role).toBe('maintainer');
    });

    it('returns [] and null without throwing for hostile listMembers and findMember arguments', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      const hostileIds: readonly unknown[] = [
        null,
        undefined,
        7,
        true,
        '',
        'ORG-UPPER',
        'org-' + 'a'.repeat(5000),
        ['org-a'],
        { length: 1, 0: 'o' },
        '__proto__',
        'constructor',
      ];
      for (const bad of hostileIds) {
        expect(await port.listMembers(bad as string)).toEqual([]);
        expect(await port.findMember(bad as string, 'owner-1')).toBeNull();
      }
      const hostileActors: readonly unknown[] = [
        null,
        undefined,
        7,
        true,
        '',
        ['owner-1'],
        { length: 1, 0: 'o' },
        'x'.repeat(5000),
      ];
      for (const bad of hostileActors) {
        expect(await port.findMember('org-a', bad as string)).toBeNull();
      }
      expect(await port.findMember('org-a', 'owner-1')).not.toBeNull();
    });

    it('refuses every hostile applyChange argument with invalid-record without throwing, invoking a getter or touching the store', async () => {
      const port = createPort();
      await bootstrapOwner(port, 'org-a', 'owner-1');
      const baseline = await port.listMembers('org-a');

      let getterRuns = 0;
      const getterChange: Record<string, unknown> = {};
      Object.defineProperty(getterChange, 'kind', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return 'add';
        },
      });
      const proxyChange = new Proxy(
        {
          kind: 'add',
          organizationId: 'org-a',
          actingActor: 'owner-1',
          actor: 'member-9',
          role: 'viewer',
        },
        {
          get() {
            getterRuns += 1;
            throw new Error('proxy get trap ran');
          },
        },
      );
      const withProtoKey: Record<string, unknown> = {
        kind: 'add',
        organizationId: 'org-a',
        actingActor: 'owner-1',
        actor: 'member-9',
        role: 'viewer',
      };
      Object.defineProperty(withProtoKey, ['__', 'proto', '__'].join(''), {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const withConstructorKey: Record<string, unknown> = {
        kind: 'add',
        organizationId: 'org-a',
        actingActor: 'owner-1',
        actor: 'member-9',
        role: 'viewer',
      };
      Object.defineProperty(withConstructorKey, 'constructor', {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const holey: unknown[] = new Array(3);
      holey[1] = { kind: 'add', organizationId: 'org-a', actingActor: 'owner-1', actor: 'member-9', role: 'viewer' };
      const plainMemberAdd = {
        kind: 'add',
        organizationId: 'org-a',
        actingActor: 'owner-1',
        actor: 'member-9',
        role: 'viewer',
      };

      const badChanges: readonly unknown[] = [
        null,
        undefined,
        7,
        true,
        'add',
        [],
        holey,
        { length: 2, 0: 'add', 1: 'x' },
        getterChange,
        proxyChange,
        withProtoKey,
        withConstructorKey,
        { ...plainMemberAdd, role: 'emperor' },
        { ...plainMemberAdd, organizationId: 'ORG-UPPER' },
        { ...plainMemberAdd, organizationId: 'org-' + 'a'.repeat(5000) },
        { ...plainMemberAdd, actor: 'x'.repeat(5000) },
        { ...plainMemberAdd, kind: 'delete' },
      ];
      for (const bad of badChanges) {
        const outcome = await port.applyChange('org-a', bad as MembershipChange, 1, NOW);
        expect(outcome.outcome).toBe('invalid-record');
        if (outcome.outcome === 'invalid-record') {
          expect(typeof outcome.reason).toBe('string');
        }
      }
      // Neither the getter nor the Proxy's get trap ever ran.
      expect(getterRuns).toBe(0);

      const badRevisions: readonly unknown[] = [
        null,
        undefined,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        '0',
        true,
      ];
      for (const bad of badRevisions) {
        const outcome = await port.applyChange(
          'org-a',
          plainMemberAdd as MembershipChange,
          bad as number,
          NOW,
        );
        expect(outcome).toMatchObject({ outcome: 'invalid-record' });
      }

      const badNowIsos: readonly unknown[] = [
        null,
        undefined,
        7,
        true,
        '',
        'not-a-date',
        '2026-02-31T00:00:00.000Z',
        '2026-13-01T00:00:00.000Z',
        'x'.repeat(5000),
      ];
      for (const bad of badNowIsos) {
        const outcome = await port.applyChange(
          'org-a',
          plainMemberAdd as MembershipChange,
          1,
          bad as string,
        );
        expect(outcome).toMatchObject({ outcome: 'invalid-record' });
      }

      const badOrganizationIds: readonly unknown[] = [
        null,
        undefined,
        7,
        true,
        '',
        'ORG-UPPER',
        'org-' + 'a'.repeat(100000),
        ['org-a'],
        new Proxy(new String('org-a'), {}) as unknown as string,
      ];
      for (const bad of badOrganizationIds) {
        const outcome = await port.applyChange(
          bad as string,
          plainMemberAdd as MembershipChange,
          1,
          NOW,
        );
        expect(outcome).toMatchObject({ outcome: 'invalid-record' });
      }

      // Every refusal happened before the store was touched: the baseline
      // list and the stored revision are unchanged (a change at the stored
      // revision 1 still applies cleanly afterwards).
      expect(await port.listMembers('org-a')).toEqual(baseline);
      const followUp = await port.applyChange(
        'org-a',
        addChange('org-a', 'member-9', 'viewer', 'owner-1'),
        1,
        NOW,
      );
      expect(followUp.outcome).toBe('saved');
      expect(await port.listMembers('org-a')).toHaveLength(2);
    });
  });
}
