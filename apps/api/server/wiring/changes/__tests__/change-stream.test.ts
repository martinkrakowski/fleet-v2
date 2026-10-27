import { describe, expect, it, vi } from 'vitest';
import { ChangeFeed } from '../change-feed.js';
import { ChangeStream, openChangeStreamCount } from '../change-stream.js';

function fakeSink(accept: () => boolean = () => true) {
  const chunks: string[] = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    sink: { write: (c: string) => { chunks.push(c); return accept(); }, end: () => { ended = true; } },
  };
}

const lines = (chunks: string[]) =>
  chunks.filter((c) => c !== '\n').map((c) => JSON.parse(c) as Record<string, unknown>);

const signal = (id: string) =>
  ({ kind: 'attempt', id, stateFile: null, before: null, written: null });

const makeFeed = () =>
  new ChangeFeed({ streamId: 's1', now: () => new Date('2026-10-27T00:00:00.000Z') });

describe('ChangeStream', () => {
  it('after null starts with a control resync', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: null, sink: fake.sink });
    try {
      stream.start();
      const parsed = lines(fake.chunks);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        stream: 's1',
        seq: 0,
        kind: 'resync',
        id: null,
      });
      expect(typeof parsed[0]!.at).toBe('string');
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a foreign-stream cursor starts with a resync then delivers new entries', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    feed.emit(signal('att-1'));
    feed.emit(signal('att-2'));
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: 's0:5', sink: fake.sink });
    try {
      stream.start();
      const parsed = lines(fake.chunks);
      expect(parsed[0]).toMatchObject({ stream: 's1', seq: 2, kind: 'resync', id: null });
      feed.emit(signal('att-3'));
      vi.advanceTimersByTime(250);
      const all = lines(fake.chunks);
      expect(all[all.length - 1]).toMatchObject({ kind: 'attempt', id: 'att-3', seq: 3 });
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a current-history cursor delivers newer entries in order without a resync', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    feed.emit(signal('att-1'));
    feed.emit(signal('att-2'));
    feed.emit(signal('att-3'));
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: 's1:1', sink: fake.sink });
    try {
      stream.start();
      const parsed = lines(fake.chunks);
      expect(parsed.map((e) => e.seq)).toEqual([2, 3]);
      expect(parsed.every((e) => e.kind === 'attempt')).toBe(true);
      expect(parsed.some((e) => e.kind === 'resync')).toBe(false);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a current cursor writes nothing until the next signal', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    feed.emit(signal('att-1'));
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: 's1:1', sink: fake.sink });
    try {
      stream.start();
      expect(fake.chunks).toEqual([]);
      feed.emit(signal('att-2'));
      vi.advanceTimersByTime(250);
      const parsed = lines(fake.chunks);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ kind: 'attempt', id: 'att-2', seq: 2 });
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a malformed or ahead-of-head cursor starts with a resync', () => {
    vi.useFakeTimers();
    try {
      for (const bad of ['s1:abc', 's1:99']) {
        const feed = makeFeed();
        feed.emit(signal('att-1'));
        const fake = fakeSink();
        const stream = new ChangeStream({ feed, after: bad, sink: fake.sink });
        try {
          stream.start();
          const parsed = lines(fake.chunks);
          expect(parsed).toHaveLength(1);
          expect(parsed[0]).toMatchObject({ stream: 's1', kind: 'resync', id: null });
        } finally {
          stream.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('ring overflow makes a stale cursor start with a resync', () => {
    vi.useFakeTimers();
    const feed = new ChangeFeed({
      streamId: 's1',
      capacity: 16,
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    });
    for (let i = 1; i <= 20; i += 1) {
      feed.emit(signal(`att-${i}`));
    }
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink });
    try {
      stream.start();
      const parsed = lines(fake.chunks);
      expect(parsed[0]).toMatchObject({ stream: 's1', kind: 'resync', id: null });
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a slow client drops the queue and receives a resync', () => {
    vi.useFakeTimers();
    let accepting = false;
    const feed = makeFeed();
    const fake = fakeSink(() => accepting);
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink, maxQueue: 8 });
    try {
      stream.start();
      feed.emit(signal('att-1'));
      vi.advanceTimersByTime(250);
      expect(fake.chunks).toHaveLength(1);
      for (let i = 2; i <= 21; i += 1) {
        feed.emit(signal(`att-${i}`));
      }
      vi.advanceTimersByTime(250);
      expect(stream.queuedLines).toBe(0);
      expect(fake.chunks).toHaveLength(1);
      accepting = true;
      stream.drain();
      const afterDrain = lines(fake.chunks);
      expect(afterDrain[afterDrain.length - 1]).toMatchObject({
        kind: 'resync',
        seq: feed.headSeq,
        stream: 's1',
      });
      feed.emit(signal('att-22'));
      vi.advanceTimersByTime(250);
      const all = lines(fake.chunks);
      expect(all[all.length - 1]).toMatchObject({
        kind: 'attempt',
        id: 'att-22',
        seq: feed.headSeq,
      });
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a resync drops queued lines and stops polling until it is written', () => {
    vi.useFakeTimers();
    let accepting = false;
    const feed = makeFeed();
    const fake = fakeSink(() => accepting);
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink, maxQueue: 8 });
    try {
      stream.start();
      feed.emit(signal('att-1'));
      vi.advanceTimersByTime(250);
      // the first write is refused, so the sink is blocked from here on
      expect(fake.chunks).toHaveLength(1);
      for (let i = 2; i <= 21; i += 1) {
        feed.emit(signal(`att-${i}`));
      }
      // one poll reads 20 entries, so the queue overflows into a pending resync
      vi.advanceTimersByTime(250);
      expect(stream.queuedLines).toBe(0);
      // three more emits, then another poll: nothing may be queued while the resync is pending
      feed.emit(signal('att-22'));
      feed.emit(signal('att-23'));
      feed.emit(signal('att-24'));
      vi.advanceTimersByTime(250);
      expect(stream.queuedLines).toBe(0);
      const beforeDrain = fake.chunks.length;
      accepting = true;
      stream.drain();
      // exactly one line comes out: the resync at the current head, and no data lines after it
      const drained = lines(fake.chunks.slice(beforeDrain));
      expect(drained).toHaveLength(1);
      expect(drained[0]).toMatchObject({
        kind: 'resync',
        seq: feed.headSeq,
        stream: 's1',
        id: null,
      });
      // a further emit and poll then deliver normally
      feed.emit(signal('att-25'));
      vi.advanceTimersByTime(250);
      const all = lines(fake.chunks);
      expect(all[all.length - 1]).toMatchObject({
        kind: 'attempt',
        id: 'att-25',
        seq: feed.headSeq,
      });
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('backpressure queues lines without dropping until the queue overflows', () => {
    vi.useFakeTimers();
    let accepting = false;
    const feed = makeFeed();
    const fake = fakeSink(() => accepting);
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink, maxQueue: 8 });
    try {
      stream.start();
      feed.emit(signal('att-1'));
      vi.advanceTimersByTime(250);
      expect(fake.chunks).toHaveLength(1);
      feed.emit(signal('att-2'));
      feed.emit(signal('att-3'));
      feed.emit(signal('att-4'));
      vi.advanceTimersByTime(250);
      expect(stream.queuedLines).toBe(3);
      expect(fake.chunks).toHaveLength(1);
      accepting = true;
      stream.drain();
      expect(stream.queuedLines).toBe(0);
      const parsed = lines(fake.chunks);
      expect(parsed.slice(1).map((e) => e.seq)).toEqual([2, 3, 4]);
      expect(parsed.slice(1).map((e) => e.kind)).toEqual(['attempt', 'attempt', 'attempt']);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('keep-alive sends a blank line every 15 seconds unless blocked', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink });
    try {
      stream.start();
      vi.advanceTimersByTime(15_000);
      expect(fake.chunks.filter((c) => c === '\n')).toHaveLength(1);
      vi.advanceTimersByTime(15_000);
      expect(fake.chunks.filter((c) => c === '\n')).toHaveLength(2);

      const blockedFeed = makeFeed();
      const fakeBlocked = fakeSink(() => false);
      const blockedStream = new ChangeStream({ feed: blockedFeed, after: 's1:0', sink: fakeBlocked.sink });
      blockedStream.start();
      blockedFeed.emit(signal('att-1'));
      vi.advanceTimersByTime(250);
      expect(fakeBlocked.chunks).toHaveLength(1);
      vi.advanceTimersByTime(15_000);
      expect(fakeBlocked.chunks.filter((c) => c === '\n')).toHaveLength(0);
      blockedStream.close();
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('close stops both timers and decrements the open count', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    const fake = fakeSink();
    const before = openChangeStreamCount();
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink });
    try {
      stream.start();
      expect(openChangeStreamCount()).toBe(before + 1);
      expect(vi.getTimerCount()).toBe(2);
      stream.close();
      expect(openChangeStreamCount()).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
      feed.emit(signal('att-1'));
      vi.advanceTimersByTime(30_000);
      expect(fake.chunks).toEqual([]);
      stream.close();
      stream.close();
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a lost feed ends the sink and closes the stream', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    let live = true;
    const fake = fakeSink();
    const before = openChangeStreamCount();
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink, isLive: () => live });
    try {
      stream.start();
      live = false;
      vi.advanceTimersByTime(250);
      expect(fake.ended).toBe(true);
      expect(stream.isOpen).toBe(false);
      expect(openChangeStreamCount()).toBe(before);
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });

  it('a feed resync entry passes through as a line', () => {
    vi.useFakeTimers();
    const feed = makeFeed();
    feed.emit(signal('att-1'));
    feed.resync();
    const fake = fakeSink();
    const stream = new ChangeStream({ feed, after: 's1:0', sink: fake.sink });
    try {
      stream.start();
      const parsed = lines(fake.chunks);
      expect(parsed).toHaveLength(2);
      expect(parsed[1]).toMatchObject({ kind: 'resync', seq: 2, stream: 's1', id: null });
    } finally {
      stream.close();
      vi.useRealTimers();
    }
  });
});
