// @generated adapter scaffold — implemented for lane O14c2.
/**
 * AgyRunnerAdapter implements ExecutionRunnerPort for the agy runner kind
 * (D7) by driving the reviewed `bin/agy-run` script on the lane-runner host's
 * executor — the same reviewed-script-behind-a-port shape as
 * ExecutionRunnerAdapter, with the agy rules:
 *
 *  - **The prompt never reaches the command line.** `agy-run`'s fixed prompt
 *    names the brief file inside the worktree, so the argv is the same for
 *    every lane and no free text from a brief, a seat or an operator can alter
 *    what the model is asked to do.
 *  - **The argv is pinned per mode** (D7): `edit-only` runs agy in
 *    `--mode accept-edits`, and `full` runs it in `--mode full`, which the
 *    script hands to agy as `--mode auto --dangerously-skip-permissions` and
 *    only when `--isolation-declared` accompanies it. The isolation floor and
 *    the acknowledgement behind that declaration are enforced by the
 *    installation loader before this adapter is ever constructed; agy-run
 *    cannot verify them and does not pretend to.
 *  - **The lane runs to completion inside `startSession`.** `agy-run --detach`
 *    keeps the agy child alive when the dispatching ssh client dies, which is
 *    what makes the wall-clock budget below safe: an exceeded budget kills the
 *    dispatcher, not the lane, and the lane is still reachable through
 *    `agy-run --status` / `--abort`.
 *  - **The model is a value, never a flag.** The seat's model must match
 *    `^[A-Za-z0-9][A-Za-z0-9._/:#@-]{0,127}$` or the run is refused before
 *    anything is spawned: a model such as `--dangerously-skip-permissions`
 *    or `-x` would otherwise arrive on agy's command line as a flag of its
 *    own, and whitespace would split it into several.
 *  - **The environment allow-list governs the local process, never a remote
 *    command.** `buildAgyRunnerEnv` builds the environment handed to the
 *    executor that owns the lane-runner host's subprocesses — for an `ssh`
 *    executor that is the local ssh client's environment, and the remote
 *    command itself runs in the lane host's login environment, which ssh
 *    never populates from it. `SSH_AUTH_SOCK` is kept only for an `ssh`
 *    transport (the local client's agent) and is never passed into the
 *    remote command.
 *  - **There is no ambiguous middle.** A run that ended with a non-empty
 *    response is `started`; exit 1 or 4 (agy failed, or reported a model or
 *    agent error), an empty response, a refused busy worktree (75) and a
 *    timeout or signal kill (no exit code at all) are all failed runs and are
 *    reported `refused` with the exit named. `unknown` is never returned: it
 *    would retain capacity and send the attempt into reconciliation as if a
 *    killed lane might still succeed.
 *
 * Nothing here is reachable from dispatch until a composition root injects
 * this adapter (lane O14e1); the selector still refuses an agy seat until it
 * is told an agy adapter exists.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  AbortWorktreeRunRequest,
  AbortWorktreeRunResult,
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionRef,
  RunnerSessionStatus,
  StartRunnerSessionRequest,
  StartRunnerSessionResult,
  StopRunnerSessionRequest,
  StopRunnerSessionResult,
  WorktreeRunRef,
  WorktreeRunState,
} from '../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptRecord, AttemptRunnerRecord } from '../../domain/execution-records.js';

/** The runner mode a lane-runner host declares for agy (D7). */
export type AgyRunnerMode = 'edit-only' | 'full';

/** agy's own `--mode` value for each declared runner mode, as pinned by the descriptor. */
const AGY_MODE_FLAG: Readonly<Record<AgyRunnerMode, string>> = {
  'edit-only': 'accept-edits',
  full: 'full',
};

/** agy-run's busy-worktree exit: another lane already runs in `--dir`. */
const AGY_RUN_EXIT_BUSY = 75;

/** Reviewed runner output budget: a lane's JSON result must not truncate. */
const AGY_RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Fallback wall-clock budget when a request carries no time limit. */
const AGY_RUN_DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * The only host environment variables the lane's executor process may inherit
 * (D5, D7). This environment governs the LOCAL process the executor spawns —
 * for an ssh executor, the local ssh client; the remote command on the lane
 * host runs in that host's login environment, which ssh never populates from
 * this. Every other variable is dropped, in both modes: `GH_TOKEN`,
 * `GITHUB_TOKEN`, every `GIT_*`, every `OPENROUTER*` and every `*_API_KEY`.
 * `HOME` stays because agy's sign-in lives under it; `full` can read anything
 * that user can read, which is what the security text says out loud.
 * `SSH_AUTH_SOCK` is the one ssh-transport-only allowance: the local ssh
 * client's agent, kept only when the executor transport is `ssh` and never
 * passed into the remote command.
 */
export const AGY_RUNNER_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'AGY_BIN',
];

/** The executor transport the lane's environment is built for (D5). */
export interface AgyRunnerEnvOptions {
  /**
   * Transport of the executor owning the lane-runner host's subprocesses. The
   * allow-list applies to that local process — for `ssh`, the local ssh
   * client — and `SSH_AUTH_SOCK` is kept only then; an undeclared transport
   * keeps the trimmed environment.
   */
  readonly transport?: 'local' | 'ssh';
}

/** Build the sanitized agy lane environment from the allow-list plus overrides. */
export function buildAgyRunnerEnv(
  overrides?: Readonly<Record<string, string>>,
  options?: AgyRunnerEnvOptions,
): Record<string, string> {
  // SSH_AUTH_SOCK belongs to the local ssh client only; a local lane child
  // and a remote command never receive it.
  const sshTransport = options?.transport === 'ssh';
  const sanitized: Record<string, string> = {};
  for (const key of AGY_RUNNER_ENV_ALLOWLIST) {
    if (key === 'SSH_AUTH_SOCK' && !sshTransport) {
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  return overrides === undefined ? sanitized : { ...sanitized, ...overrides };
}

/** The bundled runner script at the repository's `bin/agy-run`. */
function resolveBundledAgyRunPath(): string {
  // Works from both the compiled dist tree and vitest's src tree.
  let current = path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(current).root;
  while (true) {
    const candidate = path.join(current, 'bin', 'agy-run');
    if (existsSync(candidate)) return candidate;
    if (current === root) return 'agy-run';
    current = path.dirname(current);
  }
}

const DEFAULT_AGY_RUN_PATH = resolveBundledAgyRunPath();

/**
 * The only shape a model may take on agy-run's argv: at most 128 characters,
 * starting with a letter or digit, and never a `-`, whitespace or any other
 * character that could make it read as a flag or split into several words.
 */
export const AGY_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:#@-]{0,127}$/;

/** True when `model` is safe to hand to agy-run's `--model` as one value. */
export function isValidAgyModel(model: string): boolean {
  return AGY_MODEL_PATTERN.test(model);
}

function agyModelRefusal(model: string): string {
  return `Refusing model '${model}': it must match ${AGY_MODEL_PATTERN.source} so it can never become a flag on agy's command line`;
}

/** The argv of one agy lane, exactly as pinned per mode (D7). */
export function agyRunArgv(options: {
  readonly bin: string;
  readonly worktreePath: string;
  readonly model: string;
  readonly mode: AgyRunnerMode;
}): string[] {
  // The model is one value beside --model, never a flag of its own: refuse
  // anything that could be read as one before any argv is built.
  if (!isValidAgyModel(options.model)) {
    throw new Error(agyModelRefusal(options.model));
  }
  return [
    options.bin,
    '--dir',
    options.worktreePath,
    '--model',
    options.model,
    '--mode',
    AGY_MODE_FLAG[options.mode],
    // `full` is the only mode that widens a lane's permissions, and agy-run
    // widens none at all without this declaration travelling with it.
    ...(options.mode === 'full' ? ['--isolation-declared'] : []),
    // agy-run refuses `full` without agy's sandbox: the agent runs as the same user as agy-run,
    // and only the sandbox keeps it out of agy-run's run directory (Fable review of #151).
    ...(options.mode === 'full' ? ['--sandbox'] : []),
    '--detach',
  ];
}

/** What one agy-run stdout carries: agy's JSON result, if it printed one. */
interface AgyRunResult {
  readonly conversationId: string | null;
  readonly response: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read agy's JSON result from agy-run's stdout: the whole stream when it is
 * one object, otherwise the first line that parses as an object. An empty
 * response is kept as an empty response — never treated as a clean result.
 */
export function parseAgyRunResult(stdout: string): AgyRunResult | null {
  const read = (record: Record<string, unknown>): AgyRunResult => {
    const conversationId = record['conversation_id'];
    const response = record['response'];
    return {
      conversationId:
        typeof conversationId === 'string' && conversationId.trim() !== ''
          ? conversationId.trim()
          : null,
      response: typeof response === 'string' ? response : null,
    };
  };
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isPlainRecord(parsed)) return read(parsed);
  } catch {
    // Not a single JSON object; fall through to the line scan.
  }
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsedLine: unknown = JSON.parse(line);
      if (isPlainRecord(parsedLine)) return read(parsedLine);
    } catch {
      // Not an agy result line; the scan continues.
    }
  }
  return null;
}

export interface AgyRunnerAdapterOptions {
  /** Executor owning the lane-runner host's subprocesses. Never defaulted: the transport is a root's decision. */
  readonly executor: CommandExecutorPort;
  /** The host's declared agy mode. Absent is `edit-only`, the conservative mode (D7). */
  readonly mode?: AgyRunnerMode;
  /** Path of the agy-run script; the bundled `bin/agy-run` when found, else `agy-run` from PATH. */
  readonly agyRunBin?: string;
  /**
   * Transport of the executor owning the lane-runner host's subprocesses (D5).
   * The environment allow-list governs that local process — for `ssh`, the
   * local ssh client, which is then the only place `SSH_AUTH_SOCK` is kept;
   * the remote command runs in the lane host's login environment and never
   * receives it. An undeclared transport keeps the trimmed environment.
   */
  readonly transport?: 'local' | 'ssh';
  /** Capability overrides on top of the enforced defaults. */
  readonly capabilities?: Partial<RunnerIsolationCapabilities>;
  /** Optional resolver for cross-process lookup of an attempt's worktree path when not cached in memory. */
  readonly resolveWorktreePath?: (attemptId: string) => Promise<string | null> | string | null;
  /** Optional resolver for the attempt record, used to confirm the recorded runner kind. */
  readonly resolveAttempt?: (attemptId: string) => Promise<AttemptRecord | null> | AttemptRecord | null;
}

const defaultCapabilities: RunnerIsolationCapabilities = {
  // The enforced default is today's env-only behaviour, so its profile reports
  // the loader-derived `legacy-asserted` source (D4) exactly as the opencode
  // adapter's does. A `full` host's `declared` profile is wired by the roots.
  source: 'legacy-asserted',
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

const capabilityBooleans: readonly (keyof RunnerIsolationCapabilities)[] = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'authoritativeCompletion',
  'artifactPersistence',
];

/** Nothing observed, nothing concluded: the fail-closed session status. */
function unknownStatus(): RunnerSessionStatus {
  return {
    runnerReachable: 'unknown',
    workspacePreparation: 'unprepared',
    workerCommand: 'not-started',
    completionReceipt: null,
    artifactsCollected: false,
  };
}

export class AgyRunnerAdapter implements ExecutionRunnerPort {
  /** Locator for status/abort calls: the attempt's worktree when known. */
  private readonly worktreeByAttemptId = new Map<string, string>();

  constructor(private readonly options: AgyRunnerAdapterOptions) {}

  describeCapabilities(): RunnerIsolationCapabilities {
    return { ...defaultCapabilities, ...this.options.capabilities };
  }

  /** agy runs no tunnel port; the record carries the kind and a null port (D7). */
  describeRunner(): AttemptRunnerRecord {
    return {
      kind: 'agy',
      remotePort: null,
      host: null,
      agent: null,
      model: null,
      variant: null,
    };
  }

  async startSession(request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult> {
    const capabilities = this.describeCapabilities();
    const required = request.requiredCapabilities;
    const unsatisfied =
      required.filesystemScope !== capabilities.filesystemScope ||
      capabilityBooleans.some(
        (capability) => required[capability] === true && capabilities[capability] === false,
      );
    if (unsatisfied) {
      return { outcome: 'refused', reason: 'Runner does not satisfy required isolation capabilities' };
    }

    // The seat comes from the frozen brief exactly as for the opencode seat.
    const seatOverride = request.seatOverride;
    const model = seatOverride?.model ?? request.model ?? request.modelAssignment?.model;
    if (!model || model.trim() === '') {
      return { outcome: 'refused', reason: 'No model specified for runner session' };
    }
    // The model is a value beside --model, never a flag: refuse anything that
    // could be read as one before a single process is spawned.
    if (!isValidAgyModel(model)) {
      return { outcome: 'refused', reason: agyModelRefusal(model) };
    }
    // agy's argv is pinned: no --agent and no --variant exist. A seat that
    // names one is refused rather than quietly run as a different seat.
    const agent = seatOverride?.agent ?? request.agent ?? request.modelAssignment?.agent;
    const variant = seatOverride?.variant ?? request.variant ?? request.modelAssignment?.variant;
    if (agent !== undefined && agent.trim() !== '') {
      return { outcome: 'refused', reason: `agy has no agent flag; the seat's agent '${agent}' cannot be honoured` };
    }
    if (variant !== undefined && variant.trim() !== '') {
      return { outcome: 'refused', reason: `agy has no variant flag; the seat's variant '${variant}' cannot be honoured` };
    }

    this.worktreeByAttemptId.set(request.attemptId, request.worktreePath);
    const mode = this.options.mode ?? 'edit-only';
    const argv = agyRunArgv({
      bin: this.binPath(),
      worktreePath: request.worktreePath,
      model,
      mode,
    });

    const timeoutMs =
      request.timeLimitSeconds > 0
        ? request.timeLimitSeconds * 1000
        : AGY_RUN_DEFAULT_TIMEOUT_MS;
    const result = await this.run(argv, { timeoutMs });

    // No exit code at all: the budget expired, the process tree was signalled,
    // or the script never started. `--detach` means the lane may still be
    // running in the worktree, so the start is blocked: the reservation is
    // kept and reconcile or stop resolve the worktree.
    if (result.exitCode === null) {
      return {
        outcome: 'blocked',
        runner: {
          kind: 'agy',
          remotePort: null,
          host: null,
          agent: null,
          model,
          variant: null,
        },
        reason: `agy run ended without an exit status (${
          result.error ?? result.signal ?? 'unknown cause'
        }); the lane may still be running in the worktree, so inspect it with agy-run --status before retrying`,
      };
    }
    if (result.exitCode === AGY_RUN_EXIT_BUSY) {
      return {
        outcome: 'blocked',
        runner: {
          kind: 'agy',
          remotePort: null,
          host: null,
          agent: null,
          model,
          variant: null,
        },
        reason: 'Worktree already has an active session (agy-run exit 75)',
      };
    }
    if (result.exitCode !== 0) {
      return {
        outcome: 'refused',
        reason: `agy run failed (exit ${String(result.exitCode)})${this.failureDetail(result.stderr, result.stdout)}`,
      };
    }

    const agyResult = parseAgyRunResult(result.stdout);
    if (agyResult === null || agyResult.response === null || agyResult.response.trim() === '') {
      // agy-run already reports an empty response as exit 1; re-checked here so
      // no version of the script can turn one into a clean result.
      return {
        outcome: 'refused',
        reason: `agy run produced no response${this.failureDetail(result.stderr, result.stdout)}`,
      };
    }

    return {
      outcome: 'started',
      sessionId: agyResult.conversationId ?? `agy-${request.attemptId}`,
      runner: {
        kind: 'agy',
        remotePort: null,
        host: null,
        agent: null,
        model,
        variant: null,
      },
    };
  }

  async inspectSession(session: RunnerSessionRef): Promise<RunnerSessionStatus> {
    const worktreePath = await this.agyWorktreePath(session);
    if (worktreePath === null) return unknownStatus();

    const result = await this.run([this.binPath(), '--status', '--dir', worktreePath]);
    if (result.exitCode === 3) {
      return {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }
    if (result.exitCode === 0) {
      // agy-run's `--status` reports only whether a lane runs, never how it
      // ended: the exit status that decided the run was reported by the start
      // that ran it, so this receipt carries no exit code of its own.
      return {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: {
          attemptId: session.attemptId,
          sessionId: session.sessionId,
          endedAtIso: new Date().toISOString(),
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: false,
        },
        artifactsCollected: false,
      };
    }
    return unknownStatus();
  }

  async stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
    const worktreePath = await this.agyWorktreePath(request);
    if (worktreePath === null) {
      return { outcome: 'refused', reason: 'Worktree directory not resolved for agy session abort' };
    }

    const result = await this.run([this.binPath(), '--abort', '--dir', worktreePath]);
    if (result.exitCode === 0) {
      // An abort records exitStatus null and stoppedByRequest, never the 143
      // of the signal the script had to escalate to.
      return {
        outcome: 'terminated',
        receipt: {
          attemptId: request.attemptId,
          sessionId: request.sessionId,
          endedAtIso: new Date().toISOString(),
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: true,
        },
      };
    }
    if (result.exitCode === null) {
      return {
        outcome: 'unknown',
        reason: `agy-run --abort ended without an exit status: ${
          result.error ?? result.signal ?? 'unknown cause'
        }`,
      };
    }
    return {
      outcome: 'still-running',
      reason: result.stderr || result.stdout || 'agy-run --abort did not confirm termination',
    };
  }

  /**
   * What runs in a worktree directory, without a session id: `agy-run
   * --status` on the recorded agy lane's worktree. Exit 0 means idle; exit 3
   * means running with the session id convention `startSession` already uses.
   * Anything else, including a ref that is not an agy lane, is unknown.
   */
  async inspectWorktreeRun(ref: WorktreeRunRef): Promise<WorktreeRunState> {
    const worktreePath = await this.agyWorktreePath(ref);
    if (worktreePath === null) {
      return { state: 'unknown', reason: 'Not an agy lane worktree' };
    }
    let result: {
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly error?: string;
    };
    try {
      result = await this.run([this.binPath(), '--status', '--dir', worktreePath]);
    } catch (error) {
      return { state: 'unknown', reason: `Status command failed: ${String(error)}` };
    }
    if (result.exitCode === 0) {
      return { state: 'idle' };
    }
    if (result.exitCode === 3) {
      return { state: 'running', sessionId: `agy-${ref.attemptId}` };
    }
    return {
      state: 'unknown',
      reason: `status command exited ${result.exitCode}: ${result.stderr || result.stdout || 'no output'}`,
    };
  }

  /**
   * Abort whatever runs in a worktree directory, by directory: `agy-run
   * --abort` on the recorded agy lane's worktree, mapped like stopSession.
   * Exit 0 confirms the abort; non-zero exits stay `still-running`, a ref
   * that is not an agy lane is `refused`, and a thrown subprocess is
   * `unknown`.
   */
  async abortWorktreeRun(request: AbortWorktreeRunRequest): Promise<AbortWorktreeRunResult> {
    const worktreePath = await this.agyWorktreePath(request);
    if (worktreePath === null) {
      return { outcome: 'refused', reason: 'Worktree directory not resolved for agy worktree abort' };
    }
    let result: {
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly error?: string;
    };
    try {
      result = await this.run([this.binPath(), '--abort', '--dir', worktreePath]);
    } catch (error) {
      return { outcome: 'unknown', reason: `Abort command failed: ${String(error)}` };
    }
    if (result.exitCode === 0) {
      return { outcome: 'aborted', endedAtIso: new Date().toISOString() };
    }
    if (result.exitCode === null) {
      return {
        outcome: 'unknown',
        reason: `agy-run --abort ended without an exit status: ${
          result.error ?? result.signal ?? 'unknown cause'
        }`,
      };
    }
    return {
      outcome: 'still-running',
      reason: result.stderr || result.stdout || 'agy-run --abort did not confirm termination',
    };
  }

  /**
   * The worktree of a recorded agy lane, or null when the lane cannot be
   * identified as one. Inspect and stop key on the recorded kind and the
   * worktree: an opencode record, or a missing one, never reaches agy-run.
   */
  private async agyWorktreePath(
    session: Pick<RunnerSessionRef, 'attemptId' | 'worktreePath' | 'runner'>,
  ): Promise<string | null> {
    const recordedRunner =
      session.runner ?? (await this.options.resolveAttempt?.(session.attemptId))?.runner ?? null;
    if (recordedRunner?.kind !== 'agy') return null;

    const resolved =
      session.worktreePath ??
      this.worktreeByAttemptId.get(session.attemptId) ??
      (await this.options.resolveWorktreePath?.(session.attemptId)) ??
      (await this.options.resolveAttempt?.(session.attemptId))?.worktreePath ??
      null;
    return resolved !== null && resolved.trim() !== '' ? resolved : null;
  }

  /** The reviewed script's path: the option, then `FLEET_AGY_RUN_BIN`, then the bundled one. */
  private binPath(): string {
    return this.options.agyRunBin ?? (process.env.FLEET_AGY_RUN_BIN?.trim() || DEFAULT_AGY_RUN_PATH);
  }

  /** The lane's own failure text, trimmed to one line; never a whole log. */
  private failureDetail(stderr: string, stdout: string): string {
    const text = (stderr.trim() || stdout.trim()).split(/\r?\n/).pop() ?? '';
    return text === '' ? '' : `: ${text}`;
  }

  /**
   * Run one agy-run argv on the lane-runner host's executor with the agy
   * environment allow-list, which governs the local process the executor
   * spawns (the local ssh client when the transport is ssh) — never a remote
   * command, whose environment is the lane host's login environment. A
   * refused command is a result like any other; only an unreadable executor
   * throws, and the caller maps that to a failed run.
   */
  private async run(
    argv: readonly string[],
    options?: { readonly timeoutMs?: number },
  ): Promise<{ readonly exitCode: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string; readonly error?: string }> {
    return this.options.executor.run(argv, {
      env: buildAgyRunnerEnv(undefined, { transport: this.options.transport }),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      maxBufferBytes: AGY_RUN_MAX_BUFFER_BYTES,
    });
  }
}