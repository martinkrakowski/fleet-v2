"use client";

import type { SessionMarkView } from "../map-schedule";
import { markLayout, type StripMarkLayout } from "../svg-scale";
import styles from "../conductor.module.css";

const STRIP_WIDTH = 600;
const STRIP_HEIGHT = 40;
const STRIP_PADDING = 10;

/** A laid-out mark with the original recorded gap, for D-VZ2 recomputation. */
type RenderMark = StripMarkLayout & { readonly gapMs: number | null };

/**
 * D-VZ2: a mark is `underStagger` only when a trace supplies
 * `dispatchStaggerMs` — the 20s default is never assumed on screen. The wire
 * already carries `underStagger` when recorded; the prop fills the gap for
 * marks recorded before the stagger was known.
 */
function effectiveUnderStagger(
  mark: { readonly underStagger: boolean | null; readonly gapMs: number | null },
  dispatchStaggerMs: number | null,
): boolean | null {
  if (mark.underStagger !== null) {
    return mark.underStagger;
  }
  if (mark.gapMs === null || dispatchStaggerMs === null) {
    return null;
  }
  return mark.gapMs < dispatchStaggerMs;
}

function staggerText(
  mark: RenderMark,
  dispatchStaggerMs: number | null,
): string | null {
  if (effectiveUnderStagger(mark, dispatchStaggerMs) !== true) {
    return null;
  }
  return "under stagger";
}

function gapText(mark: SessionMarkView): string {
  return mark.gapMs === null ? "—" : String(mark.gapMs);
}

function staggerCell(
  mark: SessionMarkView,
  dispatchStaggerMs: number | null,
): string {
  const under = effectiveUnderStagger(mark, dispatchStaggerMs);
  if (under === null) {
    return "not recorded";
  }
  return under ? "yes" : "no";
}

function markTitle(
  mark: RenderMark,
  dispatchStaggerMs: number | null,
): string {
  const base = `${mark.runId} ${mark.step} ${mark.recordedAtIso}`;
  if (effectiveUnderStagger(mark, dispatchStaggerMs) === true) {
    return `${base} · under stagger`;
  }
  return base;
}

function labelAnchor(x: number): "start" | "middle" | "end" {
  if (x <= STRIP_PADDING * 2) {
    return "start";
  }
  if (x >= STRIP_WIDTH - STRIP_PADDING * 2) {
    return "end";
  }
  return "middle";
}

export function SessionStrip({
  marks,
  truncated = false,
  dispatchStaggerMs = null,
}: {
  marks: readonly SessionMarkView[];
  truncated?: boolean;
  /** Recorded from a pass trace; never the assumed 20s default (D-VZ2). */
  dispatchStaggerMs?: number | null;
}) {
  const layout = markLayout(marks, STRIP_WIDTH, STRIP_PADDING);

  const effective = (mark: StripMarkLayout, index: number) =>
    effectiveUnderStagger(
      {
        underStagger: mark.underStagger,
        gapMs: marks[index]?.gapMs ?? null,
      },
      dispatchStaggerMs,
    );

  if (marks.length === 0) {
    return (
      <section className={styles.stripSection} aria-label="Session starts">
        <p className={styles.muted}>No session starts recorded.</p>
      </section>
    );
  }

  return (
    <section className={styles.stripSection} aria-label="Session starts">
      {truncated ? (
        <p className={styles.muted}>
          Older session-start marks were cut: the strip shows only the newest 50.
        </p>
      ) : null}
      <div className={styles.strip}>
        <svg
          role="img"
          aria-label="Session starts over time"
          viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
          width="100%"
          style={{ minWidth: STRIP_WIDTH }}
          height={STRIP_HEIGHT}
          preserveAspectRatio="xMidYMid meet"
        >
          {layout.map((mark, index) => {
            const under = effective(mark, index);
            const renderMark = { ...mark, gapMs: marks[index]?.gapMs ?? null };
            return (
              <g key={`${mark.runId}-${mark.step}-${mark.recordedAtIso}`}>
                <circle
                  cx={mark.x}
                  cy={STRIP_HEIGHT / 2}
                  r={4}
                  className={
                    under === true ? styles.markUnderStagger : styles.mark
                  }
                >
                  <title>{markTitle(renderMark, dispatchStaggerMs)}</title>
                </circle>
                {staggerText(renderMark, dispatchStaggerMs) !== null ? (
                  <text
                    x={mark.x}
                    y={STRIP_PADDING}
                    textAnchor={labelAnchor(mark.x)}
                    className={styles.markLabel}
                  >
                    under stagger
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <details className={styles.stripTable}>
        <summary>Session starts as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Step</th>
              <th scope="col">Time</th>
              <th scope="col">Gap</th>
              <th scope="col">Under stagger</th>
            </tr>
          </thead>
          <tbody>
            {marks.map((mark) => (
              <tr key={`${mark.runId}-${mark.step}-${mark.recordedAtIso}`}>
                <td>{mark.runId}</td>
                <td>{mark.step}</td>
                <td>{mark.recordedAtIso}</td>
                <td>{gapText(mark)}</td>
                <td>{staggerCell(mark, dispatchStaggerMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
