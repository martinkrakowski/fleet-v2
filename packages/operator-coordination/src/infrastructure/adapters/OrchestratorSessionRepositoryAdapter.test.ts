/**
 * O9b: the store's own invariant — one active orchestrator session per
 * conductor identity (host plus state directory). Every test here runs the
 * REAL adapter over a temp-directory store: two concurrent registers, a
 * retire-and-replace that lands before the other process's save, and a
 * process re-registering on a retired id. Each ends with exactly one active
 * session for the identity. Malformed runtime input is refused with typed
 * reasons and never a path or secret echo, and an unreadable store refuses
 * and never registers.
 */

import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OrchestratorSession } from '../../domain/entities/OrchestratorSession.js';
import type { OrchestratorSessionRecord } from '../../domain/orchestrator-session-records.js';
import {
  OrchestratorSessionIdentityAlreadyActiveError,
  OrchestratorSessionRevisionConflictError,
} from '../../application/ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type { OrchestratorSessionIdentity } from '../../application/ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import { OrchestratorSessionRepositoryAdapter } from './OrchestratorSessionRepositoryAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const PAST = '2026-10-27T09:00:00.000Z';
const ATTACHED_LEASE = '2026-10-27T10:01:00.000Z';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-orchestrator-store-test-'));
}

function fileAdapter(dir: string): OrchestratorSessionRepositoryAdapter {
  return new OrchestratorSessionRepositoryAdapter({ stateDir: dir });
}

function identityFor(
  dir: string,
  orchestratorId: string,
  overrides: Partial<OrchestratorSessionIdentity['registration']> = {},
): OrchestratorSessionIdentity {
  return {
    host: 'local-host',
    stateDir: dir,
    registration: {
      orchestratorId,
      model: null,
      projects: [],
      claims: ['start-lane-run'],
      scopes: ['orchestrate'],
      registeredByTokenId: 'conductor-driver',
      ...overrides,
    },
  };
}

function activeRecord(orchestratorId: string, host = 'local-host'): OrchestratorSessionRecord {
  const created = OrchestratorSession.create({
    orchestratorId,
    cliKind: 'conductor',
    model: null,
    host,
    projects: [],
    claims: ['start-lane-run'],
    scopes: ['orchestrate'],
    registeredByTokenId: 'conductor-driver',
    startedAtIso: PAST,
    lastHeartbeatIso: PAST,
    leaseUntilIso: '2026-10-27T09:00:30.000Z',
    lastPolledRequestsAtIso: null,
    status: 'active',
  });
  if (!created.success) {
    throw created.error;
  }
  return created.value.toRecord();
}

async function activeIds(
  adapter: OrchestratorSessionRepositoryAdapter,
): Promise<readonly string[]> {
  return (await adapter.list({ status: 'active' })).map((entry) => entry.session.orchestratorId);
}

describe('one active session per conductor identity (real adapter, temp dir)', () => {
  it('concurrent register: two conductors registering the same identity at once end with one active session', async () => {
    const dir = tempDir();
    const [first, second] = await Promise.all([
      fileAdapter(dir).registerOrAdoptSession(identityFor(dir, 'orch-race-a'), NOW),
      fileAdapter(dir).registerOrAdoptSession(identityFor(dir, 'orch-race-b'), NOW),
    ]);
    // One registers over known absence; the other adopts the single live session.
    expect(new Set([first.outcome, second.outcome])).toEqual(new Set(['registered', 'adopted']));
    expect(await activeIds(fileAdapter(dir))).toHaveLength(1);
  });

  it('retire-and-replace before save: the lapsed writer reads a revision conflict, never "still live", and adopts the replacement', async () => {
    const dir = tempDir();
    const mine = fileAdapter(dir);
    const lapsed = await mine.save(activeRecord('orch-mine-1'), 0);
    // Another process retires the lapsed session and registers a replacement.
    const replacement = await fileAdapter(dir).registerOrAdoptSession(
      identityFor(dir, 'orch-replacement-1'),
      NOW,
    );
    expect(replacement.outcome).toBe('registered');
    expect(await activeIds(fileAdapter(dir))).toEqual(['orch-replacement-1']);

    // The retired id's save is a revision conflict, never a live renewal.
    await expect(
      mine.save(
        { ...lapsed.session, lastHeartbeatIso: NOW, leaseUntilIso: ATTACHED_LEASE },
        lapsed.revision,
      ),
    ).rejects.toThrow(OrchestratorSessionRevisionConflictError);
    expect(await activeIds(fileAdapter(dir))).toEqual(['orch-replacement-1']);

    // The next heartbeat calls registerOrAdoptSession once: it adopts the replacement.
    const adoption = await mine.registerOrAdoptSession(identityFor(dir, 'orch-mine-2'), NOW);
    expect(adoption).toMatchObject({ outcome: 'adopted' });
    if (adoption.outcome !== 'refused') {
      expect(adoption.session.orchestratorId).toBe('orch-replacement-1');
      expect(adoption.session.lastHeartbeatIso).toBe(NOW);
    }
    expect(await activeIds(fileAdapter(dir))).toEqual(['orch-replacement-1']);
  });

  it('adopting a retired id: re-registering next to the replacement adopts the replacement, never a duplicate', async () => {
    const dir = tempDir();
    const adapter = fileAdapter(dir);
    // A retired id is never reused; the replacement is the identity's live session.
    await adapter.save(
      { ...activeRecord('orch-old-1'), status: 'retired', leaseUntilIso: '2026-10-27T09:00:01.000Z' },
      0,
    );
    const registered = await adapter.registerOrAdoptSession(identityFor(dir, 'orch-current-1'), NOW);
    expect(registered.outcome).toBe('registered');
    expect(await activeIds(adapter)).toEqual(['orch-current-1']);

    const next = await adapter.registerOrAdoptSession(identityFor(dir, 'orch-old-2'), NOW);
    expect(next).toMatchObject({ outcome: 'adopted' });
    if (next.outcome !== 'refused') {
      expect(next.session.orchestratorId).toBe('orch-current-1');
    }
    expect(await activeIds(adapter)).toEqual(['orch-current-1']);
  });

  it('a second ACTIVE session for the same identity is refused with the typed identity-already-active error', async () => {
    const dir = tempDir();
    const adapter = fileAdapter(dir);
    await adapter.registerOrAdoptSession(identityFor(dir, 'orch-first-1'), NOW);
    const duplicate = activeRecord('orch-second-1');
    await expect(adapter.save(duplicate, 0)).rejects.toThrow(
      OrchestratorSessionIdentityAlreadyActiveError,
    );
    try {
      await adapter.save(duplicate, 0);
    } catch (error) {
      expect((error as OrchestratorSessionIdentityAlreadyActiveError).code).toBe(
        'identity-already-active',
      );
    }
    expect(await activeIds(adapter)).toEqual(['orch-first-1']);
  });

  it('the invariant leaves every other identity untouched: a second host registers, and heartbeats still save', async () => {
    const dir = tempDir();
    const adapter = fileAdapter(dir);
    const live = await adapter.registerOrAdoptSession(identityFor(dir, 'orch-host-a'), NOW);
    expect(live.outcome).toBe('registered');
    const otherHost = await adapter.registerOrAdoptSession(
      { ...identityFor(dir, 'orch-host-b'), host: 'other-host' },
      NOW,
    );
    expect(otherHost.outcome).toBe('registered');
    expect(await activeIds(adapter)).toEqual(['orch-host-a', 'orch-host-b']);

    // Heartbeating the live session saves through the same path.
    const stored = await adapter.get('orch-host-a');
    if (stored === null) {
      throw new Error('expected the session to be stored');
    }
    const loaded = OrchestratorSession.create(stored.session);
    if (!loaded.success) {
      throw loaded.error;
    }
    const renewed = loaded.value.renewLease('2026-10-27T10:00:30.000Z');
    if (!renewed.success) {
      throw renewed.error;
    }
    await expect(adapter.save(renewed.value.toRecord(), stored.revision)).resolves.toMatchObject({
      revision: stored.revision + 1,
    });
  });

  it('malformed runtime input is refused with a typed reason and writes nothing', async () => {
    const dir = tempDir();
    const adapter = fileAdapter(dir);
    const fakeSecret = ['sk', '-', 'x9y8z7'.repeat(4)].join('');
    await expect(
      adapter.registerOrAdoptSession({ ...identityFor(dir, 'orch-any-1'), host: fakeSecret }, NOW),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the conductor identity host was refused' });
    await expect(
      adapter.registerOrAdoptSession(null as never, NOW),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the conductor identity must be a record' });
    await expect(
      adapter.registerOrAdoptSession({ ...identityFor(dir, 'orch-any-2'), host: 7 as never }, NOW),
    ).resolves.toMatchObject({ outcome: 'refused' });
    await expect(
      adapter.registerOrAdoptSession(identityFor(dir, 'orch-any-3'), 'not-a-time'),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the adoption time is not a valid timestamp' });
    await expect(
      adapter.registerOrAdoptSession(
        { ...identityFor(dir, 'orch-any-4'), registration: { ...identityFor(dir, 'x').registration, registeredByTokenId: fakeSecret } },
        NOW,
      ),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the presenting token could not be identified' });
    expect(await adapter.list()).toEqual([]);
  });

  it('an unreadable store refuses and never registers', async () => {
    const dir = tempDir();
    await fs.writeFile(join(dir, 'orchestrators.json'), 'not json at all', 'utf8');
    const adapter = fileAdapter(dir);
    await expect(adapter.registerOrAdoptSession(identityFor(dir, 'orch-any-5'), NOW)).resolves.toEqual({
      outcome: 'refused',
      reason: 'the orchestrator session store could not be read',
    });
    expect(await fs.readFile(join(dir, 'orchestrators.json'), 'utf8')).toBe('not json at all');
    await expect(adapter.list()).rejects.toThrow();
  });

  it('a supplied identity state directory must name this store, and null keys on the store itself', async () => {
    const dir = tempDir();
    const adapter = fileAdapter(dir);
    await expect(
      adapter.registerOrAdoptSession(identityFor(join(dir, 'elsewhere'), 'orch-any-6'), NOW),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the identity does not belong to this store' });
    expect(await adapter.list()).toEqual([]);
    await expect(adapter.registerOrAdoptSession(identityFor(null as never, 'orch-null-1'), NOW)).resolves.toMatchObject(
      { outcome: 'registered' },
    );
    expect(await activeIds(adapter)).toEqual(['orch-null-1']);
  });

  it('more than one live session for the identity is refused, never guessed', async () => {
    const dir = tempDir();
    // Two live rows can only exist as legacy state: the save invariant refuses them.
    const legacy = [
      { revision: 1, session: { ...activeRecord('orch-legacy-a'), lastHeartbeatIso: NOW, leaseUntilIso: '2026-10-27T10:00:30.000Z' } },
      { revision: 1, session: { ...activeRecord('orch-legacy-b'), lastHeartbeatIso: NOW, leaseUntilIso: '2026-10-27T10:00:30.000Z' } },
    ];
    await fs.writeFile(join(dir, 'orchestrators.json'), JSON.stringify(legacy), 'utf8');
    const adapter = fileAdapter(dir);
    await expect(adapter.registerOrAdoptSession(identityFor(dir, 'orch-any-7'), NOW)).resolves.toEqual({
      outcome: 'refused',
      reason: 'more than one live session exists for this conductor identity',
    });
    expect(await activeIds(adapter)).toEqual(['orch-legacy-a', 'orch-legacy-b']);
  });

  it('a legacy duplicate with exactly one live row heals: the lapsed row is retired and the live row adopted', async () => {
    const dir = tempDir();
    const lapsedRecord = activeRecord('orch-legacy-lapsed');
    const liveRecord = {
      ...activeRecord('orch-legacy-live'),
      lastHeartbeatIso: NOW,
      leaseUntilIso: '2026-10-27T10:01:30.000Z',
    };
    const legacy = [
      { revision: 1, session: lapsedRecord },
      { revision: 1, session: liveRecord },
    ];
    await fs.writeFile(join(dir, 'orchestrators.json'), JSON.stringify(legacy), 'utf8');
    const adapter = fileAdapter(dir);
    const result = await adapter.registerOrAdoptSession(identityFor(dir, 'orch-any-8'), NOW);
    expect(result).toMatchObject({ outcome: 'adopted' });
    expect(await activeIds(adapter)).toEqual(['orch-legacy-live']);
    const retired = (await adapter.list({ status: 'retired' })).map(
      (entry) => entry.session.orchestratorId,
    );
    expect(retired).toEqual(['orch-legacy-lapsed']);
  });
});
