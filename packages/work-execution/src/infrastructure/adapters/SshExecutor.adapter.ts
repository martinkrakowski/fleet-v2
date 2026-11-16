// @generated adapter scaffold — implemented for migration station O3 (batch-mode ssh executor).
/**
 * SshExecutor implements CommandExecutorPort by carrying one argv array to a
 * remote POSIX shell through batch-mode ssh:
 *
 *   ssh -o BatchMode=yes -o ConnectTimeout=15 <host> -- sh -c <posixQuote(argv.map(posixQuote).join(' '))>
 *
 * The remote command always runs through an explicit POSIX `sh -c` carrying
 * one single-quoted string, so the remote account's login shell (which may
 * be zsh or another POSIX-shell descendant) parses only that fixed
 * invocation, never the command text itself. This is hardening on top of the
 * per-word POSIX quoting that already applies: every remote word is
 * POSIX-single-quoted, so no argument is ever split or interpreted by the
 * remote shell. Because the login shell still starts first and `sh`
 * inherits its exported environment, PATH is unchanged — but a remote
 * program must be a PATH executable: a function defined in a login-shell
 * profile or a shell-specific builtin is not visible to `sh`.
 *
 * Arguments containing NUL bytes (U+0000) are refused before any subprocess
 * is spawned. `input` is written to the ssh client's stdin (carrying it to
 * the remote command's stdin) and stdin is then closed; `timeoutMs` kills
 * the ssh client's whole process tree (default 60 s when omitted); an
 * omitted `env` gives the ssh client only the allow-listed host variables
 * including SSH_AUTH_SOCK, never the full host environment;
 * `maxBufferBytes` caps the captured output. An unsafe host is refused
 * before any subprocess is spawned.
 */

import { isSafeSshHost } from './WorkspaceAdapter.adapter.js';
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

/**
 * Single-quote one argument for the remote POSIX shell.
 *
 * The same helper exists in the `packages/evidence-and-acceptance`
 * `SshExecutor` copy; de-duplicating the two copies is a separate later unit.
 */
export function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** The ssh argv that carries `argv` to `host` in batch mode through `sh -c`. */
export function sshArgvFor(host: string, argv: readonly string[]): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    host,
    '--',
    'sh',
    '-c',
    posixQuote(argv.map(posixQuote).join(' ')),
  ];
}

/** A refusal result: nothing was spawned, so there is no exit code, signal or output. */
function refusal(error: string): CommandRunResult {
  return { exitCode: null, signal: null, stdout: '', stderr: '', error };
}

/** The spawn options carried over from the caller's options, omitting unset ones. */
function spawnOptionsFor(options: CommandRunOptions | undefined): Parameters<typeof runSpawnOutcome>[2] {
  const picked: Record<string, unknown> = {};
  for (const key of ['env', 'timeoutMs', 'input', 'maxBufferBytes', 'killProcessTree'] as const) {
    if (options?.[key] !== undefined) picked[key] = options[key];
  }
  return picked as Parameters<typeof runSpawnOutcome>[2];
}

export class SshExecutor implements CommandExecutorPort {
  constructor(private readonly options: SshExecutorOptions) {}

  /** The ssh destination this executor carries commands to. */
  get sshHost(): string {
    return this.options.host;
  }

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    const host = this.options.host;
    if (!isSafeSshHost(host)) {
      // Refused before any spawn: an unsafe destination never reaches ssh.
      return refusal(`Refusing to execute on unsafe SSH host: ${host}`);
    }
    if (argv.length === 0) {
      return refusal('SshExecutor refuses to run an empty argv');
    }
    if (argv.some((arg) => arg.includes('\0'))) {
      // Refused before any spawn, and the argument is never echoed back: a
      // NUL byte cannot travel through a spawned argv.
      return refusal('SshExecutor refuses an argument containing a NUL byte');
    }
    const outcome = await runSpawnOutcome('ssh', sshArgvFor(host, argv), spawnOptionsFor(options));
    const { error, ...rest } = outcome;
    return {
      exitCode: rest.exitCode,
      signal: rest.signal,
      stdout: rest.stdout,
      stderr: rest.stderr,
      ...(error !== undefined ? { error } : {}),
    };
  }
}
