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
  | { readonly ok: true; readonly events: readonly DaemonEventRecord[]; readonly nextCursor: string | null }
  | { readonly ok: false; readonly reason: 'invalid-cursor' | 'cursor-not-found' };
