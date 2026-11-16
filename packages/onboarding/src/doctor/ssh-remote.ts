/**
 * The ssh transport form for the doctor probes: one batch-mode `ssh` argv
 * whose remote side is exactly `sh -c` plus one POSIX-single-quoted command
 * line, so the remote login shell — whatever it is — parses only those
 * words and never splits or interprets a probe argument.
 *
 * Every remote program must be a PATH executable, never a login-shell
 * function or a builtin specific to the login shell: the login shell starts
 * first and the `sh` it spawns inherits only the exported environment, so
 * nothing defined inside the login shell is reachable here. fish and csh
 * are not supported, before or after this quoting.
 *
 * This is a small local copy of the quoting twins — `posixQuote` in
 * `packages/work-execution/src/infrastructure/adapters/SshExecutor.adapter.ts`
 * and `shellQuote` in `packages/onboarding/src/init/plan.ts`. De-duplicating
 * them is a separate later unit; this file stays local so the doctor keeps
 * importing no context package beyond `@fleet/installation`.
 */

import { isSafeSshHost } from '@fleet/installation';

/** Single-quote one word for a POSIX shell. */
export function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Accepted result of `sshRemoteArgv`: the argv to run through the executor. */
export interface SshRemoteArgvOk {
  readonly ok: true;
  readonly argv: readonly string[];
}

/** Refused result of `sshRemoteArgv`; the reason never echoes a value. */
export interface SshRemoteArgvRefused {
  readonly ok: false;
  readonly reason: string;
}

/** Either the ssh argv to spawn or a refusal that spawns nothing. */
export type SshRemoteArgv = SshRemoteArgvOk | SshRemoteArgvRefused;

/**
 * The batch-mode ssh argv that carries `argv` to `alias`: the ssh option
 * words, the alias, `--`, then `sh -c` with one final word — the whole
 * remote command line POSIX-single-quoted after each of its words is
 * quoted, so the remote login shell parses only `sh -c` plus that string.
 *
 * Refused, spawning nothing, when `argv` is empty or any argument is an
 * empty string or contains a NUL byte, or when `alias` is empty or not a
 * safe ssh destination (which covers a leading dash). The refusal reason
 * names the rule, never the refused value.
 */
export function sshRemoteArgv(
  alias: string,
  argv: readonly string[],
  connectTimeoutSeconds: number,
): SshRemoteArgv {
  if (alias === '' || !isSafeSshHost(alias)) {
    return { ok: false, reason: 'the ssh host alias is empty or unsafe' };
  }
  if (argv.length === 0) {
    return { ok: false, reason: 'the remote command argv is empty' };
  }
  for (const argument of argv) {
    if (argument === '') {
      return { ok: false, reason: 'the remote command has an empty argument' };
    }
    if (argument.includes('\0')) {
      return { ok: false, reason: 'the remote command has an argument with a NUL byte' };
    }
  }
  return {
    ok: true,
    argv: [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      `ConnectTimeout=${connectTimeoutSeconds}`,
      alias,
      '--',
      'sh',
      '-c',
      posixQuote(argv.map(posixQuote).join(' ')),
    ],
  };
}
