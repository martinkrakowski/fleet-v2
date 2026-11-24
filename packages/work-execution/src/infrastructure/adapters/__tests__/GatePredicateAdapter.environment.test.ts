// GatePredicateAdapter environment tests — worktree dependency installation.
/**
 * Covers the worktree-environment behaviour of GatePredicateAdapter: before
 * the first command predicate of a gate run the adapter probes
 * `<worktreePath>/node_modules/.yarn-state.yml` through the host executor,
 * runs at most one bounded `yarn install --immutable` when it is absent, and
 * reclassifies missing-module command failures as
 * `cause: 'environment-not-installed'` only while the state file is absent.
 *
 * Cost bound proved here: per gate run the environment adds exactly one
 * `test -f` probe and at most one `yarn install --immutable` (plus its
 * re-probe), no matter how many command predicates run.
 *
 * These tests fail against a constant `unknown` implementation (they assert
 * real `pass` verdicts and real command runs) and against an implementation
 * that never installs (they assert the install argv actually ran).
 */

import { describe, expect, it } from 'vitest';

import { GatePredicateAdapter } from '../GatePredicateAdapter.adapter.js';
import type { GatePredicateAdapterOptions } from '../GatePredicateAdapter.adapter.js';
import type {
  EvaluateGatePredicatesRequest,
  GatePredicateResult,
} from '../../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneDiffCheckPort, LaneDiffCheckResult } from '../../../application/ports/out/LaneDiffCheckPort.out-port.js';
import type { RunnerForAttemptHostSpec } from '../ConfirmRecordedHost.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const WORKTREE = '/lanes/w1';

function request(commands: number): EvaluateGatePredicatesRequest {
  return {
    attemptId: 'attempt-1',
    worktreePath: WORKTREE,
    runner: null,
    baseCommit: BASE,
    candidateHeadSha: HEAD,
    allowedPathPrefixes: ['src'],
    spec: {
      commitRequired: true,
      diffCheck: true,
      commands: Array.from({ length: commands }, () => ({ argv: ['corepack', 'yarn', 'build'] })),
    },
  };
}

class ScriptedExecutor implements CommandExecutorPort {
  readonly argvRecords: string[][] = [];

  constructor(
    private readonly script: (argv: readonly string[]) => Partial<CommandRunResult>,
  ) {}

  async run(argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.argvRecords.push([...argv]);
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      ...this.script(argv),
    };
  }

  probes(): number {
    return this.argvRecords.filter((argv) => argv[0] === 'test' && argv[1] === '-f').length;
  }

  installs(): number {
    return this.argvRecords.filter(
      (argv) => argv[0] === 'sh' && argv.includes('install') && argv.includes('--immutable'),
    ).length;
  }

  commands(): number {
    return this.argvRecords.filter((argv) => argv[0] === 'sh' && !argv.includes('--immutable')).length;
  }
}

class FakeLaneDiffCheck implements LaneDiffCheckPort {
  calls = 0;
  constructor(private readonly result: LaneDiffCheckResult) {}
  async checkLaneDiff(): Promise<LaneDiffCheckResult> {
    this.calls += 1;
    return this.result;
  }
}

function gitSubcommand(argv: readonly string[]): string | null {
  for (const sub of ['rev-parse', 'merge-base', 'rev-list', 'status']) {
    if (argv.includes(sub)) {
      return sub;
    }
  }
  return null;
}

function happyGit(argv: readonly string[]): Partial<CommandRunResult> {
  const sub = gitSubcommand(argv);
  if (sub === 'rev-parse') {
    return { stdout: HEAD + '\n' };
  }
  if (sub === 'rev-list') {
    return { stdout: '2\n' };
  }
  return { exitCode: 0 };
}

function makeAdapter(
  executor: ScriptedExecutor,
  options: Partial<GatePredicateAdapterOptions> = {},
  hostSpec?: RunnerForAttemptHostSpec,
): { adapter: GatePredicateAdapter } {
  const fakeDiff = new FakeLaneDiffCheck({ outcome: 'clean' });
  let now = 0;
  const adapter = new GatePredicateAdapter({
    executorForRecordedHost: () =>
      hostSpec === undefined ? { ok: true, executor } : { ok: true, executor, hostSpec },
    laneDiffCheckFor: () => fakeDiff,
    nowMs: () => {
      now += 1;
      return now;
    },
    ...options,
  });
  return { adapter };
}

function evaluatedResults(
  result: Awaited<ReturnType<GatePredicateAdapter['evaluateGatePredicates']>>,
): readonly GatePredicateResult[] {
  expect(result.outcome).toBe('evaluated');
  if (result.outcome !== 'evaluated') {
    throw new Error('expected evaluated');
  }
  return result.results;
}

/** The command results (everything after commit and diff-check). */
function commandResultsOf(results: readonly GatePredicateResult[]): GatePredicateResult[] {
  return results.slice(2);
}

describe('GatePredicateAdapter worktree environment', () => {
  it('runs no install and still passes the command when the dependency state file is present', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 0 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0]).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(executor.installs()).toBe(0);
    expect(executor.commands()).toBe(1);
    expect(executor.probes()).toBe(1);
  });

  it('installs once, re-probes, and passes both commands when the state file is absent', async () => {
    let installed = false;
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: installed ? 0 : 1 };
      }
      if (argv[0] === 'sh') {
        if (argv.includes('--immutable')) {
          installed = true;
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(2))));
    expect(executor.installs()).toBe(1);
    expect(executor.commands()).toBe(2);
    for (const result of results) {
      expect(result).toMatchObject({ verdict: 'pass', exitCode: 0 });
    }
  });

  it('installs at most once per gate run even when several commands run concurrently', async () => {
    const slotSpec: RunnerForAttemptHostSpec = {
      transport: 'local',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4096, gateSlot: { path: '/usr/local/bin/gate-slot', slots: 4 } },
    };
    let installed = false;
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: installed ? 0 : 1 };
      }
      if (argv[0] === 'sh') {
        if (argv.includes('--immutable')) {
          installed = true;
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor, { maxConcurrentPredicates: 4 }, slotSpec);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(3))));
    expect(executor.installs()).toBe(1);
    expect(results.every((result) => result.verdict === 'pass')).toBe(true);
  });

  it('returns environment-not-installed for every command and runs none when the install fails', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 1 };
      }
      if (argv[0] === 'sh') {
        if (argv.includes('--immutable')) {
          return { exitCode: 1, stderr: 'error: lockfile would have been modified\n' };
        }
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(2))));
    expect(executor.commands()).toBe(0);
    expect(results.length).toBe(2);
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: 1,
      detail: 'dependencies not installed in the worktree',
    });
    expect(results[0]).not.toHaveProperty('outputTail');
    expect(results[0]).not.toHaveProperty('failingFile');
    // Sequential gate: the second command is skipped after the first non-pass.
    expect(results[1]).toMatchObject({ verdict: 'skipped' });
    expect(executor.installs()).toBe(1);
  });

  it('returns environment-not-installed when the install succeeds but the state file is still absent', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 1 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(executor.installs()).toBe(1);
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: 0,
    });
    expect(results[0]).not.toHaveProperty('outputTail');
  });

  it('returns environment-not-installed when the install itself times out (executor error)', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 1 };
      }
      if (argv[0] === 'sh' && argv.includes('--immutable')) {
        return { exitCode: null, error: 'timed out' };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: null,
    });
  });

  it('reclassifies a missing-module failure as environment-not-installed while the state file is absent', async () => {
    // The state file is present when the command starts and gone when it
    // fails naming a missing module: the failure is the environment's.
    let stateFile = true;
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: stateFile ? 0 : 1 };
      }
      if (argv[0] === 'sh') {
        if (argv.includes('--immutable')) {
          return { exitCode: 0 };
        }
        stateFile = false;
        return { exitCode: 1, stderr: 'Error: Cannot find module \'@fleet/shared\'\n' };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: 1,
    });
    expect(results[0]).not.toHaveProperty('outputTail');
    expect(results[0]).not.toHaveProperty('failingFile');
  });

  it('keeps a missing-module failure as fail when the dependency state file is present', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 0 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: 1, stderr: 'Error: Cannot find module \'@fleet/shared\'\n' };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0].verdict).toBe('fail');
    expect(results[0]).not.toHaveProperty('cause');
    expect(typeof results[0].outputTail === 'string').toBe(true);
  });

  it('spends exactly one probe and at most one install plus one re-probe per gate run (cost bound)', async () => {
    let installed = false;
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: installed ? 0 : 1 };
      }
      if (argv[0] === 'sh') {
        if (argv.includes('--immutable')) {
          installed = true;
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    await adapter.evaluateGatePredicates(request(3));
    expect(executor.probes()).toBe(2);
    expect(executor.installs()).toBe(1);
  });

  it('reports unavailable for a malformed request (non-array commands)', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    const { adapter } = makeAdapter(executor);
    const malformed = { ...request(1), spec: { commitRequired: true, diffCheck: true, commands: 'nope' } };
    const result = await adapter.evaluateGatePredicates(
      malformed as unknown as EvaluateGatePredicatesRequest,
    );
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gate predicate request is malformed',
    });
  });

  it('reports unavailable when commands carry a wrong-primitive argv entry', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    const { adapter } = makeAdapter(executor);
    const malformed = {
      ...request(1),
      spec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['ok', 42] }] },
    };
    const result = await adapter.evaluateGatePredicates(
      malformed as unknown as EvaluateGatePredicatesRequest,
    );
    expect(result.outcome).toBe('unavailable');
  });

  it('returns unknown with no cause and no output tail when the run carries an executor error', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 0 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: null, error: 'timed out', stdout: 'partial output\n' };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0].verdict).toBe('unknown');
    expect(results[0]).not.toHaveProperty('cause');
    expect(results[0]).not.toHaveProperty('outputTail');
  });

  it('returns unknown without crashing when a CommandRunResult field is a throwing getter', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    // Replace the executor's result with hostile getters on stdout/stderr.
    const hostile: CommandExecutorPort = {
      run: async (argv: readonly string[]) => {
        executor.argvRecords.push([...argv]);
        if (argv[0] === 'git') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', ...happyGit(argv) };
        }
        if (argv[0] === 'test') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
        return {
          exitCode: 1,
          signal: null,
          get stdout(): string {
            throw new Error('getter trap');
          },
          get stderr(): string {
            throw new Error('getter trap');
          },
        };
      },
    };
    const fakeDiff = new FakeLaneDiffCheck({ outcome: 'clean' });
    let now = 0;
    const guarded = new GatePredicateAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: hostile }),
      laneDiffCheckFor: () => fakeDiff,
      nowMs: () => {
        now += 1;
        return now;
      },
    });
    const results = commandResultsOf(evaluatedResults(await guarded.evaluateGatePredicates(request(1))));
    expect(results[0].verdict).toBe('unknown');
    expect(results[0].detail).toBe('command did not complete');
  });

  it('treats a null worktreePath request as unavailable rather than probing', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    const { adapter } = makeAdapter(executor);
    const malformed = { ...request(1), worktreePath: null };
    const result = await adapter.evaluateGatePredicates(
      malformed as unknown as EvaluateGatePredicatesRequest,
    );
    expect(result.outcome).toBe('unavailable');
    expect(executor.argvRecords.length).toBe(0);
  });
});

describe('GatePredicateAdapter hostile command results and requests', () => {
  it('treats exit 0 with a non-string stdout as unknown, never pass', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 0 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: 0, stdout: 42 as unknown as string };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0]).toMatchObject({ verdict: 'unknown', exitCode: null });
  });

  it('treats a string exit code as unknown, never pass', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 0 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: '0' as unknown as number };
      }
      return happyGit(argv);
    });
    const { adapter } = makeAdapter(executor);
    const results = commandResultsOf(evaluatedResults(await adapter.evaluateGatePredicates(request(1))));
    expect(results[0].verdict).toBe('unknown');
  });

  it('refuses a non-throwing getter on stdout without invoking it', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    let invocations = 0;
    const hostile: CommandExecutorPort = {
      run: async (argv: readonly string[]) => {
        executor.argvRecords.push([...argv]);
        if (argv[0] === 'git') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', ...happyGit(argv) };
        }
        if (argv[0] === 'test') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
        return {
          exitCode: 0,
          signal: null,
          stderr: '',
          get stdout(): string {
            invocations += 1;
            return 'a perfectly valid-looking output';
          },
        };
      },
    };
    const fakeDiff = new FakeLaneDiffCheck({ outcome: 'clean' });
    let now = 0;
    const guarded = new GatePredicateAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: hostile }),
      laneDiffCheckFor: () => fakeDiff,
      nowMs: () => {
        now += 1;
        return now;
      },
    });
    const results = commandResultsOf(evaluatedResults(await guarded.evaluateGatePredicates(request(1))));
    expect(results[0].verdict).toBe('unknown');
    expect(invocations).toBe(0);
  });

  it('refuses a getter on request.worktreePath without invoking it', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    const { adapter } = makeAdapter(executor);
    let invocations = 0;
    const malformed: Record<string, unknown> = { ...request(1) };
    delete malformed.worktreePath;
    Object.defineProperty(malformed, 'worktreePath', {
      get: () => {
        invocations += 1;
        return WORKTREE;
      },
    });
    const result = await adapter.evaluateGatePredicates(
      malformed as unknown as EvaluateGatePredicatesRequest,
    );
    expect(result).toEqual({ outcome: 'unavailable', reason: 'gate predicate request is malformed' });
    expect(invocations).toBe(0);
    expect(executor.argvRecords.length).toBe(0);
  });

  it('refuses a holey argv as a malformed request, running nothing', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    const { adapter } = makeAdapter(executor);
    const argv: string[] = new Array(2);
    argv[1] = 'corepack';
    const malformed = { ...request(1), spec: { commitRequired: true, diffCheck: true, commands: [{ argv }] } };
    const result = await adapter.evaluateGatePredicates(
      malformed as unknown as EvaluateGatePredicatesRequest,
    );
    expect(result).toEqual({ outcome: 'unavailable', reason: 'gate predicate request is malformed' });
    expect(executor.argvRecords.length).toBe(0);
  });

  it('refuses a holey commands array as a malformed request, running nothing', async () => {
    const executor = new ScriptedExecutor(() => ({ exitCode: 0 }));
    const { adapter } = makeAdapter(executor);
    const commands: unknown[] = new Array(2);
    commands[1] = { argv: ['corepack', 'yarn', 'build'] };
    const malformed = { ...request(1), spec: { commitRequired: true, diffCheck: true, commands } };
    const result = await adapter.evaluateGatePredicates(
      malformed as unknown as EvaluateGatePredicatesRequest,
    );
    expect(result).toEqual({ outcome: 'unavailable', reason: 'gate predicate request is malformed' });
    expect(executor.argvRecords.length).toBe(0);
  });
});
