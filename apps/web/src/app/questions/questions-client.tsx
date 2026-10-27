"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  EmptyState,
  PageHeader,
  RouteChip,
  Select,
  Switch,
} from "@fleet/ui";
import type { QuestionsData } from "./live";
import type { QuestionView } from "./map-question";
import {
  STATE_FILTERS,
  filterQuestions,
  newestFirst,
  parseStateFilter,
  stateCounts,
  summaryText,
  type StateFilter,
} from "./question-view";
import { useAutoRefresh } from "../lanes/use-auto-refresh";
import { QuestionCard } from "./components/question-card";
import styles from "./questions.module.css";

export function QuestionsClient({ data }: { data: QuestionsData }) {
  useAutoRefresh(data.source, data.fallbackReason);
  const stateParam = useSearchParams().get("state");
  const [stateFilter, setStateFilter] = useState<StateFilter>(
    parseStateFilter(stateParam),
  );
  const [blockingOnly, setBlockingOnly] = useState(false);
  const [oneWayOnly, setOneWayOnly] = useState(false);

  const questions: readonly QuestionView[] =
    data.view === "listed" ? data.questions : [];
  const ordered = newestFirst(questions);
  const visible = filterQuestions(ordered, {
    state: stateFilter,
    blockingOnly,
    oneWayOnly,
  });
  const counts = stateCounts(questions);

  let body: ReactNode;
  if (data.view === "listed") {
    if (questions.length === 0) {
      body = (
        <EmptyState title="No owner questions recorded on this station." />
      );
    } else if (visible.length === 0) {
      body = (
        <EmptyState
          title={`Nothing matches this filter: ${questions.length} questions are recorded; the filter hides them.`}
        />
      );
    } else {
      body = (
        <ol className={styles.list} aria-label="Owner questions, newest first">
          {visible.map((q) => (
            <li key={q.questionId}>
              <QuestionCard question={q} observedAtIso={data.observedAtIso} />
            </li>
          ))}
        </ol>
      );
    }
  } else if (data.view === "error") {
    body = <p className={styles.muted}>{data.reason}</p>;
  } else {
    body = (
      <p className={styles.muted}>
        The API is not configured, so no questions were read. There is no
        sample question list.
      </p>
    );
  }

  let actions: ReactNode;
  if (data.view === "listed") {
    actions = (
      <RouteChip>
        live · GET /v1/questions · {questions.length} recorded
      </RouteChip>
    );
  } else if (data.view === "error") {
    actions = <RouteChip variant="gap">error · not read</RouteChip>;
  } else {
    actions = <RouteChip variant="gap">not configured · not read</RouteChip>;
  }

  const metaText =
    data.view === "listed"
      ? `${summaryText(questions)} · recorded, read ${data.observedAtIso}`
      : "";

  return (
    <div className={styles.page}>
      <PageHeader
        title="Questions"
        description="Questions the orchestrator asked the owner. Read-only: nothing here answers, approves or grants anything. A one-way question is answered only by the owner's signed decision for its linked request."
        actions={actions}
      />
      <p className={styles.meta} aria-live="polite">
        {metaText}
      </p>
      {data.view === "listed" ? (
        <div className={styles.tools}>
          <Select
            label="State"
            inline
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
            aria-label="state filter"
          >
            {STATE_FILTERS.map((f) => (
              <option key={f} value={f}>
                {f} ({counts[f]})
              </option>
            ))}
          </Select>
          <Switch
            checked={blockingOnly}
            onChange={setBlockingOnly}
            label="Blocking only"
          />
          <Switch
            checked={oneWayOnly}
            onChange={setOneWayOnly}
            label="One-way only"
          />
        </div>
      ) : null}
      {body}
    </div>
  );
}
