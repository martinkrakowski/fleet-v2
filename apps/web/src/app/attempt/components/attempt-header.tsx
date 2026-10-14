import { Badge, type BadgeVariant } from "@fleet/ui";
import type { Attempt } from "../fixture";
import styles from "../attempt.module.css";

function copyId(id: string): void {
  void navigator.clipboard.writeText(id);
}

export function AttemptHeader({
  attempt,
  word,
  note,
  wordVariant,
  siblingCount,
}: {
  attempt: Attempt;
  word: string;
  note: string;
  wordVariant: BadgeVariant;
  siblingCount: number;
}) {
  return (
    <header className={styles.head}>
      <h1>
        <button
          type="button"
          className={styles.idBtn}
          data-action="copy"
          data-copy={attempt.id}
          title={`copy ${attempt.id}`}
          onClick={() => copyId(attempt.id)}
        >
          {attempt.id}
        </button>
      </h1>
      <div className={styles.headBadges}>
        <Badge variant={attempt.kind === "fix" ? "fix" : "keeper"}>
          {attempt.kind === "fix" ? `fix ${attempt.number} of ${siblingCount}` : "first attempt"}
        </Badge>
        <Badge variant={wordVariant}>{word}</Badge>
        <span className={styles.headNote}>{note}</span>
      </div>
      <div className={styles.ids}>
        <span>
          work order <b>{attempt.wo}</b>
        </span>
        <span>
          session <b>{attempt.session ? attempt.session : "none yet"}</b>
        </span>
        <span>
          port <b>{attempt.port}</b>
        </span>
        <span>
          {attempt.slot ? (
            <>
              slot <b>{attempt.slot}</b>
            </>
          ) : attempt.capacity === "pending" ? (
            <>
              queue <b>waiting</b>
            </>
          ) : (
            <b>slot released</b>
          )}
        </span>
        {attempt.fixOf && (
          <span>
            fix of <b>{attempt.fixOf}</b>
          </span>
        )}
      </div>
    </header>
  );
}
