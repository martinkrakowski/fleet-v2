/**
 * Tiny inline-SVG scale helpers for the session strip. Linear, clamped, and
 * defensive: a degenerate domain maps to the middle of the range, a
 * non-finite input maps to the start of the range.
 */

export interface StripMark {
  readonly recordedAtIso: string;
}

export function timeScale(
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

export function stripDomain(
  marks: readonly StripMark[],
): readonly [number, number] | null {
  const times: number[] = [];
  for (const mark of marks) {
    const ms = Date.parse(mark.recordedAtIso);
    if (Number.isFinite(ms)) {
      times.push(ms);
    }
  }
  if (times.length === 0) {
    return null;
  }
  return [Math.min(...times), Math.max(...times)];
}

export interface StripMarkLayout {
  readonly x: number;
  readonly runId: string;
  readonly step: string;
  readonly underStagger: boolean | null;
  readonly recordedAtIso: string;
}

export interface MarkInput {
  readonly runId: string;
  readonly step: string;
  readonly underStagger: boolean | null;
  readonly recordedAtIso: string;
}

export function markLayout(
  marks: readonly MarkInput[],
  width: number,
  padding: number,
): readonly StripMarkLayout[] {
  const domain = stripDomain(marks);
  if (domain === null) {
    return [];
  }
  const scale = timeScale(domain, [padding, width - padding]);
  return marks.map((mark) => ({
    x: scale(Date.parse(mark.recordedAtIso)),
    runId: mark.runId,
    step: mark.step,
    underStagger: mark.underStagger,
    recordedAtIso: mark.recordedAtIso,
  }));
}
