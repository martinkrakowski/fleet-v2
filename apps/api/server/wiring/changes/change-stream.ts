// One open GET /v1/changes connection: reads the in-memory change feed by
// cursor on a timer, queues JSON lines with a bound, and turns overflow,
// a stale cursor or a lost stream into a resync line (plan §3.1, §4.3).
import type { ChangeFeed, FeedEntry } from "./change-feed";

export interface ChangeStreamSink {
  /** false means backpressure: stop writing until drain(). */
  write(chunk: string): boolean;
  end(): void;
}

export interface ChangeStreamOptions {
  readonly feed: ChangeFeed;
  readonly after: string | null;
  readonly sink: ChangeStreamSink;
  readonly isLive?: () => boolean;
  readonly pollMs?: number;
  readonly keepAliveMs?: number;
  readonly maxQueue?: number;
  readonly now?: () => Date;
}

export const CHANGE_STREAM_POLL_MS = 250;
export const CHANGE_STREAM_KEEP_ALIVE_MS = 15_000;
export const CHANGE_STREAM_MAX_QUEUE = 256;
export const CHANGE_STREAM_MAX_OPEN = 64;
export const KEEP_ALIVE_LINE = "\n";

let openStreams = 0;
let maxOpen = CHANGE_STREAM_MAX_OPEN;

/** Open streams in this process; tests use it to prove a closed connection stops. */
export function openChangeStreamCount(): number {
  return openStreams;
}

/** The route refuses a new stream once openChangeStreamCount() reaches this. */
export function changeStreamMaxOpen(): number {
  return maxOpen;
}

/** Test-only cap override; tests restore CHANGE_STREAM_MAX_OPEN in finally. */
export function setChangeStreamMaxOpenForTests(max: number): void {
  maxOpen = max;
}

function toLine(entry: FeedEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export class ChangeStream {
  private readonly feed: ChangeFeed;
  private readonly sink: ChangeStreamSink;
  private readonly isLive: () => boolean;
  private readonly pollMs: number;
  private readonly keepAliveMs: number;
  private readonly maxQueue: number;
  private readonly now: () => Date;
  private cursor: string | null;
  private readonly queue: string[] = [];
  private blocked = false;
  private resyncPending = false;
  private state: "new" | "open" | "closed" = "new";
  private pollTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(options: ChangeStreamOptions) {
    this.feed = options.feed;
    this.sink = options.sink;
    this.cursor = options.after;
    this.isLive = options.isLive ?? (() => true);
    this.pollMs = options.pollMs ?? CHANGE_STREAM_POLL_MS;
    this.keepAliveMs = options.keepAliveMs ?? CHANGE_STREAM_KEEP_ALIVE_MS;
    this.maxQueue = options.maxQueue ?? CHANGE_STREAM_MAX_QUEUE;
    this.now = options.now ?? (() => new Date());
  }

  get queuedLines(): number {
    return this.queue.length;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  /** Opens the stream and runs the first step synchronously. */
  start(): void {
    if (this.state !== "new") {
      return;
    }
    this.state = "open";
    openStreams += 1;
    this.pollTimer = setInterval(() => this.step(), this.pollMs);
    this.keepAliveTimer = setInterval(() => this.keepAlive(), this.keepAliveMs);
    this.step();
  }

  /** The sink can take writes again. */
  drain(): void {
    if (this.state !== "open") {
      return;
    }
    this.blocked = false;
    this.flush();
  }

  /** Stops both timers and drops the queue. Idempotent; does not end the sink. */
  close(): void {
    if (this.state === "open") {
      openStreams -= 1;
    }
    this.state = "closed";
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.queue.length = 0;
  }

  private step(): void {
    if (this.state !== "open") {
      return;
    }
    if (!this.isLive()) {
      this.close();
      this.sink.end();
      return;
    }
    if (this.resyncPending) {
      // The pending resync moves the cursor to head once it is written;
      // reading now would only queue lines that are stale by then.
      return;
    }
    const read = this.feed.read(this.cursor);
    this.cursor = read.cursor;
    if (read.kind === "resync") {
      this.requestResync();
    } else {
      for (const entry of read.entries) {
        this.queue.push(toLine(entry));
      }
      if (this.queue.length > this.maxQueue) {
        this.requestResync();
      }
    }
    this.flush();
  }

  private requestResync(): void {
    this.queue.length = 0;
    this.resyncPending = true;
  }

  private flush(): void {
    while (this.state === "open" && !this.blocked) {
      const next = this.nextLine();
      if (next === null) {
        return;
      }
      if (!this.sink.write(next)) {
        this.blocked = true;
      }
    }
  }

  private nextLine(): string | null {
    if (this.resyncPending) {
      this.resyncPending = false;
      // Nothing queued before the resync may be written after it.
      this.queue.length = 0;
      const seq = this.feed.headSeq;
      this.cursor = `${this.feed.streamId}:${seq}`;
      return toLine({
        stream: this.feed.streamId,
        seq,
        kind: "resync",
        id: null,
        at: this.now().toISOString(),
      });
    }
    return this.queue.shift() ?? null;
  }

  private keepAlive(): void {
    if (this.state !== "open" || this.blocked) {
      return;
    }
    if (!this.sink.write(KEEP_ALIVE_LINE)) {
      this.blocked = true;
    }
  }
}
