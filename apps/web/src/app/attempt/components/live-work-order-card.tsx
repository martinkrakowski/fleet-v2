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
  RouteChip,
} from "@fleet/ui";
import { attemptIdHref, recordedStateSummary } from "../../lanes/derive";
import { relativeTime } from "../live-view";
import {
  chainLabel,
  chainOrder,
  heldSlotText,
  prerequisitesText,
  workOrderAnnouncement,
} from "../work-order-view";
import { workOrderHref } from "../../work-order/timeline-view";
import type { WorkOrderPanel } from "../live-context";
import styles from "../attempt.module.css";

const WORK_ORDER_STATES = [
  "approved",
  "prepared",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "ready-to-merge",
  "merged",
  "stopped",
];

function FoundPanel({
  panel,
  attemptId,
  observedAtIso,
}: {
  panel: Extract<WorkOrderPanel, { panel: "found" }>;
  attemptId: string;
  observedAtIso: string;
}) {
  const ordered = chainOrder(panel.attempts);
  const hasCurrent = ordered.some((attempt) => attempt.id === attemptId);
  const stateUnknown = !WORK_ORDER_STATES.includes(panel.workOrder.state);

  return (
    <>
      <KeyValueList>
        <KeyValueRow term="work order" mono>
          {panel.workOrder.id}
        </KeyValueRow>
        <KeyValueRow term="state">
          {stateUnknown ? (
            <>
              <Badge tone="unknown">unknown</Badge>{" "}
              <span className={styles.muted}>{panel.workOrder.state}</span>
            </>
          ) : (
            panel.workOrder.state
          )}
        </KeyValueRow>
        <KeyValueRow term="lane">{panel.workOrder.laneId}</KeyValueRow>
        <KeyValueRow term="task">{panel.workOrder.taskId}</KeyValueRow>
        <KeyValueRow term="project">
          <Link
            href={`/projects/${encodeURIComponent(panel.workOrder.projectId)}`}
          >
            {panel.workOrder.projectId}
          </Link>
        </KeyValueRow>
        <KeyValueRow term="base commit" mono>
          {panel.workOrder.baseCommit}
        </KeyValueRow>
        <KeyValueRow term="revision">{panel.workOrder.revision}</KeyValueRow>
        <KeyValueRow term="prerequisites">
          {prerequisitesText(panel.workOrder.prerequisiteWorkOrderIds)}
        </KeyValueRow>
        <KeyValueRow term="created">
          <time dateTime={panel.workOrder.createdAtIso}>
            {panel.workOrder.createdAtIso}
          </time>{" "}
          <span className={styles.muted}>
            {relativeTime(panel.workOrder.createdAtIso, observedAtIso)}
          </span>
        </KeyValueRow>
        <KeyValueRow term="updated">
          <time dateTime={panel.workOrder.updatedAtIso}>
            {panel.workOrder.updatedAtIso}
          </time>{" "}
          <span className={styles.muted}>
            {relativeTime(panel.workOrder.updatedAtIso, observedAtIso)}
          </span>
        </KeyValueRow>
      </KeyValueList>

      <p>
        <Link
          className={styles.chainLink}
          href={workOrderHref(panel.workOrder.id)}
        >
          Open the work-order timeline
        </Link>
      </p>

      <h3 className={styles.sidebarHeading}>Attempts (fix chain)</h3>
      {ordered.length === 0 ? (
        <p className={styles.muted}>No attempts recorded on this work order.</p>
      ) : (
        <ol
          className={styles.chainList}
          aria-label="Attempts in this work order, first pass first"
        >
          {ordered.map((attempt) => {
            const isCurrent = attempt.id === attemptId;
            const [word] = recordedStateSummary(attempt.state, null);
            const content = (
              <>
                <span className={styles.chainLabel}>{chainLabel(attempt)}</span>
                {isCurrent ? (
                  <>
                    <span className={`${styles.chainCurrent} mono`}>
                      {attempt.id}
                    </span>
                    <span className={styles.muted}>this attempt</span>
                  </>
                ) : (
                  <Link className={`${styles.chainLink} mono`} href={attemptIdHref(attempt.id)}>
                    {attempt.id}
                  </Link>
                )}
                <Badge tone={word}>{word}</Badge>
                <span className={styles.muted}>
                  {attempt.outcome ?? "no outcome recorded"}
                </span>
                {attempt.priorAttemptId !== null ? (
                  <span className={styles.muted}>
                    fix of {attempt.priorAttemptId}
                  </span>
                ) : null}
                <time dateTime={attempt.updatedAtIso}>
                  {attempt.updatedAtIso}
                </time>{" "}
                <span className={styles.muted}>
                  {relativeTime(attempt.updatedAtIso, observedAtIso)}
                </span>
              </>
            );
            return isCurrent ? (
              <li key={attempt.id} className={styles.chainItem} aria-current="true">
                {content}
              </li>
            ) : (
              <li key={attempt.id} className={styles.chainItem}>
                {content}
              </li>
            );
          })}
        </ol>
      )}
      {hasCurrent ? null : (
        <p className={styles.muted}>
          This attempt is not in the work order's recorded attempts.
        </p>
      )}

      <h3 className={styles.sidebarHeading}>
        Slots held (recorded, not a runner observation)
      </h3>
      {panel.heldSlots.length === 0 ? (
        <p className={styles.muted}>
          No slot is recorded as held by this work order's attempts.
        </p>
      ) : (
        <ul className={styles.slotList}>
          {panel.heldSlots.map((slot) => (
            <li key={`${slot.attemptId}-${slot.slotIndex}`}>
              {heldSlotText(slot)}{" "}
              <span className={styles.muted}>
                since{" "}
                <time dateTime={slot.reservedAtIso}>
                  {slot.reservedAtIso}
                </time>{" "}
                {relativeTime(slot.reservedAtIso, observedAtIso)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function LiveWorkOrderCard({
  panel,
  attemptId,
  observedAtIso,
  reasonWhenNotRead,
}: {
  panel: WorkOrderPanel;
  attemptId: string;
  observedAtIso: string;
  reasonWhenNotRead: string;
}) {
  let actions: ReactNode = null;
  if (panel.panel === "found") {
    actions = (
      <RouteChip>live · GET /v1/work-orders/{panel.workOrder.id}</RouteChip>
    );
  } else if (panel.panel === "not-found") {
    actions = (
      <RouteChip>live · GET /v1/work-orders/{panel.workOrderId}</RouteChip>
    );
  } else if (panel.panel === "error") {
    actions = <RouteChip variant="gap">error · not read</RouteChip>;
  }

  let body: ReactNode;
  switch (panel.panel) {
    case "found":
      body = (
        <FoundPanel
          panel={panel}
          attemptId={attemptId}
          observedAtIso={observedAtIso}
        />
      );
      break;
    case "not-found":
      body = (
        <EmptyState
          title={`Work order ${panel.workOrderId} is not recorded on this station`}
          description="Live, not sample data: GET /v1/work-orders/:id answered not-found."
        />
      );
      break;
    case "error":
      body = (
        <Banner
          tone="danger"
          title="The work order read did not answer as expected"
        >
          <p>
            <code>{panel.reason}</code>
          </p>
          <p>
            Nothing here is sample data. The attempt record beside this card is
            still the live read.
          </p>
        </Banner>
      );
      break;
    default:
      body = <p className={styles.muted}>{reasonWhenNotRead}</p>;
  }

  return (
    <Card>
      <CardHeader
        title="Work order"
        subtitle="the lane · read-only"
        actions={actions}
      />
      <CardBody>
        <p className={styles.muted}>{workOrderAnnouncement(panel)}</p>
        {body}
      </CardBody>
    </Card>
  );
}
