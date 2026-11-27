/**
 * Tests for RunAttemptEnvironmentUseCase (lane FC8J). Fake driver only: every
 * test drives `InMemoryMicroVmDriver` (or a thin scripted wrapper around it);
 * no real VM, subprocess, network, clock or randomness is involved. A green
 * run here is NOT evidence of isolation.
 */

import { readFileSync } from 'node:fs';
import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER as PORT_DISCLAIMER } from '../../ports/in/RunAttemptEnvironmentPort.in-port.js';
import type { MicroVmDriverPort, MicroVmHandle, MicroVmIsolation } from '../../ports/out/MicroVmDriverPort.out-port.js';
import { InMemoryMicroVmDriver } from '../../ports/out/__tests__/in-memory-micro-vm-driver.js';
import {
  DISCLAIMER,
  RunAttemptEnvironmentUseCase,
  readStepOutcome,
  type AttemptEnvironmentStep,
} from '../RunAttemptEnvironmentUseCase.use-case.js';

type StepName = 'create' | 'inject' | 'seal' | 'work' | 'gate';
type StepFn = (handle: MicroVmHandle) => unknown;
type CreateRequest = { readonly attemptId: string; readonly isolation: MicroVmIsolation };

const OK = { ok: true } as const;
const ALL_STEPS: readonly StepName[] = ['create', 'inject', 'seal', 'work', 'gate'];
const STEP_REASONS: Record<StepName, string> = {
  create: 'create-failed',
  inject: 'inject-failed',
  seal: 'seal-failed',
  work: 'work-failed',
  gate: 'gate-failed',
};
const BASE_REQUEST = {
  attemptId: 'attempt-1',
  worktreeRef: 'worktrees/attempt-1',
  isolation: 'microvm',
  nowIso: '2026-11-27T15:00:00.000Z',
} as const;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_REQUEST, ...overrides };
}

function without(key: string, source: Record<string, unknown> = { ...BASE_REQUEST }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

interface Overrides {
  create?: (request: CreateRequest) => Promise<unknown>;
  injectWorktree?: (handle: MicroVmHandle) => Promise<unknown>;
  seal?: (handle: MicroVmHandle) => Promise<unknown>;
  destroy?: (handle: MicroVmHandle) => Promise<unknown>;
}

interface HarnessOptions {
  inner?: InMemoryMicroVmDriver;
  overrides?: Overrides;
  work?: StepFn | 'none' | 'not-a-function';
  gate?: StepFn | 'missing';
  omitMethod?: 'create' | 'injectWorktree' | 'seal' | 'destroy';
  useDefaultIsProxy?: boolean;
}

/** A use case over a logged wrapper of the in-memory driver; `log` is the exact call order. */
function build(options: HarnessOptions = {}) {
  const inner = options.inner ?? new InMemoryMicroVmDriver();
  const overrides = options.overrides ?? {};
  const log: string[] = [];
  const hookHandles: MicroVmHandle[] = [];
  const driverObject: Record<string, unknown> = {
    create: async (req: CreateRequest) => {
      log.push(`create:${req.attemptId}`);
      return overrides.create ? overrides.create(req) : inner.create(req);
    },
    injectWorktree: async (handle: MicroVmHandle, req: { worktreeRef: string }) => {
      log.push('inject');
      return overrides.injectWorktree ? overrides.injectWorktree(handle) : inner.injectWorktree(handle, req);
    },
    seal: async (handle: MicroVmHandle) => {
      log.push('seal');
      return overrides.seal ? overrides.seal(handle) : inner.seal(handle);
    },
    destroy: async (handle: MicroVmHandle) => {
      log.push(`destroy:${handle.environmentId}`);
      return overrides.destroy ? overrides.destroy(handle) : inner.destroy(handle);
    },
  };
  if (options.omitMethod !== undefined) {
    driverObject[options.omitMethod] = undefined;
  }
  const workFn = options.work === undefined ? (async () => OK) : options.work;
  let runWork: AttemptEnvironmentStep | undefined;
  if (workFn === 'not-a-function') {
    runWork = 'nope' as unknown as AttemptEnvironmentStep;
  } else if (workFn !== 'none') {
    runWork = (async (handle: MicroVmHandle) => {
      log.push('work');
      hookHandles.push(handle);
      return workFn(handle);
    }) as AttemptEnvironmentStep;
  }
  const gateFn = options.gate === undefined ? (async () => OK) : options.gate;
  const runGate =
    gateFn === 'missing'
      ? (undefined as unknown as AttemptEnvironmentStep)
      : ((async (handle: MicroVmHandle) => {
          log.push('gate');
          hookHandles.push(handle);
          return gateFn(handle);
        }) as AttemptEnvironmentStep);
  const dependencies = {
    driver: driverObject as unknown as MicroVmDriverPort,
    runGate,
    ...(runWork === undefined ? {} : { runWork }),
  };
  const useCase = new RunAttemptEnvironmentUseCase(dependencies, options.useDefaultIsProxy ? undefined : types.isProxy);
  return { useCase, log, inner, hookHandles };
}

/** Harness options that make exactly one step return `produce()`. */
function withOutcome(step: StepName, produce: () => unknown): HarnessOptions {
  switch (step) {
    case 'create':
      return { overrides: { create: async () => produce() } };
    case 'inject':
      return { overrides: { injectWorktree: async () => produce() } };
    case 'seal':
      return { overrides: { seal: async () => produce() } };
    case 'work':
      return { work: () => produce() };
    case 'gate':
      return { gate: () => produce() };
  }
}

function expectRefusal(result: unknown, reason: string): void {
  expect(result).toEqual({
    ok: false,
    reason,
    isolation: { source: 'declared', label: 'fake-driver' },
    disclaimer: DISCLAIMER,
  });
}

function destroyCalls(log: readonly string[]): string[] {
  return log.filter((entry) => entry.startsWith('destroy:'));
}

const TRAP_NAMES = [
  'get',
  'has',
  'ownKeys',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'set',
  'defineProperty',
  'deleteProperty',
  'isExtensible',
  'preventExtensions',
  'setPrototypeOf',
] as const;

/** A Proxy that records every trap that runs, except the `then` lookup a promise resolution always performs. */
function trapRecorder(target: object) {
  const calls: string[] = [];
  const handler: Record<string, unknown> = {};
  const reflect = Reflect as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of TRAP_NAMES) {
    handler[name] = (...args: unknown[]) => {
      if (name === 'get' && args[1] === 'then') {
        return undefined;
      }
      calls.push(name);
      return reflect[name]!(...args);
    };
  }
  return { proxy: new Proxy(target, handler as ProxyHandler<object>), calls };
}

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function handleFor(req: CreateRequest, environmentId = 'env-x'): Record<string, unknown> {
  return { environmentId, attemptId: req.attemptId, isolation: req.isolation };
}

describe('RunAttemptEnvironmentUseCase', () => {
  it('drives fake driver in create, injectWorktree, seal, run, destroy order with a fresh gate environment differing from the implementation environment', async () => {
    const { useCase, log, inner, hookHandles } = build();

    const result = await useCase.execute(request());

    expect(result).toEqual({
      ok: true,
      attemptId: 'attempt-1',
      implementationEnvironmentId: 'env-1',
      gateEnvironmentId: 'env-2',
      isolation: { source: 'declared', label: 'fake-driver' },
      disclaimer: DISCLAIMER,
    });
    expect(log).toEqual([
      'create:attempt-1.impl',
      'inject',
      'seal',
      'work',
      'destroy:env-1',
      'create:attempt-1.gate',
      'inject',
      'seal',
      'gate',
      'destroy:env-2',
    ]);
    const calls = inner.recordedCalls();
    expect(calls.map((call) => call.step)).toEqual([
      'create',
      'injectWorktree',
      'seal',
      'destroy',
      'create',
      'injectWorktree',
      'seal',
      'destroy',
    ]);
    expect(calls.map((call) => call.attemptId)).toEqual([
      'attempt-1.impl',
      'attempt-1.impl',
      'attempt-1.impl',
      'attempt-1.impl',
      'attempt-1.gate',
      'attempt-1.gate',
      'attempt-1.gate',
      'attempt-1.gate',
    ]);
    expect(calls.every((call) => call.ok)).toBe(true);
    expect(hookHandles).toEqual([
      { environmentId: 'env-1', attemptId: 'attempt-1.impl', isolation: 'microvm' },
      { environmentId: 'env-2', attemptId: 'attempt-1.gate', isolation: 'microvm' },
    ]);
    expect(hookHandles.every((handle) => Object.isFrozen(handle))).toBe(true);
  });

  it('passes the declared user-space-kernel isolation through to both created environments', async () => {
    const { useCase, inner } = build();

    const result = await useCase.execute(request({ isolation: 'user-space-kernel' }));

    expect(result).toMatchObject({ ok: true });
    expect(inner.recordedCalls().filter((call) => call.step === 'create')).toHaveLength(2);
    expect(inner.recordedCalls().every((call) => call.ok)).toBe(true);
  });

  it('accepts a 123-character attemptId and refuses a 124-character one so both phase ids stay within 128 characters', async () => {
    const accepted = build();
    const refused = build();

    const acceptedResult = await accepted.useCase.execute(request({ attemptId: 'a'.repeat(123) }));
    const refusedResult = await refused.useCase.execute(request({ attemptId: 'a'.repeat(124) }));

    expect(acceptedResult).toMatchObject({ ok: true });
    expectRefusal(refusedResult, 'invalid-attempt-id');
    expect(refused.log).toEqual([]);
  });

  it('exports DISCLAIMER matching the module header comment and omits isolated or sandboxed claims from results', async () => {
    const source = readFileSync(new URL('../RunAttemptEnvironmentUseCase.use-case.ts', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('*/'));
    const success = await build().useCase.execute(request());
    const refusal = await build().useCase.execute(null);

    expect(DISCLAIMER).toBe(PORT_DISCLAIMER);
    expect(DISCLAIMER).toContain('NOT evidence of isolation');
    expect(header).toContain(DISCLAIMER);
    for (const result of [success, refusal]) {
      expect(JSON.stringify(result)).not.toMatch(/isolated|sandboxed/i);
      expect(Object.keys(result).sort()).not.toContain('isolated');
      expect(result.isolation).toEqual({ source: 'declared', label: 'fake-driver' });
      expect(result.disclaimer).toBe(DISCLAIMER);
    }
  });

  it('runs two parallel attempts with disjoint environment ids', async () => {
    const { useCase, inner } = build();

    const [first, second] = await Promise.all([
      useCase.execute(request({ attemptId: 'parallel-1' })),
      useCase.execute(request({ attemptId: 'parallel-2' })),
    ]);

    expect(first).toMatchObject({ ok: true, attemptId: 'parallel-1' });
    expect(second).toMatchObject({ ok: true, attemptId: 'parallel-2' });
    const ids = inner
      .recordedCalls()
      .filter((call) => call.step === 'create')
      .map((call) => call.environmentId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('never reuses an environment id across phases, across sequential attempts, or across parallel attempts', async () => {
    const allOk: Overrides = {
      injectWorktree: async () => OK,
      seal: async () => OK,
      destroy: async () => OK,
    };
    const constantId: Overrides = {
      ...allOk,
      create: async (req) => ({ ok: true, handle: handleFor(req, 'env-same') }),
    };

    // Across phases: the gate create returns the implementation's id.
    const phases = build({ overrides: constantId });
    expectRefusal(await phases.useCase.execute(request()), 'environment-id-reused');
    expect(phases.log).toEqual([
      'create:attempt-1.impl',
      'inject',
      'seal',
      'work',
      'destroy:env-same',
      'create:attempt-1.gate',
    ]);

    // Across sequential attempts on the same use case instance.
    const sequential = build({ overrides: constantId });
    expectRefusal(await sequential.useCase.execute(request({ attemptId: 'seq-1' })), 'environment-id-reused');
    const before = sequential.log.length;
    expectRefusal(await sequential.useCase.execute(request({ attemptId: 'seq-2' })), 'environment-id-reused');
    expect(sequential.log.slice(before)).toEqual(['create:seq-2.impl']);

    // Across parallel attempts: both implementation creates are issued the same id.
    const parallel = build({
      overrides: {
        ...allOk,
        create: async (req) => ({
          ok: true,
          handle: handleFor(req, req.attemptId.endsWith('.gate') ? `gate-${req.attemptId}` : 'env-shared'),
        }),
      },
    });
    const results = await Promise.all([
      parallel.useCase.execute(request({ attemptId: 'par-1' })),
      parallel.useCase.execute(request({ attemptId: 'par-2' })),
    ]);
    expect(results[0]).toMatchObject({ ok: true, implementationEnvironmentId: 'env-shared' });
    expectRefusal(results[1], 'environment-id-reused');
    expect(parallel.log.filter((entry) => entry === 'inject')).toHaveLength(2);
  });

  it('refuses a second run of the same attemptId as create-failed because the driver never reissues an attempt', async () => {
    const { useCase, log } = build();

    expect(await useCase.execute(request())).toMatchObject({ ok: true });
    const before = log.length;
    expectRefusal(await useCase.execute(request()), 'create-failed');

    expect(log.slice(before)).toEqual(['create:attempt-1.impl']);
  });

  it('does not call destroy for an uncreated handle on create failure and leaves prior implementation handle destroyed if gate create fails', async () => {
    const refused = build({ inner: new InMemoryMicroVmDriver({ failOnStep: 'create' }) });
    expectRefusal(await refused.useCase.execute(request()), 'create-failed');
    expect(refused.log).toEqual(['create:attempt-1.impl']);

    const thrown = build({
      overrides: {
        create: async () => {
          throw new Error('boom');
        },
      },
    });
    expectRefusal(await thrown.useCase.execute(request()), 'create-failed');
    expect(thrown.log).toEqual(['create:attempt-1.impl']);

    let createCalls = 0;
    const gateInner = new InMemoryMicroVmDriver();
    const gateCreateFails = build({
      inner: gateInner,
      overrides: {
        create: async (req) => {
          createCalls += 1;
          if (createCalls === 2) {
            return { ok: false, reason: 'refused' };
          }
          return gateInner.create(req);
        },
      },
    });
    expectRefusal(await gateCreateFails.useCase.execute(request()), 'create-failed');
    expect(gateCreateFails.log).toEqual([
      'create:attempt-1.impl',
      'inject',
      'seal',
      'work',
      'destroy:env-1',
      'create:attempt-1.gate',
    ]);
    expect(
      gateCreateFails.inner
        .recordedCalls()
        .filter((call) => call.step === 'destroy')
        .map((call) => [call.environmentId, call.ok]),
    ).toEqual([['env-1', true]]);
  });

  it('refuses a handle from driver.create with missing, invalid, or mismatched attemptId or isolation without calling injectWorktree, seal, run, or destroy', async () => {
    const cases: Array<[string, (req: CreateRequest) => unknown]> = [
      ['ok is the string true', (r) => ({ ok: 'true', handle: handleFor(r) })],
      ['ok is 1', (r) => ({ ok: 1, handle: handleFor(r) })],
      ['ok is null', (r) => ({ ok: null, handle: handleFor(r) })],
      ['ok false without reason', () => ({ ok: false })],
      ['ok false with empty reason', () => ({ ok: false, reason: '' })],
      ['ok false with numeric reason', () => ({ ok: false, reason: 5 })],
      ['ok false with extra key', () => ({ ok: false, reason: 'refused', extra: 1 })],
      ['ok false well formed', () => ({ ok: false, reason: 'refused' })],
      ['ok true without handle', () => ({ ok: true })],
      ['ok true with extra key', (r) => ({ ok: true, handle: handleFor(r), reason: 'x' })],
      ['handle null', () => ({ ok: true, handle: null })],
      ['handle array', () => ({ ok: true, handle: [] })],
      ['handle string', () => ({ ok: true, handle: 'env-1' })],
      ['missing environmentId', (r) => ({ ok: true, handle: without('environmentId', handleFor(r)) })],
      ['environmentId with invalid characters', (r) => ({ ok: true, handle: handleFor(r, 'bad id!') })],
      ['environmentId empty', (r) => ({ ok: true, handle: handleFor(r, '') })],
      ['environmentId numeric', (r) => ({ ok: true, handle: { ...handleFor(r), environmentId: 7 } })],
      ['environmentId over 128 characters', (r) => ({ ok: true, handle: handleFor(r, 'e'.repeat(129)) })],
      ['missing attemptId', (r) => ({ ok: true, handle: without('attemptId', handleFor(r)) })],
      ['attemptId of another attempt', (r) => ({ ok: true, handle: { ...handleFor(r), attemptId: 'other.impl' } })],
      ['attemptId without the phase suffix', (r) => ({ ok: true, handle: { ...handleFor(r), attemptId: 'attempt-1' } })],
      ['missing isolation', (r) => ({ ok: true, handle: without('isolation', handleFor(r)) })],
      [
        'isolation differs from the request',
        (r) => ({ ok: true, handle: { ...handleFor(r), isolation: 'user-space-kernel' } }),
      ],
      ['isolation unsupported', (r) => ({ ok: true, handle: { ...handleFor(r), isolation: 'vm' } })],
      ['handle with an extra key', (r) => ({ ok: true, handle: { ...handleFor(r), extra: 1 } })],
      [
        'handle with an own __proto__ key',
        (r) => ({ ok: true, handle: JSON.parse(`{"environmentId":"env-x","attemptId":"${r.attemptId}","isolation":"microvm","__proto__":1}`) }),
      ],
      ['undefined', () => undefined],
      ['null', () => null],
      ['array', () => []],
    ];
    for (const [name, make] of cases) {
      const { useCase, log } = build({ overrides: { create: async (req) => make(req) } });

      const result = await useCase.execute(request());

      expectRefusal(result, 'create-failed');
      expect(log, name).toEqual(['create:attempt-1.impl']);
    }

    // A gate-phase handle bound to the implementation attempt is refused too, and the implementation stays destroyed.
    let createCalls = 0;
    const gateMismatch = build({
      overrides: {
        create: async (req) => {
          createCalls += 1;
          return createCalls === 1
            ? { ok: true, handle: handleFor(req, 'env-a') }
            : { ok: true, handle: handleFor({ ...req, attemptId: 'attempt-1.impl' }, 'env-b') };
        },
        injectWorktree: async () => OK,
        seal: async () => OK,
        destroy: async () => OK,
      },
    });
    expectRefusal(await gateMismatch.useCase.execute(request()), 'create-failed');
    expect(gateMismatch.log).toEqual([
      'create:attempt-1.impl',
      'inject',
      'seal',
      'work',
      'destroy:env-a',
      'create:attempt-1.gate',
    ]);
  });

  it('calls destroy once when injectWorktree fails', async () => {
    const variants: HarnessOptions[] = [
      { inner: new InMemoryMicroVmDriver({ failOnStep: 'injectWorktree' }) },
      {
        overrides: {
          injectWorktree: async () => {
            throw new Error('boom');
          },
        },
      },
      { overrides: { injectWorktree: async () => ({ ok: false, reason: 'refused' }) } },
    ];
    for (const options of variants) {
      const { useCase, log } = build(options);

      expectRefusal(await useCase.execute(request()), 'inject-failed');

      expect(log).toEqual(['create:attempt-1.impl', 'inject', 'destroy:env-1']);
    }
  });

  it('calls destroy once when seal fails', async () => {
    const variants: HarnessOptions[] = [
      { inner: new InMemoryMicroVmDriver({ failOnStep: 'seal' }) },
      {
        overrides: {
          seal: async () => {
            throw new Error('boom');
          },
        },
      },
      { overrides: { seal: async () => ({ ok: false, reason: 'refused' }) } },
    ];
    for (const options of variants) {
      const { useCase, log } = build(options);

      expectRefusal(await useCase.execute(request()), 'seal-failed');

      expect(log).toEqual(['create:attempt-1.impl', 'inject', 'seal', 'destroy:env-1']);
    }
  });

  it('calls destroy once on runWork failure without creating gate environment', async () => {
    const variants: StepFn[] = [
      async () => ({ ok: false, reason: 'work-broke' }),
      async () => {
        throw new Error('boom');
      },
      () => {
        throw new Error('sync boom');
      },
    ];
    for (const work of variants) {
      const { useCase, log } = build({ work });

      expectRefusal(await useCase.execute(request()), 'work-failed');

      expect(log).toEqual(['create:attempt-1.impl', 'inject', 'seal', 'work', 'destroy:env-1']);
    }
  });

  it('calls destroy once on gate failure including failed command, unreadable file, malformed record, timeout, budget exhaustion, and thrown error', async () => {
    const variants: Array<[string, StepFn]> = [
      ['failed command', async () => ({ ok: false, reason: 'command-failed' })],
      ['empty command result', async () => ({})],
      ['unreadable file', async () => ({ ok: false, reason: 'unreadable-file' })],
      ['malformed record', async () => ({ ok: 'yes' })],
      ['timeout', async () => Promise.reject(new Error('timeout'))],
      ['budget exhausted', async () => ({ ok: false, reason: 'budget-exhausted' })],
      ['unknown verdict', async () => ({ ok: true, verdict: 'unknown' })],
      [
        'thrown error',
        () => {
          throw new Error('boom');
        },
      ],
    ];
    for (const [name, gate] of variants) {
      const { useCase, log } = build({ gate });

      const result = await useCase.execute(request());

      expectRefusal(result, 'gate-failed');
      expect(log, name).toEqual([
        'create:attempt-1.impl',
        'inject',
        'seal',
        'work',
        'destroy:env-1',
        'create:attempt-1.gate',
        'inject',
        'seal',
        'gate',
        'destroy:env-2',
      ]);
      expect(destroyCalls(log)).toHaveLength(2);
    }
  });

  it('refuses malformed create, injectWorktree, seal, runWork, and runGate outcomes where ok is not boolean or reason is not a non-empty string', async () => {
    const malformed: Array<[string, () => unknown]> = [
      ['ok is the string true', () => ({ ok: 'true' })],
      ['ok is 1', () => ({ ok: 1 })],
      ['ok is null', () => ({ ok: null })],
      ['ok false without reason', () => ({ ok: false })],
      ['ok false with empty reason', () => ({ ok: false, reason: '' })],
      ['ok false with numeric reason', () => ({ ok: false, reason: 5 })],
      ['ok true with extra key', () => ({ ok: true, extra: 1 })],
      ['ok false with extra key', () => ({ ok: false, reason: 'r', extra: 1 })],
      ['ok false with over-long reason', () => ({ ok: false, reason: 'r'.repeat(129) })],
      ['empty object', () => ({})],
      ['undefined', () => undefined],
      ['null', () => null],
      ['string', () => 'ok'],
      ['array', () => []],
    ];
    for (const step of ALL_STEPS) {
      for (const [name, make] of malformed) {
        const { useCase, log } = build(withOutcome(step, make));

        const result = await useCase.execute(request());

        expectRefusal(result, STEP_REASONS[step]);
        // A refused step never lets a later step run, and every created handle is destroyed exactly once.
        const expectedDestroys = { create: 0, inject: 1, seal: 1, work: 1, gate: 2 }[step];
        expect(destroyCalls(log).length, `${step}/${name}`).toBe(expectedDestroys);
        if (step === 'create') {
          expect(log, `${step}/${name}`).toEqual(['create:attempt-1.impl']);
        }
        if (step !== 'gate') {
          expect(log, `${step}/${name}`).not.toContain('gate');
        }
        if (step === 'inject') {
          expect(log, `${step}/${name}`).not.toContain('seal');
        }
        if (step === 'seal' || step === 'inject') {
          expect(log, `${step}/${name}`).not.toContain('work');
        }
      }
    }
  });

  it('treats a failed, malformed or hostile destroy outcome as unavailable instead of success, and keeps an earlier failure reason', async () => {
    const failedDestroy = build({ inner: new InMemoryMicroVmDriver({ failOnStep: 'destroy' }) });
    expectRefusal(await failedDestroy.useCase.execute(request()), 'unavailable');
    expect(failedDestroy.log).toEqual(['create:attempt-1.impl', 'inject', 'seal', 'work', 'destroy:env-1']);

    const malformedDestroy = build({ overrides: { destroy: async () => ({ ok: 'true' }) } });
    expectRefusal(await malformedDestroy.useCase.execute(request()), 'unavailable');

    const thrownDestroy = build({
      overrides: {
        destroy: async () => {
          throw new Error('boom');
        },
      },
    });
    expectRefusal(await thrownDestroy.useCase.execute(request()), 'unavailable');

    const recorder = trapRecorder({ ok: true });
    const hostileDestroy = build({ overrides: { destroy: async () => recorder.proxy } });
    expectRefusal(await hostileDestroy.useCase.execute(request()), 'unavailable');
    expect(recorder.calls).toEqual([]);

    const earlier = build({
      inner: new InMemoryMicroVmDriver({ failOnStep: 'destroy' }),
      work: async () => ({ ok: false, reason: 'work-broke' }),
    });
    expectRefusal(await earlier.useCase.execute(request()), 'work-failed');
    expect(destroyCalls(earlier.log)).toHaveLength(1);
  });

  it('refuses null, undefined, primitives, non-iterables, array holes, array-likes, and enormous lengths without echoing values', async () => {
    const marker = 'SECRET-MARKER-12345';
    const inputs: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['boolean', true],
      ['string', marker],
      ['symbol', Symbol(marker)],
      ['bigint', 10n],
      ['function', () => marker],
      ['empty array', []],
      ['array with a hole', Object.assign(new Array(2), { 1: marker })],
      ['array with elements', [marker]],
      ['sparse array of enormous length', new Array(2 ** 32 - 1)],
      ['array-like with enormous length', { length: 2 ** 32, 0: marker }],
      ['array-like with small length', { length: 1, 0: marker }],
      ['Map', new Map([[marker, marker]])],
      ['Set', new Set([marker])],
      ['over-long string', marker.repeat(100)],
      ['object with an unknown key', { [marker]: marker }],
      ['object with the right keys plus an extra', request({ extra: marker })],
    ];
    for (const [name, input] of inputs) {
      const { useCase, log } = build();

      const result = await useCase.execute(input);

      expectRefusal(result, 'invalid-input');
      expect(JSON.stringify(result), name).not.toContain(marker);
      expect(log, name).toEqual([]);
    }
  });

  it('refuses Proxy and revoked Proxy inputs and outcomes without throwing or running traps', async () => {
    const requestRecorder = trapRecorder(request());
    const proxied = build();
    expectRefusal(await proxied.useCase.execute(requestRecorder.proxy), 'invalid-input');
    expect(requestRecorder.calls).toEqual([]);
    expect(proxied.log).toEqual([]);

    expectRefusal(await build().useCase.execute(revokedProxy()), 'invalid-input');
    expectRefusal(await build({ useDefaultIsProxy: true }).useCase.execute(revokedProxy()), 'invalid-input');

    const fieldRecorder = trapRecorder({});
    expectRefusal(await build().useCase.execute(request({ isolation: fieldRecorder.proxy })), 'unsupported-isolation');
    expect(fieldRecorder.calls).toEqual([]);

    for (const step of ALL_STEPS) {
      const recorder = trapRecorder({ ok: true });
      const live = build(withOutcome(step, () => recorder.proxy));
      expectRefusal(await live.useCase.execute(request()), STEP_REASONS[step]);
      expect(recorder.calls, `${step} proxy traps`).toEqual([]);

      const revoked = build(withOutcome(step, () => revokedProxy()));
      expectRefusal(await revoked.useCase.execute(request()), STEP_REASONS[step]);
    }

    const handleRecorder = trapRecorder(handleFor({ attemptId: 'attempt-1.impl', isolation: 'microvm' }));
    const inHandle = build({ overrides: { create: async () => ({ ok: true, handle: handleRecorder.proxy }) } });
    expectRefusal(await inHandle.useCase.execute(request()), 'create-failed');
    expect(handleRecorder.calls).toEqual([]);
    expect(inHandle.log).toEqual(['create:attempt-1.impl']);

    // The shared outcome reader itself never throws on a revoked Proxy, whatever the detector says.
    expect(readStepOutcome(revokedProxy(), types.isProxy)).toBeNull();
    expect(readStepOutcome(revokedProxy(), () => false)).toBeNull();
    expect(readStepOutcome(revokedProxy(), () => {
      throw new Error('detector');
    })).toBeNull();
  });

  it('refuses own accessor getters and inherited prototype getters without invoking them', async () => {
    let reads = 0;
    const ownGetter = (source: Record<string, unknown>, key: string): Record<string, unknown> => {
      const target = without(key, source);
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          reads += 1;
          return source[key];
        },
      });
      return target;
    };

    expectRefusal(await build().useCase.execute(ownGetter(request(), 'attemptId')), 'invalid-attempt-id');
    expectRefusal(await build().useCase.execute(ownGetter(request(), 'isolation')), 'unsupported-isolation');
    const inheritedRequest = Object.create({
      get attemptId() {
        reads += 1;
        return 'attempt-1';
      },
    }) as Record<string, unknown>;
    Object.assign(inheritedRequest, without('attemptId'));
    expectRefusal(await build().useCase.execute(inheritedRequest), 'invalid-input');

    for (const step of ALL_STEPS) {
      const own = {};
      Object.defineProperty(own, 'ok', {
        enumerable: true,
        get() {
          reads += 1;
          return true;
        },
      });
      const inherited = Object.create({
        get ok() {
          reads += 1;
          return true;
        },
      }) as object;
      for (const outcome of [own, inherited]) {
        expectRefusal(await build(withOutcome(step, () => outcome)).useCase.execute(request()), STEP_REASONS[step]);
      }
    }

    const handleWithGetter = {};
    Object.defineProperty(handleWithGetter, 'environmentId', {
      enumerable: true,
      get() {
        reads += 1;
        return 'env-x';
      },
    });
    Object.assign(handleWithGetter, { attemptId: 'attempt-1.impl', isolation: 'microvm' });
    const withGetterHandle = build({ overrides: { create: async () => ({ ok: true, handle: handleWithGetter }) } });
    expectRefusal(await withGetterHandle.useCase.execute(request()), 'create-failed');
    expect(withGetterHandle.log).toEqual(['create:attempt-1.impl']);

    expect(reads).toBe(0);
  });

  it('refuses Symbol.iterator overrides on request and outcomes', async () => {
    const iterator = function* iterator(): Generator<never> {
      // empty
    };
    expectRefusal(await build().useCase.execute({ ...BASE_REQUEST, [Symbol.iterator]: iterator }), 'invalid-input');
    expectRefusal(await build().useCase.execute(Object.assign([], { [Symbol.iterator]: iterator })), 'invalid-input');

    for (const step of ALL_STEPS) {
      const outcome = { ok: true, [Symbol.iterator]: iterator };
      expectRefusal(await build(withOutcome(step, () => outcome)).useCase.execute(request()), STEP_REASONS[step]);
    }
    const inHandle = build({
      overrides: {
        create: async (req) => ({ ok: true, handle: { ...handleFor(req), [Symbol.iterator]: iterator } }),
      },
    });
    expectRefusal(await inHandle.useCase.execute(request()), 'create-failed');
    expect(inHandle.log).toEqual(['create:attempt-1.impl']);
  });

  it('refuses reserved own keys (__proto__, constructor, prototype) and extra keys on request, handle, and outcomes', async () => {
    const protoRequest = JSON.parse(
      '{"attemptId":"attempt-1","worktreeRef":"worktrees/attempt-1","isolation":"microvm","nowIso":"t","__proto__":1}',
    ) as unknown;
    expect(Object.hasOwn(protoRequest as object, '__proto__')).toBe(true);
    expectRefusal(await build().useCase.execute(protoRequest), 'invalid-input');
    for (const key of ['constructor', 'prototype', 'extra']) {
      const { useCase, log } = build();
      expectRefusal(await useCase.execute(request({ [key]: 1 })), 'invalid-input');
      expect(log).toEqual([]);
    }

    for (const key of ['constructor', 'prototype', 'extra']) {
      const inHandle = build({
        overrides: { create: async (req) => ({ ok: true, handle: { ...handleFor(req), [key]: 1 } }) },
      });
      expectRefusal(await inHandle.useCase.execute(request()), 'create-failed');
      expect(inHandle.log).toEqual(['create:attempt-1.impl']);
    }

    for (const step of ALL_STEPS) {
      if (step === 'create') {
        continue;
      }
      for (const key of ['constructor', 'prototype', 'extra']) {
        expectRefusal(
          await build(withOutcome(step, () => ({ ok: true, [key]: 1 }))).useCase.execute(request()),
          STEP_REASONS[step],
        );
      }
      expectRefusal(
        await build(withOutcome(step, () => JSON.parse('{"ok":true,"__proto__":1}'))).useCase.execute(request()),
        STEP_REASONS[step],
      );
    }
    const createProto = build({
      overrides: {
        create: async () => JSON.parse('{"ok":true,"handle":1,"__proto__":1}'),
      },
    });
    expectRefusal(await createProto.useCase.execute(request()), 'create-failed');
  });

  it('maps missing or invalid attemptId, worktreeRef, and nowIso to field-specific refusal reasons', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['attemptId missing', without('attemptId'), 'invalid-attempt-id'],
      ['attemptId empty', request({ attemptId: '' }), 'invalid-attempt-id'],
      ['attemptId with a space', request({ attemptId: 'a b' }), 'invalid-attempt-id'],
      ['attemptId with a slash', request({ attemptId: 'a/b' }), 'invalid-attempt-id'],
      ['attemptId over 123 characters', request({ attemptId: 'a'.repeat(124) }), 'invalid-attempt-id'],
      ['attemptId over the string bound', request({ attemptId: 'a'.repeat(513) }), 'invalid-attempt-id'],
      ['attemptId numeric', request({ attemptId: 5 }), 'invalid-attempt-id'],
      ['attemptId null', request({ attemptId: null }), 'invalid-attempt-id'],
      ['attemptId undefined', request({ attemptId: undefined }), 'invalid-attempt-id'],
      ['attemptId nested object', request({ attemptId: { a: { b: 1 } } }), 'invalid-attempt-id'],
      ['worktreeRef missing', without('worktreeRef'), 'invalid-worktree-ref'],
      ['worktreeRef empty', request({ worktreeRef: '' }), 'invalid-worktree-ref'],
      ['worktreeRef absolute', request({ worktreeRef: '/abs/path' }), 'invalid-worktree-ref'],
      ['worktreeRef drive letter', request({ worktreeRef: 'C:\\work' }), 'invalid-worktree-ref'],
      ['worktreeRef parent segment', request({ worktreeRef: 'a/../b' }), 'invalid-worktree-ref'],
      ['worktreeRef leading parent', request({ worktreeRef: '../b' }), 'invalid-worktree-ref'],
      ['worktreeRef NUL', request({ worktreeRef: 'a\u0000b' }), 'invalid-worktree-ref'],
      ['worktreeRef newline', request({ worktreeRef: 'a\nb' }), 'invalid-worktree-ref'],
      ['worktreeRef over 512 characters', request({ worktreeRef: 'w'.repeat(513) }), 'invalid-worktree-ref'],
      ['worktreeRef numeric', request({ worktreeRef: 5 }), 'invalid-worktree-ref'],
      ['nowIso missing', without('nowIso'), 'invalid-now-iso'],
      ['nowIso empty', request({ nowIso: '' }), 'invalid-now-iso'],
      ['nowIso over 64 characters', request({ nowIso: 'n'.repeat(65) }), 'invalid-now-iso'],
      ['nowIso newline', request({ nowIso: 'a\nb' }), 'invalid-now-iso'],
      ['nowIso numeric', request({ nowIso: 7 }), 'invalid-now-iso'],
      ['nowIso null', request({ nowIso: null }), 'invalid-now-iso'],
    ];
    for (const [name, input, reason] of cases) {
      const { useCase, log } = build();

      const result = await useCase.execute(input);

      expectRefusal(result, reason);
      expect(log, name).toEqual([]);
    }
  });

  it('refuses unsupported or missing isolation without silent downgrade', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing', without('isolation')],
      ['unknown kind', request({ isolation: 'vm' })],
      ['wrong case', request({ isolation: 'MICROVM' })],
      ['empty', request({ isolation: '' })],
      ['numeric', request({ isolation: 5 })],
      ['null', request({ isolation: null })],
      ['object', request({ isolation: { kind: 'microvm' } })],
    ];
    for (const [name, input] of cases) {
      const { useCase, log } = build();

      expectRefusal(await useCase.execute(input), 'unsupported-isolation');
      expect(log, name).toEqual([]);
    }

    // A driver that supports only microvm refuses user-space-kernel; the use case never retries with a weaker kind.
    const microvmOnly = build({ inner: new InMemoryMicroVmDriver({ supportedIsolations: ['microvm'] }) });
    expectRefusal(await microvmOnly.useCase.execute(request({ isolation: 'user-space-kernel' })), 'create-failed');
    expect(microvmOnly.log).toEqual(['create:attempt-1.impl']);
    expect(microvmOnly.inner.recordedCalls().map((call) => [call.step, call.reason])).toEqual([
      ['create', 'unsupported-isolation'],
    ]);
  });

  it('returns unavailable when a required driver or gate method is missing and skips work when optional runWork is omitted', async () => {
    for (const method of ['create', 'injectWorktree', 'seal', 'destroy'] as const) {
      const { useCase, log } = build({ omitMethod: method });

      expectRefusal(await useCase.execute(request()), 'unavailable');
      expect(log, method).toEqual([]);
    }

    const noGate = build({ gate: 'missing' });
    expectRefusal(await noGate.useCase.execute(request()), 'unavailable');
    expect(noGate.log).toEqual([]);

    const badWork = build({ work: 'not-a-function' });
    expectRefusal(await badWork.useCase.execute(request()), 'unavailable');
    expect(badWork.log).toEqual([]);

    const noWork = build({ work: 'none' });
    expect(await noWork.useCase.execute(request())).toMatchObject({ ok: true });
    expect(noWork.log).toEqual([
      'create:attempt-1.impl',
      'inject',
      'seal',
      'destroy:env-1',
      'create:attempt-1.gate',
      'inject',
      'seal',
      'gate',
      'destroy:env-2',
    ]);
  });
});
