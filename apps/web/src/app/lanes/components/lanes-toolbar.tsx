"use client";

import { Select } from "@fleet/ui";
import { STATE_FILTERS } from "../derive";
import styles from "../lanes.module.css";

export interface LanesToolbarProps {
  stateFilter: string;
  onStateFilterChange: (value: string) => void;
  shown: number;
  scopedCount: number;
}

export function LanesToolbar({
  stateFilter,
  onStateFilterChange,
  shown,
  scopedCount
}: LanesToolbarProps) {
  return (
    <div className={styles.tools}>
      <Select
        label="State"
        inline
        value={stateFilter}
        onChange={(e) => onStateFilterChange(e.target.value)}
        aria-label="state filter"
      >
        {STATE_FILTERS.map((s) => (
          <option key={s} value={s}>
            {s ? s.charAt(0).toUpperCase() + s.slice(1) : "Every state"}
          </option>
        ))}
      </Select>
      <span className={`${styles.tally} ${styles.mono}`}>
        {shown} of {scopedCount} shown{stateFilter ? " · filtered" : ""}
      </span>
    </div>
  );
}
