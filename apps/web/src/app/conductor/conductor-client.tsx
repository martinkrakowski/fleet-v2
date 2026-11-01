"use client";

import { useState, type ReactNode } from "react";
import { Banner, EmptyState, PageHeader, RouteChip, Select } from "@fleet/ui";
import type { ConductorData } from "./live";
import type { ScheduleRowView, ScheduleView } from "./map-schedule";
import {
  PLACEMENT_FILTERS,
  capNote,
  filterRows,
  type PlacementFilter,
} from "./schedule-view";
import { useAutoRefresh } from "../lanes/use-auto-refresh";
import { CapGauge } from "./components/cap-gauge";
import { ScheduleBoard } from "./components/schedule-board";
import { SessionStrip } from "./components/session-strip";
import styles from "./conductor.module.css";

function haltedBannerTitle(halt: string): string {
  if (halt === "unreadable") {
    return "Halt marker unreadable — treated as halted";
  }
  return "Conductor halted";
}

function actions(data: ConductorData, liveCount: number): ReactNode {
  if (data.view === "listed") {
    return (
      <RouteChip>live · GET /v1/runs · {liveCount} live</RouteChip>
    );
  }
  if (data.view === "error") {
    return <RouteChip variant="gap">error · not read</RouteChip>;
  }
  return <RouteChip variant="gap">not configured · not read</RouteChip>;
}

function unreadBanner(data: ConductorData): ReactNode {
  if (data.view === "error") {
    return (
      <Banner tone="danger" title="Read failed">
        <p>{data.reason}</p>
      </Banner>
    );
  }
  return (
    <Banner tone="neutral" title="api boundary is not configured">
      <p>
        No rows were read: the API boundary is not configured on this station,
        so there is no sample list of live runs.
      </p>
    </Banner>
  );
}

function scheduleList(
  schedule: ScheduleView,
  rows: readonly ScheduleRowView[],
): ReactNode {
  if (schedule.rows.length === 0) {
    return <EmptyState title="No live runs." />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={`Nothing matches this filter: ${schedule.rows.length} runs are live; the filter hides them.`}
      />
    );
  }
  return <ScheduleBoard visibleRows={rows} hosts={schedule.hosts} />;
}

export function ConductorClient({ data }: { data: ConductorData }) {
  useAutoRefresh(data.source, data.fallbackReason);
  const [placementFilter, setPlacementFilter] = useState<PlacementFilter>("all");

  const schedule = data.view === "listed" ? data.schedule : null;
  const rows = schedule === null ? [] : filterRows(schedule.rows, placementFilter);

  let body: ReactNode;
  if (data.view !== "listed" || schedule === null) {
    body = unreadBanner(data);
  } else {
    body = (
      <>
        {schedule.halt !== "clear" ? (
          <Banner tone="warn" title={haltedBannerTitle(schedule.halt)}>
            <p>The run list below is still shown, read-only.</p>
          </Banner>
        ) : null}
        <CapGauge admission={schedule.admission} />
        <div className={styles.tools}>
          <Select
            label="Placement"
            inline
            value={placementFilter}
            onChange={(e) =>
              setPlacementFilter(e.target.value as PlacementFilter)
            }
            aria-label="placement filter"
          >
            {PLACEMENT_FILTERS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </div>
        {scheduleList(schedule, rows)}
        <SessionStrip
          marks={schedule.sessionStarts}
          truncated={schedule.truncated}
        />
      </>
    );
  }

  const liveCount =
    schedule === null ? 0 : filterRows(schedule.rows, "all").length;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Conductor"
        description="Read-only picture of the conductor's live runs: who holds a host slot, which package keys they own and how full admission is. Nothing here starts, stops, halts, resumes or reorders a run."
        actions={actions(data, liveCount)}
      />
      <p className={styles.meta} aria-live="polite">
        {schedule === null
          ? ""
          : `read ${data.observedAtIso} · ${capNote(schedule)}`}
      </p>
      {body}
    </div>
  );
}
