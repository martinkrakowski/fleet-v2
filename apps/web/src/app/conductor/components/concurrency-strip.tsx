"use client";

import { TableContainer, Table, Tbody, Td, Th, Thead, Tr } from "@fleet/ui";
import type { ConductorPassView } from "../map-passes";
import type { SessionMarkView } from "../map-schedule";
import {
  buildReservationStepPoints,
  computeTimelineDomain,
  derivePassOverlaySamples,
  positionSessionMarks,
  scaleCountY,
  scaleTimeX,
  type ReservationInput,
} from "../timeline-scale";
import styles from "../conductor.module.css";

const STRIP_WIDTH = 600;
const STRIP_HEIGHT = 80;
const STRIP_PADDING = 10;
const PLOT_TOP = 12;
const PLOT_BOTTOM = 56;
const BASELINE_Y = STRIP_HEIGHT - 6;

export interface ConcurrencyStripProps {
  readonly reservations: readonly ReservationInput[];
  readonly passes: readonly ConductorPassView[];
  readonly sessionMarks: readonly SessionMarkView[];
  readonly truncated?: boolean;
}

function waitSummary(sample: {
  readonly totalWaits: number;
  readonly waits: Readonly<Record<string, number>>;
}): string {
  if (sample.totalWaits === 0) {
    return "no waits";
  }
  const reasons = Object.entries(sample.waits)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  return `${sample.totalWaits} waits (${reasons})`;
}

function overlayTitle(sample: {
  readonly passId: string;
  readonly atIso: string;
  readonly active: number;
  readonly totalWaits: number;
  readonly waits: Readonly<Record<string, number>>;
}): string {
  return `${sample.passId} ${sample.atIso} · active ${sample.active} · ${waitSummary(sample)}`;
}

function emptyStrip() {
  return (
    <section className={styles.stripSection} aria-label="Concurrency">
      <p className={styles.muted}>No concurrency history recorded.</p>
    </section>
  );
}

export function ConcurrencyStrip({
  reservations,
  passes,
  sessionMarks,
  truncated = false,
}: ConcurrencyStripProps) {
  const points = buildReservationStepPoints(reservations);
  const samples = derivePassOverlaySamples(passes);
  const dispatchStaggerMs = passes[0]?.dispatchStaggerMs ?? null;
  const sessionLayout = positionSessionMarks(sessionMarks, dispatchStaggerMs);

  const domain = computeTimelineDomain([
    ...points,
    ...samples,
    ...sessionMarks.map((mark) => ({ atIso: mark.recordedAtIso })),
  ]);
  if (domain === null) {
    return emptyStrip();
  }

  const x = scaleTimeX(domain, [STRIP_PADDING, STRIP_WIDTH - STRIP_PADDING]);
  const maxHeld = points.reduce(
    (max, point) => Math.max(max, point.held),
    1,
  );
  const maxCount = Math.max(maxHeld, ...samples.map((sample) => sample.active), 1);
  const y = scaleCountY(maxCount, [PLOT_TOP, PLOT_BOTTOM]);

  const stepLines = points
    .map((point, index) => {
      if (index === 0) {
        return null;
      }
      const previous = points[index - 1];
      const px = x(Date.parse(point.atIso));
      const previousY = y(previous.held);
      const py = y(point.held);
      return (
        <line
          key={`step-${point.atIso}`}
          x1={px}
          y1={previousY}
          x2={px}
          y2={py}
          className={styles.reservationLine}
        />
      );
    })
    .filter(Boolean);

  const stepRuns = points.map((point) => {
    const px = x(Date.parse(point.atIso));
    const py = y(point.held);
    return <circle key={`held-${point.atIso}`} cx={px} cy={py} r={2} className={styles.reservationLine} />;
  });

  return (
    <section className={styles.stripSection} aria-label="Concurrency">
      {truncated ? (
        <p className={styles.muted}>Older concurrency was cut: the strip shows the newest data.</p>
      ) : null}
      <div className={styles.strip}>
        <svg
          role="img"
          aria-label="Reservation held count over time with pass overlay"
          viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
          width="100%"
          style={{ minWidth: STRIP_WIDTH }}
          height={STRIP_HEIGHT}
          preserveAspectRatio="xMidYMid meet"
        >
          {stepLines}
          {stepRuns}
          {samples.map((sample) => {
            const sx = x(Date.parse(sample.atIso));
            const sy = y(sample.active);
            return (
              <circle
                key={`sample-${sample.passId}`}
                cx={sx}
                cy={sy}
                r={4}
                className={styles.overlay}
              >
                <title>{overlayTitle(sample)}</title>
              </circle>
            );
          })}
          {sessionLayout.map((mark) => (
            <circle
              key={`session-${mark.runId}-${mark.step}-${mark.recordedAtIso}`}
              cx={mark.x * (STRIP_WIDTH - STRIP_PADDING * 2) + STRIP_PADDING}
              cy={BASELINE_Y}
              r={3}
              className={
                mark.underStagger === true
                  ? styles.markUnderStagger
                  : styles.mark
              }
            >
              <title>{`${mark.runId} ${mark.step} ${mark.recordedAtIso}`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <TableContainer className={styles.stripTable}>
        <Table>
          <Thead>
            <Tr>
              <Th>Time</Th>
              <Th>Held</Th>
              <Th>Pass</Th>
              <Th>Active</Th>
              <Th>Waits</Th>
            </Tr>
          </Thead>
          <Tbody>
            {points.map((point) => (
              <Tr key={`row-held-${point.atIso}`}>
                <Td>{point.atIso}</Td>
                <Td>{point.held}</Td>
                <Td>—</Td>
                <Td>—</Td>
                <Td>—</Td>
              </Tr>
            ))}
            {samples.map((sample) => (
              <Tr key={`row-sample-${sample.passId}`}>
                <Td>{sample.atIso}</Td>
                <Td>—</Td>
                <Td>{sample.passId}</Td>
                <Td>{sample.active}</Td>
                <Td>{waitSummary(sample)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </TableContainer>
    </section>
  );
}
