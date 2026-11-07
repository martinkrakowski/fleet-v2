/**
 * Lane O2c unit tests for ReconcileOrchestratorRequestUseCase: journal-key
 * reconciliation of the four enabled request kinds. The request store is the
 * real OrchestratorRequestRepositoryAdapter in a temp dir; the journal delegate
 * is a fake (except where a test name says the real adapter) so append refusals
 * and store faults are injected deterministically. The clock is always injected,
 * and the digest function is the real `hashOrchestratorRequestDigest`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OrchestratorRequest,
  type OrchestratorRequestResult,
} from '../../../domain/entities/OrchestratorRequest.js';
import type { OrchestratorRequestRecord } from '../../../domain/orchestrator-request-records.js';
import type {
  OrchestratorCliKind,
  OrchestratorRequestKind,
  OrchestratorSessionRecord,
} from '../../../domain/orchestrator-session-records.js';
import type { ProjectProfileRecord } from '../../../domain/coordination-records.js';
import type { OrchestratorSessionRepositoryPort } from '../../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type { ProjectProfileRepositoryPort } from '../../ports/out/ProjectProfileRepositoryPort.out-port.js';
import { OrchestratorRequestRepositoryAdapter } from '../../../infrastructure/adapters/OrchestratorRequestRepositoryAdapter.adapter.js';
import {
  OrchestratorRequestJournalAdapter,
  hashOrchestratorRequestDigest,
} from '../../../infrastructure/adapters/OrchestratorRequestJournalAdapter.adapter.js';
import { ReconcileOrchestratorRequestUseCase } from '../ReconcileOrchestratorRequestUseCase.use-case.js';

const NOW_ISO = '2026-10-27T10:00:00.000Z';
const ID = '01JB0000000000000000000000';
const ID2 = '01JB0000000000000000000001';
const ORCH = 'orch-example-1';
const PROJECT = 'example-project';
const HOST = 'example-host';
const SESSION = 'session-example-1';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function mustSucceed(result: OrchestratorRequestResult): OrchestratorRequest {
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function makeClock(at: string = NOW_ISO): { nowIso: () => string; set: (iso: string) => void } {
  let now = at;
  return {
    nowIso: () => now,
    set(iso: string) {
      now = iso;
    },
  };
}

class FakeSessionRepo implements OrchestratorSessionRepositoryPort {
  readonly sessions = new Map<string, OrchestratorSessionRecord>();
  throwOnGet = false;

  set(session: OrchestratorSessionRecord): void {
    this.sessions.set(session.orchestratorId, session);
  }

  async get(orchestratorId: string): Promise<{ revision: number; session: OrchestratorSessionRecord } | null> {
    if (this.throwOnGet) {
      throw new Error('session store unreadable');
    }
    const session = this.sessions.get(orchestratorId);
    return session === undefined ? null : { revision: 1, session };
  }

  async save(): Promise<never> {
    throw new Error('not used');
  }

  async list(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeProfileRepo implements ProjectProfileRepositoryPort {
  profile: ProjectProfileRecord | null = null;
  throwOnFind = false;

  async findProfileById(): Promise<ProjectProfileRecord | null> {
    if (this.throwOnFind) {
      throw new Error('profile store unreadable');
    }
    return this.profile;
  }

  async saveProfile(): Promise<never> {
    throw new Error('not used');
  }

  async listProfiles(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeJournalDelegate {
  readonly entries: Array<Record<string, unknown>> = [];
  appends = 0;
  throwAppendOnce = false;
  throwListOnce = false;
  appendError: Error | null = null;
  listError: Error | null = null;

  async append(entry: Record<string, unknown>): Promise<
    | { outcome: 'appended'; entry: unknown }
    | { outcome: 'refused'; reason: string; detail: string | null }
  > {
    if (this.throwAppendOnce) {
      this.throwAppendOnce = false;
      throw this.appendError ?? new Error('journal append failed');
    }
    const key = entry.key as string;
    if (entry.kind === 'intent') {
      const existing = this.entries.find((stored) => stored.key === key && stored.kind === 'intent');
      if (existing !== undefined) {
        return { outcome: 'refused', reason: 'duplicate-key', detail: null };
      }
    } else if (entry.kind === 'result') {
      if (!this.entries.some((stored) => stored.key === key && stored.kind === 'intent')) {
        return { outcome: 'refused', reason: 'result-without-intent', detail: null };
      }
      if (
        this.entries.some(
          (stored) =>
            stored.key === key &&
            stored.kind === 'result' &&
            stored.outcome !== 'ambiguous' &&
            !(stored.outcome === 'not-started' && key.startsWith('request/')),
        )
      ) {
        return { outcome: 'refused', reason: 'result-after-final', detail: null };
      }
    }
    this.entries.push({ ...entry });
    this.appends += 1;
    return { outcome: 'appended', entry: { ...entry } };
  }

  async listForKey(key: string): Promise<readonly unknown[]> {
    if (this.throwListOnce) {
      this.throwListOnce = false;
      throw this.listError ?? new Error('journal read failed');
    }
    return this.entries.filter((stored) => stored.key === key).map((stored) => ({ ...stored }));
  }
}

interface Env {
  tempDir: string;
  requestRepo: OrchestratorRequestRepositoryAdapter;
  sessions: FakeSessionRepo;
  profiles: FakeProfileRepo;
  journal: FakeJournalDelegate;
  clock: ReturnType<typeof makeClock>;
  useCase: ReconcileOrchestratorRequestUseCase;
}

async function fresh(overrides: {
  cliKind?: string;
  host?: string;
  claims?: readonly string[];
  profile?: ProjectProfileRecord | null;
} = {}): Promise<Env> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reconcile-request-'));
  const requestRepo = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
  const sessions = new FakeSessionRepo();
  const profiles = new FakeProfileRepo();
  const journal = new FakeJournalDelegate();
  const clock = makeClock();

  sessions.set({
    orchestratorId: ORCH,
    cliKind: (overrides.cliKind ?? 'conductor') as OrchestratorCliKind,
    model: null,
    host: overrides.host ?? HOST,
    projects: [PROJECT],
    claims: (overrides.claims ?? ['start-lane-run', 'prepare-fix']) as readonly OrchestratorRequestKind[],
    scopes: ['orchestrate'],
    registeredByTokenId: 'shared-bearer',
    startedAtIso: NOW_ISO,
    lastHeartbeatIso: NOW_ISO,
    leaseUntilIso: '2026-10-27T10:05:00.000Z',
    lastPolledRequestsAtIso: null,
    status: 'active',
  });

  if (overrides.profile !== undefined) {
    profiles.profile = overrides.profile;
  } else {
    profiles.profile = {
      projectId: PROJECT,
      displayName: 'Example',
      repository: 'example/example',
      designatedDispatcherHost: HOST,
      policyRevision: 'policy@rev-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: {},
      revision: 1,
      updatedAtIso: NOW_ISO,
      status: 'active',
      defaultBranch: null,
      clones: {},
      gateProcedures: [],
      defaultAllowedPathPrefixes: [],
      lastProbe: null,
    };
  }

  const useCase = new ReconcileOrchestratorRequestUseCase({
    requestRepo,
    sessionRepo: sessions,
    profileRepo: profiles,
    journal: new OrchestratorRequestJournalAdapter(journal),
    clock,
    hashDigest: hashOrchestratorRequestDigest,
    mintEntryId: (() => {
      let counter = 0;
      return () => `01JB${String(counter++).padStart(22, '0')}`;
    })(),
  });

  return { tempDir, requestRepo, sessions, profiles, journal, clock, useCase };
}

function requestRecord(kind: 'start-lane-run' | 'prepare-fix' | 'request-review' | 'resume-run' | 'dispatch-attempt', overrides: Partial<OrchestratorRequestRecord> = {}): OrchestratorRequestRecord {
  const target =
    kind === 'start-lane-run'
      ? { workOrderId: 'work-order-example-1' }
      : kind === 'resume-run'
        ? { runId: 'run-example-1' }
        : { attemptId: 'attempt-example-1' };
  const created = OrchestratorRequest.open(
    { requestId: ID, kind, projectId: PROJECT, target },
    { via: 'web', sessionId: SESSION },
    NOW_ISO,
  );
  if (!created.success) {
    throw new Error(created.error.message);
  }
  return { ...created.value.toRecord(), ...overrides };
}

/** The canonical digest exactly as the use case computes it, for the digest tests. */
function canonical(record: OrchestratorRequestRecord): string {
  return JSON.stringify({
    requestId: record.requestId,
    kind: record.kind,
    projectId: record.projectId,
    target: record.target,
    requestedBy: { via: record.requestedBy.via, sessionId: record.requestedBy.sessionId },
    createdAtIso: record.createdAtIso,
    expiresAtIso: record.expiresAtIso,
  });
}

describe('ReconcileOrchestratorRequestUseCase', () => {
  let env: Env;

  beforeEach(async () => {
    env = await fresh();
  });

  afterEach(async () => {
    await fs.rm(env.tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('unconfigured throws Not implemented before reading the body', async () => {
    const unconfigured = new ReconcileOrchestratorRequestUseCase();
    await expect(unconfigured.execute('claim', null)).rejects.toThrow(
      'Not implemented: ReconcileOrchestratorRequestUseCase',
    );
  });

  it('refuses a null body, a wrong-typed field, a sparse array, an unknown action and a throwing getter', async () => {
    const cases: Array<[unknown, unknown]> = [
      ['claim', null],
      ['claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: '1' }],
      ['record-result', { requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1, outcome: 'completed', reasonCode: null, reasonKind: null, linkedId: 'run-example-1', extra: true }],
      ['record-intent', { requestId: ID, orchestratorId: ORCH, expectedRevision: 2 }],
      ['unknown-action', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 }],
    ];
    const sparse: unknown[] = [];
    sparse[2] = 1;
    cases.push(['claim', sparse]);
    const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    cases.push(['claim', hostile]);

    for (const [action, body] of cases) {
      const result = await env.useCase.execute(action, body);
      expect(result).toEqual({ outcome: 'refused', code: 'invalid-request', requestId: null });
    }
    expect(env.journal.appends).toBe(0);
    expect(env.journal.entries).toHaveLength(0);
  });

  it('a journal lock timeout leaves the request claimed and the next record-intent completes', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    const claimed = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(claimed).toEqual({ outcome: 'claimed', requestId: ID, revision: 2, fence: 1 });

    env.journal.throwAppendOnce = true;
    const first = await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    expect(first).toEqual({ outcome: 'unknown', code: 'lock-timeout', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    expect(stored.outcome).toBe('found');
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('claimed');
      expect(stored.request.claim?.orchestratorId).toBe(ORCH);
    }

    const second = await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    expect(second).toEqual({ outcome: 'intent-recorded', requestId: ID });
    expect(env.journal.entries).toHaveLength(1);
  });

  it('a crash after the intent and before the result does not append a second intent and the later result completes the request', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });

    const first = await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    expect(first).toEqual({ outcome: 'intent-recorded', requestId: ID });

    const again = await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    expect(again).toEqual({ outcome: 'unchanged', requestId: ID });
    expect(env.journal.entries).toHaveLength(1);

    const completed = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-example-2',
    });
    expect(completed).toEqual({ outcome: 'result-recorded', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    expect(stored.outcome).toBe('found');
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('dispatched');
      expect(stored.request.linked).toEqual({
        attemptId: 'attempt-example-2',
        journalKey: `request/${ID}`,
      });
    }
    expect(env.journal.entries).toHaveLength(2);

    const laterClaim = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 3 });
    expect(laterClaim).toEqual({ outcome: 'already-dispatched', requestId: ID });
    expect(env.journal.appends).toBe(2);
  });

  it('a record-intent after the claim lease expired is refused and writes no journal entry', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });

    env.clock.set('2026-10-27T10:03:00.000Z');
    const result = await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'claim-lease', requestId: ID });
    expect(env.journal.appends).toBe(0);
  });

  it('an unreadable journal read is unknown and is not treated as no intent', async () => {
    await env.requestRepo.save(requestRecord('start-lane-run'), 0);
    env.journal.throwListOnce = true;

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'unknown', code: 'unreadable-journal', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    expect(stored.outcome).toBe('found');
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('queued');
    }
  });

  it('a thrown journal error is returned as a code and echoes neither the path nor the message', async () => {
    await env.requestRepo.save(requestRecord('start-lane-run'), 0);
    env.journal.throwListOnce = true;
    env.journal.listError = new Error(`unreadable /tmp/fleet-state/run-journal.json ${fakeSecretShape()}`);

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('/tmp/fleet-state/run-journal.json');
    expect(serialized).not.toContain(fakeSecretShape());
    expect(result).toEqual({ outcome: 'unknown', code: 'unreadable-journal', requestId: ID });
  });

  it('an overlong reason code and an over-long linked id are refused before any journal append', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });

    const longReason = 'a'.repeat(65);
    const longReasonResult = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'refused',
      reasonCode: longReason,
      reasonKind: 'policy',
      linkedId: null,
    });
    expect(longReasonResult).toEqual({ outcome: 'refused', code: 'invalid-request', requestId: null });

    const longLinked = 'x'.repeat(257);
    const longLinkedResult = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: longLinked,
    });
    expect(longLinkedResult).toEqual({ outcome: 'refused', code: 'invalid-request', requestId: null });

    expect(env.journal.appends).toBe(0);
  });

  it('request intent digest is the full sha256 of every closed payload field and a 12-hex digest is unknown', async () => {
    const base = requestRecord('prepare-fix');
    const baseDigest = hashOrchestratorRequestDigest(canonical(base));

    const flips: Array<[string, Partial<OrchestratorRequestRecord>]> = [
      ['requestId', { requestId: `${ID.slice(0, 25)}1` }],
      ['kind', { kind: 'resume-run', target: { runId: 'run-example-1' } }],
      ['projectId', { projectId: 'other-project' }],
      ['target id', { target: { attemptId: 'attempt-example-2' } }],
      ['sessionId', { requestedBy: { via: 'web', sessionId: 'session-example-2' } }],
      ['createdAtIso', { createdAtIso: '2026-10-27T10:00:01.000Z' }],
      ['expiresAtIso', { expiresAtIso: '2026-10-27T10:30:01.000Z' }],
    ];
    for (const [, override] of flips) {
      const digest = hashOrchestratorRequestDigest(canonical({ ...base, ...override }));
      expect(digest).not.toBe(baseDigest);
    }

    // revision and claim are not part of the digest.
    expect(hashOrchestratorRequestDigest(canonical({ ...base, revision: 2 }))).toBe(baseDigest);
    expect(
      hashOrchestratorRequestDigest(
        canonical({ ...base, claim: { orchestratorId: ORCH, fence: 1, leaseUntilIso: NOW_ISO } }),
      ),
    ).toBe(baseDigest);

    // A stored intent with a 12-hex digest makes claim report digest-failed, never already-dispatched.
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    env.journal.entries.push({ version: 1, entryId: '01JB0000000000000000000001', kind: 'intent', key: `request/${ID}`, digest: '0123456789abcdef' });
    env.journal.entries.push({ version: 1, entryId: '01JB0000000000000000000002', kind: 'result', key: `request/${ID}`, outcome: 'completed', reasonCode: null });

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'unknown', code: 'digest-failed', requestId: ID });
  });

  it('start-lane-run is refused for a non-conductor session and prepare-fix is claimed by that session', async () => {
    env = await fresh({ cliKind: 'agy', claims: ['start-lane-run', 'prepare-fix'] });

    await env.requestRepo.save(requestRecord('start-lane-run'), 0);
    const start = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(start).toEqual({ outcome: 'refused', code: 'policy', requestId: ID });

    const storedStart = await env.requestRepo.get(ID);
    expect(storedStart.outcome).toBe('found');
    if (storedStart.outcome === 'found') {
      expect(storedStart.request.state).toBe('queued');
    }

    await env.requestRepo.save(requestRecord('prepare-fix', { requestId: ID2 }), 0);
    const prepare = await env.useCase.execute('claim', { requestId: ID2, orchestratorId: ORCH, expectedRevision: 1 });
    expect(prepare).toEqual({ outcome: 'claimed', requestId: ID2, revision: 2, fence: 1 });
  });

  it('start-lane-run is refused when the session host is not the profile designated dispatcher host and the refusal names no host', async () => {
    env = await fresh({ host: 'other-host' });
    await env.requestRepo.save(requestRecord('start-lane-run'), 0);

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'refused', code: 'dispatcher-host', requestId: ID });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HOST);
    expect(serialized).not.toContain('other-host');
  });

  it('claim of dispatch-attempt is refused policy', async () => {
    env = await fresh({ claims: ['dispatch-attempt'] });
    await env.requestRepo.save(requestRecord('dispatch-attempt'), 0);

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'refused', code: 'policy', requestId: ID });
    expect(env.journal.appends).toBe(0);
  });

  it('record-intent on cancel-requested writes nothing', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });

    const stored = await env.requestRepo.get(ID);
    expect(stored.outcome).toBe('found');
    if (stored.outcome !== 'found') {
      return;
    }
    const cancelled = mustSucceed(OrchestratorRequest.create(stored.request)).requestCancel(stored.request.revision, NOW_ISO);
    expect(cancelled.success).toBe(true);
    if (!cancelled.success) {
      return;
    }
    const saved = await env.requestRepo.save(cancelled.value.toRecord(), stored.request.revision);
    expect(saved.outcome).toBe('saved');

    const result = await env.useCase.execute('record-intent', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 3,
      fence: 1,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'cancel-requested', requestId: ID });
    expect(env.journal.appends).toBe(0);
  });

  it('a refused result without a reason kind is refused before any journal append', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    const result = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'refused',
      reasonCode: 'busy',
      reasonKind: null,
      linkedId: null,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'invalid-request', requestId: null });
    expect(env.journal.appends).toBe(1); // the intent only, never a final result

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('claimed');
    }
  });

  it('record-intent on a dispatched request is refused and writes nothing', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-dispatched-1',
    });

    const appends = env.journal.appends;
    const result = await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });
    expect(result).toEqual({ outcome: 'refused', code: 'holder', requestId: ID });
    expect(env.journal.appends).toBe(appends);
  });

  it('claim recovery applies exactly the recorded refused reason kind', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    // A writer crashed between the journal result and its save: the result is
    // in the journal, the request is still claimed.
    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000003',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'refused',
      reasonCode: 'busy',
      reasonKind: 'seat-unavailable',
      linkedId: null,
    });

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'already-refused', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('refused');
      expect(stored.request.reason?.reasonKind).toBe('seat-unavailable');
    }
  });

  it('claim recovery applies the recorded link id and never invents one from the target', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000004',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-recovered-1',
    });

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'already-dispatched', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('dispatched');
      // The link id is the recorded one, not the target's attempt id.
      expect(stored.request.linked).toEqual({
        attemptId: 'attempt-recovered-1',
        journalKey: `request/${ID}`,
      });
    }
  });

  it('a retry after a recorded result applies the recorded link id, not the one from the retry body', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    // The writer crashed between the journal result and its save: the result
    // is in the journal, the request is still claimed. The retry carries a
    // different link id; the recorded one must win.
    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000005',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-recorded-1',
    });

    const retry = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-retry-9',
    });
    expect(retry).toEqual({ outcome: 'unchanged', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('dispatched');
      expect(stored.request.linked).toEqual({
        attemptId: 'attempt-recorded-1',
        journalKey: `request/${ID}`,
      });
    }
  });

  it('a retry after a recorded refusal applies the recorded reason kind, not the one from the retry body', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000006',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'refused',
      reasonCode: 'busy',
      reasonKind: 'seat-unavailable',
      linkedId: null,
    });

    const retry = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'refused',
      reasonCode: 'busy',
      reasonKind: 'policy',
      linkedId: null,
    });
    expect(retry).toEqual({ outcome: 'unchanged', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('refused');
      expect(stored.request.reason?.reasonKind).toBe('seat-unavailable');
    }
  });

  it('claim recovery treats a recorded not-started result as non-final and a later result completes', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000007',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'not-started',
      reasonCode: null,
      reasonKind: null,
      linkedId: null,
    });

    // not-started never moves the request, so recovery reports neither
    // digest-failed nor a completion: the request is still claimed by this
    // orchestrator and reconciles.
    const recovered = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(recovered).toEqual({ outcome: 'reconcile', requestId: ID, revision: 2, fence: 1 });

    // A later final result is still allowed and moves the request.
    const completed = await env.useCase.execute('record-result', {
      requestId: ID,
      orchestratorId: ORCH,
      expectedRevision: 2,
      fence: 1,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-example-2',
    });
    expect(completed).toEqual({ outcome: 'result-recorded', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('dispatched');
      expect(stored.request.linked).toEqual({
        attemptId: 'attempt-example-2',
        journalKey: `request/${ID}`,
      });
    }
  });

  it('claim recovery applies a recorded completion after the retained claim lease expires', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000008',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'completed',
      reasonCode: null,
      reasonKind: null,
      linkedId: 'attempt-recovered-1',
    });

    // The claim lease (10:02:00) lapsed; the session lease (10:05:00) is live.
    env.clock.set('2026-10-27T10:03:00.000Z');

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'already-dispatched', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('dispatched');
      expect(stored.request.linked).toEqual({
        attemptId: 'attempt-recovered-1',
        journalKey: `request/${ID}`,
      });
    }
  });

  it('claim recovery applies a recorded refusal after the retained claim lease expires', async () => {
    await env.requestRepo.save(requestRecord('prepare-fix'), 0);
    await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    await env.useCase.execute('record-intent', {
      requestId: ID, orchestratorId: ORCH, expectedRevision: 2, fence: 1,
    });

    env.journal.entries.push({
      version: 1,
      entryId: '01JB0000000000000000000009',
      kind: 'result',
      key: `request/${ID}`,
      outcome: 'refused',
      reasonCode: 'busy',
      reasonKind: 'seat-unavailable',
      linkedId: null,
    });

    env.clock.set('2026-10-27T10:03:00.000Z');

    const result = await env.useCase.execute('claim', { requestId: ID, orchestratorId: ORCH, expectedRevision: 1 });
    expect(result).toEqual({ outcome: 'already-refused', requestId: ID });

    const stored = await env.requestRepo.get(ID);
    if (stored.outcome === 'found') {
      expect(stored.request.state).toBe('refused');
      expect(stored.request.reason?.reasonKind).toBe('seat-unavailable');
    }
  });
});
