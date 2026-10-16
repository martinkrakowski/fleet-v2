// @generated adapter scaffold — implemented for migration station O3 (local command executor).
/**
 * LocalExecutor implements CommandExecutorPort by spawning the argv array
 * directly through `execFile`. A shell is never involved: every argument
 * travels as one argv element, so shell metacharacters in an argument keep
 * their literal meaning.
 */

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';

/** Completed execFile outcome, including the failure shapes. */
interface ExecFileOutcome {
  stdout: string;
  stderr: string;
  code?: number | string;
  signal?: string | null;
  error?: Error;
}

/**
 * Run one argv array through execFile, forwarding `input` on the child's
 * stdin, and resolve with the completed outcome (exit code and signal for a
 * terminated child, an error description for a spawn failure).
 */
function runExecFile(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
    input?: string;
  },
): Promise<ExecFileOutcome & { code?: number | string; signal?: string | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: { ...options.env } } : {}),
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs, killSignal: 'SIGTERM' } : {}),
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean })
          | null;
        if (failure === null) {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 });
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(typeof failure.code === 'number'
            ? { code: failure.code, signal: typeof failure.signal === 'string' ? failure.signal : null }
            : { error: failure, signal: typeof failure.signal === 'string' ? failure.signal : null }),
        });
      },
    ) as unknown as ChildProcess;
    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {
        // The child may exit before consuming all stdin; the completed
        // outcome is reported by the execFile callback either way.
      });
      child.stdin.end(options.input, 'utf8');
    }
  });
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
    const outcome = await runExecFile(argv[0], argv.slice(1), {
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.input !== undefined ? { input: options.input } : {}),
    });
    const exitCode = typeof outcome.code === 'number' ? outcome.code : null;
    const signal = typeof outcome.signal === 'string' ? outcome.signal : null;
    if (outcome.error !== undefined && exitCode === null) {
      // Spawn failure or a termination without an exit code: reported, never
      // guessed.
      return {
        exitCode: null,
        signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        error: outcome.error.message ?? String(outcome.error),
      };
    }
    return { exitCode, signal, stdout: outcome.stdout, stderr: outcome.stderr };
  }
}
