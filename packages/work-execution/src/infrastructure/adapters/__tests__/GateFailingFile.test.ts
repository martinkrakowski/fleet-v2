// PT1a: the failing file a gate command's output names, and its carriage on gate results.
import { describe, expect, it } from 'vitest';

import { GatePredicateAdapter } from '../GatePredicateAdapter.adapter.js';
import { extractFailingFile } from '../GateFailingFile.helper.js';
import type { EvaluateGatePredicatesRequest } from '../../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneDiffCheckPort } from '../../../application/ports/out/LaneDiffCheckPort.out-port.js';

const WORKTREE = '/mnt/pool/cloud-services/projects/.worktrees/fleet-v2/pt1a';
const WORK_EXECUTION_TEST = ['yarn', 'workspace', '@fleet/work-execution', 'test'];

/** A vitest failure as `yarn workspace <name> test` prints it: workspace-relative path, ids only. */
const VITEST_FAILURE = [
  ' ❯ src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts (121 tests | 1 failed) 640ms',
  '   × AdvanceLaneRunUseCase fix-round prepare (K5-5) > f1b) a round-2 gate failure parks gate-outside-owned 19ms',
  '',
  ' FAIL  src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts > AdvanceLaneRunUseCase fix-round prepare (K5-5) > f1b)',
  'AssertionError: expected 1 to be +0 // Object.is equality',
  ' ❯ src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts:1431:28',
].join('\n');

describe('extractFailingFile (PT1a)', () => {
  it('reads the vitest FAIL line and makes the workspace path repo-relative', () => {
    expect(extractFailingFile(VITEST_FAILURE, '', WORKTREE, WORK_EXECUTION_TEST)).toBe(
      'packages/work-execution/src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts',
    );
    expect(extractFailingFile(VITEST_FAILURE, '', WORKTREE, ['yarn', 'workspace', '@fleet/cli', 'test'])).toBe(
      'apps/cli/src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts',
    );
  });

  it('reads a turbo-prefixed line, strips colour and reads stderr as well', () => {
    const turbo = '@fleet/installation:test:  \u001b[41m FAIL \u001b[49m src/__tests__/merge-policy.test.ts > resolveMergePolicy > applies defaults';
    // The colour codes sit between FAIL and the path: after stripping, the line matches the FAIL shape.
    expect(extractFailingFile('', turbo, WORKTREE, ['yarn', 'build'])).toBe(
      'packages/installation/src/__tests__/merge-policy.test.ts',
    );
  });

  it('falls back to a stack frame, a tsc error and an eslint header', () => {
    expect(extractFailingFile(' ❯ src/domain/park-class.ts:44:9', '', WORKTREE, WORK_EXECUTION_TEST)).toBe(
      'packages/work-execution/src/domain/park-class.ts',
    );
    expect(
      extractFailingFile("apps/cli/src/conductor.ts(1812,9): error TS2322: Type 'x' is not assignable.", '', WORKTREE, ['yarn', 'typecheck']),
    ).toBe('apps/cli/src/conductor.ts');
    expect(
      extractFailingFile(`${WORKTREE}/packages/shared/src/index.ts\n  12:3  error  Unexpected any  @typescript-eslint/no-explicit-any\n`, '', WORKTREE, ['yarn', 'lint']),
    ).toBe('packages/shared/src/index.ts');
  });

  it('is null when the output names no file, or only one the screen refuses', () => {
    expect(extractFailingFile('Tests  3 failed | 10 passed', '', WORKTREE, WORK_EXECUTION_TEST)).toBeNull();
    expect(extractFailingFile('', '', WORKTREE, WORK_EXECUTION_TEST)).toBeNull();
    // An absolute path outside the worktree and a path climbing out are refused, never repaired.
    expect(extractFailingFile(' FAIL  /home/martin/other/repo/src/x.test.ts > a', '', WORKTREE, ['yarn', 'test'])).toBeNull();
    expect(extractFailingFile(' FAIL  ../../outside/src/x.test.ts > a', '', WORKTREE, ['yarn', 'test'])).toBeNull();
    expect(extractFailingFile(' FAIL  packages/../../etc/x.test.ts > a', '', WORKTREE, ['yarn', 'test'])).toBeNull();
  });

  it('skips a refused candidate and takes the next usable one', () => {
    const output = [' FAIL  /elsewhere/abs.test.ts > a', ' FAIL  packages/shared/src/ok.test.ts > b'].join('\n');
    expect(extractFailingFile(output, '', WORKTREE, ['yarn', 'test'])).toBe('packages/shared/src/ok.test.ts');
  });

  it('never throws on malformed inputs', () => {
    expect(extractFailingFile(undefined, null, 42, 'not-an-array')).toBeNull();
    expect(extractFailingFile({}, [], undefined)).toBeNull();
  });
});

describe('GatePredicateAdapter failingFile (PT1a)', () => {
  const HEAD = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);

  function request(argv: readonly string[]): EvaluateGatePredicatesRequest {
    return {
      attemptId: 'attempt-01M64PT1PX2MAZVQDYAYMZ7WNB',
      worktreePath: WORKTREE,
      runner: null,
      baseCommit: BASE,
      candidateHeadSha: HEAD,
      allowedPathPrefixes: ['packages'],
      spec: { commitRequired: true, diffCheck: true, commands: [{ argv: [...argv] }] },
    };
  }

  function adapterFor(result: Partial<CommandRunResult>): GatePredicateAdapter {
    // The commit predicate's git calls answer as a clean two-commit branch at HEAD; the command answers `result`.
    const executor: CommandExecutorPort = {
      run: async (argv) => {
        const git = ['rev-parse', 'merge-base', 'rev-list', 'status'].find((sub) => argv.includes(sub));
        if (git === 'rev-parse') {
          return { exitCode: 0, signal: null, stdout: HEAD + '\n', stderr: '' };
        }
        if (git === 'rev-list') {
          return { exitCode: 0, signal: null, stdout: '2\n', stderr: '' };
        }
        if (git !== undefined) {
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        }
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...result };
      },
    };
    const diff: LaneDiffCheckPort = { checkLaneDiff: async () => ({ outcome: 'clean' }) };
    return new GatePredicateAdapter({
      executorForRecordedHost: () => ({ ok: true, executor }),
      laneDiffCheckFor: () => diff,
      nowMs: () => 0,
    });
  }

  it('a failing command carries the screened failing file, never the output', async () => {
    const outcome = await adapterFor({ exitCode: 1, stdout: VITEST_FAILURE }).evaluateGatePredicates(request(WORK_EXECUTION_TEST));
    expect(outcome.outcome).toBe('evaluated');
    if (outcome.outcome !== 'evaluated') {
      return;
    }
    const command = outcome.results.find((result) => result.kind === 'command');
    expect(command?.verdict).toBe('fail');
    expect(command?.failingFile).toBe(
      'packages/work-execution/src/application/use-cases/__tests__/advance-lane-run-fix-round.test.ts',
    );
    expect(JSON.stringify(command)).not.toContain('AssertionError');
  });

  it('a failing command with no file in its output records null', async () => {
    const outcome = await adapterFor({ exitCode: 1, stdout: 'something broke\n' }).evaluateGatePredicates(request(WORK_EXECUTION_TEST));
    if (outcome.outcome !== 'evaluated') {
      throw new Error('expected an evaluation');
    }
    const command = outcome.results.find((result) => result.kind === 'command');
    expect(command?.verdict).toBe('fail');
    expect(command?.failingFile).toBeNull();
  });

  it('a passing command carries no failingFile field', async () => {
    const outcome = await adapterFor({ exitCode: 0, stdout: VITEST_FAILURE }).evaluateGatePredicates(request(WORK_EXECUTION_TEST));
    if (outcome.outcome !== 'evaluated') {
      throw new Error('expected an evaluation');
    }
    const command = outcome.results.find((result) => result.kind === 'command');
    expect(command?.verdict).toBe('pass');
    expect(command !== undefined && 'failingFile' in command).toBe(false);
  });
});
