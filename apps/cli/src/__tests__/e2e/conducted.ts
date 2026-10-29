/**
 * Lane Q1b: the conducted fixture on top of Q1a's `startE2eFixture()`. It adds
 * everything a real `conductor start` + `conductor run --live --once` pass
 * needs on the loopback lane host: a bare origin repo and its clone, a
 * registered project profile and approved work order, an accepted brief
 * request, a recording `ocm-run` wrapper and a fake `opencode` client on
 * PATH, and the CLI runtime wired with stub forge/review transports. The
 * fixture mutates only `process.env.PATH` (its two dirs removed on stop) and
 * everything stays inside its own disposable directory.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  parseInstallation,
  requireValidInstallationModel,
  writeInstallationV2,
} from '@fleet/installation';
import type { FleetInstallationV2 } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../../composition.js';
import { runCli } from '../../index.js';
import { buildLiveConductorDriver, type ConductorDriver } from '../../conductor-wiring.js';
import { resolveE2eDir, startE2eFixture, type E2eFixture } from './fixture.js';

/** [0-9A-HJKMNP-TV-Z]: the ULID charset minus I, L, O and U. */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WORK_ORDER_ID = 'wo-example-1';
const PROJECT_ID = 'project-example-1';
const TASK_ID = 'task-example-1';
const LANE_ID = 'lane-example-1';
const POLICY_REVISION = 'policy-example-1';
const SEAT_AGENT_DEFAULT = 'lane';
const REVIEWER_AGENT = 'reviewer';
const IMPLEMENTER_MODEL = 'example/implementer-model';
const REVIEWER_MODEL = 'example/reviewer-model';

export interface ConductedFixtureOptions {
  /** The agent recorded on the implementer seat (default 'lane'). */
  readonly seatAgent?: string;
  /** When set, the frozen model assignment names this agent instead. */
  readonly assignmentAgent?: string | null;
}

export interface CliRunResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface CapturedIo {
  readonly outLines: string[];
  readonly errLines: string[];
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ConductedFixture extends E2eFixture {
  /** The CLI runtime composed over the fixture's installation and state dir. */
  readonly runtime: FleetCliRuntime;
  /** The live conductor driver over the runtime (objects only until driven). */
  readonly driver: ConductorDriver;
  /** The seed commit's 40-hex sha. */
  readonly baseCommit: string;
  /** The clone on this machine (which IS the lane host). */
  readonly clonePath: string;
  /** The bare origin repository path. */
  readonly bareRepo: string;
  /** Where lane worktrees are prepared (also the lane host's worktreeRoot). */
  readonly worktreeRoot: string;
  /** The accepted brief-request JSON file path. */
  readonly briefRequestPath: string;
  /** The brief request object that was written to `briefRequestPath`. */
  readonly briefRequest: Record<string, unknown>;
  /** The fixed run id for this fixture. */
  readonly runId: string;
  /** The fixed attempt id for this fixture. */
  readonly attemptId: string;
  /** File the ocm-run wrapper appends its argv to, one line per call. */
  readonly ocmRunArgvLog: string;
  /** File the ocm-run wrapper appends its OCM_HOST/OCM_REMOTE_PORT env to. */
  readonly ocmRunEnvLog: string;
  /** File the fake opencode client appends its argv to, one line per run. */
  readonly fakeArgvFile: string;
  /** File listing the running fake opencode client pids. */
  readonly fakePidsFile: string;
  /** Captured CLI I/O shared by every command this fixture runs. */
  readonly io: CapturedIo;
  /** `conductor start --brief-request ...` through the CLI. */
  readonly start: (tier: 1 | 2) => Promise<CliRunResult>;
  /** One `conductor run --live --once` pass through the CLI (60 s abort). */
  readonly runPass: () => Promise<CliRunResult>;
  /** A runtime rebuilt over the current installation FILE (scenario 3). */
  readonly rebuildRuntime: () => Promise<FleetCliRuntime>;
  /** Kill the fake lanes, tear the tunnel and sshd down, restore PATH. */
  readonly stop: () => Promise<void>;
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

/**
 * Every fixture git command runs insulated from the real $HOME: no global
 * hooks (core.hooksPath=/dev/null), no signing (commit.gpgSign=false) and an
 * explicit example identity, so the fixture never picks up operator config.
 */
const GIT_SAFE_ARGS = [
  '-c', 'commit.gpgSign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'user.name=example',
  '-c', 'user.email=example@example.invalid',
];

/** git with a hard timeout: a hung fixture git call fails setup, not the test clock. */
function git(args: readonly string[], options?: { cwd?: string }): string {
  return String(execFileSync('git', [...GIT_SAFE_ARGS, ...args], {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    encoding: 'utf8',
    timeout: 20000,
  })).trim();
}

/** POSIX single-quote for generated shell wrappers. */
function sq(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Deterministic ULID-charset characters from one integer seed. */
function idChars(seed: number, count: number): string {
  const chars: string[] = [];
  let state = seed >>> 0;
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    chars.push(ID_ALPHABET[state % ID_ALPHABET.length]);
  }
  return chars.join('');
}

/** The conducted v2 installation: conductor on, two seats with agents, github forge. */
function buildConductedInstallation(
  fakePort: number,
  orchestratorWorktreeRoot: string,
  laneWorktreeRoot: string,
  seatAgent: string,
  laneAuthFile: string,
): FleetInstallationV2 {
  return {
    schemaVersion: 2,
    hosts: {
      'orchestrator-host': {
        transport: 'local',
        worktreeRoot: orchestratorWorktreeRoot,
        roles: ['orchestrator'],
      },
      'lane-host': {
        transport: 'ssh',
        sshAlias: 'fleet-e2e',
        worktreeRoot: laneWorktreeRoot,
        roles: ['lane-runner'],
        runner: {
          kind: 'opencode',
          port: fakePort,
          // The empty orchestrator-side auth file ocm-run sources INSTEAD of the
          // operator's $HOME/.config/opencode/server-auth.env: the real $HOME
          // never reaches ocm-run.
          authFile: laneAuthFile,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 1,
        },
      },
    },
    tools: ['opencode'],
    seats: [
      {
        id: 'implementer',
        tool: 'opencode',
        model: IMPLEMENTER_MODEL,
        agent: seatAgent,
        roles: ['implementer'],
        costClass: 'plan-quota',
      },
      {
        id: 'reviewer',
        tool: 'opencode',
        model: REVIEWER_MODEL,
        agent: REVIEWER_AGENT,
        roles: ['reviewer'],
        costClass: 'plan-quota',
      },
    ],
    chains: {
      implementer: [{ seatId: 'implementer' }],
      reviewer: [{ seatId: 'reviewer' }],
    },
    policy: { conductor: { enabled: true } },
    forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
    shelf: { provider: 'local' },
    verification: { procedures: { gate: { command: 'true', args: [] } } },
    waves: {
      baseUrl: 'https://waves.example',
      tokenFile: '/home/operator/.config/fleet/waves-token',
    },
    decisions: { provider: 'none' },
  };
}

/** The stub `gh` binary on PATH: every call prints the example PR URL. */
function ghStubScript(): string {
  return '#!/bin/sh\necho "https://github.com/example-owner/example-repo/pull/7"\n';
}

/**
 * The `ocm-run` wrapper: appends its argv and its OCM_HOST/OCM_REMOTE_PORT
 * env to recording logs, then execs the repository's real `bin/ocm-run`.
 */
function ocmRunWrapperScript(realOcmRunBin: string, argvLog: string, envLog: string): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${sq(argvLog)}`,
    `printf 'OCM_HOST=%s\\n' "\${OCM_HOST-}" >> ${sq(envLog)}`,
    `printf 'OCM_REMOTE_PORT=%s\\n' "\${OCM_REMOTE_PORT-}" >> ${sq(envLog)}`,
    `exec ${sq(realOcmRunBin)} "$@"`,
    '',
  ].join('\n');
}

/**
 * The fake `opencode` client on PATH: the runner environment is allow-listed
 * (FAKE_OPENCODE_* never survive into it), so this wrapper bakes the
 * fixture's env values in before exec'ing the shared fake script.
 */
function fakeOpencodeWrapperScript(
  fakeScript: string,
  pidsFile: string,
  argvFile: string,
): string {
  return [
    '#!/bin/sh',
    `FAKE_OPENCODE_PIDS_FILE=${sq(pidsFile)} \\`,
    'FAKE_OPENCODE_FLIP=1 \\',
    `FAKE_OPENCODE_ARGV_FILE=${sq(argvFile)} \\`,
    `exec ${sq(fakeScript)} "$@"`,
    '',
  ].join('\n');
}

/** A recording gh runner answering pulls, checks and graphql like PC-4's stub. */
function makeForgeGhRunner(head: () => string) {
  const calls: string[][] = [];
  const forgeGhRunner = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'checks') {
      return { exitCode: 0, stdout: '[{"bucket":"pass"}]', stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } },
        }),
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify([{ state: 'open', number: 7, head: { sha: head() } }]),
      stderr: '',
    };
  };
  return { calls, forgeGhRunner };
}

/** The fake review transport: exit 0, one step_start event, a VERDICT: PASS text part. */
const REVIEW_PASS_FIXTURE =
  '{"type":"step_start","part":{"type":"step-start"}}\n' +
  '{"type":"text","part":{"type":"text","text":"VERDICT: PASS\\n"}}';

function makeReviewSpawn() {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const reviewSpawn = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    return { exitCode: 0, stdout: REVIEW_PASS_FIXTURE, stderr: '' };
  };
  return { calls, reviewSpawn };
}

/**
 * The head of the fixture's first worktree, read with local git (this machine
 * IS the lane host). Falls back to the base commit while no worktree exists.
 */
function readWorktreeHead(worktreeRoot: string, fallback: string): string {
  try {
    const entries = readdirSync(worktreeRoot).filter((name) => !name.startsWith('.'));
    if (entries.length === 0) {
      return fallback;
    }
    return git(['-C', path.join(worktreeRoot, entries[0]), 'rev-parse', 'HEAD']);
  } catch {
    return fallback;
  }
}

export async function startConductedFixture(
  options?: ConductedFixtureOptions,
): Promise<ConductedFixture> {
  const seatAgent = options?.seatAgent ?? SEAT_AGENT_DEFAULT;
  const assignmentAgent = options?.assignmentAgent === undefined
    ? seatAgent
    : options.assignmentAgent;
  const e2eDir = resolveE2eDir();
  const repoRoot = path.dirname(path.dirname(e2eDir));
  const realOcmRunBin = path.join(repoRoot, 'bin', 'ocm-run');
  const fakeOpencodeScript = path.join(e2eDir, 'fake-opencode');

  const e2e = await startE2eFixture();
  const dir = e2e.dir;
  const pathbin = path.join(dir, 'pathbin');

  const ocmRunArgvLog = path.join(dir, 'ocm-run.argv.log');
  const ocmRunEnvLog = path.join(dir, 'ocm-run.env.log');
  const fakeArgvFile = path.join(dir, 'fake-opencode.argv.log');
  const fakePidsFile = path.join(dir, 'fake-opencode.pids');

  // PATH layering: prepend ONLY this fixture's two dirs; the real PATH stays
  // reachable. On stop we remove exactly those two entries from the CURRENT
  // value instead of restoring a snapshot: two fixtures alive at once each own
  // two dirs, and a snapshot restore would put the other fixture's
  // already-deleted dirs back on PATH whichever stop order runs.
  const ownedPathDirs = [pathbin, e2e.bin];
  const stripOwnPathDirs = (value: string): string => {
    const parts = value
      .split(':')
      .filter((entry) => entry !== '' && !ownedPathDirs.includes(entry));
    return parts.join(':');
  };
  process.env.PATH = `${pathbin}:${e2e.bin}:${process.env.PATH ?? ''}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      // 1) every running fake opencode client dies with the fixture.
      try {
        const pids = (await fs.readFile(fakePidsFile, 'utf8'))
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[0-9]+$/.test(line));
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGTERM');
          } catch {
            // Already gone: nothing to clean.
          }
        }
      } catch {
        // No pids file: no fake client ever started.
      }
      // 2) the ssh fixture stop now also ends the ssh -f -N tunnel.
      await e2e.stop();
    } finally {
      // 3) drop exactly our own two dirs from the current PATH: any stop order
      // leaves the other fixture's entries intact and no deleted dir behind.
      const currentPath = process.env.PATH;
      if (currentPath !== undefined) {
        const cleaned = stripOwnPathDirs(currentPath);
        if (cleaned === '') {
          delete process.env.PATH;
        } else {
          process.env.PATH = cleaned;
        }
      }
    }
  };

  try {
    // --- PATH tools -----------------------------------------------------
    await fs.mkdir(pathbin, { recursive: true });
    const writeTool = async (name: string, body: string): Promise<void> => {
      const target = path.join(pathbin, name);
      await fs.writeFile(target, body, 'utf8');
      await fs.chmod(target, 0o700);
    };
    await writeTool('gh', ghStubScript());
    await writeTool('ocm-run', ocmRunWrapperScript(realOcmRunBin, ocmRunArgvLog, ocmRunEnvLog));
    await writeTool(
      'opencode',
      fakeOpencodeWrapperScript(fakeOpencodeScript, fakePidsFile, fakeArgvFile),
    );

    // --- origin repo + clone --------------------------------------------
    const bareRepo = path.join(dir, 'origin.git');
    const clonePath = path.join(dir, 'clone');
    const worktreeRoot = path.join(dir, 'worktrees');
    await fs.mkdir(worktreeRoot, { recursive: true });
    git(['init', '--bare', '--initial-branch=main', bareRepo]);
    git(['clone', bareRepo, clonePath]);
    git(['config', 'user.email', 'fixture@example.com'], { cwd: clonePath });
    git(['config', 'user.name', 'Fixture'], { cwd: clonePath });
    await fs.writeFile(path.join(clonePath, '.gitignore'), '.lane/\n', 'utf8');
    await fs.mkdir(path.join(clonePath, 'packages', 'example'), { recursive: true });
    await fs.writeFile(
      path.join(clonePath, 'packages', 'example', 'README.md'),
      '# example\n\nThe lane work order owns this package.\n',
      'utf8',
    );
    git(['add', '-A'], { cwd: clonePath });
    git(['commit', '-m', 'example seed commit'], { cwd: clonePath });
    git(['push', 'origin', 'main'], { cwd: clonePath });
    const baseCommit = git(['rev-parse', 'HEAD'], { cwd: clonePath });

    // --- installation ----------------------------------------------------
    // The lane host's authFile is an empty file ocm-run sources instead of the
    // real $HOME/.config/opencode/server-auth.env.
    const laneAuthFile = path.join(dir, 'opencode-auth.env');
    await fs.writeFile(laneAuthFile, '', 'utf8');
    const installation = buildConductedInstallation(
      Number(new URL(e2e.fakeOpencodeUrl).port),
      path.join(dir, 'orchestrator-worktrees'),
      worktreeRoot,
      seatAgent,
      laneAuthFile,
    );
    const written = writeInstallationV2(installation);
    const parsed = parseInstallation(JSON.parse(written));
    if (!parsed.ok) {
      throw new Error(`conducted fixture installation must parse: ${parsed.errors.join('; ')}`);
    }
    await fs.writeFile(
      path.join(e2e.stateDir, 'installation', 'fleet.json'),
      written,
      'utf8',
    );

    // --- runtime ----------------------------------------------------------
    const gh = makeForgeGhRunner(() => readWorktreeHead(worktreeRoot, baseCommit));
    const review = makeReviewSpawn();
    const buildRuntime = (installationForRuntime: FleetInstallationV2): FleetCliRuntime => {
      return createFleetCliRuntime({
        stateDir: e2e.stateDir,
        installation: installationForRuntime,
        loadInstallationForAutoMerge: () => ({
          status: 'loaded' as const,
          file: path.join(e2e.stateDir, 'installation', 'fleet.json'),
          installation: installationForRuntime,
          model: requireValidInstallationModel(installationForRuntime),
          warnings: [],
        }),
        ocmRunBin: path.join(pathbin, 'ocm-run'),
        forgeGhRunner: gh.forgeGhRunner,
        ghBinaryCandidates: [path.join(pathbin, 'gh')],
        forgeActionDelegate: {
          verifyCurrentHeadSha: async () => readWorktreeHead(worktreeRoot, baseCommit),
        },
        reviewSpawn: review.reviewSpawn,
      });
    };
    const runtime = buildRuntime(installation);
    // `runtime` stays readable as the CURRENT runtime: scenario 3 swaps it
    // through rebuildRuntime() without touching the returned fixture shape.
    let currentRuntime: FleetCliRuntime = runtime;

    // --- project profile + work order ------------------------------------
    const profileResult = await runtime.coordination.registerProjectProfile.execute({
      projectId: PROJECT_ID,
      displayName: 'Example Project',
      repository: bareRepo,
      designatedDispatcherHost: 'orchestrator-host',
      policyRevision: POLICY_REVISION,
      maxConcurrentLanes: 1,
      runnerCapabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        filesystemScope: 'scoped-worktree',
      },
      clones: { 'lane-host': { path: clonePath, worktreeRoot } },
    });
    if (profileResult.outcome !== 'registered') {
      throw new Error(`profile registration refused: ${JSON.stringify(profileResult)}`);
    }
    const workOrderResult = await runtime.execution.registerWorkOrder.execute({
      workOrderId: WORK_ORDER_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      laneId: LANE_ID,
      repository: bareRepo,
      baseCommit,
      policyRevision: POLICY_REVISION,
      ownedPaths: ['packages/example'],
    });
    if (workOrderResult.outcome !== 'registered') {
      throw new Error(`work order registration refused: ${JSON.stringify(workOrderResult)}`);
    }

    // --- brief request ----------------------------------------------------
    const briefPath = path.join(dir, 'brief.md');
    await fs.writeFile(
      briefPath,
      [
        '# Example lane brief',
        '',
        'Read and follow this brief. Work only inside packages/example.',
        'Run the acceptance commands, commit your work, and stop.',
        '',
      ].join('\n'),
      'utf8',
    );
    const briefRequest: Record<string, unknown> = {
      workOrderId: WORK_ORDER_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      laneId: LANE_ID,
      repository: bareRepo,
      baseCommit,
      policyRevision: POLICY_REVISION,
      modelAssignment: {
        model: IMPLEMENTER_MODEL,
        variant: 'default',
        fallbackModel: null,
        seatTool: 'opencode',
        agent: assignmentAgent,
      },
      seatPlan: {
        version: 1,
        'first-pass': [
          { id: 'fp-1', model: IMPLEMENTER_MODEL, tool: 'opencode', agent: seatAgent },
        ],
        fix: [
          { id: 'fx-1', model: IMPLEMENTER_MODEL, tool: 'opencode', agent: seatAgent },
        ],
        review: [
          { id: 'rv-1', model: REVIEWER_MODEL, tool: 'opencode', agent: REVIEWER_AGENT },
        ],
      },
      independentReviewer: REVIEWER_MODEL,
      ownedPaths: ['packages/example'],
      allowedPathPrefixes: ['packages/example'],
      permissions: [],
      acceptanceChecks: ['typecheck'],
      acceptanceSpec: {
        commitRequired: true,
        diffCheck: true,
        commands: [{ argv: ['true'] }],
      },
      stepLimit: 10,
      timeLimitSeconds: 300,
      resourceBounds: {},
      expectedArtifacts: [],
      ownerDecisionReferences: [],
      contextDecisions: [],
      handWrittenBriefPath: briefPath,
      prNotes: {
        hardToUndo: 'Only the example package is touched; revert the lane branch.',
        assumptions: 'The example package builds with the repository toolchain.',
        challengeThis: 'Flag any acceptance command that cannot run in the lane.',
      },
    };
    const briefRequestPath = path.join(dir, 'brief-request.json');
    await fs.writeFile(briefRequestPath, JSON.stringify(briefRequest, null, 2), 'utf8');

    // --- ids ---------------------------------------------------------------
    const runId = 'run-0' + idChars(20261029, 25);
    const attemptId = 'attempt-' + idChars(97202610, 26);

    const io = captureIo();
    /** Returns stdout AND stderr both captured BEFORE the buffers clear. */
    const takeOutput = (): { stdout: string[]; stderr: string[] } => {
      const stdout = [...io.outLines];
      const stderr = [...io.errLines];
      io.outLines.length = 0;
      io.errLines.length = 0;
      return { stdout, stderr };
    };

    const start = async (tier: 1 | 2): Promise<CliRunResult> => {
      const code = await runCli(
        ['conductor', 'start', '--brief-request', briefRequestPath, '--tier', String(tier),
          '--run-id', runId, '--attempt-id', attemptId],
        io,
        currentRuntime,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { stateDir: e2e.stateDir },
      );
      return { code, ...takeOutput() };
    };

    const runPass = async (): Promise<CliRunResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const code = await runCli(
          ['conductor', 'run', '--live', '--once'],
          io,
          currentRuntime,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            stateDir: e2e.stateDir,
            stopSignal: controller.signal,
          },
        );
        return { code, ...takeOutput() };
      } finally {
        clearTimeout(timer);
      }
    };

    const rebuildRuntime = async (): Promise<FleetCliRuntime> => {
      // Re-read the installation FILE: scenario 3 rewrites it with the lane
      // host renamed and rebuilds the runtime over the changed file.
      const raw = JSON.parse(
        await fs.readFile(path.join(e2e.stateDir, 'installation', 'fleet.json'), 'utf8'),
      );
      const reparsed = parseInstallation(raw);
      if (!reparsed.ok) {
        throw new Error(`rewritten installation must parse: ${reparsed.errors.join('; ')}`);
      }
      currentRuntime = buildRuntime(raw as FleetInstallationV2);
      return currentRuntime;
    };

    return {
      ...e2e,
      get runtime() {
        return currentRuntime;
      },
      // A getter so a renamed-host fixture drives the rebuilt runtime: the
      // driver is rebuilt over the CURRENT runtime on every access.
      get driver() {
        return buildLiveConductorDriver(currentRuntime, { maxActiveRuns: 1 });
      },
      baseCommit,
      clonePath,
      bareRepo,
      worktreeRoot,
      briefRequestPath,
      briefRequest,
      runId,
      attemptId,
      ocmRunArgvLog,
      ocmRunEnvLog,
      fakeArgvFile,
      fakePidsFile,
      io,
      start,
      runPass,
      rebuildRuntime,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
