// GatePredicateAdapter tests — plan S2b.
/**
 * Covers GatePredicateAdapter over a scripted CommandExecutorPort: the
 * commit predicate (head, ancestor, count, clean tree), the lane diff check
 * through an injected laneDiffCheckFor, and fixed argv commands with their
 * declared coverage. Output never leaks into results.
 */

import { describe, expect, it } from 'vitest';

import { GatePredicateAdapter, boundedRedactedOutputTail } from '../GatePredicateAdapter.adapter.js';
import type { GatePredicateAdapterOptions } from '../GatePredicateAdapter.adapter.js';
import type {
  EvaluateGatePredicatesRequest,
} from '../../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  LaneDiffCheckPort,
  LaneDiffCheckResult,
  LaneDiffFinding,
} from '../../../application/ports/out/LaneDiffCheckPort.out-port.js';
import type { RunnerForAttemptHostSpec } from '../ConfirmRecordedHost.js';
import { GATE_COVERAGE_READER_UNIT_KINDS } from '../../../domain/value-objects/AcceptanceSpec.vo.js';
import { COVERAGE_READER_UNIT_KINDS } from '@fleet/evidence-and-acceptance';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const WORKTREE = '/lanes/w1';

const REQUEST: EvaluateGatePredicatesRequest = {
  attemptId: 'attempt-1',
  worktreePath: WORKTREE,
  runner: null,
  baseCommit: BASE,
  candidateHeadSha: HEAD,
  allowedPathPrefixes: ['src'],
  spec: {
    commitRequired: true,
    diffCheck: true,
    commands: [{ argv: ['corepack', 'yarn', 'build'] }],
  },
};

class ScriptedExecutor implements CommandExecutorPort {
  readonly argvRecords: string[][] = [];

  constructor(
    private readonly script: (argv: readonly string[]) => Partial<CommandRunResult>,
  ) {}

  async run(
    argv: readonly string[],
    _options?: CommandRunOptions,
  ): Promise<CommandRunResult> {
    this.argvRecords.push([...argv]);
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      ...this.script(argv),
    };
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
  if (sub === 'merge-base') {
    return { exitCode: 0 };
  }
  if (sub === 'rev-list') {
    return { stdout: '2\n' };
  }
  if (sub === 'status') {
    return { stdout: '' };
  }
  return { exitCode: 0 };
}

function makeAdapter(
  script: (argv: readonly string[]) => Partial<CommandRunResult>,
  options: Partial<GatePredicateAdapterOptions> = {},
  diff: LaneDiffCheckResult = { outcome: 'clean' },
  hostSpec?: RunnerForAttemptHostSpec,
): { adapter: GatePredicateAdapter; executor: ScriptedExecutor; fakeDiff: FakeLaneDiffCheck } {
  const executor = new ScriptedExecutor(script);
  const fakeDiff = new FakeLaneDiffCheck(diff);
  let now = 0;
  const adapter = new GatePredicateAdapter({
    executorForRecordedHost: () =>
      hostSpec === undefined
        ? { ok: true, executor }
        : { ok: true, executor, hostSpec },
    laneDiffCheckFor: () => fakeDiff,
    nowMs: () => {
      now += 1;
      return now;
    },
    ...options,
  });
  return { adapter, executor, fakeDiff };
}

function evaluatedResults(
  result: Awaited<ReturnType<GatePredicateAdapter['evaluateGatePredicates']>>,
) {
  expect(result.outcome).toBe('evaluated');
  if (result.outcome !== 'evaluated') {
    throw new Error('expected evaluated');
  }
  return result.results;
}

describe('GatePredicateAdapter', () => {
  it('passes when every predicate passes', async () => {
    const { adapter, executor, fakeDiff } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { exitCode: 0 };
      }
      return happyGit(argv);
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results).toEqual([
      {
        name: 'commit',
        kind: 'commit',
        verdict: 'pass',
        exitCode: null,
        durationMs: expect.any(Number),
        detail: 'head ' + HEAD + ', 2 commit(s) since the base',
      },
      {
        name: 'diff-check',
        kind: 'diff-check',
        verdict: 'pass',
        exitCode: null,
        durationMs: expect.any(Number),
        detail: 'clean',
      },
      {
        name: 'command 1: corepack yarn build',
        kind: 'command',
        verdict: 'pass',
        exitCode: 0,
        durationMs: expect.any(Number),
        detail: 'exit 0',
      },
    ]);
    expect(fakeDiff.calls).toBe(1);
    expect(executor.argvRecords.filter((argv) => argv[0] === 'sh')).toEqual([
      ['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'fleet-gate', WORKTREE, 'corepack', 'yarn', 'build'],
    ]);
    for (const argv of executor.argvRecords.filter((record) => record[0] === 'git')) {
      expect(argv.slice(0, 7)).toEqual([
        'git',
        '-C',
        WORKTREE,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
      ]);
    }
  });

  it('fails when the worktree head is not the candidate head and skips the rest', async () => {
    const { adapter, executor, fakeDiff } = makeAdapter((argv) => {
      if (gitSubcommand(argv) === 'rev-parse') {
        return { stdout: 'c'.repeat(40) + '\n' };
      }
      return { exitCode: 0 };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({
      name: 'commit',
      verdict: 'fail',
      detail: 'HEAD is not the candidate commit',
    });
    expect(results[1]).toEqual({
      name: 'diff-check',
      kind: 'diff-check',
      verdict: 'skipped',
      exitCode: null,
      durationMs: 0,
      detail: 'not run: an earlier predicate did not pass',
    });
    expect(results[2]).toMatchObject({ name: 'command 1: corepack yarn build', kind: 'command', verdict: 'skipped' });
    expect(fakeDiff.calls).toBe(0);
    expect(executor.argvRecords.some((argv) => argv[0] === 'sh')).toBe(false);
  });

  it('fails when rev-parse prints the candidate commit id but exits 1', async () => {
    const { adapter } = makeAdapter((argv) => {
      if (gitSubcommand(argv) === 'rev-parse') {
        return { exitCode: 1, stdout: HEAD + '\n' };
      }
      return { exitCode: 0 };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({
      name: 'commit',
      verdict: 'fail',
      detail: 'HEAD is not the candidate commit',
    });
  });

  it('never includes rev-parse stdout in a HEAD mismatch detail', async () => {
    const sentinel = 'SENTINEL-REV-PARSE-STDOUT-789';
    const { adapter } = makeAdapter((argv) => {
      if (gitSubcommand(argv) === 'rev-parse') {
        return { exitCode: 0, stdout: sentinel + '\n' };
      }
      return { exitCode: 0 };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({
      name: 'commit',
      verdict: 'fail',
      detail: 'HEAD is not the candidate commit',
    });
    expect(results[0].detail).not.toContain(sentinel);
    for (const result of results) {
      expect(result.detail).not.toContain(sentinel);
    }
  });

  it('fails the commit predicate when there is no commit since the base', async () => {
    const { adapter } = makeAdapter((argv) => {
      const sub = gitSubcommand(argv);
      if (sub === 'rev-parse') {
        return { stdout: HEAD + '\n' };
      }
      if (sub === 'merge-base') {
        return { exitCode: 0 };
      }
      if (sub === 'rev-list') {
        return { stdout: '0\n' };
      }
      return { stdout: '' };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({ name: 'commit', verdict: 'fail', detail: 'no commit since the base' });
  });

  it('fails the commit predicate when the commit count has trailing text', async () => {
    const { adapter } = makeAdapter((argv) => {
      const sub = gitSubcommand(argv);
      if (sub === 'rev-parse') {
        return { stdout: HEAD + '\n' };
      }
      if (sub === 'merge-base') {
        return { exitCode: 0 };
      }
      if (sub === 'rev-list') {
        return { stdout: '1 unexpected\n' };
      }
      return { stdout: '' };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({ name: 'commit', verdict: 'fail', detail: 'no commit since the base' });
  });

  it('fails the commit predicate on uncommitted changes', async () => {
    const { adapter } = makeAdapter((argv) => {
      const sub = gitSubcommand(argv);
      if (sub === 'rev-parse') {
        return { stdout: HEAD + '\n' };
      }
      if (sub === 'merge-base') {
        return { exitCode: 0 };
      }
      if (sub === 'rev-list') {
        return { stdout: '2\n' };
      }
      if (sub === 'status') {
        return { stdout: ' M src/a.ts\n' };
      }
      return { exitCode: 0 };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({
      name: 'commit',
      verdict: 'fail',
      detail: 'uncommitted changes in the worktree',
    });
  });

  it('fails the commit predicate when the base is not an ancestor', async () => {
    const { adapter } = makeAdapter((argv) => {
      const sub = gitSubcommand(argv);
      if (sub === 'rev-parse') {
        return { stdout: HEAD + '\n' };
      }
      if (sub === 'merge-base') {
        return { exitCode: 1 };
      }
      return { exitCode: 0 };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({
      name: 'commit',
      verdict: 'fail',
      detail: 'base is not an ancestor of the candidate head',
    });
  });

  it('reports unknown when rev-parse fails to spawn', async () => {
    const { adapter } = makeAdapter((argv) => {
      if (gitSubcommand(argv) === 'rev-parse') {
        return { error: 'spawn failed' };
      }
      return { exitCode: 0 };
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[0]).toMatchObject({ name: 'commit', verdict: 'unknown', detail: 'git rev-parse did not complete' });
  });

  it('fails with invalid base or candidate commit and records nothing', async () => {
    const { adapter, executor } = makeAdapter(() => ({}));
    const request: EvaluateGatePredicatesRequest = { ...REQUEST, baseCommit: 'main' };

    const results = evaluatedResults(await adapter.evaluateGatePredicates(request));
    expect(results[0]).toMatchObject({
      name: 'commit',
      verdict: 'fail',
      detail: 'invalid base or candidate commit',
    });
    expect(executor.argvRecords).toHaveLength(0);
  });

  it('fails the diff check on findings and skips commands', async () => {
    const findings: readonly LaneDiffFinding[] = [
      { path: 'package.json', rule: 'protected-path' },
      { path: 'src/x.ts', line: 3, rule: 'secret:aws' },
    ];
    const { adapter, executor, fakeDiff } = makeAdapter(
      happyGit,
      {},
      { outcome: 'findings', findings },
    );

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[1]).toMatchObject({
      name: 'diff-check',
      verdict: 'fail',
      detail: '2 finding(s): package.json protected-path; src/x.ts:3 secret:aws',
    });
    expect(results[2]).toMatchObject({ kind: 'command', verdict: 'skipped' });
    expect(fakeDiff.calls).toBe(1);
    expect(executor.argvRecords.some((argv) => argv[0] === 'sh')).toBe(false);
  });

  it('reports unknown on a diff check error and skips commands', async () => {
    const { adapter } = makeAdapter(
      happyGit,
      {},
      { outcome: 'error', reason: 'unsupported-path-characters' },
    );

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[1]).toMatchObject({
      name: 'diff-check',
      verdict: 'unknown',
      detail: 'diff check error: unsupported-path-characters',
    });
    expect(results[2]).toMatchObject({ kind: 'command', verdict: 'skipped' });
  });

  it('runs two commands and skips the second after the first fails', async () => {
    const request: EvaluateGatePredicatesRequest = {
      ...REQUEST,
      spec: {
        commitRequired: true,
        diffCheck: true,
        commands: [{ argv: ['a'] }, { argv: ['b'] }],
      },
    };
    const { adapter, executor } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { exitCode: argv.includes('a') ? 1 : 0 };
      }
      return happyGit(argv);
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(request));
    expect(results[2]).toMatchObject({ name: 'command 1: a', kind: 'command', verdict: 'fail', exitCode: 1 });
    expect(results[3]).toEqual({
      name: 'command 2: b',
      kind: 'command',
      verdict: 'skipped',
      exitCode: null,
      durationMs: 0,
      detail: 'not run: an earlier predicate did not pass',
    });
    expect(executor.argvRecords.filter((argv) => argv[0] === 'sh')).toHaveLength(1);
  });

  it('reports unknown when a command never reports an exit code', async () => {
    const { adapter } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { error: 'timed out', exitCode: null };
      }
      return happyGit(argv);
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({
      kind: 'command',
      verdict: 'unknown',
      exitCode: null,
      detail: 'no exit code',
    });
  });

  it('treats exit 255 as a transport failure only when remote', async () => {
    const { adapter } = makeAdapter(
      (argv) => {
        if (argv[0] === 'sh') {
          return { exitCode: 255 };
        }
        return happyGit(argv);
      },
      { isRemote: () => true },
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ kind: 'command', verdict: 'unknown' });

    const { adapter: localAdapter } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { exitCode: 255 };
      }
      return happyGit(argv);
    });
    const localResults = evaluatedResults(await localAdapter.evaluateGatePredicates(REQUEST));
    expect(localResults[2]).toMatchObject({ kind: 'command', verdict: 'fail' });
  });

  it('applies declared coverage to a passing command', async () => {
    const request: EvaluateGatePredicatesRequest = {
      ...REQUEST,
      spec: {
        commitRequired: true,
        diffCheck: true,
        commands: [
          {
            argv: ['vitest', 'run'],
            coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1 },
          },
        ],
      },
    };

    const { adapter } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { stdout: ' Test Files  1 skipped (1)\n      Tests  5 skipped (5)\n' };
      }
      return happyGit(argv);
    });
    const skippedResults = evaluatedResults(await adapter.evaluateGatePredicates(request));
    expect(skippedResults[2]).toMatchObject({
      verdict: 'unknown',
      coverage: { ran: true, unitKind: 'tests', units: 0 },
    });

    const { adapter: passedAdapter } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { stdout: ' Test Files  1 passed (1)\n      Tests  36 passed (36)\n' };
      }
      return happyGit(argv);
    });
    const passedResults = evaluatedResults(await passedAdapter.evaluateGatePredicates(request));
    expect(passedResults[2]).toMatchObject({
      verdict: 'pass',
      coverage: { ran: true, unitKind: 'tests', units: 36 },
    });
  });

  it('never upgrades a failing command with coverage', async () => {
    const request: EvaluateGatePredicatesRequest = {
      ...REQUEST,
      spec: {
        commitRequired: true,
        diffCheck: true,
        commands: [
          {
            argv: ['vitest', 'run'],
            coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1 },
          },
        ],
      },
    };
    const { adapter } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { exitCode: 1, stdout: ' Test Files  1 passed (1)\n      Tests  36 passed (36)\n' };
      }
      return happyGit(argv);
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(request));
    expect(results[2]).toMatchObject({ verdict: 'fail', coverage: { ran: true, units: 36 } });
  });

  it('never leaks command output into a result', async () => {
    const { adapter } = makeAdapter((argv) => {
      if (argv[0] === 'sh') {
        return { stdout: 'TOKEN-VALUE-123', stderr: 'TOKEN-VALUE-123' };
      }
      return happyGit(argv);
    });

    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    for (const result of results) {
      expect(result.name).not.toContain('TOKEN-VALUE-123');
      expect(result.detail).not.toContain('TOKEN-VALUE-123');
    }
  });

  it('returns unavailable when no executor resolves for the recorded host', async () => {
    const executor = new ScriptedExecutor(() => ({}));
    const adapter = new GatePredicateAdapter({
      executorForRecordedHost: () => ({ ok: false, reason: 'host gone' }),
      laneDiffCheckFor: () => new FakeLaneDiffCheck({ outcome: 'clean' }),
      nowMs: () => 1,
    });

    const result = await adapter.evaluateGatePredicates(REQUEST);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'host gone' });
    expect(executor.argvRecords).toHaveLength(0);
  });

  it('keeps the gate coverage readers in parity with evidence-and-acceptance', () => {
    expect(GATE_COVERAGE_READER_UNIT_KINDS).toEqual(COVERAGE_READER_UNIT_KINDS);
  });
});

// KF-30b: when the recorded host declares `runner.gateSlot`, every acceptance
// command is prefixed so it takes one of the host-wide flock slots through the
// trusted, host-installed wrapper — never the worktree's own `bin/gate-slot`.
describe('GatePredicateAdapter gate slot (KF-30b)', () => {
  const GATE_SLOT_PATH = '/usr/local/bin/gate-slot';
  const HOST_SPEC: RunnerForAttemptHostSpec = {
    transport: 'local',
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port: 4096, gateSlot: { path: GATE_SLOT_PATH, slots: 8 } },
  };

  it('prefixes the command exactly when the host declares gateSlot', async () => {
    const { adapter, executor } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 0 } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(executor.argvRecords.filter((argv) => argv[0] === 'sh')).toEqual([
      [
        'sh',
        '-c',
        'cd -- "$1" && shift && exec "$@"',
        'fleet-gate',
        WORKTREE,
        '/usr/bin/env',
        'FLEET_V2_GATE_SLOTS=8',
        // 30 min default budget / 3000 = 600, capped at 600.
        'FLEET_V2_GATE_WAIT_MAX_SECONDS=600',
        GATE_SLOT_PATH,
        'corepack',
        'yarn',
        'build',
      ],
    ]);
  });

  it('leaves the command unchanged when the host declares no gateSlot', async () => {
    const { adapter, executor } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 0 } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4096 } },
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(executor.argvRecords.filter((argv) => argv[0] === 'sh')).toEqual([
      ['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'fleet-gate', WORKTREE, 'corepack', 'yarn', 'build'],
    ]);
  });

  it('uses the declared host path, never the worktree own bin/gate-slot', async () => {
    const { adapter, executor } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 0 } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      { ...HOST_SPEC, runner: { kind: 'opencode', port: 4096, gateSlot: { path: GATE_SLOT_PATH, slots: 8 } } },
    );
    await adapter.evaluateGatePredicates(REQUEST);
    for (const argv of executor.argvRecords) {
      expect(argv).not.toContain(WORKTREE + '/bin/gate-slot');
      expect(argv).not.toContain('bin/gate-slot');
    }
    const prefixed = executor.argvRecords.find((argv) => argv.includes(GATE_SLOT_PATH));
    expect(prefixed).toBeDefined();
  });

  it('caps the slot wait at a third of the command budget', async () => {
    const { adapter, executor } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 0 } : happyGit(argv)),
      { commandTimeoutMs: 90_000 },
      { outcome: 'clean' },
      HOST_SPEC,
    );
    await adapter.evaluateGatePredicates(REQUEST);
    const prefixed = executor.argvRecords.find((argv) => argv.includes(GATE_SLOT_PATH));
    expect(prefixed).toBeDefined();
    expect(prefixed).toContain('FLEET_V2_GATE_WAIT_MAX_SECONDS=30');
  });

  it('maps exit 75 with the fixed stderr line to unknown, detail gate slot wait limit reached', async () => {
    const { adapter } = makeAdapter(
      (argv) =>
        argv[0] === 'sh'
          ? {
              exitCode: 75,
              stderr: 'gate-slot: no slot within the wait limit\n',
            }
          : happyGit(argv),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({
      kind: 'command',
      verdict: 'unknown',
      exitCode: 75,
      detail: 'gate slot wait limit reached',
      cause: 'gate-slot-wait-limit',
    });
  });

  it('keeps a bare exit 75 as the command own fail', async () => {
    const { adapter } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 75, stderr: 'my tool: fatal' } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'fail', exitCode: 75 });
    expect(results[2]).not.toHaveProperty('cause');
  });

  it('keeps exit 75 with another stderr line as the command own fail even with a slot declared', async () => {
    const { adapter } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 75, stderr: '' } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'fail', exitCode: 75 });
  });

  it('treats the fixed line as the last stderr line, ignoring ssh warnings before it', async () => {
    const { adapter } = makeAdapter(
      (argv) =>
        argv[0] === 'sh'
          ? {
              exitCode: 75,
              stderr:
                'ssh: Warning: Permanently added to the list of known hosts.\ngate-slot: no slot within the wait limit\n',
            }
          : happyGit(argv),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({
      kind: 'command',
      verdict: 'unknown',
      exitCode: 75,
      detail: 'gate slot wait limit reached',
      cause: 'gate-slot-wait-limit',
    });
  });

  it('keeps exit 75 with the fixed stderr line and an executor error as unknown without cause', async () => {
    const { adapter } = makeAdapter(
      (argv) =>
        argv[0] === 'sh'
          ? {
              exitCode: 75,
              stderr: 'gate-slot: no slot within the wait limit\n',
              error: 'timed out',
            }
          : happyGit(argv),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'unknown', exitCode: 75 });
    expect(results[2]).not.toHaveProperty('cause');
  });

  it('keeps exit 75 with the fixed stderr line as the command own fail without a declared gateSlot', async () => {
    const { adapter } = makeAdapter(
      (argv) =>
        argv[0] === 'sh'
          ? { exitCode: 75, stderr: 'gate-slot: no slot within the wait limit\n' }
          : happyGit(argv),
      {},
      { outcome: 'clean' },
      { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4096 } },
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'fail', exitCode: 75 });
  });

  it('does not set cause on an unknown from a thrown run', async () => {
    const { adapter } = makeAdapter(
      (argv) => {
        if (argv[0] === 'sh') {
          throw new Error('spawn failed');
        }
        return happyGit(argv);
      },
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({
      kind: 'command',
      verdict: 'unknown',
      exitCode: null,
      detail: 'command did not complete',
    });
    expect(results[2]).not.toHaveProperty('cause');
  });

  it('maps command exit 137 without executor error to unknown with cause resource-exhausted', async () => {
    const { adapter } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 137, signal: 'KILL' } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({
      kind: 'command',
      verdict: 'unknown',
      exitCode: 137,
      cause: 'resource-exhausted',
    });
    expect(results[2].kind === 'command' && results[2].detail).toContain('137');
  });

  it('maps command exit 143 without executor error to unknown with cause resource-exhausted', async () => {
    const { adapter } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 143, signal: 'TERM' } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({
      kind: 'command',
      verdict: 'unknown',
      exitCode: 143,
      cause: 'resource-exhausted',
    });
    expect(results[2].kind === 'command' && results[2].detail).toContain('143');
  });

  it('keeps command exit 137 or 143 with executor error as unknown without cause', async () => {
    for (const exitCode of [137, 143]) {
      const { adapter } = makeAdapter(
        (argv) => (argv[0] === 'sh' ? { exitCode, error: 'timed out' } : happyGit(argv)),
        {},
        { outcome: 'clean' },
        HOST_SPEC,
      );
      const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
      expect(results[2]).toMatchObject({ verdict: 'unknown', exitCode });
      expect(results[2]).not.toHaveProperty('cause');
    }
  });

  it('keeps other non-zero command exits such as 1 and 2 as fail without cause', async () => {
    for (const exitCode of [1, 2]) {
      const { adapter } = makeAdapter(
        (argv) => (argv[0] === 'sh' ? { exitCode } : happyGit(argv)),
        {},
        { outcome: 'clean' },
        HOST_SPEC,
      );
      const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
      expect(results[2]).toMatchObject({ verdict: 'fail', exitCode });
      expect(results[2]).not.toHaveProperty('cause');
    }
  });

  it('keeps command exit 0 as pass without cause', async () => {
    const { adapter } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 0 } : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    const results = evaluatedResults(await adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(results[2]).not.toHaveProperty('cause');
  });

  it('never passes a zero wait limit, whatever the command budget', async () => {
    const { adapter, executor } = makeAdapter(
      (argv) => (argv[0] === 'sh' ? { exitCode: 0 } : happyGit(argv)),
      { commandTimeoutMs: 2000 },
      { outcome: 'clean' },
      HOST_SPEC,
    );
    await adapter.evaluateGatePredicates(REQUEST);
    const prefixed = executor.argvRecords.find((argv) => argv.includes(GATE_SLOT_PATH));
    expect(prefixed).toBeDefined();
    expect(prefixed).toContain('FLEET_V2_GATE_WAIT_MAX_SECONDS=1');
  });
});

describe('GatePredicateAdapter failed output tail (GD2)', () => {
  const HOST_SPEC: RunnerForAttemptHostSpec = {
    transport: 'local',
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port: 4096 },
  };

  function commandResults(script: (argv: readonly string[]) => Partial<CommandRunResult>) {
    const adapter = makeAdapter(
      (argv) => (argv[0] === 'sh' ? script(argv) : happyGit(argv)),
      {},
      { outcome: 'clean' },
      HOST_SPEC,
    );
    return adapter.adapter.evaluateGatePredicates(REQUEST).then(evaluatedResults);
  }

  it('attaches a bounded outputTail to a failing command with output', async () => {
    const results = await commandResults(() => ({ exitCode: 1, stdout: 'error: build failed\n' }));
    expect(results[2]).toMatchObject({ verdict: 'fail', exitCode: 1, outputTail: 'error: build failed' });
  });

  it('omits outputTail when both streams are empty or whitespace', async () => {
    for (const streams of [{}, { stdout: '', stderr: '' }, { stdout: '   \n\t', stderr: '' }]) {
      const results = await commandResults(() => ({ exitCode: 1, ...streams }));
      expect(results[2]).not.toHaveProperty('outputTail');
    }
  });

  it('omits outputTail on pass, skipped, timeout and congestion verdicts', async () => {
    const passing = await commandResults(() => ({ exitCode: 0, stdout: 'all good\n' }));
    expect(passing[2]).not.toHaveProperty('outputTail');
    const killed = await commandResults(() => ({ exitCode: 137, signal: 'KILL', stdout: 'out of memory\n' }));
    expect(killed[2]).toMatchObject({ verdict: 'unknown', cause: 'resource-exhausted' });
    expect(killed[2]).not.toHaveProperty('outputTail');
    const timedOut = await commandResults(() => ({ exitCode: 1, error: 'timed out', stdout: 'partial\n' }));
    expect(timedOut[2].verdict === 'unknown').toBe(true);
    expect(timedOut[2]).not.toHaveProperty('outputTail');
  });

  it('omits outputTail for the declared gate-slot wait-limit verdict (exit 75 unknown)', async () => {
    const slotSpec: RunnerForAttemptHostSpec = {
      transport: 'local',
      roles: ['lane-runner'],
      runner: { kind: 'opencode', port: 4096, gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 } },
    };
    const adapter = makeAdapter(
      (argv) =>
        argv[0] === 'sh'
          ? { exitCode: 75, stderr: 'gate-slot: no slot within the wait limit\n' }
          : happyGit(argv),
      {},
      { outcome: 'clean' },
      slotSpec,
    );
    const results = evaluatedResults(await adapter.adapter.evaluateGatePredicates(REQUEST));
    expect(results[2]).toMatchObject({ verdict: 'unknown', cause: 'gate-slot-wait-limit' });
    expect(results[2]).not.toHaveProperty('outputTail');
  });

  it('keeps the tail at most 200 lines and 32 KiB of combined output', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    const results = await commandResults(() => ({ exitCode: 1, stdout: long }));
    const tail = results[2].kind === 'command' && typeof results[2].outputTail === 'string' ? results[2].outputTail : '';
    expect(tail.length).toBeLessThanOrEqual(32 * 1024);
    expect(tail.startsWith('line ')).toBe(true);
    expect(tail).not.toContain('line 0\n');
    expect(tail.endsWith('line 399')).toBe(true);
  });

  it('redacts secret-shaped lines line by line', async () => {
    const results = await commandResults(() => ({
      exitCode: 1,
      stdout: 'starting build\ntoken: gh' + 'p_abc123def456ghi789jkl012mno345pqr678\nbuild failed\n',
    }));
    const tail = results[2].kind === 'command' && typeof results[2].outputTail === 'string' ? results[2].outputTail : '';
    expect(tail).toContain('starting build');
    expect(tail).toContain('[redacted: secret-shaped line]');
    expect(tail).not.toContain('gh' + 'p_');
  });

  it('never throws for non-string streams (boundedRedactedOutputTail is total)', () => {
    for (const [a, b] of [
      [undefined, undefined],
      [null as unknown, null as unknown],
      [{ length: 3 } as unknown, 42 as unknown],
    ]) {
      expect(() => boundedRedactedOutputTail(a, b)).not.toThrow();
      expect(boundedRedactedOutputTail(a, b)).toBeUndefined();
    }
    expect(boundedRedactedOutputTail('out\n', undefined)).toBe('out');
    expect(boundedRedactedOutputTail(undefined, 'err\n')).toBe('err');
  });

  it('strips ANSI escape sequences before bounding and redacting', async () => {
    const results = await commandResults(() => ({
      exitCode: 1,
      stdout: '[31merror: failed[0m\n',
    }));
    expect(results[2].kind === 'command' && results[2].outputTail).toBe('error: failed');
  });

  it('GD2 bounds the tail in UTF-8 bytes on a code-point boundary', () => {
    const emojiLine = '\u{1F600}'.repeat(10);
    const tail = boundedRedactedOutputTail(`${emojiLine}\n`.repeat(2000), undefined);
    expect(tail).toBeDefined();
    expect(Buffer.byteLength(tail as string, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    // The cut first line is partial and dropped: every kept line is whole.
    for (const line of (tail as string).split('\n')) {
      expect(line).toBe(emojiLine);
    }
    const cjkLine = '\u4e2d'.repeat(10);
    const cjk = boundedRedactedOutputTail(`${cjkLine}\n`.repeat(2000), undefined) as string;
    expect(Buffer.byteLength(cjk, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    for (const line of cjk.split('\n')) {
      expect(line).toBe(cjkLine);
    }
  });

  it('bounds the scan of an enormous stream to its last 200 lines and 32 KiB', () => {
    // A stream far past the bound (several MiB, 100k+ lines): the tail must
    // still be exactly the last 200 lines capped to 32 KiB, produced by
    // scanning only the end of the stream — a whole-stream join/strip/split
    // would allocate and scan every byte first.
    const long = Array.from({ length: 120000 }, (_, i) => `line ${i}: aaaa`).join('\n');
    const tail = boundedRedactedOutputTail(long, undefined);
    expect(tail).toBeDefined();
    const lines = (tail as string).split('\n');
    expect(lines.length).toBeLessThanOrEqual(200);
    expect((tail as string).length).toBeLessThanOrEqual(32 * 1024);
    expect(lines[0]).toBe('line 119800: aaaa');
    expect(lines[lines.length - 1]).toBe('line 119999: aaaa');
    const hugeLine = 'x'.repeat(10_000_000) + '\nlast words';
    const hugeTail = boundedRedactedOutputTail(hugeLine, undefined);
    expect(hugeTail).toBe('last words');
  });

  it('keeps the combined stdout+stderr scan within 32 KiB, never splitting more than the combined window (fix round 2, item 2)', () => {
    // Two streams whose individually retained slices add up to well over
    // 32 KiB: the helper must cut the raw COMBINED text to its last 32 KiB
    // before any strip or split, and apply the 200-line limit by locating the
    // boundary newline instead of splitting the whole window. The assertions
    // fail against the previous implementation, which joined both retained
    // 32 KiB slices and split the ~64 KiB result before limiting the lines.
    const stdout = Array.from({ length: 40000 }, (_, i) => `out ${i}`).join('\n');
    const stderr = Array.from({ length: 300 }, (_, i) => `err ${i}`).join('\n');
    expect(stdout.length + stderr.length).toBeGreaterThan(64 * 1024);
    const originalSplit = String.prototype.split;
    let longestSplit = 0;
    (String.prototype as { split: typeof String.prototype.split }).split = function trackedSplit(
      this: string,
      ...args: unknown[]
    ) {
      longestSplit = Math.max(longestSplit, this.length);
      return originalSplit.apply(this, args as Parameters<typeof originalSplit>);
    };
    try {
      const tail = boundedRedactedOutputTail(stdout, stderr);
      expect(tail).toBeDefined();
      const lines = (tail as string).split('\n');
      expect(lines.length).toBeLessThanOrEqual(200);
      // stderr is fully inside the combined last-32-KiB window, so the last
      // 200 lines of the combined text are exactly stderr's last 200 lines.
      expect(lines[0]).toBe('err 100');
      expect(lines[lines.length - 1]).toBe('err 299');
      expect((tail as string).length).toBeLessThanOrEqual(32 * 1024);
    } finally {
      String.prototype.split = originalSplit;
    }
    expect(longestSplit).toBeLessThanOrEqual(32 * 1024 + 1);
  });

  it('returns undefined when only the unscanned head carries non-whitespace content', () => {
    // A stream whose last 32 KiB is entirely blank: the bounded scan never
    // reads the non-whitespace head, so the tail is whitespace-only and
    // undefined — a whole-stream implementation would still emit a
    // whitespace-only tail string.
    const tail = boundedRedactedOutputTail('x\n' + ' '.repeat(50000), undefined);
    expect(tail).toBeUndefined();
  });
  it('GD2 redacts a whole PEM block, not only its BEGIN line', () => {
    const begin = '-----' + 'BEGIN ' + 'PRIVATE ' + 'KEY-----';
    const end = '-----' + 'END ' + 'PRIVATE ' + 'KEY-----';
    const body = ['Zm9vYmFyYmF6cXV4', 'quuxCORGEgraultGARPLY0123'].map((part) => part.repeat(4));
    const tail = boundedRedactedOutputTail(['before', begin, ...body, end, 'after'].join('\n'), undefined) as string;
    expect(tail).toContain('before');
    expect(tail).toContain('after');
    for (const hidden of [begin, end, ...body]) {
      expect(tail).not.toContain(hidden);
    }
  });

  it('GD2 redacts a PEM block with no END line to the end of the tail', () => {
    const begin = '-----' + 'BEGIN ' + 'RSA ' + 'PRIVATE ' + 'KEY-----';
    const tail = boundedRedactedOutputTail(['before', begin, 'bodyline-one', 'bodyline-two'].join('\n'), undefined) as string;
    expect(tail).toBe(['before', '[redacted: secret-shaped line]', '[redacted: secret-shaped line]', '[redacted: secret-shaped line]'].join('\n'));
  });

  it('GD2 redacts a long base64-ish run, but not a hex digest', () => {
    const blob = 'aB3k9xQkL7mZ2pR4tY6uW8eI0oA1sD5fG7hJ9' + 'kLzXcV';
    expect(blob.length).toBe(43);
    const digest = 'abcdef0123456789'.repeat(4);
    const tail = boundedRedactedOutputTail(`${blob}\ndigest ${digest}`, undefined) as string;
    expect(tail).not.toContain(blob);
    expect(tail).toContain(digest);
    const slashed = 'aB3k9xQkL7mZ2pR4tY6/uW8eI0oA1sD5fG7hJ9kLzXcV+=';
    expect(boundedRedactedOutputTail(slashed, undefined)).toBe('[redacted: secret-shaped line]');
  });

  it('GD2 keeps path-shaped error locations out of the base64 redaction', () => {
    const lines = [
      'packages/work-execution/src/infrastructure/adapters/GatePredicateAdapter.adapter.ts(12,3): error TS2322: bad',
      'src/infrastructure/Adapters2/GatePredicateAdapter2Handler.adapter.ts(12,3): error TS2322: bad',
      '    at file:///home/u/work/packages/work-execution/src/Gate2Adapter/GatePredicate.test.ts:12:5',
      '/home/u/packages/work-execution/src/infrastructure/Adapters2/Gate.ts  12:3  error  no-unused-vars',
      'at node_modules/@scope/pkg/dist/index.js:10:2 node_modules/@scope/pkg2/Dist/Index2Handler.js',
    ];
    expect(boundedRedactedOutputTail(lines.join('\n'), undefined)).toBe(lines.join('\n'));
  });

  it('GD2 does not leak a token split by the 32 KiB cut', () => {
    const token = 'gh' + 'p_abc123def456ghi789jkl012mno345pqr678';
    const total = 32 * 1024;
    // The window is the last 32 KiB: the token starts 15 characters before the cut,
    // so the surviving 15-character-shorter suffix must not be emitted unredacted.
    const restLength = total + 15 - token.length;
    const rest = `\n${'y'.repeat(restLength - 6)}\nlast`;
    expect(rest.length).toBe(restLength);
    const out = boundedRedactedOutputTail(`${'q'.repeat(10)}${token}${rest}`, undefined) as string;
    expect(out).not.toContain(token.slice(15));
    expect(out).toContain('last');
  });

  it('GD2 keeps the byte bound after redaction, even when markers are longer than the lines they replace', () => {
    const begin = '-----' + 'BEGIN ' + 'X-----';
    const end = '-----' + 'END ' + 'X-----';
    const pairs = `${begin}\n${end}\n`.repeat(99);
    const filler = 'y'.repeat(32 * 1024 - pairs.length);
    const raw = pairs + filler;
    expect(raw.length).toBe(32 * 1024);
    const out = boundedRedactedOutputTail(raw, undefined) as string;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(out).not.toContain('BEGIN');
  });
});

/**
 * TP5A1: the typed host-side gate causes. `lint-arch-timeout` classifies a
 * `lint:arch` run ONLY from the executor's typed `errorCode: 'timeout'`
 * (never free-text error output); `missing-generated-types` classifies a
 * failing `typecheck` ONLY from the host-side probe of
 * `apps/web/.next/types` (never from command output). Both are hard `fail`
 * verdicts that never route to the congestion retry path.
 */
describe('GatePredicateAdapter typed gate causes (TP5A1)', () => {
  /**
   * An executor returning raw values (no spread), so a run can be `null`,
   * carry an accessor property, or an invalid `errorCode` exactly as it would
   * arrive over an untrusted boundary.
   */
  class RawScriptedExecutor implements CommandExecutorPort {
    readonly argvRecords: string[][] = [];

    constructor(private readonly script: (argv: readonly string[]) => unknown) {}

    async run(argv: readonly string[]): Promise<CommandRunResult> {
      this.argvRecords.push([...argv]);
      const scripted = this.script(argv);
      if (scripted === null || typeof scripted !== 'object') {
        return scripted as CommandRunResult;
      }
      // A clean-run default, overlaid with the script's own data properties —
      // copied as property descriptors, so an accessor property (a getter the
      // adapter must never invoke) survives instead of being read here.
      const base: Record<string, unknown> = { exitCode: 0, signal: null, stdout: '', stderr: '' };
      for (const key of Object.keys(scripted)) {
        const descriptor = Object.getOwnPropertyDescriptor(scripted, key);
        if (descriptor !== undefined) {
          Object.defineProperty(base, key, descriptor);
        }
      }
      return base as unknown as CommandRunResult;
    }
  }

  function makeRawAdapter(script: (argv: readonly string[]) => unknown): {
    adapter: GatePredicateAdapter;
    executor: RawScriptedExecutor;
  } {
    const executor = new RawScriptedExecutor(script);
    const fakeDiff = new FakeLaneDiffCheck({ outcome: 'clean' });
    let now = 0;
    const adapter = new GatePredicateAdapter({
      executorForRecordedHost: () => ({ ok: true, executor }),
      laneDiffCheckFor: () => fakeDiff,
      nowMs: () => {
        now += 1;
        return now;
      },
    });
    return { adapter, executor };
  }

  function commandRequest(argv: readonly string[]): EvaluateGatePredicatesRequest {
    return {
      ...REQUEST,
      spec: { commitRequired: true, diffCheck: true, commands: [{ argv: [...argv] }] },
    };
  }

  const LINT_ARCH = ['corepack', 'yarn', 'lint:arch'];
  const TYPECHECK = ['corepack', 'yarn', 'typecheck'];

  it('emits lint-arch-timeout only for lint:arch with typed errorCode timeout', async () => {
    // lint:arch with the typed timeout signal: fail with the typed cause.
    const typed = makeRawAdapter((argv) =>
      argv[0] === 'sh'
        ? {
            exitCode: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            error: 'command exceeded its 1000ms timeout and its process tree was killed',
            errorCode: 'timeout',
          }
        : happyGit(argv),
    );
    const typedResults = evaluatedResults(
      await typed.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(typedResults[2]).toMatchObject({
      kind: 'command',
      verdict: 'fail',
      exitCode: null,
      cause: 'lint-arch-timeout',
    });

    // The same free-text error without the typed code stays unknown, no cause.
    const freeText = makeRawAdapter((argv) =>
      argv[0] === 'sh'
        ? {
            exitCode: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            error: 'command exceeded its 1000ms timeout and its process tree was killed',
          }
        : happyGit(argv),
    );
    const freeTextResults = evaluatedResults(
      await freeText.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(freeTextResults[2]).toMatchObject({ kind: 'command', verdict: 'unknown' });
    expect(freeTextResults[2]).not.toHaveProperty('cause');

    // A non-lint:arch command with the typed timeout stays unknown, no cause.
    const otherCommand = makeRawAdapter((argv) =>
      argv[0] === 'sh'
        ? {
            exitCode: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            error: 'command exceeded its 1000ms timeout and its process tree was killed',
            errorCode: 'timeout',
          }
        : happyGit(argv),
    );
    const otherResults = evaluatedResults(
      await otherCommand.adapter.evaluateGatePredicates(commandRequest(['corepack', 'yarn', 'build'])),
    );
    expect(otherResults[2]).toMatchObject({ kind: 'command', verdict: 'unknown' });
    expect(otherResults[2]).not.toHaveProperty('cause');
  });

  it('returns fail without lint-arch-timeout when lint:arch exits 1 and unknown when exitCode is null', async () => {
    // Exit 1: the command's own hard failure, never the typed timeout cause.
    const exited = makeRawAdapter((argv) =>
      argv[0] === 'sh' ? { exitCode: 1, signal: null, stdout: '', stderr: '' } : happyGit(argv),
    );
    const exitedResults = evaluatedResults(
      await exited.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(exitedResults[2]).toMatchObject({ kind: 'command', verdict: 'fail', exitCode: 1 });
    expect(exitedResults[2]).not.toHaveProperty('cause');

    // Exit code null without the typed code: unknown, no cause.
    const noExit = makeRawAdapter((argv) =>
      argv[0] === 'sh' ? { exitCode: null, signal: null, stdout: '', stderr: '' } : happyGit(argv),
    );
    const noExitResults = evaluatedResults(
      await noExit.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(noExitResults[2]).toMatchObject({ kind: 'command', verdict: 'unknown', exitCode: null });
    expect(noExitResults[2]).not.toHaveProperty('cause');
  });

  it('keeps lint:arch exits 137 and 143 as unknown with resource-exhausted', async () => {
    for (const exitCode of [137, 143]) {
      const { adapter } = makeRawAdapter((argv) =>
        argv[0] === 'sh' ? { exitCode, signal: null, stdout: '', stderr: '' } : happyGit(argv),
      );
      const results = evaluatedResults(await adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)));
      expect(results[2]).toMatchObject({
        kind: 'command',
        verdict: 'unknown',
        exitCode,
        cause: 'resource-exhausted',
      });
    }
  });

  it('emits missing-generated-types only when the host probe confirms apps/web/.next/types absent', async () => {
    const failingTypecheck = {
      exitCode: 2,
      signal: null,
      stdout: "error TS6053: Cannot find file '/lanes/w1/apps/web/.next/types'",
      stderr: '',
    };
    // Probe exit 0: tsconfig.json exists and .next/types is absent.
    const absent = makeRawAdapter((argv) => {
      if (argv[0] === 'test') return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      if (argv[0] === 'sh') return { ...failingTypecheck };
      return happyGit(argv);
    });
    const absentResults = evaluatedResults(
      await absent.adapter.evaluateGatePredicates(commandRequest(TYPECHECK)),
    );
    expect(absentResults[2]).toMatchObject({
      kind: 'command',
      verdict: 'fail',
      exitCode: 2,
      cause: 'missing-generated-types',
    });
    // The host probe ran (the `.next`-types probe among the test probes), and
    // the classification never came from the output.
    const probeCalls = absent.executor.argvRecords.filter((argv) => argv[0] === 'test');
    expect(
      probeCalls.filter((argv) => argv.some((arg) => arg.includes('.next'))),
    ).toHaveLength(1);

    // Probe exit 1 (.next/types present): the failure stays the command's own,
    // even with TS6053 and .next/types in the output.
    const present = makeRawAdapter((argv) => {
      if (argv[0] === 'test') return { exitCode: 1, signal: null, stdout: '', stderr: '' };
      if (argv[0] === 'sh') return { ...failingTypecheck };
      return happyGit(argv);
    });
    const presentResults = evaluatedResults(
      await present.adapter.evaluateGatePredicates(commandRequest(TYPECHECK)),
    );
    expect(presentResults[2]).toMatchObject({ kind: 'command', verdict: 'fail', exitCode: 2 });
    expect(presentResults[2]).not.toHaveProperty('cause');
  });

  it('does not emit missing-generated-types when host probe errors or throws', async () => {
    const failingTypecheck = { exitCode: 2, signal: null, stdout: '', stderr: '' };
    // Probe reports its own error: failing closed, no typed cause.
    const probeError = makeRawAdapter((argv) => {
      if (argv[0] === 'test')
        return { exitCode: 1, signal: null, stdout: '', stderr: '', error: 'probe failed' };
      if (argv[0] === 'sh') return { ...failingTypecheck };
      return happyGit(argv);
    });
    const probeErrorResults = evaluatedResults(
      await probeError.adapter.evaluateGatePredicates(commandRequest(TYPECHECK)),
    );
    expect(probeErrorResults[2]).toMatchObject({ kind: 'command', verdict: 'fail', exitCode: 2 });
    expect(probeErrorResults[2]).not.toHaveProperty('cause');

    // Probe throws: nextTypesAbsent catches and reads false, no typed cause.
    const probeThrows = makeRawAdapter((argv) => {
      if (argv[0] === 'test') throw new Error('probe exploded');
      if (argv[0] === 'sh') return { ...failingTypecheck };
      return happyGit(argv);
    });
    const probeThrowsResults = evaluatedResults(
      await probeThrows.adapter.evaluateGatePredicates(commandRequest(TYPECHECK)),
    );
    expect(probeThrowsResults[2]).toMatchObject({ kind: 'command', verdict: 'fail', exitCode: 2 });
    expect(probeThrowsResults[2]).not.toHaveProperty('cause');
  });

  it('refuses CommandRunResult with invalid or non-string errorCode as unknown', async () => {
    for (const errorCode of ['bogus', 7, true]) {
      const { adapter } = makeRawAdapter((argv) =>
        argv[0] === 'sh'
          ? { exitCode: 1, signal: null, stdout: '', stderr: '', errorCode }
          : happyGit(argv),
      );
      const results = evaluatedResults(await adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)));
      expect(results[2]).toMatchObject({ kind: 'command', verdict: 'unknown', exitCode: null });
      expect(results[2]).not.toHaveProperty('cause');
    }
  });

  it('refuses getter on errorCode without invoking it', async () => {
    let reads = 0;
    const run: CommandRunResult = { exitCode: 1, signal: null, stdout: '', stderr: '' };
    Object.defineProperty(run, 'errorCode', {
      enumerable: true,
      get() {
        reads += 1;
        return 'timeout';
      },
    });
    const { adapter } = makeRawAdapter((argv) => (argv[0] === 'sh' ? run : happyGit(argv)));
    const results = evaluatedResults(await adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)));
    expect(reads).toBe(0);
    expect(results[2]).toMatchObject({ kind: 'command', verdict: 'unknown', exitCode: null });
    expect(results[2]).not.toHaveProperty('cause');
  });

  it('accepts CommandRunResult when optional errorCode is omitted', async () => {
    // A legacy/scripted executor's clean run: classified normally, no cause.
    const passing = makeRawAdapter((argv) =>
      argv[0] === 'sh' ? { exitCode: 0, signal: null, stdout: '', stderr: '' } : happyGit(argv),
    );
    const passingResults = evaluatedResults(
      await passing.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(passingResults[2]).toMatchObject({ kind: 'command', verdict: 'pass', exitCode: 0 });
    expect(passingResults[2]).not.toHaveProperty('cause');

    const failing = makeRawAdapter((argv) =>
      argv[0] === 'sh' ? { exitCode: 1, signal: null, stdout: '', stderr: '' } : happyGit(argv),
    );
    const failingResults = evaluatedResults(
      await failing.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(failingResults[2]).toMatchObject({ kind: 'command', verdict: 'fail', exitCode: 1 });
    expect(failingResults[2]).not.toHaveProperty('cause');
  });

  it('refuses non-array spec commands as unavailable without executing anything', async () => {
    const { adapter, executor } = makeRawAdapter(() => {
      throw new Error('no command must run for a malformed spec');
    });
    const request = commandRequest(LINT_ARCH);
    const malformed = {
      ...request,
      spec: { ...request.spec, commands: 'not-an-array' },
    } as unknown as EvaluateGatePredicatesRequest;
    const result = await adapter.evaluateGatePredicates(malformed);
    expect(result.outcome).toBe('unavailable');
    expect(executor.argvRecords).toHaveLength(0);
  });

  it('returns unknown without cause when the executor returns a null run or null exitCode', async () => {
    // The executor itself returned null: the whole run is refused, unknown.
    const nullRun = makeRawAdapter((argv) => (argv[0] === 'sh' ? null : happyGit(argv)));
    const nullRunResults = evaluatedResults(
      await nullRun.adapter.evaluateGatePredicates(commandRequest(LINT_ARCH)),
    );
    expect(nullRunResults[2]).toMatchObject({ kind: 'command', verdict: 'unknown', exitCode: null });
    expect(nullRunResults[2]).not.toHaveProperty('cause');
  });
});
