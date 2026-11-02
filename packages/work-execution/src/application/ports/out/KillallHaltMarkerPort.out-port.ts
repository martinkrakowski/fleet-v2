// @generated outbound contract scaffold — refined for lane KA2.
/**
 * KillallHaltMarkerPort reads and sets the killall halt marker of a state
 * directory (plan §6): the marker the KILLALL command writes and the shared
 * dispatch scripts and the conductor refuse while halted. One record per state
 * directory, `killall-halt.json`, read as clear, halted or unreadable;
 * halting never fails on an unreadable file, lifting refuses one. No path or
 * file content crosses the port.
 */

import type { ConductorHaltRecord } from '../../../domain/conductor-halt.js';

/** The marker as the CLI and the state check see it; `unreadable` is a halt. */
export type KillallHaltMarkerRead = { readonly state: 'clear' | 'halted' | 'unreadable' };

export type KillallHaltMarkerSetResult =
  | { readonly outcome: 'changed' | 'unchanged'; readonly record: ConductorHaltRecord }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'marker-unreadable' };

export interface KillallHaltMarkerPort {
  /** Never throws for an unreadable file: it reads `unreadable`. Absent file or in-memory nothing → clear. */
  read(): Promise<KillallHaltMarkerRead>;
  /**
   * Under the store's lock: halted true over anything (an unreadable file is
   * quarantined, then replaced); halted false over an unreadable file → refused
   * marker-unreadable (lifting needs a readable marker). Same value as stored →
   * unchanged (nothing written); else the new record is written → changed.
   */
  set(request: { readonly halted: boolean; readonly nowIso: string }): Promise<KillallHaltMarkerSetResult>;
}
