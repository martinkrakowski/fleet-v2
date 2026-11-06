// KS2c: the gate reuses a recorded receipt when every key component is equal, with the real store and the real readers.
import { describe, expect, it } from 'vitest';

import {
  GatePredicateAdapter,
  readGateDeclaredEnvironmentDigest,
  readGateToolchainVersions,
} from '../GatePredicateAdapter.adapter.js';
import type { GatePredicateAdapterOptions } from '../GatePredicateAdapter.adapter.js';
import { GateReceiptReuseAdapter } from '../GateReceiptReuseAdapter.adapter.js';
import type {
  FindGateReceiptResult,
  GateReceiptReusePort,
  RecordGateReceiptRequest,
  RecordGateReceiptResult,
} from '../../../application/ports/out/GateReceiptReusePort.out-port.js';
import type {
  EvaluateGatePredicatesRequest,
  EvaluateGatePredicatesResult,
  GatePredicateResult,
} from '../../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneDiffCheckPort } from '../../../application/ports/out/LaneDiffCheckPort.out-port.js';
import type { GateReceiptKey } from '../../../domain/gate-receipt-key.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const WORKTREE = '/lanes/reuse-wiring';
const DECLARED_VALUE = 'declared-value-ZZZ-9137';

interface Call {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

/** Answers git, the four version probes, `cat turbo.json`, `printenv` and the gate command itself. */
class ScriptedExecutor implements CommandExecutorPort {
  readonly calls: Call[] = [];
  readonly gateRuns: string[] = [];
  treeHash = TREE;
  versions: Record<string, string> = {
    node: 'v22.23.3',
    yarn: '4.12.0',
    hexagen: 'hexagen 1.2.3',
    turbo: 'turbo 2.5.4',
  };
  turboJson: string | null = JSON.stringify({ tasks: { build: { env: ['DECLARED_ONE'] } } });
  env: Record<string, string> = { DECLARED_ONE: DECLARED_VALUE };
  failingProbes = new Set<string>();
  throwEverything = false;
  gateExit: Record<string, number> = {};

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    if (this.throwEverything) {
      throw new Error('executor crashed');
    }
    this.calls.push({ argv, options });
    const ok = (stdout: string): CommandRunResult => ({ exitCode: 0, signal: null, stdout, stderr: '' });
    const head = argv[0] ?? '';
    if (head === 'git') {
      if (argv.includes('--verify')) {
        return ok(this.treeHash + '\n');
      }
      if (argv.includes('rev-parse')) {
        return ok(HEAD + '\n');
      }
      return ok(argv.includes('rev-list') ? '2\n' : '');
    }
    if (this.failingProbes.has(argv.join(' '))) {
      return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', error: 'timed out' };
    }
    if (argv[1] === '--version' && this.versions[head] !== undefined) {
      return ok((this.versions[head] ?? '') + '\n');
    }
    if (head === 'cat') {
      return this.turboJson === null
        ? { exitCode: 1, signal: null, stdout: '', stderr: 'no such file' }
        : ok(this.turboJson);
    }
    if (head === 'printenv') {
      const value = this.env[argv[1] ?? ''];
      return value === undefined ? { exitCode: 1, signal: null, stdout: '', stderr: '' } : ok(value + '\n');
    }
    // After `fleet-gate <worktree>` comes the declared gate-slot prefix (env, two settings, the wrapper) or the command.
    const rest = argv.slice(argv.indexOf('fleet-gate') + 2);
    const name = (rest[0] === '/usr/bin/env' ? rest[4] : rest[0]) ?? '';
    this.gateRuns.push(name);
    return { exitCode: this.gateExit[name] ?? 0, signal: null, stdout: '', stderr: '' };
  }
}

const cleanDiff: LaneDiffCheckPort = { checkLaneDiff: async () => ({ outcome: 'clean' }) };

function requestWith(commands: ReadonlyArray<readonly string[]>): EvaluateGatePredicatesRequest {
  return {
    attemptId: 'attempt-1',
    worktreePath: WORKTREE,
    runner: null,
    baseCommit: BASE,
    candidateHeadSha: HEAD,
    allowedPathPrefixes: ['src'],
    spec: { commitRequired: true, diffCheck: true, commands: commands.map((argv) => ({ argv })) },
  };
}

function adapterOver(
  executor: CommandExecutorPort,
  store: GateReceiptReusePort,
  slots: number | undefined = undefined,
  overrides: Partial<GatePredicateAdapterOptions> = {},
): GatePredicateAdapter {
  return new GatePredicateAdapter({
    executorForRecordedHost: () => ({
      ok: true,
      executor,
      hostSpec: {
        transport: 'local',
        runner: {
          kind: 'opencode',
          port: 4096,
          ...(slots === undefined ? {} : { gateSlot: { path: '/usr/local/bin/gate-slot', slots } }),
        },
      },
    }),
    laneDiffCheckFor: () => cleanDiff,
    receiptReuse: {
      port: store,
      toolchainVersions: readGateToolchainVersions,
      declaredEnvironmentDigest: readGateDeclaredEnvironmentDigest,
    },
    ...overrides,
  });
}

function commandResults(result: EvaluateGatePredicatesResult): GatePredicateResult[] {
  expect(result.outcome).toBe('evaluated');
  if (result.outcome !== 'evaluated') {
    throw new Error('expected evaluated');
  }
  return result.results.slice(2);
}

/** The real in-memory store, remembering the keys it recorded. */
class SpyStore implements GateReceiptReusePort {
  readonly inner = new GateReceiptReuseAdapter();
  readonly recorded: GateReceiptKey[] = [];
  finds = 0;
  findGateReceipt(key: GateReceiptKey): Promise<FindGateReceiptResult> {
    this.finds += 1;
    return this.inner.findGateReceipt(key);
  }
  async recordGateReceipt(request: RecordGateReceiptRequest): Promise<RecordGateReceiptResult> {
    const result = await this.inner.recordGateReceipt(request);
    if (result.outcome === 'recorded') {
      this.recorded.push(request.key);
    }
    return result;
  }
}

const GATE = ['gate-a'];

describe('gate receipt reuse wiring (KS2c)', () => {
  it('reuses an equal key and skips the run', async () => {
    const store = new SpyStore();
    const executor = new ScriptedExecutor();
    const adapter = adapterOver(executor, store);
    const first = commandResults(await adapter.evaluateGatePredicates(requestWith([GATE])));
    expect(first[0]).toMatchObject({ verdict: 'pass', detail: 'exit 0' });
    const second = commandResults(await adapter.evaluateGatePredicates(requestWith([GATE])));
    expect(executor.gateRuns).toEqual(['gate-a']);
    expect(second[0]).toMatchObject({ verdict: 'pass', exitCode: 0, durationMs: 0 });
    expect(second[0]?.detail.startsWith('reused receipt: ')).toBe(true);
  });

  it('misses on a changed tree, definition, toolchain or declared environment', async () => {
    const store = new SpyStore();
    await adapterOver(new ScriptedExecutor(), store).evaluateGatePredicates(requestWith([GATE]));
    expect(store.recorded).toHaveLength(1);

    const changedTree = new ScriptedExecutor();
    changedTree.treeHash = 'd'.repeat(40);
    await adapterOver(changedTree, store).evaluateGatePredicates(requestWith([GATE]));
    expect(changedTree.gateRuns).toEqual(['gate-a']);

    const changedDefinition = new ScriptedExecutor();
    await adapterOver(changedDefinition, store).evaluateGatePredicates(requestWith([['gate-a', '--changed']]));
    expect(changedDefinition.gateRuns).toEqual(['gate-a']);

    const changedToolchain = new ScriptedExecutor();
    changedToolchain.versions.node = 'v24.0.0';
    await adapterOver(changedToolchain, store).evaluateGatePredicates(requestWith([GATE]));
    expect(changedToolchain.gateRuns).toEqual(['gate-a']);

    const changedEnvironment = new ScriptedExecutor();
    changedEnvironment.env.DECLARED_ONE = 'another declared value';
    await adapterOver(changedEnvironment, store).evaluateGatePredicates(requestWith([GATE]));
    expect(changedEnvironment.gateRuns).toEqual(['gate-a']);

    // The unchanged baseline is still reused.
    const unchanged = new ScriptedExecutor();
    await adapterOver(unchanged, store).evaluateGatePredicates(requestWith([GATE]));
    expect(unchanged.gateRuns).toEqual([]);
  });

  it('misses when the store is unreadable', async () => {
    const broken: GateReceiptReusePort = {
      findGateReceipt: async () => {
        throw new Error('store unreadable');
      },
      recordGateReceipt: async () => {
        throw new Error('store unreadable');
      },
    };
    const executor = new ScriptedExecutor();
    const results = commandResults(await adapterOver(executor, broken).evaluateGatePredicates(requestWith([GATE])));
    expect(executor.gateRuns).toEqual(['gate-a']);
    expect(results[0]).toMatchObject({ verdict: 'pass', detail: 'exit 0' });
  });

  it('records the reuse in the recorded receipt', async () => {
    const store = new SpyStore();
    const executor = new ScriptedExecutor();
    const adapter = adapterOver(executor, store);
    await adapter.evaluateGatePredicates(requestWith([GATE]));
    const reused = commandResults(await adapter.evaluateGatePredicates(requestWith([GATE])));
    expect(reused[0]?.detail.startsWith('reused receipt: ')).toBe(true);
    expect(store.recorded).toHaveLength(1);
    const key = store.recorded[0];
    if (key === undefined) {
      throw new Error('expected a recorded key');
    }
    const found = await store.inner.findGateReceipt(key);
    expect(found).toMatchObject({ outcome: 'hit', verdict: 'pass' });
    if (found.outcome === 'hit') {
      expect(reused[0]?.detail).toBe('reused receipt: ' + found.receiptRef);
    }
  });

  it('keeps the first non-pass in declared order with a mix of reused and fresh predicates', async () => {
    for (const slots of [undefined, 3]) {
      const store = new SpyStore();
      await adapterOver(new ScriptedExecutor(), store, slots).evaluateGatePredicates(requestWith([['gate-a']]));
      const executor = new ScriptedExecutor();
      executor.gateExit['gate-b'] = 1;
      const results = commandResults(
        await adapterOver(executor, store, slots).evaluateGatePredicates(requestWith([['gate-a'], ['gate-b']])),
      );
      expect(executor.gateRuns).toEqual(['gate-b']);
      expect(results.map((result) => result.name)).toEqual(['command 1: gate-a', 'command 2: gate-b']);
      expect(results.map((result) => result.verdict)).toEqual(['pass', 'fail']);
      expect(results[0]?.detail.startsWith('reused receipt: ')).toBe(true);
      expect(results.find((result) => result.verdict !== 'pass')?.name).toBe('command 2: gate-b');
    }
  });

  it('never throws on runtime input', async () => {
    const store = new SpyStore();
    const adapter = adapterOver(new ScriptedExecutor(), store);
    for (const malformed of [null, undefined, {}, { ...requestWith([GATE]), spec: null }]) {
      const result = await adapter.evaluateGatePredicates(malformed as unknown as EvaluateGatePredicatesRequest);
      expect(result).toEqual({ outcome: 'unavailable', reason: 'gate predicate request is malformed' });
    }

    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile read');
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('hostile descriptor');
        },
      },
    );
    const hostileProviders: Array<Partial<GatePredicateAdapterOptions['receiptReuse']>> = [
      { toolchainVersions: async () => hostile },
      { declaredEnvironmentDigest: async () => hostile },
      {
        toolchainVersions: async () => {
          throw new Error('provider threw');
        },
      },
    ];
    for (const provider of hostileProviders) {
      const executor = new ScriptedExecutor();
      const results = commandResults(
        await adapterOver(executor, store, undefined, {
          receiptReuse: {
            port: store,
            toolchainVersions: readGateToolchainVersions,
            declaredEnvironmentDigest: readGateDeclaredEnvironmentDigest,
            ...provider,
          },
        }).evaluateGatePredicates(requestWith([GATE])),
      );
      expect(executor.gateRuns).toEqual(['gate-a']);
      expect(results[0]).toMatchObject({ verdict: 'pass', detail: 'exit 0' });
    }

    for (const turboJson of ['{"tasks": ', '[]', '{"tasks":{"build":{"env":[]}}}']) {
      const executor = new ScriptedExecutor();
      executor.turboJson = turboJson;
      const results = commandResults(
        await adapterOver(executor, store).evaluateGatePredicates(requestWith([GATE])),
      );
      expect(executor.gateRuns).toEqual(['gate-a']);
      expect(results[0]).toMatchObject({ verdict: 'pass', detail: 'exit 0' });
    }

    const crashing = new ScriptedExecutor();
    crashing.throwEverything = true;
    const crashed = await adapterOver(crashing, store).evaluateGatePredicates(requestWith([GATE]));
    if (crashed.outcome === 'evaluated') {
      expect(crashed.results.some((result) => result.kind === 'command' && result.verdict === 'pass')).toBe(false);
    } else {
      expect(crashed.outcome).toBe('unavailable');
    }
  });

  it('guards every receipt-input call', async () => {
    const executor = new ScriptedExecutor();
    await adapterOver(executor, new SpyStore()).evaluateGatePredicates(requestWith([GATE]));
    const probes = executor.calls.filter((call) => ['node', 'yarn', 'hexagen', 'turbo', 'cat', 'printenv'].includes(call.argv[0] ?? ''));
    expect(probes).toHaveLength(6);
    for (const call of probes) {
      expect(typeof call.options?.timeoutMs).toBe('number');
      expect(typeof call.options?.maxBufferBytes).toBe('number');
    }

    // A probe that timed out is a miss: the command runs again and no receipt is reused.
    const store = new SpyStore();
    await adapterOver(new ScriptedExecutor(), store).evaluateGatePredicates(requestWith([GATE]));
    const slow = new ScriptedExecutor();
    slow.failingProbes.add('printenv DECLARED_ONE');
    const results = commandResults(await adapterOver(slow, store).evaluateGatePredicates(requestWith([GATE])));
    expect(slow.gateRuns).toEqual(['gate-a']);
    expect(results[0]?.detail).toBe('exit 0');
  });

  it('records one receipt per key', async () => {
    const store = new SpyStore();
    const executor = new ScriptedExecutor();
    const adapter = adapterOver(executor, store);
    await adapter.evaluateGatePredicates(requestWith([GATE]));
    await adapter.evaluateGatePredicates(requestWith([GATE]));
    expect(store.recorded).toHaveLength(1);
    const key = store.recorded[0];
    if (key === undefined) {
      throw new Error('expected a recorded key');
    }
    const before = await store.inner.findGateReceipt(key);
    const again = await store.inner.recordGateReceipt({ key, verdict: 'pass', receiptRef: 'gate-pass:another' });
    expect(again).toEqual({ outcome: 'already-recorded' });
    await expect(store.inner.findGateReceipt(key)).resolves.toEqual(before);
  });

  it('an unreadable component is a miss, never a reuse', async () => {
    const store = new SpyStore();
    await adapterOver(new ScriptedExecutor(), store).evaluateGatePredicates(requestWith([GATE]));

    const unreadable: Array<[string, (executor: ScriptedExecutor) => void]> = [
      ['toolchain', (executor) => executor.failingProbes.add('yarn --version')],
      ['toolchain without a digit', (executor) => (executor.versions.turbo = 'turbo unknown')],
      ['environment file', (executor) => (executor.turboJson = null)],
      ['environment value', (executor) => executor.failingProbes.add('printenv DECLARED_ONE')],
    ];
    for (const [, break_] of unreadable) {
      const executor = new ScriptedExecutor();
      break_(executor);
      executor.gateExit['gate-a'] = 1;
      const results = commandResults(await adapterOver(executor, store).evaluateGatePredicates(requestWith([GATE])));
      // The recorded pass is not reused: the command ran again and its own failure is the verdict.
      expect(executor.gateRuns).toEqual(['gate-a']);
      expect(results[0]).toMatchObject({ verdict: 'fail', detail: 'exit 1' });
    }

    const unreadableStore: GateReceiptReusePort = {
      findGateReceipt: async () => {
        throw new Error('store unreadable');
      },
      recordGateReceipt: async () => ({ outcome: 'refused', reason: 'store-unreadable' }),
    };
    const executor = new ScriptedExecutor();
    executor.gateExit['gate-a'] = 1;
    const results = commandResults(
      await adapterOver(executor, unreadableStore).evaluateGatePredicates(requestWith([GATE])),
    );
    expect(executor.gateRuns).toEqual(['gate-a']);
    expect(results[0]).toMatchObject({ verdict: 'fail', detail: 'exit 1' });
  });

  it('echoes no secret-shaped text and no path', async () => {
    const store = new SpyStore();
    const executor = new ScriptedExecutor();
    const adapter = adapterOver(executor, store);
    await adapter.evaluateGatePredicates(requestWith([GATE]));
    const reused = commandResults(await adapter.evaluateGatePredicates(requestWith([GATE])));
    expect(reused[0]?.detail).toMatch(/^reused receipt: gate-pass:[0-9a-f]{32}$/);
    const echoed = JSON.stringify(reused) + JSON.stringify(store.recorded);
    expect(echoed).not.toContain(DECLARED_VALUE);
    expect(echoed).not.toContain(WORKTREE);
    expect(echoed).not.toContain('DECLARED_ONE');
    const key = store.recorded[0];
    expect(key?.declaredEnvironmentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
