/**
 * Internal spawn-based command runner shared by the work-execution context's
 * executors (local and ssh transports). No shell is ever involved: the argv
 * array travels as separate words. `input` is written to the child's stdin
 * and stdin is then closed, so a command that reads stdin always receives
 * the bytes. A `timeoutMs` budget kills the whole process tree; when the
 * caller gives none, the default budget (60 s) applies. A `maxBufferBytes`
 * cap kills the process tree instead of truncating output silently.
 *
 * When the caller passes no `env`, the child inherits only the allow-listed
 * host variables (PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TMPDIR, plus
 * SSH_AUTH_SOCK for the ssh transport) — never the full `process.env`, so a
 * credential planted in the host environment (GH_TOKEN, AWS_*, a proxy
 * password) cannot leak into a child.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** Default captured-output cap, matching the runner's reviewed 64 MiB. */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Default wall-clock budget for one run when the caller gives no timeout. */
export const DEFAULT_RUN_TIMEOUT_MS = 60 * 1000;

/**
 * Host variables a child may inherit when the caller passes no `env`, plus
 * the ssh-only addition. Everything else — credentials, tokens, host
 * configuration — is stripped, fail closed.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
];

const SSH_CHILD_ENV_ALLOWLIST: readonly string[] = [...CHILD_ENV_ALLOWLIST, 'SSH_AUTH_SOCK'];

/**
 * Build the allow-listed child environment from the host environment. The
 * ssh transport keeps `SSH_AUTH_SOCK` (the host's agent); a local child
 * never sees it.
 */
export function allowListedChildEnv(transport: 'local' | 'ssh'): Record<string, string> {
  const allowlist = transport === 'ssh' ? SSH_CHILD_ENV_ALLOWLIST : CHILD_ENV_ALLOWLIST;
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Grace between the timeout's SIGTERM to the process tree and the SIGKILL. */
const KILL_GRACE_MS = 500;

export interface SpawnRunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure, a timeout, or a max-buffer overrun; absent on a clean run. */
  readonly error?: string;
}

export interface SpawnRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly input?: string;
  readonly maxBufferBytes?: number;
  /**
   * Whether the timeout and overrun terminations may signal the child's whole
   * process group (default true). `false` signals only the direct child, so a
   * detached grandchild survives the run's own timeout.
   */
  readonly killProcessTree?: boolean;
}

/** Kill the whole process tree (POSIX group kill), falling back to the child. */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL', tree = true): void {
  if (!tree) {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
    return;
  }
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

/**
 * Spawn `file` with `args` (no shell), forward `input` on stdin, enforce the
 * wall-clock timeout and the captured-output cap, and resolve with the
 * completed outcome including spawn failures and terminations.
 */
export function runSpawnOutcome(
  file: string,
  args: readonly string[],
  options: SpawnRunOptions = {},
): Promise<SpawnRunOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let killed: string | null = null;
    let error: string | undefined;
    let killGrace: ReturnType<typeof setTimeout> | undefined;

    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const killTree = options.killProcessTree !== false;
    let buffered = 0;
    let overran = false;

    const child = spawn(file, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      // An explicit `env` is the complete child environment. Without one the
      // child gets the allow-listed host variables, never `process.env`.
      env:
        options.env !== undefined
          ? { ...options.env }
          : allowListedChildEnv(file === 'ssh' ? 'ssh' : 'local'),
      // A detached child becomes its own POSIX process-group leader, so the
      // timeout can kill the tree and not only the direct child.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const settle = (outcome: SpawnRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killGrace);
      resolve(outcome);
    };

    const terminate = (signal: string, reason: string): void => {
      if (settled || killed !== null) return;
      killed = signal;
      error = reason;
      killProcessTree(child, 'SIGKILL', killTree);
      // The process tree was SIGKILLed; a close event still follows.
    };

    const timer = setTimeout(() => {
      if (killed === null) {
        killed = 'SIGTERM';
        error = killTree
          ? `command exceeded its ${String(timeoutMs)}ms timeout and its process tree was killed`
          : `command exceeded its ${String(timeoutMs)}ms timeout and was killed`;
        // SIGTERM first so a well-behaved tree can flush; SIGKILL follows.
        if (killTree && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            try {
              child.kill('SIGTERM');
            } catch {
              // already exited
            }
          }
        } else {
          try {
            child.kill('SIGTERM');
          } catch {
            // already exited
          }
        }
      }
      killGrace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killProcessTree(child, 'SIGKILL', killTree);
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const considerBuffer = (chunk: string): boolean => {
      buffered += Buffer.byteLength(chunk, 'utf8');
      if (buffered > maxBufferBytes && !overran) {
        overran = true;
        terminate(
          'SIGKILL',
          `output exceeded maxBufferBytes (${String(maxBufferBytes)}); the process tree was killed`,
        );
        return false;
      }
      return true;
    };

    if (child.stdout !== null) {
      if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string | Buffer) => {
        const text = String(chunk);
        if (overran) return; // Drain but discard; the outcome is already an error.
        if (considerBuffer(text)) stdout += text;
      });
    }
    if (child.stderr !== null) {
      if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string | Buffer) => {
        const text = String(chunk);
        if (overran) return;
        if (considerBuffer(text)) stderr += text;
      });
    }

    child.on('error', (failure: NodeJS.ErrnoException) => {
      // Spawn failure (for example ENOENT): reported, never guessed.
      error = failure.message ?? String(failure);
      settle({ exitCode: null, signal: null, stdout, stderr, error });
    });

    // Without a tree kill, a surviving grandchild may hold the inherited
    // stdio pipes open, so 'close' could never come. Once the killed child
    // has exited, drain briefly, then close the pipes and settle anyway.
    child.on('exit', (_code: number | null, signal: NodeJS.Signals | null) => {
      if (killTree || killed === null) return;
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        const signalName = signal ?? killed;
        settle({
          exitCode: null,
          signal: typeof signalName === 'string' ? signalName : null,
          stdout,
          stderr,
          ...(error !== undefined ? { error } : {}),
        });
      }, KILL_GRACE_MS).unref();
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const signalName = signal ?? killed;
      // A timed-out or overran run was killed, so the child's exit code (0
      // from a trap, 1 from a late failure) is not an answer: report null.
      const forcedNull = killed !== null || overran;
      settle({
        exitCode: forcedNull ? null : code,
        signal: typeof signalName === 'string' ? signalName : null,
        stdout,
        stderr,
        ...(error !== undefined ? { error } : {}),
      });
    });

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {
        // The child may exit before consuming all stdin (EPIPE); the close
        // event reports the completed outcome either way.
      });
      child.stdin.write(options.input, 'utf8');
      child.stdin.end();
    } else if (child.stdin !== null) {
      child.stdin.end();
    }
  });
}
