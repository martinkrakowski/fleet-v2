// @generated outbound contract scaffold — refined for lane DT3.
/**
 * Append and read the events.jsonl projection (version 1, ids and codes only),
 * regenerable from the journal and never a source of truth (plan §3.4).
 */
import type { DaemonEventRecord } from '../../../domain/daemon-events.js';

export interface DaemonEventProjectionPort {
  append(events: readonly DaemonEventRecord[]): Promise<{ readonly appended: number }>;
  readAfterCursor(cursorEventId: string | null): Promise<DaemonEventCursorRead>;
}

export type DaemonEventCursorRead =
  | {
      readonly ok: true;
      readonly events: readonly DaemonEventRecord[];
      readonly nextCursor: string | null;
      /**
       * OD7a3: each returned event's 0-based file line index in
       * `events.jsonl`, parallel to `events`. Optional for backwards
       * compatibility with callers that do not set it.
       */
      readonly eventPositions?: readonly number[];
      /**
       * OD7a3: the 0-based indexes of every file line that could not be
       * parsed (blank lines and the header line are not dropped). Policy:
       * `events.jsonl` holds the whole history, so a dropped line counts
       * against a day only when its position lies between the first and
       * last successfully parsed record whose time is inside that day; a
       * corrupt line outside every day's bracket affects no day. Optional
       * for backwards compatibility.
       */
      readonly droppedLines?: readonly number[];
    }
  | { readonly ok: false; readonly reason: 'invalid-cursor' | 'cursor-not-found' };
