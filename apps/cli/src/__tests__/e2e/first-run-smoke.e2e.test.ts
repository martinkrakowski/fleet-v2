/**
 * The O12' first-run smoke (lane O12'). Two assertions in one file:
 *
 * 1. The multi-profile first run: `init --profile multi --hosts ... --yes`
 *    writes a file the real loader accepts, with the chosen isolation
 *    declaration applied to every drafted runner, and the two usage errors
 *    around --hosts refuse with exit 2.
 * 2. The refused-dispatch assertion: a single-profile installation written
 *    with `--isolation none` refuses `attempt dispatch` with exit 1 and the
 *    exact refusal reason, because the runner capabilities do not satisfy
 *    the required isolation.
 *
 * This lane is TypeScript on purpose: the owner forbids new shell scripts in
 * fleet-v2, so the smoke runs as a vitest e2e test instead of a shell pair.
 * It touches no network and no ssh: the upstream repository is a local
 * `file://` clone, detection and doctor probes are faked, and the runner is
 * never started (the refusal is decided before any runner call).
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  GH_BINARY_CANDIDATES,
  type DoctorCommandExecutor,
  type DoctorProbes,
} from '@fleet/onboarding';
import { parseInstallation } from '@fleet/installation';

import { createFleetCliRuntime } from '../../composition.js';
import { runCli, type CliIo } from '../../index.js';

// ---------------------------------------------------------------------------
// Fixtures and helpers (copied from cli-init.test.ts / onboarding-smoke.test.ts)
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-first-run-smoke-'));
  createdDirs.push(directory);
  return directory;
}

function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

/** The detection environment: every platform tool present, tools signed in. */
function detectionExecutor(cwd: string): DoctorCommandExecutor {
  const table: Record<
    string,
    { exitCode: number; stdout?: string; stderr?: string }
  > = {
    'uname -s': { exitCode: 0, stdout: 'Linux\n' },
    pwd: { exitCode: 0, stdout: `${cwd}\n` },
    'node --version': { exitCode: 0, stdout: 'v20.11.0\n' },
    'yarn --version': { exitCode: 0, stdout: '4.1.0\n' },
    'git --version': { exitCode: 0, stdout: 'git version 2.43.0\n' },
    'gh --version': { exitCode: 0, stdout: 'gh version 2.50.0\n' },
    'sh -c true': { exitCode: 0 },
    'nc -h': { exitCode: 0, stdout: 'usage: nc\n' },
    'curl --version': { exitCode: 0, stdout: 'curl 8.5.0\n' },
    'ssh -V': { exitCode: 0, stderr: 'OpenSSH_9.6\n' },
    'opencode --version': { exitCode: 0, stdout: '1.0.0\n' },
    'claude --version': { exitCode: 0, stdout: '1.0.0\n' },
    'claude auth status': { exitCode: 0, stdout: 'signed in as someone\n' },
    'grok --version': { exitCode: 0, stdout: '1.0.0\n' },
    'grok auth status': { exitCode: 0, stdout: 'signed in as someone\n' },
    'grok models': { exitCode: 0, stdout: 'Available models:\ngrok-4.7\n' },
  };
  return {
    async run(argv) {
      const answer = table[argv.join(' ')];
      if (answer === undefined) {
        return {
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          error: 'not probed',
        };
      }
      return {
        exitCode: answer.exitCode,
        signal: null,
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? '',
      };
    },
  };
}

/** Full-accepting doctor probes: every line PASS. */
function passingDoctorProbes(): DoctorProbes {
  return {
    hostReachable: async () => true,
    commandAvailable: async () => true,
    toolVersion: async () => '1.0.0',
    fileMode: async () => 0o600,
    worktreeRootWritable: async () => true,
    ocmRunBinary: async () => ({
      path: '/repo/bin/ocm-run',
      sha256: 'c'.repeat(64),
    }),
    expectedOcmRunHash: async () => 'c'.repeat(64),
    ghBinary: async () => ({
      resolved: '/usr/bin/gh',
      candidates: GH_BINARY_CANDIDATES,
    }),
    seatProbe: async () => ({ outcome: 'pass', reason: 'answered' }),
    serverProbe: async () => ({
      outcome: 'pass',
      reason: 'the opencode server answered',
    }),
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runInit(
  argv: readonly string[],
  directory: string,
): Promise<RunResult> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(
    ['init', ...argv],
    io,
    undefined,
    undefined,
    undefined,
    {
      installationFile: path.join(directory, 'installation', 'fleet.json'),
      detectionExecutor: detectionExecutor(directory),
      doctorProbes: passingDoctorProbes(),
    },
  );
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function runCliCommand(
  argv: readonly string[],
  runtime: ReturnType<typeof createFleetCliRuntime>,
): Promise<RunResult> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(argv, io, runtime);
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

/** Run git with an argv array (never a shell string) and return trimmed stdout. */
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Build the throwaway upstream repository with a committed package.json. */
function initUpstream(dir: string): void {
  git('init', '--initial-branch=main', '-q', dir);
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Demo project agent instructions\n');
  writeFileSync(path.join(dir, '.gitignore'), '.lane/\n');
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demo-upstream', scripts: { test: 'x', build: 'y' } }, null, 2)}\n`,
  );
  git('-C', dir, 'add', '.');
  // Identity is scoped to the commit command only; never global config.
  git(
    '-C',
    dir,
    '-c',
    'user.name=Fleet First Run Smoke',
    '-c',
    'user.email=fleet@example.invalid',
    'commit',
    '-q',
    '-m',
    'init',
  );
}

/** Skip the whole suite only when git itself is unavailable. */
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

const PROJECT_ID = 'proj-o12';
const WORK_ORDER_ID = 'wo-1';
const POLICY_REVISION = 'policy-1';

// ---------------------------------------------------------------------------
// Test 1: the multi-profile first-run smoke (no git, no ssh, no network)
// ---------------------------------------------------------------------------

describe("fleet-v2 init --profile multi first run (O12')", () => {
  it('writes a two-host installation the loader accepts, with the container isolation on the runner', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'installation', 'fleet.json');
    const hosts = [
      {
        name: 'orch-host',
        transport: 'local',
        worktreeRoot: path.join(dir, 'orch-worktrees'),
        roles: ['orchestrator'],
      },
      {
        name: 'lane-host',
        transport: 'local',
        worktreeRoot: path.join(dir, 'worktrees'),
        roles: ['lane-runner'],
        runner: { kind: 'opencode', port: 46001, maxLanes: 1 },
      },
    ];
    const result = await runInit(
      [
        '--profile',
        'multi',
        '--hosts',
        JSON.stringify(hosts),
        '--tools',
        'opencode',
        '--isolation',
        'container',
        '--forge',
        'none',
        '--yes',
      ],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('profile multi');
    expect(result.stdout).toContain(`written ${file}`);
    expect(result.stdout).toMatch(/PASS installation schema/);

    const parsed = parseInstallation(JSON.parse(readFileSync(file, 'utf8')));
    expect(parsed.ok).toBe(true);
    const hostsOut = (parsed.ok ? parsed.installation.hosts : {}) as Record<
      string,
      {
        roles?: readonly string[];
        runner?: { capabilities?: Record<string, unknown> };
      }
    >;
    expect(Object.keys(hostsOut).sort()).toEqual(['lane-host', 'orch-host']);
    expect(hostsOut['orch-host']?.roles).toContain('orchestrator');
    expect(hostsOut['orch-host']?.runner).toBeUndefined();
    expect(hostsOut['lane-host']?.roles).toContain('lane-runner');
    expect(hostsOut['lane-host']?.runner?.capabilities).toEqual({
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: 'scoped-worktree',
    });
  });

  it('refuses --profile multi without --hosts with a usage error', async () => {
    const dir = makeTempDir();
    const result = await runInit(
      [
        '--profile',
        'multi',
        '--tools',
        'opencode',
        '--isolation',
        'container',
        '--forge',
        'none',
        '--yes',
      ],
      dir,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--profile multi requires --hosts');
  });

  it('refuses --hosts with --profile single with a usage error', async () => {
    const dir = makeTempDir();
    const hosts = [
      {
        name: 'orch-host',
        transport: 'local',
        worktreeRoot: path.join(dir, 'orch-worktrees'),
        roles: ['orchestrator'],
      },
    ];
    const result = await runInit(
      [
        '--profile',
        'single',
        '--hosts',
        JSON.stringify(hosts),
        '--tools',
        'opencode',
        '--isolation',
        'container',
        '--forge',
        'none',
        '--yes',
      ],
      dir,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--hosts belongs to --profile multi');
  });
});

// ---------------------------------------------------------------------------
// Test 2: the refused-dispatch assertion (single profile, --isolation none)
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable)("the refused dispatch on an isolation-none installation (O12')", () => {
  it('init writes the false capabilities and dispatch refuses with exit 1', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'installation', 'fleet.json');

    // 1. Write the single-profile installation with --isolation none.
    const init = await runInit(
      [
        '--profile',
        'single',
        '--tools',
        'opencode',
        '--isolation',
        'none',
        '--forge',
        'none',
        '--yes',
      ],
      dir,
    );
    expect(init.code).toBe(0);
    expect(init.stderr).toBe('');
    expect(init.stdout).toContain(
      "isolation is 'none': dispatch will refuse until the declaration changes",
    );
    const parsed = parseInstallation(JSON.parse(readFileSync(file, 'utf8')));
    expect(parsed.ok).toBe(true);
    const hosts = (parsed.ok ? parsed.installation.hosts : {}) as Record<
      string,
      { runner?: { capabilities?: Record<string, unknown> } }
    >;
    expect(hosts['this-machine']?.runner?.capabilities).toEqual({
      networkEgressRestricted: false,
      cpuAndMemoryLimited: false,
      processTreeTermination: false,
      filesystemScope: 'inherited-directory',
    });

    // 2. Compose the runtime over the file init just wrote, so the runner
    //    adapter sees the false capabilities.
    const runtime = createFleetCliRuntime({
      stateDir: path.join(dir, 'state'),
      installation: parsed.ok ? parsed.installation : undefined,
    });

    // 3. A throwaway local git upstream; the repository string is file://.
    const upstream = path.join(dir, 'upstream');
    mkdirSync(upstream);
    initUpstream(upstream);
    const head = git('-C', upstream, 'rev-parse', 'HEAD');
    const repositoryUrl = `file://${upstream}`;

    // 4. Walk the chain through the CLI, up to the refused dispatch.
    const profile = await runCliCommand(
      [
        'coordination',
        'register-profile',
        '--json',
        JSON.stringify({
          projectId: PROJECT_ID,
          displayName: 'First Run Smoke Project',
          repository: repositoryUrl,
          designatedDispatcherHost: 'this-machine',
          policyRevision: POLICY_REVISION,
          maxConcurrentLanes: 2,
        }),
      ],
      runtime,
    );
    expect(profile.code).toBe(0);
    expect(JSON.parse(profile.stdout)).toMatchObject({ outcome: 'registered' });

    const workOrder = await runCliCommand(
      [
        'work-order',
        'register',
        '--work-order-id',
        WORK_ORDER_ID,
        '--project-id',
        PROJECT_ID,
        '--task-id',
        'task-1',
        '--lane-id',
        'lane-1',
        '--repository',
        repositoryUrl,
        '--base-commit',
        head,
        '--owned-paths',
        'packages/demo/src',
        '--policy-revision',
        POLICY_REVISION,
      ],
      runtime,
    );
    expect(workOrder.code).toBe(0);
    expect(JSON.parse(workOrder.stdout)).toMatchObject({
      outcome: 'registered',
      workOrder: { id: WORK_ORDER_ID, state: 'approved', baseCommit: head },
    });

    // A v2 installation's reserve allocates the worktree path itself; the
    // operator passes no host, slot budget or path.
    const reserve = await runCliCommand(
      [
        'capacity',
        'reserve',
        '--json',
        JSON.stringify({
          reservationId: 'res-1',
          attemptId: 'att-1',
          workOrderId: WORK_ORDER_ID,
          seatTool: 'opencode',
        }),
      ],
      runtime,
    );
    expect(reserve.code).toBe(0);
    const reserved = JSON.parse(reserve.stdout) as {
      outcome: string;
      worktreePath?: string;
      reservation?: { worktreePath?: string };
    };
    expect(reserved).toMatchObject({ outcome: 'reserved' });
    const reservedPath = reserved.worktreePath ?? reserved.reservation?.worktreePath;
    expect(typeof reservedPath).toBe('string');
    expect(reservedPath!.startsWith(path.join(dir, 'worktrees'))).toBe(true);

    // The brief package is never read: the refusal is decided before the
    // brief is opened; only a non-empty digest and a .md path are required.
    const briefPath = path.join(dir, 'brief.md');
    writeFileSync(briefPath, '# First run smoke brief\n', 'utf8');
    expect(existsSync(briefPath)).toBe(true);

    const dispatch = await runCliCommand(
      [
        'attempt',
        'dispatch',
        '--json',
        JSON.stringify({
          attemptId: 'att-1',
          workOrderId: WORK_ORDER_ID,
          worktreePath: reservedPath,
          briefPackagePath: briefPath,
          briefDigest: 'a'.repeat(64),
          baseCommit: head,
        }),
      ],
      runtime,
    );
    expect(dispatch.code).toBe(1);
    expect(JSON.parse(dispatch.stdout)).toEqual({
      outcome: 'refused',
      reason: 'Runner capabilities do not satisfy required isolation',
    });
    expect(dispatch.stderr).toBe('');
  });
});
