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
  WorkspacePreparationState,
} from '../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { CommandCompletionReceipt } from '../../domain/execution-records.js';

const execFileAsync = promisify(execFile);

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
  readonly agent?: string;
  readonly model?: string;
  readonly variant?: string;
  /** Optional resolver for cross-process lookup of an attempt's worktree path when not cached in memory. */
  readonly resolveWorktreePath?: (attemptId: string) => Promise<string | null> | string | null;
  /** Deterministic subprocess execution for unit tests. */
  readonly runSubprocess?: SubprocessRunner;
  /** Capability overrides on top of the enforced defaults. */
  readonly capabilities?: Partial<RunnerIsolationCapabilities>;
}

const defaultCapabilities: RunnerIsolationCapabilities = {
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

/** Build the sanitized subprocess environment from the allow-list plus overrides. */
export function buildRunnerEnv(
  overrides?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_ENV_ALLOWLIST) {
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
): Promise<SubprocessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      env: buildRunnerEnv(env),
      // A live `ocm-run --format json` run streams NDJSON on stdout; the
      // default 1 MiB node buffer truncates it and reports a runner failure.
      maxBuffer: 64 * 1024 * 1024,
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

function asIsoString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asExitStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const workspacePreparationStates: readonly WorkspacePreparationState[] = [
  'unprepared',
  'preparing',
  'prepared',
  'failed',
];

function isWorkspacePreparationState(value: string): value is WorkspacePreparationState {
  return (workspacePreparationStates as readonly string[]).includes(value);
}

export class ExecutionRunnerAdapter implements ExecutionRunnerPort {
  /** Locator for status/abort calls: the attempt's worktree when known. */
  private readonly worktreeByAttemptId = new Map<string, string>();

  constructor(private readonly options?: ExecutionRunnerAdapterOptions) {}

  describeCapabilities(): RunnerIsolationCapabilities {
    return { ...defaultCapabilities, ...this.options?.capabilities };
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

    this.worktreeByAttemptId.set(request.attemptId, request.worktreePath);

    const args: string[] = ['--detach', '--dir', request.worktreePath];
    const agent = this.options?.agent;
    const model = this.options?.model;
    const variant = this.options?.variant;
    if (agent !== undefined) args.push('--agent', agent);
    if (model !== undefined) args.push('-m', model);
    if (variant !== undefined) args.push('--variant', variant);
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
        return { outcome: 'started', sessionId };
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
    // A reconcile or stop runs in a later CLI process than the dispatch, so
    // the locator is resolved from the recorded attempt rather than memory.
    const resolved =
      this.worktreeByAttemptId.get(session.attemptId) ??
      (await this.options?.resolveWorktreePath?.(session.attemptId)) ??
      null;
    const dir = resolved ?? session.sessionId;
    let result: SubprocessResult;
    try {
      result = await this.run(this.binPath(), ['--status', '--dir', dir], this.remotePortEnv());
    } catch {
      return {
        runnerReachable: 'unreachable',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }
    // `ocm-run --status` exits 3 when a session is running in the directory and
    // 0 when nothing is; both carry a classified status line.
    if (result.exitCode !== 0 && result.exitCode !== 3) {
      return {
        runnerReachable: 'unreachable',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }
    return this.parseSessionStatus(session, `${result.stdout}\n${result.stderr}`);
  }

  async stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
    const resolved =
      this.worktreeByAttemptId.get(request.attemptId) ??
      (await this.options?.resolveWorktreePath?.(request.attemptId)) ??
      null;
    const dir = resolved ?? request.sessionId;
    let result: SubprocessResult;
    try {
      result = await this.run(this.binPath(), ['--abort', '--dir', dir], this.remotePortEnv());
    } catch (error) {
      return { outcome: 'unknown', reason: `Abort command failed: ${String(error)}` };
    }
    if (result.exitCode === 0) {
      const receipt: CommandCompletionReceipt = {
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        endedAtIso: new Date().toISOString(),
        authoritative: true,
        exitStatus: 130,
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
  private remotePortEnv(): Readonly<Record<string, string>> | undefined {
    const overrides: Record<string, string> = {};
    if (this.options?.remotePort !== undefined) {
      overrides.OCM_REMOTE_PORT = String(this.options.remotePort);
    }
    const remoteHost = this.options?.remoteHost ?? (process.env.OCM_HOST?.trim() || undefined);
    if (remoteHost !== undefined) {
      overrides.OCM_HOST = remoteHost;
    }
    return Object.keys(overrides).length === 0 ? undefined : overrides;
  }

  private run(
    command: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<SubprocessResult> {
    const injected = this.options?.runSubprocess;
    if (injected !== undefined) return injected(command, args, env);
    return runViaExecFile(command, args, env);
  }

  private parseSessionStatus(session: RunnerSessionRef, output: string): RunnerSessionStatus {
    const lower = output.toLowerCase();

    let activeFlag: boolean | undefined;
    let endedAtIso: string | null = null;
    let exitStatus: number | null = null;
    let artifactsCollected = false;
    let workspacePreparation: WorkspacePreparationState | undefined;
    const trimmed = output.trim();
    if (trimmed !== '') {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const candidate = parsed as Record<string, unknown>;
          if (typeof candidate.active === 'boolean') activeFlag = candidate.active;
          endedAtIso =
            asIsoString(candidate.endedAtIso) ?? asIsoString(candidate.ended_at_iso);
          exitStatus =
            asExitStatus(candidate.exitStatus) ??
            asExitStatus(candidate.exit_status) ??
            asExitStatus(candidate.exitCode);
          if (typeof candidate.artifactsCollected === 'boolean') {
            artifactsCollected = candidate.artifactsCollected;
          }
          const preparation =
            asIsoString(candidate.workspacePreparation) ?? asIsoString(candidate.workspace_preparation);
          if (preparation !== null && isWorkspacePreparationState(preparation)) {
            workspacePreparation = preparation;
          }
        }
      } catch {
        // Free-text status output; keyword classification below.
      }
    }

    if (
      lower.includes('unreachable') ||
      lower.includes('not reachable') ||
      lower.includes('connection refused') ||
      lower.includes('error')
    ) {
      return {
        runnerReachable: 'unreachable',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }

    const ended =
      activeFlag === false ||
      lower.includes('idle') ||
      lower.includes('nothing running') ||
      lower.includes('nothing is running');
    if (ended) {
      const receipt: CommandCompletionReceipt = {
        attemptId: session.attemptId,
        sessionId: session.sessionId,
        endedAtIso: endedAtIso ?? new Date().toISOString(),
        authoritative: true,
        exitStatus,
        stoppedByRequest: false,
      };
      return {
        runnerReachable: 'reachable',
        workspacePreparation: workspacePreparation ?? 'prepared',
        workerCommand: 'ended',
        completionReceipt: receipt,
        artifactsCollected,
      };
    }

    const active = activeFlag === true || lower.includes('active') || lower.includes('running');
    if (active) {
      return {
        runnerReachable: 'reachable',
        workspacePreparation: workspacePreparation ?? 'prepared',
        workerCommand: 'active',
        completionReceipt: null,
        artifactsCollected,
      };
    }

    return {
      runnerReachable: 'unreachable',
      workspacePreparation: 'unprepared',
      workerCommand: 'not-started',
      completionReceipt: null,
      artifactsCollected: false,
    };
  }
}
