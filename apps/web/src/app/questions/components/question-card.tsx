import type { ReactNode } from "react";
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  Chip,
  KeyValueList,
  KeyValueRow,
} from "@fleet/ui";
import type { QuestionView } from "../map-question";
import {
  answerCommands,
  questionIdIsCliSafe,
  blocksText,
  isPastExpiry,
  stateTone,
  relativeTimeEitherWay,
} from "../question-view";
import { relativeTime } from "../../attempt/live-view";
import styles from "../questions.module.css";

export function QuestionCard({
  question,
  observedAtIso,
}: {
  question: QuestionView;
  observedAtIso: string;
}) {
  const pastExpiry = isPastExpiry(question, observedAtIso);
  const commands = answerCommands(question);

  let doorBlock: ReactNode = null;
  if (question.doorKind === "one-way") {
    doorBlock = (
      <Banner
        tone="decision"
        title="One-way door: needs the owner's signed decision"
      >
        <p>
          One-way door: answered only by the owner's signed decision for
          request {question.linkedRequestId}. The web cannot sign and records
          nothing here;{" "}
          <code className={styles.mono}>fleet-v2 questions sync</code> settles
          the question once a verified decision exists.
        </p>
      </Banner>
    );
  } else if (question.state === "open") {
    doorBlock = (
      <div>
        <p>Answer with the CLI until the web can (Q5):</p>
        {questionIdIsCliSafe(question) ? null : (
          <p>This question id starts with a dash, which the CLI would read as a flag, so no command is shown.</p>
        )}
        {commands.map((command) => (
          <p key={command}>
            <code className={styles.mono}>{command}</code>
          </p>
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader
        title={question.title}
        subtitle={`question ${question.questionId} · revision ${question.revision} · asked by ${question.askedBy}`}
        actions={
          <>
            <Badge tone={stateTone(question.state)}>{question.state}</Badge>
            <Chip
              tone={question.doorKind === "one-way" ? "decision" : "neutral"}
            >
              {question.doorKind} door
            </Chip>
          </>
        }
      />
      <CardBody>
        <KeyValueList>
          <KeyValueRow term="Asked">
            <time dateTime={question.askedAt}>{question.askedAt}</time>{" "}
            <span className={styles.muted}>
              {relativeTime(question.askedAt, observedAtIso)}
            </span>
          </KeyValueRow>
          <KeyValueRow term="Expires">
            {question.expiresAt === null ? (
              "no expiry recorded"
            ) : (
              <>
                <time dateTime={question.expiresAt}>
                  {question.expiresAt}
                </time>{" "}
                <span className={styles.muted}>
                  {relativeTimeEitherWay(question.expiresAt, observedAtIso)}
                </span>
                {pastExpiry ? (
                  <span className={styles.muted}>
                    {" "}· past its recorded expiry · still recorded open
                  </span>
                ) : null}
              </>
            )}
          </KeyValueRow>
        </KeyValueList>
        <pre className={styles.body}>{question.body}</pre>
        <ol aria-label="Options">
          {question.options.map((opt) => (
            <li key={opt.id}>
              <b>{opt.label}</b>{" "}
              <span className={styles.mono}>{opt.id}</span> {opt.consequence}
              {opt.id === question.recommendation.optionId ? (
                <>
                  {" "}
                  <Chip tone="accent">recommended</Chip>{" "}
                  {question.recommendation.because}
                </>
              ) : null}
            </li>
          ))}
        </ol>
        <p>Blocks: {blocksText(question.blocks)}</p>
        {doorBlock}
        {question.state === "expired" ? (
          <p className={styles.muted}>
            expired: stays blocking and is re-asked, never dropped
          </p>
        ) : null}
        {question.answer !== null ? (
          <div>
            <p>
              Answer · {question.answer.shape}
              {question.answer.optionId !== null ? (
                <> · option {question.answer.optionId}</>
              ) : null}{" "}
              · via {question.answer.answeredVia} ·{" "}
              <time dateTime={question.answer.answeredAt}>
                {question.answer.answeredAt}
              </time>
            </p>
            {question.answer.text !== null ? (
              <pre className={styles.body}>{question.answer.text}</pre>
            ) : null}
            {question.answer.reason !== null ? (
              <pre className={styles.body}>{question.answer.reason}</pre>
            ) : null}
            <p className={styles.muted}>recorded advice: it grants nothing</p>
          </div>
        ) : null}
        <p>
          {question.acknowledgement !== null ? (
            <>
              acknowledged by {question.acknowledgement.by}{" "}
              <time dateTime={question.acknowledgement.at}>
                {question.acknowledgement.at}
              </time>
            </>
          ) : (
            "not acknowledged"
          )}
        </p>
      </CardBody>
    </Card>
  );
}
