// KS2c: the two receipt-input readers (toolchain versions, declared environment digest) over a scripted executor.
import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  readGateDeclaredEnvironmentDigest,
  readGateToolchainVersions,
} from '../GatePredicateAdapter.adapter.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';

const WORKTREE = '/lanes/probe-worktree';
/** `hexagen`/`turbo` are project dependencies: the probe names their binary in the worktree's `node_modules/.bin`. */
const HEXAGEN_BIN = join(WORKTREE, 'node_modules/.bin/hexagen');
const TURBO_BIN = join(WORKTREE, 'node_modules/.bin/turbo');

type Answer = Partial<CommandRunResult> | 'throw';

interface Call {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

class ProbeExecutor implements CommandExecutorPort {
  readonly calls: Call[] = [];

  constructor(private readonly answers: Readonly<Record<string, Answer>>) {}

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ argv, options });
    // Every probe runs inside the worktree through the `cd` wrapper; answers are
    // keyed by the wrapped command after its `fleet-probe` marker.
    const inner = argv[0] === '/usr/bin/env' && argv[1] === '-C' ? argv.slice(3) : argv;
    const answer = this.answers[inner.join(' ')];
    if (answer === 'throw') {
      throw new Error('executor died');
    }
    if (answer === undefined) {
      return { exitCode: 127, signal: null, stdout: '', stderr: 'not found' };
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', ...answer };
  }
}

const VERSIONS: Record<string, Answer> = {
  'node --version': { stdout: 'v22.23.3\n' },
  'yarn --version': { stdout: '4.12.0\n' },
  [HEXAGEN_BIN + ' --version']: { stdout: 'hexagen 1.2.3\n' },
  [TURBO_BIN + ' --version']: { stdout: 'turbo 2.5.4\n' },
};

function turboJson(env: Record<string, readonly string[]>): string {
  const tasks: Record<string, { env: readonly string[] }> = {};
  for (const [task, names] of Object.entries(env)) {
    tasks[task] = { env: names };
  }
  return JSON.stringify({ tasks });
}

function environment(
  document: string,
  values: Record<string, string | null>,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {
    [`cat ${join(WORKTREE, 'turbo.json')}`]: { stdout: document },
  };
  for (const [name, value] of Object.entries(values)) {
    answers['printenv ' + name] = value === null ? { exitCode: 1 } : { stdout: value + '\n' };
  }
  return answers;
}

const DECLARED = turboJson({ build: ['DECLARED_ONE'], test: ['DECLARED_TWO', 'DECLARED_ONE'] });

describe('gate receipt input readers (KS2c)', () => {
  it('reads the four toolchain versions', async () => {
    const executor = new ProbeExecutor(VERSIONS);
    await expect(readGateToolchainVersions(executor, WORKTREE)).resolves.toEqual({
      node: 'v22.23.3',
      yarn: '4.12.0',
      hexagen: '1.2.3',
      turbo: '2.5.4',
    });
    expect(executor.calls.map((call) => call.argv)).toEqual([
      ['/usr/bin/env', '-C', WORKTREE, 'node', '--version'],
      ['/usr/bin/env', '-C', WORKTREE, 'yarn', '--version'],
      ['/usr/bin/env', '-C', WORKTREE, HEXAGEN_BIN, '--version'],
      ['/usr/bin/env', '-C', WORKTREE, TURBO_BIN, '--version'],
    ]);
  });

  it('a failing version probe is a miss', async () => {
    const cases: Array<Record<string, Answer>> = [
      { ...VERSIONS, 'yarn --version': { exitCode: 1, stdout: '4.12.0\n' } },
      { ...VERSIONS, [TURBO_BIN + ' --version']: { stdout: 'turbo unknown\n' } },
      { ...VERSIONS, 'node --version': { stdout: '' } },
      { ...VERSIONS, [HEXAGEN_BIN + ' --version']: { stdout: '1.2.3!\n' } },
      { ...VERSIONS, [HEXAGEN_BIN + ' --version']: { stdout: '1'.repeat(65) + '\n' } },
      { ...VERSIONS, 'node --version': { exitCode: null } },
      { ...VERSIONS, 'node --version': { error: 'spawn node ENOENT' } },
      { ...VERSIONS, [TURBO_BIN + ' --version']: 'throw' },
      Object.fromEntries(Object.entries(VERSIONS).filter(([name]) => name !== TURBO_BIN + ' --version')),
    ];
    for (const answers of cases) {
      await expect(readGateToolchainVersions(new ProbeExecutor(answers), WORKTREE)).resolves.toBeUndefined();
    }
  });

  it('the declared environment digest changes with a declared value', async () => {
    const digestOf = (values: Record<string, string | null>): Promise<string | undefined> =>
      readGateDeclaredEnvironmentDigest(
        new ProbeExecutor(environment(DECLARED, values)),
        WORKTREE,
      );
    const same = { DECLARED_ONE: 'one', DECLARED_TWO: 'two' };
    const first = await digestOf(same);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(digestOf({ ...same })).resolves.toBe(first);
    await expect(digestOf({ ...same, DECLARED_TWO: 'changed' })).resolves.not.toBe(first);
    // An unset variable is hashed as the empty string (the brief's digest is exactly { names, values }).
    const unset = await digestOf({ DECLARED_ONE: 'one', DECLARED_TWO: null });
    expect(unset).not.toBe(first);
    await expect(digestOf({ DECLARED_ONE: 'one', DECLARED_TWO: '' })).resolves.toBe(unset);
  });

  it('pins the digest to SHA-256 of JSON.stringify({ names, values })', async () => {
    const digest = await readGateDeclaredEnvironmentDigest(
      new ProbeExecutor(environment(DECLARED, { DECLARED_ONE: 'one', DECLARED_TWO: null })),
      WORKTREE,
    );
    const expected = createHash('sha256')
      .update(JSON.stringify({ names: ['DECLARED_ONE', 'DECLARED_TWO'], values: { DECLARED_ONE: 'one', DECLARED_TWO: '' } }))
      .digest('hex');
    expect(digest).toBe(expected);
  });

  it('runs every probe as an argv command with no shell, passing metacharacters literally', async () => {
    const hostile = '/lanes/a b;$(touch x)`id`|&\'"';
    const executor = new ProbeExecutor({});
    await readGateToolchainVersions(executor, hostile);
    await readGateDeclaredEnvironmentDigest(executor, hostile);
    expect(executor.calls.length).toBeGreaterThan(0);
    for (const call of executor.calls) {
      expect(call.argv.slice(0, 3)).toEqual(['/usr/bin/env', '-C', hostile]);
      expect(call.argv).not.toContain('sh');
      expect(call.argv).not.toContain('-c');
      expect(call.options?.cwd).toBe(hostile);
    }
  });

  it('an unreadable turbo.json is a miss', async () => {
    const values = { DECLARED_ONE: 'one', DECLARED_TWO: 'two' };
    const cases: Array<Record<string, Answer>> = [
      { ...environment(DECLARED, values), [`cat ${join(WORKTREE, 'turbo.json')}`]: { exitCode: 1, stdout: DECLARED } },
      { ...environment(DECLARED, values), [`cat ${join(WORKTREE, 'turbo.json')}`]: { error: 'cat failed' } },
      { ...environment(DECLARED, values), [`cat ${join(WORKTREE, 'turbo.json')}`]: 'throw' },
      environment('{"tasks": ', values),
      environment('not json at all', values),
      environment('[]', values),
      environment('{}', values),
      environment(JSON.stringify({ tasks: { build: { env: [] }, test: {} } }), values),
      environment(JSON.stringify({ tasks: { build: { env: 'DECLARED_ONE' } } }), values),
      environment(JSON.stringify({ tasks: { build: { env: [1] } } }), values),
      environment(JSON.stringify({ tasks: { build: { env: ['--help'] } } }), values),
      environment(DECLARED, { DECLARED_ONE: 'one' }),
    ];
    for (const answers of cases) {
      await expect(
        readGateDeclaredEnvironmentDigest(new ProbeExecutor(answers), WORKTREE),
      ).resolves.toBeUndefined();
    }
  });

  it('never throws on runtime input', async () => {
    const hostile: CommandExecutorPort = {
      run: () => {
        throw new Error('synchronous crash');
      },
    };
    const nothing: CommandExecutorPort = { run: async () => null as unknown as CommandRunResult };
    const odd: CommandExecutorPort = {
      run: async () => ({ exitCode: 0, signal: null, stdout: 42, stderr: '' }) as unknown as CommandRunResult,
    };
    for (const executor of [hostile, nothing, odd]) {
      await expect(readGateToolchainVersions(executor, WORKTREE)).resolves.toBeUndefined();
      await expect(readGateDeclaredEnvironmentDigest(executor, WORKTREE)).resolves.toBeUndefined();
    }
    const hostileTurbo = new ProbeExecutor(
      environment('{"tasks":{"build":{"env":["DECLARED_ONE"]}}}', { DECLARED_ONE: 'one' }),
    );
    await expect(readGateDeclaredEnvironmentDigest(hostileTurbo, WORKTREE)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(readGateToolchainVersions(undefined as unknown as CommandExecutorPort, WORKTREE)).resolves.toBeUndefined();
  });

  it('guards every receipt-input call', async () => {
    const executor = new ProbeExecutor({
      ...VERSIONS,
      ...environment(DECLARED, { DECLARED_ONE: 'one', DECLARED_TWO: 'two' }),
    });
    await readGateToolchainVersions(executor, WORKTREE);
    await readGateDeclaredEnvironmentDigest(executor, WORKTREE);
    expect(executor.calls).toHaveLength(4 + 1 + 2);
    for (const call of executor.calls) {
      expect(call.options?.cwd).toBe(WORKTREE);
      expect(call.options?.timeoutMs).toBe(10_000);
      expect(call.options?.maxBufferBytes).toBeGreaterThan(0);
      expect(call.options?.maxBufferBytes).toBeLessThanOrEqual(65_536);
    }
    // A probe the executor reports as timed out is a miss, never a hang.
    const timedOut = new ProbeExecutor({
      ...VERSIONS,
      'yarn --version': { exitCode: null, signal: 'SIGKILL', error: 'timed out' },
      ...environment(DECLARED, { DECLARED_ONE: 'one', DECLARED_TWO: 'two' }),
      'printenv DECLARED_TWO': { exitCode: null, signal: 'SIGKILL', error: 'timed out' },
    });
    await expect(readGateToolchainVersions(timedOut, WORKTREE)).resolves.toBeUndefined();
    await expect(readGateDeclaredEnvironmentDigest(timedOut, WORKTREE)).resolves.toBeUndefined();
  });

  it('echoes no secret-shaped text and no path', async () => {
    const value = 'declared-value-ZZZ-9137';
    const digest = await readGateDeclaredEnvironmentDigest(
      new ProbeExecutor(environment(DECLARED, { DECLARED_ONE: value, DECLARED_TWO: 'two' })),
      WORKTREE,
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(value);
    expect(digest).not.toContain('lanes');
    const versions = await readGateToolchainVersions(new ProbeExecutor(VERSIONS), WORKTREE);
    expect(JSON.stringify(versions)).not.toContain('lanes');
    expect(JSON.stringify(versions)).not.toContain('probe-worktree');
  });

  it('runs no git and no network command for the receipt inputs', async () => {
    const executor = new ProbeExecutor({
      ...VERSIONS,
      ...environment(DECLARED, { DECLARED_ONE: 'one', DECLARED_TWO: 'two' }),
    });
    await readGateToolchainVersions(executor, WORKTREE);
    await readGateDeclaredEnvironmentDigest(executor, WORKTREE);
    const innerCalls = executor.calls.map((call) => call.argv.slice(3));
    expect(innerCalls.map((argv) => argv.join(' '))).toEqual([
      'node --version',
      'yarn --version',
      `${HEXAGEN_BIN} --version`,
      `${TURBO_BIN} --version`,
      'cat ' + join(WORKTREE, 'turbo.json'),
      'printenv DECLARED_ONE',
      'printenv DECLARED_TWO',
    ]);
    for (const call of executor.calls) {
      const inner = call.argv.slice(3);
      expect(inner[0]).not.toBe('git');
      expect(inner[0]).not.toBe('sh');
      expect(inner.join(' ')).not.toMatch(/curl|wget|ssh|https?:/);
    }
  });

  it('bounds the size of every receipt input', async () => {
    const values = { DECLARED_ONE: 'one', DECLARED_TWO: 'two' };
    // An oversized turbo.json, even when the executor did not cut it.
    const bigDocument = JSON.stringify({
      tasks: { build: { env: ['DECLARED_ONE'] } },
      padding: 'x'.repeat(70_000),
    });
    await expect(
      readGateDeclaredEnvironmentDigest(new ProbeExecutor(environment(bigDocument, values)), WORKTREE),
    ).resolves.toBeUndefined();

    // An oversized declared value.
    await expect(
      readGateDeclaredEnvironmentDigest(
        new ProbeExecutor(environment(DECLARED, { ...values, DECLARED_TWO: 'v'.repeat(9000) })),
        WORKTREE,
      ),
    ).resolves.toBeUndefined();

    // More than 16 declared names.
    const names = Array.from({ length: 17 }, (_, index) => 'DECLARED_' + String(index));
    const many = Object.fromEntries(names.map((name) => [name, 'v']));
    await expect(
      readGateDeclaredEnvironmentDigest(
        new ProbeExecutor(environment(turboJson({ build: names }), many)),
        WORKTREE,
      ),
    ).resolves.toBeUndefined();

    // Sixteen names are still readable.
    const sixteen = names.slice(0, 16);
    await expect(
      readGateDeclaredEnvironmentDigest(
        new ProbeExecutor(environment(turboJson({ build: sixteen }), many)),
        WORKTREE,
      ),
    ).resolves.toMatch(/^[0-9a-f]{64}$/);

    // An oversized version output.
    await expect(
      readGateToolchainVersions(
        new ProbeExecutor({ ...VERSIONS, 'node --version': { stdout: ' '.repeat(5000) + 'v22.0.0\n' } }),
        WORKTREE,
      ),
    ).resolves.toBeUndefined();
  });
});
