// @generated adapter scaffold — implemented for migration station O3 (evidence copy of the ssh executor).
/**
 * SshExecutor implements the evidence context's CommandExecutorPort by
 * carrying one argv array to a remote POSIX shell through batch-mode ssh:
 *
 *   ssh -o BatchMode=yes <host> -- <argv quoted for the remote POSIX shell>
 *
 * `input` is written to the ssh client's stdin (carrying it to the remote
 * command's stdin) and stdin is then closed; `timeoutMs` kills the ssh
 * client's whole process tree; `maxBufferBytes` caps the captured output.
 * An unsafe host is refused before any subprocess is spawned.
 */

import { runSpawnOutcome } from './spawn-run.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';

export interface SshExecutorOptions {
  /** Safe ssh destination (`host` or `user@host`) owning the remote commands. */
  readonly host: string;
}

/** An ssh destination that could inject options or split words never spawns. */
export function isSpawnableSshHost(host: string): boolean {
  return host.length > 0 && !host.startsWith('-') && !/\s/.test(host);
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
    if (!isSpawnableSshHost(host)) {
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
    const outcome = await runSpawnOutcome('ssh', sshArgvFor(host, argv), {
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.input !== undefined ? { input: options.input } : {}),
      ...(options?.maxBufferBytes !== undefined ? { maxBufferBytes: options.maxBufferBytes } : {}),
    });
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }
}
