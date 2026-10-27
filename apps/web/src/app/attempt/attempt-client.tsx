"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Badge,
  Banner,
  EmptyState,
  RouteChip,
  type BadgeVariant,
} from "@fleet/ui";
import {
  FIXTURE,
  findAttempt,
  workOrderOf,
  attemptsOf,
  summarize,
} from "./fixture";
import type { AttemptPageData } from "./live";
import type { AttemptContext } from "./live-context";
import { LiveWorkOrderCard } from "./components/live-work-order-card";
import {
  ATTEMPT_REFRESH_MS,
  useAutoRefresh,
} from "../lanes/use-auto-refresh";
import { attemptIdHref } from "../lanes/derive";
import { announcementFor, cliHints } from "./live-view";
import { LiveAttemptRecord } from "./components/live-attempt-record";
import { LiveOperationsCard } from "./components/live-operations-card";
import { AttemptHeader } from "./components/attempt-header";
import { RunnerFactsGrid } from "./components/runner-facts-grid";
import { AttemptLifecycleStepper } from "./components/attempt-lifecycle-stepper";
import { ModelCostCard } from "./components/model-cost-card";
import { WorktreeCard } from "./components/worktree-card";
import { ReadinessCard } from "./components/readiness-card";
import { ReceiptsCard } from "./components/receipts-card";
import { FrozenBriefAccordion } from "./components/frozen-brief-accordion";
import { WorkOrderSidebar } from "./components/work-order-sidebar";
import { OperationsSidebar } from "./components/operations-sidebar";
import styles from "./attempt.module.css";

function sampleTree(attemptId: string) {
  const attempt = findAttempt(attemptId) ?? FIXTURE.attempts[0];
  const workOrder = workOrderOf(attempt);
  const siblings = attemptsOf(attempt.wo);
  const [word, note, variant] = summarize(attempt);
  return { attempt, workOrder, siblings, word, note, variant };
}

function routeLine(data: AttemptPageData): ReactNode {
  switch (data.view) {
    case "found":
    case "unknown":
    case "not-found":
      return (
        <>
          <RouteChip>live · GET /v1/attempts/{data.attemptId}</RouteChip>
          <p className={styles.muted}>
            Recorded state, not a runner observation · read{" "}
            <time dateTime={data.observedAtIso}>{data.observedAtIso}</time> ·
            refreshes every 10 s while this tab is visible
          </p>
        </>
      );
    case "error":
      return <RouteChip variant="gap">error · {data.reason}</RouteChip>;
    case "sample":
      return (
        <RouteChip variant="gap">sample · {data.fallbackReason}</RouteChip>
      );
    case "missing-id":
      return null;
  }
}

function renderSidebar(
  data: AttemptPageData,
  context: AttemptContext,
  onCopied: (message: string) => void,
): ReactNode {
  switch (data.view) {
    case "sample": {
      const { attempt, workOrder, siblings, word } = sampleTree(data.attemptId);
      return (
        <>
          <aside aria-label="Work order">
            <WorkOrderSidebar
              attempt={attempt}
              workOrder={workOrder}
              siblings={siblings}
            />
          </aside>
          <aside className={styles.opsCol} aria-label="Operations">
            <OperationsSidebar attempt={attempt} word={word} />
          </aside>
        </>
      );
    }
    case "found":
      return (
        <>
          <LiveWorkOrderCard
            panel={context.workOrder}
            attemptId={data.attemptId}
            observedAtIso={data.observedAtIso}
            reasonWhenNotRead="Work order not read on this page."
          />
          <LiveOperationsCard hints={cliHints(data)} onCopied={onCopied} />
        </>
      );
    case "unknown":
      return (
        <>
          <LiveWorkOrderCard
            panel={context.workOrder}
            attemptId={data.attemptId}
            observedAtIso={data.observedAtIso}
            reasonWhenNotRead="Not read: the attempt record is unknown, so its work order is not known here. Not idle, not a pass."
          />
          <LiveOperationsCard hints={cliHints(data)} onCopied={onCopied} />
        </>
      );
    case "not-found":
      return <p className={styles.muted}>nothing to act on</p>;
    default:
      return null;
  }
}

function renderRecord(data: AttemptPageData): ReactNode {
  switch (data.view) {
    case "sample": {
      const { attempt, siblings, word, note, variant } = sampleTree(
        data.attemptId,
      );
      const notInFixture = data.attemptId !== "" && !findAttempt(data.attemptId);
      return (
        <>
          <Banner tone="warn" title="Sample data, not this station">
            <p>
              The API boundary is not configured, so this page shows a sample
              attempt and never refreshes.
            </p>
            {notInFixture ? (
              <p>
                {data.attemptId} is not in the sample data; showing sample
                attempt {attempt.id}.
              </p>
            ) : null}
          </Banner>
          <AttemptHeader
            attempt={attempt}
            word={word}
            note={note}
            wordVariant={variant as BadgeVariant}
            siblingCount={siblings.length}
          />
          <RunnerFactsGrid attempt={attempt} />
          <AttemptLifecycleStepper attempt={attempt} />
          <ModelCostCard attempt={attempt} />
          <WorktreeCard attempt={attempt} />
          <ReadinessCard attempt={attempt} />
          <ReceiptsCard attempt={attempt} />
          <FrozenBriefAccordion attempt={attempt} />
        </>
      );
    }
    case "found":
      return <LiveAttemptRecord data={data} />;
    case "unknown":
      return (
        <>
          <div className={styles.headBadges}>
            <span className="mono">{data.attemptId}</span>
            <Badge tone="unknown">unknown</Badge>
          </div>
          <Banner
            tone="warn"
            title="Recorded host cannot be resolved: holds its slot"
          >
            <p>
              <code>{data.reason}</code>
            </p>
            <p>
              Not idle, not a pass. Every operation below is disabled until the
              host resolves.
            </p>
          </Banner>
        </>
      );
    case "not-found":
      return (
        <EmptyState
          title={`Attempt ${data.attemptId} is not recorded on this station`}
          description="Live, not sample data: GET /v1/attempts/:id answered not-found."
          actions={<Link href="/lanes">Open Lanes</Link>}
        />
      );
    case "error":
      return (
        <Banner tone="danger" title="The API did not answer as expected">
          <p>
            <code>{data.reason}</code>
          </p>
          <p>
            Nothing here is sample data. Retrying every 10 s while this tab is
            visible; no write is ever retried.
          </p>
        </Banner>
      );
    case "missing-id":
      return (
        <EmptyState
          title="No attempt selected"
          description="Open an attempt from Lanes."
          actions={
            <>
              <Link href="/lanes">Open Lanes</Link>
              {data.newestAttemptId !== null ? (
                <Link href={attemptIdHref(data.newestAttemptId)}>
                  Open the most recently updated attempt {data.newestAttemptId}
                </Link>
              ) : null}
            </>
          }
        />
      );
  }
}

export default function AttemptPage({
  data,
  context,
}: {
  data: AttemptPageData;
  context: AttemptContext;
}) {
  useAutoRefresh(data.source, data.fallbackReason, ATTEMPT_REFRESH_MS);
  const [copied, setCopied] = useState<string | null>(null);
  // A copy confirmation lasts until the next data update, so later state changes are announced.
  useEffect(() => {
    setCopied(null);
  }, [data]);

  return (
    <div className={styles.layout} data-contained-scroll>
      <div
        className={styles.sidebarCol}
        tabIndex={0}
        role="region"
        aria-label="Work order and operations"
      >
        {renderSidebar(data, context, setCopied)}
      </div>

      <section
        className={styles.recordCol}
        tabIndex={0}
        role="region"
        aria-label="Attempt record"
      >
        <p className={styles.liveStatus} aria-live="polite">
          {copied ?? announcementFor(data)}
        </p>
        {routeLine(data)}
        {renderRecord(data)}
      </section>
    </div>
  );
}
