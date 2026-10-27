import Link from "next/link";
import { type ReactNode } from "react";
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KeyValueList,
  KeyValueRow,
  PageHeader,
  RouteChip,
} from "@fleet/ui";
import { attemptIdHref, recordedStateSummary } from "../../lanes/derive";
import { relativeTime } from "../../attempt/live-view";
import { chainLabel, prerequisitesText } from "../../attempt/work-order-view";
import { LiveJournalPanel } from "../../attempt/components/live-journal-panel";
import { chainNoteText, notReadText } from "../timeline-view";
import type { TimelineData } from "../live";
import styles from "../work-order.module.css";

function TimelineBody({ data }: { data: TimelineData }) {
  switch (data.view) {
    case "found": {
      const notRead = notReadText(data.journalsNotRead);
      return (
        <>
          <Card>
            <CardHeader
              title="Work order"
              subtitle="recorded facts · read-only"
            />
            <CardBody>
              <KeyValueList>
                <KeyValueRow term="state">{data.workOrder.state}</KeyValueRow>
                <KeyValueRow term="lane">{data.workOrder.laneId}</KeyValueRow>
                <KeyValueRow term="task">{data.workOrder.taskId}</KeyValueRow>
                <KeyValueRow term="project">
                  <Link
                    href={`/projects/${encodeURIComponent(data.workOrder.projectId)}`}
                  >
                    {data.workOrder.projectId}
                  </Link>
                </KeyValueRow>
                <KeyValueRow term="base commit" mono>
                  {data.workOrder.baseCommit}
                </KeyValueRow>
                <KeyValueRow term="revision">
                  {data.workOrder.revision}
                </KeyValueRow>
                <KeyValueRow term="prerequisites">
                  {prerequisitesText(data.workOrder.prerequisiteWorkOrderIds)}
                </KeyValueRow>
                <KeyValueRow term="created">
                  <time dateTime={data.workOrder.createdAtIso}>
                    {data.workOrder.createdAtIso}
                  </time>{" "}
                  <span className={styles.muted}>
                    {relativeTime(
                      data.workOrder.createdAtIso,
                      data.observedAtIso,
                    )}
                  </span>
                </KeyValueRow>
                <KeyValueRow term="updated">
                  <time dateTime={data.workOrder.updatedAtIso}>
                    {data.workOrder.updatedAtIso}
                  </time>{" "}
                  <span className={styles.muted}>
                    {relativeTime(
                      data.workOrder.updatedAtIso,
                      data.observedAtIso,
                    )}
                  </span>
                </KeyValueRow>
              </KeyValueList>
            </CardBody>
          </Card>

          {notRead !== "" ? (
            <p className={styles.muted}>{notRead}</p>
          ) : null}

          {data.attempts.length === 0 ? (
            <p className={styles.muted}>
              No attempts recorded on this work order.
            </p>
          ) : (
            <ol
              className={styles.timeline}
              aria-label="Attempts in fix-chain order, first pass first"
            >
              {data.attempts.map((t) => {
                const [word] = recordedStateSummary(t.attempt.state, null);
                return (
                  <li key={t.attempt.id} className={styles.step}>
                    <div className={styles.stepHead}>
                      <b>{chainLabel(t.attempt)}</b>
                      <Link
                        href={attemptIdHref(t.attempt.id)}
                        className="mono"
                      >
                        {t.attempt.id}
                      </Link>
                      <Badge tone={word}>{word}</Badge>
                      <span className={styles.muted}>
                        {t.attempt.outcome ?? "no outcome recorded"}
                      </span>
                      <span className={styles.muted}>
                        {chainNoteText(t.chain)}
                      </span>
                    </div>

                    <p className={styles.muted}>
                      created{" "}
                      <time dateTime={t.attempt.createdAtIso}>
                        {t.attempt.createdAtIso}
                      </time>{" "}
                      {relativeTime(
                        t.attempt.createdAtIso,
                        data.observedAtIso,
                      )}{" "}
                      · updated{" "}
                      <time dateTime={t.attempt.updatedAtIso}>
                        {t.attempt.updatedAtIso}
                      </time>{" "}
                      {relativeTime(
                        t.attempt.updatedAtIso,
                        data.observedAtIso,
                      )}
                    </p>

                    <p>
                      {t.attempt.artifacts !== null ? (
                        <>
                          head{" "}
                          <span className="mono">
                            {t.attempt.artifacts.headCommit}
                          </span>
                        </>
                      ) : (
                        "no head collected"
                      )}
                    </p>
                    <p className={styles.muted}>
                      head evidence: not read on this page
                    </p>

                    <LiveJournalPanel
                      panel={t.journal}
                      attemptId={t.attempt.id}
                      observedAtIso={data.observedAtIso}
                    />
                  </li>
                );
              })}
            </ol>
          )}
        </>
      );
    }
    case "not-found":
      return (
        <EmptyState
          title={`Work order ${data.workOrderId} is not recorded on this station`}
          description="Live, not sample data: GET /v1/work-orders/:id answered not-found."
        />
      );
    case "error":
      return (
        <Banner
          tone="danger"
          title="The work order read did not answer as expected"
        >
          <p>
            <code>{data.reason}</code>
          </p>
          <p>Nothing here is sample data.</p>
        </Banner>
      );
    case "not-configured":
      return (
        <p className={styles.muted}>
          The API is not configured, so no work order was read. There is no
          sample timeline.
        </p>
      );
    case "missing-id":
      return (
        <EmptyState
          title="No work order selected"
          description={<Link href="/lanes">Go to lanes</Link>}
        />
      );
  }
}

export function WorkOrderTimeline({ data }: { data: TimelineData }) {
  const title =
    data.view === "missing-id"
      ? "Work order"
      : `Work order ${data.workOrderId}`;

  let actions: ReactNode = null;
  if (data.view === "found" || data.view === "not-found") {
    actions = (
      <RouteChip>
        live · GET /v1/work-orders/{data.workOrderId}
      </RouteChip>
    );
  } else if (data.view === "error") {
    actions = <RouteChip variant="gap">error · not read</RouteChip>;
  } else if (data.view === "not-configured") {
    actions = (
      <RouteChip variant="gap">not configured · not read</RouteChip>
    );
  }

  const readMeta =
    data.view !== "missing-id" && data.view !== "not-configured";

  return (
    <div className={styles.page}>
      <PageHeader
        title={title}
        description="One work order's recorded attempts in fix-chain order, first pass first, each with its journal. Recorded facts, not runner observations. Read-only."
        actions={actions}
      />
      {readMeta ? (
        <p className={styles.meta}>
          Recorded facts, not runner observations · read {data.observedAtIso}{" "}
          · reload to re-read
        </p>
      ) : null}
      <TimelineBody data={data} />
    </div>
  );
}
