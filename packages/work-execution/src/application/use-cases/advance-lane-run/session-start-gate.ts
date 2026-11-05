/**
 * The session-start gate (KF-34a1): one spacing rule where a lane session
 * actually starts — a dispatch, a seat pivot or a fix round through
 * `performDispatch`, and a `brief-check` or `code-review` review through
 * `performReview`. Every start is spaced at least `staggerMs` from the one
 * before it, within this pass and from a start a previous pass or process
 * recorded (the seeded `lastStartIso`). Pure: only the times passed in matter.
 */

import { decideDispatchStagger } from '../../../domain/dispatch-stagger.js';
import type { SessionStartGate } from '../../ports/in/AdvanceLaneRunPort.in-port.js';

export class SessionStartSpacing implements SessionStartGate {
  private readonly reservations = new Map<string, number>();
  private nextFreeMs: number;
  /** CO13: per-endpoint last-start ms (endpointKey -> ms). */
  private readonly endpointLastStartMs = new Map<string, number>();
  /** CO13: per-run endpoint reservations (runId -> slot ms). */
  private readonly endpointReservations = new Map<string, number>();

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

  /**
   * CO13: the per-runner-endpoint dispatch stagger. The seeded last start is
   * the later of the endpoint's own last start and the durable seed passed in;
   * a durable seed that cannot be dated is kept so the pure rule waits one full
   * interval (never too early). A granted start is NOT recorded here — the
   * caller commits it with `commitStartForEndpoint` only once the dispatch
   * actually proceeds past every gate, so a grant the global gate then blocks
   * never counts as a start. A denied start reserves the run's turn at now +
   * retryAfterMs.
   */
  tryStartForEndpoint(
    runId: string,
    nowIso: string,
    endpointKey: string,
    lastStartIso: string | null,
  ): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number } {
    const endpointMs = this.endpointLastStartMs.get(endpointKey);
    const persistedMs = lastStartIso === null ? NaN : Date.parse(lastStartIso);
    let seededIso: string | null = null;
    if (lastStartIso !== null && !Number.isFinite(persistedMs)) {
      seededIso = lastStartIso;
    } else {
      if (endpointMs !== undefined && !Number.isNaN(endpointMs)) {
        seededIso = new Date(endpointMs).toISOString();
      }
      if (!Number.isNaN(persistedMs) && (seededIso === null || persistedMs > Date.parse(seededIso))) {
        seededIso = lastStartIso;
      }
    }
    const decision = decideDispatchStagger({
      nowIso,
      lastStartIso: seededIso,
      minIntervalMs: this.staggerMs,
    });
    if (decision.ok) {
      this.endpointReservations.delete(runId);
      return { ok: true };
    }
    this.endpointReservations.set(runId, Date.parse(nowIso) + decision.retryAfterMs);
    return decision;
  }

  /** CO13: record an endpoint start once it actually proceeded past every gate. */
  commitStartForEndpoint(endpointKey: string, nowIso: string): void {
    this.endpointLastStartMs.set(endpointKey, Date.parse(nowIso));
  }

  /** The ms until the run's reserved turn, or 0 when it holds none. */
  pendingMs(runId: string, nowIso: string): number {
    const slot = this.reservations.get(runId);
    const endpointSlot = this.endpointReservations.get(runId);
    const globalPending = slot === undefined ? 0 : Math.max(0, slot - Date.parse(nowIso));
    const endpointPending = endpointSlot === undefined ? 0 : Math.max(0, endpointSlot - Date.parse(nowIso));
    return Math.max(globalPending, endpointPending);
  }
}
