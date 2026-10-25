// Outbound contract: announce, after a successful save, that a record changed.
/**
 * ChangeSignalPort: after a successful save, announce that a record of a kind
 * changed. It carries no record state and never fails or delays the save; it
 * is in-process only and never sent to a client.
 */

export type ChangeSignalKind = 'question' | 'profile';
export interface ChangeSignal {
  readonly kind: ChangeSignalKind;
  readonly id: string;
  /** Absolute path of the store file just written; null for an in-memory store. In-process only, never sent to a client. */
  readonly stateFile: string | null;
  /** `fs.stat` of stateFile taken as the FIRST statement inside the lock, before reading; null when in-memory, the file is missing, or the stat failed. */
  readonly before: { readonly mtimeMs: number; readonly size: number; readonly ino: number } | null;
  /** `fs.stat` of stateFile taken inside the lock right after the write; null when in-memory or the stat failed. */
  readonly written: { readonly mtimeMs: number; readonly size: number; readonly ino: number } | null;
}
export interface ChangeSignalPort {
  /** Must be synchronous: a returned Promise is neither awaited nor caught. Must not throw into the caller; callers still guard it. */
  emit(signal: ChangeSignal): void;
}
