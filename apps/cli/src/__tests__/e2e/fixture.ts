/**
 * Lane Q1a: the conductor end-to-end fixture. `startE2eFixture()` stands up a
 * disposable sshd (through `tests/e2e/ssh-fixture.sh`), a fake opencode v2
 * server (`tests/e2e/fake-opencode-server.mjs`) and a v2 installation file
 * whose single lane-runner host reaches the sshd through the `fleet-e2e`
 * alias. Callers set `HOME` and `PATH` themselves; nothing here mutates the
 * process environment.
 */

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeInstallationV2 } from '@fleet/installation';
import type { FleetInstallationV2, HostSection } from '@fleet/installation';
import type { RunnerForAttemptHostSpec } from '@fleet/work-execution';

export interface E2eFixture {
  /** The disposable fixture directory (contains home/, worktrees/ and state/). */
  readonly dir: string;
  /** The client home whose `~/.ssh/config` names the `fleet-e2e` alias. */
  readonly home: string;
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
  readonly port: number;
  readonly alias: string;
}

function runSshFixture(e2eDir: string, args: readonly string[]): FixtureLines {
  const script = path.join(e2eDir, 'ssh-fixture.sh');
  const stdout = execFileSync('sh', [script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const values: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      throw new Error(`unexpected ssh-fixture output line: ${trimmed}`);
    }
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  const dir = values.FLEET_E2E_DIR ?? '';
  const home = values.FLEET_E2E_HOME ?? '';
  const port = Number(values.FLEET_E2E_PORT ?? '');
  const alias = values.FLEET_E2E_ALIAS ?? '';
  if (
    dir === '' ||
    home === '' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    alias === ''
  ) {
    throw new Error('ssh-fixture start printed incomplete FLEET_E2E_* output');
  }
  return { dir, home, port, alias };
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
      child.kill('SIGTERM');
      reject(new Error(message));
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1 || settled) return;
      settled = true;
      const match = /^port=(\d+)$/.exec(buffer.slice(0, newline).trim());
      if (match === null) {
        child.kill('SIGTERM');
        reject(new Error(`fake opencode server printed an unexpected first line: ${buffer.slice(0, newline).trim()}`));
        return;
      }
      const url = `http://127.0.0.1:${Number(match[1])}`;
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

/** The minimal valid v2 shape from `v2-write.test.ts`, with the ssh host. */
function buildInstallation(fakePort: number, worktreeRoot: string): FleetInstallationV2 {
  return {
    schemaVersion: 2,
    hosts: {
      'lane-host': {
        transport: 'ssh',
        sshAlias: 'fleet-e2e',
        worktreeRoot,
        roles: ['orchestrator', 'lane-runner'],
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
 * The RunnerForAttemptHostSpec map derived from the installation's host. The
 * recorded `remotePort` in this fixture is the tunnel port (the sshd port),
 * so the confirm-or-unknown comparison sees that port here.
 */
function deriveHosts(
  installation: FleetInstallationV2,
  sshPort: number,
): Readonly<Record<string, RunnerForAttemptHostSpec>> {
  const host = installation.hosts['lane-host'] as HostSection;
  return {
    'lane-host': {
      transport: host.transport,
      sshAlias: host.sshAlias,
      roles: host.roles.filter((role) => role === 'lane-runner'),
      runner: {
        kind: host.runner?.kind ?? 'opencode',
        port: sshPort,
      },
    },
  };
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
  const stateDir = path.join(ssh.dir, 'state');
  await fs.mkdir(path.join(stateDir, 'installation'), { recursive: true });

  const fake = await spawnFakeOpencodeServer(e2eDir);
  const fakePort = Number(new URL(fake.url).port);
  const installation = buildInstallation(fakePort, path.join(ssh.dir, 'worktrees'));
  await fs.writeFile(
    path.join(stateDir, 'installation', 'fleet.json'),
    writeInstallationV2(installation),
    'utf8',
  );

  const hosts = deriveHosts(installation, ssh.port);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminateChild(fake.child);
    execFileSync('sh', [path.join(e2eDir, 'ssh-fixture.sh'), 'stop', ssh.dir], {
      stdio: 'ignore',
    });
  };

  return {
    dir: ssh.dir,
    home: ssh.home,
    stateDir,
    alias: ssh.alias,
    sshPort: ssh.port,
    fakeOpencodeUrl: fake.url,
    fakeOpencodeBin: e2eDir,
    hosts,
    stop,
  };
}
