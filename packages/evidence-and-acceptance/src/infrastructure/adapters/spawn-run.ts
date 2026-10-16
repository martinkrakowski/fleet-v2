/**
 * Internal spawn-based command runner shared by the evidence context's
 * executors (local and ssh transports). No shell is ever involved: the argv
 * array travels as separate words. `input` is written to the child's stdin
 * and stdin is then closed, so a command that reads stdin always receives
 * the bytes. A `timeoutMs` budget kills the whole process tree; a
 * `maxBufferBytes` cap kills the process tree instead of truncating output
 * silently.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** Default captured-output cap, matching the runner's reviewed 64 MiB. */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
}

/** Kill the whole process tree (POSIX group kill), falling back to the child. */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
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
    let buffered = 0;
    let overran = false;

    const child = spawn(file, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: { ...options.env } } : {}),
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
      killProcessTree(child);
      // The process tree was SIGKILLed; a close event still follows.
    };

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            if (killed === null) {
              killed = 'SIGTERM';
              error = `command exceeded its ${String(options.timeoutMs)}ms timeout and its process tree was killed`;
              // SIGTERM first so a well-behaved tree can flush; SIGKILL follows.
              if (child.pid !== undefined) {
                try {
                  process.kill(-child.pid, 'SIGTERM');
                } catch {
                  try {
                    child.kill('SIGTERM');
                  } catch {
                    // already exited
                  }
                }
              }
            }
            killGrace = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) {
                killProcessTree(child);
              }
            }, KILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;

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
      child.stdout.on('data', (chunk: string | Buffer) => {
        const text = String(chunk);
        if (overran) return; // Drain but discard; the outcome is already an error.
        if (considerBuffer(text)) stdout += text;
      });
    }
    if (child.stderr !== null) {
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

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const signalName = signal ?? killed;
      settle({
        exitCode: code,
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
