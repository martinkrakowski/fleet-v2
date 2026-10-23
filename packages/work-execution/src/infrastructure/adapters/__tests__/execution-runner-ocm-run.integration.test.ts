import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { StartRunnerSessionRequest } from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import { ExecutionRunnerAdapter } from '../ExecutionRunnerAdapter.adapter.js';

/**
 * Lane L5b integration test: drive the REAL `bin/ocm-run` (no injected
 * `runSubprocess`, no executor — the execFile path) against a fake opencode
 * v2 server. It proves the adapter records the id the real script's
 * `session started: <id> (detached)` line prints and that an unknown start is
 * resolved through `--status` (or reported unknown, never refused). Against a
 * pre-L5a script the fake client never returns, so the start cannot complete.
 */

const repoRootBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../bin/ocm-run',
);
const ocmRunBin = process.env.OCM_IT_SCRIPT ?? repoRootBin;

const toolsAvailable = (() => {
  const probe = spawnSync('sh', [
    '-c',
    'command -v curl >/dev/null 2>&1 && command -v nc >/dev/null 2>&1',
  ]);
  return probe.status === 0;
})();

const createdDirs = new Set<string>();
/** Cleanups of setups whose test has not cleaned up yet (a hung start skips its finally). */
const pendingCleanups = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const cleanup of [...pendingCleanups]) await cleanup();
});

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.add(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

interface FakeSession {
  state: 'created' | 'busy';
  directory: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * A fake opencode v2 server implementing exactly what `ocm-run --detach`,
 * `--status` and `--abort` call, plus the test-only `POST /__start/<id>` that
 * the fake client uses to flip a created session to busy.
 */
class FakeOpencodeServer {
  readonly sessions = new Map<string, FakeSession>();
  readonly interrupts: string[] = [];
  readonly createdIds: string[] = [];
  private readonly server: http.Server;
  private readonly portPromise: Promise<number>;
  private closed = false;

  constructor() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
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

  private send(res: http.ServerResponse, code: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/api/info' && req.method === 'GET') {
        return this.send(res, 200, { version: '2.0.28' });
      }
      if (
        parts.length === 2 &&
        parts[0] === 'api' &&
        parts[1] === 'session' &&
        req.method === 'POST'
      ) {
        const body = await readBody(req);
        let directory = '';
        try {
          directory = (JSON.parse(body) as { location?: { directory?: unknown } }).location?.directory as string;
        } catch {
          // Malformed body: fall through with an empty directory.
        }
        const id = `ses_it${this.createdIds.length + 1}`;
        this.createdIds.push(id);
        this.sessions.set(id, { state: 'created', directory });
        return this.send(res, 200, { data: { id, location: { directory } } });
      }
      if (url.pathname === '/api/session/active' && req.method === 'GET') {
        const active: Record<string, unknown> = {};
        for (const [id, session] of this.sessions) {
          if (session.state === 'busy') active[id] = { type: 'busy' };
        }
        return this.send(res, 200, { data: active });
      }
      if (
        parts.length === 3 &&
        parts[0] === 'api' &&
        parts[1] === 'session' &&
        parts[2].startsWith('ses_') &&
        req.method === 'GET'
      ) {
        const session = this.sessions.get(parts[2]);
        if (session === undefined) return this.send(res, 404, { error: 'not found' });
        return this.send(res, 200, {
          data: { id: parts[2], location: { directory: session.directory } },
        });
      }
      if (
        parts.length === 4 &&
        parts[0] === 'api' &&
        parts[1] === 'session' &&
        parts[3] === 'interrupt' &&
        req.method === 'POST'
      ) {
        this.interrupts.push(parts[2]);
        this.sessions.delete(parts[2]);
        return this.send(res, 200, { interrupted: true });
      }
      if (parts.length === 2 && parts[0] === '__start' && req.method === 'POST') {
        const session = this.sessions.get(parts[1]);
        if (session === undefined) return this.send(res, 404, { error: 'not found' });
        session.state = 'busy';
        return this.send(res, 200, { started: true });
      }
      return this.send(res, 404, { error: 'not found' });
    } catch {
      return this.send(res, 500, { error: 'boom' });
    }
  }
}

/**
 * Write a fake `opencode` into `binDir` (prepended to PATH). It parses
 * `--server <url>` and `-s <id>`, flips the session to busy via `/__start`
 * when `flip` is true, then stays alive until TERM or ~20 s.
 */
async function writeFakeOpencode(controlDir: string, flip: boolean): Promise<string> {
  const binDir = path.join(controlDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const pidsFile = path.join(controlDir, 'opencode-pids');
  const flipLine = flip ? 'curl -s -X POST "$url/__start/$sid" >/dev/null 2>&1\n' : '';
  const content = `#!/bin/sh
[ "$1" = run ] || exit 9
echo "$$" >> "${pidsFile}"
prev=''
url=''
sid=''
for a in "$@"; do
  case "$prev" in
    --server) url=$a ;;
    -s) sid=$a ;;
  esac
  prev=$a
done
[ -n "$url" ] && [ -n "$sid" ] || exit 9
sleep 0.5
${flipLine}trap 'exit 143' TERM
i=0
while [ "$i" -lt 200 ]; do sleep 0.1; i=$((i + 1)); done
`;
  const scriptPath = path.join(binDir, 'opencode');
  await fs.writeFile(scriptPath, content, { mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return binDir;
}

async function killRecordedProcesses(pidsFile: string): Promise<void> {
  let pids: string[] = [];
  try {
    const raw = await fs.readFile(pidsFile, 'utf8');
    pids = raw.split('\n').filter(Boolean);
  } catch {
    return;
  }
  // The detached client runs in its own process group (setsid when available), so the
  // group is signalled first and its sleep children go with it; the pid itself after.
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, sig);
      } catch {
        // Already gone, or not a group leader.
      }
    }
  };
  for (const pid of pids) signal(Number(pid), 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const pid of pids) signal(Number(pid), 'SIGKILL');
}

const requiredCapabilities = {
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
} as const;

function makeStartRequest(
  overrides: Partial<StartRunnerSessionRequest> = {},
): StartRunnerSessionRequest {
  return {
    attemptId: 'att-it-1',
    worktreePath: '/tmp/fleet-it-worktree',
    briefPackagePath: '/tmp/fleet-it-worktree/.lane/brief.md',
    baseCommit: 'abc123',
    stepLimit: 50,
    timeLimitSeconds: 3600,
    requiredCapabilities,
    model: 'glm-5',
    ...overrides,
  };
}

/**
 * Environment keys the integration suite touches. The OCM/FLEET keys are
 * deleted before every run: a host operator's runner routing must never
 * point this suite at a real host.
 */
const SNAPSHOT_ENV_KEYS = [
  'HOME',
  'PATH',
  'OCM_HOST',
  'OCM_REMOTE_PORT',
  'OCM_PORT',
  'FLEET_OCM_RUN_BIN',
] as const;

function snapshotEnv(): Partial<Record<(typeof SNAPSHOT_ENV_KEYS)[number], string | undefined>> {
  const snapshot: Partial<Record<(typeof SNAPSHOT_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of SNAPSHOT_ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(
  snapshot: Partial<Record<(typeof SNAPSHOT_ENV_KEYS)[number], string | undefined>>,
): void {
  for (const key of SNAPSHOT_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

interface SetupContext {
  readonly adapter: ExecutionRunnerAdapter;
  readonly server: FakeOpencodeServer;
  readonly worktreePath: string;
  readonly cleanup: () => Promise<void>;
}

async function setup(flip: boolean): Promise<SetupContext> {
  const worktreePath = await makeTempDir('fleet-it-worktree-');
  const controlDir = await makeTempDir('fleet-it-control-');
  const homeDir = path.join(controlDir, 'home');
  await fs.mkdir(homeDir, { recursive: true });

  const server = new FakeOpencodeServer();
  const port = await server.port();
  const binDir = await writeFakeOpencode(controlDir, flip);
  const pidsFile = path.join(controlDir, 'opencode-pids');

  const originalEnv = snapshotEnv();
  process.env.HOME = homeDir;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  // The suite talks only to the fake in-process server it started itself.
  delete process.env.OCM_HOST;
  delete process.env.OCM_REMOTE_PORT;
  delete process.env.OCM_PORT;
  delete process.env.FLEET_OCM_RUN_BIN;

  const adapter = new ExecutionRunnerAdapter({
    remotePort: port,
    startBudgetSeconds: 10,
    ocmRunBin,
  });

  // Assertion-free guard: if operator routing reappears, starting a session
  // fails loudly instead of reaching a real host.
  const realStartSession = adapter.startSession.bind(adapter);
  Object.defineProperty(adapter, 'startSession', {
    value: (request: StartRunnerSessionRequest) => {
      if (process.env.OCM_HOST !== undefined) {
        throw new Error(
          'OCM_HOST is set while the integration suite starts a session; it must never reach a real host',
        );
      }
      return realStartSession(request);
    },
  });

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    pendingCleanups.delete(cleanup);
    try {
      await killRecordedProcesses(pidsFile);
      await server.close();
    } finally {
      restoreEnv(originalEnv);
    }
  };

  pendingCleanups.add(cleanup);
  return { adapter, server, worktreePath, cleanup };
}

describe.skipIf(!toolsAvailable)('ExecutionRunnerAdapter runs the real bin/ocm-run (integration)', () => {
  it('starts a session through the real ocm-run, reports it active and aborts it', { timeout: 60000 }, async () => {
    const ctx = await setup(true);
    try {
      const started = await ctx.adapter.startSession(
        makeStartRequest({ worktreePath: ctx.worktreePath }),
      );
      expect(started.outcome).toBe('started');
      if (started.outcome !== 'started') return;
      expect(started.sessionId).toMatch(/^ses_it\d+$/);
      expect(ctx.server.sessions.get(started.sessionId)?.state).toBe('busy');

      const status = await ctx.adapter.inspectSession({
        attemptId: 'att-it-1',
        sessionId: started.sessionId,
        worktreePath: ctx.worktreePath,
        runner: started.runner,
      });
      expect(status.runnerReachable).toBe('reachable');
      expect(status.workerCommand).toBe('active');

      const stop = await ctx.adapter.stopSession({
        attemptId: 'att-it-1',
        sessionId: started.sessionId,
        worktreePath: ctx.worktreePath,
        gracePeriodSeconds: 10,
        runner: started.runner,
      });
      expect(stop.outcome).toBe('terminated');
      expect(ctx.server.interrupts).toContain(started.sessionId);
      expect(ctx.server.sessions.has(started.sessionId)).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });

  it('returns unknown (never refused) when the session never becomes visible', { timeout: 60000 }, async () => {
    const ctx = await setup(false);
    try {
      const result = await ctx.adapter.startSession(
        makeStartRequest({ worktreePath: ctx.worktreePath }),
      );
      expect(result.outcome).toBe('unknown');
      // The start budget overran, so ocm-run aborted the created id itself.
      const createdId = ctx.server.createdIds[0] ?? '';
      expect(ctx.server.interrupts).toContain(createdId);
      expect(ctx.server.sessions.has(createdId)).toBe(false);
    } finally {
      await ctx.cleanup();
    }
  });
});
