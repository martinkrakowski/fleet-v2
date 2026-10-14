import { Banner, Fact } from "@fleet/ui";
import { FACTS_ORDER, type Attempt } from "../fixture";
import styles from "../attempt.module.css";

export function RunnerFactsGrid({ attempt }: { attempt: Attempt }) {
  const stale = attempt.worktree?.stale ?? false;
  return (
    <section className={styles.factsSection} aria-label="Five runner facts">
      <h2 className={styles.sectionHead}>
        Five runner facts
        <span className={styles.sectionMeta}>observed {attempt.observedAt}</span>
      </h2>
      <div className={styles.factsGrid}>
        {FACTS_ORDER.map((k) => {
          const v = attempt.facts[k];
          const lk = v === "unknown" && attempt.lastKnown ? attempt.lastKnown.facts[k] : null;
          const tip = `${k}: ${v} · observed ${attempt.observedAt} · ${attempt.observedFrom}`;
          return (
            <div key={k} className={styles.factCell} title={tip}>
              <span className={styles.factLabel}>{k}</span>
              <Fact value={v} stale={stale} />
              <span className={styles.factMeta}>
                {lk ? `last ${lk} · ${attempt.lastKnown?.at}` : attempt.observedAt}
              </span>
            </div>
          );
        })}
      </div>
      {stale && (
        <Banner tone="warn" className={styles.bannerSpacing}>
          This inspection is stale — read at {attempt.worktree?.inspectedAt}. The page keeps it as it
          was.
        </Banner>
      )}
    </section>
  );
}
