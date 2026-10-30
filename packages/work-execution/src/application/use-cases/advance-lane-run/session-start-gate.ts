/**
 * The session-start gate (KF-34a1): one spacing rule where a lane session
 * actually starts — a dispatch, a seat pivot or a fix round through
 * `performDispatch`, and a `brief-check` or `code-review` review through
 * `performReview`. Every start is spaced at least `staggerMs` from the one
 * before it, within this pass and from a start a previous pass or process
 * recorded (the seeded `lastStartIso`). Pure: only the times passed in matter.
 */

import type { SessionStartGate } from '../../ports/in/AdvanceLaneRunPort.in-port.js';

export class SessionStartSpacing implements SessionStartGate {
  private readonly reservations = new Map<string, number>();
  private nextFreeMs: number;

  constructor(
    private readonly staggerMs: number,
    lastStartIso: string | null,
  ) {
    const lastStartMs = lastStartIso === null ? NaN : Date.parse(lastStartIso);
    this.nextFreeMs = Number.isNaN(lastStartMs) ? -Infinity : lastStartMs + staggerMs;
  }

  tryStart(runId: string, nowIso: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number } {
    const now = Date.parse(nowIso);
    const slot = this.reservations.get(runId);
    if (slot !== undefined) {
      if (now >= slot) {
        this.reservations.delete(runId);
        return { ok: true };
      }
      return { ok: false, retryAfterMs: slot - now };
    }
    const startMs = Math.max(now, this.nextFreeMs);
    this.nextFreeMs = startMs + this.staggerMs;
    if (startMs <= now) {
      return { ok: true };
    }
    this.reservations.set(runId, startMs);
    return { ok: false, retryAfterMs: startMs - now };
  }

  /** The ms until the run's reserved turn, or 0 when it holds none. */
  pendingMs(runId: string, nowIso: string): number {
    const slot = this.reservations.get(runId);
    if (slot === undefined) {
      return 0;
    }
    return Math.max(0, slot - Date.parse(nowIso));
  }
}
