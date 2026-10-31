/**
 * The probe-plan step of the shared onboarding engine (plan section 5): a
 * pure, ordered list of the observations one host needs, and the runner that
 * executes that list through the doctor engine's argv executor.
 *
 * Every step is an argv array, never a shell string, and every remote step
 * travels as `ssh -o BatchMode=yes -o ConnectTimeout=N <alias> -- …` with the
 * alias checked against the strict safe-host rule before any step is built.
 * The opencode server is asked on the host's own loopback through that ssh
 * call, never through a local forward, so a probe leaves no tunnel open and
 * no other host's server can answer.
 *
 * Two steps need more than one command and are expressed as their own kinds:
 * the worktree-root check creates one path with
 * `mktemp <root>/.fleet-probe.XXXXXX` — the template form, which works with
 * both GNU and BSD mktemp where `mktemp -p <root>` does not — and removes
 * exactly that path with `rm`, and the auth-file check compares the file's
 * owner against the orchestrator's own user id. Both run their commands as
 * argv arrays too; nothing is ever interpolated into a shell.
 *
 * Every produced detail carries paths, modes, versions and reasons only, and
 * is bounded and redacted exactly as the doctor engine bounds its own lines.
 */

import type {
  HostTransport,
  RunnerCapabilityDeclaration,
} from '@fleet/installation';
import { BUILT_IN_TOOLS } from '@fleet/tooling';

import { boundDoctorDetail } from '../doctor/run-doctor.js';
import type {
  DoctorCommandExecutor,
  DoctorCommandRunResult,
} from '../doctor/probes-node.js';
import type { DoctorLine, DoctorScope, DoctorStatus } from '../doctor/types.js';

import { isSafeSshHost, type HostDraft } from './draft.js';

/**
 * The argv executor host probes run through: the same structural shape the
 * doctor probes use, so `createNodeDoctorExecutor()` and every fake executor
 * built for doctor work here unchanged.
 */
export type HostProbeExecutor = DoctorCommandExecutor;

/** Connect budget for every ssh step, matching the doctor probes. */
const SSH_CONNECT_TIMEOUT_S = 10;

/** Wall-clock budget of one platform probe command. */
const PROBE_TIMEOUT_MS = 10_000;

/** Wall-clock budget of the loopback server probe. */
const SERVER_TIMEOUT_MS = 10_000;

/** The runner kinds a v2 host may declare. */
export type HostRunnerKind = 'opencode' | 'agy';

/** The runner one host probes, as the file describes it. */
export interface HostProbeRunner {
  readonly kind: HostRunnerKind;
  /** The server's port on its own host. */
  readonly port: number;
  /** Absolute path of the auth file on the orchestrator. */
  readonly authFile?: string;
  readonly capabilities?: RunnerCapabilityDeclaration;
  /** The host-wide gate-slot throttle the runner declares (KF-30b), if any. */
  readonly gateSlot?: { readonly path: string; readonly slots: number };
}

/** Everything the plan needs to know about one host. */
export interface HostProbeSpec {
  /** The installation host name, the subject of every host-scoped line. */
  readonly name: string;
  readonly transport: HostTransport;
  readonly sshAlias?: string;
  readonly worktreeRoot: string;
  readonly tmpDir?: string;
  readonly runner?: HostProbeRunner;
  /**
   * True when the host holds the `lane-runner` role (KF-30b): only a
   * lane-runner host's conducted acceptance gates are subject to the
   * gate-slot throttle, so only such a host can warn about running
   * unthrottled. Absent means it does not.
   */
  readonly isLaneRunner?: boolean;
  /**
   * The lane-runner host's worktree root, supplied when this host is a
   * verifier: verification relies on the verifier being able to see it.
   * Absent for every other host, and then no visibility step is planned.
   */
  readonly laneRunnerWorktreeRoot?: {
    readonly hostName: string;
    readonly worktreeRoot: string;
  };
}

/** The probe-plan inputs of a drafted host. */
export function hostProbeSpecFromDraft(draft: HostDraft): HostProbeSpec {
  const runner = draft.host.runner;
  return {
    name: draft.name,
    transport: draft.host.transport,
    ...(draft.host.sshAlias !== undefined
      ? { sshAlias: draft.host.sshAlias }
      : {}),
    worktreeRoot: draft.host.worktreeRoot,
    ...(draft.host.tmpDir !== undefined ? { tmpDir: draft.host.tmpDir } : {}),
    ...(draft.host.roles.includes('lane-runner') ? { isLaneRunner: true } : {}),
    ...(runner === undefined
      ? {}
      : {
          runner: {
            kind: runner.kind,
            port: runner.port,
            ...(runner.authFile !== undefined
              ? { authFile: runner.authFile }
              : {}),
            ...(runner.capabilities !== undefined
              ? { capabilities: runner.capabilities }
              : {}),
            ...(runner.gateSlot !== undefined ? { gateSlot: runner.gateSlot } : {}),
          },
        }),
  };
}

/** How a successful run is reported; picks the wording of its detail. */
export type HostProbeOutcome = 'reachable' | 'version' | 'server' | 'directory';

/** What every step reports on and under which check name. */
interface HostProbeStepBase {
  readonly scope: DoctorScope;
  readonly subject: string;
  readonly check: string;
}

/** One planned observation of a host. */
export type HostProbeStep =
  | (HostProbeStepBase & {
      readonly kind: 'run';
      /** What the command checks, named in the detail; never its output. */
      readonly label: string;
      readonly outcome: HostProbeOutcome;
      readonly argv: readonly string[];
      /** The status a failed run reports (plan section 10: UNKNOWN for identity). */
      readonly failureStatus: DoctorStatus;
      readonly timeoutMs: number;
    })
  | (HostProbeStepBase & {
      readonly kind: 'mktemp-then-rm';
      readonly worktreeRoot: string;
      /** The `mktemp -p <worktreeRoot>` argv. */
      readonly argv: readonly string[];
      /** The transport prefix the derived `rm` argv must also travel through. */
      readonly transportPrefix: readonly string[];
      readonly timeoutMs: number;
    })
  | (HostProbeStepBase & {
      readonly kind: 'auth-file';
      readonly authFile: string;
      /** `id -u` on the orchestrator: the uid the file must be owned by. */
      readonly ownerArgv: readonly string[];
      /** GNU stat: uid, octal mode, file type. */
      readonly statArgv: readonly string[];
      /** BSD/macOS stat form of the same three fields. */
      readonly statFallbackArgv: readonly string[];
      readonly timeoutMs: number;
    })
  | (HostProbeStepBase & {
      readonly kind: 'note';
      readonly status: DoctorStatus;
      readonly detail: string;
    });

/** The `ssh <alias> --` prefix with BatchMode and a connect budget. */
function sshPrefixOf(alias: string): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    alias,
    '--',
  ];
}

/** The version argv of a runner kind's tool descriptor, or undefined. */
function versionArgvOf(kind: HostRunnerKind): readonly string[] | undefined {
  return BUILT_IN_TOOLS.find((tool) => tool.id === kind)?.detect.argv;
}

/** `sh`, `git` and `node` on every host, plus the runner's own tool. */
const PLATFORM_VERSION_ARGV: readonly (readonly [string, readonly string[]])[] =
  [
    ['sh', ['sh', '--version']],
    ['git', ['git', '--version']],
    ['node', ['node', '--version']],
  ];

/**
 * The ordered probe plan for one host: reachability, the platform and runner
 * tool versions, the worktree root's writability (create and remove exactly
 * one path inside it), the lane-runner worktree root when this host is a
 * verifier, the opencode server on the host's own loopback, the capability
 * declaration's derived source and the orchestrator-side auth file's owner and
 * mode.
 *
 * An ssh alias that fails the safe-host rule yields a single FAIL line and no
 * command at all, so no caller can reach a subprocess with an alias that
 * could be read as an option.
 */
export function planHostProbes(spec: HostProbeSpec): HostProbeStep[] {
  const subject = spec.name;
  const alias = spec.transport === 'ssh' ? spec.sshAlias : undefined;
  if (alias !== undefined && !isSafeSshHost(alias)) {
    return [
      {
        kind: 'note',
        scope: 'host',
        subject,
        check: 'ssh-alias',
        status: 'FAIL',
        detail:
          'the ssh alias is not a safe host string; no command was run on this host',
      },
    ];
  }
  const transportPrefix = alias === undefined ? [] : sshPrefixOf(alias);
  const remote = (argv: readonly string[]): string[] => [
    ...transportPrefix,
    ...argv,
  ];
  const steps: HostProbeStep[] = [];

  steps.push({
    kind: 'run',
    scope: 'host',
    subject,
    check: 'reachable',
    label: alias ?? 'local',
    outcome: 'reachable',
    argv: remote(['true']),
    failureStatus: 'FAIL',
    timeoutMs: SSH_CONNECT_TIMEOUT_S * 1000,
  });

  for (const [tool, argv] of PLATFORM_VERSION_ARGV) {
    steps.push({
      kind: 'run',
      scope: 'host',
      subject,
      check: `version-${tool}`,
      label: tool,
      outcome: 'version',
      argv: remote(argv),
      failureStatus: 'FAIL',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  const runner = spec.runner;
  if (runner !== undefined) {
    const runnerArgv = versionArgvOf(runner.kind);
    steps.push(
      runnerArgv === undefined
        ? {
            kind: 'note',
            scope: 'tool',
            subject: `${subject}/${runner.kind}`,
            check: `version-${runner.kind}`,
            status: 'UNKNOWN',
            detail: `no version descriptor for runner kind ${runner.kind}`,
          }
        : {
            kind: 'run',
            scope: 'tool',
            subject: `${subject}/${runner.kind}`,
            check: `version-${runner.kind}`,
            label: runner.kind,
            outcome: 'version',
            argv: remote(runnerArgv),
            failureStatus: 'FAIL',
            timeoutMs: PROBE_TIMEOUT_MS,
          },
    );
  }

  steps.push({
    kind: 'mktemp-then-rm',
    scope: 'host',
    subject,
    check: 'worktree-root-writable',
    worktreeRoot: spec.worktreeRoot,
    argv: remote(['mktemp', `${spec.worktreeRoot}/.fleet-probe.XXXXXX`]),
    transportPrefix,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  const laneRunnerRoot = spec.laneRunnerWorktreeRoot;
  if (laneRunnerRoot !== undefined) {
    steps.push({
      kind: 'run',
      scope: 'host',
      subject,
      check: 'lane-runner-worktree-visible',
      label: `lane-runner worktree root ${laneRunnerRoot.worktreeRoot} on ${laneRunnerRoot.hostName}`,
      outcome: 'directory',
      argv: remote(['test', '-d', laneRunnerRoot.worktreeRoot]),
      failureStatus: 'FAIL',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  }

  // Only an opencode host serves a loopback endpoint; an agy lane is a CLI,
  // so its identity is the tool version probed above. A server that does not
  // answer is UNKNOWN, not a refusal (plan section 10): `hosts add` still
  // writes and the first real dispatch confirms it.
  if (runner !== undefined && runner.kind === 'opencode') {
    steps.push({
      kind: 'run',
      scope: 'host',
      subject,
      check: 'server-loopback',
      label: `opencode server on 127.0.0.1:${runner.port}`,
      outcome: 'server',
      argv: remote([
        'curl',
        '-fsS',
        '--max-time',
        '5',
        `http://127.0.0.1:${runner.port}/`,
      ]),
      failureStatus: 'UNKNOWN',
      timeoutMs: SERVER_TIMEOUT_MS,
    });
  }

  if (runner !== undefined) {
    const capabilities = runner.capabilities;
    steps.push({
      kind: 'note',
      scope: 'host',
      subject,
      check: 'runner-capabilities',
      status: capabilities === undefined ? 'UNKNOWN' : 'PASS',
      detail:
        capabilities === undefined
          ? 'capability source undeclared, filesystemScope unknown'
          : `capability source declared, filesystemScope ${capabilities.filesystemScope}`,
    });

    // KF-30b: conducted acceptance gates are throttled only when the host
    // declares `runner.gateSlot`; without it they run unthrottled next to
    // hand-run gates. A missing declaration is a config gap, not a failure,
    // so it reports as a PASS line with a warning detail (the same
    // convention as accepted-and-ignored v1 fields).
    if (spec.isLaneRunner === true && runner.gateSlot === undefined) {
      steps.push({
        kind: 'note',
        scope: 'host',
        subject,
        check: 'gate-slot',
        status: 'PASS',
        detail:
          'warning: conducted acceptance gates run unthrottled; declare runner.gateSlot to route them through the host-wide gate slot',
      });
    }

    const authFile = runner.authFile;
    if (authFile !== undefined) {
      steps.push({
        kind: 'auth-file',
        scope: 'credential',
        subject: authFile,
        check: 'file-owner-mode',
        authFile,
        ownerArgv: ['id', '-u'],
        statArgv: ['stat', '-c', '%u %a %F', authFile],
        statFallbackArgv: ['stat', '-f', '%u %Lp %HT', authFile],
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    }
  }

  return steps;
}

/** First non-empty line of text, trimmed. */
function firstLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }
  return undefined;
}

/** Format a stat mode as the conventional octal literal, e.g. `0600`. */
function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/** What a failed run says, per outcome; never the command's whole output. */
const FAILURE_WORD: Readonly<Record<HostProbeOutcome, string>> = {
  reachable: 'not reachable',
  version: 'no version answer',
  server: 'no answer',
  directory: 'not visible',
};

function failureDetail(
  step: Extract<HostProbeStep, { kind: 'run' }>,
  result: DoctorCommandRunResult,
): string {
  const reason = firstLine(result.stderr);
  return `${step.label}: ${FAILURE_WORD[step.outcome]} (exit ${result.exitCode}${
    reason === undefined ? '' : `; ${reason}`
  })`;
}

/**
 * True when `candidate` is a path directly inside `root`: an absolute path
 * under the root with no empty, `.` or `..` segment, so `mktemp` can never
 * talk this engine into removing something outside the worktree root.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  if (!candidate.startsWith('/') || candidate.includes('\0')) {
    return false;
  }
  const prefix = `${root.endsWith('/') ? root.slice(0, -1) : root}/`;
  if (!candidate.startsWith(prefix)) {
    return false;
  }
  const segments = candidate.slice(prefix.length).split('/');
  return (
    segments.length > 0 &&
    segments.every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Run a probe; a throw becomes `undefined` and reports as unknown. */
async function safely<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

function line(
  step: HostProbeStep,
  status: DoctorStatus,
  detail: string,
): DoctorLine {
  return {
    scope: step.scope,
    subject: step.subject,
    check: step.check,
    status,
    detail: boundDoctorDetail(detail),
  };
}

/** One `run` step: version, reachability, loopback server or visibility. */
async function runStep(
  step: Extract<HostProbeStep, { kind: 'run' }>,
  executor: HostProbeExecutor,
): Promise<DoctorLine> {
  const result = await safely(() =>
    executor.run(step.argv, { timeoutMs: step.timeoutMs }),
  );
  if (result === undefined) {
    return line(step, 'UNKNOWN', `${step.label}: the probe could not be run`);
  }
  if (result.error !== undefined) {
    // A spawn failure means the command itself is not there.
    return line(
      step,
      step.failureStatus,
      `${step.label}: could not be run (${firstLine(result.error) ?? 'spawn failed'})`,
    );
  }
  if (step.outcome === 'version') {
    const version = firstLine(result.stdout);
    if (result.exitCode === 0 && version !== undefined) {
      return line(step, 'PASS', `${step.label}: version ${version}`);
    }
    // A POSIX `sh` need not implement `--version`: it answered by exiting, so
    // it exists and its version stays unknown instead of refusing the host.
    if (result.exitCode === 0) {
      return line(
        step,
        'UNKNOWN',
        `${step.label}: version absent or unparsable`,
      );
    }
    return line(step, 'UNKNOWN', failureDetail(step, result));
  }
  if (result.exitCode === 0) {
    if (step.outcome === 'server') {
      return line(
        step,
        'PASS',
        `${step.label} answered on the host's own loopback`,
      );
    }
    if (step.outcome === 'directory') {
      return line(step, 'PASS', `${step.label} is visible`);
    }
    return line(step, 'PASS', `reachable via ${step.label}`);
  }
  return line(step, step.failureStatus, failureDetail(step, result));
}

/**
 * The worktree-root step: create one path with `mktemp -p <root>`, then
 * remove exactly that path with `rm --`. A path the answer does not place
 * inside the root is refused and nothing is removed; a path that cannot be
 * removed is reported with the path left behind, so the operator can delete
 * it by hand.
 */
async function runMktempStep(
  step: Extract<HostProbeStep, { kind: 'mktemp-then-rm' }>,
  executor: HostProbeExecutor,
): Promise<DoctorLine> {
  const root = step.worktreeRoot;
  const created = await safely(() =>
    executor.run(step.argv, { timeoutMs: step.timeoutMs }),
  );
  if (created === undefined) {
    return line(
      step,
      'UNKNOWN',
      `${root}: the writability probe could not be run`,
    );
  }
  if (created.error !== undefined) {
    return line(
      step,
      'FAIL',
      `${root}: mktemp could not be run (${firstLine(created.error) ?? 'spawn failed'})`,
    );
  }
  if (created.exitCode !== 0) {
    const reason = firstLine(created.stderr);
    return line(
      step,
      'FAIL',
      `${root}: not writable (mktemp exited ${created.exitCode}${reason === undefined ? '' : `; ${reason}`})`,
    );
  }
  const answer = firstLine(created.stdout);
  if (answer === undefined) {
    return line(step, 'FAIL', `${root}: mktemp printed no path`);
  }
  if (!isInsideRoot(root, answer)) {
    return line(
      step,
      'FAIL',
      `${root}: mktemp answered with a path outside the worktree root; nothing was removed`,
    );
  }
  const removed = await safely(() =>
    executor.run([...step.transportPrefix, 'rm', '--', answer], {
      timeoutMs: step.timeoutMs,
    }),
  );
  if (removed === undefined) {
    return line(
      step,
      'UNKNOWN',
      `${root}: the created path could not be checked for removal`,
    );
  }
  if (removed.error !== undefined || removed.exitCode !== 0) {
    return line(
      step,
      'FAIL',
      `${root}: created ${answer} was not removed (rm exited ${removed.exitCode ?? 'null'})`,
    );
  }
  return line(
    step,
    'PASS',
    `${root}: writable (created and removed one path inside the root)`,
  );
}

/**
 * The orchestrator-side auth file: a regular file, owned by the orchestrator's
 * own user, with no group- or world bits set. The readable bits are the rule
 * the doctor engine already applies to credential files, which is stricter
 * than the plan's floor of "neither group- nor world-writable" and the mode
 * `ocm-run` expects (600). Only the mode and the owner are read; the file's
 * contents are never opened anywhere in this package.
 */
async function runAuthFileStep(
  step: Extract<HostProbeStep, { kind: 'auth-file' }>,
  executor: HostProbeExecutor,
): Promise<DoctorLine> {
  const path = step.authFile;
  const ownerResult = await safely(() =>
    executor.run(step.ownerArgv, { timeoutMs: step.timeoutMs }),
  );
  const ownerUid =
    ownerResult === undefined ||
    ownerResult.error !== undefined ||
    ownerResult.exitCode !== 0
      ? undefined
      : firstLine(ownerResult.stdout);
  if (ownerUid === undefined || !/^\d+$/.test(ownerUid)) {
    return line(
      step,
      'UNKNOWN',
      `${path}: the orchestrator user id is unknown, so ownership was not checked`,
    );
  }
  let statResult = await safely(() =>
    executor.run(step.statArgv, { timeoutMs: step.timeoutMs }),
  );
  if (statResult === undefined) {
    return line(step, 'UNKNOWN', `${path}: mode probe failed`);
  }
  // GNU coreutils `stat` answers `-c`; the BSD/macOS stat rejects `-c` and
  // answers `-f`, so a failed GNU probe falls back to the BSD form.
  if (statResult.error !== undefined || statResult.exitCode !== 0) {
    statResult = await safely(() =>
      executor.run(step.statFallbackArgv, { timeoutMs: step.timeoutMs }),
    );
  }
  if (
    statResult === undefined ||
    statResult.error !== undefined ||
    statResult.exitCode !== 0
  ) {
    return line(step, 'UNKNOWN', `${path}: mode probe failed`);
  }
  const fields = (firstLine(statResult.stdout) ?? '')
    .split(/\s+/)
    .filter((field) => field !== '');
  if (fields.length < 3) {
    return line(
      step,
      'UNKNOWN',
      `${path}: stat answered without owner, mode and type`,
    );
  }
  const [rawUid, rawMode] = fields;
  // BSD/macOS `%HT` answers a two-word type ("Regular File"), GNU `%F` one.
  const type = fields.slice(2).join(' ').toLowerCase();
  if (type !== 'regular file') {
    return line(step, 'FAIL', `${path}: not a regular file (${type})`);
  }
  if (rawUid !== ownerUid) {
    return line(
      step,
      'FAIL',
      `${path}: owned by uid ${rawUid}, not by the orchestrator user (uid ${ownerUid})`,
    );
  }
  const mode = Number.parseInt(rawMode, 8);
  if (!Number.isInteger(mode) || Number.isNaN(mode)) {
    return line(step, 'UNKNOWN', `${path}: stat answered an unreadable mode`);
  }
  if ((mode & 0o077) !== 0) {
    return line(
      step,
      'FAIL',
      `${path}: mode ${formatMode(mode)} is group- or world-accessible`,
    );
  }
  return line(
    step,
    'PASS',
    `${path}: mode ${formatMode(mode)}, a regular file owned by the orchestrator user`,
  );
}

/**
 * Execute one host's plan in order and return its doctor lines. A probe that
 * throws becomes an UNKNOWN line, never a crash, and the order is stable so a
 * display can stream the lines as they arrive.
 */
export async function runHostProbes(
  steps: readonly HostProbeStep[],
  executor: HostProbeExecutor,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  for (const step of steps) {
    if (step.kind === 'note') {
      lines.push(line(step, step.status, step.detail));
    } else if (step.kind === 'run') {
      lines.push(await runStep(step, executor));
    } else if (step.kind === 'mktemp-then-rm') {
      lines.push(await runMktempStep(step, executor));
    } else {
      lines.push(await runAuthFileStep(step, executor));
    }
  }
  return lines;
}

/** Plan and run one host's probes in one call. */
export async function probeHost(
  spec: HostProbeSpec,
  executor: HostProbeExecutor,
): Promise<DoctorLine[]> {
  return runHostProbes(planHostProbes(spec), executor);
}

/**
 * True when any line failed: `hosts add` refuses on a FAIL and shows the
 * UNKNOWN lines without refusing (plan section 4).
 */
export function hostProbesHaveFailure(lines: readonly DoctorLine[]): boolean {
  return lines.some((hostLine) => hostLine.status === 'FAIL');
}
