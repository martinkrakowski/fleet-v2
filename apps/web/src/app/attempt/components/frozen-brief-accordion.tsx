import { Accordion, KeyValueList, KeyValueRow } from "@fleet/ui";
import type { Attempt } from "../fixture";
import styles from "../attempt.module.css";

export function FrozenBriefAccordion({ attempt }: { attempt: Attempt }) {
  const b = attempt.brief;
  if (!b) return null;
  return (
    <Accordion
      summary={<b>Frozen brief</b>}
      meta={`${b.digest} · frozen ${b.frozenAt}`}
    >
      <div className={styles.briefModels}>
        <span>
          model <b>{attempt.model.implementer}</b>
        </span>
        {b.original && (
          <span>
            original <b>{b.original}</b>
          </span>
        )}
      </div>
      <KeyValueList>
        {Object.entries(b.manifest).map(([k, v]) => (
          <KeyValueRow key={k} term={k}>
            {String(v)}
          </KeyValueRow>
        ))}
      </KeyValueList>
      <pre className={styles.briefMarkdown}>{b.markdown}</pre>
    </Accordion>
  );
}
