// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * VerificationExecutorAdapter implements VerificationExecutorPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import { spawnSync } from 'node:child_process';
import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type {
  ExecuteVerificationCheckRequest,
  ExecuteVerificationCheckResult,
  VerificationExecutorPort,
} from '../../application/ports/out/VerificationExecutorPort.out-port.js';

export interface VerificationExecutorOptions {
  /** Test/seam transport: runs the check and returns its completed result. */
  readonly runCheck?: (
    request: ExecuteVerificationCheckRequest,
  ) => Promise<ExecuteVerificationCheckResult>;
  /**
   * Explicit allow-list of `procedureName -> executable path` on the
   * verification host (for example `verify-run.sh`). A procedure with no
   * entry is never executed, and no command string is ever interpolated
   * into a shell.
   */
  readonly allowListedCommands?: Readonly<Record<string, string>>;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A missing exit code means the check never completed: that is `unknown`. */
function resultForExitCode(exitCode: number | null): EvidenceResultValue {
  if (exitCode === 0) {
    return 'pass';
  }
  if (exitCode === null) {
    return 'unknown';
  }
  return 'fail';
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
    const command = this.options.allowListedCommands?.[request.procedureName];
    if (!isNonEmptyTrimmedString(command)) {
      return {
        result: 'unknown',
        exitCode: null,
        outputSummary: `no allow-listed verification command is configured for '${request.procedureName}'`,
        completedAtIso,
      };
    }

    const execution = spawnSync(command, [request.candidateHeadSha], { encoding: 'utf8' });
    const outputSummary = [execution.stdout ?? '', execution.stderr ?? '']
      .filter((part) => part.trim().length > 0)
      .join('\n');
    return {
      result: resultForExitCode(execution.status),
      exitCode: execution.status,
      outputSummary:
        outputSummary.length > 0 ? outputSummary : `'${request.procedureName}' produced no output`,
      completedAtIso,
    };
  }
}