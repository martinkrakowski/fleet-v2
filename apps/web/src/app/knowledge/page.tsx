"use client";

import { useState, type ReactNode } from "react";
import { Badge, Card } from "@fleet/ui";
import {
  PROJECT,
  candidates,
  keepers,
  type Candidate,
} from "./fixture";
import styles from "./knowledge.module.css";

type DispositionKind = "accept" | "reject" | "unresolved" | "policy";

interface Disposition {
  kind: DispositionKind;
  at: string;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className={styles.ic} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

const OPS: Record<DispositionKind, { label: string; icon: ReactNode; cls: string }> = {
  accept: {
    label: "Accept",
    icon: (
      <Icon>
        <path d="M4 12l5 5L20 7" />
      </Icon>
    ),
    cls: styles.btnMerge,
  },
  reject: {
    label: "Reject",
    icon: (
      <Icon>
        <path d="M6 6l12 12M18 6L6 18" />
      </Icon>
    ),
    cls: styles.btnDanger,
  },
  unresolved: {
    label: "Leave unresolved",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </Icon>
    ),
    cls: "",
  },
  policy: {
    label: "Propose a policy change",
    icon: (
      <Icon>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <circle cx="15.5" cy="12" r="1" />
      </Icon>
    ),
    cls: styles.btnViolet,
  },
};

function decidedText(kind: DispositionKind, at: string): string {
  switch (kind) {
    case "accept":
      return `accepted · recorded in this browser only · no keeper was published · ${at}`;
    case "reject":
      return `rejected · recorded in this browser only · ${at}`;
    case "unresolved":
      return `left unresolved · it stays a candidate · recorded in this browser only · ${at}`;
    case "policy":
      return `policy proposal recorded in this browser only · it left the product, it is not a keeper · ${at}`;
  }
}

function CandidateCard({
  cand,
  disposition,
  onDisposition,
}: {
  cand: Candidate;
  disposition?: Disposition;
  onDisposition: (id: string, kind: DispositionKind) => void;
}) {
  const decided = disposition !== undefined;
  return (
    <article className={styles.cand}>
      <div className={styles.ch}>
        <b className={styles.mono}>{cand.id}</b>
        <Badge tone="candidate">candidate</Badge>
        {disposition ? (
          <span
            className={`${styles.decided} ${
              disposition.kind === "accept"
                ? styles.decidedAccept
                : disposition.kind === "reject"
                  ? styles.decidedReject
                  : disposition.kind === "unresolved"
                    ? styles.decidedUnresolved
                    : styles.decidedPolicy
            }`}
          >
            {decidedText(disposition.kind, disposition.at)}
          </span>
        ) : null}
      </div>
      <p className={styles.claim}>{cand.claim}</p>
      <dl className={styles.prov}>
        <dt>project</dt>
        <dd>{cand.project}</dd>
        <dt>paths</dt>
        <dd className={styles.mono}>{cand.paths}</dd>
        <dt>source</dt>
        <dd className={styles.mono}>{cand.source}</dd>
        <dt>evidence</dt>
        <dd>{cand.evidence}</dd>
        <dt>checked</dt>
        <dd>
          {cand.checked ? (
            cand.checked
          ) : (
            <span className={styles.none}>not checked yet</span>
          )}
        </dd>
        <dt>supersedes</dt>
        <dd>{cand.supersedes}</dd>
      </dl>
      {cand.acceptable ? (
        <div className={styles.acceptline}>accept is legal · {cand.acceptWhy}</div>
      ) : (
        <div className={styles.notoff}>
          <b>Accept</b>
          <span>{cand.acceptWhy}</span>
        </div>
      )}
      <div className={styles.disp}>
        {(Object.keys(OPS) as DispositionKind[])
          .filter((kind) => kind !== "accept" || cand.acceptable)
          .map((kind) => (
            <button
              key={kind}
              type="button"
              className={`${styles.btn} ${OPS[kind].cls}`}
              disabled={decided}
              onClick={() => onDisposition(cand.id, kind)}
            >
              {OPS[kind].icon} {OPS[kind].label}
            </button>
          ))}
      </div>
    </article>
  );
}

export default function KnowledgePage() {
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({});

  const cands = candidates.filter((c) => c.project === PROJECT);
  const keeps = keepers.filter((k) =>
    k.project.split(",").map((s) => s.trim()).includes(PROJECT),
  );
  const open = cands.filter((c) => dispositions[c.id] === undefined).length;

  const onDisposition = (id: string, kind: DispositionKind) => {
    const at = new Date().toISOString().slice(11, 19) + "Z";
    setDispositions((prev) => ({ ...prev, [id]: { kind, at } }));
  };

  return (
    <main className={styles.page}>
      <div className={styles.vhTop}>
        <h1>Knowledge</h1>
        <span
          className={`${styles.route} ${styles.routeGap}`}
          title="a route the plan does not name yet"
        >
          gap · list routes are not on this station
        </span>
      </div>
      <p className={styles.lede}>
        Two lists. A keeper is published only from a head that carries an
        acceptance receipt; anything else stays a candidate, is rejected, or
        leaves the product as a policy proposal. Nothing on this page writes a
        policy.
      </p>
      <div className={styles.stack}>
        <Card>
          <div className={styles.pad}>
            <h2>
              Candidates{" "}
              <span className={styles.meta}>
                {open} open · {cands.length} in scope
              </span>
            </h2>
            <div className={styles.cands}>
              {cands.length ? (
                cands.map((c) => (
                  <CandidateCard
                    key={c.id}
                    cand={c}
                    disposition={dispositions[c.id]}
                    onDisposition={onDisposition}
                  />
                ))
              ) : (
                <div className={styles.empty}>
                  No candidates in this project scope. That is a scope note,
                  not “nothing running”.
                </div>
              )}
            </div>
          </div>
        </Card>
        <Card>
          <div className={styles.pad}>
            <h2>
              Keepers <span className={styles.meta}>{keeps.length} in scope</span>
            </h2>
            <div className={styles.tablewrap}>
              <table className={styles.grid}>
                <thead>
                  <tr>
                    <th>entry</th>
                    <th>claim</th>
                    <th>scope</th>
                    <th>source</th>
                    <th>checked</th>
                    <th>supersedes</th>
                    <th>reuse</th>
                    <th>wrong turns</th>
                  </tr>
                </thead>
                <tbody>
                  {keeps.map((k) => (
                    <tr key={k.id}>
                      <td className={styles.mono}>
                        {k.id} {k.v}
                      </td>
                      <td className={styles.tdClaim}>{k.claim}</td>
                      <td>
                        {k.project} · {k.paths}
                      </td>
                      <td className={`${styles.mono} ${styles.tdSrc}`}>{k.source}</td>
                      <td>{k.checked}</td>
                      <td className={styles.mono}>{k.supersedes}</td>
                      <td className={styles.mono}>{k.used}×</td>
                      <td>
                        {k.wrongTurns ? (
                          <Badge tone="failed" title="wrong turns reported against this keeper">
                            {k.wrongTurns}
                          </Badge>
                        ) : (
                          <span className={styles.none}>0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
