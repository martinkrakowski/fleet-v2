// GatePredicateAdapter tests — plan S2b.
/**
 * Covers GatePredicateAdapter over a scripted CommandExecutorPort: the
 * commit predicate (head, ancestor, count, clean tree), the lane diff check
 * through an injected laneDiffCheckFor, and fixed argv commands with their
 * declared coverage. Output never leaks into results.
 */

import { describe, expect, it } from 'vitest';

import { GatePredicateAdapter } from '../GatePredicateAdapter.adapter.js';
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
): { adapter: GatePredicateAdapter; executor: ScriptedExecutor; fakeDiff: FakeLaneDiffCheck } {
  const executor = new ScriptedExecutor(script);
  const fakeDiff = new FakeLaneDiffCheck(diff);
  let now = 0;
  const adapter = new GatePredicateAdapter({
    executorForRecordedHost: () => ({ ok: true, executor }),
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
      detail: 'worktree HEAD ' + 'c'.repeat(40) + ' is not the candidate head',
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
