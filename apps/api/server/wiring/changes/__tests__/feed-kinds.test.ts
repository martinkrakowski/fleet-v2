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

const FILE = '/example/store.json';

const STORE_KINDS = ['owner-item', 'plan', 'merge', 'forge-observation'];

describe('feed kinds', () => {
  it.each(STORE_KINDS)('a %s signal appends one entry', (kind) => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    const signal: ChangeSignalLike = {
      kind,
      id: `${kind}-1`,
      stateFile: FILE,
      before: null,
      written: null,
    };
    feed.emit(signal);
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toHaveLength(1);
      expect(snapshot.entries[0]).toEqual({
        stream: 'stream',
        seq: 1,
        kind,
        id: `${kind}-1`,
        at: new Date(0).toISOString(),
      });
    }
  });

  it.each(['heartbeat', 'attention-item'])(
    'a %s signal records stamps and appends nothing',
    (kind) => {
      const feed = new ChangeFeed({
        streamId: 'stream',
        now: () => new Date(0),
      });
      const before = stamp({ mtimeMs: 1, size: 10, ino: 1 });
      const written = stamp({ mtimeMs: 2, size: 20, ino: 1 });
      feed.emit({
        kind,
        id: `${kind}-1`,
        stateFile: FILE,
        before,
        written,
      });
      const snapshot = feed.read('stream:0');
      expect(snapshot.kind).toBe('entries');
      if (snapshot.kind === 'entries') {
        expect(snapshot.entries).toEqual([]);
      }
      expect(feed.lastLocalWrite(FILE)).toEqual(written);
    },
  );

  it('an unknown kind appends nothing', () => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    feed.emit({
      kind: 'bogus',
      id: 'whatever',
      stateFile: FILE,
      before: null,
      written: null,
    });
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toEqual([]);
    }
  });

  it('a plan signal with a foreign before stamp appends a resync then its entry', () => {
    const feed = new ChangeFeed({
      streamId: 'stream',
      now: () => new Date(0),
    });
    const before = stamp({ mtimeMs: 1, size: 10, ino: 1 });
    const written = stamp({ mtimeMs: 2, size: 20, ino: 1 });
    feed.emit({
      kind: 'heartbeat',
      id: 'orch-example-1',
      stateFile: FILE,
      before,
      written,
    });
    feed.emit({
      kind: 'plan',
      id: 'plan-1',
      stateFile: FILE,
      before: stamp({ mtimeMs: 3, size: 30, ino: 1 }),
      written: null,
    });
    const snapshot = feed.read('stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'resync',
        'plan',
      ]);
    }
  });
});
