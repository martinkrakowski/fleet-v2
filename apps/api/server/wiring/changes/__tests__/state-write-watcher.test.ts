import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttemptRepositoryAdapter,
  WorkOrderRepositoryAdapter,
  type AttemptRecord,
  type WorkOrderRecord,
} from '@fleet/work-execution';
import { ChangeFeed, type FileStamp } from '../change-feed.js';
import { StateWriteWatcher } from '../state-write-watcher.js';
import { configureFleetApiRuntime, getChangeFeed } from '../../runtime.js';

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/worktree-1',
    baseCommit: 'commit-1',
    state: 'dispatching',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'org/repo',
    baseCommit: 'commit-1',
    ownedPaths: [],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 0,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('StateWriteWatcher', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-state-write-watcher-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function stampOf(file: string): Promise<FileStamp> {
    const s = await fs.stat(file);
    return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
  }

  it('the first tick on an existing file gives no resync', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    await fs.writeFile(target, JSON.stringify([]), 'utf8');
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toEqual([]);
    }
  });

  it('a save through the change-signal adapter then a tick gives one attempt entry and no resync', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const adapter = new AttemptRepositoryAdapter({ stateDir: dir, changeSignal: feed });
    await adapter.saveAttempt(makeAttempt({ id: 'att-a' }));
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual(['attempt']);
    }
  });

  it('a CLI-style save without a change signal then two ticks give one resync', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const adapter = new AttemptRepositoryAdapter({ stateDir: dir, changeSignal: feed });
    await adapter.saveAttempt(makeAttempt({ id: 'att-a' }));
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick();

    const cli = new AttemptRepositoryAdapter({ stateDir: dir });
    await cli.saveAttempt(makeAttempt({ id: 'att-b' }));

    await watcher.tick();
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'attempt',
        'resync',
      ]);
    }
  });

  it('two foreign changes to two files in two ticks give exactly one resync', async () => {
    const attemptsTarget = path.resolve(path.join(dir, 'attempts.json'));
    const ordersTarget = path.resolve(path.join(dir, 'work-orders.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({
      feed,
      files: [attemptsTarget, ordersTarget],
    });
    await watcher.tick(); // baseline: both files missing -> null

    const attempts = new AttemptRepositoryAdapter({ stateDir: dir, changeSignal: feed });
    await attempts.saveAttempt(makeAttempt({ id: 'att-a' }));
    const orders = new WorkOrderRepositoryAdapter({ stateDir: dir, changeSignal: feed });
    await orders.saveWorkOrder(makeWorkOrder({ id: 'wo-a' }));

    const cliAttempts = new AttemptRepositoryAdapter({ stateDir: dir });
    await cliAttempts.saveAttempt(makeAttempt({ id: 'att-b' }));
    const cliOrders = new WorkOrderRepositoryAdapter({ stateDir: dir });
    await cliOrders.saveWorkOrder(makeWorkOrder({ id: 'wo-b' }));

    await watcher.tick();
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'attempt',
        'work-order',
        'resync',
      ]);
    }
  });

  it('a file that appears after a missing baseline counts as a change and gives a resync after two ticks', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick(); // baseline: missing -> null

    const cli = new AttemptRepositoryAdapter({ stateDir: dir });
    await cli.saveAttempt(makeAttempt());

    await watcher.tick();
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual(['resync']);
    }
  });

  it('start() seeds the baseline so a save before the first tick is foreign', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    await fs.writeFile(target, JSON.stringify([]), 'utf8');
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target], intervalMs: 60_000 });
    try {
      watcher.start();

      const cli = new AttemptRepositoryAdapter({ stateDir: dir });
      await cli.saveAttempt(makeAttempt({ id: 'att-cli' }));

      await watcher.tick();
      await watcher.tick();
      const snapshot = feed.read('stream:0');
      expect(snapshot.kind).toBe('entries');
      if (snapshot.kind === 'entries') {
        expect(snapshot.entries.map((entry) => entry.kind)).toEqual(['resync']);
      }
    } finally {
      watcher.stop();
    }
  });

  it('a tick between the adapter rename and emit gives no resync', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick(); // baseline: missing -> null

    await fs.writeFile(target, '[1]'); // stands in for the adapter's rename
    await watcher.tick(); // suspect
    feed.emit({
      kind: 'attempt',
      id: 'att-x',
      stateFile: target,
      before: null,
      written: await stampOf(target),
    });
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual(['attempt']);
    }
  });

  it('a burst of two own writes in one interval gives no resync', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick(); // baseline: missing -> null

    await fs.writeFile(target, '[1]');
    await watcher.tick(); // suspect
    const first = await stampOf(target);
    feed.emit({
      kind: 'attempt',
      id: 'att-1',
      stateFile: target,
      before: null,
      written: first,
    });

    await fs.writeFile(target, '[1,2]');
    const second = await stampOf(target);
    feed.emit({
      kind: 'attempt',
      id: 'att-2',
      stateFile: target,
      before: first,
      written: second,
    });
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'attempt',
        'attempt',
      ]);
    }
  });

  it('a foreign write just before our first own write still resyncs', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick(); // baseline: missing -> null

    const cli = new AttemptRepositoryAdapter({ stateDir: dir });
    await cli.saveAttempt(makeAttempt({ id: 'att-cli' }));
    await watcher.tick(); // suspect

    const adapter = new AttemptRepositoryAdapter({ stateDir: dir, changeSignal: feed });
    await adapter.saveAttempt(makeAttempt({ id: 'att-a' }));
    await watcher.tick();
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'attempt',
        'resync',
      ]);
    }
  });

  it('a deleted file is foreign after two ticks', async () => {
    const target = path.resolve(path.join(dir, 'attempts.json'));
    await fs.writeFile(target, JSON.stringify([]), 'utf8');
    const feed = new ChangeFeed({ streamId: 'stream' });
    const watcher = new StateWriteWatcher({ feed, files: [target] });
    await watcher.tick(); // baseline: exists

    await fs.rm(target);
    await watcher.tick();
    const firstSnapshot = feed.read('stream:0');
    expect(firstSnapshot.kind).toBe('entries');
    if (firstSnapshot.kind === 'entries') {
      expect(firstSnapshot.entries).toEqual([]);
    }

    await watcher.tick();
    const secondSnapshot = feed.read('stream:0');
    expect(secondSnapshot.kind).toBe('entries');
    if (secondSnapshot.kind === 'entries') {
      expect(secondSnapshot.entries.map((entry) => entry.kind)).toEqual(['resync']);
    }
  });

  it('start() is idempotent and stop() clears the interval without throwing', () => {
    vi.useFakeTimers();
    try {
      const feed = new ChangeFeed({ streamId: 'stream' });
      const watcher = new StateWriteWatcher({ feed, files: [], intervalMs: 100 });
      const tickSpy = vi.spyOn(watcher, 'tick').mockResolvedValue(undefined);
      watcher.start();
      watcher.start();
      vi.advanceTimersByTime(200);
      expect(tickSpy).toHaveBeenCalledTimes(2);
      watcher.stop();
      watcher.stop();
      vi.advanceTimersByTime(200);
      expect(tickSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runtime wiring of the change feed', () => {
  it('configuring with a stateDir creates a change feed', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-runtime-change-feed-'));
    try {
      configureFleetApiRuntime({ stateDir });
      expect(getChangeFeed()).not.toBeNull();
    } finally {
      configureFleetApiRuntime(null);
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('configureFleetApiRuntime(null) clears the change feed', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-runtime-change-feed-'));
    try {
      configureFleetApiRuntime({ stateDir });
      expect(getChangeFeed()).not.toBeNull();
      configureFleetApiRuntime(null);
      expect(getChangeFeed()).toBeNull();
    } finally {
      configureFleetApiRuntime(null);
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a relative stateDir resolves watched paths to match the stores and causes no resync on local save', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-runtime-rel-'));
    const originalCwd = process.cwd();
    const parentDir = path.dirname(stateDir);
    const relativeStateDir = path.basename(stateDir);
    const captured: { watcher?: StateWriteWatcher } = {};
    const originalStart = StateWriteWatcher.prototype.start;
    StateWriteWatcher.prototype.start = function (this: StateWriteWatcher): void {
      captured.watcher = this;
    };
    try {
      process.chdir(parentDir);
      configureFleetApiRuntime({ stateDir: relativeStateDir });
      const feed = getChangeFeed();
      expect(feed).not.toBeNull();
      expect(captured.watcher).toBeDefined();
      if (feed === null || captured.watcher === undefined) {
        throw new Error('expected configured change feed and watcher');
      }
      await captured.watcher.tick();
      const adapter = new AttemptRepositoryAdapter({
        stateDir: relativeStateDir,
        changeSignal: feed,
      });
      await adapter.saveAttempt(makeAttempt({ id: 'att-rel' }));
      await captured.watcher.tick();
      const snapshot = feed.read(`${feed.streamId}:0`);
      expect(snapshot.kind).toBe('entries');
      if (snapshot.kind === 'entries') {
        expect(snapshot.entries.map((entry) => entry.kind)).toEqual(['attempt']);
      }
    } finally {
      StateWriteWatcher.prototype.start = originalStart;
      configureFleetApiRuntime(null);
      process.chdir(originalCwd);
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
