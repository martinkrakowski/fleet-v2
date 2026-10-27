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
import type { LanesData } from "./live";
import type { QuestionSummary } from "../questions/summary";
import { STATE_ORDER, kpiScopeNote, summary, woOf } from "./derive";
import { NOT_CONFIGURED_REASON, useAutoRefresh } from "./use-auto-refresh";
import { LanesKpiRow } from "./components/lanes-kpi-row";
import { LanesToolbar } from "./components/lanes-toolbar";
import { LaneRow } from "./components/lane-row";
import { CapacityCard } from "./components/capacity-card";
import { AttentionCard } from "./components/attention-card";
import styles from "./lanes.module.css";

export function LanesClient({
  data,
  questions,
}: {
  data: LanesData;
  questions: QuestionSummary;
}) {
  useAutoRefresh(data.source, data.fallbackReason);
  const [showEnded, setShowEnded] = useState(true);
  const [stateFilter, setStateFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const project = useSearchParams().get("project") ?? "";

  const rows = data.attempts
    .filter((a) => !project || woOf(a, data.workOrders).project === project)
    .filter((a) => showEnded || a.capacity !== "released")
    .filter((a) => !stateFilter || summary(a)[0] === stateFilter)
    .sort((x, y) => {
      const s = STATE_ORDER[summary(x)[0]] - STATE_ORDER[summary(y)[0]];
      if (s) return s;
      return (y.startedAt ?? y.queuedAt ?? "").localeCompare(
        x.startedAt ?? x.queuedAt ?? ""
      );
    });
  const scopedCount = data.attempts.filter(
    (a) => !project || woOf(a, data.workOrders).project === project
  ).length;

  const queued = data.attempts.filter((a) => a.capacity === "pending").length;
  const unknown = data.attempts.filter((a) => summary(a)[0] === "unknown").length;
  const blocked = data.attempts.filter((a) => summary(a)[0] === "blocked").length;
  const heldAttempts = data.attempts
    .filter((a) => a.capacity === "held")
    .sort((x, y) => (x.slot ?? 0) - (y.slot ?? 0));
  const pendingAttempts = data.attempts
    .filter((a) => a.capacity === "pending")
    .sort((x, y) => (x.queuedAt ?? "").localeCompare(y.queuedAt ?? ""));

  return (
    <div className={styles.page} data-contained-scroll>
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
          data.source === "api" ? (
            <RouteChip>
              live · GET /v1/attempts · {data.total} recorded
              {data.truncated ? ` · showing ${data.attempts.length}` : ""}
            </RouteChip>
          ) : (
            <RouteChip variant="gap">fixture · {data.fallbackReason}</RouteChip>
          )
        }
      />
      <p className={styles.meta}>
        {data.source === "api"
          ? `Recorded state, not runner observations · read ${data.observedAtIso} · refreshes every 30 s`
          : `Sample data, not this station · read ${data.observedAtIso}${
              data.fallbackReason !== NOT_CONFIGURED_REASON
                ? " · the API did not answer; retrying every 30 s"
                : ""
            }`}
      </p>
      <LanesKpiRow
        queued={queued}
        unknown={unknown}
        blocked={blocked}
        held={heldAttempts.length}
        slots={data.capacity?.slots ?? null}
        host={data.capacity?.host ?? null}
        port={data.capacity?.port ?? null}
        queuedAll={pendingAttempts.length}
        scopeNote={kpiScopeNote(
          data.total,
          data.attempts.length,
          data.truncated
        )}
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
          <CardBody
            className={styles.laneScroll}
            tabIndex={0}
            role="region"
            aria-label="Lanes"
          >
            {rows.length > 0 ? (
              <ul className={styles.lanes}>
                {rows.map((a) => (
                  <LaneRow
                    key={a.id}
                    attempt={a}
                    workOrders={data.workOrders}
                    attempts={data.attempts}
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
        <div
          className={styles.rail}
          tabIndex={0}
          role="region"
          aria-label="Attention"
        >
          <CapacityCard
            heldAttempts={heldAttempts}
            pendingAttempts={pendingAttempts}
            capacity={data.capacity}
          />
          <AttentionCard attempts={data.attempts} questions={questions} />
        </div>
      </div>
    </div>
  );
}
