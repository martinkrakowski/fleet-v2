// @generated adapter scaffold — implemented for migration station O3 (evidence copy of the local executor).
/**
 * LocalExecutor implements the evidence context's CommandExecutorPort by
 * spawning the argv array directly through `execFile`. A shell is never
 * involved: every argument travels as one argv element.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';

const execFileAsync = promisify(execFile);

interface ExecFileOutcome {
  stdout: string;
  stderr: string;
}

export class LocalExecutor implements CommandExecutorPort {
  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    if (argv.length === 0) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: 'LocalExecutor refuses to run an empty argv',
      };
    }
    try {
      const { stdout, stderr } = (await execFileAsync(argv[0], [...argv.slice(1)], {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: { ...options.env } } : {}),
        ...(options?.input !== undefined
          ? { input: options.input, encoding: 'utf8' as const }
          : { encoding: 'utf8' as const }),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      })) as unknown as ExecFileOutcome;
      return { exitCode: 0, signal: null, stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
      return localFailureResult(error);
    }
  }
}

/** Map a completed-but-failed execFile call onto the port's result. */
function localFailureResult(error: unknown): CommandRunResult {
  const failure = error as {
    code?: number | string;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    message?: string;
  };
  if (typeof failure.code === 'number') {
    return {
      exitCode: failure.code,
      signal: typeof failure.signal === 'string' ? failure.signal : null,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    };
  }
  return {
    exitCode: null,
    signal: typeof failure.signal === 'string' ? failure.signal : null,
    stdout: String(failure.stdout ?? ''),
    stderr: String(failure.stderr ?? ''),
    error: failure.message ?? String(error),
  };
}
