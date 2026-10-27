"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  Banner,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  type SemanticTone
} from "@fleet/ui";
import type { AttemptSummary } from "../fixture";
import type { QuestionSummary } from "../../questions/summary";
import { attemptsOf, summary, unknownAttention } from "../derive";
import styles from "../lanes.module.css";

interface AttentionItem {
  tone: SemanticTone;
  tt: ReactNode;
  ss: string;
  rr?: ReactNode;
}

function buildAttentionItems(attempts: AttemptSummary[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  attempts.forEach((a) => {
    const [word, note] = summary(a);
    if (word === "unknown") {
      const { title, detail } = unknownAttention(a, note);
      items.push({
        tone: "warn",
        tt: (
          <>
            <b>{a.id}</b> {title}
          </>
        ),
        ss: detail
      });
    }
    const decision = a.receipts.decision;
    if (word === "blocked" && decision) {
      items.push({
        tone: "decision",
        tt: (
          <>
            <b>{a.wo}</b> waits on decision {decision.id}
          </>
        ),
        ss: `${note} · a ${decision.door} door · silence is not approval`,
        rr: <Link href="/questions">open Questions</Link>
      });
    }
    if (
      word === "ended" &&
      a.receipts.completion &&
      a.facts.collected !== "yes"
    ) {
      items.push({
        tone: "accent",
        tt: (
          <>
            <b>{a.id}</b> ended · artifacts not collected
          </>
        ),
        ss: `completion ${a.receipts.completion.id} · collect is legal now`
      });
    }
    if (word === "failed") {
      const openFix = attemptsOf(a.wo, attempts).find(
        (x) =>
          x.id !== a.id && (x.capacity === "held" || x.capacity === "pending")
      );
      items.push({
        tone: "danger",
        tt: (
          <>
            <b>{a.id}</b> verification failed
          </>
        ),
        ss: `${note}${openFix ? ` · a fix is already open: ${openFix.id}` : ""}`
      });
    }
    if (word === "queued") {
      items.push({
        tone: "neutral",
        tt: (
          <>
            <b>{a.id}</b> queued for a slot
          </>
        ),
        ss: `${note}${a.queueBound ? ` · ${a.queueBound} bound` : ""} · no session yet, so withdraw is the only word`
      });
    }
    if (
      word === "accepted" &&
      a.receipts.acceptance &&
      a.legal.includes("merge")
    ) {
      items.push({
        tone: "ok",
        tt: (
          <>
            <b>{a.wo}</b> accepted at{" "}
            <span className={styles.mono}>{a.receipts.acceptance.head}</span>
          </>
        ),
        ss: `pull request ${a.pullRequest} · merge is legal`
      });
    }
  });
  return items;
}

function questionItem(summary: QuestionSummary): AttentionItem | null {
  if (summary.status === "error") {
    return {
      tone: "warn",
      tt: "Owner questions not read",
      ss: summary.reason,
    };
  }
  if (summary.status === "not-read" || summary.open === 0) {
    return null;
  }
  return {
    tone: "decision",
    tt: `${summary.open} open owner ${
      summary.open === 1 ? "question" : "questions"
    }`,
    ss: `${summary.oneWay} one-way (need the owner's signed decision) · ${summary.blocking} blocking · recorded, not answered here`,
    rr: <Link href="/questions?state=open">open Questions</Link>,
  };
}

export function AttentionCard({
  attempts,
  questions,
}: {
  attempts: AttemptSummary[];
  questions: QuestionSummary;
}) {
  const question = questionItem(questions);
  const items = buildAttentionItems(attempts);
  const allItems = question ? [question, ...items] : items;
  return (
    <Card className={styles.attnCard}>
      <CardHeader
        title="Needs attention"
        actions={<span className={styles.meta}>{allItems.length}</span>}
      />
      <CardBody>
        {allItems.length > 0 ? (
          allItems.map((item, i) => (
            <Banner
              key={i}
              tone={item.tone}
              title={item.tt}
              meta={item.ss}
              actions={item.rr}
              className={styles.attn}
            />
          ))
        ) : (
          <EmptyState
            title="Nothing needs the operator right now"
            description="The counts above are work, not health."
          />
        )}
      </CardBody>
    </Card>
  );
}
