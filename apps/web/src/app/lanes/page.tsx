"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  RouteChip,
  Switch
} from "@fleet/ui";
import { attempts, capacity } from "./fixture";
import { STATE_ORDER, summary, woOf } from "./derive";
import { LanesKpiRow } from "./components/lanes-kpi-row";
import { LanesToolbar } from "./components/lanes-toolbar";
import { LaneRow } from "./components/lane-row";
import { CapacityCard } from "./components/capacity-card";
import { AttentionCard } from "./components/attention-card";
import styles from "./lanes.module.css";

export default function LanesPage() {
  const [showEnded, setShowEnded] = useState(true);
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const project = useSearchParams().get("project") ?? "";

  const rows = attempts
    .filter((a) => !project || woOf(a).project === project)
    .filter((a) => showEnded || a.capacity !== "released")
    .filter((a) => !stateFilter || summary(a)[0] === stateFilter)
    .sort((x, y) => {
      const s = STATE_ORDER[summary(x)[0]] - STATE_ORDER[summary(y)[0]];
      if (s) return s;
      return (y.startedAt ?? y.queuedAt ?? "").localeCompare(
        x.startedAt ?? x.queuedAt ?? ""
      );
    });
  const scopedCount = attempts.filter(
    (a) => !project || woOf(a).project === project
  ).length;

  const queued = attempts.filter((a) => a.capacity === "pending").length;
  const unknown = attempts.filter((a) => summary(a)[0] === "unknown").length;
  const blocked = attempts.filter((a) => summary(a)[0] === "blocked").length;
  const heldAttempts = attempts
    .filter((a) => a.capacity === "held")
    .sort((x, y) => (x.slot ?? 0) - (y.slot ?? 0));
  const pendingAttempts = attempts
    .filter((a) => a.capacity === "pending")
    .sort((x, y) => (x.queuedAt ?? "").localeCompare(y.queuedAt ?? ""));

  return (
    <div className={styles.page}>
      <PageHeader
        title="Lanes"
        description={
          <>
            Attempts for <b>every project</b>, five runner facts kept apart. A
            branch is not an attempt; a fix is a fresh attempt on the same work
            order. <b>Unknown</b> holds its slot until the runner answers — it
            is never read as idle, never as a pass. The state word is derived,
            and labelled as derived.
          </>
        }
        actions={
          <span title="a route the plan does not name yet">
            <RouteChip variant="gap">
              gap · no list route: GET /v1/attempts is missing
            </RouteChip>
          </span>
        }
      />
      <LanesKpiRow
        queued={queued}
        unknown={unknown}
        blocked={blocked}
        held={heldAttempts.length}
        slots={capacity.slots}
        host={capacity.host}
        port={capacity.port}
        queuedAll={pendingAttempts.length}
      />
      <LanesToolbar
        stateFilter={stateFilter}
        onStateFilterChange={setStateFilter}
        shown={rows.length}
        scopedCount={scopedCount}
      />
      <div className={`row col-8-4 ${styles.board}`}>
        <Card className={styles.lanewrap}>
          <CardHeader
            title={project || "All projects"}
            actions={
              <div className={styles.headerActions}>
                <Switch
                  checked={showEnded}
                  onChange={setShowEnded}
                  label="Show ended"
                />
                <span className={styles.meta}>
                  {rows.length} lane{rows.length === 1 ? "" : "s"}
                </span>
              </div>
            }
          />
          <CardBody className={styles.laneScroll}>
            {rows.length > 0 ? (
              <ul className={styles.lanes}>
                {rows.map((a) => (
                  <LaneRow
                    key={a.id}
                    attempt={a}
                    selected={selectedId === a.id}
                    onSelect={() =>
                      setSelectedId((cur) => (cur === a.id ? null : a.id))
                    }
                  />
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Nothing matches this filter — that is not “nothing running”."
                description={
                  <>
                    {scopedCount} lane{scopedCount === 1 ? "" : "s"} in scope
                    for {project || "every project"}; the state filter or the
                    show-ended toggle hides the rest. A capped or offline
                    station is a note like this one, never an empty list.
                  </>
                }
              />
            )}
          </CardBody>
        </Card>
        <div className={styles.rail}>
          <CapacityCard
            heldAttempts={heldAttempts}
            pendingAttempts={pendingAttempts}
          />
          <AttentionCard />
        </div>
      </div>
    </div>
  );
}