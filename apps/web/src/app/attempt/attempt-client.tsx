"use client";

import { useSearchParams } from "next/navigation";
import type { BadgeVariant } from "@fleet/ui";
import { FIXTURE, findAttempt, workOrderOf, attemptsOf, summarize } from "./fixture";
import { AttemptHeader } from "./components/attempt-header";
import { RunnerFactsGrid } from "./components/runner-facts-grid";
import { AttemptLifecycleStepper } from "./components/attempt-lifecycle-stepper";
import { ModelCostCard } from "./components/model-cost-card";
import { WorktreeCard } from "./components/worktree-card";
import { ReadinessCard } from "./components/readiness-card";
import { ReceiptsCard } from "./components/receipts-card";
import { FrozenBriefAccordion } from "./components/frozen-brief-accordion";
import { WorkOrderSidebar } from "./components/work-order-sidebar";
import { OperationsSidebar } from "./components/operations-sidebar";
import styles from "./attempt.module.css";

export default function AttemptPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const attempt = findAttempt(id) ?? FIXTURE.attempts[0];
  const workOrder = workOrderOf(attempt);
  const siblings = attemptsOf(attempt.wo);
  const [word, note, variant] = summarize(attempt);

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebarCol} aria-label="Work order">
        <WorkOrderSidebar attempt={attempt} workOrder={workOrder} siblings={siblings} />
      </aside>

      <section className={styles.recordCol} aria-label="Attempt record">
        <AttemptHeader
          attempt={attempt}
          word={word}
          note={note}
          wordVariant={variant as BadgeVariant}
          siblingCount={siblings.length}
        />
        <RunnerFactsGrid attempt={attempt} />
        <AttemptLifecycleStepper attempt={attempt} />
        <ModelCostCard attempt={attempt} />
        <WorktreeCard attempt={attempt} />
        <ReadinessCard attempt={attempt} />
        <ReceiptsCard attempt={attempt} />
        <FrozenBriefAccordion attempt={attempt} />
      </section>

      <aside className={styles.opsCol} aria-label="Operations">
        <OperationsSidebar attempt={attempt} word={word} />
      </aside>
    </div>
  );
}
