import { Accordion, Banner, Card, CardBody, CardHeader, KeyValueList, KeyValueRow } from "@fleet/ui";
import type { Attempt } from "../fixture";
import styles from "../attempt.module.css";

function PathList({ paths }: { paths: string[] }) {
  return (
    <Accordion summary={`${paths.length} path${paths.length === 1 ? "" : "s"}`}>
      <ul className={styles.pathsList}>
        {paths.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </Accordion>
  );
}

function PathCell({ paths }: { paths: string[] | undefined }) {
  if (paths && paths.length) return <PathList paths={paths} />;
  return <span className={styles.muted}>none</span>;
}

export function WorktreeCard({ attempt }: { attempt: Attempt }) {
  const w = attempt.worktree;
  if (!w) return null;
  return (
    <Card>
      <CardHeader
        title="Worktree inspection"
        subtitle={`inspected ${w.inspectedAt}${w.stale ? " · stale" : ""}`}
      />
      <CardBody>
        <KeyValueList>
          <KeyValueRow term="checked out" mono>
            {w.commit} · {w.commitsSinceDispatch} commit{w.commitsSinceDispatch === 1 ? "" : "s"} since
            dispatch · base {w.base}
          </KeyValueRow>
          <KeyValueRow term="uncommitted">
            <PathCell paths={w.uncommitted} />
          </KeyValueRow>
          <KeyValueRow term="untracked">
            <PathCell paths={w.untracked} />
          </KeyValueRow>
          <KeyValueRow term="residue">
            {w.residue && w.residue.length ? (
              <span className={styles.residue}>{w.residue.join(", ")}</span>
            ) : (
              <span className={styles.muted}>none</span>
            )}
          </KeyValueRow>
          <KeyValueRow term="expected artifacts">
            {(w.artifacts || []).map(([n, ok]) => (
              <span key={n} className={ok ? styles.artifactOk : styles.artifact}>
                {ok ? "✓ " : "– "}
                {n}
              </span>
            ))}
          </KeyValueRow>
        </KeyValueList>
        {w.stale && (
          <Banner tone="warn" className={styles.bannerSpacing}>
            This inspection is stale — read at {w.inspectedAt}. The page keeps it as it was.
          </Banner>
        )}
      </CardBody>
    </Card>
  );
}
