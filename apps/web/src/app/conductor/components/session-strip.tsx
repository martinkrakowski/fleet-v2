"use client";

import type { SessionMarkView } from "../map-schedule";
import { markLayout } from "../svg-scale";
import styles from "../conductor.module.css";

const STRIP_WIDTH = 600;
const STRIP_HEIGHT = 40;
const STRIP_PADDING = 10;

function staggerText(mark: { readonly underStagger: boolean | null }): string | null {
  if (mark.underStagger !== true) {
    return null;
  }
  return "under stagger";
}

function gapText(mark: SessionMarkView): string {
  return mark.gapMs === null ? "—" : String(mark.gapMs);
}

function staggerCell(mark: SessionMarkView): string {
  if (mark.underStagger === null) {
    return "not recorded";
  }
  return mark.underStagger ? "yes" : "no";
}

export function SessionStrip({ marks }: { marks: readonly SessionMarkView[] }) {
  const layout = markLayout(marks, STRIP_WIDTH, STRIP_PADDING);

  if (marks.length === 0) {
    return (
      <section className={styles.stripSection} aria-label="Session starts">
        <p className={styles.muted}>No session starts recorded.</p>
      </section>
    );
  }

  return (
    <section className={styles.stripSection} aria-label="Session starts">
      <div className={styles.strip}>
        <svg
          role="img"
          aria-label="Session starts over time"
          viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
          width="100%"
          height={STRIP_HEIGHT}
          preserveAspectRatio="xMidYMid meet"
        >
          {layout.map((mark) => (
            <g key={`${mark.runId}-${mark.step}-${mark.recordedAtIso}`}>
              <circle
                cx={mark.x}
                cy={STRIP_HEIGHT / 2}
                r={4}
                className={
                  mark.underStagger === true
                    ? styles.markUnderStagger
                    : styles.mark
                }
              >
                <title>
                  {mark.runId} {mark.step} {mark.recordedAtIso}
                </title>
              </circle>
              {staggerText(mark) !== null ? (
                <text
                  x={mark.x}
                  y={STRIP_PADDING}
                  textAnchor="middle"
                  className={styles.markLabel}
                >
                  under stagger
                </text>
              ) : null}
            </g>
          ))}
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
                <td>{staggerCell(mark)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
