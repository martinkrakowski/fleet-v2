import { Card, CardBody, CardHeader, RouteChip } from "@fleet/ui";
import type { Attempt, Receipt } from "../fixture";
import styles from "../attempt.module.css";

export function ReceiptsCard({ attempt }: { attempt: Attempt }) {
  const R = attempt.receipts;
  const slots: Array<[string, Receipt | null | undefined]> = [
    ["completion", R.completion],
    ["verification", R.verification],
    ["review", R.review],
    ["acceptance", R.acceptance],
  ];
  if (R.merge) slots.push(["merge", R.merge]);

  const awaited: Record<string, string> = {
    completion: "no completion receipt yet",
    verification: "the verification host has not spoken",
    review: "the reviewer seat has not spoken",
    acceptance: "no acceptance binds this head yet",
    merge: "not merged",
  };

  return (
    <Card>
      <CardHeader
        title="Receipts"
        actions={<RouteChip>GET /v1/heads/:sha/evidence</RouteChip>}
      />
      <CardBody>
        {slots.map(([name, r]) =>
          r ? (
            <div
              key={name}
              className={[
                styles.receipt,
                r.pass ? styles.receiptPass : styles.receiptFail,
              ].join(" ")}
            >
              <div className={styles.receiptTop}>
                <b className={styles.receiptId}>
                  {name} · {r.id}
                </b>
                <span>
                  {r.at}
                  {r.head && ` · head ${r.head}`}
                </span>
              </div>
              <p className={styles.receiptText}>{r.text}</p>
            </div>
          ) : (
            <div
              key={name}
              className={[styles.receipt, styles.receiptPending].join(" ")}
            >
              <div className={styles.receiptTop}>
                <b className={styles.receiptId}>{name}</b>
                <span>awaited</span>
              </div>
              <p className={styles.receiptText}>{awaited[name]}</p>
            </div>
          ),
        )}
      </CardBody>
    </Card>
  );
}
