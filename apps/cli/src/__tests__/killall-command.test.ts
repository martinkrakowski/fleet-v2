// KILLALL CLI tests — KA2.
/**
 * `fleet-v2 killall` and `killall --lift`: marker first, then the train pause,
 * then the stop agent, then the report (plan §6). Uses real mkdtempSync state
 * directories (no hand-written file stubs) and a fake KillallStopAgentPort that
 * records call order and returns scripted results; no test runs a real stop.
 */

import { existsSync, mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { KillallStopAgentPort, KillallStopAgentResult } from '@fleet/work-execution';

import { runCli, type CliIo } from '../index.js';

const NOW = '2026-10-27T10:00:00.000Z';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
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

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-killall-test-'));
}

const tempDirs: string[] = [];

function trackedStateDir(): string {
  const dir = tempStateDir();
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

/** Run one killall invocation with the given options and return its exit code and captured streams. */
async function runKillall(
  args: readonly string[],
  io: CapturedIo,
  options: { readonly now?: () => string; readonly stateDir?: string; readonly stopAgent?: KillallStopAgentPort },
): Promise<number> {
  return runCli(
    ['killall', ...args],
    io,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
}

function parseStdoutDoc(io: CapturedIo): Record<string, unknown> {
  expect(io.outLines).toHaveLength(1);
  return JSON.parse(io.outLines[0]!) as Record<string, unknown>;
}

async function readFirstRecord(stateDir: string, basename: string): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(await fs.readFile(join(stateDir, basename), 'utf8'));
  expect(Array.isArray(raw)).toBe(true);
  return (raw as unknown[])[0] as Record<string, unknown>;
}

/** A fake stop agent that records call order and whether the marker and pause stores existed when it ran. */
class RecordingStopAgent implements KillallStopAgentPort {
  readonly calls: string[] = [];
  readonly sawMarker: boolean[] = [];
  readonly sawPause: boolean[] = [];

  constructor(
    private readonly respond: (haltedAtIso: string) => KillallStopAgentResult,
    private readonly stateDir: string,
  ) {}

  async stop(request: { readonly haltedAtIso: string }): Promise<KillallStopAgentResult> {
    this.calls.push(request.haltedAtIso);
    this.sawMarker.push(existsSync(join(this.stateDir, 'killall-halt.json')));
    this.sawPause.push(existsSync(join(this.stateDir, 'killall-train-pause.json')));
    return this.respond(request.haltedAtIso);
  }
}

/** A report `killallStopReportConfirmed` accepts: marker halted, train confirmed, whole-sweep clean, every lane confirmed. */
function confirmedResponse(haltedAtIso: string): KillallStopAgentResult {
  return {
    ok: true,
    payload: {
      version: 1,
      haltedAtIso,
      marker: 'halted',
      cleanSweeps: 2,
      lanes: [
        {
          projectId: 'proj-a',
          laneId: 'lane-1',
          confirmed: true,
          unconfirmedReason: null,
          cleanSweeps: 2,
          confirmedAtIso: haltedAtIso,
          sessionResults: [{ sessionRef: 'sess-1', stopped: true }],
        },
      ],
      train: { paused: true, acknowledged: true, unconfirmedReason: null },
    },
  };
}

/** A report with one unconfirmed lane: `killallStopReportConfirmed` is false. */
function unconfirmedLaneResponse(haltedAtIso: string): KillallStopAgentResult {
  return {
    ok: true,
    payload: {
      version: 1,
      haltedAtIso,
      marker: 'halted',
      cleanSweeps: 2,
      lanes: [
        {
          projectId: 'proj-a',
          laneId: 'lane-1',
          confirmed: false,
          unconfirmedReason: 'not-stopped',
          cleanSweeps: 0,
          confirmedAtIso: null,
          sessionResults: [],
        },
      ],
      train: { paused: true, acknowledged: true, unconfirmedReason: null },
    },
  };
}

function malformedResponse(): KillallStopAgentResult {
  return { ok: true, payload: { bogus: true } };
}

function unavailableResponse(): KillallStopAgentResult {
  return { ok: false, reason: 'unavailable' };
}

describe('fleet-v2 killall halt flow', () => {
  it('calls marker set, then pause set, then the stop agent, and exits 0 on a confirmed report (rule 3)', async () => {
    const stateDir = trackedStateDir();
    const clockSnapshots: Array<{ readonly marker: boolean; readonly pause: boolean }> = [];
    const now = () => {
      clockSnapshots.push({
        marker: existsSync(join(stateDir, 'killall-halt.json')),
        pause: existsSync(join(stateDir, 'killall-train-pause.json')),
      });
      return NOW;
    };
    const agent = new RecordingStopAgent(confirmedResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now, stateDir, stopAgent: agent });

    expect(code).toBe(0);
    expect(clockSnapshots).toEqual([
      { marker: false, pause: false },
      { marker: true, pause: false },
    ]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.sawMarker).toEqual([true]);
    expect(agent.sawPause).toEqual([true]);

    const marker = await readFirstRecord(stateDir, 'killall-halt.json');
    expect(agent.calls[0]).toBe(marker.changedAtIso);

    const doc = parseStdoutDoc(io);
    expect(doc.outcome).toBe('completed');
    expect(doc.marker).toBe('halted');
    expect(doc.confirmed).toBe(true);
    expect((doc.train as { paused?: unknown }).paused).toBe(true);
    expect((doc.report as { version?: unknown }).version).toBe(1);
  });

  it('when the marker write refuses, the pause and agent are never called and exit is 1 (rule 3)', async () => {
    const stateDir = trackedStateDir();
    const agent = new RecordingStopAgent(confirmedResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now: () => 'not-a-time', stateDir, stopAgent: agent });

    expect(code).toBe(1);
    expect(agent.calls).toEqual([]);
    await expect(fs.access(join(stateDir, 'killall-train-pause.json'))).rejects.toThrow();
    expect(parseStdoutDoc(io)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('never echoes a state-dir path or file content on failure (rule 4)', async () => {
    const stateDir = trackedStateDir();
    const garbage = '{ not json CANARY-bytes';
    await fs.writeFile(join(stateDir, 'killall-halt.json'), garbage, 'utf8');
    const agent = new RecordingStopAgent(unavailableResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now: () => NOW, stateDir, stopAgent: agent });

    expect(code).toBe(1);
    const all = [...io.outLines, ...io.errLines].join('\n');
    expect(all).not.toContain(stateDir);
    expect(all).not.toContain(garbage);
    expect(all).not.toContain('quarantine');
    const doc = parseStdoutDoc(io);
    expect((doc.train as { unconfirmedReason?: unknown }).unconfirmedReason).toBe('sweep-unreachable');
  });

  it('exits 0 only on a confirmed report (rule 6a)', async () => {
    const stateDir = trackedStateDir();
    const agent = new RecordingStopAgent(confirmedResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now: () => NOW, stateDir, stopAgent: agent });
    expect(code).toBe(0);
  });

  it('exits 1 when one lane is unconfirmed (rule 6b)', async () => {
    const stateDir = trackedStateDir();
    const agent = new RecordingStopAgent(unconfirmedLaneResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now: () => NOW, stateDir, stopAgent: agent });
    expect(code).toBe(1);
    const doc = parseStdoutDoc(io);
    expect(doc.confirmed).toBe(false);
  });

  it('prints an unconfirmed report and exits 1 when the stop agent is unavailable, with the fail-closed rule named (rule 6c)', async () => {
    const stateDir = trackedStateDir();
    const agent = new RecordingStopAgent(unavailableResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now: () => NOW, stateDir, stopAgent: agent });
    expect(code).toBe(1);

    const doc = parseStdoutDoc(io);
    expect(doc.version).toBe(1);
    expect(doc.marker).toBe('halted');
    expect(doc.cleanSweeps).toBe(0);
    expect(doc.lanes).toEqual([]);
    expect(doc.train).toEqual({
      paused: true,
      acknowledged: false,
      unconfirmedReason: 'sweep-unreachable',
    });
  });

  it('exits 1 with fixed text on a malformed agent payload, never the payload (rule 6d)', async () => {
    const stateDir = trackedStateDir();
    const agent = new RecordingStopAgent(malformedResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now: () => NOW, stateDir, stopAgent: agent });
    expect(code).toBe(1);
    expect(parseStdoutDoc(io)).toEqual({ outcome: 'refused', reason: 'stop agent report unreadable' });
  });

  it('exits 2 on an unknown subcommand (rule 6e)', async () => {
    const stateDir = trackedStateDir();
    const io = captureIo();
    const code = await runKillall(['halt'], io, { now: () => NOW, stateDir });
    expect(code).toBe(2);
    expect(io.errLines.join('\n')).toContain('killall');
  });

  it('never echoes unknown arguments or stray paths on usage error (finding 2 / rule 4)', async () => {
    const stateDir = trackedStateDir();
    const io = captureIo();
    const canaryHost = 'secret-lane-host.internal';
    const canaryPath = '/var/secrets/runner-worktree';
    const code = await runKillall([canaryHost, canaryPath], io, { now: () => NOW, stateDir });

    expect(code).toBe(2);
    const errText = io.errLines.join('\n');
    expect(errText).not.toContain(canaryHost);
    expect(errText).not.toContain(canaryPath);
    expect(errText).toContain('Usage: fleet-v2 killall [--lift]');
    expect(io.outLines).toHaveLength(0);
  });

  it('exits 2 without a durable state directory (rule 6f)', async () => {
    const saved = process.env.FLEET_STATE_DIR;
    delete process.env.FLEET_STATE_DIR;
    try {
      const io = captureIo();
      const code = await runKillall([], io, { now: () => NOW });
      expect(code).toBe(2);
      expect(io.errLines.join('\n')).toContain('killall requires a durable state directory');
    } finally {
      if (saved !== undefined) {
        process.env.FLEET_STATE_DIR = saved;
      }
    }
  });

  it('dispatches killall without composing runtime when installation is invalid (finding 1)', async () => {
    const stateDir = trackedStateDir();
    const badInstallation = join(stateDir, 'corrupt-installation.json');
    await fs.writeFile(badInstallation, '{ invalid JSON content\n', 'utf8');

    const savedEnv = process.env.FLEET_INSTALLATION_FILE;
    process.env.FLEET_INSTALLATION_FILE = badInstallation;

    try {
      const agent = new RecordingStopAgent(confirmedResponse, stateDir);
      const io = captureIo();
      const code = await runCli(
        ['killall', '--state-dir', stateDir],
        io,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { now: () => NOW, stopAgent: agent },
      );

      expect(code).toBe(0);
      expect(agent.calls).toHaveLength(1);
      expect(existsSync(join(stateDir, 'killall-halt.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'killall-train-pause.json'))).toBe(true);
      const doc = parseStdoutDoc(io);
      expect(doc.outcome).toBe('completed');
      expect(doc.marker).toBe('halted');
      expect(io.errLines).toHaveLength(0);
    } finally {
      if (savedEnv !== undefined) {
        process.env.FLEET_INSTALLATION_FILE = savedEnv;
      } else {
        delete process.env.FLEET_INSTALLATION_FILE;
      }
    }
  });

  it('uses a fresh clock for each write, so the pause time differs from the marker time (rule 5)', async () => {
    const stateDir = trackedStateDir();
    const times = ['2026-10-27T10:00:00.000Z', '2026-10-27T10:01:00.000Z'];
    let index = 0;
    const now = () => times[index++] ?? times[times.length - 1];
    const agent = new RecordingStopAgent(confirmedResponse, stateDir);
    const io = captureIo();
    const code = await runKillall([], io, { now, stateDir, stopAgent: agent });
    expect(code).toBe(0);

    const marker = await readFirstRecord(stateDir, 'killall-halt.json');
    const pause = await readFirstRecord(stateDir, 'killall-train-pause.json');
    expect(pause.requestedAtIso).not.toBe(marker.changedAtIso);
    expect(agent.calls).toEqual([marker.changedAtIso]);
  });
});

describe('fleet-v2 killall --lift', () => {
  it('after a halt, lift clears the pause then the marker and exits 0 (rule 6)', async () => {
    const stateDir = trackedStateDir();
    const agent = new RecordingStopAgent(confirmedResponse, stateDir);

    const haltIo = captureIo();
    const haltCode = await runKillall([], haltIo, { now: () => NOW, stateDir, stopAgent: agent });
    expect(haltCode).toBe(0);

    const liftIo = captureIo();
    const liftCode = await runKillall(['--lift'], liftIo, { now: () => NOW, stateDir });
    expect(liftCode).toBe(0);
    expect(parseStdoutDoc(liftIo)).toEqual({ outcome: 'completed', marker: 'clear', train: 'clear' });

    const pause = await readFirstRecord(stateDir, 'killall-train-pause.json');
    expect(pause.paused).toBe(false);
    const marker = await readFirstRecord(stateDir, 'killall-halt.json');
    expect(marker.halted).toBe(false);
  });

  it('refuses an unreadable marker: the pause clears, the marker stays halted, and a later halt still writes (rule 6)', async () => {
    const stateDir = trackedStateDir();
    const garbage = '{ not json';
    await fs.writeFile(join(stateDir, 'killall-halt.json'), garbage, 'utf8');

    const liftIo = captureIo();
    const liftCode = await runKillall(['--lift'], liftIo, { now: () => NOW, stateDir });
    expect(liftCode).toBe(1);
    expect(parseStdoutDoc(liftIo)).toEqual({ outcome: 'refused', reason: 'marker-unreadable' });
    expect(await fs.readFile(join(stateDir, 'killall-halt.json'), 'utf8')).toBe(garbage);

    const agent = new RecordingStopAgent(confirmedResponse, stateDir);
    const haltIo = captureIo();
    const haltCode = await runKillall([], haltIo, { now: () => NOW, stateDir, stopAgent: agent });
    expect(haltCode).toBe(0);
    const marker = await readFirstRecord(stateDir, 'killall-halt.json');
    expect(marker.halted).toBe(true);
  });
});
