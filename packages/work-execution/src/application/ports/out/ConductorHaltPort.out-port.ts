// @generated outbound contract scaffold — refined for lane K7-1.
/**
 * ConductorHaltPort reads and sets the conductor's halt marker of a state
 * directory (plan §3.7, owner decision K7-D2): the kill switch the driver
 * checks before any external action. An unreadable marker reads as halted,
 * halting never fails on an unreadable file, and lifting refuses one.
 */

import type { ConductorHaltRecord, ConductorHaltState } from '../../../domain/conductor-halt.js';

export type ConductorHaltSetResult =
  | { readonly outcome: 'changed' | 'unchanged'; readonly record: ConductorHaltRecord }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'marker-unreadable' };

export interface ConductorHaltPort {
  /** Never throws for an unreadable file: it reads `unreadable`. Absent file or in-memory nothing → clear, record null. */
  read(): Promise<ConductorHaltState>;
  /**
   * Under the store's lock: halted true over anything (an unreadable file is quarantined, then replaced);
   * halted false over an unreadable file → refused marker-unreadable (lifting needs a readable marker).
   * Same value as stored → unchanged (nothing written); else the new record is written → changed.
   */
  set(request: { readonly halted: boolean; readonly nowIso: string }): Promise<ConductorHaltSetResult>;
}
