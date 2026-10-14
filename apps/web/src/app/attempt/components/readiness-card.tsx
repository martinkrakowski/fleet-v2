import { Card, CardBody, CardHeader } from "@fleet/ui";
import type { Attempt } from "../fixture";
import styles from "../attempt.module.css";

export function ReadinessCard({ attempt }: { attempt: Attempt }) {
  if (!attempt.readiness || attempt.readiness.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Readiness receipt" subtitle="ten lines" />
      <CardBody>
        <ul className={styles.readinessList}>
          {attempt.readiness.map(([name, pass, rnote], i) => (
            <li key={i} className={styles.readinessItem}>
              <i className={pass ? styles.readinessMark : `${styles.readinessMark} ${styles.readinessMarkFail}`}>
                {pass ? "pass" : "FAIL"}
              </i>
              <span>
                <b>{name}</b> — {rnote}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
