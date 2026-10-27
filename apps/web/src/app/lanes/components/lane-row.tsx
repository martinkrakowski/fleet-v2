"use client";

import Link from "next/link";
import { Badge, Chip } from "@fleet/ui";
import type { AttemptSummary, WorkOrderSummary } from "../fixture";
import {
  attemptsOf,
  isLive,
  laneIdLine,
  liveViewHref,
  observedLine,
  summary,
  woOf,
} from "../derive";
import {
  modelChipText,
  seatChipText,
  sumUsage,
  usageChip,
  usageSumText,
  type UsageInput,
} from "../../../lib/usage-view";
import { workOrderHref } from "../../work-order/timeline-view";
import { LiveClock } from "./live-clock";
import styles from "../lanes.module.css";

export interface LaneRowProps {
  attempt: AttemptSummary;
  workOrders: Record<string, WorkOrderSummary>;
  attempts: AttemptSummary[];
  selected: boolean;
  onSelect: () => void;
}

function toInput(a: AttemptSummary): UsageInput {
  return { runner: a.recordedRunner ?? null, usage: a.recordedUsage ?? null };
}

export function LaneRow({
  attempt,
  workOrders,
  attempts,
  selected,
  onSelect
}: LaneRowProps) {
  const [word, note] = summary(attempt);
  const wo = woOf(attempt, workOrders);
  const href = liveViewHref(attempt);
  const live = isLive(attempt);
  const recorded = attempt.basis === "recorded";
  const input = toInput(attempt);
  const chip = usageChip(input);
  return (
    <li className={`${styles.lane}${selected ? ` ${styles.laneSel}` : ""}`}>
      <div className={styles.laneRow}>
        <button
          type="button"
          className={styles.laneMain}
          onClick={onSelect}
          aria-expanded={selected}
        >
          <span className={styles.laneTop}>
            <span className={styles.taskWrap}>
              <span className={styles.task} title={wo.task}>
                {wo.task}
              </span>{" "}
              <Badge tone={attempt.kind === "fix" ? "fix" : "first"}>
                {attempt.kind === "fix" ? `fix ${attempt.number}` : "first"}
              </Badge>
            </span>
            <span className={styles.laneState}>
              {live ? <i className={styles.pulseDot} aria-hidden="true" /> : null}
              <Badge tone={word}>{word}</Badge>
              {live ? (
                <LiveClock startMinutes={attempt.cost?.minutes ?? 0} />
              ) : attempt.cost ? (
                <span className={`${styles.mono} ${styles.staticMin}`}>
                  {attempt.cost.minutes} min
                </span>
              ) : null}
            </span>
          </span>
          <span className={`${styles.sub} ${styles.mono} ${styles.idline}`}>
            {laneIdLine(attempt, attempts)}
          </span>
          {recorded ? (
            <span className={styles.chips}>
              <Chip
                mono
                title="recorded runner seat, not a runner observation"
              >
                {seatChipText(input.runner)}
              </Chip>
              <Chip mono title="recorded model">
                {modelChipText(input)}
              </Chip>
              <Chip
                tone={chip.estimate ? "warn" : "neutral"}
                title={chip.title}
              >
                {chip.text}
              </Chip>
            </span>
          ) : null}
        </button>
        {href !== null ? (
          <Link className={styles.openLink} href={href}>
            Open
          </Link>
        ) : (
          <span
            className={styles.openLink}
            aria-disabled="true"
            title="no attempt id recorded"
          >
            no live view
          </span>
        )}
      </div>
      {selected ? (
        <div className={`${styles.laneMore} ${styles.mono}`}>
          {observedLine(attempt, note)}
          {recorded ? (
            <span className={styles.woSum}>
              work order {attempt.wo}:{" "}
              {usageSumText(
                sumUsage(attemptsOf(attempt.wo, attempts).map(toInput)),
              )}
              {" · counted over the listed attempts "}
              <Link href={workOrderHref(attempt.wo)}>timeline</Link>
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
