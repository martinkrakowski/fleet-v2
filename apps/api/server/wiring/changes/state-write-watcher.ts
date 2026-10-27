// Watches the store files whose saves emit change signals and turns foreign
// writes (a CLI run, another API process) into a resync on the shared change
// feed. The watcher's own process writes are recognized through the feed's
// last-local-write stamps and are never reported as foreign.
import { promises as fs } from "node:fs";
import type { ChangeFeed, FileStamp } from "./change-feed";

export interface StateWriteWatcherOptions {
  readonly feed: ChangeFeed;
  readonly files: readonly string[];
  readonly intervalMs?: number;
  readonly stat?: (file: string) => Promise<FileStamp | null>;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function sameStamp(
  left: FileStamp | null | undefined,
  right: FileStamp | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return left === right;
  }
  return (
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.ino === right.ino
  );
}

export class StateWriteWatcher {
  private readonly feed: ChangeFeed;
  private readonly files: readonly string[];
  private readonly intervalMs: number;
  private readonly statFn: ((file: string) => Promise<FileStamp | null>) | undefined;
  private readonly lastObserved = new Map<string, FileStamp | null>();
  private timer: NodeJS.Timeout | null = null;
  private statFailuresCount = 0;

  constructor(options: StateWriteWatcherOptions) {
    this.feed = options.feed;
    this.files = options.files;
    this.intervalMs = options.intervalMs ?? 2000;
    this.statFn = options.stat;
  }

  get statFailures(): number {
    return this.statFailuresCount;
  }

  async tick(): Promise<void> {
    const stamps = await Promise.all(
      this.files.map(async (file) => this.stat(file)),
    );
    let foreignChanged = false;
    for (let i = 0; i < this.files.length; i += 1) {
      const file = this.files[i]!;
      const stamp = stamps[i]!;
      const previous = this.lastObserved.get(file);
      if (previous === undefined) {
        // First observation sets the baseline; it is never foreign.
        this.lastObserved.set(file, stamp);
        continue;
      }
      if (
        !sameStamp(previous, stamp) &&
        !sameStamp(stamp, this.feed.lastLocalWrite(file))
      ) {
        foreignChanged = true;
      }
      this.lastObserved.set(file, stamp);
    }
    if (foreignChanged) {
      this.feed.resync();
    }
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // A failed tick never crashes the process; stat failures are counted.
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async stat(file: string): Promise<FileStamp | null> {
    if (this.statFn !== undefined) {
      return this.statFn(file);
    }
    try {
      const stats = await fs.stat(file);
      return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
    } catch (error: unknown) {
      if (isEnoent(error)) {
        return null;
      }
      this.statFailuresCount += 1;
      return null;
    }
  }
}
