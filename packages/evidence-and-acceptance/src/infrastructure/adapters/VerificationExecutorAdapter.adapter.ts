/**
 * VerificationExecutorAdapter implements VerificationExecutorPort.
 *
 * It runs an allow-listed verification command as an explicit argv array,
 * locally or through batch-mode ssh on the configured verification host, and
 * maps the completed process outcome onto the evidence result, fail closed:
 * only exit code 0 of a completed check is `pass`; anything missing, killed
 * or ambiguous is `unknown`. No command is ever run through a shell. A
 * procedure that declares coverage passes only when its reader counted at
 * least `minUnits` units in the full output.
 */

import { spawnSync } from 'node:child_process';
import { applyCoverage, isCheckCoverage } from '../../domain/check-coverage.js';
import type { CheckCoverage, CoverageExpectation, CoverageUnitKind } from '../../domain/check-coverage.js';
import { COVERAGE_READER_UNIT_KINDS, isCoverageReaderName, readCheckCoverage } from './coverage-readers.js';
import type { CoverageReaderName } from './coverage-readers.js';
import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type {
  ExecuteVerificationCheckRequest,
  ExecuteVerificationCheckResult,
  VerificationExecutorPort,
} from '../../application/ports/out/VerificationExecutorPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';

/** Optional coverage the procedure must show; absent means today's exit-0 rule (plan D3). */
export interface ProcedureCoverageDeclaration {
  readonly reader: CoverageReaderName;
  readonly unitKind: CoverageUnitKind;
  readonly minUnits: number;
}

/** Allow-listed check: an executable plus optional fixed arguments. */
export interface AllowListedVerificationCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly coverage?: ProcedureCoverageDeclaration;
}

/** Completed outcome of one spawned process, as far as this port needs it. */
export interface SpawnedVerificationOutcome {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
  readonly stdout: string;
  readonly stderr: string;
}

/** Transport seam; defaults to `spawnSync` without a shell. */
export type SpawnVerificationTransport = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => SpawnedVerificationOutcome;

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_SUMMARY_LIMIT = 4000;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export interface VerificationExecutorOptions {
  /** Test/seam transport: runs the check and returns its completed result. */
  readonly runCheck?: (
    request: ExecuteVerificationCheckRequest,
  ) => Promise<ExecuteVerificationCheckResult>;
  /**
   * Explicit allow-list of `procedureName -> executable path (plus optional
   * fixed arguments)` on the verification host (for example `verify-run.sh`).
   * A procedure with no entry is never executed, and no command string is
   * ever interpolated into a shell.
   */
  readonly allowListedCommands?: Readonly<
    Record<string, string | AllowListedVerificationCommand>
  >;
  /**
   * SSH destination of the verification host (`host` or `user@host`). When
   * set, the allow-listed command runs over ssh in batch mode. A host that
   * starts with `-` or contains whitespace is rejected without spawning.
   */
  readonly sshHost?: string;
  /**
   * Executor owning the verification host's commands (local or ssh). When
   * set it is authoritative and the allow-listed command travels as one argv
   * array through it, never through a shell.
   */
  readonly executor?: CommandExecutorPort;
  /** Wall-clock budget for one check; a check that exceeds it is `unknown`. */
  readonly timeoutMs?: number;
  /**
   * Spawn seam for tests; defaults to `spawnSync` with `encoding: 'utf8'`
   * and no shell. The command always travels as an argv array.
   */
  readonly spawn?: SpawnVerificationTransport;
}

const defaultSpawnTransport: SpawnVerificationTransport = (file, args, options) => {
  const executed = spawnSync(file, args, { ...options, encoding: 'utf8' });
  return {
    status: executed.status,
    signal: executed.signal,
    error: executed.error,
    stdout: executed.stdout,
    stderr: executed.stderr,
  };
};

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveAllowListedCommand(
  entry: unknown,
): { readonly command: string; readonly args: readonly string[] } | null {
  if (typeof entry === 'string') {
    return isNonEmptyTrimmedString(entry) ? { command: entry, args: [] } : null;
  }
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  const candidate = entry as { command?: unknown; args?: unknown };
  if (!isNonEmptyTrimmedString(candidate.command)) {
    return null;
  }
  const args = candidate.args ?? [];
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) {
    return null;
  }
  return { command: candidate.command, args };
}

function resolveCoverageDeclaration(
  entry: unknown,
): ProcedureCoverageDeclaration | undefined | 'malformed' {
  if (typeof entry === 'string') {
    return undefined;
  }
  if (entry === null || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  // Own property only: an inherited coverage is never a declaration.
  const coverage = Object.hasOwn(record, 'coverage') ? record.coverage : undefined;
  if (coverage === undefined) {
    return undefined;
  }
  if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return 'malformed';
  }
  const declaration = coverage as Record<string, unknown>;
  const keys = Object.keys(declaration);
  if (
    keys.length !== 3 ||
    !keys.includes('reader') ||
    !keys.includes('unitKind') ||
    !keys.includes('minUnits')
  ) {
    return 'malformed';
  }
  if (!isCoverageReaderName(declaration.reader)) {
    return 'malformed';
  }
  const expectedUnitKind = COVERAGE_READER_UNIT_KINDS[declaration.reader];
  if (declaration.unitKind !== expectedUnitKind) {
    return 'malformed';
  }
  if (
    typeof declaration.minUnits !== 'number' ||
    !Number.isSafeInteger(declaration.minUnits) ||
    declaration.minUnits < 1
  ) {
    return 'malformed';
  }
  return {
    reader: declaration.reader,
    unitKind: expectedUnitKind,
    minUnits: declaration.minUnits,
  };
}

/**
 * ssh joins the words after the destination into one remote shell line, so
 * every remote word is POSIX-single-quoted (`'` becomes `'\''`).
 */
function quotePosixSingleQuoted(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/** An ssh destination that could inject options or split words never spawns. */
function isSpawnableSshHost(host: string): boolean {
  return host.length > 0 && !host.startsWith('-') && !/\s/.test(host);
}

function receipt(
  result: EvidenceResultValue,
  exitCode: number | null,
  outputSummary: string,
  completedAtIso: string,
  coverage?: CheckCoverage,
): ExecuteVerificationCheckResult {
  return {
    result,
    exitCode,
    outputSummary: outputSummary.slice(-OUTPUT_SUMMARY_LIMIT),
    completedAtIso,
    ...(coverage !== undefined ? { coverage } : {}),
  };
}

function measureCoverage(
  declaration: ProcedureCoverageDeclaration,
  output: string,
): CheckCoverage {
  const read = readCheckCoverage(declaration.reader, output);
  return isCheckCoverage(read)
    ? read
    : { ran: false, reason: 'coverage reader returned a malformed value' };
}

function coverageNote(
  declaration: ProcedureCoverageDeclaration,
  coverage: CheckCoverage,
): string {
  if (coverage.ran) {
    return (
      'coverage: ' +
      coverage.units +
      ' ' +
      coverage.unitKind +
      ' (at least ' +
      declaration.minUnits +
      ' ' +
      declaration.unitKind +
      ' expected)'
    );
  }
  return 'coverage: not read (' + coverage.reason + ')';
}

function completedReceipt(
  exitCode: number,
  output: string,
  procedureName: string,
  declaration: ProcedureCoverageDeclaration | undefined,
  completedAtIso: string,
): ExecuteVerificationCheckResult {
  const raw: EvidenceResultValue = exitCode === 0 ? 'pass' : 'fail';
  const summary =
    output.length > 0 ? output : `'${procedureName}' produced no output`;
  if (declaration === undefined) {
    return receipt(raw, exitCode, summary, completedAtIso);
  }
  const coverage = measureCoverage(declaration, output);
  const expectation: CoverageExpectation = {
    unitKind: declaration.unitKind,
    minUnits: declaration.minUnits,
  };
  const result = applyCoverage(raw, coverage, expectation);
  const summaryWithNote = summary + '\n' + coverageNote(declaration, coverage);
  return receipt(result, exitCode, summaryWithNote, completedAtIso, coverage);
}

export class VerificationExecutorAdapter implements VerificationExecutorPort {
  constructor(private readonly options: VerificationExecutorOptions = {}) {}

  async executeVerificationCheck(
    request: ExecuteVerificationCheckRequest,
  ): Promise<ExecuteVerificationCheckResult> {
    const runCheck = this.options.runCheck;
    if (runCheck !== undefined) {
      return runCheck(request);
    }

    const completedAtIso = new Date().toISOString();
    const resolved = resolveAllowListedCommand(
      this.options.allowListedCommands?.[request.procedureName],
    );
    if (resolved === null) {
      return receipt(
        'unknown',
        null,
        `no allow-listed verification command is configured for '${request.procedureName}'`,
        completedAtIso,
      );
    }

    const declaration = resolveCoverageDeclaration(
      this.options.allowListedCommands?.[request.procedureName],
    );
    if (declaration === 'malformed') {
      return receipt(
        'unknown',
        null,
        `the coverage declaration for '${request.procedureName}' is malformed; refusing to run it`,
        completedAtIso,
      );
    }

    if (!SHA_PATTERN.test(request.candidateHeadSha)) {
      return receipt(
        'unknown',
        null,
        `candidate head sha is malformed; refusing to run '${request.procedureName}'`,
        completedAtIso,
      );
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const executor = this.options.executor;
    if (executor !== undefined) {
      const executed = await executor.run([resolved.command, ...resolved.args, request.candidateHeadSha], {
        timeoutMs,
      });
      const output = [executed.stdout, executed.stderr]
        .filter((part) => part.trim().length > 0)
        .join('\n');
      if (executed.error !== undefined) {
        return receipt('unknown', executed.exitCode, `spawn failed: ${executed.error}`, completedAtIso);
      }
      if (executed.signal !== null) {
        return receipt(
          'unknown',
          executed.exitCode,
          `verification check was terminated by signal ${executed.signal} before completing`,
          completedAtIso,
        );
      }
      if (executed.exitCode === null) {
        return receipt(
          'unknown',
          null,
          'verification check ended without reporting an exit code',
          completedAtIso,
        );
      }
      if (executed.exitCode === 255) {
        // Through an ssh executor exit 255 means the transport itself
        // failed before the check ran; the check's own outcome is unknown.
        return receipt(
          'unknown',
          executed.exitCode,
          'verification check exited 255; through an ssh executor this means the transport failed before the check completed',
          completedAtIso,
        );
      }
      return completedReceipt(executed.exitCode, output, request.procedureName, declaration, completedAtIso);
    }

    const sshHost = this.options.sshHost;
    if (sshHost !== undefined && !isSpawnableSshHost(sshHost)) {
      return receipt(
        'unknown',
        null,
        `configured ssh host is invalid; refusing to run '${request.procedureName}'`,
        completedAtIso,
      );
    }

    const spawn = this.options.spawn ?? defaultSpawnTransport;
    let file: string;
    let argv: readonly string[];
    if (sshHost !== undefined) {
      file = 'ssh';
      argv = [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        sshHost,
        '--',
        ...[resolved.command, ...resolved.args, request.candidateHeadSha].map(
          quotePosixSingleQuoted,
        ),
      ];
    } else {
      file = resolved.command;
      argv = [...resolved.args, request.candidateHeadSha];
    }

    const execution = spawn(file, argv, { timeout: timeoutMs });

    if (execution.error !== undefined) {
      const failure = execution.error as NodeJS.ErrnoException;
      return receipt(
        'unknown',
        execution.status,
        `spawn failed: ${failure.code ?? failure.message}`,
        completedAtIso,
      );
    }

    if (execution.signal !== null) {
      return receipt(
        'unknown',
        execution.status,
        `verification check was terminated by signal ${execution.signal} before completing`,
        completedAtIso,
      );
    }

    if (execution.status === null) {
      return receipt(
        'unknown',
        null,
        'verification check ended without reporting an exit code',
        completedAtIso,
      );
    }

    if (sshHost !== undefined && execution.status === 255) {
      return receipt(
        'unknown',
        execution.status,
        'ssh transport failed with exit code 255 before the verification check completed',
        completedAtIso,
      );
    }

    const output = [execution.stdout, execution.stderr]
      .filter((part) => part.trim().length > 0)
      .join('\n');
    return completedReceipt(execution.status, output, request.procedureName, declaration, completedAtIso);
  }
}
