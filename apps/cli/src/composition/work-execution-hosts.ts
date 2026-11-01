/**
 * Work-execution host composition (SPLIT-2): builds the execution stores,
 * recorded-host executors, runners and the forge delegate from the shared
 * root inputs; called by the CLI composition root.
 */
import { existsSync } from 'node:fs';

import {
  AgyRunnerAdapter,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  AttemptReviewLocator,
  BriefAuthoringAdapter,
  ExecutionJournalAdapter,
  ExecutionRunnerAdapter,
  ExecutorForHost,
  ForgeActionAdapter,
  OpencodeApiUsageAdapter,
  RunnerForAttemptAdapter,
  RunnerSelectorAdapter,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  isSafeSshHost,
  resolveRunnerCapabilityProfile,
  type ExecutionRunnerHost,
  type ExecutorForRecordedHostResult,
  type ForgeActionDelegate,
  type ForgeReadAdapter,
  type GhInvocationResult,
  type resolveRoleExecutors,
  forgeActionPushesBranch,
} from '@fleet/work-execution';
import type { FleetInstallationModel } from '@fleet/installation';

import type { FleetCliRuntimeOptions } from '../composition.js';
import type {
  headRouteForExecutor,
  readGitHead,
  readGitHeadLocally,
  readGitHeadOverSsh,
} from '../composition.js';

export interface ComposeExecutionHostsInput {
  readonly stateDir?: string;
  readonly options?: FleetCliRuntimeOptions;
  readonly roleExecutors: ReturnType<typeof resolveRoleExecutors>;
  readonly reviewLocatorRef: { locator?: AttemptReviewLocator };
  readonly runnerRemotePort?: number;
  readonly runnerRemoteHost?: string;
  readonly ocmRunBin?: string;
  readonly runnerHost?: ExecutionRunnerHost;
  readonly runnerProfile: ReturnType<typeof resolveRunnerCapabilityProfile>;
  readonly executorForHostName: (name: string) => ExecutorForRecordedHostResult;
  readonly agyHost?: {
    readonly name: string;
    readonly mode: 'edit-only' | 'full';
    readonly sshAlias?: string;
  };
  readonly installationModel?: FleetInstallationModel;
  readonly runGhSubprocess: (
    args: readonly string[],
    candidates?: readonly string[],
  ) => Promise<GhInvocationResult>;
  readonly ghBinaryCandidates: readonly string[];
  readonly forgeRead: ForgeReadAdapter;
  readonly forgeGithubSection?: Extract<FleetInstallationModel['forge'], { mode: 'github' }>;
  readonly worktreeSshHost?: string;
  readonly forgeActionOverrides: (
    delegate: Pick<ForgeActionDelegate, 'runGh' | 'verifyCurrentHeadSha'> | undefined,
  ) => Partial<Pick<ForgeActionDelegate, 'runGh' | 'verifyCurrentHeadSha'>>;
  readonly readGitHeadOverSsh: typeof readGitHeadOverSsh;
  readonly readGitHeadLocally: typeof readGitHeadLocally;
  readonly readGitHead: typeof readGitHead;
  readonly headRouteForExecutor: typeof headRouteForExecutor;
  readonly runGitCommand: (args: readonly string[]) => Promise<string>;
}

export function composeExecutionHosts(input: ComposeExecutionHostsInput) {
  const {
    stateDir,
    options,
    roleExecutors,
    reviewLocatorRef,
    runnerRemotePort,
    runnerRemoteHost,
    ocmRunBin,
    runnerHost,
    runnerProfile,
    executorForHostName,
    agyHost,
    installationModel,
    runGhSubprocess,
    ghBinaryCandidates,
    forgeRead,
    forgeGithubSection,
    worktreeSshHost,
    forgeActionOverrides,
    readGitHeadOverSsh,
    readGitHeadLocally,
    readGitHead,
    headRouteForExecutor,
    runGitCommand,
  } = input;

  // --- work-execution ---------------------------------------------------------

  const workOrderRepository = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepository = new AttemptRepositoryAdapter({ stateDir });
  const executionJournal = new ExecutionJournalAdapter({ stateDir });
  // H9b2: workspace and artifact reads for an attempt recorded on a named
  // host run through that recorded host's executor (the recorded host is the
  // truth); legacy records keep the worktree-role executor exactly as before.
  const executorForHost = new ExecutorForHost({
    hosts: options?.installation?.hosts,
    legacyExecutor: roleExecutors.worktree,
  });
  // The review locator reads attempt records and recorded-host executors from
  // this work context; it is filled in here so the router bound above only
  // runs after composition finishes.
  reviewLocatorRef.locator = new AttemptReviewLocator({
    findAttempt: (attemptId) => attemptRepository.findAttemptById(attemptId),
    executorForHost,
    hosts: options?.installation?.hosts,
    legacyRoute: {
      ...(runnerRemotePort !== undefined ? { remotePort: runnerRemotePort } : {}),
      ...(runnerRemoteHost !== undefined ? { remoteHost: runnerRemoteHost } : {}),
    },
  });
  const workspace = new WorkspaceAdapter({
    executor: roleExecutors.worktree,
    executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
  });
  // Wraps the reviewed `ocm-run` runner subprocess. The bundled repository
  // script is the default; the worktree locator is resolved from the recorded
  // attempt so a later CLI process (reconcile, stop, collect) addresses the
  // same directory the dispatch used.
  const runner = new ExecutionRunnerAdapter({
    ocmRunBin,
    remotePort: runnerRemotePort,
    remoteHost: runnerRemoteHost,
    // A v2 installation routes the runner from its selected lane-runner host;
    // the host's presence switches the adapter to v2 mode (no env fallbacks,
    // OCM_HOST/OCM_REMOTE_PORT/OPENCODE_AUTH_FILE set from the host alone).
    ...(runnerHost !== undefined ? { host: runnerHost } : {}),
    executor: roleExecutors.orchestrator,
    runSubprocess: options?.runSubprocess,
    // The capability report comes from the installation's lane-runner entry
    // with the loader-derived source (D4); the transport trims the runner
    // environment on a single machine (D5).
    ...(runnerProfile !== undefined ? { capabilities: runnerProfile.capabilities } : {}),
    ...(runnerProfile !== undefined ? { runnerTransport: runnerProfile.transport } : {}),
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepository.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepository.findAttemptById(attemptId),
  });
  // H9b1: inspect, reconcile, stop and collect act through the attempt's
  // recorded host. One adapter per host name is built and cached from the
  // installation's hosts with the same options as the single runner above;
  // legacy attempts (no recorded hostName) keep this single runner.
  // AG-5: the executor that runs `bin/agy-run` on a named agy lane-runner host,
  // for attempts recorded on that host (reconcile, stop, collect, edit-only commit).
  const agyExecutorForHost = (name: string) => {
    const resolved = executorForHostName(name);
    return resolved.ok ? resolved.executor : null;
  };
  const runnerForAttempt = new RunnerForAttemptAdapter({
    hosts: options?.installation?.hosts,
    legacyRunner: runner,
    ocmRunBin,
    executor: roleExecutors.orchestrator,
    agyExecutorForHost,
    runSubprocess: options?.runSubprocess,
    ...(runnerProfile !== undefined ? { capabilities: runnerProfile.capabilities } : {}),
    ...(runnerProfile !== undefined ? { runnerTransport: runnerProfile.transport } : {}),
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepository.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepository.findAttemptById(attemptId),
  });
  // AG-5: the agy runner of the installation's agy lane-runner host. Its
  // executor runs `bin/agy-run` on that host; its mode is the host's declared
  // agyMode (D7). Absent host or executor: no agy runner, and an agy
  // reservation is refused as runner-not-available.
  const agyExecutor = agyHost === undefined ? undefined : executorForHostName(agyHost.name);
  const agyProfile =
    agyHost === undefined
      ? undefined
      : resolveRunnerCapabilityProfile({
          [agyHost.name]: installationModel!.hosts[agyHost.name],
        });
  const agyRunner =
    agyHost !== undefined && agyExecutor !== undefined && agyExecutor.ok
      ? new AgyRunnerAdapter({
          executor: agyExecutor.executor,
          hostName: agyHost.name,
          ...(agyHost.sshAlias !== undefined ? { sshAlias: agyHost.sshAlias } : {}),
          mode: agyHost.mode,
          ...(agyProfile !== undefined
            ? {
                capabilities: agyProfile.capabilities,
                transport: agyProfile.transport,
              }
            : {}),
          resolveWorktreePath: async (attemptId) =>
            (await attemptRepository.findAttemptById(attemptId))?.worktreePath ?? null,
          resolveAttempt: async (attemptId) => await attemptRepository.findAttemptById(attemptId),
        })
      : undefined;
  // AG-5: the selector implements both runner kinds for dispatch. The single
  // agy runner is handed to dispatch; a second agy host is never dispatched to
  // (its recorded attempts still resolve through runnerForAttempt per host).
  const runnerSelector = new RunnerSelectorAdapter({
    hosts: installationModel?.hosts,
    implementedRunnerKinds: agyRunner === undefined ? ['opencode'] : ['opencode', 'agy'],
  });
  const attemptArtifact = new AttemptArtifactAdapter({
    executor: roleExecutors.worktree,
    executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
  });
  // KF-15b: the usage read asks the opencode server that ran the session
  // (`ocm-run --usage`) over the route a review of the same attempt dials: the
  // installation host's alias, port and auth file, or the legacy environment
  // route. A route that cannot be built refuses, which the adapter reports as
  // `unavailable` without running anything.
  const opencodeUsage = new OpencodeApiUsageAdapter({
    ocmRunBin,
    routeForAttempt: (attempt) => {
      const locator = reviewLocatorRef.locator;
      if (locator === undefined) {
        return { ok: false, reason: 'no review locator composed' };
      }
      const route = locator.routeFor(attempt.runner ?? null);
      if (route.kind === 'none') {
        return { ok: false, reason: route.reason };
      }
      if (route.remotePort === undefined) {
        return { ok: false, reason: 'no runner port recorded or configured' };
      }
      const sshHost = route.remoteHost !== undefined && route.remoteHost !== '' ? route.remoteHost : null;
      return {
        ok: true,
        remotePort: route.remotePort,
        sshHost,
        authFile: route.kind === 'installation' && route.authFile !== undefined ? route.authFile : null,
        transport: sshHost === null ? 'local' : 'ssh',
      };
    },
  });
  // Hand-written brief files arrive per request; no default prose is assumed.
  const briefAuthoring = new BriefAuthoringAdapter();
  // The reviewed GitHub CLI subprocess behind a host-side delegate; every
  // invocation first verifies the live HEAD of the attempt's own worktree so
  // a moved branch head is never pushed or merged on stale readiness.
  const forgeAction = new ForgeActionAdapter(
    {
    runGh: (args: readonly string[]) => runGhSubprocess(args, ghBinaryCandidates),
    verifyCurrentHeadSha: async (branchName, request) => {
      const attempt = await attemptRepository.findAttemptById(request.attemptId);
      if (attempt === null) {
        throw new Error(`No attempt is recorded for ${request.attemptId}`);
      }
      // H9b2: the recorded host is the truth. Every recorded runner block is
      // resolved through the ExecutorForHost helper: a record with a hostName
      // is confirmed against the installation, and an alias-only record
      // resolves through the single installation ssh host with that alias or
      // is refused, naming the record (owner decision D2) — it never falls
      // back to the legacy route. When the helper resolves an installation
      // host, the recorded host's transport reads HEAD, seeds and fetches —
      // local reads locally, an ssh host through its alias — and a host that
      // changed or was removed refuses. A legacy record (no runner block, or
      // the helper's legacy executor) keeps today's behaviour exactly, with
      // the `existsSync(worktreePath)` heuristic behind the legacy branch
      // only.
      const recorded = attempt.runner ?? null;
      const recordedResolution = executorForHost.executorForRecordedHost(recorded);
      if (!recordedResolution.ok) {
        // A changed, removed or unresolvable host refuses, naming the record.
        throw new Error(recordedResolution.reason);
      }
      const recordedResolved = recordedResolution.hostSpec !== undefined;
      const recordedRoute = recordedResolved
        ? headRouteForExecutor(recordedResolution.executor)
        : null;
      const recordedSshAlias = recordedRoute?.route === 'ssh' ? recordedRoute.alias : null;
      const head =
        recordedRoute !== null
          ? recordedRoute.route === 'ssh'
            ? await readGitHeadOverSsh(attempt.worktreePath, recordedRoute.alias)
            : await readGitHeadLocally(attempt.worktreePath)
          : await readGitHead(attempt.worktreePath, worktreeSshHost);
      // Only the branch-pushing kinds (push-and-open-pr, push-to-pr) build the
      // push plumbing; every other kind (post-status, merge-pr) returns the
      // verified head unchanged (KS7a-2).
      if (!forgeActionPushesBranch(request.kind)) {
        return head;
      }
      // A worktree that lives on another host has its branch only on that
      // host's repository; `gh pr create` (and `push-to-pr`, which updates an
      // existing PR's branch) needs the branch on origin, so the verified head
      // is fetched across and pushed before the PR is opened.
      const branchRef = `${head}:refs/heads/${branchName}`;
      // push-to-pr updates an existing PR branch: never force it (a non-fast-forward
      // push fails and the action is ambiguous); the other kinds keep `-f`.
      const pushArgs =
        request.kind === 'push-to-pr'
          ? ['push', 'origin', branchRef]
          : ['push', '-f', 'origin', branchRef];
      const recordedWantsSeed =
        recordedResolved
          ? recordedSshAlias !== null ||
            process.env.FLEET_FORGE_PUSH_ORIGIN === '1'
          : null;
      const shouldSeedOrigin =
        forgeActionPushesBranch(request.kind) &&
        head === request.expectedHeadSha &&
        (recordedWantsSeed !== null
          ? recordedWantsSeed
          : worktreeSshHost !== undefined ||
            process.env.FLEET_FORGE_PUSH_ORIGIN === '1');
      if (shouldSeedOrigin && recordedSshAlias !== null) {
        if (!isSafeSshHost(recordedSshAlias)) {
          throw new Error(
            `Refusing to fetch from unsafe SSH host: '${recordedSshAlias}'`,
          );
        }
        await runGitCommand([
          'fetch',
          `${recordedSshAlias}:${attempt.worktreePath}`,
          branchRef,
          '--force',
        ]);
        await runGitCommand(pushArgs);
      } else if (
        shouldSeedOrigin &&
        recordedResolved &&
        recordedSshAlias === null &&
        process.env.FLEET_FORGE_PUSH_ORIGIN === '1'
      ) {
        // A recorded local host: the worktree lives on this machine, so the
        // orchestrator fetches from the worktree path itself.
        await runGitCommand(['fetch', attempt.worktreePath, branchRef, '--force']);
        await runGitCommand(pushArgs);
      } else if (
        shouldSeedOrigin &&
        !recordedResolved &&
        worktreeSshHost !== undefined &&
        !existsSync(attempt.worktreePath)
      ) {
        // Legacy record: today's fetch across the configured worktree ssh
        // host, unchanged.
        if (!isSafeSshHost(worktreeSshHost)) {
          throw new Error(`Refusing to fetch from unsafe SSH host: '${worktreeSshHost}'`);
        }
        await runGitCommand([
          'fetch',
          `${worktreeSshHost}:${attempt.worktreePath}`,
          branchRef,
          '--force',
        ]);
        await runGitCommand(pushArgs);
      }
      return head;
    },
    pullRequestRead: forgeRead,
    ...(forgeGithubSection !== undefined
      ? { repository: { owner: forgeGithubSection.owner, repo: forgeGithubSection.repo } }
      : {}),
    // Test-only: a supplied gh runner or head read replaces the production one (spread last, so it wins).
    ...forgeActionOverrides(options?.forgeActionDelegate),
    },
    forgeRead,
  );

  return {
    workOrderRepository,
    attemptRepository,
    executionJournal,
    executorForHost,
    workspace,
    runner,
    runnerForAttempt,
    agyRunner,
    runnerSelector,
    attemptArtifact,
    opencodeUsage,
    briefAuthoring,
    forgeAction,
  };
}
