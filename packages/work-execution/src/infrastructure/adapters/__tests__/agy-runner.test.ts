import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { StartRunnerSessionRequest } from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import {
  AGY_MODEL_PATTERN,
  AGY_RUNNER_ENV_ALLOWLIST,
  AgyRunnerAdapter,
  agyRunArgv,
  buildAgyRunnerEnv,
  parseAgyRunResult,
} from '../AgyRunnerAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

/**
 * Lane O14c2: the agy adapter runs on a fake `agy-run` script. The real agy is
 * never invoked and no other host is reached — the fake records the argv and
 * the environment it was handed and then behaves as `fake-mode` says.
 */

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const FAKE_AGY_RUN = `#!/bin/sh
# A fake agy-run: it is not the reviewed script and it runs no model. It records
# the argv it was handed and then answers as \`fake-mode\` in this directory says.
printf '%s\\n' "$0" "$@" > "__DIR__/args.log"
env | sort > "__DIR__/env.log"
case "$(cat "__DIR__/fake-mode")" in
  missing) echo "agy-run: agy is not on PATH" >&2; exit 1 ;;
  error) echo "agy-run: agy reported a model or agent error" >&2; exit 4 ;;
  empty) printf '{"conversation_id":"c1","status":"SUCCESS","response":""}'; exit 0 ;;
  nojson) echo "something went wrong"; exit 0 ;;
  busy) echo "agy-run: a lane is already running" >&2; exit 75 ;;
  hang) sleep 30; exit 0 ;;
  running) echo "agy-run: running in the worktree (pid 4242)"; exit 3 ;;
  abortfail) echo "agy-run: still running after the abort" >&2; exit 1 ;;
  *) printf '{"conversation_id":"c-conv-1","status":"SUCCESS","response":"Changed a.ts","duration_seconds":1.0,"num_turns":1,"usage":{"total_tokens":6}}'; exit 0 ;;
esac
`;

interface FakeLane {
  readonly dir: string;
  readonly bin: string;
}

/** A throwaway directory holding the fake `agy-run` and its mode file. */
async function makeFakeLane(): Promise<FakeLane> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-agy-lane-'));
  createdDirs.add(dir);
  const bin = path.join(dir, 'agy-run');
  await fs.writeFile(bin, FAKE_AGY_RUN.split('__DIR__').join(dir), { mode: 0o755 });
  await fs.chmod(bin, 0o755);
  await fs.writeFile(path.join(dir, 'fake-mode'), 'success', 'utf8');
  return { dir, bin };
}

async function fakeMode(lane: FakeLane, mode: string): Promise<void> {
  await fs.writeFile(path.join(lane.dir, 'fake-mode'), mode, 'utf8');
}

/** The argv the fake was invoked with, as recorded (argv[0] first). */
async function recordedArgv(lane: FakeLane): Promise<string[]> {
  const raw = await fs.readFile(path.join(lane.dir, 'args.log'), 'utf8');
  return raw.split('\n').filter((line) => line !== '');
}

/** The environment the fake was handed, as recorded (`NAME=value` per line). */
async function recordedEnv(lane: FakeLane): Promise<Record<string, string>> {
  const raw = await fs.readFile(path.join(lane.dir, 'env.log'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
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
    attemptId: 'att-1',
    worktreePath: '/lanes/att-1',
    briefPackagePath: '.lane/brief.md',
    baseCommit: 'abc123',
    stepLimit: 40,
    timeLimitSeconds: 3600,
    requiredCapabilities,
    model: 'gemini-3.1-pro',
    ...overrides,
  };
}

function agyRecord(overrides: Partial<AttemptRunnerRecord> = {}): AttemptRunnerRecord {
  return {
    kind: 'agy',
    remotePort: null,
    host: null,
    agent: null,
    model: 'gemini-3.1-pro',
    variant: null,
    ...overrides,
  };
}

function makeAdapter(
  lane: FakeLane,
  options: {
    mode?: 'edit-only' | 'full';
    transport?: 'local' | 'ssh';
    resolveAttempt?: () => AttemptRecord | null;
  } = {},
): AgyRunnerAdapter {
  return new AgyRunnerAdapter({
    executor: new LocalExecutor(),
    agyRunBin: lane.bin,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.resolveAttempt !== undefined
      ? { resolveAttempt: () => options.resolveAttempt?.() ?? null }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// The pinned argv per mode
// ---------------------------------------------------------------------------

describe('AgyRunnerAdapter argv (both modes)', () => {
  it('runs an edit-only lane with the pinned argv and no prompt', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane, { mode: 'edit-only' });

    const result = await adapter.startSession(makeStartRequest());

    expect(result.outcome).toBe('started');
    expect(await recordedArgv(lane)).toEqual([
      lane.bin,
      '--dir',
      '/lanes/att-1',
      '--model',
      'gemini-3.1-pro',
      '--mode',
      'accept-edits',
      '--detach',
    ]);
  });

  it('runs a full lane with --isolation-declared alongside --mode full', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane, { mode: 'full' });

    const result = await adapter.startSession(makeStartRequest());

    expect(result.outcome).toBe('started');
    expect(await recordedArgv(lane)).toEqual([
      lane.bin,
      '--dir',
      '/lanes/att-1',
      '--model',
      'gemini-3.1-pro',
      '--mode',
      'full',
      '--isolation-declared',
      '--detach',
    ]);
  });

  it('defaults to the conservative edit-only mode when a host declares none', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane);

    await adapter.startSession(makeStartRequest());

    const argv = await recordedArgv(lane);
    expect(argv).toContain('accept-edits');
    expect(argv).not.toContain('--isolation-declared');
  });

  it('never puts prompt text on the command line and never passes the agent or a variant', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane);

    const result = await adapter.startSession(
      makeStartRequest({
        briefPackagePath: '/lanes/att-1/.lane/brief.md',
        seatOverride: {
          model: 'gemini-3.8-flash',
          reason: 'operator override',
          setBy: 'owner',
          expiresAtIso: '2026-10-17T00:00:00.000Z',
        },
      }),
    );

    expect(result.outcome).toBe('started');
    expect(await recordedArgv(lane)).toEqual([
      lane.bin,
      '--dir',
      '/lanes/att-1',
      '--model',
      'gemini-3.8-flash',
      '--mode',
      'accept-edits',
      '--detach',
    ]);
  });

  it('refuses a seat that names an agent or a variant instead of running as another seat', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane);

    const withAgent = await adapter.startSession(makeStartRequest({ agent: 'reviewer' }));
    expect(withAgent).toEqual({
      outcome: 'refused',
      reason: "agy has no agent flag; the seat's agent 'reviewer' cannot be honoured",
    });
    const withVariant = await adapter.startSession(makeStartRequest({ variant: 'high' }));
    expect(withVariant).toEqual({
      outcome: 'refused',
      reason: "agy has no variant flag; the seat's variant 'high' cannot be honoured",
    });
    await expect(fs.access(path.join(lane.dir, 'args.log'))).rejects.toThrow();
  });

  it('refuses a session with no model and a session whose isolation is unsatisfied', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane, {
      resolveAttempt: () => null,
    });

    const noModel = await adapter.startSession(
      makeStartRequest({ model: '', seatOverride: undefined, modelAssignment: undefined }),
    );
    expect(noModel).toEqual({
      outcome: 'refused',
      reason: 'No model specified for runner session',
    });

    const unmet = new AgyRunnerAdapter({
      executor: new LocalExecutor(),
      agyRunBin: lane.bin,
      capabilities: { filesystemScope: 'inherited-directory' },
    });
    expect(await unmet.startSession(makeStartRequest())).toEqual({
      outcome: 'refused',
      reason: 'Runner does not satisfy required isolation capabilities',
    });
    await expect(fs.access(path.join(lane.dir, 'args.log'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The model is a value, never a flag
// ---------------------------------------------------------------------------

describe('AgyRunnerAdapter model validation', () => {
  /** An executor that must never be reached while the models are refused. */
  function zeroSpawnExecutor(): { port: CommandExecutorPort; spawns: string[] } {
    const spawns: string[] = [];
    const port: CommandExecutorPort = {
      async run(argv: readonly string[]) {
        spawns.push(argv.join(' '));
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    };
    return { port, spawns };
  }

  it('refuses a model that would become a flag before anything is spawned', async () => {
    const lane = await makeFakeLane();
    const { port, spawns } = zeroSpawnExecutor();
    const adapter = new AgyRunnerAdapter({ executor: port, agyRunBin: lane.bin });

    for (const model of ['--dangerously-skip-permissions', '-x', 'a b']) {
      expect(await adapter.startSession(makeStartRequest({ model }))).toEqual({
        outcome: 'refused',
        reason: `Refusing model '${model}': it must match ${AGY_MODEL_PATTERN.source} so it can never become a flag on agy's command line`,
      });
    }
    expect(spawns).toEqual([]);
    await expect(fs.access(path.join(lane.dir, 'args.log'))).rejects.toThrow();
  });

  it('refuses an empty, whitespace-padded or oversized model and a seat override with one', async () => {
    const lane = await makeFakeLane();
    const { port, spawns } = zeroSpawnExecutor();
    const adapter = new AgyRunnerAdapter({ executor: port, agyRunBin: lane.bin });

    expect(
      await adapter.startSession(
        makeStartRequest({
          model: 'gemini-3.1-pro',
          seatOverride: {
            model: '-x',
            reason: 'operator override',
            setBy: 'owner',
            expiresAtIso: '2026-10-17T00:00:00.000Z',
          },
        }),
      ),
    ).toEqual({
      outcome: 'refused',
      reason: `Refusing model '-x': it must match ${AGY_MODEL_PATTERN.source} so it can never become a flag on agy's command line`,
    });
    for (const model of [' model', 'model ', 'm\nx', 'm\tx', `${'a'.repeat(129)}`]) {
      expect(await adapter.startSession(makeStartRequest({ model }))).toMatchObject({
        outcome: 'refused',
      });
    }
    expect(spawns).toEqual([]);
    await expect(fs.access(path.join(lane.dir, 'args.log'))).rejects.toThrow();
  });

  it('accepts the reviewed model shapes on the pinned argv', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane);

    for (const model of ['gemini-3.1-pro', 'prov/model-x', 'z-ai/glm-5.3-flash', 'a'.repeat(128)]) {
      const result = await adapter.startSession(makeStartRequest({ model }));
      expect(result.outcome).toBe('started');
      expect(await recordedArgv(lane)).toContain(model);
    }
  });

  it('agyRunArgv refuses to build an argv for a flag-shaped model', () => {
    for (const model of ['--dangerously-skip-permissions', '-x', 'a b', '']) {
      expect(() =>
        agyRunArgv({ bin: 'agy-run', worktreePath: '/lanes/att-1', model, mode: 'edit-only' }),
      ).toThrow(/never become a flag on agy's command line/);
    }
  });
});

// ---------------------------------------------------------------------------
// The environment allow-list, per mode
// ---------------------------------------------------------------------------

describe('AgyRunnerAdapter environment allow-list (both modes)', () => {
  const planted: Record<string, string> = {
    SSH_AUTH_SOCK: '/tmp/fleet-agent.sock',
    GH_TOKEN: 'gho-planted',
    GITHUB_TOKEN: 'ghp-planted',
    GIT_SSH_COMMAND: 'ssh -i /tmp/fleet-key',
    GIT_AUTHOR_NAME: 'planted',
    OPENROUTER_API_KEY: 'or-planted',
    OPENROUTER_KEY: 'or-planted-key',
    ANTHROPIC_API_KEY: 'sk-planted',
    OPENAI_API_KEY: 'sk-planted-openai',
  };
  // Set every allow-listed variable so the whole list is exercised, not just
  // the subset this host happens to export.
  const allowed: Record<string, string> = {
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: '/tmp',
    AGY_BIN: '/usr/local/bin/agy',
  };
  const touched = [...Object.keys(planted), ...Object.keys(allowed)];
  const snapshot: Record<string, string | undefined> = Object.fromEntries(
    touched.map((key) => [key, process.env[key]]),
  );

  async function runLaneAndReadEnv(mode: 'edit-only' | 'full'): Promise<Record<string, string>> {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane, { mode });
    const result = await adapter.startSession(makeStartRequest());
    expect(result.outcome).toBe('started');
    return recordedEnv(lane);
  }

  it('keeps only the six lane variables and drops every credential, in both modes', async () => {
    try {
      for (const [key, value] of Object.entries({ ...planted, ...allowed })) {
        process.env[key] = value;
      }

      for (const mode of ['edit-only', 'full'] as const) {
        const env = await runLaneAndReadEnv(mode);

        // PATH and HOME come from this host; PWD is set by /bin/sh itself as it
        // starts, never by the adapter, which handed over the allow-list only.
        // SSH_AUTH_SOCK is planted here and must still be dropped: no ssh
        // transport is declared, so it belongs to no process in this lane.
        const laneAllowlist = AGY_RUNNER_ENV_ALLOWLIST.filter((key) => key !== 'SSH_AUTH_SOCK');
        expect(Object.keys(env).sort()).toEqual([...laneAllowlist, 'PWD'].sort());
        for (const key of Object.keys(allowed)) expect(env[key]).toBe(allowed[key]);
        // Named explicitly, per mode: the ssh agent, both GitHub tokens, every
        // GIT_* variable, every OPENROUTER* and every *_API_KEY.
        for (const key of Object.keys(planted)) expect(env[key]).toBeUndefined();
        expect(Object.keys(env).some((key) => /^(GIT_|OPENROUTER)/.test(key))).toBe(false);
        expect(Object.keys(env).some((key) => key.endsWith('_API_KEY'))).toBe(false);
      }
    } finally {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('names exactly the reviewed allow-list, with SSH_AUTH_SOCK as the ssh-only entry', () => {
    expect(AGY_RUNNER_ENV_ALLOWLIST).toEqual([
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'SSH_AUTH_SOCK',
      'AGY_BIN',
    ]);
  });

  it('builds the environment from the host variables and the overrides, never from process.env', () => {
    try {
      process.env['PATH'] = '/usr/bin:/bin';
      process.env['GITHUB_TOKEN'] = 'gho-planted';
      const env = buildAgyRunnerEnv({ AGY_BIN: '/opt/agy' });
      expect(env['PATH']).toBe('/usr/bin:/bin');
      expect(env['AGY_BIN']).toBe('/opt/agy');
      expect(env['GITHUB_TOKEN']).toBeUndefined();
    } finally {
      const previous = snapshot['GITHUB_TOKEN'];
      if (previous === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// The environment allow-list across executor transports (D5)
// ---------------------------------------------------------------------------

describe('AgyRunnerAdapter environment across transports', () => {
  const planted: Record<string, string> = {
    SSH_AUTH_SOCK: '/tmp/fleet-agent.sock',
    GH_TOKEN: 'gho-planted',
  };

  /** An executor that records the environment each run was handed, and spawns nothing. */
  function capturingExecutor(): { port: CommandExecutorPort; envs: Record<string, string>[] } {
    const envs: Record<string, string>[] = [];
    const port: CommandExecutorPort = {
      async run(_argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
        envs.push({ ...(options?.env ?? {}) });
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    };
    return { port, envs };
  }

  it('keeps SSH_AUTH_SOCK in the executor environment only for an ssh transport', async () => {
    const snapshot = Object.fromEntries(
      Object.entries(planted).map(([key]) => [key, process.env[key]]),
    );
    try {
      for (const [key, value] of Object.entries(planted)) process.env[key] = value;

      for (const transport of ['local', 'ssh'] as const) {
        const { port, envs } = capturingExecutor();
        const adapter = new AgyRunnerAdapter({
          executor: port,
          agyRunBin: 'agy-run',
          transport,
        });
        await adapter.startSession(makeStartRequest());

        // The env travels to the executor's local process: for ssh, the local
        // ssh client. The remote command never receives any of it.
        expect(envs).toHaveLength(1);
        if (transport === 'ssh') {
          expect(envs[0]['SSH_AUTH_SOCK']).toBe('/tmp/fleet-agent.sock');
        } else {
          expect(envs[0]['SSH_AUTH_SOCK']).toBeUndefined();
        }
        expect(envs[0]['GH_TOKEN']).toBeUndefined();
      }
    } finally {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('drops SSH_AUTH_SOCK from a built environment unless the transport is ssh', () => {
    const previous = process.env['SSH_AUTH_SOCK'];
    try {
      process.env['SSH_AUTH_SOCK'] = '/tmp/fleet-agent.sock';
      expect(buildAgyRunnerEnv(undefined, { transport: 'ssh' })['SSH_AUTH_SOCK']).toBe(
        '/tmp/fleet-agent.sock',
      );
      expect(buildAgyRunnerEnv(undefined, { transport: 'local' })['SSH_AUTH_SOCK']).toBeUndefined();
      expect(buildAgyRunnerEnv()['SSH_AUTH_SOCK']).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['SSH_AUTH_SOCK'];
      else process.env['SSH_AUTH_SOCK'] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// A failed run is failed, never an ambiguous start
// ---------------------------------------------------------------------------

describe('AgyRunnerAdapter failed runs', () => {
  it('maps exit 1 (agy missing or failed) to a failed run, never to unknown', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'missing');
    const result = await makeAdapter(lane).startSession(makeStartRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('agy run failed (exit 1)');
      expect(result.reason).toContain('agy-run: agy is not on PATH');
    }
  });

  it('maps exit 4 (a model or agent error) to a failed run', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'error');
    const result = await makeAdapter(lane).startSession(makeStartRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('agy run failed (exit 4)');
    }
  });

  it('maps an empty response to a failed run even when agy exited 0', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'empty');
    const result = await makeAdapter(lane).startSession(makeStartRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('agy run produced no response');
    }
  });

  it('maps output that is no agy result to a failed run', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'nojson');
    const result = await makeAdapter(lane).startSession(makeStartRequest());
    expect(result.outcome).toBe('refused');
  });

  it('refuses a busy worktree (exit 75) as a refusal, not as a failure to start', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'busy');
    const result = await makeAdapter(lane).startSession(makeStartRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Worktree already has an active session (agy-run exit 75)',
    });
  });

  it('treats an exceeded wall-clock budget (no exit code) as a failed run, never unknown', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'hang');
    const result = await makeAdapter(lane).startSession(
      makeStartRequest({ timeLimitSeconds: 1 }),
    );
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('ended without an exit status');
      expect(result.reason).toContain('agy-run --status');
    }
  });

  it('hands the request time limit to the executor as the lane budget', async () => {
    const lane = await makeFakeLane();
    const timeouts: (number | undefined)[] = [];
    const executor = {
      async run(argv: readonly string[], options?: { timeoutMs?: number }) {
        timeouts.push(options?.timeoutMs);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    };
    const adapter = new AgyRunnerAdapter({
      executor,
      agyRunBin: lane.bin,
    });
    await adapter.startSession(makeStartRequest({ timeLimitSeconds: 900 }));
    expect(timeouts).toEqual([900_000]);
  });
});

// ---------------------------------------------------------------------------
// Records, inspect and stop
// ---------------------------------------------------------------------------

describe('AgyRunnerAdapter records, inspect and stop', () => {
  it('records kind agy with no port', () => {
    expect(makeAdapter({ dir: '/tmp', bin: '/tmp/agy-run' }).describeRunner()).toEqual({
      kind: 'agy',
      remotePort: null,
      host: null,
      agent: null,
      model: null,
      variant: null,
    });
  });

  it('returns the started run under an agy record with a null port', async () => {
    const lane = await makeFakeLane();
    const result = await makeAdapter(lane).startSession(makeStartRequest());
    expect(result).toEqual({
      outcome: 'started',
      sessionId: 'c-conv-1',
      runner: {
        kind: 'agy',
        remotePort: null,
        host: null,
        agent: null,
        model: 'gemini-3.1-pro',
        variant: null,
      },
    });
  });

  it('falls back to an attempt-bound session id when agy printed no conversation id', () => {
    expect(parseAgyRunResult('{"status":"SUCCESS","response":"done"}')).toEqual({
      conversationId: null,
      response: 'done',
    });
    expect(parseAgyRunResult('not json at all')).toBeNull();
    expect(parseAgyRunResult('')).toBeNull();
  });

  it('reports a running lane as active through agy-run --status', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'running');
    const adapter = makeAdapter(lane);

    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'c-conv-1',
      worktreePath: '/lanes/att-1',
      runner: agyRecord(),
    });

    expect(await recordedArgv(lane)).toEqual([
      lane.bin,
      '--status',
      '--dir',
      '/lanes/att-1',
    ]);
    expect(status).toEqual({
      runnerReachable: 'reachable',
      workspacePreparation: 'prepared',
      workerCommand: 'active',
      completionReceipt: null,
      artifactsCollected: false,
    });
  });

  it('reports an ended lane with an authoritative receipt and no invented exit status', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'success');
    const adapter = makeAdapter(lane);

    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'c-conv-1',
      worktreePath: '/lanes/att-1',
      runner: agyRecord(),
    });

    expect(status.workerCommand).toBe('ended');
    expect(status.completionReceipt).toMatchObject({
      attemptId: 'att-1',
      sessionId: 'c-conv-1',
      authoritative: true,
      exitStatus: null,
      stoppedByRequest: false,
    });
  });

  it('reports nothing observed when the runner could not be asked', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'missing');
    const adapter = makeAdapter(lane);

    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'c-conv-1',
      worktreePath: '/lanes/att-1',
      runner: agyRecord(),
    });

    expect(status).toEqual({
      runnerReachable: 'unknown',
      workspacePreparation: 'unprepared',
      workerCommand: 'not-started',
      completionReceipt: null,
      artifactsCollected: false,
    });
  });

  it('never reaches agy-run for a lane that is not recorded as agy', async () => {
    const lane = await makeFakeLane();
    const adapter = makeAdapter(lane);

    const opencodeSession = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_1',
      worktreePath: '/lanes/att-1',
      runner: { ...agyRecord(), kind: 'opencode', remotePort: 4166 },
    });
    expect(opencodeSession.runnerReachable).toBe('unknown');
    expect(
      await adapter.stopSession({
        attemptId: 'att-1',
        sessionId: 'ses_1',
        gracePeriodSeconds: 10,
        worktreePath: '/lanes/att-1',
        runner: { ...agyRecord(), kind: 'opencode', remotePort: 4166 },
      }),
    ).toEqual({
      outcome: 'refused',
      reason: 'Worktree directory not resolved for agy session abort',
    });
    await expect(fs.access(path.join(lane.dir, 'args.log'))).rejects.toThrow();
  });

  it('resolves the worktree from the recorded attempt when the session omits it', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'running');
    const attempt = {
      worktreePath: '/lanes/from-record',
      runner: agyRecord(),
    } as AttemptRecord;
    const adapter = makeAdapter(lane, { resolveAttempt: () => attempt });

    const status = await adapter.inspectSession({ attemptId: 'att-1', sessionId: 'c-conv-1' });

    expect(status.workerCommand).toBe('active');
    expect(await recordedArgv(lane)).toEqual([
      lane.bin,
      '--status',
      '--dir',
      '/lanes/from-record',
    ]);
  });

  it('stops a lane through agy-run --abort and records the stop', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'success');
    const adapter = makeAdapter(lane);

    const result = await adapter.stopSession({
      attemptId: 'att-1',
      sessionId: 'c-conv-1',
      gracePeriodSeconds: 10,
      worktreePath: '/lanes/att-1',
      runner: agyRecord(),
    });

    expect(await recordedArgv(lane)).toEqual([lane.bin, '--abort', '--dir', '/lanes/att-1']);
    expect(result.outcome).toBe('terminated');
    if (result.outcome === 'terminated') {
      expect(result.receipt).toMatchObject({
        attemptId: 'att-1',
        sessionId: 'c-conv-1',
        authoritative: true,
        exitStatus: null,
        stoppedByRequest: true,
      });
    }
  });

  it('keeps the lane running when agy-run --abort did not confirm the stop', async () => {
    const lane = await makeFakeLane();
    await fakeMode(lane, 'abortfail');
    const adapter = makeAdapter(lane);

    const result = await adapter.stopSession({
      attemptId: 'att-1',
      sessionId: 'c-conv-1',
      gracePeriodSeconds: 10,
      worktreePath: '/lanes/att-1',
      runner: agyRecord(),
    });

    expect(result.outcome).toBe('still-running');
  });
});