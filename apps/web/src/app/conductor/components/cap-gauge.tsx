"use client";

import type { ScheduleAdmissionView } from "../map-schedule";
import { gaugeFraction, gaugeText } from "../schedule-view";
import styles from "../conductor.module.css";

export function CapGauge({
  admission,
}: {
  admission: ScheduleAdmissionView;
}) {
  const fraction = gaugeFraction(admission);
  return (
    <div className={styles.gauge}>
      <p className={styles.gaugeText}>{gaugeText(admission)}</p>
      {fraction !== null ? (
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={admission.maxActiveRuns ?? 0}
          aria-valuenow={admission.active + admission.inFlight}
          aria-label="Admission"
          className={styles.gaugeBar}
        >
          <div
            className={styles.gaugeFill}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
