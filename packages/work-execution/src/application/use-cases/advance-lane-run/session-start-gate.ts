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
  /** CO13: per-run held endpoint starts (runId -> the hold and what it replaced). */
  private readonly endpointHolds = new Map<
    string,
    { readonly endpointKey: string; readonly heldMs: number; readonly previousMs: number | undefined }
  >();

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
   * the later of the endpoint's own last start in this gate and the durable
   * seed passed in; a durable seed that cannot be dated is dropped (garbage
   * never blocks a lane). A granted start is HELD for the endpoint at once, so
   * a sibling run asking in the same pass is spaced from it; the caller
   * releases the hold with `releaseStartForEndpoint` when no runner was
   * contacted (another gate waited, the intent was refused, the runner
   * refused), so a start that never happened delays nobody. A denied start
   * reserves the run's turn at now + retryAfterMs.
   */
  tryStartForEndpoint(
    runId: string,
    nowIso: string,
    endpointKey: string,
    lastStartIso: string | null,
  ): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number } {
    const endpointMs = this.endpointLastStartMs.get(endpointKey);
    const persistedMs = lastStartIso === null ? NaN : Date.parse(lastStartIso);
    const candidates = [endpointMs ?? NaN, persistedMs].filter((ms) => Number.isFinite(ms));
    const seededIso = candidates.length === 0 ? null : new Date(Math.max(...candidates)).toISOString();
    const decision = decideDispatchStagger({
      nowIso,
      lastStartIso: seededIso,
      minIntervalMs: this.staggerMs,
    });
    if (!decision.ok) {
      this.endpointReservations.set(runId, Date.parse(nowIso) + decision.retryAfterMs);
      return decision;
    }
    this.endpointReservations.delete(runId);
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(nowMs)) {
      this.endpointHolds.set(runId, { endpointKey, heldMs: nowMs, previousMs: endpointMs });
      this.endpointLastStartMs.set(endpointKey, nowMs);
    }
    return { ok: true };
  }

  /**
   * CO13: drop the run's held endpoint start when no runner was contacted.
   * The endpoint's last start goes back to what it was before the hold,
   * unless a later hold on the same endpoint has replaced it since.
   */
  releaseStartForEndpoint(runId: string): void {
    const hold = this.endpointHolds.get(runId);
    if (hold === undefined) {
      return;
    }
    this.endpointHolds.delete(runId);
    if (this.endpointLastStartMs.get(hold.endpointKey) !== hold.heldMs) {
      return;
    }
    if (hold.previousMs === undefined) {
      this.endpointLastStartMs.delete(hold.endpointKey);
    } else {
      this.endpointLastStartMs.set(hold.endpointKey, hold.previousMs);
    }
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
