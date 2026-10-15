import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  KeyValueList,
  KeyValueRow,
  type SemanticTone,
} from "@fleet/ui";
import type { Attempt } from "../fixture";
import styles from "../attempt.module.css";

const OP_LABELS: Record<string, string> = {
  reconcile: "Reconcile",
  stop: "Stop",
  collect: "Collect artifacts",
  fix: "Start fix",
  merge: "Merge",
};

const OP_DESC: Record<string, string> = {
  reconcile: "Re-read the runner.",
  stop: "Stop the command — or withdraw the queued intent before a session exists.",
  collect: "Legal only after a completion receipt.",
  fix: "A fresh attempt on the same work order, numbered, frozen from this package.",
  merge: "The pull request is looked up before any forge call.",
};

function opTone(op: string): SemanticTone {
  if (op === "merge") return "ok";
  if (op === "stop") return "danger";
  return "neutral";
}

export function OperationsSidebar({ attempt, word }: { attempt: Attempt; word: string }) {
  const legalOps = ["reconcile", "stop", "collect", "fix", "merge"];
  const isUnknown = word === "unknown";

  const enabledOps = legalOps.filter((op) => {
    if (!attempt.legal.includes(op)) return false;
    if (isUnknown && (op === "stop" || op === "collect" || op === "merge")) return false;
    return true;
  });

  const blockedByUnknown: Array<[string, string]> = legalOps
    .filter(
      (op) =>
        attempt.legal.includes(op) &&
        isUnknown &&
        (op === "stop" || op === "collect" || op === "merge"),
    )
    .map((op) => [
      op,
      "unknown outcome: this operation is not enabled until the runner answers",
    ]);

  const notOfferedRows: Array<[string, string]> = [
    ...blockedByUnknown,
    ...(attempt.notOffered ?? []),
  ];

  return (
    <Card>
      <CardHeader title="Operations" subtitle="only legal actions are enabled" />
      <CardBody>
        <div className={styles.opsList}>
          {enabledOps.map((op) => (
            <Button
              key={op}
              tone={opTone(op)}
              variant="outline"
              className={styles.opButton}
              data-action="op"
              data-op={op}
              data-att={attempt.id}
            >
              <span className={styles.opTitle}>
                <b>{OP_LABELS[op] || op}</b>
                {attempt.fixOf && op === "fix" && <span className={styles.opAside}>on {attempt.wo}</span>}
                {op === "merge" && attempt.mergeHead && (
                  <span className={styles.opAside}>{attempt.mergeHead}</span>
                )}
              </span>
              <span className={styles.opDesc}>{OP_DESC[op] || ""}</span>
            </Button>
          ))}
        </div>

        {notOfferedRows.length > 0 && (
          <div className={styles.notOfferedWrap}>
            <h3 className={styles.notOfferedHead}>Not offered, and why</h3>
            <div className={styles.notOfferedList}>
              {notOfferedRows.map(([op, why]) => (
                <div key={op} className={styles.notOffered}>
                  <b className={styles.notOfferedLabel}>{OP_LABELS[op] || op}</b>
                  <span className={styles.notOfferedReason}>{why}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {attempt.receipts.decision && attempt.receipts.decision.pending && (
          <Banner tone="decision" className={styles.bannerSpacing} title="Open decision">
            <div className={styles.decisionRow}>
              <b>{attempt.receipts.decision.id}</b>
              <span>{attempt.receipts.decision.door} door</span>
            </div>
            <p className={styles.decisionQuestion}>{attempt.receipts.decision.question}</p>
            <KeyValueList>
              <KeyValueRow term="scope" mono>
                {attempt.receipts.decision.scope}
              </KeyValueRow>
              <KeyValueRow term="asked" mono>
                {attempt.receipts.decision.askedAt}
              </KeyValueRow>
              <KeyValueRow term="answer">
                <span className={styles.muted}>none — silence is not approval</span>
              </KeyValueRow>
            </KeyValueList>
          </Banner>
        )}
      </CardBody>
    </Card>
  );
}
