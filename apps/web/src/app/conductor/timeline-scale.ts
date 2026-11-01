/**
 * Pure timeline and SVG scale helpers for the Conductor page's concurrency
 * strip. Everything here is a pure function: there are no clock reads
 * (`Date.now` is forbidden), no stores and no React — only numbers in and
 * layout out, so the scale and sample derivation are unit-testable.
 */

import type {
  ConductorPassView,
  ConductorTraceStepView,
} from "./map-passes";

/** One reservation held-count point in the step series. */
export interface HeldPoint {
  readonly atIso: string;
  readonly held: number;
}

/** One reservation interval: held from `reservedAtIso` until `releasedAtIso`. */
export interface ReservationInterval {
  readonly reservedAtIso: string;
  readonly releasedAtIso: string | null;
}

/** Accepted reservation series input: precomputed points or raw intervals. */
export type ReservationInput = HeldPoint | ReservationInterval;

/**
 * The domain of a timeline in Unix milliseconds, spanning the given point
 * times and an optional anchor (for example the observation time so a single
 * point still yields a non-empty range). null when nothing parses.
 */
export function computeTimelineDomain(
  points: readonly { readonly atIso: string }[],
  anchorIso?: string,
): readonly [number, number] | null {
  const times: number[] = [];
  for (const point of points) {
    const ms = Date.parse(point.atIso);
    if (Number.isFinite(ms)) {
      times.push(ms);
    }
  }
  if (anchorIso !== undefined) {
    const ms = Date.parse(anchorIso);
    if (Number.isFinite(ms)) {
      times.push(ms);
    }
  }
  if (times.length === 0) {
    return null;
  }
  return [Math.min(...times), Math.max(...times)];
}

/** Linear time scale, clamped; a degenerate domain maps to the middle. */
export function scaleTimeX(
  domain: readonly [number, number],
  range: readonly [number, number],
): (ms: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 === d0) {
    const middle = (r0 + r1) / 2;
    return () => middle;
  }
  const width = d1 - d0;
  return (ms: number) => {
    if (!Number.isFinite(ms)) {
      return r0;
    }
    const clamped = Math.min(d1, Math.max(d0, ms));
    return r0 + ((clamped - d0) / width) * (r1 - r0);
  };
}

/**
 * Linear count scale: `maxCount` maps to the start of the range (top of the
 * plot) and 0 to the end (baseline). A non-positive max maps every count to
 * the middle.
 */
export function scaleCountY(
  maxCount: number,
  range: readonly [number, number],
): (count: number) => number {
  const [r0, r1] = range;
  if (!Number.isFinite(maxCount) || maxCount <= 0) {
    const middle = (r0 + r1) / 2;
    return () => middle;
  }
  return (count: number) => {
    if (!Number.isFinite(count)) {
      return r1;
    }
    const clamped = Math.min(maxCount, Math.max(0, count));
    return r1 - (clamped / maxCount) * (r1 - r0);
  };
}

interface NormalizedInterval {
  readonly start: number;
  readonly end: number | null;
}

interface NormalizedReservations {
  readonly intervals: readonly NormalizedInterval[];
  readonly direct: ReadonlyMap<number, number>;
  readonly instants: readonly number[];
}

function normalizedInterval(
  item: ReservationInterval,
  instants: Set<number>,
): NormalizedInterval | null {
  const start = Date.parse(item.reservedAtIso);
  if (!Number.isFinite(start)) {
    return null;
  }
  if (item.releasedAtIso === null) {
    instants.add(start);
    return { start, end: null };
  }
  const end = Date.parse(item.releasedAtIso);
  if (!Number.isFinite(end) || end < start) {
    return null;
  }
  instants.add(start);
  instants.add(end);
  return { start, end };
}

function normalizedDirectPoint(
  item: HeldPoint,
  instants: Set<number>,
): { readonly at: number; readonly held: number } | null {
  const at = Date.parse(item.atIso);
  if (!Number.isFinite(at) || !Number.isInteger(item.held) || item.held < 0) {
    return null;
  }
  instants.add(at);
  return { at, held: item.held };
}

function normalizeReservationInput(
  input: readonly ReservationInput[],
): NormalizedReservations {
  const instants = new Set<number>();
  const intervals: NormalizedInterval[] = [];
  const direct = new Map<number, number>();
  for (const item of input) {
    if ("reservedAtIso" in item) {
      const interval = normalizedInterval(item, instants);
      if (interval !== null) {
        intervals.push(interval);
      }
    } else {
      const point = normalizedDirectPoint(item, instants);
      if (point !== null) {
        direct.set(point.at, point.held);
      }
    }
  }
  return {
    intervals,
    direct,
    instants: [...instants].sort((left, right) => left - right),
  };
}

function heldAtInstant(
  instant: number,
  intervals: readonly NormalizedInterval[],
  direct: ReadonlyMap<number, number>,
): number {
  let held = 0;
  for (const interval of intervals) {
    if (
      interval.start <= instant &&
      (interval.end === null || interval.end > instant)
    ) {
      held += 1;
    }
  }
  const overridden = direct.get(instant);
  if (overridden !== undefined) {
    return overridden;
  }
  return held;
}

/**
 * Builds the reservation held-count step series from either precomputed
 * points (`{ atIso, held }`) or raw intervals (`{ reservedAtIso,
 * releasedAtIso }`, mirroring `deriveReservationSeries`). Points with
 * unparseable times, non-finite counts or a release before the reservation
 * are skipped. The result is sorted by time and holds the count in force at
 * each recorded instant.
 */
export function buildReservationStepPoints(
  input: readonly ReservationInput[],
): readonly HeldPoint[] {
  const { intervals, direct, instants } = normalizeReservationInput(input);
  return instants.map((instant) => ({
    atIso: new Date(instant).toISOString(),
    held: heldAtInstant(instant, intervals, direct),
  }));
}

/** One drawn segment of the held-count step chart, in plot coordinates. */
export interface StepChartSegment {
  readonly key: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Turns the held-count points into the step chart's segments: for each
 * consecutive pair, a horizontal plateau at the previous count from the
 * previous time to the next time, then the vertical riser at the next time.
 */
export function buildReservationStepSegments(
  points: readonly HeldPoint[],
  scaleX: (ms: number) => number,
  scaleY: (count: number) => number,
): readonly StepChartSegment[] {
  const segments: StepChartSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (previous === undefined || point === undefined) {
      continue;
    }
    const px = scaleX(Date.parse(previous.atIso));
    const cx = scaleX(Date.parse(point.atIso));
    const plateauY = scaleY(previous.held);
    const riserY = scaleY(point.held);
    segments.push({
      key: `plateau-${previous.atIso}-${point.atIso}`,
      x1: px,
      y1: plateauY,
      x2: cx,
      y2: plateauY,
    });
    segments.push({
      key: `riser-${point.atIso}`,
      x1: cx,
      y1: plateauY,
      x2: cx,
      y2: riserY,
    });
  }
  return segments;
}

/**
 * Wait reasons come solely from pass traces (D-VZ1): the same tokens the lane
 * run decider emits, mirrored here because the web boundary never imports
 * `@fleet/work-execution`.
 */
export type LaneRunWaitReason =
  | "admission"
  | "dispatch-pending"
  | "lane-running"
  | "prior-not-ended"
  | "gate-pending"
  | "review-pending"
  | "premerge-pending"
  | "ci-pending"
  | "ci-unknown"
  | "merge-train"
  | "parked"
  | "session-stagger"
  | "stop-unconfirmed"
  | "facts-inconsistent"
  | "stop-draining"
  | "stop-grace-exceeded"
  | "gate-congested";

export const LANE_RUN_WAIT_REASONS: ReadonlySet<string> = new Set([
  "admission",
  "dispatch-pending",
  "lane-running",
  "prior-not-ended",
  "gate-pending",
  "review-pending",
  "premerge-pending",
  "ci-pending",
  "ci-unknown",
  "merge-train",
  "parked",
  "session-stagger",
  "stop-unconfirmed",
  "facts-inconsistent",
  "stop-draining",
  "stop-grace-exceeded",
  "gate-congested",
]);

/** One overlay sample per recorded pass: active runs and wait counts. */
export interface PassOverlaySample {
  readonly passId: string;
  readonly atIso: string;
  /** Runs the pass worked (an `advanced` report); empty before the first trace. */
  readonly active: number;
  readonly totalWaits: number;
  readonly waits: Readonly<Partial<Record<LaneRunWaitReason, number>>>;
}

/**
 * Derives the per-pass overlay samples from recorded traces. `active` counts
 * the runs with an `advanced` report; wait counts come only from traced
 * `waiting` steps whose reason is a known `LaneRunWaitReason`. Empty before
 * the first traced pass (D-VZ1); no wait is ever inferred.
 */
function countTracedSteps(
  steps: readonly ConductorTraceStepView[],
  waits: Partial<Record<LaneRunWaitReason, number>>,
): void {
  for (const step of steps) {
    if (step.outcome !== "waiting" || step.reason === undefined) {
      continue;
    }
    if (!LANE_RUN_WAIT_REASONS.has(step.reason)) {
      continue;
    }
    const reason = step.reason as LaneRunWaitReason;
    waits[reason] = (waits[reason] ?? 0) + 1;
  }
}

function countPassRun(pass: ConductorPassView): {
  readonly active: number;
  readonly waits: Partial<Record<LaneRunWaitReason, number>>;
} {
  let active = 0;
  const waits: Partial<Record<LaneRunWaitReason, number>> = {};
  for (const run of pass.runs) {
    if (run.report.outcome !== "advanced") {
      continue;
    }
    active += 1;
    countTracedSteps(run.report.steps, waits);
  }
  return { active, waits };
}

/**
 * Derives the per-pass overlay samples from recorded traces. `active` counts
 * the runs with an `advanced` report; wait counts come only from traced
 * `waiting` steps whose reason is a known `LaneRunWaitReason`. Empty before
 * the first traced pass (D-VZ1); no wait is ever inferred.
 */
export function derivePassOverlaySamples(
  passes: readonly ConductorPassView[],
): readonly PassOverlaySample[] {
  return passes.map((pass) => {
    const { active, waits } = countPassRun(pass);
    const totalWaits = Object.values(waits).reduce(
      (sum, count) => sum + (count ?? 0),
      0,
    );
    return {
      passId: pass.passId,
      atIso: pass.nowIso,
      active,
      totalWaits,
      waits,
    };
  });
}

/** Input shape for session-start marks used by the strip's alignment pass. */
export interface SessionMarkLayoutInput {
  readonly runId: string;
  readonly step: string;
  readonly recordedAtIso: string;
  readonly gapMs: number | null;
  /** The wire-recorded flag, kept as-is when present (D-VZ2). */
  readonly underStagger?: boolean | null;
}

export interface SessionMarkLayout extends SessionMarkLayoutInput {
  /** Position across the timeline as a fraction of the domain (0..1). */
  readonly x: number;
  /** `gapMs < dispatchStaggerMs`; null when either is unknown (D-VZ2). */
  readonly underStagger: boolean | null;
}

function underStaggerFlag(
  mark: SessionMarkLayoutInput,
  dispatchStaggerMs: number | null,
): boolean | null {
  if (mark.underStagger !== null && mark.underStagger !== undefined) {
    return mark.underStagger;
  }
  if (mark.gapMs === null || dispatchStaggerMs === null) {
    return null;
  }
  return mark.gapMs < dispatchStaggerMs;
}

/**
 * Positions session-start marks on the timeline (`dispatch`, `brief-check`,
 * `code-review`) and marks `underStagger` only when a trace supplies
 * `dispatchStaggerMs` — the 20s default is never assumed on screen. A wire
 * recorded `underStagger` flag is kept as-is. By default the domain is the
 * marks' own span; pass `domain` to lay the marks out on the strip's shared
 * time axis (points, samples and marks together).
 */
export function positionSessionMarks(
  marks: readonly SessionMarkLayoutInput[],
  dispatchStaggerMs: number | null,
  domain?: readonly [number, number] | null,
): readonly SessionMarkLayout[] {
  const bounds =
    domain ??
    computeTimelineDomain(marks.map((mark) => ({ atIso: mark.recordedAtIso })));
  if (bounds === null) {
    return [];
  }
  const x = scaleTimeX(bounds, [0, 1]);
  return marks.map((mark) => {
    const ms = Date.parse(mark.recordedAtIso);
    const at = Number.isFinite(ms) ? ms : bounds[0];
    return {
      ...mark,
      x: x(at),
      underStagger: underStaggerFlag(mark, dispatchStaggerMs),
    };
  });
}
