import { describe, expect, it } from 'vitest';

import type { MicroVmHandle } from '../MicroVmDriverPort.out-port.js';
import { InMemoryMicroVmDriver } from './in-memory-micro-vm-driver.js';
import { describeMicroVmDriverContract } from './micro-vm-driver.contract.js';

describeMicroVmDriverContract('in-memory', () => new InMemoryMicroVmDriver());

describe('InMemoryMicroVmDriver specifics', () => {
  it('refuses unsupported isolation without silent downgrade', async () => {
    const driver = new InMemoryMicroVmDriver({ supportedIsolations: ['user-space-kernel'] });
    const refused = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
    expect(refused).toEqual({ ok: false, reason: 'unsupported-isolation' });

    // The declared isolation is honoured exactly; the attempt is never silently downgraded.
    const accepted = await driver.create({ attemptId: 'att-1', isolation: 'user-space-kernel' });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.handle.isolation).toBe('user-space-kernel');
    }
  });

  it('returns configured failure reason when a step is injected to fail', async () => {
    const createUnavailable = new InMemoryMicroVmDriver({ failOnStep: 'create', failureReason: 'unavailable' });
    expect(await createUnavailable.create({ attemptId: 'att-1', isolation: 'microvm' }))
      .toEqual({ ok: false, reason: 'unavailable' });
    // The failed step stored nothing, so a retry on a fresh driver decides fresh state.
    const createRefused = new InMemoryMicroVmDriver({ failOnStep: 'create', failureReason: 'refused' });
    expect(await createRefused.create({ attemptId: 'att-1', isolation: 'microvm' }))
      .toEqual({ ok: false, reason: 'refused' });

    const injectUnavailable = new InMemoryMicroVmDriver({ failOnStep: 'injectWorktree', failureReason: 'unavailable' });
    const created = await injectUnavailable.create({ attemptId: 'att-1', isolation: 'microvm' });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(await injectUnavailable.injectWorktree(created.handle, { worktreeRef: 'wt/att-1' }))
        .toEqual({ ok: false, reason: 'unavailable' });
      expect(await injectUnavailable.seal(created.handle)).toEqual({ ok: false, reason: 'refused' });
    }

    const sealRefused = new InMemoryMicroVmDriver({ failOnStep: 'seal', failureReason: 'refused' });
    const created2 = await sealRefused.create({ attemptId: 'att-1', isolation: 'microvm' });
    expect(created2.ok).toBe(true);
    if (created2.ok) {
      expect(await sealRefused.injectWorktree(created2.handle, { worktreeRef: 'wt/att-1' })).toEqual({ ok: true });
      expect(await sealRefused.seal(created2.handle)).toEqual({ ok: false, reason: 'refused' });
      // The failed seal left the environment loaded, not sealed.
      expect(await sealRefused.injectWorktree(created2.handle, { worktreeRef: 'wt/att-1-again' })).toEqual({ ok: true });
    }

    const destroyUnavailable = new InMemoryMicroVmDriver({ failOnStep: 'destroy', failureReason: 'unavailable' });
    const created3 = await destroyUnavailable.create({ attemptId: 'att-1', isolation: 'microvm' });
    expect(created3.ok).toBe(true);
    if (created3.ok) {
      expect(await destroyUnavailable.destroy(created3.handle)).toEqual({ ok: false, reason: 'unavailable' });
    }
  });

  it('records call metadata for every step without ever storing worktree contents', async () => {
    const driver = new InMemoryMicroVmDriver();
    const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const worktreeRef = 'wt/private-contents/att-1';
    expect(await driver.injectWorktree(created.handle, { worktreeRef })).toEqual({ ok: true });
    expect(await driver.seal(created.handle)).toEqual({ ok: true });
    expect(await driver.destroy(created.handle)).toEqual({ ok: true });

    const calls = driver.recordedCalls();
    expect(calls.map((call) => call.step)).toEqual(['create', 'injectWorktree', 'seal', 'destroy']);
    expect(calls.every((call) => call.ok)).toBe(true);
    // No worktree content ever enters the recorded metadata.
    expect(JSON.stringify(calls)).not.toContain(worktreeRef);

    const refused = await driver.create({ attemptId: 'att-2', isolation: 'bogus' } as unknown as Parameters<InMemoryMicroVmDriver['create']>[0]);
    expect(refused).toEqual({ ok: false, reason: 'refused' });
    expect(driver.recordedCalls().at(-1)).toMatchObject({ step: 'create', ok: false, reason: 'refused' });
  });

  it('keeps destroy idempotent for the bound handle while refusing it for foreign handles', async () => {
    const driver = new InMemoryMicroVmDriver();
    const created = await driver.create({ attemptId: 'att-1', isolation: 'microvm' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(await driver.destroy(created.handle)).toEqual({ ok: true });
    expect(await driver.destroy(created.handle)).toEqual({ ok: true });
    const foreign: MicroVmHandle = { environmentId: 'env-unknown', attemptId: 'att-1', isolation: 'microvm' };
    expect(await driver.destroy(foreign)).toEqual({ ok: false, reason: 'refused' });
  });
});
