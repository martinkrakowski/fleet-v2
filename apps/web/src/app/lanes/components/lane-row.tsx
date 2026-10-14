"use client";

import Link from "next/link";
import { Badge } from "@fleet/ui";
import type { AttemptSummary } from "../fixture";
import { attemptHref, isLive, laneIdLine, summary, woOf } from "../derive";
import { LiveClock } from "./live-clock";
import styles from "../lanes.module.css";

export interface LaneRowProps {
  attempt: AttemptSummary;
  selected: boolean;
  onSelect: () => void;
}

export function LaneRow({ attempt, selected, onSelect }: LaneRowProps) {
  const [word, note] = summary(attempt);
  const wo = woOf(attempt);
  const href = attemptHref(attempt);
  const live = isLive(attempt);
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
            {laneIdLine(attempt)}
          </span>
        </button>
        <Link className={styles.openLink} href={href}>
          Open
        </Link>
      </div>
      {selected ? (
        <div className={`${styles.laneMore} ${styles.mono}`}>
          observed {attempt.observedAt} · {attempt.observedFrom} · {note}
        </div>
      ) : null}
    </li>
  );
}