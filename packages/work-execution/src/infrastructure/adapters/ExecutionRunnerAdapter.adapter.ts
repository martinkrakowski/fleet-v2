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

/** Runner subprocess budget; the runner is started with --detach, so it returns well within this. */
const RUNNER_START_TIMEOUT_MS = 120_000;

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

export interface ExecutionRunnerAdapterOptions {
  /** Path of the ocm-run binary; the bundled `bin/ocm-run` when found, else `ocm-run` from PATH when omitted. */
  readonly ocmRunBin?: string;
  /** Port passed as OCM_REMOTE_PORT to the runner subprocess. */
  readonly remotePort?: number;
  /** SSH host passed as OCM_HOST to the runner subprocess when configured. */
  readonly remoteHost?: string;
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
   * Transport of the host holding the lane-runner role (D5). A `local` host's
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
  'OCM_REMOTE_PORT',
  'OCM_HOST',
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
): Promise<SubprocessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      env: buildRunnerEnv(env, envOptions),
      // A live `ocm-run --format json` run streams NDJSON on stdout; the
      // default 1 MiB node buffer truncates it and reports a runner failure.
      maxBuffer: RUNNER_MAX_BUFFER_BYTES,
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

/** An ssh destination that could inject options or split words never spawns. */
function isSafeSshHost(host: string): boolean {
  return host.length > 0 && !host.startsWith('-') && !/\s/.test(host);
}

export class ExecutionRunnerAdapter implements ExecutionRunnerPort {
  /** Locator for status/abort calls: the attempt's worktree when known. */
  private readonly worktreeByAttemptId = new Map<string, string>();

  constructor(private readonly options?: ExecutionRunnerAdapterOptions) {}

  describeCapabilities(): RunnerIsolationCapabilities {
    return { ...defaultCapabilities, ...this.options?.capabilities };
  }

  configuredRemotePort(): number | undefined {
    if (this.options?.remotePort !== undefined) return this.options.remotePort;
    const envPort = process.env.OCM_REMOTE_PORT;
    if (envPort !== undefined && envPort.trim() !== '') {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  configuredRemoteHost(): string | null {
    return this.options?.remoteHost ?? (process.env.OCM_HOST?.trim() || null);
  }

  describeRunner(): AttemptRunnerRecord | undefined {
    const port = this.configuredRemotePort();
    if (port === undefined) return undefined;
    return {
      remotePort: port,
      host: this.configuredRemoteHost(),
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

    let result: SubprocessResult;
    try {
      result = await this.run(this.binPath(), args, env);
    } catch (error) {
      return { outcome: 'unknown', reason: `Runner start failed: ${String(error)}` };
    }

    if (result.exitCode === 75) {
      return { outcome: 'refused', reason: 'Worktree already has an active session (exit 75)' };
    }
    if (result.exitCode === 0) {
      const sessionId = parseSessionId(result.stdout);
      if (sessionId !== null) {
        const port = this.configuredRemotePort();
        return {
          outcome: 'started',
          sessionId,
          runner:
            port !== undefined
              ? {
                  remotePort: port,
                  host: this.configuredRemoteHost(),
                  agent: agent ?? null,
                  model,
                  variant: variant ?? null,
                }
              : undefined,
        };
      }
      return {
        outcome: 'unknown',
        reason: result.stderr || result.stdout || 'Runner exited 0 without returning a sessionId',
      };
    }
    return {
      outcome: 'unknown',
      reason: result.stderr || result.stdout || 'Runner start outcome ambiguous',
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
    if (!recordedRunner || recordedRunner.remotePort === undefined || recordedRunner.remotePort === null) {
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
    if (!recordedRunner || recordedRunner.remotePort === undefined || recordedRunner.remotePort === null) {
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

  /** Configured remote port/host as runner environment; absent when neither is set. */
  private remotePortEnv(
    overridePort?: number,
    overrideHost?: string,
  ): Readonly<Record<string, string>> | undefined {
    const overrides: Record<string, string> = {};
    const port = overridePort ?? this.configuredRemotePort();
    if (port !== undefined) {
      overrides.OCM_REMOTE_PORT = String(port);
    }
    const host = overrideHost ?? this.configuredRemoteHost();
    if (host !== null && host !== undefined) {
      overrides.OCM_HOST = host;
    }
    return Object.keys(overrides).length === 0 ? undefined : overrides;
  }

  private run(
    command: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<SubprocessResult> {
    // D5: the lane-runner host's transport decides whether the runner
    // environment keeps `SSH_AUTH_SOCK`; every non-runner subprocess keeps
    // the full allow-list regardless.
    const envOptions: RunnerEnvOptions = { transport: this.options?.runnerTransport };
    const injected = this.options?.runSubprocess;
    if (injected !== undefined) return injected(command, args, env);
    const executor = this.options?.executor;
    if (executor !== undefined) {
      // Exactly what the legacy path applied: the allow-listed host
      // environment (from process.env) plus the OCM overrides — never the
      // full process env and never only the two OCM variables — and the
      // same 64 MiB output budget the legacy execFile path enforced.
      const runEnv = buildRunnerEnv(env as Record<string, string> | undefined, envOptions);
      return executor
        .run([command, ...args], {
          env: { ...runEnv } as Record<string, string>,
          maxBufferBytes: RUNNER_MAX_BUFFER_BYTES,
          timeoutMs: RUNNER_START_TIMEOUT_MS,
        })
        .then((result) => {
          if (result.exitCode === null) {
            throw new Error(result.error ?? 'Runner subprocess ended without an exit code');
          }
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        });
    }
    return runViaExecFile(command, args, env, envOptions);
  }
}
