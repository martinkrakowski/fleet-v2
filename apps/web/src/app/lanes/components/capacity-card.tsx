import Link from "next/link";
import { Card, CardBody, CardHeader, RouteChip } from "@fleet/ui";
import type { AttemptSummary } from "../fixture";
import { liveViewHref, summary } from "../derive";
import styles from "../lanes.module.css";

export function CapacityCard({
  heldAttempts,
  pendingAttempts,
  capacity
}: {
  heldAttempts: AttemptSummary[];
  pendingAttempts: AttemptSummary[];
  capacity: { host: string; port: number; slots: number } | null;
}) {
  const queuedAll = pendingAttempts.length;
  const slotWord = heldAttempts.length === 1 ? "" : "s";
  return (
    <Card>
      <CardHeader
        title="Capacity"
        actions={
          <RouteChip variant="gap">gap · no capacity route</RouteChip>
        }
      />
      <CardBody>
        {capacity ? (
          <>
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
          </>
        ) : (
          <>
            <p className={styles.kvline}>
              {heldAttempts.length} slot{slotWord} held · slot budget not served
              by the API
            </p>
            {heldAttempts.map((a) => (
              <p key={a.id} className={styles.kvline}>
                {a.id} · slot {a.slot ?? "unrecorded"}
              </p>
            ))}
          </>
        )}
        {queuedAll > 0 ? (
          <div>
            <span className={styles.qLbl}>queued behind them</span>
            {pendingAttempts.map((a) => {
              const href = liveViewHref(a);
              const chip = (
                <span className={styles.qchip}>
                  <b className={styles.mono}>{a.id}</b>
                  <span>{a.wo}</span>
                  {a.queueBound !== null ? (
                    <span className={styles.mono}>{a.queueBound} bound</span>
                  ) : null}
                </span>
              );
              return href !== null ? (
                <Link
                  key={a.id}
                  href={href}
                  title={a.id}
                  className={styles.qitem}
                >
                  {chip}
                </Link>
              ) : (
                <span
                  key={a.id}
                  className={styles.qitem}
                  title="no attempt id recorded"
                >
                  {chip}
                </span>
              );
            })}
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
