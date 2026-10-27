// Adapter for plan S2: evaluates the frozen acceptance spec on the attempt's
// recorded worktree host. Predicates are data from the frozen manifest; model
// reports are never an input. Results carry no command output: output is read
// only by the coverage reader, and details carry exit codes, counts, durations
// and diff-check findings (path, line, rule) — never a matched value.
/**
 * GatePredicateAdapter implements GatePredicatePort over an injected
 * CommandExecutorPort (resolved for the attempt's recorded host). It runs the
 * predicates in order: the commit since the base at the candidate head with a
 * clean tree, the lane diff check, then each fixed argv command with its
 * declared coverage. The first predicate that does not pass stops the run;
 * every later predicate is reported skipped and is never executed, so a
 * command never runs after a failed diff check.
 */

import type {
  GatePredicatePort,
  GatePredicateResult,
  GatePredicateKind,
  GatePredicateVerdict,
  EvaluateGatePredicatesRequest,
  EvaluateGatePredicatesResult,
} from '../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type { ExecutorForRecordedHostResult } from './ExecutorForHost.helper.js';
import { LaneDiffCheckAdapter } from './LaneDiffCheckAdapter.adapter.js';
import type {
  LaneDiffCheckPort,
  LaneDiffCheckResult,
} from '../../application/ports/out/LaneDiffCheckPort.out-port.js';
import { SshExecutor } from './SshExecutor.adapter.js';
import {
  applyCoverage,
  isCheckCoverage,
  readCheckCoverage,
} from '@fleet/evidence-and-acceptance';
import type {
  CheckCoverage,
  EvidenceResultValue,
} from '@fleet/evidence-and-acceptance';
import type { GateCommand } from '../../domain/value-objects/AcceptanceSpec.vo.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';

export interface GatePredicateAdapterOptions {
  /** The composition root passes ExecutorForHost.executorForRecordedHost. */
  readonly executorForRecordedHost: (runner: AttemptRunnerRecord | null) => ExecutorForRecordedHostResult;
  /** Default: (executor) => new LaneDiffCheckAdapter(executor). */
  readonly laneDiffCheckFor?: (executor: CommandExecutorPort) => LaneDiffCheckPort;
  /** Per-command wall-clock budget; default 30 minutes. */
  readonly commandTimeoutMs?: number;
  /** Whether exit 255 is the transport's failure; default `executor instanceof SshExecutor`. */
  readonly isRemote?: (executor: CommandExecutorPort) => boolean;
  /** Millisecond clock for durations; default Date.now. */
  readonly nowMs?: () => number;
}

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const GIT_HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/** A run that never reported a completed exit is not a verdict. */
function gitFailed(run: CommandRunResult): boolean {
  return run.error !== undefined || run.exitCode === null;
}

function skipped(name: string, kind: GatePredicateKind): GatePredicateResult {
  return {
    name,
    kind,
    verdict: 'skipped',
    exitCode: null,
    durationMs: 0,
    detail: 'not run: an earlier predicate did not pass',
  };
}

function commandName(command: GateCommand, index: number): string {
  return ('command ' + (index + 1) + ': ' + command.argv.join(' ')).slice(0, 120);
}

/** Raw command verdict before coverage is applied; exit 255 is only a transport failure when remote. */
function rawVerdict(run: CommandRunResult, isRemote: boolean): EvidenceResultValue {
  if (run.error !== undefined || run.exitCode === null) {
    return 'unknown';
  }
  if (run.exitCode === 255 && isRemote) {
    return 'unknown';
  }
  if (run.exitCode === 0) {
    return 'pass';
  }
  return 'fail';
}

function mapVerdict(value: EvidenceResultValue): GatePredicateVerdict {
  if (value === 'pass') {
    return 'pass';
  }
  if (value === 'fail') {
    return 'fail';
  }
  return 'unknown';
}

function detailForCommand(
  run: CommandRunResult,
  command: GateCommand,
  coverage: CheckCoverage | undefined,
): string {
  const exit = run.exitCode === null ? 'no exit code' : 'exit ' + String(run.exitCode);
  if (command.coverage === undefined) {
    return exit;
  }
  if (coverage !== undefined && coverage.ran) {
    return (
      exit +
      ', coverage ' +
      coverage.units +
      ' ' +
      coverage.unitKind +
      ' (at least ' +
      command.coverage.minUnits +
      ')'
    );
  }
  const reason = coverage !== undefined ? coverage.reason : 'coverage reader returned a malformed value';
  return exit + ', coverage not read (' + reason + ')';
}

export class GatePredicateAdapter implements GatePredicatePort {
  private readonly executorForRecordedHost: (
    runner: AttemptRunnerRecord | null,
  ) => ExecutorForRecordedHostResult;
  private readonly laneDiffCheckFor: (executor: CommandExecutorPort) => LaneDiffCheckPort;
  private readonly commandTimeoutMs: number;
  private readonly isRemote: (executor: CommandExecutorPort) => boolean;
  private readonly nowMs: () => number;

  constructor(options: GatePredicateAdapterOptions) {
    this.executorForRecordedHost = options.executorForRecordedHost;
    this.laneDiffCheckFor =
      options.laneDiffCheckFor ?? ((executor) => new LaneDiffCheckAdapter(executor));
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.isRemote = options.isRemote ?? ((executor) => executor instanceof SshExecutor);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async evaluateGatePredicates(
    request: EvaluateGatePredicatesRequest,
  ): Promise<EvaluateGatePredicatesResult> {
    const resolved = this.executorForRecordedHost(request.runner);
    if (!resolved.ok) {
      return { outcome: 'unavailable', reason: resolved.reason };
    }
    const executor = resolved.executor;

    const commit = await this.commitPredicate(executor, request);
    const diff =
      commit.verdict === 'pass'
        ? await this.diffPredicate(executor, request)
        : skipped('diff-check', 'diff-check');

    const initial: Promise<GatePredicateResult[]> = Promise.resolve([]);
    const commandResults = await request.spec.commands.reduce(
      (chain, command, index) =>
        chain.then(async (done) => {
          const blocked =
            diff.verdict !== 'pass' || done.some((result) => result.verdict !== 'pass');
          const next = blocked
            ? skipped(commandName(command, index), 'command')
            : await this.runCommand(executor, request.worktreePath, command, index);
          return [...done, next];
        }),
      initial,
    );

    return { outcome: 'evaluated', results: [commit, diff, ...commandResults] };
  }

  private async runGit(
    executor: CommandExecutorPort,
    worktreePath: string,
    argv: readonly string[],
  ): Promise<CommandRunResult> {
    return executor.run(
      ['git', '-C', worktreePath, ...GIT_HARDENING, ...argv],
      { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS },
    );
  }

  private async commitPredicate(
    executor: CommandExecutorPort,
    request: EvaluateGatePredicatesRequest,
  ): Promise<GatePredicateResult> {
    const started = this.nowMs();
    const base = request.baseCommit;
    const candidateHeadSha = request.candidateHeadSha;

    const fail = (detail: string): GatePredicateResult => ({
      name: 'commit',
      kind: 'commit',
      verdict: 'fail',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail,
    });
    const unknown = (detail: string): GatePredicateResult => ({
      name: 'commit',
      kind: 'commit',
      verdict: 'unknown',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail,
    });

    if (!COMMIT_PATTERN.test(base) || !COMMIT_PATTERN.test(candidateHeadSha)) {
      return fail('invalid base or candidate commit');
    }

    const revParse = await this.runGit(executor, request.worktreePath, ['rev-parse', 'HEAD']);
    if (gitFailed(revParse)) {
      return unknown('git rev-parse did not complete');
    }
    const head = revParse.stdout.trim();
    if (head !== candidateHeadSha) {
      return fail('worktree HEAD ' + head + ' is not the candidate head');
    }

    const mergeBase = await this.runGit(executor, request.worktreePath, [
      'merge-base',
      '--is-ancestor',
      base,
      candidateHeadSha,
    ]);
    if (gitFailed(mergeBase)) {
      return unknown('git merge-base did not complete');
    }
    if (mergeBase.exitCode === 1) {
      return fail('base is not an ancestor of the candidate head');
    }
    if (mergeBase.exitCode !== 0) {
      return unknown('git merge-base did not complete');
    }

    const revList = await this.runGit(executor, request.worktreePath, [
      'rev-list',
      '--count',
      base + '..' + candidateHeadSha,
    ]);
    if (gitFailed(revList) || revList.exitCode !== 0) {
      return unknown('git rev-list did not complete');
    }
    const count = Number.parseInt(revList.stdout.trim(), 10);
    if (!Number.isSafeInteger(count) || count < 1) {
      return fail('no commit since the base');
    }

    const status = await this.runGit(executor, request.worktreePath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    if (gitFailed(status) || status.exitCode !== 0) {
      return unknown('git status did not complete');
    }
    if (status.stdout !== '') {
      return fail('uncommitted changes in the worktree');
    }

    return {
      name: 'commit',
      kind: 'commit',
      verdict: 'pass',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail: 'head ' + candidateHeadSha + ', ' + count + ' commit(s) since the base',
    };
  }

  private diffUnknown(started: number, detail: string): GatePredicateResult {
    return {
      name: 'diff-check',
      kind: 'diff-check',
      verdict: 'unknown',
      exitCode: null,
      durationMs: this.nowMs() - started,
      detail,
    };
  }

  private async diffPredicate(
    executor: CommandExecutorPort,
    request: EvaluateGatePredicatesRequest,
  ): Promise<GatePredicateResult> {
    const started = this.nowMs();
    const laneDiffCheck = this.laneDiffCheckFor(executor);
    let result: LaneDiffCheckResult;
    try {
      result = await laneDiffCheck.checkLaneDiff({
        worktreePath: request.worktreePath,
        baseCommit: request.baseCommit,
        allowedPathPrefixes: request.allowedPathPrefixes,
      });
    } catch {
      return this.diffUnknown(started, 'diff check threw');
    }
    if (result.outcome === 'clean') {
      return {
        name: 'diff-check',
        kind: 'diff-check',
        verdict: 'pass',
        exitCode: null,
        durationMs: this.nowMs() - started,
        detail: 'clean',
      };
    }
    if (result.outcome === 'findings') {
      const joined = result.findings
        .slice(0, 10)
        .map(
          (finding) =>
            finding.path + (finding.line === undefined ? '' : ':' + finding.line) + ' ' + finding.rule,
        )
        .join('; ');
      return {
        name: 'diff-check',
        kind: 'diff-check',
        verdict: 'fail',
        exitCode: null,
        durationMs: this.nowMs() - started,
        detail: result.findings.length + ' finding(s): ' + joined,
      };
    }
    return this.diffUnknown(started, 'diff check error: ' + result.reason);
  }

  private async runCommand(
    executor: CommandExecutorPort,
    worktreePath: string,
    command: GateCommand,
    index: number,
  ): Promise<GatePredicateResult> {
    const started = this.nowMs();
    const name = commandName(command, index);
    let run: CommandRunResult;
    try {
      run = await executor.run(
        ['sh', '-c', 'cd -- "$1" && shift && exec "$@"', 'fleet-gate', worktreePath, ...command.argv],
        {
          cwd: worktreePath,
          timeoutMs: this.commandTimeoutMs,
          maxBufferBytes: MAX_OUTPUT_BYTES,
        },
      );
    } catch {
      return {
        name,
        kind: 'command',
        verdict: 'unknown',
        exitCode: null,
        durationMs: this.nowMs() - started,
        detail: 'command did not complete',
      };
    }

    const raw = rawVerdict(run, this.isRemote(executor));
    if (command.coverage === undefined) {
      return {
        name,
        kind: 'command',
        verdict: mapVerdict(raw),
        exitCode: run.exitCode,
        durationMs: this.nowMs() - started,
        detail: detailForCommand(run, command, undefined),
      };
    }

    const output = [run.stdout, run.stderr].filter((part) => part.trim() !== '').join('\n');
    const read = readCheckCoverage(command.coverage.reader, output);
    const coverage: CheckCoverage = isCheckCoverage(read)
      ? read
      : { ran: false, reason: 'coverage reader returned a malformed value' };
    const verdict = applyCoverage(raw, coverage, {
      unitKind: command.coverage.unitKind,
      minUnits: command.coverage.minUnits,
    });
    return {
      name,
      kind: 'command',
      verdict: mapVerdict(verdict),
      exitCode: run.exitCode,
      durationMs: this.nowMs() - started,
      detail: detailForCommand(run, command, coverage),
      coverage,
    };
  }
}
