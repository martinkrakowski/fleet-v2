import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type {
  RunnerIsolationCapabilities,
  StartRunnerSessionRequest,
} from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import {
  SandboxRunnerAdapter,
  type SandboxCreatePayload,
  type SandboxCreateResult,
  type SandboxDestroyResult,
  type SandboxDriver,
  type SandboxInspectResult,
} from '../SandboxRunnerAdapter.adapter.js';

/**
 * Lane FC8A: the sandbox adapter runs against an in-memory fake driver that
 * records every call. Nothing here spawns, opens a socket or reads a file
 * except the single source-text check on the adapter's own file.
 */

const DECLARED_CAPS: RunnerIsolationCapabilities = {
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
  source: 'declared',
};

const SESSION_ID = 'sess-1';
const ATTEMPT_ID = 'attempt-1';
const ENDED_AT = new Date(0).toISOString();

const INSPECTED: SandboxInspectResult = {
  runnerReachable: 'reachable',
  workspacePreparation: 'prepared',
  workerCommand: 'active',
  completionReceipt: {
    attemptId: ATTEMPT_ID,
    sessionId: SESSION_ID,
    endedAtIso: ENDED_AT,
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  },
  artifactsCollected: true,
};

class FakeDriver implements SandboxDriver {
  readonly createCalls: SandboxCreatePayload[] = [];
  readonly inspectCalls: string[] = [];
  readonly destroyCalls: string[] = [];

  createResult: SandboxCreateResult | Error = { outcome: 'confirmed', sessionId: SESSION_ID };
  inspectResult: SandboxInspectResult | Error = INSPECTED;
  destroyResult: SandboxDestroyResult | Error = { outcome: 'destroyed' };
  /**
   * When set, the next create awaits it and then clears it. Only that call
   * waits, so a missed reservation cannot hang the test.
   */
  createHold: Promise<void> | null = null;
  /** Returned as-is, before `instanceof`, so a Proxy is not probed by the fake. */
  rawCreateResult: { readonly value: unknown } | null = null;
  rawInspectResult: { readonly value: unknown } | null = null;
  rawDestroyResult: { readonly value: unknown } | null = null;
  /** When true, create never settles. Only the adapter's deadline can finish the call. */
  neverSettleCreate = false;
  neverSettleDestroy = false;
  /** Returned as the create/destroy promise so a test can settle it after the deadline. */
  holdCreate: Promise<SandboxCreateResult> | null = null;
  holdDestroy: Promise<SandboxDestroyResult> | null = null;

  async create(payload: SandboxCreatePayload): Promise<SandboxCreateResult> {
    this.createCalls.push(payload);
    const hold = this.createHold;
    if (hold !== null) {
      this.createHold = null;
      await hold;
    }
    if (this.neverSettleCreate) {
      return new Promise<SandboxCreateResult>(() => {});
    }
    if (this.holdCreate !== null) {
      const pending = this.holdCreate;
      this.holdCreate = null;
      return pending;
    }
    if (this.rawCreateResult !== null) {
      return this.rawCreateResult.value as SandboxCreateResult;
    }
    if (this.createResult instanceof Error) {
      throw this.createResult;
    }
    return this.createResult;
  }

  async inspect(sessionId: string): Promise<SandboxInspectResult> {
    this.inspectCalls.push(sessionId);
    if (this.rawInspectResult !== null) {
      return this.rawInspectResult.value as SandboxInspectResult;
    }
    if (this.inspectResult instanceof Error) {
      throw this.inspectResult;
    }
    return this.inspectResult;
  }

  async destroy(sessionId: string): Promise<SandboxDestroyResult> {
    this.destroyCalls.push(sessionId);
    if (this.neverSettleDestroy) {
      return new Promise<SandboxDestroyResult>(() => {});
    }
    if (this.holdDestroy !== null) {
      const pending = this.holdDestroy;
      this.holdDestroy = null;
      return pending;
    }
    if (this.rawDestroyResult !== null) {
      return this.rawDestroyResult.value as SandboxDestroyResult;
    }
    if (this.destroyResult instanceof Error) {
      throw this.destroyResult;
    }
    return this.destroyResult;
  }
}

function makeAdapter(
  overrides?: Partial<ConstructorParameters<typeof SandboxRunnerAdapter>[0]>,
): { adapter: SandboxRunnerAdapter; driver: FakeDriver } {
  const driver = new FakeDriver();
  const adapter = new SandboxRunnerAdapter({
    driver,
    capabilities: DECLARED_CAPS,
    now: () => new Date(0),
    ...overrides,
  });
  return { adapter, driver };
}

function startRequest(
  overrides: Partial<StartRunnerSessionRequest> = {},
): StartRunnerSessionRequest {
  return {
    attemptId: ATTEMPT_ID,
    worktreePath: '/worktrees/attempt-1',
    briefPackagePath: '/briefs/attempt-1.json',
    baseCommit: 'c0ffee0',
    stepLimit: 100,
    timeLimitSeconds: 600,
    requiredCapabilities: { ...DECLARED_CAPS },
    model: 'seat-model-1',
    agent: 'build-agent',
    variant: 'variant-1',
    ...overrides,
  };
}

/** The happy path every refusal test must see first (correction 7). */
async function expectStarted(adapter: SandboxRunnerAdapter): Promise<void> {
  const result = await adapter.startSession(startRequest());
  expect(result.outcome).toBe('started');
}

/** A request copy where `key` is an own getter: the flag records any read. */
function withGetter(
  base: StartRunnerSessionRequest,
  key: string,
  flag: { read: boolean },
): StartRunnerSessionRequest {
  const copy: Record<string, unknown> = { ...base };
  const value = copy[key];
  delete copy[key];
  Object.defineProperty(copy, key, {
    get: () => {
      flag.read = true;
      return value;
    },
    enumerable: true,
  });
  return copy as unknown as StartRunnerSessionRequest;
}

/** Own data on a custom prototype, plus one inherited getter the adapter must not run. */
function withInheritedGetter(
  fields: Record<string, unknown>,
  inheritedKey: string,
  flag: { read: boolean },
): Record<string, unknown> {
  const proto = {};
  Object.defineProperty(proto, inheritedKey, {
    enumerable: true,
    configurable: true,
    get() {
      flag.read = true;
      return 'inherited-' + 'value';
    },
  });
  const record = Object.create(proto) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

/** Property names a Promise reads while adopting a returned Proxy. */
function unexpectedTraps(seen: readonly string[]): string[] {
  return seen.filter((name) => name !== 'then' && !name.startsWith('Symbol('));
}

describe('SandboxRunnerAdapter', () => {
  describe('describeCapabilities', () => {
    it('returns source declared and the driver-declared booleans without calling driver.create', () => {
      const { adapter, driver } = makeAdapter({
        capabilities: { ...DECLARED_CAPS, networkEgressRestricted: false },
      });
      const capabilities = adapter.describeCapabilities();
      expect(capabilities.source).toBe('declared');
      expect(capabilities.networkEgressRestricted).toBe(false);
      expect(capabilities.filesystemScope).toBe('scoped-worktree');
      expect(capabilities.processTreeTermination).toBe(true);
      expect(driver.createCalls).toHaveLength(0);
    });

    it('reports an invalid driver filesystemScope as unknown with source undeclared', () => {
      const { adapter } = makeAdapter({
        capabilities: {
          ...DECLARED_CAPS,
          filesystemScope: 'not-a-scope' as RunnerIsolationCapabilities['filesystemScope'],
        },
      });
      const capabilities = adapter.describeCapabilities();
      expect(capabilities.filesystemScope).toBe('unknown');
      expect(capabilities.source).toBe('undeclared');
    });

    it('turns a non-boolean declared capability into false instead of trusting it', () => {
      const { adapter } = makeAdapter({
        capabilities: {
          ...DECLARED_CAPS,
          artifactPersistence: 'yes' as unknown as boolean,
        },
      });
      expect(adapter.describeCapabilities().artifactPersistence).toBe(false);
    });
  });

  describe('startSession', () => {
    it('starts a confirmed driver result with a sessionId and no runner field, calling create once', async () => {
      const { adapter, driver } = makeAdapter();
      const result = await adapter.startSession(startRequest());
      expect(result).toStrictEqual({ outcome: 'started', sessionId: SESSION_ID });
      expect(driver.createCalls).toHaveLength(1);
      expect('runner' in result).toBe(false);
    });

    it('passes the exact nine-key payload to driver.create', async () => {
      const { adapter, driver } = makeAdapter();
      await adapter.startSession(startRequest());
      expect(driver.createCalls[0]).toStrictEqual({
        attemptId: ATTEMPT_ID,
        worktreePath: '/worktrees/attempt-1',
        briefPackagePath: '/briefs/attempt-1.json',
        baseCommit: 'c0ffee0',
        stepLimit: 100,
        timeLimitSeconds: 600,
        model: 'seat-model-1',
        agent: 'build-agent',
        variant: 'variant-1',
      });
    });

    it('omits absent agent and variant keys from the payload instead of setting undefined', async () => {
      const { adapter, driver } = makeAdapter();
      const request = startRequest();
      const rest = {
        ...request,
        agent: undefined,
        variant: undefined,
      };
      delete (rest as { agent?: unknown }).agent;
      delete (rest as { variant?: unknown }).variant;
      await adapter.startSession(rest as StartRunnerSessionRequest);
      expect(driver.createCalls[0]).toStrictEqual({
        attemptId: ATTEMPT_ID,
        worktreePath: '/worktrees/attempt-1',
        briefPackagePath: '/briefs/attempt-1.json',
        baseCommit: 'c0ffee0',
        stepLimit: 100,
        timeLimitSeconds: 600,
        model: 'seat-model-1',
      });
    });

    it('resolves the seat as seatOverride over request over modelAssignment', async () => {
      const { adapter, driver } = makeAdapter();
      await adapter.startSession(
        startRequest({
          model: 'request-model-1',
          modelAssignment: { model: 'assignment-model-1' },
          seatOverride: {
            model: 'override-model-1',
            reason: 'operator request',
            setBy: 'operator',
            expiresAtIso: ENDED_AT,
          },
        }),
      );
      expect(driver.createCalls[0]?.model).toBe('override-model-1');
    });

    it('blocks a second startSession for an attempt with a live environment without calling create again', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('returns refused when driver create reports an error and records no live environment', async () => {
      const { adapter, driver } = makeAdapter();
      driver.createResult = { outcome: 'refused' };
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('refused');
      expect(driver.createCalls).toHaveLength(1);
      expect(String((result as { reason?: string }).reason ?? '').includes(SESSION_ID)).toBe(
        false,
      );
      driver.createResult = { outcome: 'confirmed', sessionId: SESSION_ID };
      const retried = await adapter.startSession(startRequest());
      expect(retried.outcome).toBe('started');
      expect(driver.createCalls).toHaveLength(2);
    });

    it('returns unknown without retrying when driver create is unconfirmed, then blocks the next start', async () => {
      const { adapter, driver } = makeAdapter();
      driver.createResult = { outcome: 'unconfirmed' };
      const first = await adapter.startSession(startRequest());
      expect(first.outcome).toBe('unknown');
      expect(driver.createCalls).toHaveLength(1);
      const second = await adapter.startSession(startRequest());
      expect(second.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('returns unknown when driver create throws, then blocks the next start', async () => {
      const { adapter, driver } = makeAdapter();
      driver.createResult = new Error('driver exploded with ' + SESSION_ID);
      const first = await adapter.startSession(startRequest());
      expect(first.outcome).toBe('unknown');
      expect(
        String((first as { reason?: string }).reason ?? '').includes(SESSION_ID),
      ).toBe(false);
      const second = await adapter.startSession(startRequest());
      expect(second.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('returns unknown when a confirmed driver result carries an unusable sessionId', async () => {
      const { adapter, driver } = makeAdapter();
      driver.createResult = { outcome: 'confirmed', sessionId: 'x'.repeat(129) };
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('unknown');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses startSession before calling driver when requiredCapabilities are not satisfied', async () => {
      const { adapter, driver } = makeAdapter({
        capabilities: { ...DECLARED_CAPS, networkEgressRestricted: false },
      });
      const satisfied = await adapter.startSession(
        startRequest({
          requiredCapabilities: { ...DECLARED_CAPS, networkEgressRestricted: false },
        }),
      );
      expect(satisfied.outcome).toBe('started');
      const before = driver.createCalls.length;
      const result = await adapter.startSession(
        startRequest({
          requiredCapabilities: { ...DECLARED_CAPS, networkEgressRestricted: true },
        }),
      );
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(driver.createCalls).toHaveLength(before);
    });

    it('refuses startSession when the adapter filesystemScope differs from the required one', async () => {
      const { adapter, driver } = makeAdapter({
        capabilities: { ...DECLARED_CAPS, filesystemScope: 'inherited-directory' },
      });
      const satisfied = await adapter.startSession(
        startRequest({
          requiredCapabilities: { ...DECLARED_CAPS, filesystemScope: 'inherited-directory' },
        }),
      );
      expect(satisfied.outcome).toBe('started');
      const before = driver.createCalls.length;
      const result = await adapter.startSession(
        startRequest({
          requiredCapabilities: { ...DECLARED_CAPS, filesystemScope: 'scoped-worktree' },
        }),
      );
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(driver.createCalls).toHaveLength(before);
    });

    it('always refuses when the adapter filesystemScope is unknown', async () => {
      const { adapter, driver } = makeAdapter({
        capabilities: {
          ...DECLARED_CAPS,
          filesystemScope: 'garbage' as RunnerIsolationCapabilities['filesystemScope'],
        },
      });
      const result = await adapter.startSession(
        startRequest({
          requiredCapabilities: { ...DECLARED_CAPS, filesystemScope: 'unknown' },
        }),
      );
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(driver.createCalls).toHaveLength(0);
    });
  });

  describe('stopSession', () => {
    it('terminates a confirmed destroy with an authoritative receipt stamped by the injected clock', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const result = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(result).toStrictEqual({
        outcome: 'terminated',
        receipt: {
          attemptId: ATTEMPT_ID,
          sessionId: SESSION_ID,
          endedAtIso: ENDED_AT,
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: true,
        },
      });
      expect(driver.destroyCalls).toStrictEqual([SESSION_ID]);
    });

    it('refuses stopSession for an unknown session without calling driver.destroy', async () => {
      // Control: the same stop on a started session terminates, so a constant `refused` fails this test.
      const control = makeAdapter();
      await expectStarted(control.adapter);
      const clean = await control.adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(clean.outcome).toBe('terminated');
      const { adapter, driver } = makeAdapter();
      const result = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(driver.destroyCalls).toHaveLength(0);
    });

    it('refuses a double stopSession without a second destroy call and without throwing', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const first = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(first.outcome).toBe('terminated');
      const second = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(second).toMatchObject({ outcome: 'refused' });
      expect(driver.destroyCalls).toHaveLength(1);
    });

    it('returns still-running when driver destroy reports the environment still present and destroys again on the next stop', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      driver.destroyResult = { outcome: 'still-present' };
      const first = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(first).toMatchObject({ outcome: 'still-running' });
      driver.destroyResult = { outcome: 'destroyed' };
      const second = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(second.outcome).toBe('terminated');
      expect(driver.destroyCalls).toHaveLength(2);
    });

    it('refuses an overlapping stop while a destroy is in flight and lets a later stop retry', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      driver.destroyResult = { outcome: 'still-present' };
      const stop = { attemptId: ATTEMPT_ID, sessionId: SESSION_ID, gracePeriodSeconds: 5 };
      const [first, second] = await Promise.all([adapter.stopSession(stop), adapter.stopSession(stop)]);
      expect(first.outcome).toBe('still-running');
      expect(second).toMatchObject({ outcome: 'refused' });
      expect(driver.destroyCalls).toHaveLength(1);
      // The reservation is released: a later stop calls destroy again and can terminate.
      driver.destroyResult = { outcome: 'destroyed' };
      const third = await adapter.stopSession(stop);
      expect(third.outcome).toBe('terminated');
      expect(driver.destroyCalls).toHaveLength(2);
    });

    it('returns unknown when driver destroy is unconfirmed and destroys again on the next stop', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      driver.destroyResult = { outcome: 'unconfirmed' };
      const first = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(first).toMatchObject({ outcome: 'unknown' });
      driver.destroyResult = { outcome: 'destroyed' };
      const second = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(second.outcome).toBe('terminated');
      expect(driver.destroyCalls).toHaveLength(2);
    });
  });

  describe('inspectSession with an unreachable runner', () => {
    it('replaces every other claim with the safe defaults when the driver reports the runner unreachable', async () => {
      // Control: the same claims with a reachable runner pass through.
      const control = makeAdapter();
      await expectStarted(control.adapter);
      const reachable = await control.adapter.inspectSession({ attemptId: ATTEMPT_ID, sessionId: SESSION_ID });
      expect(reachable.runnerReachable).toBe('reachable');
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      driver.inspectResult = {
        runnerReachable: 'unreachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: null,
        artifactsCollected: true,
      };
      const status = await adapter.inspectSession({ attemptId: ATTEMPT_ID, sessionId: SESSION_ID });
      expect(status.runnerReachable).toBe('unreachable');
      expect(status.artifactsCollected).toBe(false);
      expect(status.completionReceipt).toBeNull();
      expect(status.workerCommand).not.toBe('ended');
    });
  });

  describe('inspectSession', () => {
    it('reports all five RunnerSessionStatus fields separately', async () => {
      const { adapter, driver } = makeAdapter();
      const status = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(status.runnerReachable).toBe('reachable');
      expect(status.workspacePreparation).toBe('prepared');
      expect(status.workerCommand).toBe('active');
      expect(status.completionReceipt).toStrictEqual(INSPECTED.completionReceipt);
      expect(status.artifactsCollected).toBe(true);
      expect(driver.inspectCalls).toStrictEqual([SESSION_ID]);
    });

    it('reports a completionReceipt bound to another attempt or session as null', async () => {
      const { adapter: attemptBound, driver: attemptDriver } = makeAdapter();
      attemptDriver.inspectResult = {
        ...INSPECTED,
        completionReceipt: { ...INSPECTED.completionReceipt!, attemptId: 'attempt-2' },
      };
      const mismatchedAttempt = await attemptBound.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(mismatchedAttempt.completionReceipt).toBeNull();
      expect(mismatchedAttempt.workspacePreparation).toBe('prepared');

      const { adapter: sessionBound, driver: sessionDriver } = makeAdapter();
      sessionDriver.inspectResult = {
        ...INSPECTED,
        completionReceipt: { ...INSPECTED.completionReceipt!, sessionId: 'sess-2' },
      };
      const mismatchedSession = await sessionBound.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(mismatchedSession.completionReceipt).toBeNull();
    });

    it('reports runnerReachable unreachable without throwing when driver inspect fails', async () => {
      const { adapter, driver } = makeAdapter();
      driver.inspectResult = new Error('driver went away');
      const status = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(status).toStrictEqual({
        runnerReachable: 'unreachable',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      });
    });

    it('reports unreachable with safe defaults when the driver inspect result is malformed', async () => {
      const { adapter, driver } = makeAdapter();
      driver.inspectResult = {
        runnerReachable: 'reachable',
        workspacePreparation: 'not-a-state',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: true,
      } as unknown as SandboxInspectResult;
      const status = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(status.runnerReachable).toBe('unreachable');
      expect(status.workspacePreparation).toBe('unprepared');
      expect(status.completionReceipt).toBeNull();
    });
  });

  describe('hostile inputs', () => {
    const hostileBodies: [string, unknown][] = [
      ['null', null],
      ['undefined', undefined],
      ['a string primitive', 'attempt-1'],
      ['a number primitive', 7],
      ['an array', [startRequest()]],
      ['an array-like object', { ...startRequest(), length: 3 }],
    ];

    for (const [name, value] of hostileBodies) {
      it(`refuses ${name} as a start request with zero driver calls`, async () => {
        const { adapter, driver } = makeAdapter();
        await expectStarted(adapter);
        const before = driver.createCalls.length;
        const result = await adapter.startSession(value as StartRunnerSessionRequest);
        expect(result).toMatchObject({ outcome: 'refused' });
        expect(driver.createCalls).toHaveLength(before);
      });
    }

    it('refuses a Proxy start request with zero driver calls', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const result = await adapter.startSession(
        new Proxy(startRequest(), {}) as StartRunnerSessionRequest,
      );
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses a start request with a getter without invoking the getter or the driver', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const seen = { read: false };
      const request = withGetter(startRequest(), 'model', seen);
      const result = await adapter.startSession(request);
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(seen.read).toBe(false);
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses a nested getter on requiredCapabilities without invoking the getter or the driver', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const seen = { read: false };
      const request = startRequest();
      const capabilities: Record<string, unknown> = { ...request.requiredCapabilities };
      const value = capabilities.networkEgressRestricted;
      delete capabilities.networkEgressRestricted;
      Object.defineProperty(capabilities, 'networkEgressRestricted', {
        get: () => {
          seen.read = true;
          return value;
        },
        enumerable: true,
      });
      const result = await adapter.startSession({
        ...request,
        requiredCapabilities: capabilities,
      } as unknown as StartRunnerSessionRequest);
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(seen.read).toBe(false);
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses start request keys outside the port contract with zero driver calls', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const request = { ...startRequest(), smuggledKey: 'value' } as unknown as StartRunnerSessionRequest;
      const result = await adapter.startSession(request);
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses prototype-polluting start request keys with zero driver calls', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const request = startRequest() as unknown as Record<string, unknown>;
        Object.defineProperty(request, key, { value: {}, enumerable: true });
        const result = await adapter.startSession(request as unknown as StartRunnerSessionRequest);
        expect(result).toMatchObject({ outcome: 'refused' });
      }
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses traversal, absolute-path escape, NUL, newline and oversized inputs without echoing 8+ char values', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const before = driver.createCalls.length;
      const oversized = 'w'.repeat(4097);
      const hostilePaths: [string, string][] = [
        ['a .. path segment', '/worktrees/' + 'x' + '/../../etc'],
        ['an absolute-path escape on attemptId', '/' + 'etc' + '/' + 'passwd'],
        ['a NUL byte in the worktree path', '/worktrees/attempt-1\u0000'],
        ['a newline in the brief path', '/briefs/attempt-1\n.json'],
        ['a carriage return in baseCommit', 'c0ffee0\r'],
        ['an oversized worktree path', '/' + oversized],
      ];
      for (const [name, value] of hostilePaths) {
        const overrides: Partial<StartRunnerSessionRequest> =
          name === 'an absolute-path escape on attemptId'
            ? { attemptId: value }
            : name === 'a NUL byte in the worktree path'
              ? { worktreePath: value }
              : name === 'a newline in the brief path'
                ? { briefPackagePath: value }
                : name === 'a carriage return in baseCommit'
                  ? { baseCommit: value }
                  : { worktreePath: value };
        const result = await adapter.startSession(startRequest(overrides));
        expect(result, name).toMatchObject({ outcome: 'refused' });
        expect(String((result as { reason?: string }).reason ?? '').includes(value), name).toBe(
          false,
        );
      }
      expect(driver.createCalls).toHaveLength(before);
    });

    it('refuses invalid model, agent or variant values before calling driver', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const before = driver.createCalls.length;
      const longModel = 'm'.repeat(129);
      const flagModel = '-' + 'm'.repeat(20);
      const cases: [string, Partial<StartRunnerSessionRequest>][] = [
        ['a missing model', { model: undefined }],
        ['a whitespace model', { model: 'model with space' }],
        ['an oversized model', { model: longModel }],
        ['a flag-shaped model', { model: flagModel }],
        ['a flag-shaped agent', { agent: '-' + 'a'.repeat(5) }],
        ['a whitespace agent', { agent: 'agent two' }],
        ['an oversized variant', { variant: 'v'.repeat(129) }],
      ];
      for (const [name, overrides] of cases) {
        const result = await adapter.startSession(startRequest(overrides));
        expect(result, name).toMatchObject({ outcome: 'refused' });
        for (const value of [longModel, flagModel]) {
          expect(String((result as { reason?: string }).reason ?? '').includes(value), name).toBe(
            false,
          );
        }
      }
      expect(driver.createCalls).toHaveLength(before);
    });

    it('refuses non-positive or non-finite stepLimit and timeLimitSeconds', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const before = driver.createCalls.length;
      const badNumbers = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];
      for (const value of badNumbers) {
        const stepResult = await adapter.startSession(startRequest({ stepLimit: value }));
        expect(stepResult, `stepLimit ${value}`).toMatchObject({ outcome: 'refused' });
        const timeResult = await adapter.startSession(startRequest({ timeLimitSeconds: value }));
        expect(timeResult, `timeLimitSeconds ${value}`).toMatchObject({ outcome: 'refused' });
      }
      expect(driver.createCalls).toHaveLength(before);
    });

    it('refuses hostile stop requests without invoking getters or driver.destroy', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const before = driver.destroyCalls.length;
      const seen = { read: false };
      const getterStop: Record<string, unknown> = {
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      };
      const attemptValue = 'attempt-' + '1';
      Object.defineProperty(getterStop, 'attemptId', {
        get: () => {
          seen.read = true;
          return attemptValue;
        },
        enumerable: true,
      });
      const stopRequests: unknown[] = [
        null,
        undefined,
        'stop',
        ['stop'],
        new Proxy({ attemptId: ATTEMPT_ID, sessionId: SESSION_ID, gracePeriodSeconds: 5 }, {}),
        { attemptId: ATTEMPT_ID, sessionId: SESSION_ID, gracePeriodSeconds: -1 },
        { attemptId: ATTEMPT_ID, sessionId: SESSION_ID, gracePeriodSeconds: 5, smuggled: true },
        getterStop,
      ];
      for (const request of stopRequests) {
        const result = await adapter.stopSession(
          request as Parameters<SandboxRunnerAdapter['stopSession']>[0],
        );
        expect(result).toMatchObject({ outcome: 'refused' });
      }
      expect(seen.read).toBe(false);
      expect(driver.destroyCalls).toHaveLength(before);
    });

    it('reports unreachable with safe defaults for hostile inspect sessions without driver calls', async () => {
      // Control: a clean session ref on a started session is reachable, so a constant `unreachable` fails this test.
      const control = makeAdapter();
      await expectStarted(control.adapter);
      const cleanStatus = await control.adapter.inspectSession({ attemptId: ATTEMPT_ID, sessionId: SESSION_ID });
      expect(cleanStatus.runnerReachable).toBe('reachable');
      const { adapter, driver } = makeAdapter();
      const seen = { read: false };
      const sessions: unknown[] = [
        null,
        undefined,
        'session',
        ['session'],
        new Proxy({ attemptId: ATTEMPT_ID, sessionId: SESSION_ID }, {}),
        { ...{ attemptId: ATTEMPT_ID, sessionId: SESSION_ID }, length: 2 },
        { attemptId: ATTEMPT_ID, sessionId: SESSION_ID, smuggled: true },
      ];
      const getterSession: Record<string, unknown> = {
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      };
      const sessionValue = getterSession['sessionId'];
      delete getterSession['sessionId'];
      Object.defineProperty(getterSession, 'sessionId', {
        get: () => {
          seen.read = true;
          return sessionValue;
        },
        enumerable: true,
      });
      sessions.push(getterSession);
      for (const session of sessions) {
        const status = await adapter.inspectSession(
          session as Parameters<SandboxRunnerAdapter['inspectSession']>[0],
        );
        expect(status).toStrictEqual({
          runnerReachable: 'unreachable',
          workspacePreparation: 'unprepared',
          workerCommand: 'not-started',
          completionReceipt: null,
          artifactsCollected: false,
        });
      }
      expect(seen.read).toBe(false);
      expect(driver.inspectCalls).toHaveLength(0);
    });
  });

  describe('source constraints', () => {
    const SOURCE = readFileSync(
      fileURLToPath(new URL('../SandboxRunnerAdapter.adapter.ts', import.meta.url)),
      'utf8',
    );

    it('declares no process.env, no node built-ins and no fetch in the adapter source', () => {
      for (const forbidden of [
        'process.env',
        'node:fs',
        'node:child_process',
        'node:net',
        'node:http',
        'fetch(',
      ]) {
        expect(SOURCE.includes(forbidden), forbidden).toBe(false);
      }
    });
  });

  describe('guarded results and concurrent starts', () => {
    it('fail-closes a capability getter or Proxy without invoking it, while a plain profile stays declared', () => {
      const plain = makeAdapter();
      expect(plain.adapter.describeCapabilities().source).toBe('declared');
      expect(plain.adapter.describeCapabilities().networkEgressRestricted).toBe(true);

      const flag = { read: false };
      const capabilities: Record<string, unknown> = { ...DECLARED_CAPS };
      Object.defineProperty(capabilities, 'networkEgressRestricted', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return true;
        },
      });
      const getterAdapter = makeAdapter({
        capabilities: capabilities as unknown as RunnerIsolationCapabilities,
      });
      const getterProfile = getterAdapter.adapter.describeCapabilities();
      expect(flag.read).toBe(false);
      expect(getterProfile).toStrictEqual({
        filesystemScope: 'unknown',
        networkEgressRestricted: false,
        cpuAndMemoryLimited: false,
        processTreeTermination: false,
        authoritativeCompletion: false,
        artifactPersistence: false,
        source: 'undeclared',
      });

      const seen: string[] = [];
      const proxy = new Proxy(DECLARED_CAPS, {
        get(_target, property) {
          seen.push(String(property));
          return true;
        },
      });
      const proxyAdapter = makeAdapter({
        capabilities: proxy as RunnerIsolationCapabilities,
      });
      const proxyProfile = proxyAdapter.adapter.describeCapabilities();
      expect(unexpectedTraps(seen)).toEqual([]);
      expect(proxyProfile.filesystemScope).toBe('unknown');
      expect(proxyProfile.source).toBe('undeclared');
    });

    it('refuses startSession when the capability profile is a Proxy and does not call create', async () => {
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      expect(clean.driver.createCalls).toHaveLength(1);

      const seen: string[] = [];
      const { adapter, driver } = makeAdapter({
        capabilities: new Proxy(DECLARED_CAPS, {
          get(_target, property) {
            seen.push(String(property));
            return true;
          },
        }) as RunnerIsolationCapabilities,
      });
      const result = await adapter.startSession(startRequest());
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(unexpectedTraps(seen)).toEqual([]);
      expect(driver.createCalls).toHaveLength(0);
    });

    it('keeps a runtime-built token-shaped value out of the driver.create payload', async () => {
      const credentialShape = ['tok', 'en', 'Q'.repeat(10)].join('-');
      const clean = makeAdapter();
      const cleanResult = await clean.adapter.startSession(startRequest());
      expect(cleanResult.outcome).toBe('started');
      expect(clean.driver.createCalls).toHaveLength(1);
      expect(JSON.stringify(clean.driver.createCalls[0]).includes(credentialShape)).toBe(false);

      const { adapter, driver } = makeAdapter();
      const result = await adapter.startSession(
        startRequest({
          seatOverride: {
            model: 'override-model-1',
            reason: credentialShape,
            setBy: 'operator',
            expiresAtIso: ENDED_AT,
          },
          modelAssignment: {
            model: 'assignment-model-1',
            fallbackModel: credentialShape,
          },
        }),
      );
      expect(result.outcome).toBe('started');
      expect(driver.createCalls).toHaveLength(1);
      expect(driver.createCalls[0]).toStrictEqual({
        attemptId: ATTEMPT_ID,
        worktreePath: '/worktrees/attempt-1',
        briefPackagePath: '/briefs/attempt-1.json',
        baseCommit: 'c0ffee0',
        stepLimit: 100,
        timeLimitSeconds: 600,
        model: 'override-model-1',
        agent: 'build-agent',
        variant: 'variant-1',
      });
      expect(JSON.stringify(driver.createCalls[0]).includes(credentialShape)).toBe(false);
    });

    it('reserves the attempt before awaiting create so a concurrent startSession is blocked with one create call', async () => {
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      expect(clean.driver.createCalls).toHaveLength(1);

      const { adapter, driver } = makeAdapter();
      let release: () => void = () => {};
      driver.createHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = adapter.startSession(startRequest());
      const second = adapter.startSession(startRequest());
      const secondResult = await second;
      expect(secondResult.outcome).toBe('blocked');
      expect('runner' in secondResult).toBe(false);
      if (secondResult.outcome === 'blocked') {
        expect(secondResult.reason.includes(ATTEMPT_ID)).toBe(false);
      }
      expect(driver.createCalls).toHaveLength(1);
      release();
      const firstResult = await first;
      expect(firstResult).toStrictEqual({ outcome: 'started', sessionId: SESSION_ID });
      expect(driver.createCalls).toHaveLength(1);
    });

    it('maps a Proxy create result to unknown without reading outcome and blocks the next start', async () => {
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      const seen: string[] = [];
      const { adapter, driver } = makeAdapter();
      driver.rawCreateResult = {
        value: new Proxy(
          { outcome: 'confirmed', sessionId: SESSION_ID },
          {
            get(_target, property) {
              seen.push(String(property));
              return undefined;
            },
          },
        ),
      };
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('unknown');
      expect(unexpectedTraps(seen)).toEqual([]);
      const next = await adapter.startSession(startRequest());
      expect(next.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('maps a create result whose outcome is a getter to unknown without invoking the getter', async () => {
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      const flag = { read: false };
      const value: Record<string, unknown> = { sessionId: SESSION_ID };
      Object.defineProperty(value, 'outcome', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return 'confirmed';
        },
      });
      const { adapter, driver } = makeAdapter();
      driver.rawCreateResult = { value };
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('unknown');
      expect(flag.read).toBe(false);
      const next = await adapter.startSession(startRequest());
      expect(next.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('maps a create result with a custom prototype to unknown without invoking an inherited getter', async () => {
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      const flag = { read: false };
      const { adapter, driver } = makeAdapter();
      driver.rawCreateResult = {
        value: withInheritedGetter(
          { outcome: 'confirmed', sessionId: SESSION_ID },
          'detail',
          flag,
        ),
      };
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('unknown');
      expect(flag.read).toBe(false);
      const next = await adapter.startSession(startRequest());
      expect(next.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('maps a create result with an extra field to unknown and does not forward that field', async () => {
      const credentialShape = ['drv', 'text', 'M'.repeat(8)].join('-');
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      const { adapter, driver } = makeAdapter();
      driver.rawCreateResult = {
        value: { outcome: 'refused', detail: credentialShape },
      };
      const result = await adapter.startSession(startRequest());
      expect(result.outcome).toBe('unknown');
      if (result.outcome === 'unknown' || result.outcome === 'refused' || result.outcome === 'blocked') {
        expect(result.reason.includes(credentialShape)).toBe(false);
      }
      const next = await adapter.startSession(startRequest());
      expect(next.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses a start request whose prototype is not Object.prototype without invoking an inherited getter', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const flag = { read: false };
      const request = withInheritedGetter(
        { ...startRequest() } as unknown as Record<string, unknown>,
        'inheritedField',
        flag,
      );
      const result = await adapter.startSession(request as unknown as StartRunnerSessionRequest);
      expect(result).toMatchObject({ outcome: 'refused' });
      expect(flag.read).toBe(false);
      expect(driver.createCalls).toHaveLength(1);
    });

    it('starts a null-prototype request whose fields are own data properties', async () => {
      const { adapter, driver } = makeAdapter();
      const request = Object.create(null) as Record<string, unknown>;
      for (const [key, value] of Object.entries({ ...startRequest() })) {
        Object.defineProperty(request, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const result = await adapter.startSession(request as unknown as StartRunnerSessionRequest);
      expect(result).toStrictEqual({ outcome: 'started', sessionId: SESSION_ID });
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses getters on seatOverride.model and modelAssignment.model without invoking them or calling create', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const seatFlag = { read: false };
      const assignmentFlag = { read: false };
      const seat: Record<string, unknown> = {
        reason: 'operator request',
        setBy: 'operator',
        expiresAtIso: ENDED_AT,
      };
      Object.defineProperty(seat, 'model', {
        enumerable: true,
        configurable: true,
        get() {
          seatFlag.read = true;
          return 'override-model-1';
        },
      });
      const assignment: Record<string, unknown> = {};
      Object.defineProperty(assignment, 'model', {
        enumerable: true,
        configurable: true,
        get() {
          assignmentFlag.read = true;
          return 'assignment-model-1';
        },
      });
      const seatResult = await adapter.startSession(
        startRequest({
          seatOverride: seat as unknown as StartRunnerSessionRequest['seatOverride'],
        }),
      );
      expect(seatResult).toMatchObject({ outcome: 'refused' });
      expect(seatFlag.read).toBe(false);
      const assignmentResult = await adapter.startSession(
        startRequest({
          modelAssignment: assignment as unknown as StartRunnerSessionRequest['modelAssignment'],
        }),
      );
      expect(assignmentResult).toMatchObject({ outcome: 'refused' });
      expect(assignmentFlag.read).toBe(false);
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses prototype-polluting keys on nested requiredCapabilities and seatOverride without calling create', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      for (const key of ['__proto__', 'constructor', 'prototype'] as const) {
        const capabilities = { ...DECLARED_CAPS } as Record<string, unknown>;
        Object.defineProperty(capabilities, key, {
          value: {},
          enumerable: true,
          configurable: true,
        });
        const result = await adapter.startSession(
          startRequest({
            requiredCapabilities: capabilities as unknown as StartRunnerSessionRequest['requiredCapabilities'],
          }),
        );
        expect(result, key).toMatchObject({ outcome: 'refused' });
      }
      const seat = {
        model: 'override-model-1',
        reason: 'operator request',
        setBy: 'operator',
        expiresAtIso: ENDED_AT,
      } as Record<string, unknown>;
      Object.defineProperty(seat, 'constructor', {
        value: {},
        enumerable: true,
        configurable: true,
      });
      const seatResult = await adapter.startSession(
        startRequest({
          seatOverride: seat as unknown as StartRunnerSessionRequest['seatOverride'],
        }),
      );
      expect(seatResult).toMatchObject({ outcome: 'refused' });
      expect(driver.createCalls).toHaveLength(1);
    });

    it('refuses stopSession for an indeterminate attempt and never calls destroy with the caller sessionId', async () => {
      const clean = makeAdapter();
      await expectStarted(clean.adapter);
      const terminated = await clean.adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(terminated.outcome).toBe('terminated');
      expect(clean.driver.destroyCalls).toStrictEqual([SESSION_ID]);

      const callerSessionId = 'caller-' + 'session';
      const { adapter, driver } = makeAdapter();
      driver.createResult = { outcome: 'unconfirmed' };
      const started = await adapter.startSession(startRequest());
      expect(started.outcome).toBe('unknown');
      const stopped = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: callerSessionId,
        gracePeriodSeconds: 5,
      });
      expect(stopped).toMatchObject({ outcome: 'refused' });
      expect(driver.destroyCalls).toStrictEqual([]);
      const again = await adapter.startSession(startRequest());
      expect(again.outcome).toBe('blocked');
      expect(driver.createCalls).toHaveLength(1);
    });

    it('maps a Proxy destroy result to unknown without reading outcome and terminates on a later plain destroy', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const seen: string[] = [];
      driver.rawDestroyResult = {
        value: new Proxy(
          { outcome: 'destroyed' },
          {
            get(_target, property) {
              seen.push(String(property));
              return undefined;
            },
          },
        ),
      };
      const first = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(first.outcome).toBe('unknown');
      expect(unexpectedTraps(seen)).toEqual([]);
      driver.rawDestroyResult = null;
      const second = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(second.outcome).toBe('terminated');
      expect(driver.destroyCalls).toStrictEqual([SESSION_ID, SESSION_ID]);
    });

    it('maps a destroy result whose outcome is a getter to unknown without invoking the getter', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const flag = { read: false };
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, 'outcome', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return 'destroyed';
        },
      });
      driver.rawDestroyResult = { value };
      const first = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(first.outcome).toBe('unknown');
      expect(flag.read).toBe(false);
      driver.rawDestroyResult = null;
      const second = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(second.outcome).toBe('terminated');
      expect(driver.destroyCalls).toHaveLength(2);
    });

    it('maps a destroy result with an extra field or a custom prototype to unknown and does not terminate', async () => {
      const extra = makeAdapter();
      await expectStarted(extra.adapter);
      extra.driver.rawDestroyResult = { value: { outcome: 'destroyed', extra: true } };
      const extraResult = await extra.adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(extraResult.outcome).toBe('unknown');
      extra.driver.rawDestroyResult = null;
      const extraTerminated = await extra.adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(extraTerminated.outcome).toBe('terminated');
      expect(extra.driver.destroyCalls).toHaveLength(2);

      const flag = { read: false };
      const custom = makeAdapter();
      await expectStarted(custom.adapter);
      custom.driver.rawDestroyResult = {
        value: withInheritedGetter({ outcome: 'destroyed' }, 'detail', flag),
      };
      const customResult = await custom.adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(customResult.outcome).toBe('unknown');
      expect(flag.read).toBe(false);
      custom.driver.rawDestroyResult = null;
      const customTerminated = await custom.adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(customTerminated.outcome).toBe('terminated');
    });

    it('reports a hostile completionReceipt as null without invoking its getter and keeps the other status fields', async () => {
      const { adapter, driver } = makeAdapter();
      const clean = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(clean.completionReceipt).toStrictEqual(INSPECTED.completionReceipt);
      expect(clean.workspacePreparation).toBe('prepared');

      const flag = { read: false };
      const receipt: Record<string, unknown> = {
        sessionId: SESSION_ID,
        endedAtIso: ENDED_AT,
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      };
      Object.defineProperty(receipt, 'attemptId', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return ATTEMPT_ID;
        },
      });
      driver.inspectResult = {
        ...INSPECTED,
        completionReceipt: receipt,
      } as unknown as SandboxInspectResult;
      const status = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(flag.read).toBe(false);
      expect(status.completionReceipt).toBeNull();
      expect(status.runnerReachable).toBe('reachable');
      expect(status.workspacePreparation).toBe('prepared');
      expect(status.workerCommand).toBe('active');
      expect(status.artifactsCollected).toBe(true);
    });

    it('reports unreachable when inspectSession runner has a nested getter and does not invoke it', async () => {
      const { adapter, driver } = makeAdapter();
      const clean = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(clean.runnerReachable).toBe('reachable');
      const flag = { read: false };
      const runner: Record<string, unknown> = {
        kind: 'agy',
        remotePort: null,
        host: null,
        agent: null,
        variant: null,
      };
      Object.defineProperty(runner, 'model', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return null;
        },
      });
      const status = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        runner: runner as never,
      });
      expect(status).toStrictEqual({
        runnerReachable: 'unreachable',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      });
      expect(flag.read).toBe(false);
      expect(driver.inspectCalls).toHaveLength(1);
    });

    it('refuses stopSession when runner has a nested getter without invoking it or calling destroy', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const flag = { read: false };
      const runner: Record<string, unknown> = {
        kind: 'agy',
        remotePort: null,
        host: null,
        agent: null,
        variant: null,
      };
      Object.defineProperty(runner, 'model', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return null;
        },
      });
      const refused = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
        runner: runner as never,
      });
      expect(refused).toMatchObject({ outcome: 'refused' });
      expect(flag.read).toBe(false);
      expect(driver.destroyCalls).toHaveLength(0);
      const terminated = await adapter.stopSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      });
      expect(terminated.outcome).toBe('terminated');
      expect(driver.destroyCalls).toStrictEqual([SESSION_ID]);
    });

    it('reports unreachable for a prototype-polluting inspect key and refuses that key on stop', async () => {
      const { adapter, driver } = makeAdapter();
      await expectStarted(adapter);
      const clean = await adapter.inspectSession({
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      });
      expect(clean.runnerReachable).toBe('reachable');
      const inspectBody: Record<string, unknown> = {
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
      };
      Object.defineProperty(inspectBody, 'prototype', {
        value: {},
        enumerable: true,
        configurable: true,
      });
      const status = await adapter.inspectSession(
        inspectBody as unknown as Parameters<SandboxRunnerAdapter['inspectSession']>[0],
      );
      expect(status.runnerReachable).toBe('unreachable');
      expect(driver.inspectCalls).toHaveLength(1);

      const stopBody: Record<string, unknown> = {
        attemptId: ATTEMPT_ID,
        sessionId: SESSION_ID,
        gracePeriodSeconds: 5,
      };
      Object.defineProperty(stopBody, '__proto__', {
        value: {},
        enumerable: true,
        configurable: true,
      });
      const stopped = await adapter.stopSession(
        stopBody as unknown as Parameters<SandboxRunnerAdapter['stopSession']>[0],
      );
      expect(stopped).toMatchObject({ outcome: 'refused' });
      expect(driver.destroyCalls).toHaveLength(0);
    });
  });

  describe('driver call deadlines', () => {
    const STOP = {
      attemptId: ATTEMPT_ID,
      sessionId: SESSION_ID,
      gracePeriodSeconds: 5,
    };

    async function expectCleanDeadline(timeoutMs: number): Promise<void> {
      const clock = manualClock();
      const { adapter, driver } = makeAdapter({
        driverTimeoutMs: timeoutMs,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });
      const started = await adapter.startSession(startRequest());
      expect(started).toStrictEqual({ outcome: 'started', sessionId: SESSION_ID });
      expect(driver.createCalls).toHaveLength(1);
      expect(clock.delays).toEqual([timeoutMs]);
      expect(clock.fired).toBe(0);
      expect(clock.cleared).toHaveLength(1);
      const stopped = await adapter.stopSession(STOP);
      expect(stopped.outcome).toBe('terminated');
      expect(driver.destroyCalls).toStrictEqual([SESSION_ID]);
      expect(clock.fired).toBe(0);
      expect(clock.cleared).toHaveLength(2);
      expect(clock.delays).toEqual([timeoutMs, timeoutMs]);
    }

    it('completes a confirmed start and destroy before driverTimeoutMs and clears the timer without firing it', async () => {
      const clock = manualClock();
      const { adapter, driver } = makeAdapter({
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });
      const started = await adapter.startSession(startRequest());
      expect(started).toStrictEqual({ outcome: 'started', sessionId: SESSION_ID });
      expect(driver.createCalls).toHaveLength(1);
      expect(clock.delays).toEqual([120_000]);
      expect(clock.fired).toBe(0);
      expect(clock.cleared).toHaveLength(1);
      // The cleared timer must not rewrite a start that already settled.
      clock.fire();
      const stopped = await adapter.stopSession(STOP);
      expect(stopped.outcome).toBe('terminated');
      expect(driver.destroyCalls).toStrictEqual([SESSION_ID]);
      expect(clock.fired).toBe(0);
      expect(clock.delays).toEqual([120_000, 120_000]);
      expect(clock.cleared).toHaveLength(2);
    }, 2_000);

    it(
      'returns unknown when create never settles within driverTimeoutMs and blocks the next start with zero further create calls',
      async () => {
        // Positive control: the same deadline, with a driver that settles, starts once.
        await expectCleanDeadline(40_000);
        const clock = manualClock();
        const { adapter, driver } = makeAdapter({
          driverTimeoutMs: 40_000,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
        });
        driver.neverSettleCreate = true;
        const pending = adapter.startSession(startRequest());
        expect(driver.createCalls).toHaveLength(1);
        expect(clock.delays).toEqual([40_000]);
        expect(clock.fired).toBe(0);
        clock.fire();
        const result = await pending;
        expect(result.outcome).toBe('unknown');
        if (result.outcome === 'unknown') {
          expect(result.reason.includes(ATTEMPT_ID)).toBe(false);
        }
        expect(clock.fired).toBe(1);
        expect(clock.cleared).toHaveLength(1);
        const next = await adapter.startSession(startRequest());
        expect(next.outcome).toBe('blocked');
        expect(driver.createCalls).toHaveLength(1);
        const stop = await adapter.stopSession(STOP);
        expect(stop.outcome).toBe('refused');
        expect(driver.destroyCalls).toHaveLength(0);
      },
      // Removing the race leaves `pending` forever. This testTimeout fails the
      // test instead of hanging the suite.
      2_000,
    );

    it(
      'returns still-running when destroy never settles within driverTimeoutMs and the next stop calls destroy again',
      async () => {
        await expectCleanDeadline(40_000);
        const clock = manualClock();
        const { adapter, driver } = makeAdapter({
          driverTimeoutMs: 40_000,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
        });
        const started = await adapter.startSession(startRequest());
        expect(started.outcome).toBe('started');
        expect(clock.fired).toBe(0);
        expect(clock.cleared).toHaveLength(1);
        driver.neverSettleDestroy = true;
        const pending = adapter.stopSession(STOP);
        expect(driver.destroyCalls).toStrictEqual([SESSION_ID]);
        clock.fire();
        const first = await pending;
        expect(first.outcome).toBe('still-running');
        if (first.outcome === 'still-running') {
          expect(first.reason.includes(ATTEMPT_ID)).toBe(false);
          expect(first.reason.includes(SESSION_ID)).toBe(false);
        }
        // Only the destroy deadline was still armed. A leaked create timer would fire too.
        expect(clock.fired).toBe(1);
        driver.neverSettleDestroy = false;
        const second = await adapter.stopSession(STOP);
        expect(second.outcome).toBe('terminated');
        expect(driver.destroyCalls).toStrictEqual([SESSION_ID, SESSION_ID]);
      },
      2_000,
    );

    it(
      'ignores a create result that settles after the timeout and does not change the recorded outcome',
      async () => {
        await expectCleanDeadline(15_000);
        const clock = manualClock();
        const { adapter, driver } = makeAdapter({
          driverTimeoutMs: 15_000,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
        });
        let resolveCreate: (value: SandboxCreateResult) => void = () => {};
        driver.holdCreate = new Promise<SandboxCreateResult>((resolve) => {
          resolveCreate = resolve;
        });
        const pending = adapter.startSession(startRequest());
        expect(driver.createCalls).toHaveLength(1);
        clock.fire();
        const result = await pending;
        expect(result.outcome).toBe('unknown');
        resolveCreate({ outcome: 'confirmed', sessionId: SESSION_ID });
        await Promise.resolve();
        await Promise.resolve();
        const next = await adapter.startSession(startRequest());
        expect(next.outcome).toBe('blocked');
        expect(driver.createCalls).toHaveLength(1);
        const stop = await adapter.stopSession(STOP);
        expect(stop.outcome).toBe('refused');
        expect(driver.destroyCalls).toHaveLength(0);

        const refusedClock = manualClock();
        const refusedCase = makeAdapter({
          driverTimeoutMs: 15_000,
          setTimer: refusedClock.setTimer,
          clearTimer: refusedClock.clearTimer,
        });
        let resolveRefused: (value: SandboxCreateResult) => void = () => {};
        refusedCase.driver.holdCreate = new Promise<SandboxCreateResult>((resolve) => {
          resolveRefused = resolve;
        });
        const refusedPending = refusedCase.adapter.startSession(startRequest());
        refusedClock.fire();
        const refusedResult = await refusedPending;
        expect(refusedResult.outcome).toBe('unknown');
        resolveRefused({ outcome: 'refused' });
        await Promise.resolve();
        await Promise.resolve();
        const afterRefused = await refusedCase.adapter.startSession(startRequest());
        expect(afterRefused.outcome).toBe('blocked');
        expect(refusedCase.driver.createCalls).toHaveLength(1);
      },
      2_000,
    );

    it(
      'ignores a destroy result that settles after the timeout and calls destroy again on the next stop',
      async () => {
        await expectCleanDeadline(15_000);
        const clock = manualClock();
        const { adapter, driver } = makeAdapter({
          driverTimeoutMs: 15_000,
          setTimer: clock.setTimer,
          clearTimer: clock.clearTimer,
        });
        const started = await adapter.startSession(startRequest());
        expect(started.outcome).toBe('started');
        expect(driver.createCalls).toHaveLength(1);
        expect(clock.fired).toBe(0);
        let resolveDestroy: (value: SandboxDestroyResult) => void = () => {};
        driver.holdDestroy = new Promise<SandboxDestroyResult>((resolve) => {
          resolveDestroy = resolve;
        });
        const pending = adapter.stopSession(STOP);
        expect(driver.destroyCalls).toStrictEqual([SESSION_ID]);
        clock.fire();
        const first = await pending;
        expect(first.outcome).toBe('still-running');
        resolveDestroy({ outcome: 'destroyed' });
        await Promise.resolve();
        await Promise.resolve();
        const second = await adapter.stopSession(STOP);
        expect(second.outcome).toBe('terminated');
        expect(driver.destroyCalls).toStrictEqual([SESSION_ID, SESSION_ID]);
      },
      2_000,
    );

    it('refuses construction unless driverTimeoutMs is a positive integer of at most 600000', async () => {
      const accepted = manualClock();
      const { adapter, driver } = makeAdapter({
        driverTimeoutMs: 600_000,
        setTimer: accepted.setTimer,
        clearTimer: accepted.clearTimer,
      });
      const started = await adapter.startSession(startRequest());
      expect(started.outcome).toBe('started');
      expect(driver.createCalls).toHaveLength(1);
      expect(accepted.delays).toEqual([600_000]);
      expect(accepted.fired).toBe(0);

      const minimum = manualClock();
      const small = makeAdapter({
        driverTimeoutMs: 1,
        setTimer: minimum.setTimer,
        clearTimer: minimum.clearTimer,
      });
      const smallStarted = await small.adapter.startSession(startRequest());
      expect(smallStarted.outcome).toBe('started');
      expect(minimum.delays).toEqual([1]);

      for (const driverTimeoutMs of [0, -1, 600_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => makeAdapter({ driverTimeoutMs })).toThrow(/positive integer of at most 600000/);
      }
      expect(() => makeAdapter({ driverTimeoutMs: '120000' as never })).toThrow(
        /positive integer of at most 600000/,
      );

      const flag = { read: false };
      const hostile = {
        driver: new FakeDriver(),
        capabilities: DECLARED_CAPS,
      };
      Object.defineProperty(hostile, 'driverTimeoutMs', {
        enumerable: true,
        configurable: true,
        get() {
          flag.read = true;
          return 1;
        },
      });
      expect(() => new SandboxRunnerAdapter(hostile)).toThrow(/positive integer of at most 600000/);
      expect(flag.read).toBe(false);

      const timerFlag = { read: false };
      const half = {
        driver: new FakeDriver(),
        capabilities: DECLARED_CAPS,
        clearTimer: () => {},
      };
      Object.defineProperty(half, 'setTimer', {
        enumerable: true,
        configurable: true,
        get() {
          timerFlag.read = true;
          return () => 0;
        },
      });
      expect(() => new SandboxRunnerAdapter(half)).toThrow(/setTimer and clearTimer/);
      expect(timerFlag.read).toBe(false);
      expect(() => makeAdapter({ setTimer: () => 0 })).toThrow(/setTimer and clearTimer/);
    });
  });
});

/** A clock the adapter arms and the test fires. Clearing drops the callback. */
function manualClock(): {
  readonly delays: number[];
  readonly cleared: number[];
  fired: number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: unknown) => void;
  fire: () => void;
} {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const clock = {
    delays: [] as number[],
    cleared: [] as number[],
    fired: 0,
    setTimer(callback: () => void, delayMs: number): number {
      const handle = nextHandle;
      nextHandle += 1;
      clock.delays.push(delayMs);
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimer(handle: unknown): void {
      if (typeof handle !== 'number') {
        return;
      }
      clock.cleared.push(handle);
      callbacks.delete(handle);
    },
    fire(): void {
      const pending = [...callbacks.entries()];
      for (const [handle, callback] of pending) {
        callbacks.delete(handle);
        clock.fired += 1;
        callback();
      }
    },
  };
  return clock;
}
