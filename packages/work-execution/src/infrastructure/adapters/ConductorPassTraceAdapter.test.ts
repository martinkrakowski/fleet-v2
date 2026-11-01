import { mkdtempSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConductorPassTraceAdapter } from './ConductorPassTraceAdapter.adapter.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LIMITS = { maxActiveRuns: 2, passConcurrency: 1, dispatchStaggerMs: 20000 };

/** A valid append input for pass `n`; carries no schemaVersion, like the real result. */
function trace(n: number) {
  return {
    passId: `pass-${n}`,
    nowIso: NOW,
    holderId: 'driver-x',
    halted: false,
    progressed: true,
    runs: [
      {
        runId: RUN_ID,
        outcome: 'advanced',
        steps: [{ outcome: 'entered', state: 'running' }],
      },
    ],
    attention: [{ runId: RUN_ID, kind: 'stop-grace-exceeded' }],
  };
}

/** A stored record for direct file fixtures: the shape `append` writes. */
function storedTrace(n: number) {
  return {
    ...trace(n),
    maxActiveRuns: LIMITS.maxActiveRuns,
    passConcurrency: LIMITS.passConcurrency,
    dispatchStaggerMs: LIMITS.dispatchStaggerMs,
    runs: [{ runId: RUN_ID, report: { outcome: 'advanced', steps: [{ outcome: 'entered', state: 'running' }] } }],
  };
}

describe('ConductorPassTraceAdapter', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => {})),
    );
  });

  function makeTempDir(): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fleet-conductor-pass-test-'));
    tempDirs.push(directory);
    return directory;
  }

  it('a: append records and list reads it back; the file holds one version-1 trace', async () => {
    const tempDir = makeTempDir();
    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    expect(await adapter.append(trace(1))).toEqual({ outcome: 'recorded', passId: 'pass-1' });

    const listed = await adapter.list();
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      expect(listed.traces).toHaveLength(1);
      expect(listed.traces[0]!.maxActiveRuns).toBe(2);
      expect(listed.traces[0]!.schemaVersion).toBe(1);
    }

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'conductor-passes.json'), 'utf8')) as unknown[];
    expect(raw).toHaveLength(1);
    expect((raw[0] as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  it('b: the ring bounds at 32 newest traces and leaves only the data file behind', async () => {
    const tempDir = makeTempDir();
    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    for (let n = 1; n <= 40; n += 1) {
      expect((await adapter.append(trace(n))).outcome).toBe('recorded');
    }

    const listed = await adapter.list();
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      expect(listed.traces).toHaveLength(32);
      expect(listed.traces[0]!.passId).toBe('pass-9');
      expect(listed.traces.at(-1)!.passId).toBe('pass-40');
    }

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'conductor-passes.json'), 'utf8')) as unknown[];
    expect(raw).toHaveLength(32);
    expect(await fs.readdir(tempDir)).toEqual(['conductor-passes.json']);
  });

  it('c: an unknown schema version refuses the append byte-identically and lists unreadable', async () => {
    const tempDir = makeTempDir();
    const file = path.join(tempDir, 'conductor-passes.json');
    const fileBytes = Buffer.from(JSON.stringify([{ ...storedTrace(1), schemaVersion: 2 }]));
    await fs.writeFile(file, fileBytes);

    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    expect(await adapter.append(trace(2))).toEqual({ outcome: 'not-recorded', reason: 'unknown-schema-version' });
    expect(await fs.readFile(file)).toEqual(fileBytes);
    expect(await adapter.list()).toEqual({ outcome: 'unreadable', reason: 'unknown-schema-version' });
  });

  it('d: an unreadable file refuses the append byte-identically and lists unreadable', async () => {
    const tempDir = makeTempDir();
    const file = path.join(tempDir, 'conductor-passes.json');
    const fileBytes = Buffer.from('{ not json');
    await fs.writeFile(file, fileBytes);

    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    expect(await adapter.append(trace(1))).toEqual({ outcome: 'not-recorded', reason: 'store-unreadable' });
    expect(await fs.readFile(file)).toEqual(fileBytes);
    expect(await adapter.list()).toEqual({ outcome: 'unreadable', reason: 'store-unreadable' });
  });

  it('e: a missing schemaVersion lists as version 1 and append succeeds', async () => {
    const tempDir = makeTempDir();
    const file = path.join(tempDir, 'conductor-passes.json');
    await fs.writeFile(file, JSON.stringify([storedTrace(1)]));

    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    const listed = await adapter.list();
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      expect(listed.traces[0]!.schemaVersion).toBe(1);
    }
    expect(await adapter.append(trace(2))).toEqual({ outcome: 'recorded', passId: 'pass-2' });
    const after = await adapter.list();
    expect(after.outcome).toBe('listed');
    if (after.outcome === 'listed') {
      expect(after.traces).toHaveLength(2);
    }
  });

  it('f: a stateDir that is a regular file never throws; a colliding fileName writes failed', async () => {
    const container = makeTempDir();
    const filePath = path.join(container, 'not-a-dir');
    await fs.writeFile(filePath, 'plain file');

    const adapter = new ConductorPassTraceAdapter({ stateDir: filePath, limits: LIMITS });
    await expect(adapter.append(trace(1))).resolves.toMatchObject({
      outcome: 'not-recorded',
      reason: 'write-failed',
    });
    await expect(adapter.list()).resolves.toMatchObject({ outcome: 'unreadable', reason: 'store-unreadable' });

    const tempDir = makeTempDir();
    const colliding = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS, fileName: 'lane-runs.json' });
    await expect(colliding.append(trace(1))).resolves.toMatchObject({
      outcome: 'not-recorded',
      reason: 'write-failed',
    });
    await expect(colliding.list()).resolves.toMatchObject({ outcome: 'unreadable', reason: 'store-unreadable' });

    const unsafe = new ConductorPassTraceAdapter({ stateDir: makeTempDir(), limits: LIMITS, fileName: '../x.json' });
    await expect(unsafe.append(trace(1))).resolves.toMatchObject({
      outcome: 'not-recorded',
      reason: 'write-failed',
    });
    await expect(unsafe.list()).resolves.toMatchObject({ outcome: 'unreadable', reason: 'store-unreadable' });
  });

  it('g: a held lock times out with write-failed and creates no data file', async () => {
    const tempDir = makeTempDir();
    const file = path.join(tempDir, 'conductor-passes.json');
    await fs.writeFile(`${file}.lock`, '99999-abcdef-1234567890');

    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS, lockTimeoutMs: 50 });
    expect(await adapter.append(trace(1))).toEqual({ outcome: 'not-recorded', reason: 'write-failed' });
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('h: missing limits or readOnly refuse without creating a file', async () => {
    const tempDir = makeTempDir();
    const noLimits = new ConductorPassTraceAdapter({ stateDir: tempDir });
    expect(await noLimits.append(trace(1))).toEqual({ outcome: 'not-recorded', reason: 'limits-unset' });

    const readOnly = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS, readOnly: true });
    expect(await readOnly.append(trace(1))).toEqual({ outcome: 'not-recorded', reason: 'read-only' });

    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('i: invalid input writes nothing', async () => {
    const tempDir = makeTempDir();
    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    const bad = {
      passId: 'pass-1',
      nowIso: NOW,
      holderId: 'driver-x',
      halted: false,
      progressed: true,
      runs: [{ runId: 'nope', outcome: 'skipped', reason: 'lease-held' }],
      attention: [],
    };
    expect(await adapter.append(bad)).toEqual({ outcome: 'not-recorded', reason: 'invalid-trace' });
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('m: a limits object carrying schemaVersion fails as invalid-trace and a valid one stamps version 1', async () => {
    const tempDir = makeTempDir();
    const hijacked = new ConductorPassTraceAdapter({
      stateDir: tempDir,
      limits: { ...LIMITS, schemaVersion: 2 } as never,
    });
    expect(await hijacked.append(trace(1))).toEqual({ outcome: 'not-recorded', reason: 'invalid-trace' });
    expect(await fs.readdir(tempDir)).toEqual([]);

    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    expect(await adapter.append(trace(1))).toEqual({ outcome: 'recorded', passId: 'pass-1' });
    const listed = await adapter.list();
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      expect(listed.traces[0]!.schemaVersion).toBe(1);
    }
  });

  it('j: the in-memory ring bounds at 32 without a stateDir', async () => {
    const adapter = new ConductorPassTraceAdapter({ limits: LIMITS });
    for (let n = 1; n <= 33; n += 1) {
      expect((await adapter.append(trace(n))).outcome).toBe('recorded');
    }
    const listed = await adapter.list();
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      expect(listed.traces).toHaveLength(32);
      expect(listed.traces[0]!.passId).toBe('pass-2');
      expect(listed.traces.at(-1)!.passId).toBe('pass-33');
    }
  });

  it('l: list on a fresh directory is empty and leaves it empty, also read-only', async () => {
    const tempDir = makeTempDir();
    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir });
    expect(await adapter.list()).toEqual({ outcome: 'listed', traces: [] });
    expect(await fs.readdir(tempDir)).toEqual([]);

    const readOnly = new ConductorPassTraceAdapter({ stateDir: tempDir, readOnly: true });
    expect(await readOnly.list()).toEqual({ outcome: 'listed', traces: [] });
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('k: two parallel appends both record and the ring holds both', async () => {
    const tempDir = makeTempDir();
    const adapter = new ConductorPassTraceAdapter({ stateDir: tempDir, limits: LIMITS });
    const results = await Promise.all([adapter.append(trace(1)), adapter.append(trace(2))]);
    expect(results).toEqual([
      { outcome: 'recorded', passId: 'pass-1' },
      { outcome: 'recorded', passId: 'pass-2' },
    ]);
    const listed = await adapter.list();
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      expect(listed.traces).toHaveLength(2);
    }
  });
});
