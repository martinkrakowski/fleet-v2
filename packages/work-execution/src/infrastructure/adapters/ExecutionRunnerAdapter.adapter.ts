// @generated adapter scaffold — implemented for migration step 2 (reviewed ocm-run subprocess wrapper).
/**
 * ExecutionRunnerAdapter implements ExecutionRunnerPort by wrapping the
 * reviewed `ocm-run` subprocess. A subprocess runner can be injected for
 * deterministic unit tests. Ambiguous outcomes are reported as `unknown`
 * (never retried blindly, never releasing capacity); only a confirmed
 * termination or runner-reported end produces a completion receipt.
 */

import { execFile } from 'node:child_process';
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
  /** Path of the ocm-run binary; `ocm-run` from PATH when omitted. */
  readonly ocmRunBin?: string;
  /** Port passed as OCM_REMOTE_PORT to the runner subprocess. */
  readonly remotePort?: number;
  readonly agent?: string;
  readonly model?: string;
  readonly variant?: string;
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

/** Default subprocess runner: exit codes become values, spawn failures throw. */
async function runViaExecFile(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<SubprocessResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      env: env === undefined ? process.env : { ...process.env, ...env },
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

/** Extract a session id from JSON output or the first `ses_...` token. */
function parseSessionId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed !== '') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        for (const key of ['sessionID', 'sessionId']) {
          const value = candidate[key];
          if (typeof value === 'string' && value.trim() !== '') return value.trim();
        }
      }
    } catch {
      // Not JSON output; fall through to the token scan.
    }
  }
  for (const rawToken of stdout.split(/\s+/)) {
    const token = rawToken.replace(/^["'`[{(]+/, '').replace(/["'`\]},.)]+$/, '');
    if (token.startsWith('ses_')) return token;
  }
  return null;
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

    const remotePort = this.options?.remotePort;
    const env = remotePort === undefined ? undefined : { OCM_REMOTE_PORT: String(remotePort) };

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
    const dir = this.worktreeByAttemptId.get(session.attemptId) ?? session.sessionId;
    let result: SubprocessResult;
    try {
      result = await this.run(this.binPath(), ['--status', '--dir', dir]);
    } catch {
      return {
        runnerReachable: 'unreachable',
        workspacePreparation: 'unprepared',
        workerCommand: 'not-started',
        completionReceipt: null,
        artifactsCollected: false,
      };
    }
    if (result.exitCode !== 0) {
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
    const dir = this.worktreeByAttemptId.get(request.attemptId) ?? request.sessionId;
    let result: SubprocessResult;
    try {
      result = await this.run(this.binPath(), ['--abort', '--dir', dir]);
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
    return this.options?.ocmRunBin ?? 'ocm-run';
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

    const ended = activeFlag === false || lower.includes('idle') || lower.includes('nothing running');
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
