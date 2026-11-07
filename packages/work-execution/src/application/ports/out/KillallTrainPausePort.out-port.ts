// @generated outbound contract scaffold — refined for lane KA2.
/**
 * KillallTrainPausePort reads and sets the killall train-pause record beside
 * the verification pause (plan §6): one record per state directory,
 * `killall-train-pause.json`, that pauses the merge train during a KILLALL
 * halt. A lift clears only this record, never any other pause or the marker;
 * unreadable is a value, never a default.
 */

/** The stored train-pause record's schema version. */
export const KILLALL_TRAIN_PAUSE_RECORD_VERSION = 1 as const;

export interface KillallTrainPauseStoreRecord {
  readonly version: typeof KILLALL_TRAIN_PAUSE_RECORD_VERSION;
  readonly paused: boolean;
  /** When the pause was requested; a zoned ISO time, normalised with toISOString(). */
  readonly requestedAtIso: string;
}

/** The pause as the CLI sees it; `unreadable` is never guessed. */
export type KillallTrainPauseRead = { readonly status: 'clear' | 'paused' | 'unreadable' };

export type KillallTrainPauseSetResult =
  | { readonly outcome: 'changed' | 'unchanged'; readonly record: KillallTrainPauseStoreRecord }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'pause-unreadable' };

export interface KillallTrainPausePort {
  /** Never throws for an unreadable file: it reads `unreadable`. Absent file or in-memory nothing → clear. */
  read(): Promise<KillallTrainPauseRead>;
  /**
   * Under the store's lock: paused true over anything (an unreadable file is
   * quarantined, then replaced); paused false over an unreadable file → refused
   * pause-unreadable. Same value as stored → unchanged (nothing written).
   */
  set(request: { readonly paused: boolean; readonly nowIso: string }): Promise<KillallTrainPauseSetResult>;
}
