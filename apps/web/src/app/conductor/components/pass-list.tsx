"use client";

import { Accordion, EmptyState } from "@fleet/ui";
import type {
  ConductorPassView,
  ConductorRunReportView,
  ConductorTraceStepView,
  PassListView,
} from "../map-passes";
import styles from "../conductor.module.css";

function reportText(report: ConductorRunReportView): string {
  if (report.outcome === "advanced") {
    const last = report.steps[report.steps.length - 1];
    return last === undefined ? "advanced" : `advanced · ${last.outcome}`;
  }
  return `${report.outcome} · ${report.reason}`;
}

function stepText(step: ConductorTraceStepView): string {
  const parts = [step.outcome];
  if (step.step !== undefined) {
    parts.push(step.step);
  }
  if (step.reason !== undefined) {
    parts.push(step.reason);
  } else if (step.reasonCode !== undefined && step.reasonCode !== null) {
    parts.push(step.reasonCode);
  } else if (step.detail !== undefined && step.detail !== null) {
    parts.push(step.detail);
  } else if (step.result !== undefined) {
    parts.push(step.result);
  }
  return parts.join(" ");
}

function passChips(pass: ConductorPassView) {
  const chips: string[] = [];
  if (pass.halted) {
    chips.push("halted");
  }
  if (pass.progressed) {
    chips.push("progressed");
  }
  chips.push(`max ${pass.maxActiveRuns}`);
  chips.push(`concurrency ${pass.passConcurrency}`);
  chips.push(`stagger ${pass.dispatchStaggerMs}ms`);
  return chips;
}

function runReport(report: ConductorRunReportView) {
  if (report.outcome === "advanced") {
    return (
      <ol className={styles.passSteps}>
        {report.steps.map((step, index) => (
          <li key={`${index}-${step.outcome}`}>{stepText(step)}</li>
        ))}
      </ol>
    );
  }
  return null;
}

function attentionBadges(pass: ConductorPassView) {
  if (pass.attention.length === 0) {
    return null;
  }
  return (
    <p className={styles.passAttention}>
      {pass.attention.map((item) => (
        <span key={`${item.runId}-${item.kind}`} className={styles.badge}>
          {item.kind}
        </span>
      ))}
    </p>
  );
}

function passCard(pass: ConductorPassView) {
  return (
    <Accordion
      key={pass.passId}
      summary={`${pass.passId} · ${pass.nowIso}`}
      meta={passChips(pass).map((chip) => (
        <span key={chip} className={styles.badge}>
          {chip}
        </span>
      ))}
    >
      <ul className={styles.passRuns}>
        {pass.runs.map((run) => (
          <li key={run.runId}>
            <span className={styles.passRunId}>{run.runId}</span>{" "}
            {reportText(run.report)}
            {runReport(run.report)}
          </li>
        ))}
      </ul>
      {attentionBadges(pass)}
    </Accordion>
  );
}

export function PassList({ passes }: { passes: PassListView }) {
  if (passes.store === "unreadable") {
    return (
      <section className={styles.passList} aria-label="Passes">
        <p className={styles.muted}>
          The pass trace store is unreadable — no pass details are shown.
        </p>
      </section>
    );
  }
  if (passes.passes.length === 0) {
    return (
      <section className={styles.passList} aria-label="Passes">
        <EmptyState title="No passes recorded yet." />
      </section>
    );
  }
  return (
    <section className={styles.passList} aria-label="Passes">
      {passes.truncated ? (
        <p className={styles.muted}>
          Older passes were cut: only the newest 32 are shown.
        </p>
      ) : null}
      {passes.passes.map(passCard)}
    </section>
  );
}
