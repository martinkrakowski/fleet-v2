import { type ReactNode } from "react";
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  KeyValueList,
  KeyValueRow,
  RouteChip,
} from "@fleet/ui";
import { relativeTime } from "../../attempt/live-view";
import {
  assessmentTone,
  coverageText,
  kindText,
  listText,
  resultTone,
  tallyText,
} from "../evidence-view";
import type { HeadEvidenceView } from "../map-evidence";
import type { EvidencePanel } from "../live";
import styles from "../work-order.module.css";

function FoundEvidenceBody({
  evidence,
  observedAtIso,
}: {
  evidence: HeadEvidenceView;
  observedAtIso: string;
}) {
  return (
    <>
      <KeyValueList>
        <KeyValueRow term="assessment state">
          <Badge tone={assessmentTone(evidence.state)}>{evidence.state}</Badge>
        </KeyValueRow>
        <KeyValueRow term="revision">{evidence.revision}</KeyValueRow>
        <KeyValueRow term="policy revision">
          {evidence.policyRevision}
        </KeyValueRow>
        <KeyValueRow term="implementer">{evidence.implementerModel}</KeyValueRow>
        <KeyValueRow term="requested reviewer">
          {evidence.requestedReviewerModel ?? "no review requested"}
        </KeyValueRow>
        <KeyValueRow term="required checks">
          {listText(evidence.requiredChecks, "none recorded")}
        </KeyValueRow>
        <KeyValueRow term="blockers">
          {listText(evidence.blockers, "no blockers recorded")}
        </KeyValueRow>
        <KeyValueRow term="acceptance">
          {evidence.acceptanceReceiptId === null
            ? "no acceptance recorded"
            : `acceptance receipt ${evidence.acceptanceReceiptId}`}
        </KeyValueRow>
        <KeyValueRow term="review tally">
          {tallyText(evidence.reviewTally)}
        </KeyValueRow>
      </KeyValueList>

      <h4>Verifications</h4>
      {evidence.verifications.length === 0 ? (
        <p>No verification receipts recorded.</p>
      ) : (
        <ul className={styles.evidenceList}>
          {evidence.verifications.map((verification) => (
            <li key={verification.id}>
              <b>{verification.procedureName}</b>{" "}
              <Badge tone={resultTone(verification.result)}>
                {verification.result}
              </Badge>{" "}
              {verification.exitCode === null
                ? "no exit code recorded"
                : `exit code ${verification.exitCode}`}{" "}
              · {coverageText(verification.coverage)} · completed{" "}
              <time dateTime={verification.completedAtIso}>
                {verification.completedAtIso}
              </time>{" "}
              <span className={styles.muted}>
                {relativeTime(verification.completedAtIso, observedAtIso)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4>Reviews</h4>
      {evidence.reviews.length === 0 ? (
        <p>No review receipts recorded.</p>
      ) : (
        <ul className={styles.evidenceList}>
          {evidence.reviews.map((review) => (
            <li key={review.id}>
              <b>{review.reviewerModel}</b>{" "}
              <Badge tone={resultTone(review.result)}>{review.result}</Badge>{" "}
              · read-only verified {review.readOnlyVerified ? "yes" : "no"} ·{" "}
              {kindText(review.kind)} · completed{" "}
              <time dateTime={review.completedAtIso}>
                {review.completedAtIso}
              </time>{" "}
              <span className={styles.muted}>
                {relativeTime(review.completedAtIso, observedAtIso)}
              </span>
              {review.findings.length === 0 ? (
                <p className={styles.muted}>no findings recorded</p>
              ) : (
                <ul className={styles.evidenceList}>
                  {review.findings.map((finding) => (
                    <li key={finding.findingId}>
                      {finding.severity} · {finding.state}
                      <p className={styles.findingText}>{finding.summary}</p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>Dispositions</h4>
      {evidence.dispositions.length === 0 ? (
        <p>No dispositions recorded.</p>
      ) : (
        <ul className={styles.evidenceList}>
          {evidence.dispositions.map((disposition) => (
            <li key={disposition.id}>
              finding {disposition.findingId} · {disposition.state} · recorded
              by {disposition.recordedBy} ·{" "}
              <time dateTime={disposition.recordedAtIso}>
                {disposition.recordedAtIso}
              </time>{" "}
              <span className={styles.muted}>
                {relativeTime(disposition.recordedAtIso, observedAtIso)}
              </span>
              <p className={styles.findingText}>{disposition.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function HeadEvidencePanel({
  panel,
  observedAtIso,
}: {
  panel: EvidencePanel;
  observedAtIso: string;
}) {
  let actions: ReactNode = null;
  if (panel.panel === "found") {
    actions = (
      <RouteChip>
        live · GET /v1/heads/
        {panel.evidence.candidateHeadSha.slice(0, 12)}/evidence
      </RouteChip>
    );
  } else if (panel.panel === "not-recorded") {
    actions = (
      <RouteChip>
        live · GET /v1/heads/{panel.headSha.slice(0, 12)}/evidence
      </RouteChip>
    );
  } else if (panel.panel === "error") {
    actions = <RouteChip variant="gap">error · not read</RouteChip>;
  }

  let body: ReactNode;
  switch (panel.panel) {
    case "found":
      body = (
        <FoundEvidenceBody evidence={panel.evidence} observedAtIso={observedAtIso} />
      );
      break;
    case "not-recorded":
      body = (
        <p>
          No assessment is recorded at head {panel.headSha}: not recorded, never
          a pass.
        </p>
      );
      break;
    case "error":
      body = (
        <Banner
          tone="danger"
          title="The evidence read did not answer as expected"
        >
          <p>
            <code>{panel.reason}</code>
          </p>
          <p>Nothing here is sample data.</p>
        </Banner>
      );
      break;
    case "no-head":
      body = <p>No head commit collected: no evidence to read.</p>;
      break;
    default:
      body = <p>Evidence not read on this page.</p>;
  }

  return (
    <Card>
      <CardHeader
        title="Head evidence"
        subtitle="recorded at the attempt's collected head · read-only"
        actions={actions}
      />
      <CardBody>{body}</CardBody>
    </Card>
  );
}
