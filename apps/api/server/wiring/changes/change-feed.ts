// In-memory change feed: every file-backed repository save in this process
// emits a ChangeSignal; the feed turns those into an ordered, cursorable entry
// stream and reports a resync when a foreign process (a CLI run, another API
// process) wrote to a store file behind our back.
import { randomUUID } from "node:crypto";

export type FeedKind =
  | "attempt"
  | "capacity"
  | "work-order"
  | "question"
  | "profile"
  | "resync";

export interface FeedEntry {
  readonly stream: string;
  readonly seq: number;
  readonly kind: FeedKind;
  readonly id: string | null;
  readonly at: string;
}

export interface FileStamp {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

export interface ChangeSignalLike {
  readonly kind: string;
  readonly id: string;
  readonly stateFile: string | null;
  readonly before: FileStamp | null;
  readonly written: FileStamp | null;
}

export type FeedRead =
  | {
      readonly kind: "entries";
      readonly entries: readonly FeedEntry[];
      readonly cursor: string;
    }
  | { readonly kind: "resync"; readonly cursor: string };

const DATA_KINDS: ReadonlySet<FeedKind> = new Set([
  "attempt",
  "capacity",
  "work-order",
  "question",
  "profile",
]);

const DEFAULT_CAPACITY = 1024;
const MIN_CAPACITY = 16;
const RECENT_LOCAL_STAMPS = 8;

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return (
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.ino === right.ino
  );
}

/** Parse `<stream>:<non-negative integer>` or return null when malformed. */
function parseCursor(cursor: string): { stream: string; seq: number } | null {
  const colon = cursor.indexOf(":");
  if (colon === -1) {
    return null;
  }
  const stream = cursor.slice(0, colon);
  const seqText = cursor.slice(colon + 1);
  if (!/^[0-9]+$/.test(seqText)) {
    return null;
  }
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) {
    return null;
  }
  return { stream, seq };
}

export interface ChangeFeedOptions {
  readonly capacity?: number;
  readonly streamId?: string;
  readonly now?: () => Date;
}

export class ChangeFeed {
  readonly streamId: string;

  private readonly capacity: number;
  private readonly now: () => Date;
  private seq = 0;
  private readonly entries: FeedEntry[] = [];
  private readonly lastLocal = new Map<string, FileStamp>();
  private readonly recentLocal = new Map<string, FileStamp[]>();
  private emitFailuresCount = 0;

  constructor(options: ChangeFeedOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY) {
      throw new Error(
        `ChangeFeed capacity must be an integer of at least ${MIN_CAPACITY}`,
      );
    }
    this.capacity = capacity;
    this.streamId = options.streamId ?? `s_${randomUUID()}`;
    this.now = options.now ?? (() => new Date());
  }

  get emitFailures(): number {
    return this.emitFailuresCount;
  }

  /** The sequence number of the newest entry (0 before the first). */
  get headSeq(): number {
    return this.seq;
  }

  /**
   * Record a change signal. Never throws: any failure is counted in
   * `emitFailures` instead of propagating into the saving caller.
   */
  emit(signal: ChangeSignalLike): void {
    try {
      if (
        signal.stateFile !== null &&
        signal.before !== null &&
        this.lastLocal.has(signal.stateFile) &&
        !sameStamp(this.lastLocal.get(signal.stateFile)!, signal.before)
      ) {
        // Another process wrote the file since our last local write.
        this.resync();
      }
      if (signal.stateFile !== null && signal.written !== null) {
        this.lastLocal.set(signal.stateFile, signal.written);
        this.rememberLocal(signal.stateFile, signal.written);
      }
      if (DATA_KINDS.has(signal.kind as FeedKind)) {
        this.appendEntry({
          stream: this.streamId,
          seq: this.seq + 1,
          kind: signal.kind as FeedKind,
          id: signal.id,
          at: this.now().toISOString(),
        });
      }
    } catch {
      this.emitFailuresCount += 1;
      // Plan section 3.1: a delivery failure becomes a resync, so a client is never left with
      // neither the lost signal nor a resync. appendEntry cannot throw.
      this.resync();
    }
  }

  /** Append a resync marker; clients treat it as an instruction to reset. */
  resync(): void {
    this.appendEntry({
      stream: this.streamId,
      seq: this.seq + 1,
      kind: "resync",
      id: null,
      at: this.now().toISOString(),
    });
  }

  lastLocalWrite(stateFile: string): FileStamp | undefined {
    return this.lastLocal.get(stateFile);
  }

  /** True when `stamp` is one of the last few stamps this process wrote to `stateFile`. */
  isRecentLocalWrite(stateFile: string, stamp: FileStamp | null): boolean {
    if (stamp === null) {
      return false;
    }
    const recent = this.recentLocal.get(stateFile) ?? [];
    return recent.some((known) => sameStamp(known, stamp));
  }

  private rememberLocal(stateFile: string, stamp: FileStamp): void {
    const recent = this.recentLocal.get(stateFile) ?? [];
    recent.push(stamp);
    if (recent.length > RECENT_LOCAL_STAMPS) {
      recent.shift();
    }
    this.recentLocal.set(stateFile, recent);
  }

  read(cursor: string | null): FeedRead {
    const next = `${this.streamId}:${this.seq}`;
    if (cursor === null) {
      return { kind: "resync", cursor: next };
    }
    const parsed = parseCursor(cursor);
    if (
      parsed === null ||
      parsed.stream !== this.streamId ||
      parsed.seq > this.seq
    ) {
      return { kind: "resync", cursor: next };
    }
    const oldest = this.entries[0];
    if (oldest !== undefined && parsed.seq < oldest.seq - 1) {
      // Entries between the cursor and the oldest retained entry were dropped.
      return { kind: "resync", cursor: next };
    }
    return {
      kind: "entries",
      entries: this.entries.filter((entry) => entry.seq > parsed.seq),
      cursor: next,
    };
  }

  private appendEntry(entry: FeedEntry): void {
    this.entries.push(entry);
    this.seq += 1;
    if (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }
}
