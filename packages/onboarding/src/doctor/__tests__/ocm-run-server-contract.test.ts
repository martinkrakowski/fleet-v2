/**
 * Contract test (P3): the bundled `ocm-run --check` client and the doctor's
 * opencode server probe must accept and refuse the same servers, because they
 * are two readers of one server shape. The client is the real `bin/ocm-run`
 * script; the probe is the real `DoctorProbes.serverProbe` from `probes-node.ts`.
 * A fake opencode server in this process stands in for a live host, so neither
 * side touches a real host, a real opencode binary or a credential.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createNodeDoctorProbes } from '../probes-node.js';

/** Walk up from this module to the repository root that owns `bin/ocm-run`. */
function resolveRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'bin', 'ocm-run'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`repo root containing bin/ocm-run not found from ${dir}`);
    }
    dir = parent;
  }
}

const ocmRunPath = path.join(resolveRepoRoot(), 'bin', 'ocm-run');

const toolsAvailable = (() => {
  const probe = spawnSync('sh', [
    '-c',
    'command -v curl >/dev/null 2>&1 && command -v nc >/dev/null 2>&1',
  ]);
  return probe.status === 0;
})();

/** Env keys the client run must not inherit: routing, auth and proxies. */
const ENV_KEYS_TO_DELETE = [
  'OCM_HOST',
  'OCM_PORT',
  'OCM_REMOTE_PORT',
  'OPENCODE_AUTH_FILE',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_PASSWORD',
  'FLEET_OCM_RUN_BIN',
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'all_proxy',
  'no_proxy',
  'NO_PROXY',
] as const;

const createdDirs = new Set<string>();
/** Cleanups of setups whose test has not cleaned up yet (a failure skips its finally). */
const pendingCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const cleanup of [...pendingCleanups]) await cleanup();
});

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

type ServerShape = 'v2' | 'silent';

/**
 * A fake opencode server on `127.0.0.1` port `0`. Two shapes, chosen per
 * test: the v2 shape answers `GET /api/info` and `GET /api/model`; the silent
 * shape answers 404 on every path. Every request is recorded as
 * `'<METHOD> <path>'`; bodies are never read and never logged.
 */
class FakeOpencodeServer {
  readonly requests: string[] = [];
  private readonly server: http.Server;
  private readonly portPromise: Promise<number>;
  private closed = false;

  constructor(shape: ServerShape) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res, shape);
    });
    this.portPromise = new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address !== null && typeof address === 'object') {
          resolve(address.port);
        }
      });
    });
  }

  async port(): Promise<number> {
    return this.portPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise((resolve) => this.server.close(resolve));
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  private send(res: http.ServerResponse, code: number, contentType: string, body: string): void {
    res.writeHead(code, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, shape: ServerShape): void {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    this.requests.push(`${method} ${pathname}`);
    if (shape === 'v2') {
      if (method === 'GET' && pathname === '/api/info') {
        return this.send(res, 200, 'application/json', '{"version":"2.0.28"}');
      }
      if (method === 'GET' && pathname === '/api/model') {
        return this.send(
          res,
          200,
          'application/json',
          '{"data":{"current":"example/model","models":{"example/model":{"variants":["low"]}}}}',
        );
      }
    }
    this.send(res, 404, 'text/plain', '');
  }
}

interface RunClientResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the real `bin/ocm-run --check` with a built environment. `spawn` (not
 * `spawnSync`) is used on purpose: the fake opencode server lives in this
 * process, and a synchronous wait would block the event loop and the server
 * with it (the work-execution integration test spawns asynchronously for the
 * same reason).
 */
function runClientWithEnv(env: Record<string, string>): Promise<RunClientResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', [ocmRunPath, '--check'], {
      env,
      timeout: 20000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      resolve({ status: null, stdout, stderr });
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

interface SetupContext {
  readonly server: FakeOpencodeServer;
  readonly port: number;
  readonly runClient: () => Promise<RunClientResult>;
  readonly readSshLog: () => Promise<string>;
  readonly cleanup: () => Promise<void>;
}

async function setup(shape: ServerShape): Promise<SetupContext> {
  const server = new FakeOpencodeServer(shape);
  const port = await server.port();

  // If any step below throws after the server started listening but before
  // the full cleanup is registered (for example `fs.mkdir` or `fs.writeFile`
  // rejects), the test's try/finally is never reached and the listening
  // server would be left open. Register a server-only cleanup right away so
  // afterEach can close it; the full cleanup supersedes it below.
  const serverOnlyCleanup = async (): Promise<void> => {
    pendingCleanups.delete(serverOnlyCleanup);
    await server.close();
  };
  pendingCleanups.add(serverOnlyCleanup);

  const controlDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocm-contract-'));
  createdDirs.add(controlDir);
  const binDir = path.join(controlDir, 'bin');
  const homeDir = path.join(controlDir, 'home');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  const sshLog = path.join(controlDir, 'ssh-argv.log');

  // `--check` refuses to pass when `opencode` is not on PATH (bin/ocm-run
  // lines 465-468); the stub only has to exist.
  const opencodeStub = path.join(binDir, 'opencode');
  await fs.writeFile(opencodeStub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.chmod(opencodeStub, 0o755);

  // ssh must never be called (OCM_HOST unset dials loopback directly); the log
  // is the proof the check reached no host. Exit 255 so an accidental call
  // fails loudly instead of being mistaken for a real tunnel.
  const sshStub = path.join(binDir, 'ssh');
  const sshScript =
    '#!/bin/sh\n' + `printf '%s\\n' "$*" >> '${sshLog}'\n` + 'exit 255\n';
  await fs.writeFile(sshStub, sshScript, { mode: 0o755 });
  await fs.chmod(sshStub, 0o755);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of ENV_KEYS_TO_DELETE) delete env[key];
  env.HOME = homeDir;
  env.PATH = `${binDir}:${env.PATH ?? ''}`;
  env.OCM_REMOTE_PORT = String(port);
  const runClient = (): Promise<RunClientResult> => runClientWithEnv(env);

  const readSshLog = async (): Promise<string> => {
    try {
      return await fs.readFile(sshLog, 'utf8');
    } catch {
      return '';
    }
  };

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    pendingCleanups.delete(serverOnlyCleanup);
    pendingCleanups.delete(cleanup);
    try {
      await server.close();
    } finally {
      await fs.rm(controlDir, { recursive: true, force: true });
    }
  };
  pendingCleanups.add(cleanup);

  return { server, port, runClient, readSshLog, cleanup };
}

describe.skipIf(!toolsAvailable)('the bundled ocm-run --check and the doctor probe speak one server shape', () => {
  it('the bundled ocm-run --check and the doctor probe accept the same v2 server', { timeout: 30000 }, async () => {
    const ctx = await setup('v2');
    try {
      const client = await ctx.runClient();
      expect(client.status).toBe(0);
      expect(client.stdout).toContain('ocm-run: ok');

      const clientRequests = [...ctx.server.requests];
      expect(clientRequests).toEqual(['GET /api/info']);

      ctx.server.clearRequests();
      const probes = createNodeDoctorProbes();
      const result = await probes.serverProbe('local', ctx.port);
      expect(result).toEqual({
        outcome: 'pass',
        reason: `the opencode server on 127.0.0.1:${ctx.port} answered`,
        models: ['example/model', 'example/model#low'],
      });

      const probeRequests = [...ctx.server.requests];
      expect(probeRequests).toEqual(['GET /api/info', 'GET /api/model']);

      // Both readers ask the same server the same question; neither starts anything.
      expect([...clientRequests, ...probeRequests].filter((request) => request.startsWith('POST'))).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it('a server that answers neither /api/info nor /session/status is refused by both', { timeout: 30000 }, async () => {
    const ctx = await setup('silent');
    try {
      const client = await ctx.runClient();
      expect(client.status).toBe(1);
      expect(client.stderr).toContain('did not answer v2 /api/info or v1 /session/status');

      const probes = createNodeDoctorProbes();
      const result = await probes.serverProbe('local', ctx.port);
      expect(result).toEqual({
        outcome: 'fail',
        reason: `the opencode server on 127.0.0.1:${ctx.port} answered HTTP 404`,
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it('the check never opens a tunnel and never starts a session', { timeout: 30000 }, async () => {
    const ctx = await setup('v2');
    try {
      const client = await ctx.runClient();
      expect(client.status).toBe(0);
      expect(await ctx.readSshLog()).toBe('');
      expect(ctx.server.requests.filter((request) => request.startsWith('POST'))).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });
});
