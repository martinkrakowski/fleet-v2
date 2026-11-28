import Link from "next/link";
import {
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
import type { BriefPageData } from "./live";
import { formatBriefDigest, selectWorkOrderEntry } from "./map-brief";
import { md } from "./markdown";
import styles from "./brief.module.css";

const ROOT_CLASS = [styles.stack, styles.view].filter(Boolean).join(" ");

function joined(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

export function BriefView({ data }: { data: BriefPageData }) {
  if (data.view === "not-configured") {
    return (
      <div className={ROOT_CLASS} data-contained-scroll>
        <PageHeader
          title="Briefs"
          description="GET /v1/work-orders is not served yet, so no work order or frozen brief was read. There is no sample brief."
          actions={<RouteChip gap>not configured · not read</RouteChip>}
        />
      </div>
    );
  }
  if (data.view === "error") {
    return (
      <div className={ROOT_CLASS} data-contained-scroll>
        <PageHeader title="Briefs" actions={<RouteChip gap>error · not read</RouteChip>} />
        <Banner>{data.reason}</Banner>
      </div>
    );
  }
  if (data.view === "empty") {
    return (
      <div className={ROOT_CLASS} data-contained-scroll>
        <PageHeader title="Briefs" />
        <EmptyState title="No work orders recorded on this station." />
      </div>
    );
  }

  const selected = selectWorkOrderEntry(
    data.entries,
    data.selectedId === null ? undefined : data.selectedId,
  );
  const wo = selected?.workOrder ?? null;
  const attempt = selected?.latestAttempt ?? null;
  const markdown = selected?.briefMarkdown ?? null;

  return (
    <div className={ROOT_CLASS} data-contained-scroll>
      <PageHeader
        title="Briefs"
        description="Work orders and their frozen briefs, read from GET /v1/work-orders. Read-only: nothing here freezes or dispatches."
        actions={<RouteChip>live · GET /v1/work-orders · {data.entries.length} rows</RouteChip>}
      />
      <div className={styles.grid}>
        <Card className={styles.woCard} aria-label="Work orders">
          <CardHeader title="Work orders" subtitle={`${data.entries.length} recorded`} />
          <CardBody className={styles.woScroll} tabIndex={0} role="region" aria-label="Work orders">
            {data.entries.map((entry) => (
              <Link
                key={entry.workOrder.id}
                href={{ pathname: "/brief", query: { workOrderId: entry.workOrder.id } }}
                className={styles.woItem}
                aria-current={entry.workOrder.id === wo?.id ? "true" : undefined}
              >
                <span className={styles.woTitle}>{entry.workOrder.pullRequestTitle ?? entry.workOrder.taskId}</span>
                <span className={styles.woMeta}>
                  {entry.workOrder.id} · {entry.workOrder.laneId} · {entry.workOrder.state}
                </span>
              </Link>
            ))}
          </CardBody>
        </Card>
        <div
          className={[styles.stack, styles.detail].filter(Boolean).join(" ")}
          tabIndex={0}
          role="region"
          aria-label="Brief detail"
        >
          {wo === null ? null : (
            <Card>
              <CardHeader title="Work order" subtitle={wo.id} />
              <CardBody>
                <KeyValueList>
                  <KeyValueRow term="project">{wo.projectId}</KeyValueRow>
                  <KeyValueRow term="task">{wo.taskId}</KeyValueRow>
                  <KeyValueRow term="lane">{wo.laneId}</KeyValueRow>
                  <KeyValueRow term="state">{wo.state}</KeyValueRow>
                  <KeyValueRow term="base commit">{wo.baseCommit}</KeyValueRow>
                  <KeyValueRow term="base branch">{wo.baseBranch ?? "main"}</KeyValueRow>
                  <KeyValueRow term="risk">{wo.risk ?? "high (default)"}</KeyValueRow>
                  <KeyValueRow term="policy revision">{String(wo.policyRevision)}</KeyValueRow>
                  <KeyValueRow term="owned paths">{joined(wo.ownedPaths)}</KeyValueRow>
                  <KeyValueRow term="prerequisites">{joined(wo.prerequisiteWorkOrderIds)}</KeyValueRow>
                </KeyValueList>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Frozen brief" subtitle="read-only" />
            <CardBody>
              <KeyValueList>
                <KeyValueRow term="digest">{formatBriefDigest(attempt?.briefDigest ?? null)}</KeyValueRow>
                <KeyValueRow term="owner decisions">{attempt?.ownerDecisionReferences == null ? "not recorded" : joined(attempt.ownerDecisionReferences)}</KeyValueRow>
              </KeyValueList>
              {markdown === null ? (
                <p>no frozen brief text recorded</p>
              ) : (
                <div className={styles.md} dangerouslySetInnerHTML={{ __html: md(markdown) }} />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Commands" subtitle="run these yourself" />
            <CardBody>
              <code>fleet-v2 work-order list</code>
              <br />
              <code>fleet-v2 brief prepare --work-order {wo?.id ?? "<id>"}</code>
              <br />
              <code>fleet-v2 attempt dispatch</code>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
