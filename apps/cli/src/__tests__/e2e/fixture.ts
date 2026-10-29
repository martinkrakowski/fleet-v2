/**
 * Lane Q1a: the conductor end-to-end fixture. `startE2eFixture()` stands up a
 * disposable sshd (through `tests/e2e/ssh-fixture.sh`), a fake opencode v2
 * server (`tests/e2e/fake-opencode-server.mjs`) and a v2 installation file
 * with a local orchestrator host and one lane-runner host reaching the sshd
 * through the `fleet-e2e` alias. Callers set `PATH` themselves (prepend
 * `fixture.bin`); nothing here mutates the process environment.
 */

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseInstallation, writeInstallationV2 } from '@fleet/installation';
import type { FleetInstallationV2 } from '@fleet/installation';
import type { RunnerForAttemptHostSpec } from '@fleet/work-execution';

export interface E2eFixture {
  /** The disposable fixture directory (contains home/, bin/, worktrees/ and state/). */
  readonly dir: string;
  /** The client home whose `~/.ssh/config` names the `fleet-e2e` alias. */
  readonly home: string;
  /** The wrapper dir to prepend to PATH; ssh ignores HOME. */
  readonly bin: string;
  /** The directory holding `installation/fleet.json`. */
  readonly stateDir: string;
  /** The ssh config alias for the fixture's sshd. */
  readonly alias: string;
  /** The sshd's loopback port. */
  readonly sshPort: number;
  /** Base URL of the fake opencode server. */
  readonly fakeOpencodeUrl: string;
  /** Directory holding the fake `opencode` client. */
  readonly fakeOpencodeBin: string;
  /** The RunnerForAttemptHostSpec map derived from the installation. */
  readonly hosts: Readonly<Record<string, RunnerForAttemptHostSpec>>;
  /** Kill the fake server and tear the sshd down. */
  readonly stop: () => Promise<void>;
}

/**
 * The repository's `tests/e2e` directory, found by walking up from this
 * module (the fixture lives at `apps/cli/src/__tests__/e2e/`).
 */
export function resolveE2eDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'tests', 'e2e', 'ssh-fixture.sh'))) {
      return path.join(dir, 'tests', 'e2e');
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('repo root (containing tests/e2e/ssh-fixture.sh) not found');
    }
    dir = parent;
  }
}

interface FixtureLines {
  readonly dir: string;
  readonly home: string;
  readonly bin: string;
  readonly port: number;
  readonly alias: string;
}

const EXPECTED_FIXTURE_KEYS: ReadonlySet<string> = new Set([
  'FLEET_E2E_DIR',
  'FLEET_E2E_HOME',
  'FLEET_E2E_BIN',
  'FLEET_E2E_PORT',
  'FLEET_E2E_ALIAS',
]);
const EXPECTED_FIXTURE_LINE_COUNT = 5;
const PORT_PATTERN = /^[0-9]+$/;
const MAX_PORT = 65535;

function parsePort(value: string, label: string): number {
  if (!PORT_PATTERN.test(value)) {
    throw new Error(`${label} is not a number: ${value}`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`${label} must be within 1..${MAX_PORT}: ${value}`);
  }
  return port;
}

function runSshFixture(e2eDir: string, args: readonly string[]): FixtureLines {
  const script = path.join(e2eDir, 'ssh-fixture.sh');
  const stdout = execFileSync('sh', [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  if (lines.length !== EXPECTED_FIXTURE_LINE_COUNT) {
    throw new Error(
      `ssh-fixture start printed ${lines.length} lines, expected ${EXPECTED_FIXTURE_LINE_COUNT}`,
    );
  }
  const values: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new Error(`unexpected ssh-fixture output line: ${line}`);
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!EXPECTED_FIXTURE_KEYS.has(key)) {
      throw new Error(`unexpected ssh-fixture output key: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`duplicate ssh-fixture output key: ${key}`);
    }
    values[key] = value;
  }
  const dir = values.FLEET_E2E_DIR;
  const home = values.FLEET_E2E_HOME;
  const bin = values.FLEET_E2E_BIN;
  const alias = values.FLEET_E2E_ALIAS;
  if (dir === '' || home === '' || bin === '' || alias === '') {
    throw new Error('ssh-fixture start printed incomplete FLEET_E2E_* output');
  }
  return {
    dir,
    home,
    bin,
    port: parsePort(values.FLEET_E2E_PORT, 'FLEET_E2E_PORT'),
    alias,
  };
}

interface FakeServer {
  readonly child: ChildProcess;
  readonly url: string;
  readonly exited: Promise<void>;
}

function spawnFakeOpencodeServer(e2eDir: string): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(e2eDir, 'fake-opencode-server.mjs')], {
      cwd: e2eDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let releaseExit = (): void => {};
    const exited = new Promise<void>((resolveExit) => {
      releaseExit = resolveExit;
    });
    child.on('exit', () => releaseExit());
    let buffer = '';
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      fail('fake opencode server did not print port= within 10 seconds');
    }, 10000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1 || settled) return;
      settled = true;
      clearTimeout(timer);
      const match = /^port=(\d+)$/.exec(buffer.slice(0, newline).trim());
      if (match === null) {
        child.kill('SIGTERM');
        reject(new Error(`fake opencode server printed an unexpected first line: ${buffer.slice(0, newline).trim()}`));
        return;
      }
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
        child.kill('SIGTERM');
        reject(new Error(`fake opencode server printed an invalid port: ${match[1]}`));
        return;
      }
      const url = `http://127.0.0.1:${port}`;
      resolve({ child, url, exited });
    });
    child.stderr?.on('data', () => {
      // The fake server writes nothing to stderr; discard if it ever does.
    });
    child.on('error', (failure: Error) => fail(failure.message));
    child.on('exit', (code) => {
      if (!settled) fail(`fake opencode server exited early (code ${String(code)})`);
    });
  });
}

/** The minimal valid v2 shape from `v2-write.test.ts`, with two hosts. */
function buildInstallation(
  fakePort: number,
  orchestratorWorktreeRoot: string,
  laneWorktreeRoot: string,
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
        model: 'example-provider/example-model',
        roles: ['implementer'],
        costClass: 'plan-quota',
      },
    ],
    chains: { implementer: [{ seatId: 'implementer' }] },
    policy: { forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }] },
    shelf: { provider: 'local' },
    forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
    verification: { procedures: { gate: { command: 'true', args: [] } } },
    waves: {
      baseUrl: 'https://waves.example',
      tokenFile: '/home/operator/.config/fleet/waves-token',
    },
    decisions: { provider: 'none' },
  };
}

/**
 * The RunnerForAttemptHostSpec map derived from the installation itself: the
 * lane-runner host's `runner.port` (the fake opencode server's port) is the
 * recorded `remotePort` the confirm-or-unknown comparison sees.
 */
function deriveHosts(
  installation: FleetInstallationV2,
): Readonly<Record<string, RunnerForAttemptHostSpec>> {
  const hosts: Record<string, RunnerForAttemptHostSpec> = {};
  for (const [name, host] of Object.entries(installation.hosts)) {
    if (!host.roles.includes('lane-runner')) continue;
    hosts[name] = {
      transport: host.transport,
      sshAlias: host.sshAlias,
      roles: host.roles.filter((role) => role === 'lane-runner'),
      runner: {
        kind: host.runner?.kind ?? 'opencode',
        port: host.runner?.port ?? 0,
      },
    };
  }
  return hosts;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let release = (): void => {};
  const exited = new Promise<void>((resolveExit) => {
    release = resolveExit;
  });
  child.once('exit', release);
  if (child.exitCode !== null || child.signalCode !== null) {
    release();
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 2000);
  await exited;
  clearTimeout(timer);
}

export async function startE2eFixture(): Promise<E2eFixture> {
  const e2eDir = resolveE2eDir();
  const ssh = runSshFixture(e2eDir, ['start']);
  let fake: FakeServer | undefined;
  const stopSshFixture = (): void => {
    execFileSync('sh', [path.join(e2eDir, 'ssh-fixture.sh'), 'stop', ssh.dir], {
      stdio: 'ignore',
      timeout: 15000,
    });
  };
  try {
    const stateDir = path.join(ssh.dir, 'state');
    await fs.mkdir(path.join(stateDir, 'installation'), { recursive: true });

    fake = await spawnFakeOpencodeServer(e2eDir);
    const fakePort = Number(new URL(fake.url).port);
    const installation = buildInstallation(
      fakePort,
      path.join(ssh.dir, 'orchestrator-worktrees'),
      path.join(ssh.dir, 'worktrees'),
    );
    const written = writeInstallationV2(installation);
    // Prove the fixture parses here, so a bad fixture fails at start, never later.
    const parsed = parseInstallation(JSON.parse(written));
    if (!parsed.ok) {
      throw new Error(`fixture installation must parse: ${parsed.errors.join('; ')}`);
    }
    await fs.writeFile(
      path.join(stateDir, 'installation', 'fleet.json'),
      written,
      'utf8',
    );

    const hosts = deriveHosts(installation);

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        if (fake !== undefined) {
          await terminateChild(fake.child);
        }
      } finally {
        stopSshFixture();
      }
    };

    return {
      dir: ssh.dir,
      home: ssh.home,
      bin: ssh.bin,
      stateDir,
      alias: ssh.alias,
      sshPort: ssh.port,
      fakeOpencodeUrl: fake.url,
      fakeOpencodeBin: e2eDir,
      hosts,
      stop,
    };
  } catch (error) {
    if (fake !== undefined) {
      try {
        await terminateChild(fake.child);
      } catch {
        // Best effort: the original failure is the one to surface.
      }
    }
    try {
      stopSshFixture();
    } catch {
      // Best effort: the original failure is the one to surface.
    }
    throw error;
  }
}
