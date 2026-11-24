// CB1b: install-tail capture and deferring the environment check until a receipt misses.
/**
 * A failed `yarn install --immutable` keeps a 4 KiB secret-screened tail.
 * A cached passing receipt never installs. A non-yarn worktree never installs
 * and never reports `environment-not-installed`.
 */

import { describe, expect, it } from 'vitest';

import { GatePredicateAdapter } from '../GatePredicateAdapter.adapter.js';
import type { GatePredicateAdapterOptions } from '../GatePredicateAdapter.adapter.js';
import type {
  EvaluateGatePredicatesRequest,
  GatePredicateResult,
} from '../../../application/ports/out/GatePredicatePort.out-port.js';
import type { GateReceiptReusePort } from '../../../application/ports/out/GateReceiptReusePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneDiffCheckPort, LaneDiffCheckResult } from '../../../application/ports/out/LaneDiffCheckPort.out-port.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const WORKTREE = '/lanes/w1';
const DIGEST = 'ab'.repeat(32);
const TOOLCHAIN = { node: '22.23.3', yarn: '4.12.0', hexagen: '1.2.3', turbo: '2.5.4' };

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

function isYarnProjectProbe(argv: readonly string[]): boolean {
  return argv[0] === 'test' && argv.includes('-a');
}

class ScriptedExecutor implements CommandExecutorPort {
  readonly argvRecords: string[][] = [];

  constructor(
    private readonly script: (argv: readonly string[]) => Partial<CommandRunResult>,
    private readonly yarnProject = true,
  ) {}

  async run(argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.argvRecords.push([...argv]);
    if (isYarnProjectProbe(argv)) {
      return { exitCode: this.yarnProject ? 0 : 1, signal: null, stdout: '', stderr: '' };
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', ...this.script(argv) };
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
  constructor(private readonly result: LaneDiffCheckResult) {}
  async checkLaneDiff(): Promise<LaneDiffCheckResult> {
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
  executor: CommandExecutorPort,
  options: Partial<GatePredicateAdapterOptions> = {},
): GatePredicateAdapter {
  let now = 0;
  return new GatePredicateAdapter({
    executorForRecordedHost: () => ({ ok: true, executor }),
    laneDiffCheckFor: () => new FakeLaneDiffCheck({ outcome: 'clean' }),
    nowMs: () => {
      now += 1;
      return now;
    },
    ...options,
  });
}

function commandResults(
  result: Awaited<ReturnType<GatePredicateAdapter['evaluateGatePredicates']>>,
): readonly GatePredicateResult[] {
  expect(result.outcome).toBe('evaluated');
  if (result.outcome !== 'evaluated') {
    throw new Error('expected evaluated');
  }
  return result.results.slice(2);
}

function installExecutor(install: Partial<CommandRunResult>, yarnProject = true): ScriptedExecutor {
  return new ScriptedExecutor((argv) => {
    if (argv[0] === 'test') {
      return { exitCode: 1 };
    }
    if (argv[0] === 'sh' && argv.includes('--immutable')) {
      return install;
    }
    return happyGit(argv);
  }, yarnProject);
}

const hittingStore: GateReceiptReusePort = {
  async findGateReceipt() {
    return { outcome: 'hit', verdict: 'pass', receiptRef: 'gate-pass:cached' };
  },
  async recordGateReceipt() {
    return { outcome: 'recorded' };
  },
};

describe('GatePredicateAdapter environment install tail (CB1b)', () => {
  const secretLine = 'sk-' + 'a'.repeat(24);

  it('install failure attaches bounded 4 KiB redacted outputTail', async () => {
    const marker = 'INSTALL-TAIL-MARKER';
    const stderr = 'H'.repeat(20_000) + '\n' + marker + '\n';
    const executor = installExecutor({ exitCode: 1, stderr });
    const results = commandResults(await makeAdapter(executor).evaluateGatePredicates(request(1)));
    expect(executor.installs()).toBe(1);
    expect(executor.commands()).toBe(0);
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: 1,
      outputTail: marker,
    });
    expect(Buffer.byteLength(results[0]?.outputTail ?? '', 'utf8')).toBeLessThanOrEqual(4 * 1024);
    expect(results[0]?.outputTail).not.toContain('HHH');
  });

  it('empty install output omits outputTail', async () => {
    for (const streams of [
      { stdout: '', stderr: '' },
      { stdout: ' \n\t', stderr: '\n' },
      { stdout: '   ', stderr: '' },
    ]) {
      const executor = installExecutor({ exitCode: 1, ...streams });
      const results = commandResults(await makeAdapter(executor).evaluateGatePredicates(request(1)));
      expect(results[0]).toMatchObject({ verdict: 'unknown', cause: 'environment-not-installed', exitCode: 1 });
      expect(results[0]).not.toHaveProperty('outputTail');
    }
  });

  it('secret-shaped install output is redacted or withheld', async () => {
    const executor = installExecutor({ exitCode: 1, stderr: 'lockfile drift\n' + secretLine + '\n' });
    const results = commandResults(await makeAdapter(executor).evaluateGatePredicates(request(1)));
    const tail = results[0]?.outputTail ?? '';
    expect(results[0]).toMatchObject({ verdict: 'unknown', cause: 'environment-not-installed' });
    expect(
      tail === '[output withheld: secret-shaped text]' || tail.includes('[redacted: secret-shaped line]'),
    ).toBe(true);
    expect(tail).not.toContain(secretLine);
    expect(tail).not.toContain('sk-');
  });

  it('install timeout or executor throw returns unknown environment-not-installed', async () => {
    const timedOut = installExecutor({ exitCode: null, error: 'timed out', stdout: 'partial install log\n' });
    const timeoutResults = commandResults(await makeAdapter(timedOut).evaluateGatePredicates(request(1)));
    expect(timeoutResults[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: null,
      outputTail: 'partial install log',
    });
    expect(timeoutResults[0]?.verdict).not.toBe('pass');

    const crashing: CommandExecutorPort = {
      async run(argv: readonly string[]): Promise<CommandRunResult> {
        if (argv[0] === 'git') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', ...happyGit(argv) };
        }
        if (argv[0] === 'test') {
          return { exitCode: argv.includes('-a') ? 0 : 1, signal: null, stdout: '', stderr: '' };
        }
        throw new Error('install crashed');
      },
    };
    const thrown = commandResults(await makeAdapter(crashing).evaluateGatePredicates(request(1)));
    expect(thrown[0]).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: null,
    });
    expect(thrown[0]).not.toHaveProperty('outputTail');
    expect(thrown[0]?.verdict).not.toBe('pass');
  });

  it('exhausted budget returns unknown', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 0 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: 0, stdout: 'ok\n' };
      }
      return happyGit(argv);
    });
    const results = commandResults(
      await makeAdapter(executor, {
        isRemote: () => {
          throw new Error('budgeted command task failed');
        },
      }).evaluateGatePredicates(request(1)),
    );
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      exitCode: null,
      detail: 'command did not complete',
    });
    expect(results[0]?.verdict).not.toBe('pass');
    expect(results[0]).not.toHaveProperty('cause');
  });

  it('throwing stdout getter does not crash install tail', async () => {
    const hostile: CommandExecutorPort = {
      async run(argv: readonly string[]): Promise<CommandRunResult> {
        if (argv[0] === 'git') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', ...happyGit(argv) };
        }
        if (argv[0] === 'test') {
          return { exitCode: argv.includes('-a') ? 0 : 1, signal: null, stdout: '', stderr: '' };
        }
        return {
          exitCode: 1,
          signal: null,
          get stdout(): string {
            throw new Error('stdout getter');
          },
          get stderr(): string {
            throw new Error('stderr getter');
          },
        };
      },
    };
    const results = commandResults(await makeAdapter(hostile).evaluateGatePredicates(request(1)));
    expect(results[0]).toMatchObject({ verdict: 'unknown', cause: 'environment-not-installed' });
    expect(results[0]).not.toHaveProperty('outputTail');
    expect(results[0]?.verdict).not.toBe('pass');
  });

  it('non-yarn worktree never installs and never returns environment-not-installed', async () => {
    const executor = installExecutor({ exitCode: 1, stderr: 'should not install\n' }, false);
    const results = commandResults(await makeAdapter(executor).evaluateGatePredicates(request(2)));
    expect(executor.installs()).toBe(0);
    expect(executor.commands()).toBe(2);
    for (const result of results) {
      expect(result).toMatchObject({ verdict: 'pass', exitCode: 0 });
      expect(result.cause).toBeUndefined();
    }
  });

  it('cached receipt pass skips ensureEnvironment', async () => {
    const executor = new ScriptedExecutor((argv) => {
      if (argv[0] === 'test') {
        return { exitCode: 1 };
      }
      if (argv[0] === 'sh') {
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });
    const results = commandResults(
      await makeAdapter(executor, {
        receiptReuse: {
          port: hittingStore,
          toolchainVersions: async () => TOOLCHAIN,
          declaredEnvironmentDigest: async () => DIGEST,
        },
      }).evaluateGatePredicates(request(1)),
    );
    expect(results[0]).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(results[0]?.detail.startsWith('reused receipt: ')).toBe(true);
    expect(results[0]?.cause).toBeUndefined();
    expect(executor.installs()).toBe(0);
    expect(executor.commands()).toBe(0);
    expect(executor.argvRecords.some((argv) => argv[0] === 'test')).toBe(false);
  });
});
