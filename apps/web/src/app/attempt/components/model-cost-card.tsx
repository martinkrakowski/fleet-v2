import { Card, CardBody, CardHeader, KeyValueList, KeyValueRow } from "@fleet/ui";
import type { Attempt } from "../fixture";
import styles from "../attempt.module.css";

export function ModelCostCard({ attempt }: { attempt: Attempt }) {
  return (
    <Card>
      <CardHeader title="Model &amp; cost" subtitle={`reach: ${attempt.cost?.note ? attempt.cost.note : "to the last observation"}`} />
      <CardBody>
        <KeyValueList>
          <KeyValueRow term="implementer" mono>
            {attempt.model.implementer}
          </KeyValueRow>
          <KeyValueRow term="fallback" mono>
            {attempt.model.fallback}
          </KeyValueRow>
          <KeyValueRow term="reviewer seat" mono>
            {attempt.model.reviewer}
          </KeyValueRow>
          <KeyValueRow term="cost">
            {attempt.cost ? (
              <span>
                {attempt.cost.steps} steps · {attempt.cost.minutes} lane min · ${attempt.cost.usd}
              </span>
            ) : (
              <span className={styles.muted}>nothing measured yet; the attempt has not started</span>
            )}
          </KeyValueRow>
        </KeyValueList>
      </CardBody>
    </Card>
  );
}
