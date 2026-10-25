/**
 * Per-project single-flight throttle for the probe route. At most one run is
 * in flight per projectId at a time — a second call for the same id is
 * refused immediately with `busy-project`, never queued — and at most
 * `maxConcurrent` runs are in flight overall, beyond which a call is refused
 * with `busy-global`. Slots are released even when the task throws; the
 * error then propagates to the caller. Pure in-process state; no timers.
 */
export type ProbeLimiterRunResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "busy-project" | "busy-global" };

export class ProbeLimiter {
  private readonly maxConcurrent: number;
  private readonly inFlightProjects = new Set<string>();
  private inFlightCount = 0;

  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(
    projectId: string,
    task: () => Promise<T>,
  ): Promise<ProbeLimiterRunResult<T>> {
    if (this.inFlightProjects.has(projectId)) {
      return { ok: false, reason: "busy-project" };
    }
    if (this.inFlightCount >= this.maxConcurrent) {
      return { ok: false, reason: "busy-global" };
    }
    this.inFlightProjects.add(projectId);
    this.inFlightCount += 1;
    try {
      const value = await task();
      return { ok: true, value };
    } finally {
      this.inFlightProjects.delete(projectId);
      this.inFlightCount -= 1;
    }
  }
}
