import { type ReactNode } from "react";
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  RouteChip,
} from "@fleet/ui";
import { relativeTime } from "../live-view";
import {
  journalCountText,
  journalStatusNote,
  journalStatusTone,
} from "../journal-view";
import type { JournalPanel } from "../live-context";
import styles from "../attempt.module.css";

export function LiveJournalPanel({
  panel,
  attemptId,
  observedAtIso,
}: {
  panel: JournalPanel;
  attemptId: string;
  observedAtIso: string;
}) {
  let actions: ReactNode = null;
  if (panel.panel === "error") {
    actions = <RouteChip variant="gap">error · not read</RouteChip>;
  } else if (panel.panel !== "not-read") {
    actions = (
      <RouteChip>live · GET /v1/attempts/{attemptId}/journal</RouteChip>
    );
  }

  let body: ReactNode;
  switch (panel.panel) {
    case "listed":
      body = (
        <>
          <p className={styles.muted}>
            {journalCountText(panel.entries.length)} · recorded, not a runner
            observation
          </p>
          {panel.entries.length === 0 ? (
            <p>No journal entries recorded for this attempt.</p>
          ) : (
            <ol
              className={styles.journalList}
              aria-label="Journal entries in recorded order"
            >
              {panel.entries.map((entry) => (
                <li key={entry.id}>
                  <b>{entry.action}</b>{" "}
                  <Badge tone={journalStatusTone(entry.status)}>
                    {entry.status}
                  </Badge>{" "}
                  {journalStatusNote(entry)}{" "}
                  <time dateTime={entry.recordedAtIso}>
                    {entry.recordedAtIso}
                  </time>{" "}
                  <span className={styles.muted}>
                    {relativeTime(entry.recordedAtIso, observedAtIso)}
                  </span>
                  <br />
                  <span className="mono">
                    {entry.sessionId ?? "no session recorded"}
                  </span>
                  <br />
                  {entry.detail !== null ? (
                    <pre className={styles.journalDetail}>{entry.detail}</pre>
                  ) : (
                    "no detail recorded"
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      );
      break;
    case "not-found":
      body = (
        <p>
          The journal route answered not-found for this attempt (live, not
          sample data).
        </p>
      );
      break;
    case "error":
      body = (
        <Banner
          tone="danger"
          title="The journal read did not answer as expected"
        >
          <p>
            <code>{panel.reason}</code>
          </p>
          <p>Nothing here is sample data.</p>
        </Banner>
      );
      break;
    default:
      body = <p>Journal not read on this page.</p>;
  }

  return (
    <Card>
      <CardHeader
        title="Journal"
        subtitle="recorded actions · read-only"
        actions={actions}
      />
      <CardBody>{body}</CardBody>
    </Card>
  );
}
