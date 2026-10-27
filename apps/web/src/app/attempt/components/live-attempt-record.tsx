import { Badge, Card, CardBody, CardHeader, KeyValueList, KeyValueRow } from "@fleet/ui";
import { recordedStateSummary } from "../../lanes/derive";
import {
  completionRows,
  decisionRefsText,
  relativeTime,
  runnerRows,
  usageSummary,
} from "../live-view";
import type { AttemptPageData } from "../live";
import styles from "../attempt.module.css";

export function LiveAttemptRecord({
  data,
}: {
  data: AttemptPageData & { view: "found" };
}) {
  const attempt = data.attempt;
  const [word, note] = recordedStateSummary(attempt.state, null);
  const runner = runnerRows(attempt.runner);
  const usage = usageSummary(attempt.usage);
  const completion = completionRows(attempt.completion);
  const refs = decisionRefsText(attempt.ownerDecisionReferences);
  const kindLabel =
    attempt.kind === "initial"
      ? "first"
      : `fix ${attempt.fixNumber}${
          attempt.priorAttemptId !== null
            ? ` · fix of ${attempt.priorAttemptId}`
            : ""
        }`;

  return (
    <>
      <Card>
        <CardBody>
          <KeyValueList>
            <KeyValueRow term="id" mono>
              {attempt.id}
            </KeyValueRow>
            <KeyValueRow term="state">
              <Badge tone={word}>{word}</Badge>{" "}
              <span className={styles.headNote}>{note}</span>
            </KeyValueRow>
            <KeyValueRow term="outcome">
              {attempt.outcome ?? "no outcome recorded"}
            </KeyValueRow>
            <KeyValueRow term="kind">{kindLabel}</KeyValueRow>
            <KeyValueRow term="session" mono>
              {attempt.sessionId ?? "no session recorded"}
            </KeyValueRow>
            <KeyValueRow term="created">
              <time dateTime={attempt.createdAtIso}>{attempt.createdAtIso}</time>{" "}
              <span className={styles.muted}>
                {relativeTime(attempt.createdAtIso, data.observedAtIso)}
              </span>
            </KeyValueRow>
            <KeyValueRow term="updated">
              <time dateTime={attempt.updatedAtIso}>{attempt.updatedAtIso}</time>{" "}
              <span className={styles.muted}>
                {relativeTime(attempt.updatedAtIso, data.observedAtIso)}
              </span>
            </KeyValueRow>
          </KeyValueList>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recorded runner seat" />
        <CardBody>
          {runner.length === 0 ? (
            <p className={styles.muted}>no runner recorded on this attempt</p>
          ) : (
            <KeyValueList>
              {runner.map(([term, value]) => (
                <KeyValueRow key={term} term={term} mono>
                  {value}
                </KeyValueRow>
              ))}
            </KeyValueList>
          )}
          <KeyValueList>
            <KeyValueRow term="reachable">
              unknown{" "}
              <span className={styles.muted}>
                · recorded, not observed; reconcile asks the runner
              </span>
            </KeyValueRow>
            <KeyValueRow term="active">
              unknown{" "}
              <span className={styles.muted}>
                · recorded, not observed; reconcile asks the runner
              </span>
            </KeyValueRow>
          </KeyValueList>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Usage" />
        <CardBody>
          <p className={styles.muted}>{usage.note}</p>
          {usage.rows.length > 0 ? (
            <KeyValueList>
              {usage.rows.map(([term, value]) => (
                <KeyValueRow key={term} term={term} mono>
                  {value}
                </KeyValueRow>
              ))}
            </KeyValueList>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Artifacts and completion" />
        <CardBody>
          {attempt.artifacts === null ? (
            <p className={styles.muted}>artifacts not collected</p>
          ) : (
            <KeyValueList>
              <KeyValueRow term="head commit" mono>
                {attempt.artifacts.headCommit}
              </KeyValueRow>
              <KeyValueRow term="commit count">
                {attempt.artifacts.commitCount}
              </KeyValueRow>
              <KeyValueRow term="notes">{attempt.artifacts.notes}</KeyValueRow>
            </KeyValueList>
          )}
          <KeyValueList>
            {completion.map(([term, value]) => (
              <KeyValueRow key={term} term={term} mono>
                {value}
              </KeyValueRow>
            ))}
          </KeyValueList>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Review and decisions" />
        <CardBody>
          <KeyValueList>
            <KeyValueRow term="reviewer seat">
              {attempt.reviewerSeat ?? "not recorded"}
            </KeyValueRow>
            <KeyValueRow term="owner decisions">{refs}</KeyValueRow>
          </KeyValueList>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Brief and base" />
        <CardBody>
          <KeyValueList>
            <KeyValueRow term="brief digest" mono>
              {attempt.briefDigest ?? "not recorded"}
            </KeyValueRow>
            <KeyValueRow term="base commit" mono>
              {attempt.baseCommit}
            </KeyValueRow>
            <KeyValueRow term="stop reason">
              {attempt.stopReason ?? "not recorded"}
            </KeyValueRow>
          </KeyValueList>
        </CardBody>
      </Card>
    </>
  );
}
