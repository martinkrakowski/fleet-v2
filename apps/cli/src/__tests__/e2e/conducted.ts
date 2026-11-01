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

import { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';
import type { VerificationReceiptRecord } from '@fleet/evidence-and-acceptance';

import { createFleetCliRuntime, type FleetCliRuntime } from '../../composition.js';
import { runCli } from '../../index.js';
import { buildLiveConductorDriver, type ConductorDriver } from '../../conductor-wiring.js';
import { resolveE2eDir, startE2eFixture, type E2eFixture } from './fixture.js';

/** [0-9A-HJKMNP-TV-Z]: the ULID charset minus I, L, O and U. */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const WORK_ORDER_ID = 'wo-example-1';
const WORK_ORDER_ID2 = 'wo-example-2';
const PROJECT_ID = 'project-example-1';
const TASK_ID = 'task-example-1';
const TASK_ID2 = 'task-example-2';
const LANE_ID = 'lane-example-1';
const LANE_ID2 = 'lane-example-2';
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
  /**
   * Q1c: when true the fake lane runs a fixture-written script that appends a
   * line to `packages/example/README.md`, commits it, and then ends the
   * session, so a conducted run collects, gates and reviews a real commit.
   */
  readonly committingLane?: boolean;
  /**
   * Q1c: the verdicts the fake review transport answers with, consumed in
   * order (one per review); past the list every review passes.
   */
  readonly reviewVerdicts?: readonly ('PASS' | 'FAIL')[];
  /**
   * E2E-FIX: when set, the frozen seat plan's `fix` seat uses this model
   * (its id `fx-1`, tool and agent stay unchanged). Default: the implementer
   * model.
   */
  readonly fixModel?: string;
  /**
   * E2E-FIX: a directory NAME resolved against the fixture's own disposable
   * directory. When set, the committing lane script also copies the session's
   * `.lane/brief.md` into that directory on every dispatched session, one
   * uniquely named file per session, so a test can read the brief the lane
   * actually received.
   */
  readonly captureBriefs?: string;
  /**
   * KF-34b2: when true the fixture registers a second work order
   * (`wo-example-2`, owning `packages/second`) and a second brief request, and
   * raises the lane host's `maxLanes` and the profile's
   * `maxConcurrentLanes` to 2. Default: false — today's single-run shape.
   */
  readonly secondRun?: boolean;
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
  /** KF-34b2: the second fixed run id, present only with `secondRun`. */
  readonly runId2?: string;
  /** KF-34b2: the second fixed attempt id, present only with `secondRun`. */
  readonly attemptId2?: string;
  /** KF-34b2: the second accepted brief-request JSON file path, present only with `secondRun`. */
  readonly briefRequestPath2?: string;
  /** File the ocm-run wrapper appends its argv to, one line per call. */
  readonly ocmRunArgvLog: string;
  /** ocm-run's stderr and exit codes, one block per call, for diagnosing a dispatch that went unknown. */
  readonly ocmRunStderrLog: string;
  /** File the ocm-run wrapper appends its OCM_HOST/OCM_REMOTE_PORT env to. */
  readonly ocmRunEnvLog: string;
  /** File the fake opencode client appends its argv to, one line per run. */
  readonly fakeArgvFile: string;
  /** File listing the running fake opencode client pids. */
  readonly fakePidsFile: string;
  /** File the `gh` stub on PATH appends its argv to, one line per call. */
  readonly ghArgvLog: string;
  /** KS7a-2: the PATH dir holding the `gh` stub, for status reads through the stub. */
  readonly ghPathBin: string;
  /** Captured CLI I/O shared by every command this fixture runs. */
  readonly io: CapturedIo;
  /** `conductor start --brief-request ...` through the CLI. */
  readonly start: (tier: 1 | 2, extraArgs?: readonly string[]) => Promise<CliRunResult>;
  /**
   * KF-34b2: `conductor start` for the second run through the CLI, mirroring
   * `start` over the second brief request. Present only with `secondRun`.
   */
  readonly startSecond?: (tier: 1 | 2, extraArgs?: readonly string[]) => Promise<CliRunResult>;
  /** One `conductor run --live --once` pass through the CLI (60 s abort). */
  readonly runPass: (extraArgs?: readonly string[]) => Promise<CliRunResult>;
  /**
   * Q1c: record one completed passing verification receipt per
   * `acceptanceChecks` name at the latest attempt's collected head through
   * the runtime's record-verification-receipt port. Idempotent; answers
   * false while the collected head or the review-opened assessment is not
   * there yet, so a caller retries on the next pass; true once recorded.
   */
  readonly recordAcceptanceReceipts: () => Promise<boolean>;
  /**
   * Q1c: make the next fix-brief placement fail — chmod 0444 on the latest
   * attempt's `.lane/brief.md` so the placement's `tee` fails on the host.
   * `stop()` restores the mode.
   */
  readonly makeFixPlacementFail: () => Promise<void>;
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
  maxLanes: number,
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
          maxLanes,
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

/** The stub `gh` binary on PATH: records one flattened argv line per call, then prints the example PR URL. */
function ghStubScript(argvLog: string, statusDir: string): string {
  return [
    '#!/bin/sh',
    // One line per call: a `--body` carries newlines, so the ARGUMENTS are
    // flattened and exactly one line terminator is written per call.
    `printf '%s' "$*" | tr '\\n' ' ' >> ${sq(argvLog)}`,
    `printf '\\n' >> ${sq(argvLog)}`,
    // KS7a-2: a commit-status POST (`gh api -X POST .../statuses/<sha> -f
    // state=<state> -f context=premerge ...`) is accepted: the posted state
    // is recorded per head sha and the call exits 0 without the PR-create
    // URL. A later status read of that sha reports the last posted state, so
    // a status read answers what was actually posted.
    'sha=',
    'state=',
    'gh_form=list',
    'for gh_arg in "$@"; do',
    '  case "$gh_arg" in',
    '    */commits/*) gh_commits=${gh_arg#*/commits/}; sha=${gh_commits%/status}; gh_form=obj ;;',
    '    */statuses/*) sha=${gh_arg#*/statuses/} ;;',
    '    state=*) state=${gh_arg#state=} ;;',
    '  esac',
    'done',
    'case " $* " in',
    '  *" -X POST "*)',
    '    if [ -n "$sha" ] && [ -n "$state" ]; then',
    `      printf '%s\\n' "$state" >> ${sq(statusDir)}/status."$sha"`,
    '    fi',
    '    exit 0',
    '    ;;',
    'esac',
    `if [ -n "$sha" ] && [ -f ${sq(statusDir)}/status."$sha" ]; then`,
    `  gh_posted=$(tail -n 1 ${sq(statusDir)}/status."$sha")`,
    '  if [ "$gh_form" = obj ]; then',
    `    printf '{"state":"%s","statuses":[{"state":"%s","context":"premerge"}]}\\n' "$gh_posted" "$gh_posted"`,
    '  else',
    `    printf '[{"state":"%s","context":"premerge"}]\\n' "$gh_posted"`,
    '  fi',
    '  exit 0',
    'fi',
    'echo "https://github.com/example-owner/example-repo/pull/7"',
    '',
  ].join('\n');
}

/**
 * The committing lane script (Q1c): appends one line to the owned README and
 * commits it as the lane, then holds the session busy for a moment so
 * `ocm-run --detach`'s visibility poll still sees it before the client ends
 * the session.
 */
function laneCommitScript(captureBriefsDir?: string): string {
  return [
    '#!/bin/sh',
    'printf "\\nA lane edit for this run.\\n" >> packages/example/README.md',
    'git -c user.name=example -c user.email=example@example.invalid commit -am "lane: append an example line" >/dev/null',
    // E2E-FIX: capture the brief this session actually received. A unique
    // mktemp target keeps one file per session even if two sessions overlap.
    ...(captureBriefsDir === undefined
      ? []
      : [
          `if [ -f .lane/brief.md ] && captured=$(mktemp ${sq(captureBriefsDir)}/brief-XXXXXX); then`,
          '  cp .lane/brief.md "$captured"',
          'fi',
        ]),
    'sleep 2',
    '',
  ].join('\n');
}

/**
 * The `ocm-run` wrapper: appends its argv and its OCM_HOST/OCM_REMOTE_PORT
 * env to recording logs, then execs the repository's real `bin/ocm-run`.
 */
/** How long teardown waits for the fake clients to exit after TERM. */
const FAKE_CLIENT_EXIT_WAIT_MS = 3000;

/** Resolves once no listed pid answers a signal-0 probe, or the deadline passes. */
async function waitForPidsToExit(pids: readonly number[], deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (pids.some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function ocmRunWrapperScript(realOcmRunBin: string, argvLog: string, envLog: string, stderrLog: string): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${sq(argvLog)}`,
    `printf 'OCM_HOST=%s\\n' "\${OCM_HOST-}" >> ${sq(envLog)}`,
    `printf 'OCM_REMOTE_PORT=%s\\n' "\${OCM_REMOTE_PORT-}" >> ${sq(envLog)}`,
    // stderr is copied into the log AND still reaches the caller (production code
    // classifies failures by it); the child's own exit code is kept through the
    // pipe by way of a per-call file, since POSIX sh has no pipefail.
    `rcf=$(mktemp "\${TMPDIR:-/tmp}/ocm-run-rc.XXXXXX") || exit 1`,
    `{ { ${sq(realOcmRunBin)} "$@" 2>&1 1>&3 3>&-; echo "$?" > "$rcf"; } | tee -a ${sq(stderrLog)} >&2; } 3>&1`,
    'rc=$(cat "$rcf"); rm -f "$rcf"',
    `printf 'exit=%s argv=%s\\n' "$rc" "$*" >> ${sq(stderrLog)}`,
    'exit "$rc"',
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
  lane?: { readonly scriptPath: string },
): string {
  return [
    '#!/bin/sh',
    `FAKE_OPENCODE_PIDS_FILE=${sq(pidsFile)} \\`,
    'FAKE_OPENCODE_FLIP=1 \\',
    `FAKE_OPENCODE_ARGV_FILE=${sq(argvFile)} \\`,
    ...(lane === undefined
      ? []
      : [
          `FAKE_OPENCODE_LANE_SCRIPT=${sq(lane.scriptPath)} \\`,
          'FAKE_OPENCODE_END=1 \\',
        ]),
    `exec ${sq(fakeScript)} "$@"`,
    '',
  ].join('\n');
}

/**
 * A recording gh runner answering every read the conductor's forge ports make
 * (PC-4's stub plus the `pr view` snapshot and the compare read): an open PR
 * number 7 at the worktree head whose merge state is clean, CI buckets that
 * pass, and zero unresolved review threads.
 */
function makeForgeGhRunner(head: () => string, branchName: string) {
  const calls: string[][] = [];
  const forgeGhRunner = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 7,
          state: 'OPEN',
          headRefOid: head(),
          headRefName: branchName,
          baseRefName: 'main',
          mergedAt: null,
          closedAt: null,
          mergeCommit: null,
          mergeStateStatus: 'CLEAN',
        }),
        stderr: '',
      };
    }
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
    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].endsWith('/pulls')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ state: 'open', number: 7, head: { sha: head() } }]),
        stderr: '',
      };
    }
    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].includes('/compare/')) {
      return { exitCode: 0, stdout: JSON.stringify({ status: 'diverged' }), stderr: '' };
    }
    return { exitCode: 0, stdout: '[]', stderr: '' };
  };
  return { calls, forgeGhRunner };
}

/** The fake review transport: exit 0, one step_start event, then the verdict text part. */
const REVIEW_STEP_START_LINE = '{"type":"step_start","part":{"type":"step-start"}}';
const REVIEW_PASS_TEXT = 'VERDICT: PASS\n';
/** A FAIL carries one finding line before its verdict, so the verdict is never `unknown`. */
const REVIEW_FAIL_TEXT = 'FINDING: blocker packages/example/README.md:1 example\nVERDICT: FAIL\n';

function makeReviewSpawn(verdicts: readonly ('PASS' | 'FAIL')[]) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let index = 0;
  const reviewSpawn = async (file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const verdict = verdicts[index] ?? 'PASS';
    index += 1;
    const text = verdict === 'FAIL' ? REVIEW_FAIL_TEXT : REVIEW_PASS_TEXT;
    return {
      exitCode: 0,
      stdout:
        REVIEW_STEP_START_LINE + '\n' +
        JSON.stringify({ type: 'text', part: { type: 'text', text } }),
      stderr: '',
    };
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
  const ocmRunStderrLog = path.join(dir, 'ocm-run.stderr.log');
  const ocmRunEnvLog = path.join(dir, 'ocm-run.env.log');
  const fakeArgvFile = path.join(dir, 'fake-opencode.argv.log');
  const fakePidsFile = path.join(dir, 'fake-opencode.pids');
  const ghArgvLog = path.join(dir, 'gh.argv.log');
  // KS7a-2: the `gh` stub records posted commit-status states here, one file
  // per head sha, and answers status reads of that sha from them.
  const ghStatusDir = path.join(dir, 'gh-status');
  const laneScriptPath = path.join(dir, 'lane-commit.sh');

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
  // The `.lane/brief.md` a fix-placement failure made read-only (Q1c), restored on stop.
  let failedBriefPath: string | null = null;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    // 0) a fix-placement chmod is restored even when the test failed.
    if (failedBriefPath !== null) {
      try {
        await fs.chmod(failedBriefPath, 0o644);
      } catch {
        // Already gone: nothing to restore.
      }
      failedBriefPath = null;
    }
    try {
      // 1) every running fake opencode client dies with the fixture: TERM to
      //    each recorded pid (the client forwards it to its own child), then
      //    wait for them to be gone before the directories go away.
      let pids: number[] = [];
      try {
        pids = (await fs.readFile(fakePidsFile, 'utf8'))
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[0-9]+$/.test(line))
          .map(Number);
      } catch {
        // No pids file: no fake client ever started.
      }
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // Already gone: nothing to clean.
        }
      }
      await waitForPidsToExit(pids, FAKE_CLIENT_EXIT_WAIT_MS);
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
    await fs.mkdir(ghStatusDir, { recursive: true });
    const writeTool = async (name: string, body: string): Promise<void> => {
      const target = path.join(pathbin, name);
      await fs.writeFile(target, body, 'utf8');
      await fs.chmod(target, 0o700);
    };
    await writeTool('gh', ghStubScript(ghArgvLog, ghStatusDir));
    await writeTool('ocm-run', ocmRunWrapperScript(realOcmRunBin, ocmRunArgvLog, ocmRunEnvLog, ocmRunStderrLog));
    if (options?.committingLane === true) {
      // E2E-FIX: the brief-capture directory is created before any lane runs,
      // so the script's mktemp never fails on a missing parent.
      const briefCaptureDir = options?.captureBriefs === undefined
        ? undefined
        : path.join(dir, options.captureBriefs);
      if (briefCaptureDir !== undefined) {
        await fs.mkdir(briefCaptureDir, { recursive: true });
      }
      await fs.writeFile(laneScriptPath, laneCommitScript(briefCaptureDir), 'utf8');
      await fs.chmod(laneScriptPath, 0o700);
    }
    await writeTool(
      'opencode',
      fakeOpencodeWrapperScript(
        fakeOpencodeScript,
        fakePidsFile,
        fakeArgvFile,
        options?.committingLane === true ? { scriptPath: laneScriptPath } : undefined,
      ),
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
    if (options?.secondRun === true) {
      // KF-34b2: a second, distinct package for the second work order. The
      // name is not a prefix of `packages/example` — admission refuses
      // overlapping owned paths.
      await fs.mkdir(path.join(clonePath, 'packages', 'second'), { recursive: true });
      await fs.writeFile(
        path.join(clonePath, 'packages', 'second', 'README.md'),
        '# second\n\nThe second lane work order owns this package.\n',
        'utf8',
      );
    }
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
      options?.secondRun === true ? 2 : 1,
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

    // --- ids (before the runtime: the forge stub names the run's branch) ---
    const runId = 'run-0' + idChars(20261029, 25);
    const attemptId = 'attempt-' + idChars(97202610, 26);
    const runId2 = 'run-0' + idChars(20261030, 25);
    const attemptId2 = 'attempt-' + idChars(97202611, 26);

    // --- runtime ----------------------------------------------------------
    const gh = makeForgeGhRunner(() => readWorktreeHead(worktreeRoot, baseCommit), `fleet/${runId}`);
    const review = makeReviewSpawn(options?.reviewVerdicts ?? []);
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
      maxConcurrentLanes: options?.secondRun === true ? 2 : 1,
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
    if (options?.secondRun === true) {
      const workOrderResult2 = await runtime.execution.registerWorkOrder.execute({
        workOrderId: WORK_ORDER_ID2,
        projectId: PROJECT_ID,
        taskId: TASK_ID2,
        laneId: LANE_ID2,
        repository: bareRepo,
        baseCommit,
        policyRevision: POLICY_REVISION,
        ownedPaths: ['packages/second'],
      });
      if (workOrderResult2.outcome !== 'registered') {
        throw new Error(`second work order registration refused: ${JSON.stringify(workOrderResult2)}`);
      }
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
          {
            id: 'fx-1',
            model: options?.fixModel ?? IMPLEMENTER_MODEL,
            tool: 'opencode',
            agent: seatAgent,
          },
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

    // --- KF-34b2: the second brief request (same shape, packages/second) ---
    const briefPath2 = path.join(dir, 'brief-2.md');
    const briefRequest2: Record<string, unknown> = {
      ...briefRequest,
      workOrderId: WORK_ORDER_ID2,
      taskId: TASK_ID2,
      laneId: LANE_ID2,
      ownedPaths: ['packages/second'],
      allowedPathPrefixes: ['packages/second'],
      handWrittenBriefPath: briefPath2,
      prNotes: {
        hardToUndo: 'Only the second package is touched; revert the lane branch.',
        assumptions: 'The second package builds with the repository toolchain.',
        challengeThis: 'Flag any acceptance command that cannot run in the lane.',
      },
    };
    const briefRequestPath2 = path.join(dir, 'brief-request-2.json');
    if (options?.secondRun === true) {
      await fs.writeFile(
        briefPath2,
        [
          '# Second lane brief',
          '',
          'Read and follow this brief. Work only inside packages/second.',
          'Run the acceptance commands, commit your work, and stop.',
          '',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(briefRequestPath2, JSON.stringify(briefRequest2, null, 2), 'utf8');
    }

    const io = captureIo();
    /** Returns stdout AND stderr both captured BEFORE the buffers clear. */
    const takeOutput = (): { stdout: string[]; stderr: string[] } => {
      const stdout = [...io.outLines];
      const stderr = [...io.errLines];
      io.outLines.length = 0;
      io.errLines.length = 0;
      return { stdout, stderr };
    };

    const start = async (tier: 1 | 2, extraArgs: readonly string[] = []): Promise<CliRunResult> => {
      const code = await runCli(
        ['conductor', 'start', '--brief-request', briefRequestPath, '--tier', String(tier),
          '--run-id', runId, '--attempt-id', attemptId, ...extraArgs],
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

    const startSecond = async (tier: 1 | 2, extraArgs: readonly string[] = []): Promise<CliRunResult> => {
      const code = await runCli(
        ['conductor', 'start', '--brief-request', briefRequestPath2, '--tier', String(tier),
          '--run-id', runId2, '--attempt-id', attemptId2, ...extraArgs],
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

    const runPass = async (extraArgs: readonly string[] = []): Promise<CliRunResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const code = await runCli(
          ['conductor', 'run', '--live', '--once', ...extraArgs],
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

    // --- Q1c levers ---------------------------------------------------------
    const latestAttemptOf = async () => {
      const run = await currentRuntime.conductor.laneRunRepository.get(runId);
      if (run === null) {
        return null;
      }
      const latestId = run.attemptIds[run.attemptIds.length - 1];
      if (latestId === undefined) {
        return null;
      }
      const attempt = await currentRuntime.execution.attemptRepository.findAttemptById(latestId);
      if (attempt === null) {
        return null;
      }
      return { run, attempt };
    };

    const recordAcceptanceReceipts = async (): Promise<boolean> => {
      const found = await latestAttemptOf();
      if (found === null || found.attempt.artifacts === null) {
        return false;
      }
      const assessmentId = assessmentIdForAttempt(found.attempt.id);
      // The assessment is opened by the run's first review; before that the
      // receipts have nowhere to land, so the caller retries on the next pass.
      const assessment = await currentRuntime.evidence.evidenceAssessmentRepository
        .findAssessmentById(assessmentId);
      if (assessment === null) {
        return false;
      }
      const checks = briefRequest.acceptanceChecks as readonly string[];
      let recorded = true;
      for (const name of checks) {
        const receipt: VerificationReceiptRecord = {
          id: `verif-${assessmentId}-${name}`,
          assessmentId,
          projectId: PROJECT_ID,
          attemptId: found.attempt.id,
          candidateHeadSha: found.attempt.artifacts.headCommit,
          hostId: 'lane-host',
          procedureName: name,
          result: 'pass',
          exitCode: 0,
          evidenceRef: `fixture://verification/${name}`,
          policyRevision: found.run.runPolicyRevision,
          completedAtIso: new Date().toISOString(),
        };
        const result = await currentRuntime.evidence.recordVerificationReceipt
          .recordVerificationReceipt({ assessmentId, receipt });
        if (result.outcome !== 'recorded') {
          recorded = false;
        }
      }
      return recorded;
    };

    const makeFixPlacementFail = async (): Promise<void> => {
      const found = await latestAttemptOf();
      if (found === null) {
        throw new Error('makeFixPlacementFail needs the run and its latest attempt');
      }
      const briefPath = path.join(found.attempt.worktreePath, '.lane', 'brief.md');
      await fs.chmod(briefPath, 0o444);
      failedBriefPath = briefPath;
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
      ...(options?.secondRun === true
        ? { runId2, attemptId2, briefRequestPath2, startSecond }
        : {}),
      ocmRunArgvLog,
      ocmRunStderrLog,
      ocmRunEnvLog,
      fakeArgvFile,
      fakePidsFile,
      ghArgvLog,
      // KS7a-2: the PATH dir holding the `gh` stub, so a scenario can run a
      // status read through the stub itself.
      ghPathBin: pathbin,
      io,
      start,
      runPass,
      recordAcceptanceReceipts,
      makeFixPlacementFail,
      rebuildRuntime,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
