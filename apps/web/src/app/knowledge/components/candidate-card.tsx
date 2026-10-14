"use client";

import type { ReactNode } from "react";
import { Badge, Banner, Button, KeyValueList, KeyValueRow } from "@fleet/ui";
import type { Candidate } from "../fixture";
import styles from "../knowledge.module.css";

export type DispositionKind = "accept" | "reject" | "unresolved" | "policy";

export interface Disposition {
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

type DispositionTone = "ok" | "danger" | "neutral" | "decision";

const OPS: Record<
  DispositionKind,
  { label: string; tone: DispositionTone; icon: ReactNode }
> = {
  accept: {
    label: "Accept",
    tone: "ok",
    icon: (
      <Icon>
        <path d="M4 12l5 5L20 7" />
      </Icon>
    ),
  },
  reject: {
    label: "Reject",
    tone: "danger",
    icon: (
      <Icon>
        <path d="M6 6l12 12M18 6L6 18" />
      </Icon>
    ),
  },
  unresolved: {
    label: "Leave unresolved",
    tone: "neutral",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </Icon>
    ),
  },
  policy: {
    label: "Propose a policy change",
    tone: "decision",
    icon: (
      <Icon>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <circle cx="15.5" cy="12" r="1" />
      </Icon>
    ),
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

export function CandidateCard({
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
      </div>
      {disposition ? (
        <Banner
          tone={OPS[disposition.kind].tone}
          title={decidedText(disposition.kind, disposition.at)}
          className={styles.candNote}
        />
      ) : null}
      <p className={styles.claim}>{cand.claim}</p>
      <KeyValueList className={styles.prov}>
        <KeyValueRow term="project">{cand.project}</KeyValueRow>
        <KeyValueRow term="paths" mono>
          {cand.paths}
        </KeyValueRow>
        <KeyValueRow term="source" mono>
          {cand.source}
        </KeyValueRow>
        <KeyValueRow term="evidence">{cand.evidence}</KeyValueRow>
        <KeyValueRow term="checked">
          {cand.checked ? (
            cand.checked
          ) : (
            <span className={styles.none}>not checked yet</span>
          )}
        </KeyValueRow>
        <KeyValueRow term="supersedes" mono>
          {cand.supersedes}
        </KeyValueRow>
      </KeyValueList>
      {cand.acceptable ? (
        <Banner
          tone="ok"
          title="Accept is legal"
          meta={cand.acceptWhy}
          className={styles.candNote}
        />
      ) : (
        <Banner
          tone="neutral"
          title="Accept is not offered, and why"
          meta={cand.acceptWhy}
          className={styles.candNote}
        />
      )}
      <div className={styles.disp}>
        {(Object.keys(OPS) as DispositionKind[])
          .filter((kind) => kind !== "accept" || cand.acceptable)
          .map((kind) => (
            <Button
              key={kind}
              tone={OPS[kind].tone}
              size="sm"
              disabled={decided}
              onClick={() => onDisposition(cand.id, kind)}
            >
              {OPS[kind].icon} {OPS[kind].label}
            </Button>
          ))}
      </div>
    </article>
  );
}