// @generated adapter scaffold — implemented for migration station O3 (batch-mode ssh executor).
/**
 * SshExecutor implements CommandExecutorPort by carrying one argv array to a
 * remote POSIX shell through batch-mode ssh:
 *
 *   ssh -o BatchMode=yes <host> -- <argv quoted for the remote POSIX shell>
 *
 * Every remote word is POSIX-single-quoted, so no argument is ever split or
 * interpreted by the remote shell. An unsafe host is refused before any
 * subprocess is spawned.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isSafeSshHost } from './WorkspaceAdapter.adapter.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';

const execFileAsync = promisify(execFile);

export interface SshExecutorOptions {
  /** Safe ssh destination (`host` or `user@host`) owning the remote commands. */
  readonly host: string;
}

/** Single-quote one argument for the remote POSIX shell. */
export function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** The ssh argv that carries `argv` to `host` in batch mode. */
export function sshArgvFor(host: string, argv: readonly string[]): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    host,
    '--',
    argv.map(posixQuote).join(' '),
  ];
}

export class SshExecutor implements CommandExecutorPort {
  constructor(private readonly options: SshExecutorOptions) {}

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    const host = this.options.host;
    if (!isSafeSshHost(host)) {
      // Refused before any spawn: an unsafe destination never reaches ssh.
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: `Refusing to execute on unsafe SSH host: ${host}`,
      };
    }
    if (argv.length === 0) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: 'SshExecutor refuses to run an empty argv',
      };
    }
    try {
      const { stdout, stderr } = await execFileAsync('ssh', sshArgvFor(host, argv), {
        ...(options?.input !== undefined ? { input: options.input, encoding: 'utf8' as const } : { encoding: 'utf8' as const }),
        ...(options?.env !== undefined ? { env: { ...options.env } } : {}),
        ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      });
      return { exitCode: 0, signal: null, stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
      return sshFailureResult(error);
    }
  }
}

/** Map a completed-but-failed ssh call onto the port's result. */
function sshFailureResult(error: unknown): CommandRunResult {
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
