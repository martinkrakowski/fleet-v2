import { describe, expect, it } from 'vitest';
import {
  ChangeFeed,
  type ChangeSignalLike,
  type FileStamp,
} from '../change-feed.js';

function stamp(overrides: Partial<FileStamp> = {}): FileStamp {
  return {
    mtimeMs: 1000,
    size: 10,
    ino: 1,
    ...overrides,
  };
}

const FILE = '/example/orchestrators.json';

function emitOrchestrator(feed: ChangeFeed, id: string, before: FileStamp | null): void {
  const signal: ChangeSignalLike = {
    kind: 'orchestrator',
    id,
    stateFile: before === null ? null : FILE,
    before,
    written: null,
  };
  feed.emit(signal);
}

function emitHeartbeat(feed: ChangeFeed, before: FileStamp, written: FileStamp): void {
  feed.emit({
    kind: 'heartbeat',
    id: 'orch-example-1',
    stateFile: FILE,
    before,
    written,
  });
}

describe('orchestrator feed kind', () => {
  it('an orchestrator signal appends one entry', () => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    emitOrchestrator(feed, 'orch-example-1', null);
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toHaveLength(1);
      expect(snapshot.entries[0]).toEqual({
        stream: 'stream',
        seq: 1,
        kind: 'orchestrator',
        id: 'orch-example-1',
        at: new Date(0).toISOString(),
      });
    }
  });

  it('a heartbeat signal records stamps and appends nothing', () => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    const before = stamp({ mtimeMs: 1, size: 10, ino: 1 });
    const written = stamp({ mtimeMs: 2, size: 20, ino: 1 });
    emitHeartbeat(feed, before, written);
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toEqual([]);
    }
    expect(feed.lastLocalWrite(FILE)).toEqual(written);
  });

  it('an orchestrator signal whose before matches a local heartbeat stamp does not resync', () => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    const before = stamp({ mtimeMs: 1, size: 10, ino: 1 });
    const written = stamp({ mtimeMs: 2, size: 20, ino: 1 });
    emitHeartbeat(feed, before, written);
    emitOrchestrator(feed, 'orch-example-2', written);
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual(['orchestrator']);
    }
  });

  it('an orchestrator signal with a foreign before stamp appends a resync then its entry', () => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    const before = stamp({ mtimeMs: 1, size: 10, ino: 1 });
    const written = stamp({ mtimeMs: 2, size: 20, ino: 1 });
    emitHeartbeat(feed, before, written);
    emitOrchestrator(feed, 'orch-example-2', stamp({ mtimeMs: 3, size: 30, ino: 1 }));
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'resync',
        'orchestrator',
      ]);
    }
  });
});
