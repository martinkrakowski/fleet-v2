import { Badge, Card, CardBody, CardHeader, KeyValueList, KeyValueRow } from "@fleet/ui";
import { summarize, type Attempt, type WorkOrder } from "../fixture";
import styles from "../attempt.module.css";

const SIBLING_TONE: Record<string, string> = {
  ended: styles.sibEnded,
  failed: styles.sibFailed,
  unknown: styles.sibUnknown,
  active: styles.sibActive,
  accepted: styles.sibAccepted,
  blocked: styles.sibBlocked,
  queued: styles.sibQueued,
};

export function WorkOrderSidebar({
  attempt,
  workOrder,
  siblings,
}: {
  attempt: Attempt;
  workOrder: WorkOrder;
  siblings: Attempt[];
}) {
  return (
    <Card>
      <CardHeader title="Work order" subtitle={attempt.wo} />
      <CardBody>
        <KeyValueList>
          <KeyValueRow term="project">{workOrder.project}</KeyValueRow>
          <KeyValueRow term="task">{workOrder.task}</KeyValueRow>
          <KeyValueRow term="lane" mono>
            {workOrder.lane}
          </KeyValueRow>
          <KeyValueRow term="base commit" mono>
            {workOrder.base}
          </KeyValueRow>
          <KeyValueRow term="policy revision" mono>
            {workOrder.policy}
          </KeyValueRow>
        </KeyValueList>
        <h3 className={styles.siblingHead}>Attempts on this order</h3>
        <ul className={styles.siblingList}>
          {siblings.map((s) => {
            const [sw, snote] = summarize(s);
            const tone = SIBLING_TONE[sw] ?? styles.sibEnded;
            return (
              <li
                key={s.id}
                data-action="open"
                data-att={s.id}
                className={[
                  styles.sibling,
                  s.id === attempt.id ? styles.siblingCurrent : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className={styles.siblingTop}>
                  <b>{s.id}</b>
                  <Badge variant={s.kind === "fix" ? "fix" : "keeper"}>
                    {s.kind === "fix" ? `fix ${s.number}` : "first"}
                  </Badge>
                </span>
                <span className={styles.siblingState}>
                  <span className={`${styles.siblingDot} ${tone}`}>● {sw}</span>
                  <span className={styles.siblingNote}>{snote}</span>
                </span>
                {s.fixOf && <span className={styles.siblingMeta}>fix of {s.fixOf}</span>}
                {s.cost ? (
                  <span className={styles.siblingCost}>
                    {s.cost.steps} steps · {s.cost.minutes} min · ${s.cost.usd}
                  </span>
                ) : (
                  <span className={styles.siblingMeta}>not started · no cost yet</span>
                )}
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
