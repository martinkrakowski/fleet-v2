"use client";

import { Select, Switch } from "@fleet/ui";
import { STATE_FILTERS } from "../derive";
import styles from "../lanes.module.css";

export interface LanesToolbarProps {
  showEnded: boolean;
  onShowEndedChange: (checked: boolean) => void;
  stateFilter: string;
  onStateFilterChange: (value: string) => void;
  shown: number;
  scopedCount: number;
}

export function LanesToolbar({
  showEnded,
  onShowEndedChange,
  stateFilter,
  onStateFilterChange,
  shown,
  scopedCount
}: LanesToolbarProps) {
  return (
    <div className={styles.tools}>
      <Switch
        checked={showEnded}
        onChange={onShowEndedChange}
        label="show ended"
      />
      <Select
        label="state"
        value={stateFilter}
        onChange={(e) => onStateFilterChange(e.target.value)}
        aria-label="state filter"
      >
        {STATE_FILTERS.map((s) => (
          <option key={s} value={s}>
            {s || "every state"}
          </option>
        ))}
      </Select>
      <span className={`${styles.tally} ${styles.mono}`}>
        {shown} of {scopedCount} shown{stateFilter ? " · filtered" : ""}
      </span>
    </div>
  );
}