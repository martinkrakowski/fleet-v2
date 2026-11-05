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
  /** CO13: per-endpoint kept start ms (endpointKey -> ms): holds that were never released. */
  private readonly endpointKeptMs = new Map<string, number>();
  /** CO13: per-run endpoint reservations (runId -> slot ms). */
  private readonly endpointReservations = new Map<string, number>();
  /** CO13: per-run open endpoint holds (runId -> the held start), until released or superseded. */
  private readonly endpointHolds = new Map<string, { readonly endpointKey: string; readonly heldMs: number }>();

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
    const persistedMs = lastStartIso === null ? NaN : Date.parse(lastStartIso);
    const candidates = [this.endpointLastStartMs(endpointKey), persistedMs].filter((ms) => Number.isFinite(ms));
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
    // A run's earlier hold that was never released is a start that happened:
    // keep it before the run's new hold replaces it.
    const earlier = this.endpointHolds.get(runId);
    if (earlier !== undefined) {
      this.keepStart(earlier.endpointKey, earlier.heldMs);
      this.endpointHolds.delete(runId);
    }
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(nowMs)) {
      this.endpointHolds.set(runId, { endpointKey, heldMs: nowMs });
    }
    return { ok: true };
  }

  /**
   * CO13: drop the run's open endpoint hold when no runner was contacted. The
   * endpoint's last start is then the latest of its kept starts and the other
   * runs' open holds, so a release never restores a start that was itself
   * released and never loosens another run's hold.
   */
  releaseStartForEndpoint(runId: string): void {
    this.endpointHolds.delete(runId);
  }

  /** The endpoint's last start in this gate: its latest kept start or open hold, or NaN. */
  private endpointLastStartMs(endpointKey: string): number {
    let latest = this.endpointKeptMs.get(endpointKey) ?? NaN;
    for (const hold of this.endpointHolds.values()) {
      if (hold.endpointKey === endpointKey && (Number.isNaN(latest) || hold.heldMs > latest)) {
        latest = hold.heldMs;
      }
    }
    return latest;
  }

  private keepStart(endpointKey: string, ms: number): void {
    const kept = this.endpointKeptMs.get(endpointKey);
    if (kept === undefined || ms > kept) {
      this.endpointKeptMs.set(endpointKey, ms);
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
