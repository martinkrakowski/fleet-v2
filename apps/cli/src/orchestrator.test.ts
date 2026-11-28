import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OrchestratorRequestRepositoryAdapter,
  OrchestratorSession,
  OrchestratorSessionRepositoryAdapter,
  OrchestratorSessionRevisionConflictError,
} from '@fleet/operator-coordination';
import type { OrchestratorRequestRecord, OrchestratorSessionRecord } from '@fleet/operator-coordination';

import type { CliIo } from './index.js';
import {
  abortableSleep,
  createSnapshottingSessionRepo,
  InvalidStoreDataError,
  MAX_SEEN_REQUEST_IDS,
  orchestratorCommand,
  orchestratorHelpRequested,
  rememberRequestId,
  snapshotSessionRecord,
  type OrchestratorCliOptions,
} from './orchestrator.js';

const NOW = '2026-11-27T12:00:00.000Z';
const ORCH_ID = 'orch-01FIXTUREAAAAAAAAAAAAAAAAA';
const REQUEST_A = '01H8XGJWBWBAQ4Z2D5FN0DTQ7A';
const REQUEST_B = '01H8XGJWBWBAQ4Z2D5FN0DTQ7B';

function createIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (t) => void stdout.push(t), stderr: (t) => void stderr.push(t) }, stdout, stderr };
}

function sessionRecord(overrides: Record<string, unknown> = {}): OrchestratorSessionRecord {
  const created = OrchestratorSession.create({
    orchestratorId: ORCH_ID,
    cliKind: 'agy',
    model: null,
    host: 'fixture-host',
    projects: [],
    claims: ['dispatch-attempt'],
    scopes: ['orchestrate'],
    registeredByTokenId: 'cli-orchestrator',
    startedAtIso: NOW,
    lastHeartbeatIso: NOW,
    leaseUntilIso: '2026-11-27T12:01:30.000Z',
    lastPolledRequestsAtIso: null,
    status: 'active',
    ...overrides,
  });
  if (!created.success) throw new Error('fixture session invalid');
  return created.value.toRecord();
}

function requestRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_A,
    revision: 1,
    kind: 'dispatch-attempt',
    projectId: 'fixture-project',
    target: { attemptId: 'attempt-fixture-1' },
    requestedBy: { via: 'web', sessionId: 'web-session-1' },
    createdAtIso: '2026-11-27T11:55:00.000Z',
    expiresAtIso: '2026-11-27T12:10:00.000Z',
    updatedAtIso: '2026-11-27T11:55:00.000Z',
    state: 'queued',
    fence: 0,
    claimCount: 0,
    claim: null,
    deferredUntilIso: null,
    reason: null,
    linked: null,
    ...overrides,
  };
}

/** A record whose named field is an accessor; `fired` flips if the getter ever runs. */
function withGetter(record: Record<string, unknown>, key: string): { value: Record<string, unknown>; fired: () => boolean } {
  let fired = false;
  const copy: Record<string, unknown> = { ...record };
  const original = copy[key];
  Object.defineProperty(copy, key, {
    get() {
      fired = true;
      return original;
    },
    enumerable: true,
    configurable: true,
  });
  return { value: copy, fired: () => fired };
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** Wrap a request-store `list` answer into a runtime that also has a session store. */
function runtimeWith(parts: Record<string, unknown>): { coordination: Record<string, unknown> } {
  return { coordination: parts };
}

describe('orchestrator CLI', () => {
  let stateDir: string;
  let sessions: OrchestratorSessionRepositoryAdapter;
  let requests: OrchestratorRequestRepositoryAdapter;
  let clockMs: number;
  const now = (): string => new Date(clockMs).toISOString();
  const baseOptions = (): OrchestratorCliOptions => ({
    now,
    newOrchestratorId: () => '01FIXTUREAAAAAAAAAAAAAAAAA',
    hostName: 'fixture-host',
    sleep: async (ms) => {
      clockMs += ms;
    },
  });
  const realRuntime = (): { coordination: Record<string, unknown> } =>
    runtimeWith({ orchestratorSessionRepository: sessions, orchestratorRequestRepository: requests });

  async function seedRequest(overrides: Record<string, unknown> = {}): Promise<void> {
    const saved = await requests.save(requestRecord(overrides) as unknown as OrchestratorRequestRecord, 0);
    expect(saved.outcome).toBe('saved');
  }

  async function run(argv: string[], runtime: unknown, options: OrchestratorCliOptions = baseOptions()) {
    const captured = createIo();
    const code = await orchestratorCommand(argv, captured.io, runtime as never, options);
    return { code, stdout: captured.stdout.join(''), stderr: captured.stderr.join('') };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'fleet-orchestrator-cli-'));
    sessions = new OrchestratorSessionRepositoryAdapter({ stateDir });
    requests = new OrchestratorRequestRepositoryAdapter({ stateDir });
    clockMs = Date.parse(NOW);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe('usage errors', () => {
    it('returns exit 2 for missing subcommand, unknown flags, invalid --kind, invalid --format, and out-of-range --interval or --limit', async () => {
      const bad: string[][] = [
        [],
        ['bogus'],
        ['status', '--nope'],
        ['status', 'positional'],
        ['status', '--status', 'paused'],
        ['status', '--status', 'active', '--status', 'retired'],
        ['pending', '--kind', 'bogus-kind'],
        ['pending', '--format', 'xml'],
        ['pending', '--limit', '0'],
        ['pending', '--limit', '1001'],
        ['pending', '--limit', '1.5'],
        ['pending', '--limit'],
        ['attach'],
        ['attach', '--kind', 'not-a-cli'],
        ['attach', '--kind', 'agy', '--claim', 'bogus-claim'],
        ['attach', '--kind', 'agy', '--interval', '0s'],
        ['attach', '--kind', 'agy', '--interval', '61s'],
        ['attach', '--kind', 'agy', '--interval', '30'],
        ['attach', '--kind', 'agy', '--max', 'soon'],
        ['attach', '--kind', 'agy', '--once', '--once'],
      ];
      for (const argv of bad) {
        const result = await run(argv, realRuntime());
        expect(result.code, argv.join(' ')).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).not.toBe('');
      }
      expect(orchestratorHelpRequested(['status', '--help'])).toBe(true);
      expect(orchestratorHelpRequested(['status'])).toBe(false);
    });
  });

  describe('store availability', () => {
    it('status reports store-unavailable when a repository method is missing', async () => {
      for (const runtime of [undefined, {}, runtimeWith({}), runtimeWith({ orchestratorSessionRepository: { list: 'no' } })]) {
        const result = await run(['status'], runtime);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown', code: 'store-unavailable' });
      }
    });

    it('pending reports store-unavailable when a repository method is missing', async () => {
      const json = await run(['pending'], runtimeWith({ orchestratorRequestRepository: {} }));
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ outcome: 'unknown', code: 'store-unavailable' });
      const hook = await run(['pending', '--format', 'hook'], runtimeWith({ orchestratorRequestRepository: {} }));
      expect(hook.code).toBe(1);
      expect(hook.stdout).toBe('');
      expect(hook.stderr).toContain('store-unavailable');
    });

    it('attach reports store-unavailable when a repository method is missing', async () => {
      const partial = runtimeWith({
        orchestratorSessionRepository: { get: async () => null, list: async () => [] },
        orchestratorRequestRepository: requests,
      });
      for (const runtime of [undefined, partial, runtimeWith({ orchestratorSessionRepository: sessions })]) {
        const result = await run(['attach', '--kind', 'agy', '--once'], runtime);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown', code: 'store-unavailable' });
      }
      expect(await sessions.list()).toEqual([]);
    });
  });

  describe('status', () => {
    it('lists sessions with attached and attentive derived from the clock, filtered by --status', async () => {
      const attentive = sessionRecord({ lastPolledRequestsAtIso: NOW });
      const lapsed = sessionRecord({
        orchestratorId: 'orch-01FIXTUREBBBBBBBBBBBBBBBBB',
        startedAtIso: '2026-11-27T10:00:00.000Z',
        lastHeartbeatIso: '2026-11-27T10:00:00.000Z',
        leaseUntilIso: '2026-11-27T10:01:30.000Z',
        host: 'fixture-host-two',
      });
      await sessions.save(attentive, 0);
      await sessions.save(lapsed, 0);
      const all = await run(['status'], realRuntime());
      expect(all.code).toBe(0);
      const parsed = JSON.parse(all.stdout) as { outcome: string; sessions: { session: { orchestratorId: string }; attached: boolean; attentive: boolean }[] };
      expect(parsed.outcome).toBe('ok');
      const byId = new Map(parsed.sessions.map((entry) => [entry.session.orchestratorId, entry]));
      expect(byId.get(ORCH_ID)).toMatchObject({ attached: true, attentive: true });
      expect(byId.get('orch-01FIXTUREBBBBBBBBBBBBBBBBB')).toMatchObject({ attached: false, attentive: false });
      const retiredOnly = await run(['status', '--status', 'retired', '--json'], realRuntime());
      expect(JSON.parse(retiredOnly.stdout)).toEqual({ outcome: 'ok', sessions: [] });
    });

    it('status refuses a getter-bearing session from sessionRepo.list without invoking the getter', async () => {
      const hostile = withGetter(sessionRecord() as unknown as Record<string, unknown>, 'status');
      const result = await run(
        ['status'],
        runtimeWith({ orchestratorSessionRepository: { list: async () => [{ session: hostile.value, revision: 1 }] } }),
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown' });
      expect(hostile.fired()).toBe(false);
    });

    it('status and pending return exit 1 when store returns unknown or throws', async () => {
      const throwing = runtimeWith({
        orchestratorSessionRepository: { list: async () => Promise.reject(new Error('disk gone')) },
        orchestratorRequestRepository: { list: async () => Promise.reject(new Error('disk gone')) },
      });
      for (const argv of [['status'], ['pending']]) {
        const result = await run(argv, throwing);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown' });
        expect(result.stdout).not.toContain('disk gone');
      }
      for (const outcome of ['unknown', 'refused']) {
        const result = await run(
          ['pending'],
          runtimeWith({ orchestratorRequestRepository: { list: async () => ({ outcome, code: 'invalid-input' }) } }),
        );
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome });
      }
    });

    it('refuses revoked Proxy and throwing Proxy trap without uncaught throw', async () => {
      const throwingTrap = new Proxy({}, {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
        getPrototypeOf() {
          throw new Error('prototype trap');
        },
      });
      for (const hostile of [revokedProxy(), throwingTrap]) {
        const status = await run(
          ['status'],
          runtimeWith({ orchestratorSessionRepository: { list: async () => [{ session: hostile, revision: 1 }] } }),
        );
        expect(status.code).toBe(1);
        expect(JSON.parse(status.stdout)).toMatchObject({ outcome: 'unknown' });
        const pending = await run(
          ['pending'],
          runtimeWith({ orchestratorRequestRepository: { list: async () => hostile } }),
        );
        expect(pending.code).toBe(1);
        expect(JSON.parse(pending.stdout)).toMatchObject({ outcome: 'unknown' });
      }
    });

    it('refuses reserved own keys __proto__, constructor, prototype and extra keys on records or outcomes', async () => {
      for (const key of ['__proto__', 'constructor', 'prototype', 'extraKey']) {
        const hostileSession: Record<string, unknown> = { ...sessionRecord() };
        Object.defineProperty(hostileSession, key, { value: 'x', enumerable: true, configurable: true });
        expect(snapshotSessionRecord(hostileSession), key).toBeNull();
        const hostileRequest: Record<string, unknown> = { ...requestRecord() };
        Object.defineProperty(hostileRequest, key, { value: 'x', enumerable: true, configurable: true });
        const pending = await run(
          ['pending'],
          runtimeWith({
            orchestratorRequestRepository: { list: async () => ({ outcome: 'ok', requests: [hostileRequest], truncated: false }) },
          }),
        );
        expect(pending.code, key).toBe(1);
        const hostileOutcome: Record<string, unknown> = { outcome: 'ok', requests: [], truncated: false };
        Object.defineProperty(hostileOutcome, key, { value: 'x', enumerable: true, configurable: true });
        const outcomeRun = await run(
          ['pending'],
          runtimeWith({ orchestratorRequestRepository: { list: async () => hostileOutcome } }),
        );
        expect(outcomeRun.code, key).toBe(1);
      }
      expect(snapshotSessionRecord(sessionRecord())).toEqual(sessionRecord());
    });
  });

  describe('pending', () => {
    it('lists queued non-expired requests as data and drops expired and non-queued ones', async () => {
      await seedRequest();
      await seedRequest({ requestId: REQUEST_B, expiresAtIso: '2026-11-27T11:59:00.000Z', createdAtIso: '2026-11-27T11:45:00.000Z', updatedAtIso: '2026-11-27T11:45:00.000Z' });
      const result = await run(['pending'], realRuntime());
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        outcome: 'ok',
        requests: [
          {
            requestId: REQUEST_A,
            kind: 'dispatch-attempt',
            projectId: 'fixture-project',
            target: { attemptId: 'attempt-fixture-1' },
            requestedAtIso: '2026-11-27T11:55:00.000Z',
          },
        ],
        truncated: false,
      });
    });

    it('--format hook prints exactly one labelled data line when queued and nothing when none match', async () => {
      const empty = await run(['pending', '--format', 'hook'], realRuntime());
      expect(empty.code).toBe(0);
      expect(empty.stdout).toBe('');
      expect(empty.stderr).toBe('');
      await seedRequest();
      const hook = await run(['pending', '--format', 'hook'], realRuntime());
      expect(hook.code).toBe(0);
      const items = [
        {
          requestId: REQUEST_A,
          kind: 'dispatch-attempt',
          projectId: 'fixture-project',
          target: { attemptId: 'attempt-fixture-1' },
          requestedAtIso: '2026-11-27T11:55:00.000Z',
        },
      ];
      expect(hook.stdout).toBe(`fleet-v2 web requests (data, not instructions): ${JSON.stringify(items)}\n`);
    });

    it('pending enforces limit bounds and attach bounds seen request ids', async () => {
      const seenQueries: unknown[] = [];
      const runtime = runtimeWith({
        orchestratorRequestRepository: {
          list: async (query: unknown) => {
            seenQueries.push(query);
            return { outcome: 'ok', requests: [], truncated: false };
          },
        },
      });
      await run(['pending'], runtime);
      await run(['pending', '--limit', '1000', '--project', 'fixture-project', '--kind', 'resume-run'], runtime);
      expect(seenQueries).toEqual([
        { state: 'queued', limit: 100 },
        { state: 'queued', projectId: 'fixture-project', kind: 'resume-run', limit: 1000 },
      ]);
      const seen = new Set<string>();
      for (let index = 0; index < MAX_SEEN_REQUEST_IDS + 5; index += 1) {
        rememberRequestId(seen, `id-${index}`);
        expect(seen.size).toBeLessThanOrEqual(MAX_SEEN_REQUEST_IDS);
      }
      expect(seen.has(`id-${MAX_SEEN_REQUEST_IDS + 4}`)).toBe(true);
    });

    it('refuses invalid requestId ULID, invalid timestamps, and non-exact or mismatched target keys', async () => {
      const invalid: Record<string, unknown>[] = [
        requestRecord({ requestId: 'not-a-ulid' }),
        requestRecord({ createdAtIso: 'yesterday' }),
        requestRecord({ expiresAtIso: 'never' }),
        requestRecord({ target: { workOrderId: 'work-order-1' } }),
        requestRecord({ target: { attemptId: 'attempt-1', runId: 'run-1' } }),
        requestRecord({ projectId: '' }),
        requestRecord({ target: { attemptId: 'a'.repeat(300) } }),
      ];
      for (const record of invalid) {
        const result = await run(
          ['pending'],
          runtimeWith({ orchestratorRequestRepository: { list: async () => ({ outcome: 'ok', requests: [record], truncated: false }) } }),
        );
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown' });
      }
    });

    it('refuses malformed nested outcome fields, null, non-array, array hole, and array-like', async () => {
      const holed: unknown[] = [requestRecord()];
      holed.length = 2;
      const arrayLike = { length: 1, 0: requestRecord() };
      const answers: unknown[] = [
        null,
        undefined,
        'ok',
        { outcome: 'ok', requests: [], truncated: 'no' },
        { outcome: 'ok', requests: null, truncated: false },
        { outcome: 'ok', requests: arrayLike, truncated: false },
        { outcome: 'ok', requests: holed, truncated: false },
        { outcome: 'ok', requests: new Array<unknown>(1001).fill(requestRecord()), truncated: false },
        { outcome: 'surprise', requests: [], truncated: false },
      ];
      for (const answer of answers) {
        const result = await run(
          ['pending'],
          runtimeWith({ orchestratorRequestRepository: { list: async () => answer } }),
        );
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown' });
      }
    });

    it('refuses own accessor and Symbol.iterator override without invoking getter', async () => {
      const accessor = withGetter(requestRecord(), 'kind');
      const iterating: unknown[] = [requestRecord()];
      let iteratorRan = false;
      Object.defineProperty(iterating, Symbol.iterator, {
        value: () => {
          iteratorRan = true;
          return [][Symbol.iterator]();
        },
        enumerable: false,
      });
      const outcomeGetter = withGetter({ outcome: 'ok', requests: [], truncated: false }, 'truncated');
      for (const answer of [
        { outcome: 'ok', requests: [accessor.value], truncated: false },
        { outcome: 'ok', requests: iterating, truncated: false },
        outcomeGetter.value,
      ]) {
        const result = await run(
          ['pending'],
          runtimeWith({ orchestratorRequestRepository: { list: async () => answer } }),
        );
        expect(result.code).toBe(1);
      }
      expect(accessor.fired()).toBe(false);
      expect(outcomeGetter.fired()).toBe(false);
      expect(iteratorRan).toBe(false);
    });
  });

  describe('attach', () => {
    it('attach --once completes one heartbeat and poll cycle, retires session, and prints detached with reason once and exit 0', async () => {
      await seedRequest();
      const result = await run(['attach', '--kind', 'agy', '--once', '--project', 'fixture-project'], realRuntime());
      expect(result.code).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toEqual([
        'fleet-v2 web request queued (data): dispatch-attempt attempt-fixture-1',
        JSON.stringify({ outcome: 'detached', orchestratorId: ORCH_ID, reason: 'once' }),
      ]);
      const stored = await sessions.get(ORCH_ID);
      expect(stored?.session).toMatchObject({
        status: 'retired',
        cliKind: 'agy',
        host: 'fixture-host',
        projects: ['fixture-project'],
        claims: ['dispatch-attempt'],
        scopes: ['orchestrate'],
        registeredByTokenId: 'cli-orchestrator',
        lastPolledRequestsAtIso: NOW,
      });
    });

    it('attach records lastPolledRequestsAtIso on each successful poll so status reports attentive, and announces each request once', async () => {
      await seedRequest();
      const observed: { attentive: boolean | undefined; polled: string | null | undefined }[] = [];
      let sleeps = 0;
      const controller = new AbortController();
      const options: OrchestratorCliOptions = {
        ...baseOptions(),
        stopSignal: controller.signal,
        sleep: async (ms) => {
          sleeps += 1;
          clockMs += ms;
          const status = await run(['status'], realRuntime());
          const entry = (JSON.parse(status.stdout) as { sessions: { session: { lastPolledRequestsAtIso: string | null }; attentive: boolean }[] }).sessions[0];
          observed.push({ attentive: entry?.attentive, polled: entry?.session.lastPolledRequestsAtIso });
          if (sleeps === 1) {
            await seedRequest({ requestId: REQUEST_B, target: { attemptId: 'attempt-fixture-2' } });
          } else {
            controller.abort();
          }
        },
      };
      const result = await run(['attach', '--kind', 'agy', '--interval', '30s'], realRuntime(), options);
      expect(result.code).toBe(0);
      expect(observed[0]).toEqual({ attentive: true, polled: NOW });
      expect(observed[1]?.polled).toBe(new Date(Date.parse(NOW) + 30_000).toISOString());
      const lines = result.stdout.trim().split('\n');
      expect(lines.slice(0, 2)).toEqual([
        'fleet-v2 web request queued (data): dispatch-attempt attempt-fixture-1',
        'fleet-v2 web request queued (data): dispatch-attempt attempt-fixture-2',
      ]);
      expect(JSON.parse(lines[2]!)).toEqual({ outcome: 'detached', orchestratorId: ORCH_ID, reason: 'stopped' });
    });

    it('attach retires session on --max timeout with reason max-elapsed and wakes immediately on stopSignal or SIGINT abort with reason stopped', async () => {
      const timed = await run(['attach', '--kind', 'opencode', '--max', '90s', '--interval', '30s'], realRuntime());
      expect(timed.code).toBe(0);
      expect(JSON.parse(timed.stdout.trim())).toEqual({ outcome: 'detached', orchestratorId: ORCH_ID, reason: 'max-elapsed' });
      expect((await sessions.get(ORCH_ID))?.session.status).toBe('retired');

      // A stop signal that is already aborted ends the loop before any wait.
      const aborted = new AbortController();
      aborted.abort();
      const stoppedRuntime = runtimeWith({
        orchestratorSessionRepository: new OrchestratorSessionRepositoryAdapter({ stateDir: join(stateDir, 'second') }),
        orchestratorRequestRepository: requests,
      });
      let waited = false;
      const stopped = await run(['attach', '--kind', 'agy'], stoppedRuntime, {
        ...baseOptions(),
        stopSignal: aborted.signal,
        sleep: async () => {
          waited = true;
        },
      });
      expect(stopped.code).toBe(0);
      expect(JSON.parse(stopped.stdout.trim())).toMatchObject({ outcome: 'detached', reason: 'stopped' });
      expect(waited).toBe(false);

      // SIGINT wakes the real sleep at once: a 60 s interval returns within the test.
      const sigintRuntime = runtimeWith({
        orchestratorSessionRepository: new OrchestratorSessionRepositoryAdapter({ stateDir: join(stateDir, 'third') }),
        orchestratorRequestRepository: requests,
      });
      const pending = run(['attach', '--kind', 'agy', '--interval', '60s'], sigintRuntime, {
        now,
        newOrchestratorId: () => '01FIXTUREAAAAAAAAAAAAAAAAA',
        hostName: 'fixture-host',
      });
      setTimeout(() => process.emit('SIGINT'), 50);
      const interrupted = await pending;
      expect(interrupted.code).toBe(0);
      expect(JSON.parse(interrupted.stdout.trim())).toMatchObject({ outcome: 'detached', reason: 'stopped' });
    });

    it('abortableSleep resolves immediately on abort and removes its timer and listener', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const sleeping = abortableSleep(30_000, controller.signal);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      controller.abort();
      await sleeping;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      const finished = new AbortController();
      await abortableSleep(5, finished.signal);
      expect(getEventListeners(finished.signal, 'abort')).toHaveLength(0);
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await abortableSleep(30_000, alreadyAborted.signal);
    });

    it('attach exits 1 when session registration is refused', async () => {
      const secretShaped = `${'gh'}${'p_'}${'x'.repeat(36)}`;
      const result = await run(['attach', '--kind', 'agy', '--model', secretShaped, '--once'], realRuntime());
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'refused' });
      expect(result.stdout).not.toContain(secretShaped);
      expect(await sessions.list()).toEqual([]);
    });

    it('attach writes one stderr line and records no poll when the request store answers unknown', async () => {
      const runtime = runtimeWith({
        orchestratorSessionRepository: sessions,
        orchestratorRequestRepository: { list: async () => ({ outcome: 'unknown', code: 'unreadable' }) },
      });
      const result = await run(['attach', '--kind', 'agy', '--once'], runtime);
      expect(result.code).toBe(0);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
      expect((await sessions.get(ORCH_ID))?.session.lastPolledRequestsAtIso).toBeNull();
    });

    /** A session repository whose Nth `get` answers with a getter-bearing record. */
    function hostileGetAt(callNumber: number): { runtime: ReturnType<typeof runtimeWith>; fired: () => boolean } {
      let calls = 0;
      let fired = () => false;
      const repo = {
        list: sessions.list.bind(sessions),
        save: sessions.save.bind(sessions),
        get: async (id: string) => {
          calls += 1;
          if (calls === callNumber) {
            const hostile = withGetter(sessionRecord() as unknown as Record<string, unknown>, 'status');
            fired = hostile.fired;
            return { session: hostile.value, revision: 1 };
          }
          return sessions.get(id);
        },
      };
      return {
        runtime: runtimeWith({ orchestratorSessionRepository: repo, orchestratorRequestRepository: requests }),
        fired: () => fired(),
      };
    }

    it('attach refuses a getter-bearing session on register get without invoking the getter', async () => {
      const { runtime, fired } = hostileGetAt(1);
      const result = await run(['attach', '--kind', 'agy', '--once'], runtime);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown' });
      expect(fired()).toBe(false);
      expect(await sessions.list()).toEqual([]);
    });

    it('attach refuses a getter-bearing session on heartbeat get without invoking the getter', async () => {
      const { runtime, fired } = hostileGetAt(2);
      const result = await run(['attach', '--kind', 'agy', '--once'], runtime);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown', orchestratorId: ORCH_ID });
      expect(fired()).toBe(false);
      expect((await sessions.get(ORCH_ID))?.session.status).toBe('retired');
    });

    it('attach refuses a getter-bearing session on the poll-record get without invoking the getter', async () => {
      const { runtime, fired } = hostileGetAt(3);
      const result = await run(['attach', '--kind', 'agy', '--once'], runtime);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown', orchestratorId: ORCH_ID });
      expect(fired()).toBe(false);
      expect((await sessions.get(ORCH_ID))?.session.lastPolledRequestsAtIso).toBeNull();
      expect((await sessions.get(ORCH_ID))?.session.status).toBe('retired');
    });

    it('attach refuses a getter-bearing session on retire get without invoking the getter', async () => {
      const { runtime, fired } = hostileGetAt(4);
      const result = await run(['attach', '--kind', 'agy', '--once'], runtime);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'unknown' });
      expect(fired()).toBe(false);
      expect((await sessions.get(ORCH_ID))?.session.status).toBe('active');
    });

    it('attach stops and exits 1 when heartbeat or recordRequestsPoll is refused, session is not-found, or save conflicts twice', async () => {
      // Not found on the heartbeat read.
      let gets = 0;
      const vanishing = {
        list: sessions.list.bind(sessions),
        save: sessions.save.bind(sessions),
        get: async (id: string) => {
          gets += 1;
          return gets >= 2 ? null : sessions.get(id);
        },
      };
      const notFound = await run(
        ['attach', '--kind', 'agy', '--once'],
        runtimeWith({ orchestratorSessionRepository: vanishing, orchestratorRequestRepository: requests }),
      );
      expect(notFound.code).toBe(1);
      expect(JSON.parse(notFound.stdout)).toMatchObject({ outcome: 'not-found', orchestratorId: ORCH_ID });

      // The poll-record save conflicts twice (saves 3 and 4); registration, heartbeat and retire save normally.
      let saves = 0;
      const fresh = new OrchestratorSessionRepositoryAdapter({ stateDir: join(stateDir, 'conflict') });
      const conflicting = {
        list: fresh.list.bind(fresh),
        get: fresh.get.bind(fresh),
        save: async (record: OrchestratorSessionRecord, expected: number) => {
          saves += 1;
          if (saves === 3 || saves === 4) {
            throw new OrchestratorSessionRevisionConflictError(record.orchestratorId, expected + 1, 'conflict');
          }
          return fresh.save(record, expected);
        },
      };
      saves = 0;
      const conflicted = await run(
        ['attach', '--kind', 'agy', '--once'],
        runtimeWith({ orchestratorSessionRepository: conflicting, orchestratorRequestRepository: requests }),
      );
      expect(conflicted.code).toBe(1);
      expect(JSON.parse(conflicted.stdout)).toMatchObject({ outcome: 'refused', orchestratorId: ORCH_ID });
      expect(saves).toBe(5);
      expect((await fresh.get(ORCH_ID))?.session.status).toBe('retired');
    });
  });

  describe('session snapshots', () => {
    it('createSnapshottingSessionRepo passes store errors through unchanged and refuses unreadable entries', async () => {
      const conflict = new OrchestratorSessionRevisionConflictError(ORCH_ID, 2, 'conflict');
      const repo = createSnapshottingSessionRepo({
        get: async () => null,
        list: async () => [],
        save: async () => Promise.reject(conflict),
      });
      await expect(repo.save(sessionRecord(), 1)).rejects.toBe(conflict);
      await expect(repo.get(ORCH_ID)).resolves.toBeNull();
      const unreadable = createSnapshottingSessionRepo({
        get: async () => ({ session: sessionRecord(), revision: 0 }),
        list: async () => 'not-a-list' as never,
        save: async () => ({ session: sessionRecord(), revision: 1 }),
      });
      await expect(unreadable.get(ORCH_ID)).rejects.toBeInstanceOf(InvalidStoreDataError);
      await expect(unreadable.list()).rejects.toBeInstanceOf(InvalidStoreDataError);
      await expect(unreadable.registerOrAdoptSession({} as never, NOW)).resolves.toMatchObject({ outcome: 'refused' });
    });
  });
});
