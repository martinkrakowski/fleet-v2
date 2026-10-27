/**
 * Lane O3-0 unit tests for the token-id binding of orchestrator sessions: the
 * session is registered by (and bound to) the presenting token's id, and
 * heartbeat and retire refuse any other token inside the use case, so the
 * binding survives a restart.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OrchestratorSession,
  isOrchestratorTokenId,
  isRegisteredByToken,
} from '../../../domain/entities/OrchestratorSession.js';
import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';
import { OrchestratorSessionRevisionConflictError } from '../../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type {
  OrchestratorSessionListQuery,
  OrchestratorSessionRepositoryPort,
  StoredOrchestratorSession,
} from '../../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../ports/out/ChangeSignalPort.out-port.js';
import {
  OrchestratorSessionRepositoryAdapter,
  parseOrchestratorSessionStateRecord,
} from '../../../infrastructure/adapters/OrchestratorSessionRepositoryAdapter.adapter.js';
import type { OrchestratorSessionClock } from '../../ports/in/RegisterOrchestratorSessionPort.in-port.js';
import { RegisterOrchestratorSessionUseCase } from '../RegisterOrchestratorSessionUseCase.use-case.js';
import { HeartbeatOrchestratorSessionUseCase } from '../HeartbeatOrchestratorSessionUseCase.use-case.js';
import { RetireOrchestratorSessionUseCase } from '../RetireOrchestratorSessionUseCase.use-case.js';

const NOW_ISO = '2026-10-27T10:00:00.000Z';
const A = 'token-example-1';
const B = 'token-example-2';

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
  };
}

/** A valid 13-key session record; the registering token id is A. */
const VALID_SESSION: OrchestratorSessionRecord = {
  orchestratorId: 'orch-example-1',
  cliKind: 'claude-code',
  model: 'example-provider/example-model',
  host: 'example-host',
  projects: ['example-project'],
  claims: ['dispatch-attempt', 'prepare-fix'],
  scopes: ['message', 'orchestrate'],
  registeredByTokenId: A,
  startedAtIso: NOW_ISO,
  lastHeartbeatIso: NOW_ISO,
  leaseUntilIso: '2026-10-27T10:02:00.000Z',
  lastPolledRequestsAtIso: null,
  status: 'active',
};

/** The 12-key shape, as stored before O3-0: missing the registering token id. */
function twelveKeySession(): Record<string, unknown> {
  const record: Record<string, unknown> = { ...VALID_SESSION };
  delete record.registeredByTokenId;
  return record;
}

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

describe('O3-0 token-id binding', () => {
  describe('register binds the presenting token id', () => {
    it('stores the token id and refuses a body that carries it', async () => {
      const env = fresh();
      const result = await env.register.registerOrchestratorSession(BODY, ['orchestrate'], A);
      expect(result.outcome).toBe('registered');
      if (result.outcome === 'registered') {
        expect(result.session.registeredByTokenId).toBe(A);
      }

      const refused = await env.register.registerOrchestratorSession(
        { ...BODY, registeredByTokenId: A },
        ['orchestrate'],
        A,
      );
      expect(refused).toEqual({
        outcome: 'refused',
        reason: 'OrchestratorSession registration has an unknown key',
      });
      expect((await env.repo.list()).length).toBe(1);
    });

    it('refuses invalid presented ids before storing anything', async () => {
      const env = fresh();
      const invalidIds: unknown[] = [
        '',
        ' ',
        'a'.repeat(65),
        'tok en',
        '-leading',
        fakeSecretShape(),
        42,
        null,
      ];
      const results = await Promise.all(
        invalidIds.map(async (id) => {
          const result = await env.register.registerOrchestratorSession(BODY, ['orchestrate'], id as never);
          return { id, result };
        }),
      );
      for (const { id, result } of results) {
        expect(result).toEqual({
          outcome: 'refused',
          reason: 'the presenting token could not be identified',
        });
        if (typeof id === 'string' && id.trim().length > 0) {
          expect(result.outcome === 'refused' ? result.reason : '').not.toContain(id);
        }
      }
      expect(await env.repo.list()).toEqual([]);
    });
  });

  describe('heartbeat honours the binding', () => {
    it('refuses any other token, then renews for the owner', async () => {
      const env = fresh();
      await env.register.registerOrchestratorSession(BODY, ['orchestrate'], A);
      env.clock.set('2026-10-27T10:00:30.000Z');

      const storedBefore = await env.repo.get('orch-example-1');
      const signalsBefore = env.signals.length;
      const notOwner = await env.heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        B,
      );
      expect(notOwner).toEqual({ outcome: 'not-owner' });
      expect(await env.repo.get('orch-example-1')).toEqual(storedBefore);
      expect(env.signals.length).toBe(signalsBefore);

      const renewed = await env.heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        A,
      );
      expect(renewed).toEqual({
        outcome: 'renewed',
        session: expect.objectContaining({
          lastHeartbeatIso: '2026-10-27T10:00:30.000Z',
          leaseUntilIso: '2026-10-27T10:02:00.000Z',
        }),
        revision: 2,
      });
      expect(env.signals.slice(signalsBefore)).toEqual([
        expect.objectContaining({ kind: 'heartbeat', id: 'orch-example-1' }),
      ]);
    });

    it('refuses an invalid presented id and reports not-found for unknown ids', async () => {
      const env = fresh();
      await env.register.registerOrchestratorSession(BODY, ['orchestrate'], A);
      const badId = await env.heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        'bad id',
      );
      expect(badId).toEqual({
        outcome: 'refused',
        reason: 'the presenting token could not be identified',
      });
      const unknown = await env.heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'missing' },
        B,
      );
      expect(unknown).toEqual({ outcome: 'not-found' });
    });
  });

  describe('retire honours the binding', () => {
    it('refuses any other token and keeps the session active until the owner retires', async () => {
      const env = fresh();
      await env.register.registerOrchestratorSession(BODY, ['orchestrate'], A);

      const notOwner = await env.retire.retireOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        B,
      );
      expect(notOwner).toEqual({ outcome: 'not-owner' });
      const stored = await env.repo.get('orch-example-1');
      expect(stored?.session.status).toBe('active');

      const retired = await env.retire.retireOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        A,
      );
      expect(retired.outcome).toBe('retired');
      if (retired.outcome === 'retired') {
        const signalsAfterRetire = env.signals.length;
        const laterNotOwner = await env.retire.retireOrchestratorSession(
          { orchestratorId: 'orch-example-1' },
          B,
        );
        expect(laterNotOwner).toEqual({ outcome: 'not-owner' });
        const again = await env.retire.retireOrchestratorSession(
          { orchestratorId: 'orch-example-1' },
          A,
        );
        expect(again).toEqual({ outcome: 'retired', session: retired.session, revision: retired.revision });
        expect(env.signals.length).toBe(signalsAfterRetire);
      }
    });
  });

  describe('the binding survives a restart', () => {
    let tempDir: string | undefined;

    afterEach(async () => {
      if (tempDir !== undefined) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('re-reads the registered token id from disk', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-o3-token-binding-test-'));
      const first = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir });
      const firstClock = makeClock();
      const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: first, clock: firstClock });
      await register.registerOrchestratorSession(BODY, ['orchestrate'], A);

      const second = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir });
      const secondClock = makeClock('2026-10-27T10:00:30.000Z');
      const heartbeat = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: second, clock: secondClock });
      const notOwner = await heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        B,
      );
      expect(notOwner).toEqual({ outcome: 'not-owner' });
      const renewed = await heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        A,
      );
      expect(renewed.outcome).toBe('renewed');
    });
  });

  describe('conflict retry re-checks ownership', () => {
    it('renews on the retry for the owner', async () => {
      const repo = new ConflictSessionRepo();
      const clock = makeClock();
      const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock });
      await register.registerOrchestratorSession(BODY, ['orchestrate'], A);
      const heartbeat = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock });
      repo.conflictsRemaining = 1;
      clock.set('2026-10-27T10:00:30.000Z');
      const savesBefore = repo.saveCalls;
      const result = await heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        A,
      );
      expect(result).toEqual({
        outcome: 'renewed',
        session: expect.objectContaining({ leaseUntilIso: '2026-10-27T10:02:00.000Z' }),
        revision: 2,
      });
      expect(repo.saveCalls - savesBefore).toBe(2);
    });

    it('returns not-owner without saving when the retry is for another token', async () => {
      const repo = new ConflictSessionRepo();
      const clock = makeClock();
      const register = new RegisterOrchestratorSessionUseCase({ sessionRepo: repo, clock });
      await register.registerOrchestratorSession(BODY, ['orchestrate'], A);
      const heartbeat = new HeartbeatOrchestratorSessionUseCase({ sessionRepo: repo, clock });
      repo.conflictsRemaining = 1;
      clock.set('2026-10-27T10:00:30.000Z');
      const savesBefore = repo.saveCalls;
      const result = await heartbeat.heartbeatOrchestratorSession(
        { orchestratorId: 'orch-example-1' },
        B,
      );
      expect(result).toEqual({ outcome: 'not-owner' });
      expect(repo.saveCalls).toBe(savesBefore);
    });
  });

  describe('domain validation of the token id', () => {
    it('requires the 13th key', () => {
      const result = OrchestratorSession.create(twelveKeySession());
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('OrchestratorSession has an unknown key');
      }
    });

    it('refuses ids that break the pattern', () => {
      const longResult = OrchestratorSession.create({ ...VALID_SESSION, registeredByTokenId: 'a'.repeat(65) });
      expect(longResult.success).toBe(false);
      if (!longResult.success) {
        expect(longResult.error.message).toBe(
          'OrchestratorSession registeredByTokenId must be a token id of 1 to 64 letters, digits, dot, underscore or hyphen',
        );
      }
      const spacedResult = OrchestratorSession.create({ ...VALID_SESSION, registeredByTokenId: 'tok en' });
      expect(spacedResult.success).toBe(false);
      if (!spacedResult.success) {
        expect(spacedResult.error.message).toBe(
          'OrchestratorSession registeredByTokenId must be a token id of 1 to 64 letters, digits, dot, underscore or hyphen',
        );
      }
    });

    it('refuses a secret-shaped token id without echoing it', () => {
      const secret = fakeSecretShape();
      const result = OrchestratorSession.create({ ...VALID_SESSION, registeredByTokenId: secret });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe(
          'OrchestratorSession registeredByTokenId contains a secret-shaped value and was refused',
        );
        expect(result.error.message).not.toContain(secret);
      }
    });

    it('round-trips the id through toRecord', () => {
      const result = OrchestratorSession.create(VALID_SESSION);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.toRecord()).toEqual(VALID_SESSION);
      }
    });

    it('isOrchestratorTokenId and isRegisteredByToken cover true and false cases', () => {
      expect(isOrchestratorTokenId(A)).toBe(true);
      expect(isOrchestratorTokenId('a'.repeat(64))).toBe(true);
      expect(isOrchestratorTokenId('')).toBe(false);
      expect(isOrchestratorTokenId('tok en')).toBe(false);
      expect(isOrchestratorTokenId('-leading')).toBe(false);
      expect(isOrchestratorTokenId('a'.repeat(65))).toBe(false);
      expect(isOrchestratorTokenId(fakeSecretShape())).toBe(false);
      expect(isOrchestratorTokenId(42)).toBe(false);
      expect(isOrchestratorTokenId(null)).toBe(false);

      const created = OrchestratorSession.create(VALID_SESSION);
      const record = created.success ? created.value.toRecord() : VALID_SESSION;
      expect(isRegisteredByToken(record, A)).toBe(true);
      expect(isRegisteredByToken(record, B)).toBe(false);
      expect(isRegisteredByToken(record, 'bad id')).toBe(false);
      expect(isRegisteredByToken(record, 42)).toBe(false);
      expect(isRegisteredByToken(record, null)).toBe(false);
    });
  });

  describe('store classification and state-file parsing', () => {
    it('announces an orchestrator change when only the token id changes', async () => {
      const signals: ChangeSignal[] = [];
      const adapter = new OrchestratorSessionRepositoryAdapter({
        changeSignal: {
          emit(signal: ChangeSignal) {
            signals.push(signal);
          },
        },
      });
      await adapter.save(VALID_SESSION, 0);
      const signalsAfterFirst = signals.length;
      await adapter.save({ ...VALID_SESSION, registeredByTokenId: B }, 1);
      expect(signals.slice(signalsAfterFirst)).toEqual([
        expect.objectContaining({ kind: 'orchestrator', id: 'orch-example-1' }),
      ]);
    });

    it('quarantines a stored 12-key record and parses the 13-key record', () => {
      expect(parseOrchestratorSessionStateRecord({ revision: 1, session: twelveKeySession() })).toBeUndefined();
      expect(parseOrchestratorSessionStateRecord({ revision: 1, session: VALID_SESSION })).toEqual({
        revision: 1,
        session: VALID_SESSION,
      });
    });
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
