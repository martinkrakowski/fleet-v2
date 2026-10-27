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

function entries(feed: ChangeFeed, cursor: string): ReturnType<ChangeFeed['read']> {
  return feed.read(cursor);
}

describe('ChangeFeed', () => {
  it('a burst of 20 emits gives seq 1..20 in order and read from stream:0 returns all 20', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    for (let i = 1; i <= 20; i += 1) {
      feed.emit({
        kind: 'attempt',
        id: `att-${i}`,
        stateFile: null,
        before: null,
        written: null,
      });
    }
    const snapshot = entries(feed, 'stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toHaveLength(20);
      expect(snapshot.entries.map((entry) => entry.seq)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual(
        Array(20).fill('attempt'),
      );
      expect(snapshot.cursor).toBe('stream:20');
    }
  });

  it('read from the current cursor returns 0 entries', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    for (let i = 1; i <= 20; i += 1) {
      feed.emit({
        kind: 'attempt',
        id: `att-${i}`,
        stateFile: null,
        before: null,
        written: null,
      });
    }
    const snapshot = entries(feed, 'stream:20');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toEqual([]);
    }
  });

  it('read(null), a different stream, stream:abc and an above-current seq all return resync', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    feed.emit({
      kind: 'attempt',
      id: 'att-1',
      stateFile: null,
      before: null,
      written: null,
    });
    expect(feed.read(null).kind).toBe('resync');
    expect(feed.read('other:0').kind).toBe('resync');
    expect(feed.read('stream:abc').kind).toBe('resync');
    expect(feed.read('stream:21').kind).toBe('resync');
  });

  it('ring overflow drops the oldest entries and reports resync for a dropped range', () => {
    const feed = new ChangeFeed({ streamId: 'stream', capacity: 16 });
    for (let i = 1; i <= 40; i += 1) {
      feed.emit({
        kind: 'work-order',
        id: `wo-${i}`,
        stateFile: null,
        before: null,
        written: null,
      });
    }
    expect(feed.read('stream:1').kind).toBe('resync');
    const snapshot = entries(feed, 'stream:30');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.seq)).toEqual(
        Array.from({ length: 10 }, (_, i) => i + 31),
      );
    }
  });

  it('detects a foreign write between two local writes and appends a resync before the second entry', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    const file = '/tmp/state/attempts.json';
    feed.emit({
      kind: 'attempt',
      id: 'att-1',
      stateFile: file,
      before: null,
      written: stamp({ ino: 1 }),
    });
    feed.emit({
      kind: 'attempt',
      id: 'att-2',
      stateFile: file,
      before: stamp({ ino: 2 }),
      written: stamp({ ino: 3 }),
    });
    const snapshot = entries(feed, 'stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'attempt',
        'resync',
        'attempt',
      ]);
    }
  });

  it('no resync when the before stamp matches our last local write', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    const file = '/tmp/state/attempts.json';
    const a = stamp({ ino: 1 });
    feed.emit({
      kind: 'attempt',
      id: 'att-1',
      stateFile: file,
      before: null,
      written: a,
    });
    feed.emit({
      kind: 'attempt',
      id: 'att-2',
      stateFile: file,
      before: a,
      written: stamp({ ino: 1, size: 11 }),
    });
    const snapshot = entries(feed, 'stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries.map((entry) => entry.kind)).toEqual([
        'attempt',
        'attempt',
      ]);
    }
  });

  it('an unknown kind adds nothing', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    feed.emit({
      kind: 'bogus',
      id: 'x',
      stateFile: null,
      before: null,
      written: null,
    });
    const snapshot = entries(feed, 'stream:0');
    expect(snapshot.kind).toBe('entries');
    if (snapshot.kind === 'entries') {
      expect(snapshot.entries).toEqual([]);
    }
  });

  it('a signal whose getter throws is swallowed, counted in emitFailures and turned into a resync', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    const signal = {
      id: 'x',
      stateFile: null,
      before: null,
      written: null,
    } as unknown as ChangeSignalLike;
    Object.defineProperty(signal, 'kind', {
      get(): string {
        throw new Error('kind getter failed');
      },
    });
    expect(() => feed.emit(signal)).not.toThrow();
    expect(feed.emitFailures).toBe(1);
    const read = feed.read('stream:0');
    expect(read.kind).toBe('entries');
    if (read.kind === 'entries') {
      expect(read.entries.map((entry) => entry.kind)).toEqual(['resync']);
    }
  });

  it('rejects a capacity below 16', () => {
    expect(() => new ChangeFeed({ capacity: 8 })).toThrow();
  });

  it('headSeq is 0 on a new feed and tracks emitted entries and resyncs', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    expect(feed.headSeq).toBe(0);
    feed.emit({
      kind: 'attempt',
      id: 'att-1',
      stateFile: null,
      before: null,
      written: null,
    });
    feed.emit({
      kind: 'attempt',
      id: 'att-2',
      stateFile: null,
      before: null,
      written: null,
    });
    expect(feed.headSeq).toBe(2);
    feed.resync();
    expect(feed.headSeq).toBe(3);
  });

  it('isRecentLocalWrite recalls only the last 8 local stamps for a file', () => {
    const feed = new ChangeFeed({ streamId: 'stream' });
    const file = '/tmp/state/attempts.json';
    for (let i = 1; i <= 9; i += 1) {
      feed.emit({
        kind: 'attempt',
        id: `att-${i}`,
        stateFile: file,
        before: null,
        written: stamp({ size: i }),
      });
    }
    expect(feed.isRecentLocalWrite(file, stamp({ size: 1 }))).toBe(false);
    for (let i = 2; i <= 9; i += 1) {
      expect(feed.isRecentLocalWrite(file, stamp({ size: i }))).toBe(true);
    }
    expect(feed.isRecentLocalWrite('/tmp/state/other.json', stamp({ size: 9 }))).toBe(false);
    expect(feed.isRecentLocalWrite(file, null)).toBe(false);
  });
});
