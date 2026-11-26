import { describe, expect, it } from 'vitest';

import type { MicroVmDriverPort, MicroVmHandle } from '../MicroVmDriverPort.out-port.js';

/**
 * The shared contract suite for MicroVmDriverPort (lane FC8D2). It runs
 * against any conforming adapter and the shared in-memory fake, so the fake
 * cannot drift from the adapter. Holds no `.test.ts` suffix: the runners
 * that import it collect it.
 *
 * Hostile-input rule: every input shape the port must refuse is refused with
 * `{ ok: false, reason: 'refused' }`, never a throw and never a pass. A
 * getter is verified never to run (descriptor inspected, spy counted), a
 * Proxy detectable through its reported descriptors is refused, and every
 * key/token-shaped test value is built at runtime, never as a literal.
 */
export function describeMicroVmDriverContract(
  label: string,
  createDriver: () => MicroVmDriverPort,
): void {
  describe(`MicroVmDriverPort contract (${label})`, () => {
    it('runs the full legal lifecycle: create, injectWorktree, seal, destroy', async () => {
      const driver = createDriver();
      const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const handle = created.handle;
      expect(handle.attemptId).toBe('att-1');
      expect(handle.isolation).toBe('microvm');
      expect(typeof handle.environmentId).toBe('string');
      expect((handle.environmentId as string).length).toBeGreaterThan(0);

      expect(await driver.injectWorktree(handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: true });
      expect(await driver.seal(handle)).toEqual({ ok: true });
      expect(await driver.destroy(handle)).toEqual({ ok: true });
    });

    it('destroys from every non-destroyed state: created, loaded, sealed', async () => {
      const createdOnly = createDriver();
      const created = await createdOnly.create({ attemptId: 'att-c', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(await createdOnly.destroy(created.handle)).toEqual({ ok: true });
      }

      const loadedOnly = createDriver();
      const loaded = await loadedOnly.create({ attemptId: 'att-l', isolation: 'microvm' });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(await loadedOnly.injectWorktree(loaded.handle, { worktreeRef: 'wt/att-l' })).toEqual({ ok: true });
        expect(await loadedOnly.destroy(loaded.handle)).toEqual({ ok: true });
      }

      const sealedOnly = createDriver();
      const sealed = await sealedOnly.create({ attemptId: 'att-s', isolation: 'microvm' });
      expect(sealed.ok).toBe(true);
      if (sealed.ok) {
        expect(await sealedOnly.injectWorktree(sealed.handle, { worktreeRef: 'wt/att-s' })).toEqual({ ok: true });
        expect(await sealedOnly.seal(sealed.handle)).toEqual({ ok: true });
        expect(await sealedOnly.destroy(sealed.handle)).toEqual({ ok: true });
      }
    });

    it('refuses a second environment for the same attemptId', async () => {
      const driver = createDriver();
      const first = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(first.ok).toBe(true);
      const second = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(second).toEqual({ ok: false, reason: 'refused' });
    });

    it('refuses injectWorktree after seal and any step after destroy', async () => {
      const driver = createDriver();
      const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const handle = created.handle;
      expect(await driver.injectWorktree(handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: true });
      expect(await driver.seal(handle)).toEqual({ ok: true });

      const afterSeal = await driver.injectWorktree(handle, { worktreeRef: 'wt/att-1-late' });
      expect(afterSeal).toEqual({ ok: false, reason: 'refused' });

      expect(await driver.destroy(handle)).toEqual({ ok: true });
      expect(await driver.create({ attemptId: 'att-1', isolation: 'microvm' })).toEqual({ ok: false, reason: 'refused' });
      expect(await driver.injectWorktree(handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: false, reason: 'refused' });
      expect(await driver.seal(handle)).toEqual({ ok: false, reason: 'refused' });
    });

    it('refuses well-formed handles with unknown environmentId or mismatched attemptId without mutating state', async () => {
      const driver = createDriver();
      const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const handle = created.handle;

      const unknownEnvironment: MicroVmHandle = { environmentId: 'env-unknown', attemptId: 'att-1', isolation: 'microvm' };
      expect(await driver.seal(unknownEnvironment)).toEqual({ ok: false, reason: 'refused' });

      const unknownAttempt: MicroVmHandle = { environmentId: handle.environmentId, attemptId: 'att-other', isolation: 'microvm' };
      expect(await driver.injectWorktree(unknownAttempt, { worktreeRef: 'wt/att-1' })).toEqual({ ok: false, reason: 'refused' });

      const mismatchedIsolation: MicroVmHandle = { environmentId: handle.environmentId, attemptId: 'att-1', isolation: 'user-space-kernel' };
      expect(await driver.seal(mismatchedIsolation)).toEqual({ ok: false, reason: 'refused' });

      // State is unchanged: the bound handle still completes its lifecycle.
      expect(await driver.injectWorktree(handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: true });
      expect(await driver.seal(handle)).toEqual({ ok: true });
    });

    it('refuses malformed handles without throwing', async () => {
      const driver = createDriver();
      const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const malformed: readonly unknown[] = [
        null,
        undefined,
        'env-1',
        7,
        [],
        new Array(3),
        { length: 3, 0: 'a', 1: 'b', 2: 'c' },
        {},
        { environmentId: created.handle.environmentId, attemptId: 'att-1' },
        { ...created.handle, extra: 1 },
      ];
      for (const handle of malformed) {
        const sealed = await driver.seal(handle as MicroVmHandle);
        expect(sealed).toEqual({ ok: false, reason: 'refused' });
      }
      // The stored environment is untouched by every refusal above.
      expect(await driver.injectWorktree(created.handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: true });
    });

    it('refuses hostile non-plain, null, undefined, primitive, array-like, and oversized inputs without throwing', async () => {
      const driver = createDriver();
      const oversizedId = 'a'.repeat(1000);
      const oversizedRef = 'w'.repeat(1000);
      const sparse = new Array(3);
      sparse[1] = 'x';
      const bound = await driver.create({ attemptId: 'att-hostile-ref', isolation: 'microvm' });
      expect(bound.ok).toBe(true);
      if (!bound.ok) {
        return;
      }
      const handle = bound.handle;
      const hostileRequests: readonly unknown[] = [
        null,
        undefined,
        'att-1',
        7,
        true,
        [],
        sparse,
        { length: 2, 0: 'a', 1: 'b' },
        { attemptId: oversizedId, isolation: 'microvm' },
        { attemptId: 'att-1', isolation: oversizedId },
      ];
      for (const request of hostileRequests) {
        const created = await driver.create(request as { attemptId: string; isolation: 'microvm' });
        expect(created).toEqual({ ok: false, reason: 'refused' });
      }
      const hostileRefs: readonly unknown[] = [
        null,
        undefined,
        7,
        ['wt/att-1'],
        { length: 1, 0: 'w' },
        oversizedRef,
      ];
      for (const worktreeRef of hostileRefs) {
        const injected = await driver.injectWorktree(handle, { worktreeRef } as { worktreeRef: string });
        expect(injected).toEqual({ ok: false, reason: 'refused' });
      }
      // The bound environment is untouched by every refusal above.
      expect(await driver.injectWorktree(handle, { worktreeRef: 'wt/att-hostile-ref' })).toEqual({ ok: true });
    });

    it('refuses getters without invoking them and refuses Proxy inputs', async () => {
      const driver = createDriver();
      let getterRuns = 0;
      const getterRequest: Record<string, unknown> = {};
      Object.defineProperty(getterRequest, 'attemptId', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return 'att-1';
        },
      });
      getterRequest['isolation'] = 'microvm';
      const created = await driver.create(getterRequest as { attemptId: string; isolation: 'microvm' });
      expect(created).toEqual({ ok: false, reason: 'refused' });
      expect(getterRuns).toBe(0);

      const proxyTarget: Record<string, unknown> = {};
      Object.defineProperty(proxyTarget, 'attemptId', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return 'att-1';
        },
      });
      proxyTarget['isolation'] = 'microvm';
      const proxied = new Proxy(proxyTarget, {});
      const viaProxy = await driver.create(proxied as { attemptId: string; isolation: 'microvm' });
      expect(viaProxy).toEqual({ ok: false, reason: 'refused' });
      expect(getterRuns).toBe(0);

      // A handle read through a Proxy is refused the same way.
      const handleTarget: Record<string, unknown> = { environmentId: 'env-1', attemptId: 'att-1', isolation: 'microvm' };
      const viaHandleProxy = await driver.seal(new Proxy(handleTarget, {}) as MicroVmHandle);
      expect(viaHandleProxy).toEqual({ ok: false, reason: 'refused' });
    });

    it('refuses prototype-polluting keys and extra keys', async () => {
      const driver = createDriver();
      const pollutingKeys = ['__' + 'proto__', 'con' + 'structor', 'proto' + 'type'];
      for (const key of pollutingKeys) {
        const polluted: Record<string, unknown> = { attemptId: 'att-1', isolation: 'microvm' };
        polluted[key] = 'x';
        const created = await driver.create(polluted as { attemptId: string; isolation: 'microvm' });
        expect(created).toEqual({ ok: false, reason: 'refused' });

        const pollutedHandle: Record<string, unknown> = { environmentId: 'env-1', attemptId: 'att-1', isolation: 'microvm' };
        pollutedHandle[key] = 'x';
        const sealed = await driver.seal(pollutedHandle as MicroVmHandle);
        expect(sealed).toEqual({ ok: false, reason: 'refused' });
      }

      const extraKeyRequest = { attemptId: 'att-1', isolation: 'microvm', unexpected: 1 };
      expect(await driver.create(extraKeyRequest)).toEqual({ ok: false, reason: 'refused' });

      const created = await driver.create({ attemptId: 'att-2', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (created.ok) {
        const extraKeyHandle = { ...created.handle, unexpected: 1 };
        expect(await driver.seal(extraKeyHandle)).toEqual({ ok: false, reason: 'refused' });
        const extraKeyRef = { worktreeRef: 'wt/att-2', unexpected: 1 };
        expect(await driver.injectWorktree(created.handle, extraKeyRef)).toEqual({ ok: false, reason: 'refused' });
      }
    });

    it('refuses invalid attemptId and environmentId values without echoing them', async () => {
      const driver = createDriver();
      const invalidIds = ['', 'a'.repeat(129), 'att space', 'att/slash', 'att:colon'];
      for (const attemptId of invalidIds) {
        const created = await driver.create({ attemptId, isolation: 'microvm' });
        expect(created.ok).toBe(false);
        expect(JSON.stringify(created)).not.toContain(attemptId);
      }
      const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      for (const environmentId of invalidIds) {
        const mismatched: MicroVmHandle = { environmentId, attemptId: 'att-1', isolation: 'microvm' };
        const sealed = await driver.seal(mismatched);
        expect(sealed).toEqual({ ok: false, reason: 'refused' });
        expect(JSON.stringify(sealed)).not.toContain(environmentId);
      }
    });

    it('refuses invalid worktreeRef values with control chars, traversal, or excessive length', async () => {
      const driver = createDriver();
      const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const handle = created.handle;
      const invalidRefs = [
        '',
        'w'.repeat(513),
        'wt' + String.fromCharCode(0x00) + '/att-1',
        'wt' + String.fromCharCode(0x7f) + '/att-1',
        'wt/..' + '/escape',
        '..' + '/escape',
      ];
      for (const worktreeRef of invalidRefs) {
        const injected = await driver.injectWorktree(handle, { worktreeRef });
        expect(injected).toEqual({ ok: false, reason: 'refused' });
        expect(JSON.stringify(injected)).not.toContain(worktreeRef);
      }
      // Still in the created state: a legal injection succeeds afterwards.
      expect(await driver.injectWorktree(handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: true });
    });
  });
}
