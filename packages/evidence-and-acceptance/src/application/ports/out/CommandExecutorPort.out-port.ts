/**
 * CommandExecutorPort is the evidence context's own outbound contract for
 * running one command as an explicit argv array (no cross-context import).
 * Infrastructure chooses the transport: local `execFile` (never a shell) or
 * batch-mode ssh to a named host.
 */

/** Options of one command run. `env` is the complete environment when given. */
export interface CommandRunOptions {
  /** Working directory for a local run; ignored by remote transports. */
  readonly cwd?: string;
  /** Data written to the command's standard input. */
  readonly input?: string;
  /** Complete subprocess environment when given; inherit otherwise. */
  readonly env?: Readonly<Record<string, string>>;
  /** Wall-clock budget; an exceeded run is terminated and reported. */
  readonly timeoutMs?: number;
}

/** Completed outcome of one command run, as far as this port needs it. */
export interface CommandRunResult {
  /** Exit code, or null when the command never reported one. */
  readonly exitCode: number | null;
  /** Terminating signal, or null when the command ended without one. */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure description; absent for a command that ran. */
  readonly error?: string;
}

/** Run one argv array and return its completed outcome, fail closed. */
export interface CommandExecutorPort {
  run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult>;
}
