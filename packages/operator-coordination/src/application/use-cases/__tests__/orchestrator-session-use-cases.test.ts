/**
 * Lane O2a-2 unit tests for the orchestrator session use cases: register,
 * heartbeat, retire and list.
 *
 * The hard requirement is covered first: a session's scopes come only from
 * the presenting token's own scopes, never from the request body, and a body
 * that carries scopes, status or times is refused before anything is stored.
 * Heartbeat renews only the lease and is announced as a heartbeat, never as a
 * data change; retirement is idempotent; listing derives attached and attentive
 * from the injected clock. The clock is always injected.
 */

import { describe, expect, it } from 'vitest';

import { OrchestratorSession } from '../../../domain/entities/OrchestratorSession.js';
import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';
import { OrchestratorSessionRevisionConflictError } from '../../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type {
  OrchestratorSessionListQuery,
  OrchestratorSessionRepositoryPort,
  StoredOrchestratorSession,
} from '../../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../ports/out/ChangeSignalPort.out-port.js';
import { OrchestratorSessionRepositoryAdapter } from '../../../infrastructure/adapters/OrchestratorSessionRepositoryAdapter.adapter.js';
import type { OrchestratorSessionClock } from '../../ports/in/RegisterOrchestratorSessionPort.in-port.js';
import type { ListOrchestratorSessionsRequest } from '../../ports/in/ListOrchestratorSessionsPort.in-port.js';
import { RegisterOrchestratorSessionUseCase } from '../RegisterOrchestratorSessionUseCase.use-case.js';
import { HeartbeatOrchestratorSessionUseCase } from '../HeartbeatOrchestratorSessionUseCase.use-case.js';
import { RetireOrchestratorSessionUseCase } from '../RetireOrchestratorSessionUseCase.use-case.js';
import { ListOrchestratorSessionsUseCase } from '../ListOrchestratorSessionsUseCase.use-case.js';

const NOW_ISO = '2026-10-27T10:00:00.000Z';

const BODY = {
  orchestratorId: 'orch-example-1',
  cliKind: 'claude-code',
  model: 'example-provider/example-model',
  host: 'example-host',
  projects: ['example-project'],
  claims: ['dispatch-attempt'],
};

/** A clock the composition root would inject; it counts its reads and can be set. */
function makeClock(at: string = NOW_ISO): OrchestratorSessionClock & { calls: number; set: (iso: string) => void } {
  const state = { now: at, calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    set(iso: string) {
      state.now = iso;
    },
    nowIso() {
      state.calls += 1;
      return state.now;
    },
  };
}

interface Env {
  readonly signals: ChangeSignal[];
  readonly repo: OrchestratorSessionRepositoryAdapter;
  readonly clock: ReturnType<typeof makeClock>;
  readonly register: RegisterOrchestratorSessionUseCase;
  readonly heartbeat: HeartbeatOrchestratorSessionUseCase;
  readonly retire: RetireOrchestratorSessionUseCase;
  readonly list: ListOrchestratorSessionsUseCase;
}

function fresh(): Env {
  const signals: ChangeSignal[] = [];
  const signalPort: ChangeSignalPort = {
    emit(signal: ChangeSignal) {
      signals.push(signal);
    },
  };
  const repo = new OrchestratorSessionRepositoryAdapter({ changeSignal: signalPort });
  const clock = makeClock();
  return {
    signals,
    repo,
    clock,
    register: new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock }),
    heartbeat: new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock }),
    retire: new RetireOrchestratorSessionUseCase({ sessionRepo: repo, clock }),
    list: new ListOrchestratorSessionsUseCase({ sessionRepo: repo, clock }),
  };
}

describe('registration scopes come from the token only (hard)', () => {
  it('stores the presented scopes', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(BODY, ['message']);
    expect(result).toEqual({
      outcome: 'registered',
      session: expect.objectContaining({ scopes: ['message'] }),
      revision: 1,
    });
  });

  it('refuses a body that carries scopes and stores nothing', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(
      { ...BODY, scopes: ['orchestrate'] },
      ['message'],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession registration has an unknown key',
    });
    expect(await env.list.listOrchestratorSessions()).toEqual({ sessions: [] });
  });

  it('refuses matching scopes in the body too', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(
      { ...BODY, scopes: ['message'] },
      ['message'],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession registration has an unknown key',
    });
  });

  it('stores scopes no matter the presentation order', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(BODY, ['orchestrate', 'message']);
    expect(result).toEqual({
      outcome: 'registered',
      session: expect.objectContaining({ scopes: ['message', 'orchestrate'] }),
      revision: 1,
    });
  });

  it('refuses a token holding a forbidden scope and stores nothing', async () => {
    const env = fresh();
    const refusedDispatch = await env.register.registerOrchestratorSession(BODY, ['message', 'dispatch']);
    expect(refusedDispatch).toEqual({
      outcome: 'refused',
      reason: 'the presenting token holds a scope an orchestrator session may not hold',
    });
    const refusedVerdict = await env.register.registerOrchestratorSession(BODY, ['verdict']);
    expect(refusedVerdict).toEqual({
      outcome: 'refused',
      reason: 'the presenting token holds a scope an orchestrator session may not hold',
    });
    expect(await env.list.listOrchestratorSessions()).toEqual({ sessions: [] });
  });

  it('refuses non-array presented scopes', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(BODY, 'message' as never);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'the presenting token\'s scopes could not be read',
    });
  });

  it('never runs hostile array iterators or getters on presented scopes', async () => {
    const env = fresh();

    const lyingIterator: string[] = ['message'];
    Object.defineProperty(lyingIterator, Symbol.iterator, {
      value: function* () {
        yield 'orchestrate';
      },
      configurable: true,
    });
    const withIterator = await env.register.registerOrchestratorSession(BODY, lyingIterator);
    expect(withIterator.outcome).toBe('registered');
    if (withIterator.outcome === 'registered') {
      expect(withIterator.session.scopes).toEqual(['message']);
    }

    const throwingGetter: string[] = [];
    Object.defineProperty(throwingGetter, 0, {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    const withGetter = await env.register.registerOrchestratorSession(BODY, throwingGetter);
    expect(withGetter).toEqual({
      outcome: 'refused',
      reason: 'the presenting token holds a scope an orchestrator session may not hold',
    });
  });
});

describe('register', () => {
  it('records an active session with clock-derived times and one orchestrator signal', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(BODY, ['message']);
    expect(result).toEqual({
      outcome: 'registered',
      session: {
        orchestratorId: 'orch-example-1',
        cliKind: 'claude-code',
        model: 'example-provider/example-model',
        host: 'example-host',
        projects: ['example-project'],
        claims: ['dispatch-attempt'],
        scopes: ['message'],
        startedAtIso: '2026-10-27T10:00:00.000Z',
        lastHeartbeatIso: '2026-10-27T10:00:00.000Z',
        leaseUntilIso: '2026-10-27T10:01:30.000Z',
        lastPolledRequestsAtIso: null,
        status: 'active',
      },
      revision: 1,
    });
    expect(env.signals).toEqual([
      expect.objectContaining({ kind: 'orchestrator', id: 'orch-example-1' }),
    ]);
  });

  it('refuses body keys other than the six closed ones', async () => {
    const env = fresh();
    const withStatus = await env.register.registerOrchestratorSession(
      { ...BODY, status: 'retired' },
      ['message'],
    );
    expect(withStatus).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession registration has an unknown key',
    });
    const withStarted = await env.register.registerOrchestratorSession(
      { ...BODY, startedAtIso: '2026-10-27T09:00:00.000Z' },
      ['message'],
    );
    expect(withStarted).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession registration has an unknown key',
    });
    const withLease = await env.register.registerOrchestratorSession(
      { ...BODY, leaseUntilIso: '2026-10-27T10:30:00.000Z' },
      ['message'],
    );
    expect(withLease).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession registration has an unknown key',
    });
    expect(await env.list.listOrchestratorSessions()).toEqual({ sessions: [] });
  });

  it('refuses a secret-shaped host without echoing it', async () => {
    const env = fresh();
    const fakeSecret = ['sk', '-', 'x9y8z7'.repeat(4)].join('');
    const result = await env.register.registerOrchestratorSession(
      { ...BODY, host: fakeSecret },
      ['message'],
    );
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).not.toContain(fakeSecret);
      expect(result.reason).not.toContain('example');
      expect(result.reason).toBe('OrchestratorSession host contains a secret-shaped value and was refused');
    }
  });

  it('refuses a second registration with the same id', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    const second = await env.register.registerOrchestratorSession(BODY, ['message']);
    expect(second).toEqual({
      outcome: 'refused',
      reason: 'an orchestrator session with this id already exists',
    });
  });
});

describe('heartbeat', () => {
  it('renews the lease from the clock and announces a heartbeat only', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    env.clock.set('2026-10-27T10:00:30.000Z');
    const before = env.signals.length;
    const result = await env.heartbeat.heartbeatOrchestratorSession({
      orchestratorId: 'orch-example-1',
    });
    expect(result).toEqual({
      outcome: 'renewed',
      session: expect.objectContaining({
        lastHeartbeatIso: '2026-10-27T10:00:30.000Z',
        leaseUntilIso: '2026-10-27T10:02:00.000Z',
      }),
      revision: 2,
    });
    expect(env.signals.slice(before)).toEqual([
      expect.objectContaining({ kind: 'heartbeat', id: 'orch-example-1' }),
    ]);
  });

  it('returns not-found for an unknown id', async () => {
    const env = fresh();
    const result = await env.heartbeat.heartbeatOrchestratorSession({ orchestratorId: 'missing' });
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('refuses a retired session', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    await env.retire.retireOrchestratorSession({ orchestratorId: 'orch-example-1' });
    const result = await env.heartbeat.heartbeatOrchestratorSession({
      orchestratorId: 'orch-example-1',
    });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession is retired and cannot renew its lease',
    });
  });

  it('refuses a clock moved backwards with the domain message', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    env.clock.set('2026-10-27T09:59:59.000Z');
    const result = await env.heartbeat.heartbeatOrchestratorSession({
      orchestratorId: 'orch-example-1',
    });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession heartbeat must not move backwards',
    });
  });

  it('retries once after a save conflict and renews', async () => {
    const repo = new ConflictSessionRepo();
    const clock = makeClock();
    const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    await register.registerOrchestratorSession(BODY, ['message']);
    const heartbeat = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    repo.conflictsRemaining = 1;
    clock.set('2026-10-27T10:00:30.000Z');
    const savesBefore = repo.saveCalls;
    const result = await heartbeat.heartbeatOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'renewed',
      session: expect.objectContaining({ leaseUntilIso: '2026-10-27T10:02:00.000Z' }),
      revision: 2,
    });
    expect(repo.saveCalls - savesBefore).toBe(2);
  });

  it('refuses with the fixed reason when saves keep conflicting', async () => {
    const repo = new ConflictSessionRepo();
    const clock = makeClock();
    const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    await register.registerOrchestratorSession(BODY, ['message']);
    const heartbeat = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    repo.conflictsRemaining = Infinity;
    clock.set('2026-10-27T10:00:30.000Z');
    const result = await heartbeat.heartbeatOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'another writer moved this session first; heartbeat again',
    });
  });
});

describe('retire', () => {
  it('retires a session and announces an orchestrator change', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    const before = env.signals.length;
    const result = await env.retire.retireOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'retired',
      session: expect.objectContaining({ status: 'retired' }),
      revision: 2,
    });
    expect(env.signals.slice(before)).toEqual([
      expect.objectContaining({ kind: 'orchestrator', id: 'orch-example-1' }),
    ]);
  });

  it('is idempotent: a second retire saves nothing', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    const first = await env.retire.retireOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(first.outcome).toBe('retired');
    if (first.outcome === 'retired') {
      const signalsAfterFirst = env.signals.length;
      const second = await env.retire.retireOrchestratorSession({ orchestratorId: 'orch-example-1' });
      expect(second).toEqual({ outcome: 'retired', session: first.session, revision: first.revision });
      expect(env.signals.length).toBe(signalsAfterFirst);
    }
  });

  it('returns not-found for an unknown id', async () => {
    const env = fresh();
    const result = await env.retire.retireOrchestratorSession({ orchestratorId: 'missing' });
    expect(result).toEqual({ outcome: 'not-found' });
  });
});

describe('list', () => {
  it('derives attached and attentive from the clock with one read per call', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    await env.register.registerOrchestratorSession(
      { ...BODY, orchestratorId: 'orch-example-2' },
      ['message'],
    );

    // 10:01:00: heartbeat A so its lease outlives B's.
    env.clock.set('2026-10-27T10:01:00.000Z');
    const beat = await env.heartbeat.heartbeatOrchestratorSession({
      orchestratorId: 'orch-example-1',
    });
    expect(beat).toEqual({
      outcome: 'renewed',
      session: expect.objectContaining({ leaseUntilIso: '2026-10-27T10:02:30.000Z' }),
      revision: 2,
    });

    // At 10:01:00 both sessions are attached and neither has polled yet.
    const before = await env.list.listOrchestratorSessions();
    expect(before.sessions).toHaveLength(2);
    for (const entry of before.sessions) {
      expect(entry.attached).toBe(true);
      expect(entry.attentive).toBe(false);
    }

    // Record A's mailbox poll straight through the repository (10:01:30).
    const storedA = await env.repo.get('orch-example-1');
    if (storedA === null) {
      throw new Error('expected A to be stored');
    }
    const loadedA = OrchestratorSession.create(storedA.session);
    if (!loadedA.success) {
      throw new Error(loadedA.error.message);
    }
    const polled = loadedA.value.recordRequestsPoll('2026-10-27T10:01:30.000Z');
    if (!polled.success) {
      throw new Error(polled.error.message);
    }
    await env.repo.save(polled.value.toRecord(), storedA.revision);

    // At 10:02:00 A is still attached (lease 10:02:30) and attentive; B lapsed and never polled.
    env.clock.set('2026-10-27T10:02:00.000Z');
    const callsBefore = env.clock.calls;
    const listed = await env.list.listOrchestratorSessions();
    expect(env.clock.calls - callsBefore).toBe(1);
    const byId = new Map(listed.sessions.map((entry) => [entry.session.orchestratorId, entry]));
    const a = byId.get('orch-example-1');
    const b = byId.get('orch-example-2');
    expect(a?.attached).toBe(true);
    expect(a?.attentive).toBe(true);
    expect(b?.attached).toBe(false);
    expect(b?.attentive).toBe(false);
  });

  it('filters by status and returns an empty list for an invalid status', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(BODY, ['message']);
    await env.register.registerOrchestratorSession(
      { ...BODY, orchestratorId: 'orch-example-2' },
      ['message'],
    );
    await env.retire.retireOrchestratorSession({ orchestratorId: 'orch-example-2' });

    const retired = await env.list.listOrchestratorSessions({ status: 'retired' });
    expect(retired.sessions.map((entry) => entry.session.orchestratorId)).toEqual(['orch-example-2']);

    const bogus = await env.list.listOrchestratorSessions({
      status: 'bogus',
    } as unknown as ListOrchestratorSessionsRequest);
    expect(bogus).toEqual({ sessions: [] });
  });
});

describe('fix round 1 pins', () => {
  it('copies presented scopes by index even when the iterator lies with a forbidden scope', async () => {
    const env = fresh();
    const lyingIterator: string[] = ['message'];
    Object.defineProperty(lyingIterator, Symbol.iterator, {
      value: function* () {
        yield 'dispatch';
      },
      configurable: true,
    });
    const result = await env.register.registerOrchestratorSession(BODY, lyingIterator);
    expect(result.outcome).toBe('registered');
    if (result.outcome === 'registered') {
      expect(result.session.scopes).toEqual(['message']);
    }
  });

  it('registers only a plain record body', async () => {
    const env = fresh();
    class NotARecord {}
    for (const body of [null, ['orch-example-1'], new Map(), new NotARecord()]) {
      const result = await env.register.registerOrchestratorSession(body, ['message']);
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'OrchestratorSession registration requires a record',
      });
    }
    expect(await env.list.listOrchestratorSessions()).toEqual({ sessions: [] });
  });

  it('refuses duplicate presented scopes', async () => {
    const env = fresh();
    const result = await env.register.registerOrchestratorSession(BODY, ['message', 'message']);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession scopes must be distinct session scopes',
    });
    expect(await env.list.listOrchestratorSessions()).toEqual({ sessions: [] });
  });

  it('refuses an empty or whitespace-only orchestratorId for heartbeat and retire', async () => {
    const env = fresh();
    for (const id of ['', '   ']) {
      expect(await env.heartbeat.heartbeatOrchestratorSession({ orchestratorId: id })).toEqual({
        outcome: 'refused',
        reason: 'an orchestratorId is required',
      });
      expect(await env.retire.retireOrchestratorSession({ orchestratorId: id })).toEqual({
        outcome: 'refused',
        reason: 'an orchestratorId is required',
      });
    }
  });

  it('uses the id exactly as given: spaces are part of the id', async () => {
    const env = fresh();
    await env.register.registerOrchestratorSession(
      { ...BODY, orchestratorId: ' orch-1 ' },
      ['message'],
    );
    expect(
      await env.heartbeat.heartbeatOrchestratorSession({ orchestratorId: ' orch-1 ' }),
    ).toEqual({
      outcome: 'renewed',
      session: expect.objectContaining({ orchestratorId: ' orch-1 ' }),
      revision: 2,
    });
    expect(await env.heartbeat.heartbeatOrchestratorSession({ orchestratorId: 'orch-1' })).toEqual({
      outcome: 'not-found',
    });
  });

  it('refuses an unreadable clock instead of throwing', async () => {
    const repo = new OrchestratorSessionRepositoryAdapter({
      changeSignal: { emit() {} },
    });
    const clock = makeClock('not a time');
    const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    const result = await register.registerOrchestratorSession(BODY, ['message']);
    expect(result).toEqual({ outcome: 'refused', reason: 'the clock could not be read' });
    expect(await new ListOrchestratorSessionsUseCase({ sessionRepo: repo, clock }).listOrchestratorSessions())
      .toEqual({ sessions: [] });
  });

  it('heartbeat retry renews at the fresh revision when another writer moved the session', async () => {
    const repo = new ConflictSessionRepo();
    const clock = makeClock();
    await new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock }).registerOrchestratorSession(
      BODY,
      ['message'],
    );
    // Between the two saves, another writer polls the mailbox at a new revision.
    const betweenSaves = async () => {
      const stored = await repo.get('orch-example-1');
      if (stored === null) {
        throw new Error('expected the session to be stored');
      }
      const loaded = OrchestratorSession.create(stored.session);
      if (!loaded.success) {
        throw new Error(loaded.error.message);
      }
      const polled = loaded.value.recordRequestsPoll('2026-10-27T10:00:20.000Z');
      if (!polled.success) {
        throw new Error(polled.error.message);
      }
      await repo.save(polled.value.toRecord(), stored.revision);
    };
    const heartbeat = new HeartbeatOrchestratorSessionUseCase({
      sessionRepo: new HookedRepo(repo, betweenSaves),
      clock,
    });
    repo.conflictsRemaining = 1;
    clock.set('2026-10-27T10:00:30.000Z');
    const result = await heartbeat.heartbeatOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'renewed',
      session: expect.objectContaining({ leaseUntilIso: '2026-10-27T10:02:00.000Z' }),
      revision: 3,
    });
  });

  it('heartbeat retry refuses when the session was retired between the two saves', async () => {
    const repo = new ConflictSessionRepo();
    const clock = makeClock();
    await new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock }).registerOrchestratorSession(
      BODY,
      ['message'],
    );
    const betweenSaves = async () => {
      await new RetireOrchestratorSessionUseCase({ sessionRepo: repo, clock }).retireOrchestratorSession({
        orchestratorId: 'orch-example-1',
      });
    };
    const heartbeat = new HeartbeatOrchestratorSessionUseCase({
      sessionRepo: new HookedRepo(repo, betweenSaves),
      clock,
    });
    repo.conflictsRemaining = 1;
    clock.set('2026-10-27T10:00:30.000Z');
    const result = await heartbeat.heartbeatOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'OrchestratorSession is retired and cannot renew its lease',
    });
  });

  it('retire retry saves and returns retired after one conflict', async () => {
    const repo = new ConflictSessionRepo();
    const clock = makeClock();
    await new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock }).registerOrchestratorSession(
      BODY,
      ['message'],
    );
    const retire = new RetireOrchestratorSessionUseCase({ sessionRepo: repo, clock });
    repo.conflictsRemaining = 1;
    const savesBefore = repo.saveCalls;
    const result = await retire.retireOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'retired',
      session: expect.objectContaining({ status: 'retired' }),
      revision: 2,
    });
    expect(repo.saveCalls - savesBefore).toBe(2);
  });

  it('retire returns retired with no second save when the session was retired between the two saves', async () => {
    const repo = new ConflictSessionRepo();
    const clock = makeClock();
    await new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock }).registerOrchestratorSession(
      BODY,
      ['message'],
    );
    const betweenSaves = async () => {
      await new RetireOrchestratorSessionUseCase({ sessionRepo: repo, clock }).retireOrchestratorSession({
        orchestratorId: 'orch-example-1',
      });
    };
    const retire = new RetireOrchestratorSessionUseCase({
      sessionRepo: new HookedRepo(repo, betweenSaves),
      clock,
    });
    repo.conflictsRemaining = 1;
    const savesBefore = repo.saveCalls;
    const result = await retire.retireOrchestratorSession({ orchestratorId: 'orch-example-1' });
    expect(result).toEqual({
      outcome: 'retired',
      session: expect.objectContaining({ status: 'retired' }),
      revision: 2,
    });
    // Only the conflicting save and the concurrent writer's save happened; the retry saved nothing.
    expect(repo.saveCalls - savesBefore).toBe(2);
  });
});

describe('unconfigured use cases', () => {
  it('reject with Not implemented before any validation', async () => {
    await expect(new RegisterOrchestratorSessionUseCase().registerOrchestratorSession(BODY, ['message']))
      .rejects.toThrow('Not implemented: RegisterOrchestratorSessionUseCase');
    await expect(
      new HeartbeatOrchestratorSessionUseCase().heartbeatOrchestratorSession({
        orchestratorId: 'orch-example-1',
      }),
    ).rejects.toThrow('Not implemented: HeartbeatOrchestratorSessionUseCase');
    await expect(
      new RetireOrchestratorSessionUseCase().retireOrchestratorSession({
        orchestratorId: 'orch-example-1',
      }),
    ).rejects.toThrow('Not implemented: RetireOrchestratorSessionUseCase');
    await expect(new ListOrchestratorSessionsUseCase().listOrchestratorSessions())
      .rejects.toThrow('Not implemented: ListOrchestratorSessionsUseCase');
  });
});

/** A repository double that can fail a chosen number of saves with a revision conflict. */
class ConflictSessionRepo implements OrchestratorSessionRepositoryPort {
  private readonly stored = new Map<string, StoredOrchestratorSession>();
  saveCalls = 0;
  conflictsRemaining = 0;

  async save(
    session: OrchestratorSessionRecord,
    expectedRevision: number,
  ): Promise<StoredOrchestratorSession> {
    this.saveCalls += 1;
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new OrchestratorSessionRevisionConflictError(
        session.orchestratorId,
        expectedRevision + 1,
        'conflict',
      );
    }
    const existing = this.stored.get(session.orchestratorId);
    const currentRevision = existing === undefined ? 0 : existing.revision;
    if (currentRevision !== expectedRevision) {
      throw new OrchestratorSessionRevisionConflictError(
        session.orchestratorId,
        expectedRevision + 1,
        'conflict',
      );
    }
    const next: StoredOrchestratorSession = {
      revision: expectedRevision + 1,
      session: copyRecord(session),
    };
    this.stored.set(session.orchestratorId, next);
    return copyStored(next);
  }

  async get(orchestratorId: string): Promise<StoredOrchestratorSession | null> {
    const found = this.stored.get(orchestratorId);
    return found === undefined ? null : copyStored(found);
  }

  async list(
    query?: OrchestratorSessionListQuery,
  ): Promise<readonly StoredOrchestratorSession[]> {
    return [...this.stored.values()]
      .filter((entry) => query?.status === undefined || entry.session.status === query.status)
      .map(copyStored);
  }
}

/** A repository double that runs a hook between the failing save and the retry. */
class HookedRepo implements OrchestratorSessionRepositoryPort {
  constructor(
    private readonly inner: ConflictSessionRepo,
    private readonly onConflict: () => Promise<void>,
  ) {}

  async save(
    session: OrchestratorSessionRecord,
    expectedRevision: number,
  ): Promise<StoredOrchestratorSession> {
    try {
      return await this.inner.save(session, expectedRevision);
    } catch (error) {
      if (error instanceof OrchestratorSessionRevisionConflictError) {
        await this.onConflict();
      }
      throw error;
    }
  }

  async get(orchestratorId: string): Promise<StoredOrchestratorSession | null> {
    return this.inner.get(orchestratorId);
  }

  async list(
    query?: OrchestratorSessionListQuery,
  ): Promise<readonly StoredOrchestratorSession[]> {
    return this.inner.list(query);
  }
}

function copyRecord(session: OrchestratorSessionRecord): OrchestratorSessionRecord {
  return {
    ...session,
    projects: session.projects.slice(),
    claims: session.claims.slice(),
    scopes: session.scopes.slice(),
  };
}

function copyStored(stored: StoredOrchestratorSession): StoredOrchestratorSession {
  return { revision: stored.revision, session: copyRecord(stored.session) };
}
