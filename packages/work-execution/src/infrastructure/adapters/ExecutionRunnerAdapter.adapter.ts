// @generated adapter scaffold — implemented for migration step 2 (reviewed ocm-run subprocess wrapper).
/**
 * ExecutionRunnerAdapter implements ExecutionRunnerPort by wrapping the
 * reviewed `ocm-run` subprocess. A subprocess runner can be injected for
 * deterministic unit tests. Ambiguous outcomes are reported as `unknown`
 * (never retried blindly, never releasing capacity); only a confirmed
 * termination or runner-reported end produces a completion receipt.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isValidHostName } from '@fleet/shared';

import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionRef,
  RunnerSessionStatus,
  StartRunnerSessionRequest,
  StartRunnerSessionResult,
  StopRunnerSessionRequest,
  StopRunnerSessionResult,
} from '../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  AttemptRecord,
  AttemptRunnerRecord,
  CommandCompletionReceipt,
} from '../../domain/execution-records.js';

const execFileAsync = promisify(execFile);

/** Reviewed runner output budget: NDJSON runs must not truncate. */
const RUNNER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Budget for non-start runner subprocesses (status/wait/abort): unchanged
 * today's behaviour — the execFile path has no timeout and the executor path
 * keeps the historical 120 s cap.
 */
const RUNNER_SUBPROCESS_TIMEOUT_MS = 120_000;

/**
 * Grace added to the start budget before the start subprocess is killed.
 * Derived from the runner's own phases: preflight probe (5 s) + busy check
 * (8 s + 8 s per active session) + create (8 s) + late overrun detection
 * (one poll, 8 s) + cleanup (5 s client kill + 8 s abort) ≈ 42 s plus 8 s
 * per already-active session. 60 s covers two active sessions; beyond that
 * the start is reported `unknown` and the status lookup decides.
 */
const RUNNER_START_TIMEOUT_GRACE_MS = 60_000;

/** Bound on the --status lookup that follows an ambiguous start. */
const RUNNER_STATUS_LOOKUP_TIMEOUT_MS = 30_000;

/** Bundled runner script at the repository's `bin/ocm-run`. */
function resolveBundledOcmRunPath(): string {
  // Works from both the compiled dist tree and vitest's src tree.
  let current = path.dirname(fileURLToPath(import.meta.url));
  const root = path.parse(current).root;
  while (true) {
    const candidate = path.join(current, 'bin', 'ocm-run');
    if (existsSync(candidate)) return candidate;
    if (current === root) return 'ocm-run';
    current = path.dirname(current);
  }
}

const DEFAULT_OCM_RUN_PATH = resolveBundledOcmRunPath();

export interface SubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SubprocessRunner = (
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<SubprocessResult>;

/**
 * A runner subprocess ended without an exit code (killed on its timeout, for
 * example). It carries whatever output the subprocess had produced, so an
 * ambiguous start can still be judged by the output the start itself named.
 */
export class RunnerSubprocessError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.name = 'RunnerSubprocessError';
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * The installation's selected lane-runner host, as the adapter receives it
 * from the composition root. With this option the adapter runs in v2 mode: the
 * host is the only source of the runner's routing, and no environment variable
 * can move the lane elsewhere.
 */
export interface ExecutionRunnerHost {
  /** The installation host name recorded on the attempt. */
  readonly hostName: string;
  readonly transport: 'local' | 'ssh';
  /** The ssh alias to dial. Required for `ssh`; ignored for `local`. */
  readonly sshAlias?: string;
  /** The server port on that host. Absent means dispatch refuses. */
  readonly remotePort?: number | null;
  /** The orchestrator-side auth file `ocm-run` sources as shell. */
  readonly authFile?: string;
}

export interface ExecutionRunnerAdapterOptions {
  /**
   * The installation's selected lane-runner host (v2 mode). Its presence is
   * the switch: with it the adapter sets `OCM_HOST`, `OCM_REMOTE_PORT` and
   * `OPENCODE_AUTH_FILE` itself and reads nothing from `process.env`; without
   * it the adapter runs in legacy mode (a v1 or absent installation) and keeps
   * today's environment-based behaviour.
   */
  readonly host?: ExecutionRunnerHost;
  /** Path of the ocm-run binary; the bundled `bin/ocm-run` when found, else `ocm-run` from PATH when omitted. */
  readonly ocmRunBin?: string;
  /** Legacy mode only: port passed as OCM_REMOTE_PORT to the runner subprocess. */
  readonly remotePort?: number;
  /** Legacy mode only: SSH host passed as OCM_HOST to the runner subprocess when configured. */
  readonly remoteHost?: string;
  /**
   * Whole seconds the start subprocess waits for the session to become visible
   * (`OCM_START_MAX`); default 60. Non-integers and values ≤ 0 fall back to 60.
   */
  readonly startBudgetSeconds?: number;
  /** Optional resolver for cross-process lookup of an attempt's worktree path when not cached in memory. */
  readonly resolveWorktreePath?: (attemptId: string) => Promise<string | null> | string | null;
  /** Optional resolver for attempt record (used to verify recorded runner port/host). */
  readonly resolveAttempt?: (attemptId: string) => Promise<AttemptRecord | null> | AttemptRecord | null;
  /** Deterministic subprocess execution for unit tests. */
  readonly runSubprocess?: SubprocessRunner;
  /**
   * Executor owning the orchestrator host's subprocesses (the ocm-run
   * wrapper). Used when no `runSubprocess` seam is injected; the executor's
   * `env` option carries the sanitized runner environment.
   */
  readonly executor?: CommandExecutorPort;
  /** Capability overrides on top of the enforced defaults. */
  readonly capabilities?: Partial<RunnerIsolationCapabilities>;
  /**
   * Legacy mode only: transport of the host holding the lane-runner role (D5).
   * In v2 mode the selected host's own transport decides. A `local` host's
   * runner environment drops `SSH_AUTH_SOCK`; an `ssh` host and an unset
   * transport keep the full allow-list.
   */
  readonly runnerTransport?: 'local' | 'ssh';
}

const defaultCapabilities: RunnerIsolationCapabilities = {
  // The enforced default is today's v1 / env-only behaviour, so its profile
  // reports the loader-derived `legacy-asserted` source (D4).
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

/**
 * The only host environment variables a runner subprocess may inherit. Every
 * other variable (credentials, tokens, host configuration) is stripped so the
 * reviewed runner never observes secrets it does not need.
 *
 * `OCM_HOST` and `OCM_REMOTE_PORT` are deliberately absent: they route the
 * lane, so the adapter always sets them explicitly from the selected host
 * (v2) or from its resolved legacy configuration, and an inherited value can
 * never be mistaken for a route. Narrowing the inherited set is deliberate.
 */
export const RUNNER_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'YARN_NM_MODE',
  'SYSTEMROOT',
];

export interface RunnerEnvOptions {
  /**
   * Transport of the host holding the lane-runner role (D5). A `local` host's
   * runner environment drops `SSH_AUTH_SOCK`; the trimmed environment applies
   * only to the lane process, never to the orchestrator's own git and gh calls.
   */
  readonly transport?: 'local' | 'ssh';
}

/** Build the sanitized subprocess environment from the allow-list plus overrides. */
export function buildRunnerEnv(
  overrides?: Readonly<Record<string, string>>,
  options?: RunnerEnvOptions,
): NodeJS.ProcessEnv {
  const localTransport = options?.transport === 'local';
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_ENV_ALLOWLIST) {
    // A single-machine lane (D5) never inherits the operator's ssh agent.
    if (localTransport && key === 'SSH_AUTH_SOCK') {
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  return overrides === undefined ? sanitized : { ...sanitized, ...overrides };
}

/** Default subprocess runner: exit codes become values, spawn failures throw. */
async function runViaExecFile(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
  envOptions?: RunnerEnvOptions,
  options?: { readonly timeoutMs?: number },
): Promise<SubprocessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      env: buildRunnerEnv(env, envOptions),
      // A live `ocm-run --format json` run streams NDJSON on stdout; the
      // default 1 MiB node buffer truncates it and reports a runner failure.
      maxBuffer: RUNNER_MAX_BUFFER_BYTES,
      // The start subprocess runs under the start budget plus grace; a
      // killed start is handled as unknown (status lookup), never a refusal.
      // Other calls keep today's no-timeout behaviour.
      ...(options?.timeoutMs !== undefined
        ? { timeout: options.timeoutMs, killSignal: 'SIGTERM' as const }
        : {}),
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof failed.code === 'number') {
      return {
        exitCode: failed.code,
        stdout: String(failed.stdout ?? ''),
        stderr: String(failed.stderr ?? ''),
      };
    }
    throw error;
  }
}

/** A JSON object usable as a session-id carrier. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the first non-empty session id from one parsed record: the runner
 * reports it on the event itself or, for streamed events, on `part`.
 */
function sessionIdFromRecord(record: Record<string, unknown>): string | null {
  for (const key of ['sessionID', 'sessionId']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const part = record['part'];
  if (isPlainRecord(part)) {
    for (const key of ['sessionID', 'sessionId']) {
      const value = part[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

/**
 * Extract a session id from JSON output, from any line of a multi-line
 * NDJSON stream, or from the first `ses_...` token.
 */
function parseSessionId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed !== '') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainRecord(parsed)) {
        const sessionId = sessionIdFromRecord(parsed);
        if (sessionId !== null) return sessionId;
      }
    } catch {
      // Not JSON output; fall through to the NDJSON line scan.
    }
    // A live run streams one JSON event per line; the first event carrying a
    // session id identifies the session regardless of event ordering.
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      try {
        const parsedLine: unknown = JSON.parse(line);
        if (isPlainRecord(parsedLine)) {
          const sessionId = sessionIdFromRecord(parsedLine);
          if (sessionId !== null) return sessionId;
        }
      } catch {
        // Not a JSON event line; the token scan below still applies.
      }
    }
  }
  for (const rawToken of stdout.split(/\s+/)) {
    const token = rawToken.replace(/^["'`[{(]+/, '').replace(/["'`\]},.)]+$/, '');
    if (token.startsWith('ses_')) return token;
  }
  const match = /\b(ses_[A-Za-z0-9_-]+)\b/.exec(stdout);
  return match?.[1] ?? null;
}

const STATUS_HEADER_PATTERN = /^ocm-run: running in .*:$/;
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

/**
 * Session ids the runner's `--status` output actually lists: only lines
 * after the `ocm-run: running in <dir>:` header count, and each must be a
 * bare session id. A `ses_…` inside the directory path never counts.
 */
function statusSessionIds(stdout: string): string[] {
  const lines = stdout.split('\n');
  const headerIndex = lines.findIndex((line) => STATUS_HEADER_PATTERN.test(line));
  if (headerIndex === -1) return [];
  const ids = new Set<string>();
  for (const rawLine of lines.slice(headerIndex + 1)) {
    const line = rawLine.trim();
    if (SESSION_ID_PATTERN.test(line)) ids.add(line);
  }
  return [...ids];
}

/** A runner output line that reports the runner aborted a session. */
function isAbortLine(line: string): boolean {
  return /aborted the session/.test(line) || /aborting it/.test(line);
}

/**
 * Session ids the start subprocess itself named, split by whether the start
 * reported aborting them. An id is "named" only where the runner reports one:
 * after the word `session` ("session started: <id>", "aborted the session
 * <id>", "session <id> did not appear") or in a JSON `"sessionID"`/`"id"`
 * field; a `ses_…` inside a directory path never counts. Ids on the runner's
 * abort lines are additionally "aborted".
 */
function startOutputIds(stdout: string, stderr: string): { named: Set<string>; aborted: Set<string> } {
  const named = new Set<string>();
  const aborted = new Set<string>();
  for (const line of [...stdout.split('\n'), ...stderr.split('\n')]) {
    const ids = [
      ...line.matchAll(/\bsession(?: started:)? (ses_[A-Za-z0-9_-]+)\b/g),
      ...line.matchAll(/"(?:sessionID|id)"\s*:\s*"(ses_[A-Za-z0-9_-]+)"/g),
    ].map((match) => match[1]);
    for (const id of ids) {
      named.add(id);
      if (isAbortLine(line)) aborted.add(id);
    }
  }
  return { named, aborted };
}

/** An ssh destination that could inject options or split words never spawns. */
function isSafeSshHost(host: string): boolean {
  return host.length > 0 && !host.startsWith('-') && !/\s/.test(host);
}

export class ExecutionRunnerAdapter implements ExecutionRunnerPort {
  /** Locator for status/abort calls: the attempt's worktree when known. */
  private readonly worktreeByAttemptId = new Map<string, string>();

  constructor(private readonly options?: ExecutionRunnerAdapterOptions) {}

  /**
   * The installation host this adapter addresses, or `undefined` in legacy
   * mode. Its presence is the switch between "the installation decides" and
   * today's environment-based mapping.
   */
  private host(): ExecutionRunnerHost | undefined {
    return this.options?.host;
  }

  describeCapabilities(): RunnerIsolationCapabilities {
    return { ...defaultCapabilities, ...this.options?.capabilities };
  }

  configuredRemotePort(): number | undefined {
    const host = this.host();
    if (host !== undefined) {
      // v2: the installation host's port, and nothing else, ever.
      return typeof host.remotePort === 'number' && Number.isFinite(host.remotePort)
        ? host.remotePort
        : undefined;
    }
    if (this.options?.remotePort !== undefined) return this.options.remotePort;
    const envPort = process.env.OCM_REMOTE_PORT;
    if (envPort !== undefined && envPort.trim() !== '') {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  configuredRemoteHost(): string | null {
    const host = this.host();
    if (host !== undefined) {
      // v2: an `ssh` host is reached by its alias; a `local` host has none.
      if (host.transport !== 'ssh') return null;
      const alias = host.sshAlias?.trim() ?? '';
      return alias === '' ? null : alias;
    }
    return this.options?.remoteHost ?? (process.env.OCM_HOST?.trim() || null);
  }

  /**
   * The installation host name recorded on the attempt; `null` in legacy mode.
   * The name is the loader-validated host-map key, so it is validated again
   * here against the loader's own rule: a name that fails it is refused, never
   * recorded, and the dispatch refuses rather than guessing a route.
   */
  configuredHostName(): string | null {
    const host = this.host();
    if (host === undefined) return null;
    const name = host.hostName.trim();
    if (name === '' || !isValidHostName(name)) return null;
    return name;
  }

  describeRunner(): AttemptRunnerRecord | undefined {
    const port = this.configuredRemotePort();
    if (port === undefined) return undefined;
    return {
      kind: 'opencode',
      remotePort: port,
      host: this.configuredRemoteHost(),
      hostName: this.configuredHostName(),
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

    const host = this.host();
    if (host !== undefined) {
      // A v2 installation addresses exactly one host, so an incomplete host is
      // refused rather than guessed at: without a port `ocm-run` cannot dial,
      // without an alias an `ssh` host would be dialled on the
      // orchestrator's own loopback, and a host name that fails the loader's
      // own host-name rule never reaches a subprocess. All three are silent
      // redirects, not defaults.
      const hostName = this.configuredHostName();
      if (hostName === null) {
        return {
          outcome: 'refused',
          reason: `Runner host name '${host.hostName}' is missing or not a valid installation host name; a dispatch cannot be addressed`,
        };
      }
      const port = this.configuredRemotePort();
      if (port === undefined) {
        return {
          outcome: 'refused',
          reason: `Runner host '${hostName}' declares no port; a dispatch cannot be addressed`,
        };
      }
      if (host.transport === 'ssh' && this.configuredRemoteHost() === null) {
        return {
          outcome: 'refused',
          reason: `Runner host '${hostName}' is ssh but declares no ssh alias; a dispatch cannot be addressed`,
        };
      }
    }

    const remoteHost = this.configuredRemoteHost();
    if (remoteHost !== null && !isSafeSshHost(remoteHost)) {
      return { outcome: 'refused', reason: `Unsafe OCM_HOST configured: ${remoteHost}` };
    }

    // Determine seat: takes model, agent, variant ONLY from the request built by the use case.
    const seatOverride = request.seatOverride;
    const model = seatOverride?.model ?? request.model ?? request.modelAssignment?.model;
    const agent = seatOverride?.agent ?? request.agent ?? request.modelAssignment?.agent;
    const variant = seatOverride?.variant ?? request.variant ?? request.modelAssignment?.variant;

    // Refuse to start (outcome refused, no spawn) when no model is known
    if (!model || model.trim() === '') {
      return { outcome: 'refused', reason: 'No model specified for runner session' };
    }

    this.worktreeByAttemptId.set(request.attemptId, request.worktreePath);

    const args: string[] = ['--detach', '--dir', request.worktreePath];
    if (agent !== undefined && agent.trim() !== '') args.push('--agent', agent);
    // -m is ALWAYS passed
    args.push('-m', model);
    if (variant !== undefined && variant.trim() !== '') args.push('--variant', variant);
    args.push('--format', 'json', `Read and execute ${request.briefPackagePath}`);

    const env = this.remotePortEnv();
    const startBudgetSeconds = this.resolveStartBudgetSeconds();
    const startEnv = { ...(env ?? {}), OCM_START_MAX: String(startBudgetSeconds) };

    let result: SubprocessResult;
    try {
      result = await this.run(this.binPath(), args, startEnv, {
        timeoutMs: startBudgetSeconds * 1000 + RUNNER_START_TIMEOUT_GRACE_MS,
        startCall: true,
      });
    } catch (error) {
      // A killed start still owns its output: whatever the subprocess had
      // printed (an abort notice, a named session) travels into the lookup.
      const carried =
        error instanceof RunnerSubprocessError
          ? { stdout: error.stdout, stderr: error.stderr, message: error.message }
          : { stdout: '', stderr: '', message: String(error) };
      return this.startUnknownAfterLookup(
        request.worktreePath,
        env,
        `Runner start failed: ${carried.message}`,
        agent,
        model,
        variant,
        carried.stdout,
        carried.stderr,
      );
    }

    if (result.exitCode === 75) {
      return { outcome: 'refused', reason: 'Worktree already has an active session (exit 75)' };
    }

    if (result.exitCode === 2) {
      // A usage error created nothing, so refusing is safe.
      return {
        outcome: 'refused',
        reason: `Runner refused the start (exit 2, usage error): ${result.stderr || result.stdout || 'no output'}`,
      };
    }

    if (result.exitCode === 0) {
      const sessionId = parseSessionId(result.stdout);
      if (sessionId !== null) {
        return this.startedSessionResult(sessionId, agent, model, variant);
      }
    }

    const startDetail =
      result.exitCode === 0
        ? result.stderr || result.stdout || 'Runner exited 0 without returning a sessionId'
        : result.stderr || result.stdout || `Runner start outcome ambiguous (exit ${result.exitCode})`;
    return this.startUnknownAfterLookup(
      request.worktreePath,
      env,
      startDetail,
      agent,
      model,
      variant,
      result.stdout,
      result.stderr,
    );
  }

  private startedSessionResult(
    sessionId: string,
    agent: string | null | undefined,
    model: string,
    variant: string | null | undefined,
  ): StartRunnerSessionResult {
    const port = this.configuredRemotePort();
    return {
      outcome: 'started',
      sessionId,
      runner:
        port !== undefined
          ? {
              kind: 'opencode',
              remotePort: port,
              host: this.configuredRemoteHost(),
              hostName: this.configuredHostName(),
              agent: agent ?? null,
              model,
              variant: variant ?? null,
            }
          : undefined,
    };
  }

  private resolveStartBudgetSeconds(): number {
    const configured = this.options?.startBudgetSeconds;
    if (typeof configured !== 'number' || !Number.isInteger(configured) || configured <= 0) {
      return 60;
    }
    // `ocm-run` parses OCM_START_MAX as a bounded integer; values beyond its
    // own ceiling are clamped, not passed through.
    return Math.min(configured, 99_999);
  }

  /**
   * An ambiguous start is never refused: before answering, ask `ocm-run
   * --status` whether a session came up anyway. A status exit 3 listing
   * exactly one session id means the lane is running; anything else stays
   * `unknown` and carries both the start detail and the status result.
   */
  private async startUnknownAfterLookup(
    worktreePath: string,
    env: Readonly<Record<string, string>> | undefined,
    startDetail: string,
    agent: string | null | undefined,
    model: string,
    variant: string | null | undefined,
    startStdout = '',
    startStderr = '',
  ): Promise<StartRunnerSessionResult> {
    const status = await this.lookUpRunningSession(worktreePath, env);
    if (status.ids.length === 1) {
      const id = status.ids[0];
      // Only adopt a status id the start itself named, and never one the
      // start reported aborting: the start subprocess owns this outcome.
      const { named, aborted } = startOutputIds(startStdout, startStderr);
      if (named.has(id) && !aborted.has(id)) {
        return this.startedSessionResult(id, agent, model, variant);
      }
      return {
        outcome: 'unknown',
        reason: aborted.has(id)
          ? `${startDetail}; status lists ${id}, which this start reported aborting`
          : `${startDetail}; status lists ${id}, which this start did not create`,
      };
    }
    return { outcome: 'unknown', reason: `${startDetail}; status: ${status.reason}` };
  }

  private async lookUpRunningSession(
    worktreePath: string,
    env: Readonly<Record<string, string>> | undefined,
  ): Promise<{ ids: string[]; reason: string }> {
    let result: SubprocessResult;
    try {
      // Bounded like the start itself: a stuck status call must not hang startSession.
      result = await this.run(this.binPath(), ['--status', '--dir', worktreePath], env, {
        timeoutMs: RUNNER_STATUS_LOOKUP_TIMEOUT_MS,
      });
    } catch (error) {
      return { ids: [], reason: `status command failed: ${String(error)}` };
    }
    if (result.exitCode === 3) {
      const ids = statusSessionIds(result.stdout);
      if (ids.length === 1) {
        return { ids, reason: 'status listed one session' };
      }
      return {
        ids,
        reason: `status exit 3 listed ${ids.length} sessions (${ids.join(', ') || 'none'})`,
      };
    }
    if (result.exitCode === 0) {
      return { ids: [], reason: 'status reports nothing running' };
    }
    return {
      ids: [],
      reason: `status command exited ${result.exitCode}: ${result.stderr || result.stdout || 'no output'}`,
    };
  }

  async inspectSession(session: RunnerSessionRef): Promise<RunnerSessionStatus> {
    // Resolve recorded runner
    let recordedRunner = session.runner;
    let attemptRecord: AttemptRecord | null = null;
    if (!recordedRunner && this.options?.resolveAttempt) {
      attemptRecord = await this.options.resolveAttempt(session.attemptId);
      recordedRunner = attemptRecord?.runner ?? null;
    }

    // Refuse when attempt has no recorded port (old records without it read as unknown)
    if (!recordedRunner || recordedRunner.remotePort === null) {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    const configuredPort = this.configuredRemotePort();
    const configuredHost = this.configuredRemoteHost();

    if (configuredHost !== null && !isSafeSshHost(configuredHost)) {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    if (
      recordedRunner.host !== null &&
      recordedRunner.host !== undefined &&
      !isSafeSshHost(recordedRunner.host)
    ) {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    // Refuse when configured port or host differs from recorded one
    if (
      configuredPort !== recordedRunner.remotePort ||
      (configuredHost ?? null) !== (recordedRunner.host ?? null)
    ) {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    // L1: Resolve worktree directory; never fall back to session.sessionId
    const resolved =
      session.worktreePath ??
      this.worktreeByAttemptId.get(session.attemptId) ??
      (await this.options?.resolveWorktreePath?.(session.attemptId)) ??
      attemptRecord?.worktreePath ??
      (this.options?.resolveAttempt ? (await this.options.resolveAttempt(session.attemptId))?.worktreePath : null) ??
      null;

    if (!resolved || resolved.trim() === '') {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    const dir = resolved;
    let result: SubprocessResult;
    try {
      result = await this.run(
        this.binPath(),
        ['--status', '--dir', dir],
        this.remotePortEnv(recordedRunner.remotePort, recordedRunner.host ?? undefined),
      );
    } catch {
      return {
        runnerReachable: 'unknown',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    // M1: classify ocm-run --status by exit code only:
    // 0 = nothing running, 3 = running (parse session ids only on 3), anything else unknown.
    // No keyword scanning of the text.
    if (result.exitCode === 3) {
      const parsedId = parseSessionId(result.stdout);
      if (parsedId !== null && session.sessionId && parsedId !== session.sessionId) {
        return {
          runnerReachable: 'unknown',
          workspacePreparation: 'unprepared',
          workerCommand: 'not-started',
          completionReceipt: null,
          artifactsCollected: false,
        };
      }
      return {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    if (result.exitCode === 0) {
      // "Nothing running" is authoritative ONLY when attempt has recorded sessionId,
      // port and host match, and status was asked for recorded worktree directory.
      if (!session.sessionId || session.sessionId.trim() === '') {
        return {
          runnerReachable: 'unknown',
          workspacePreparation: 'unprepared',
          workerCommand: 'not-started',
          completionReceipt: null,
          artifactsCollected: false,
        };
      }

      let parsedExitStatus: number | null = null;
      let parsedEndedAtIso: string = new Date().toISOString();
      let parsedArtifactsCollected = false;

      const trimmed = result.stdout.trim();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        for (const line of trimmed.split(/\r?\n/)) {
          const l = line.trim();
          if (l.startsWith('{') && l.endsWith('}')) {
            try {
              parsed = JSON.parse(l);
              break;
            } catch {
              // continue
            }
          }
        }
      }
      if (isPlainRecord(parsed)) {
        if (typeof parsed.exitStatus === 'number') {
          parsedExitStatus = parsed.exitStatus;
        }
        if (typeof parsed.endedAtIso === 'string' && !Number.isNaN(Date.parse(parsed.endedAtIso))) {
          parsedEndedAtIso = parsed.endedAtIso;
        }
        if (typeof parsed.artifactsCollected === 'boolean') {
          parsedArtifactsCollected = parsed.artifactsCollected;
        }
      }

      const receipt: CommandCompletionReceipt = {
        attemptId: session.attemptId,
        sessionId: session.sessionId,
        endedAtIso: parsedEndedAtIso,
        authoritative: true,
        exitStatus: parsedExitStatus,
        stoppedByRequest: false,
      };
      return {
        runnerReachable: 'reachable',
        workspacePreparation: 'prepared',
        workerCommand: 'ended',
        completionReceipt: receipt,
        artifactsCollected: parsedArtifactsCollected,
      };
    }

    // Anything else is unknown
    return {
      runnerReachable: 'unknown',
      workspacePreparation: 'unprepared',
      workerCommand: 'not-started',
      completionReceipt: null,
      artifactsCollected: false,
    };
  }

  async stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
    // Resolve recorded runner
    let recordedRunner = request.runner;
    let attemptRecord: AttemptRecord | null = null;
    if (!recordedRunner && this.options?.resolveAttempt) {
      attemptRecord = await this.options.resolveAttempt(request.attemptId);
      recordedRunner = attemptRecord?.runner ?? null;
    }

    // Refuse when attempt has no recorded port (legacy records without runner)
    if (!recordedRunner || recordedRunner.remotePort === null) {
      return { outcome: 'refused', reason: 'Attempt has no recorded runner port' };
    }

    const configuredPort = this.configuredRemotePort();
    const configuredHost = this.configuredRemoteHost();

    if (configuredHost !== null && !isSafeSshHost(configuredHost)) {
      return { outcome: 'refused', reason: `Unsafe OCM_HOST configured: ${configuredHost}` };
    }

    if (
      recordedRunner.host !== null &&
      recordedRunner.host !== undefined &&
      !isSafeSshHost(recordedRunner.host)
    ) {
      return { outcome: 'refused', reason: `Unsafe recorded runner host: ${recordedRunner.host}` };
    }

    // Refuse when configured port or host differs from recorded one
    if (
      configuredPort !== recordedRunner.remotePort ||
      (configuredHost ?? null) !== (recordedRunner.host ?? null)
    ) {
      return {
        outcome: 'refused',
        reason: 'Configured runner port or host differs from recorded runner',
      };
    }

    const resolved =
      request.worktreePath ??
      this.worktreeByAttemptId.get(request.attemptId) ??
      (await this.options?.resolveWorktreePath?.(request.attemptId)) ??
      attemptRecord?.worktreePath ??
      (this.options?.resolveAttempt ? (await this.options.resolveAttempt(request.attemptId))?.worktreePath : null) ??
      null;

    // L1: never fall back to request.sessionId; refuse!
    if (!resolved || resolved.trim() === '') {
      return { outcome: 'refused', reason: 'Worktree directory not resolved for session abort' };
    }

    const dir = resolved;
    let result: SubprocessResult;
    try {
      result = await this.run(
        this.binPath(),
        ['--abort', '--dir', dir],
        this.remotePortEnv(recordedRunner.remotePort, recordedRunner.host ?? undefined),
      );
    } catch (error) {
      return { outcome: 'unknown', reason: `Abort command failed: ${String(error)}` };
    }
    if (result.exitCode === 0) {
      // L2: a successful abort records exitStatus: null and stoppedByRequest: true instead of 130
      const receipt: CommandCompletionReceipt = {
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        endedAtIso: new Date().toISOString(),
        authoritative: true,
        exitStatus: null,
        stoppedByRequest: true,
      };
      return { outcome: 'terminated', receipt };
    }
    return {
      outcome: 'still-running',
      reason: result.stderr || result.stdout || 'Abort did not confirm termination',
    };
  }

  private binPath(): string {
    return (
      this.options?.ocmRunBin ??
      (process.env.FLEET_OCM_RUN_BIN?.trim() || undefined) ??
      DEFAULT_OCM_RUN_PATH
    );
  }

  /**
   * The routing variables of one runner subprocess, always set explicitly.
   *
   * With a v2 installation host they come from that host alone:
   * `OCM_REMOTE_PORT` is its port, `OCM_HOST` is its ssh alias or the empty
   * string when it is `local` (never the inherited value), and
   * `OPENCODE_AUTH_FILE` is its auth file. In legacy mode the resolved
   * options-or-environment port and host are used, exactly as before.
   */
  private remotePortEnv(
    overridePort?: number,
    overrideHost?: string,
  ): Readonly<Record<string, string>> | undefined {
    const overrides: Record<string, string> = {};
    const port = overridePort ?? this.configuredRemotePort();
    if (port !== undefined) {
      overrides.OCM_REMOTE_PORT = String(port);
    }

    const host = this.host();
    if (host !== undefined) {
      // A `local` host is dialled directly, so OCM_HOST must be present and
      // empty rather than absent: an inherited alias would tunnel the lane to
      // another machine.
      overrides.OCM_HOST = overrideHost ?? (host.transport === 'ssh' ? this.configuredRemoteHost() ?? '' : '');
      const authFile = host.authFile?.trim();
      if (authFile !== undefined && authFile !== '') {
        overrides.OPENCODE_AUTH_FILE = authFile;
      }
      return Object.keys(overrides).length === 0 ? undefined : overrides;
    }

    const legacyHost = overrideHost ?? this.configuredRemoteHost();
    if (legacyHost !== null && legacyHost !== undefined) {
      overrides.OCM_HOST = legacyHost;
    }
    return Object.keys(overrides).length === 0 ? undefined : overrides;
  }

  private run(
    command: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
    options?: { readonly timeoutMs?: number; readonly startCall?: boolean },
  ): Promise<SubprocessResult> {
    // D5: the lane-runner host's transport decides whether the runner
    // environment keeps `SSH_AUTH_SOCK`; every non-runner subprocess keeps
    // the full allow-list regardless. A v2 installation's own transport wins.
    const envOptions: RunnerEnvOptions = { transport: this.host()?.transport ?? this.options?.runnerTransport };
    const injected = this.options?.runSubprocess;
    if (injected !== undefined) return injected(command, args, env);
    const executor = this.options?.executor;
    if (executor !== undefined) {
      // Exactly what the legacy path applied: the allow-listed host
      // environment (from process.env) plus the explicitly resolved routing
      // variables — never the full process env, never only the OCM pair —
      // and the same 64 MiB output budget the legacy execFile path enforced.
      const runEnv = buildRunnerEnv(env as Record<string, string> | undefined, envOptions);
      return executor
        .run([command, ...args], {
          env: { ...runEnv } as Record<string, string>,
          maxBufferBytes: RUNNER_MAX_BUFFER_BYTES,
          timeoutMs: options?.timeoutMs ?? RUNNER_SUBPROCESS_TIMEOUT_MS,
          // The start's own timeout must never group-kill ocm-run's detached
          // session: a killed start stays `unknown`, but a murdered grandchild
          // would destroy a session the status lookup could have adopted.
          ...(options?.startCall === true ? { killProcessTree: false } : {}),
        })
        .then((result) => {
          if (result.exitCode === null) {
            throw new RunnerSubprocessError(
              result.error ?? 'Runner subprocess ended without an exit code',
              result.stdout,
              result.stderr,
            );
          }
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        });
    }
    return runViaExecFile(command, args, env, envOptions, options);
  }
}
