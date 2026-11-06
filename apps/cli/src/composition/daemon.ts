/**
 * Daemon composition (lane DT10b): builds the stores, the merge pass, the tick
 * and status use cases and the deadline-guarded forge probe behind
 * `fleet-v2 daemon tick|status|pause|resume`. Called by the CLI composition
 * root; it performs no I/O at construction and runs no `git` subprocess (every
 * forge read and the probe go through the injected `gh` runner, an argument
 * array without a shell).
 */
import { newUlid } from '../ulid.js';

import {
  DaemonEventProjectionAdapter,
  DaemonLeaseAdapter,
  DaemonPauseAdapter,
  DaemonStatusFileAdapter,
  InspectDaemonStatusUseCase,
  MergeNotificationAdapter,
  MergePolicyAdapter,
  MergeVerificationAdapter,
  ChainAttentionAdapter,
  ChainRepositoryAdapter,
  RefreshChainsUseCase,
  RunDaemonTickUseCase,
  RunMergePassUseCase,
  computeCallBudget,
  isZonedIsoDateTime,
  sha256HexDigest,
  type DaemonRepositoryRef,
  type GhForgeMergeReadAdapter,
  type GhInvocationResult,
  type InspectDaemonStatusPort,
  type MergePolicyAnswer,
  type MergePolicyPort,
  type MergePolicySource,
  type MergeForgeActionPort,
  type MergeQueueRepositoryAdapter,
  type SetDaemonPausePort,
  type SetDaemonPauseRequest,
  type SetDaemonPauseResult,
} from '@fleet/work-execution';
import {
  loadInstallation,
  resolveMergePolicy,
  type FleetInstallationModel,
  type LoadResult,
} from '@fleet/installation';

import type { FleetCliRuntime, FleetCliRuntimeOptions } from '../composition.js';

/** The `gh api rate_limit` probe's normal timeout (plan §3.1); the tick deadline can only shorten it. */
export const FORGE_PROBE_TIMEOUT_MS = 10_000;
/** A larger probe answer is not parsed: it counts as an unreachable forge. */
const MAX_PROBE_STDOUT_BYTES = 65_536;

export interface ComposeDaemonInput {
  readonly stateDir: string | undefined;
  readonly options: FleetCliRuntimeOptions | undefined;
  readonly installationModel: FleetInstallationModel | undefined;
  readonly forgeMode: string | undefined;
  readonly mergeForgeRead: GhForgeMergeReadAdapter;
  readonly mergeQueueRepository: MergeQueueRepositoryAdapter;
  /** The forge's branch-head read for the shadow chain refresh; only the read is taken from it. */
  readonly chainBranchRead: Pick<MergeForgeActionPort, 'readMergeBranchHead'>;
  readonly evidence: Pick<FleetCliRuntime['evidence'], 'inspectAcceptanceEvidence' | 'requestVerification'>;
  readonly conductor: Pick<FleetCliRuntime['conductor'], 'laneRunJournal' | 'halt'>;
  readonly runGh: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>;
}

export interface ComposedDaemon {
  /** True when the stores persist under a state directory. */
  readonly durable: boolean;
  readonly mergePolicy: MergePolicyPort;
  readonly pause: DaemonPauseAdapter;
  readonly status: DaemonStatusFileAdapter;
  /** The status store opened read-only: `daemon status` never quarantines or mutates disk. */
  readonly statusReadOnly: DaemonStatusFileAdapter;
  readonly lease: DaemonLeaseAdapter;
  readonly events: DaemonEventProjectionAdapter;
  readonly runMergePass: RunMergePassUseCase;
  readonly runDaemonTick: RunDaemonTickUseCase;
  readonly inspectDaemonStatus: InspectDaemonStatusPort;
  readonly setDaemonPause: SetDaemonPausePort;
  readonly probeForge: (input: { readonly nowIso: string; readonly deadlineIso: string }) => Promise<boolean>;
  readonly now: () => string;
  readonly newUlid: () => string;
}

/**
 * The installation load → the merge-policy seam. An invalid file never has its
 * path or errors forwarded: the policy is simply unknown (`installation-invalid`).
 */
export function mergePolicySourceFromLoad(load: LoadResult): MergePolicySource {
  if (load.status === 'invalid') {
    return { outcome: 'invalid', reason: 'installation-invalid' };
  }
  return resolveMergePolicy(load.model.policy ?? {});
}

/** The known policy answer → one daemon repository ref per configured repository. */
export function toDaemonRepositoryRefs(
  answer: Extract<MergePolicyAnswer, { outcome: 'known' }>,
): readonly DaemonRepositoryRef[] {
  return answer.repositories.map((entry) => ({
    owner: entry.owner,
    repo: entry.repo,
    repoDigest: sha256HexDigest(`${entry.owner}/${entry.repo}`).slice(0, 12),
    projectId: entry.projectId,
    policy: {
      policyRevision: answer.policyRevision,
      shadow: entry.shadow,
      unattended: entry.unattended,
      requiredContexts: [...entry.requiredContexts],
      updateBranch: entry.updateBranch,
      macosProcedure: entry.macosProcedure,
      maxAttempts: entry.maxAttempts,
      checksGraceMinutes: {
        gate: entry.checksGraceMinutes,
        premerge: entry.checksGraceMinutes,
      },
      veto: {
        mode: entry.veto.mode,
        holdConfidence: entry.veto.holdConfidence,
      },
    },
  }));
}

function refusedPause(reasonCode: 'invalid-request' | 'invalid-clock' | 'pause-write-failed'): SetDaemonPauseResult {
  return { outcome: 'refused', exitCode: 1, reasonCode };
}

export function composeDaemon(input: ComposeDaemonInput): ComposedDaemon {
  const { stateDir, options, installationModel } = input;
  const durable = stateDir !== undefined && stateDir.trim().length > 0;

  const mergePolicy = new MergePolicyAdapter({
    readInstallation: async (): Promise<MergePolicySource> => {
      if (options?.loadInstallationForMergePolicy !== undefined) {
        return mergePolicySourceFromLoad(options.loadInstallationForMergePolicy());
      }
      if (options?.installation !== undefined) {
        return resolveMergePolicy(installationModel?.policy ?? {});
      }
      return mergePolicySourceFromLoad(loadInstallation({ env: options?.env ?? process.env }));
    },
  });

  const pause = new DaemonPauseAdapter({ stateDir });
  const status = new DaemonStatusFileAdapter({ stateDir });
  const statusReadOnly = durable ? new DaemonStatusFileAdapter({ stateDir, readOnly: true }) : status;
  const lease = new DaemonLeaseAdapter({ stateDir });
  const events = new DaemonEventProjectionAdapter({ stateDir });
  const verification = new MergeVerificationAdapter({
    inspector: input.evidence.inspectAcceptanceEvidence,
    requester: input.evidence.requestVerification,
  });
  const notifier = new MergeNotificationAdapter();
  const now = options?.daemonNow ?? (() => new Date().toISOString());

  const runMergePass = new RunMergePassUseCase({
    queue: input.mergeQueueRepository,
    queueWriter: input.mergeQueueRepository,
    notifier,
    forgeRead: input.mergeForgeRead,
    verification,
    journal: input.conductor.laneRunJournal,
    halt: input.conductor.halt,
    newUlid: () => newUlid(),
    nowIso: now,
  });
  // CO8: the chain-refresh job runs in shadow mode only (`policy.daemon.chainRefresh` has no live
  // value yet). The forge facade exposes the branch-head read and refuses every action, so no code
  // path here can merge, push or write to the forge; chain-refresh.sh stays the only merger.
  const shadowForge: MergeForgeActionPort = {
    readMergeBranchHead: (request) => input.chainBranchRead.readMergeBranchHead(request),
    performMergeForgeAction: async () => ({ outcome: 'refused', reason: 'shadow-mode', refusalKind: 'other' }),
    isConfigured: () => true,
  };
  const chainRefresh = new RefreshChainsUseCase({
    chains: durable ? new ChainRepositoryAdapter({ stateDir }) : new ChainRepositoryAdapter(),
    forge: shadowForge,
    attention: new ChainAttentionAdapter(),
    now,
    mode: 'shadow',
  });
  const runDaemonTick = new RunDaemonTickUseCase({
    pause,
    halt: input.conductor.halt,
    status,
    lease,
    events,
    queue: input.mergeQueueRepository,
    forge: input.mergeForgeRead,
    journal: input.conductor.laneRunJournal,
    mergePass: runMergePass,
    chainRefresh,
    now,
    ...(options?.daemonSleep !== undefined ? { sleep: options.daemonSleep } : {}),
    newUlid: () => newUlid(),
  });
  const inspectDaemonStatus = new InspectDaemonStatusUseCase({ status: statusReadOnly, policy: mergePolicy });

  const setDaemonPause: SetDaemonPausePort = {
    async setPause(request: SetDaemonPauseRequest): Promise<SetDaemonPauseResult> {
      let paused: unknown;
      let nowIso: unknown;
      try {
        if (typeof request !== 'object' || request === null || Array.isArray(request)) {
          return refusedPause('invalid-request');
        }
        paused = request.paused;
        nowIso = request.nowIso;
      } catch {
        return refusedPause('invalid-request');
      }
      if (typeof paused !== 'boolean') {
        return refusedPause('invalid-request');
      }
      if (typeof nowIso !== 'string' || !isZonedIsoDateTime(nowIso)) {
        return refusedPause('invalid-clock');
      }
      try {
        const written = await pause.write(paused, nowIso);
        return written.ok
          ? { outcome: 'recorded', exitCode: 0, record: written.record }
          : refusedPause('pause-write-failed');
      } catch {
        return refusedPause('pause-write-failed');
      }
    },
  };

  /** The forge probe (`gh api rate_limit`): true only for a bounded JSON object answer; never throws. */
  const probeForge = async (probe: { readonly nowIso: string; readonly deadlineIso: string }): Promise<boolean> => {
    try {
      if (input.forgeMode !== 'github') {
        return false;
      }
      const budget = computeCallBudget({
        nowIso: probe.nowIso,
        deadlineIso: probe.deadlineIso,
        normalTimeoutMs: FORGE_PROBE_TIMEOUT_MS,
      });
      if (!budget.allowed) {
        return false;
      }
      const result: unknown = await input.runGh(['api', 'rate_limit'], budget.timeoutMs);
      if (typeof result !== 'object' || result === null) {
        return false;
      }
      const { exitCode, stdout } = result as { exitCode?: unknown; stdout?: unknown };
      if (exitCode !== 0 || typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_PROBE_STDOUT_BYTES) {
        return false;
      }
      const parsed: unknown = JSON.parse(stdout);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };

  return {
    durable,
    mergePolicy,
    pause,
    status,
    statusReadOnly,
    lease,
    events,
    runMergePass,
    runDaemonTick,
    inspectDaemonStatus,
    setDaemonPause,
    probeForge,
    now,
    newUlid: () => newUlid(),
  };
}
