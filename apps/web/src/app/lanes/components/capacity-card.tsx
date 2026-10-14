import Link from "next/link";
import { Card, CardBody, CardHeader, RouteChip } from "@fleet/ui";
import { capacity, type AttemptSummary } from "../fixture";
import { attemptHref, summary } from "../derive";
import styles from "../lanes.module.css";

export function CapacityCard({
  heldAttempts,
  pendingAttempts
}: {
  heldAttempts: AttemptSummary[];
  pendingAttempts: AttemptSummary[];
}) {
  const queuedAll = pendingAttempts.length;
  return (
    <Card>
      <CardHeader
        title="Capacity"
        actions={
          <RouteChip variant="gap">gap · no capacity route</RouteChip>
        }
      />
      <CardBody>
        <p className={styles.kvline}>
          {capacity.host} · port {capacity.port} · {heldAttempts.length} of{" "}
          {capacity.slots} slots held
        </p>
        <div className={styles.seats}>
          {Array.from({ length: capacity.slots }, (_, i) => {
            const holder = heldAttempts.find((a) => a.slot === i + 1);
            return (
              <div
                key={i}
                className={`${styles.seat}${holder ? ` ${styles.seatHeld}` : ""}`}
                title={holder ? `${holder.id} · ${summary(holder)[1]}` : "free"}
              >
                <b>slot {i + 1}</b>
                <span className={styles.who}>
                  {holder ? `…${holder.id.slice(-5)}` : "free"}
                </span>
              </div>
            );
          })}
        </div>
        {queuedAll > 0 ? (
          <div>
            <span className={styles.qLbl}>queued behind them</span>
            {pendingAttempts.map((a) => (
              <Link
                key={a.id}
                href={attemptHref(a)}
                title={a.id}
                className={styles.qitem}
              >
                <span className={styles.qchip}>
                  <b className={styles.mono}>{a.id}</b>
                  <span>{a.wo}</span>
                  <span className={styles.mono}>{a.queueBound} bound</span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className={styles.qNone}>no queued intents</p>
        )}
        <p className={styles.capnote}>
          Unknown holds its slot. A slot frees only when a completion receipt
          is written.
        </p>
      </CardBody>
    </Card>
  );
}