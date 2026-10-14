import { Banner, Stepper, type StepItem } from "@fleet/ui";
import { FACTS_ORDER, type Attempt } from "../fixture";
import styles from "../attempt.module.css";

type LegacyStepState = "done" | "now" | "faint" | "unknown" | "fail" | "door";

/** Maps an attempt lifecycle step onto a `StepItem` state + semantic tone. */
function toStepItem(w: string, t: string, st: LegacyStepState): StepItem {
  switch (st) {
    case "done":
      return { id: w, label: w, detail: t || "·", state: "done" };
    case "now":
      return { id: w, label: w, detail: t || "·", state: "active", tone: "accent" };
    case "unknown":
      return { id: w, label: w, detail: t || "·", state: "active", tone: "warn" };
    case "fail":
      return { id: w, label: w, detail: t || "·", state: "active", tone: "danger" };
    case "door":
      return { id: w, label: w, detail: t || "·", state: "active", tone: "decision" };
    default:
      return { id: w, label: w, detail: t || "·", state: "pending" };
  }
}

export function AttemptLifecycleStepper({ attempt }: { attempt: Attempt }) {
  const R = attempt.receipts;
  const f = attempt.facts;
  const nodes: Array<{ w: string; t: string; st: LegacyStepState }> = [
    { w: "intent", t: attempt.queuedAt || "—", st: "done" },
    {
      w: "dispatch",
      t: attempt.startedAt || "",
      st: attempt.startedAt ? "done" : attempt.capacity === "pending" ? "now" : "faint",
    },
    {
      w: "ended",
      t: R.completion ? R.completion.at : "",
      st: R.completion
        ? "done"
        : f.ended === "unknown"
          ? "unknown"
          : f.active === "yes"
            ? "now"
            : "faint",
    },
    {
      w: "collected",
      t: f.collected === "yes" ? "yes" : "",
      st: f.collected === "yes" ? "done" : R.completion && !attempt.withdrawn ? "now" : "faint",
    },
    {
      w: "verified",
      t: R.verification ? R.verification.at : "",
      st: R.verification
        ? R.verification.pass
          ? "done"
          : "fail"
        : f.collected === "yes"
          ? "now"
          : "faint",
    },
    {
      w: "reviewed",
      t: R.review ? R.review.at : "",
      st: R.review ? (R.review.pass ? "done" : "fail") : R.verification && R.verification.pass ? "now" : "faint",
    },
    {
      w: "accepted",
      t: R.acceptance ? R.acceptance.at : "",
      st: R.acceptance
        ? "done"
        : R.review && R.review.pass && R.verification && R.verification.pass
          ? R.decision && R.decision.pending
            ? "door"
            : "now"
          : "faint",
    },
  ];
  if (attempt.merged) nodes.push({ w: "merged", t: R.merge ? R.merge.at : "", st: "done" });

  return (
    <section aria-label="attempt lifecycle">
      <Stepper steps={nodes.map((n) => toStepItem(n.w, n.t, n.st))} />
      {attempt.lastKnown && (
        <Banner tone="warn" className={styles.bannerSpacing}>
          The runner did not answer at {attempt.observedAt}. Unknown is its own state — not &quot;no&quot;,
          not a pass. Nothing on this page was upgraded.
          <br />
          Last known at <b>{attempt.lastKnown.at}</b>:{" "}
          {FACTS_ORDER.map((k) => `${k} ${attempt.lastKnown?.facts[k]}`).join(" · ")}.
        </Banner>
      )}
    </section>
  );
}
