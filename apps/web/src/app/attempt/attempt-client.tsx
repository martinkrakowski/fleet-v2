"use client";

import React from "react";
import { useSearchParams } from "next/navigation";
import { Badge, Fact, Card } from "@fleet/ui";
import type { BadgeVariant } from "@fleet/ui";
import {
  FIXTURE,
  findAttempt,
  workOrderOf,
  attemptsOf,
  summarize,
  FACTS_ORDER,
  FACT_LABELS,
  type Attempt,
  type Receipt,
  type WorkOrder,
} from "./fixture";

const OP_LABELS: Record<string, string> = {
  reconcile: "Reconcile",
  stop: "Stop",
  collect: "Collect artifacts",
  fix: "Start fix",
  merge: "Merge",
};

const OP_DESC: Record<string, string> = {
  reconcile: "Re-read the runner.",
  stop: "Stop the command — or withdraw the queued intent before a session exists.",
  collect: "Legal only after a completion receipt.",
  fix: "A fresh attempt on the same work order, numbered, frozen from this package.",
  merge: "The pull request is looked up before any forge call.",
};

function esc(s: string | undefined): string {
  return String(s ?? "");
}

function copyId(id: string): void {
  void navigator.clipboard.writeText(id);
}

export default function AttemptPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const attempt = findAttempt(id) ?? FIXTURE.attempts[0];
  const workOrder = workOrderOf(attempt);
  const siblings = attemptsOf(attempt.wo);
  const [word, note, variant] = summarize(attempt);
  const wordVariant = variant as BadgeVariant;

  return (
    <main
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(60rem 40rem at 12% -12%, rgba(34,211,238,.06), transparent 70%), radial-gradient(52rem 36rem at 88% -10%, rgba(192,132,252,.045), transparent 72%), #05070d",
        color: "#e9eef7",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        fontSize: "13px",
        lineHeight: "1.45",
        padding: "1rem",
      }}
    >
      <WorkOrderPane attempt={attempt} workOrder={workOrder} siblings={siblings} />
      <RecordPane
        attempt={attempt}
        word={word}
        note={note}
        wordVariant={wordVariant}
      />
      <OperationsPane attempt={attempt} word={word} />
    </main>
  );
}

function WorkOrderPane({
  attempt,
  workOrder,
  siblings,
}: {
  attempt: Attempt;
  workOrder: WorkOrder;
  siblings: Attempt[];
}) {
  return (
    <aside
      style={{ flex: "0 0 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: ".8rem" }}
      aria-label="Work order"
    >
      <Card title="Work order" padded>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "max-content minmax(0,1fr)",
            gap: ".2rem .8rem",
            margin: 0,
          }}
        >
          <dt style={{ color: "#93a0bb" }}>project</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{esc(workOrder.project)}</dd>
          <dt style={{ color: "#93a0bb" }}>task</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{esc(workOrder.task)}</dd>
          <dt style={{ color: "#93a0bb" }}>lane</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere", fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".76rem" }}>
            {esc(workOrder.lane)}
          </dd>
          <dt style={{ color: "#93a0bb" }}>base commit</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere", fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".76rem" }}>
            {esc(workOrder.base)}
          </dd>
          <dt style={{ color: "#93a0bb" }}>policy revision</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere", fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".76rem" }}>
            {esc(workOrder.policy)}
          </dd>
        </dl>
        <div style={{ marginTop: ".9rem" }}>
          <h3
            style={{
              margin: ".9rem 0 .35rem",
              fontSize: ".6rem",
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "#78849f",
              fontWeight: 600,
            }}
          >
            Attempts on this order
          </h3>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {siblings.map((s) => {
              const [sw, snote] = summarize(s);
              const dotColor =
                sw === "ended" ? "#34d399"
                : sw === "failed" ? "#fb7185"
                : sw === "unknown" ? "#fbbf24"
                : sw === "active" ? "#22d3ee"
                : sw === "accepted" ? "#34d399"
                : sw === "blocked" ? "#c084fc"
                : sw === "queued" ? "#93a0bb"
                : "#93a0bb";
              return (
                <li
                  key={s.id}
                  data-action="open"
                  data-att={s.id}
                  style={{
                    border: "1px solid rgba(148,163,184,.08)",
                    borderRadius: "3px",
                    padding: ".75rem",
                    margin: "0 0 .4rem",
                    cursor: "pointer",
                    background: "rgba(148,163,184,.03)",
                    display: "flex",
                    flexDirection: "column",
                    gap: ".12rem",
                    ...(s.id === attempt.id && {
                      borderColor: "#22d3ee",
                      boxShadow: "0 0 0 3px color-mix(in srgb, #22d3ee 14%, transparent)",
                    }),
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--mono, ui-monospace, monospace)",
                      fontSize: ".76rem",
                      display: "flex",
                      gap: ".4rem",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <b>{esc(s.id)}</b>
                    <Badge variant={s.kind === "fix" ? "fix" : "keeper"}>
                      {s.kind === "fix" ? `fix ${s.number}` : "first"}
                    </Badge>
                  </span>
                  <span style={{ color: "#93a0bb", fontSize: ".72rem" }}>
                    <span
                      style={{
                        fontFamily: "var(--mono, ui-monospace, monospace)",
                        color: dotColor,
                      }}
                    >
                      ● {sw}
                    </span>
                    <span style={{ color: "#93a0bb", marginLeft: ".4rem" }}>{esc(snote)}</span>
                  </span>
                  {s.fixOf && (
                    <span style={{ color: "#93a0bb", fontSize: ".68rem" }}>fix of {esc(s.fixOf)}</span>
                  )}
                  {s.cost ? (
                    <span style={{ color: "#93a0bb", fontSize: ".68rem", fontFamily: "var(--mono, ui-monospace, monospace)" }}>
                      {s.cost.steps} steps · {s.cost.minutes} min · ${s.cost.usd}
                    </span>
                  ) : (
                    <span style={{ color: "#93a0bb", fontSize: ".68rem" }}>not started · no cost yet</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Card>
    </aside>
  );
}

function FactsSection({ attempt }: { attempt: Attempt }) {
  const stale = attempt.worktree?.stale ?? false;
  return (
    <section style={{ marginBottom: ".6rem" }}>
      <h2
        style={{
          fontSize: ".72rem",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "#93a0bb",
          margin: "0 0 .5rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: ".5rem",
          flexWrap: "wrap",
        }}
      >
        Five runner facts
        <span
          style={{
            color: "#78849f",
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: ".64rem",
            textTransform: "none",
            marginLeft: "auto",
          }}
        >
          observed {esc(attempt.observedAt)}
        </span>
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: ".3rem",
          margin: ".2rem 0 .6rem",
        }}
      >
        {FACTS_ORDER.map((k) => {
          const v = attempt.facts[k];
          const lk = v === "unknown" && attempt.lastKnown ? attempt.lastKnown.facts[k] : null;
          const tip = `${FACT_LABELS[k]}: ${v} · observed ${attempt.observedAt} · ${attempt.observedFrom}`;
          return (
            <div
              key={k}
              className="f"
              title={tip}
              style={{
                border: "1px solid rgba(148,163,184,.08)",
                borderRadius: "3px",
                padding: ".75rem",
                textAlign: "center",
                background: "rgba(148,163,184,.03)",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  display: "block",
                  fontSize: ".56rem",
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  color: "#78849f",
                  marginBottom: ".25rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {k}
              </span>
              <Fact value={v} stale={stale} />
              <span
                style={{
                  display: "block",
                  fontFamily: "var(--mono, ui-monospace, monospace)",
                  fontSize: ".58rem",
                  color: "#78849f",
                  marginTop: ".25rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {lk ? `last ${lk} · ${esc(attempt.lastKnown?.at)}` : esc(attempt.observedAt)}
              </span>
            </div>
          );
        })}
      </div>
      {stale && (
        <div
          style={{
            border: "1px solid rgba(255,165,24, .3)",
            borderRadius: "3px",
            padding: ".75rem .8rem",
            margin: ".45rem 0",
            background: "rgba(74, 222, 128, .05)",
            fontSize: ".78rem",
            color: "#fbbf24",
          }}
        >
          This inspection is stale — read at {esc(attempt.worktree!.inspectedAt)}. The page keeps it as it was.
        </div>
      )}
    </section>
  );
}

function StepsSection({ attempt }: { attempt: Attempt }) {
  const R = attempt.receipts;
  const f = attempt.facts;
  const nodes = [
    { w: "intent", t: attempt.queuedAt || "—", st: "done" as const },
    {
      w: "dispatch",
      t: attempt.startedAt || "",
      st: attempt.startedAt ? "done" as const : attempt.capacity === "pending" ? "now" as const : "faint" as const,
    },
    {
      w: "ended",
      t: R.completion ? R.completion.at : "",
      st: R.completion
        ? "done" as const
        : f.ended === "unknown"
          ? "unknown" as const
          : f.active === "yes"
            ? "now" as const
            : "faint" as const,
    },
    {
      w: "collected",
      t: f.collected === "yes" ? "✓" : "",
      st: f.collected === "yes" ? "done" as const : R.completion && !attempt.withdrawn ? "now" as const : "faint" as const,
    },
    {
      w: "verified",
      t: R.verification ? R.verification.at : "",
      st: R.verification
        ? R.verification.pass
          ? "done" as const
          : "fail" as const
        : f.collected === "yes"
          ? "now" as const
          : "faint" as const,
    },
    {
      w: "reviewed",
      t: R.review ? R.review.at : "",
      st: R.review
        ? R.review.pass
          ? "done" as const
          : "fail" as const
        : R.verification && R.verification.pass
          ? "now" as const
          : "faint" as const,
    },
    {
      w: "accepted",
      t: R.acceptance ? R.acceptance.at : "",
      st: R.acceptance
        ? "done" as const
        : R.review && R.review.pass && R.verification && R.verification.pass
          ? R.decision && R.decision.pending
            ? "door" as const
            : "now" as const
          : "faint" as const,
    },
  ];
  if (attempt.merged) nodes.push({ w: "merged", t: R.merge ? R.merge.at : "", st: "done" as const });

  const stepColors: Record<string, { bg: string; border: string; shadow?: string }> = {
    done: { bg: "#34d399", border: "#34d399" },
    now: { bg: "transparent", border: "#22d3ee", shadow: "0 0 0 4px color-mix(in srgb, #22d3ee 16%, transparent)" },
    faint: { bg: "transparent", border: "rgba(148,163,184,.2)" },
    unknown: { bg: "transparent", border: "#fbbf24" },
    fail: { bg: "#fb7185", border: "#fb7185" },
    door: { bg: "color-mix(in srgb, #c084fc 40%, transparent)", border: "#c084fc" },
  };

  return (
    <div
      style={{
        display: "flex",
        margin: ".4rem 0 .9rem",
        overflowX: "auto",
        paddingBottom: ".2rem",
        gap: "0.5rem",
      }}
      role="img"
      aria-label="attempt lifecycle"
    >
      {nodes.map((n, i) => {
        const sc = stepColors[n.st];
        return (
          <div
            key={n.w}
            className={`step ${n.st}`}
            style={{
              flex: "1",
              minWidth: "3.8rem",
              position: "relative",
              textAlign: "center",
            }}
          >
            {i > 0 && (
              <div
                style={{
                  content: "",
                  position: "absolute",
                  top: ".42rem",
                  left: "-50%",
                  width: "100%",
                  height: "2px",
                  background: sc.bg,
                }}
              />
            )}
            <div
              className="dot"
              style={{
                position: "relative",
                display: "block",
                width: ".85rem",
                height: ".85rem",
                borderRadius: "50%",
                margin: "0 auto .3rem",
                background: sc.bg,
                border: `2px solid ${sc.border}`,
                ...(sc.shadow ? { boxShadow: sc.shadow } : {}),
                animation: n.st === "now" ? "breathe 2.2s ease-in-out infinite" : undefined,
              }}
            />
            <div
              style={{
                fontSize: ".56rem",
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "#78849f",
              }}
            >
              {n.w}
            </div>
            <div
              style={{
                fontFamily: "var(--mono, ui-monospace, monospace)",
                fontSize: ".58rem",
                color: "#93a0bb",
              }}
            >
              {esc(n.t || "·")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorktreeSection({ attempt }: { attempt: Attempt }) {
  const w = attempt.worktree;
  const list = (arr: string[] | undefined) =>
    arr && arr.length ? (
      <details style={{ cursor: "pointer" }}>
        <summary style={{ color: "#22d3ee", fontSize: ".74rem" }}>
          {arr.length} path{arr.length === 1 ? "" : "s"}
        </summary>
        <ul style={{ listStyle: "none", padding: 0, margin: ".2rem 0 0", paddingLeft: "1.1rem" }}>
          {arr.map((p) => (
            <li key={p} style={{ margin: ".1rem 0" }}>{esc(p)}</li>
          ))}
        </ul>
      </details>
    ) : (
      <span style={{ color: "#78849f" }}>none</span>
    );

  return (
    <div style={{ marginBottom: ".95rem" }}>
      <h2
        style={{
          fontSize: ".72rem",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "#93a0bb",
          margin: "0 0 .5rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: ".5rem",
          flexWrap: "wrap",
        }}
      >
        Worktree inspection
        <span
          style={{
            color: "#78849f",
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: ".64rem",
            textTransform: "none",
            marginLeft: "auto",
          }}
        >
          inspected {esc(w.inspectedAt)}
          {w.stale && (
            <Badge variant="unknown" style={{ marginLeft: ".3rem" }}>
              stale
            </Badge>
          )}
        </span>
      </h2>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content minmax(0,1fr)",
          gap: ".2rem .8rem",
          margin: 0,
          fontSize: ".8rem",
        }}
      >
        <dt style={{ color: "#93a0bb" }}>checked out</dt>
        <dd
          style={{
            margin: 0,
            overflowWrap: "anywhere",
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: ".76rem",
          }}
        >
          {esc(w.commit)} · {w.commitsSinceDispatch} commit{w.commitsSinceDispatch === 1 ? "" : "s"} since dispatch · base {esc(w.base)}
        </dd>
        <dt style={{ color: "#93a0bb" }}>uncommitted</dt>
        <dd style={{ margin: 0 }}>{list(w.uncommitted)}</dd>
        <dt style={{ color: "#93a0bb" }}>untracked</dt>
        <dd style={{ margin: 0 }}>{list(w.untracked)}</dd>
        <dt style={{ color: "#93a0bb" }}>residue</dt>
        <dd style={{ margin: 0 }}>
          {w.residue && w.residue.length ? (
            <span style={{ color: "#fbbf24", fontFamily: "var(--mono, ui-monospace, monospace)" }}>{esc(w.residue.join(", "))}</span>
          ) : (
            <span style={{ color: "#78849f" }}>none</span>
          )}
        </dd>
        <dt style={{ color: "#93a0bb" }}>expected artifacts</dt>
        <dd style={{ margin: 0 }}>
          {(w.artifacts || []).map(([n, ok]) => (
            <span
              key={n}
              style={{
                display: "inline-block",
                marginRight: ".6rem",
                fontFamily: "var(--mono, ui-monospace, monospace)",
                fontSize: ".74rem",
                color: ok ? "#34d399" : "#78849f",
              }}
            >
              {ok ? "✓ " : "– "}{esc(n)}
            </span>
          ))}
        </dd>
      </dl>
      {w.stale && (
        <div
          style={{
            border: "1px solid rgba(255,165,24, .3)",
            borderRadius: "3px",
            padding: ".75rem .8rem",
            margin: ".45rem 0",
            background: "rgba(74, 222, 128, .05)",
            fontSize: ".78rem",
            color: "#fbbf24",
          }}
        >
          This inspection is stale — read at {esc(w.inspectedAt)}. The page keeps it as it was.
        </div>
      )}
    </div>
  );
}

function ReadinessSection({ attempt }: { attempt: Attempt }) {
  if (!attempt.readiness || attempt.readiness.length === 0) return null;
  return (
    <div style={{ marginBottom: ".95rem" }}>
      <h2
        style={{
          fontSize: ".72rem",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "#93a0bb",
          margin: "0 0 .5rem",
          fontWeight: 600,
        }}
      >
        Readiness receipt
        <span
          style={{
            color: "#78849f",
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: ".64rem",
            textTransform: "none",
            marginLeft: ".4rem",
          }}
        >
          ten lines
        </span>
      </h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: ".78rem" }}>
        {attempt.readiness.map(([name, pass, rnote], i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: ".5rem",
              padding: ".75rem 0",
              alignItems: "baseline",
              borderBottom: "1px solid rgba(148,163,184,.08)",
            }}
          >
            <i
              style={{
                fontFamily: "var(--mono, ui-monospace, monospace)",
                fontSize: ".64rem",
                color: pass ? "#34d399" : "#fb7185",
                width: "2.6rem",
                flex: "none",
                fontStyle: "normal",
              }}
            >
              {pass ? "pass" : "FAIL"}
            </i>
            <span>
              <b>{esc(name)}</b> — {esc(rnote)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReceiptsSection({ attempt }: { attempt: Attempt }) {
  const R = attempt.receipts;
  const slots: Array<[string, Receipt | null | undefined]> = [
    ["completion", R.completion],
    ["verification", R.verification],
    ["review", R.review],
    ["acceptance", R.acceptance],
  ];
  if (R.merge) slots.push(["merge", R.merge]);

  const awaited: Record<string, string> = {
    completion: "no completion receipt yet",
    verification: "the verification host has not spoken",
    review: "the reviewer seat has not spoken",
    acceptance: "no acceptance binds this head yet",
    merge: "not merged",
  };

  return (
    <div style={{ marginBottom: ".95rem" }}>
      <h2
        style={{
          fontSize: ".72rem",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "#93a0bb",
          margin: "0 0 .5rem",
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: ".5rem",
          flexWrap: "wrap",
        }}
      >
        Receipts
        <span
          style={{
            color: "#78849f",
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: ".64rem",
            textTransform: "none",
            marginLeft: "auto",
          }}
        >
          GET /v1/heads/:sha/evidence
        </span>
      </h2>
      {slots.map(([name, r]) =>
        r ? (
          <div
            key={name}
            className={`receipt ${r.pass ? "pass" : "fail"}`}
            style={{
              border: "1px solid rgba(148,163,184,.13)",
              borderLeft: `3px solid ${r.pass ? "#34d399" : "#fb7185"}`,
              borderRadius: "3px",
              padding: ".75rem .8rem",
              margin: "0 0 .4rem",
              background: "rgba(148,163,184,.03)",
              fontSize: ".78rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: ".5rem",
                flexWrap: "wrap",
                fontFamily: "var(--mono, ui-monospace, monospace)",
                fontSize: ".68rem",
              }}
            >
              <b style={{ color: "#e9eef7", fontWeight: 500 }}>{name} · {r.id}</b>
              <span>{r.at}{r.head && ` · head ${r.head}`}</span>
            </div>
            <p style={{ margin: ".2rem 0 0", color: "#93a0bb" }}>{r.text}</p>
          </div>
        ) : (
          <div
            key={name}
            className="receipt pending"
            style={{
              border: "1px dashed rgba(148,163,184,.13)",
              borderLeft: "3px solid rgba(148,163,184,.2)",
              borderRadius: "3px",
              padding: ".75rem .8rem",
              margin: "0 0 .4rem",
              background: "rgba(148,163,184,.03)",
              fontSize: ".78rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: ".5rem",
                flexWrap: "wrap",
                fontFamily: "var(--mono, ui-monospace, monospace)",
                fontSize: ".68rem",
              }}
            >
              <b style={{ color: "#e9eef7", fontWeight: 500 }}>{name}</b>
              <span>awaited</span>
            </div>
            <p style={{ margin: ".2rem 0 0", color: "#78849f" }}>{awaited[name]}</p>
          </div>
        ),
      )}
    </div>
  );
}

function BriefSection({ attempt }: { attempt: Attempt }) {
  const b = attempt.brief;
  if (!b) return null;
  return (
    <details
      className="brief"
      style={{
        border: "1px solid rgba(148,163,184,.08)",
              borderRadius: "3px",
                  padding: ".75rem .8rem",
        background: "rgba(148,163,184,.03)",
      }}
    >
      <summary
        style={{
          display: "flex",
          gap: ".6rem",
          alignItems: "baseline",
          cursor: "pointer",
          color: "#93a0bb",
          fontSize: ".8rem",
          flexWrap: "wrap",
          listStyle: "none",
        }}
      >
        <b style={{ color: "#e9eef7" }}>Frozen brief</b>
        <span style={{ color: "#78849f", fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".7rem" }}>{esc(b.digest)}</span>
        <span style={{ color: "#78849f", fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".7rem" }}>frozen {esc(b.frozenAt)}</span>
      </summary>
      <div
        style={{
          display: "flex",
          gap: ".8rem",
          alignItems: "center",
          flexWrap: "wrap",
          color: "#78849f",
          fontFamily: "var(--mono, ui-monospace, monospace)",
          fontSize: ".68rem",
          margin: ".4rem 0 .5rem",
          paddingBottom: ".75rem",
          borderBottom: "1px dashed rgba(148,163,184,.08)",
        }}
      >
        <span>model <b style={{ color: "#e9eef7", fontWeight: 500 }}>{esc(attempt.model.implementer)}</b></span>
        {b.original && <span>original <b style={{ color: "#e9eef7", fontWeight: 500 }}>{esc(b.original)}</b></span>}
      </div>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content minmax(0,1fr)",
          gap: ".2rem .8rem",
          marginBottom: ".6rem",
          fontSize: ".8rem",
        }}
      >
        {Object.entries(b.manifest).map(([k, v]) => (
          <React.Fragment key={k}>
            <dt style={{ color: "#93a0bb" }}>{esc(k)}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{esc(String(v))}</dd>
          </React.Fragment>
        ))}
      </dl>
      <pre
        style={{
          background: "rgba(148,163,184,.05)",
          border: "1px solid rgba(148,163,184,.13)",
                borderRadius: "3px",
          padding: ".75rem .8rem",
          overflow: "auto",
          fontFamily: "var(--mono, ui-monospace, monospace)",
          fontSize: ".74rem",
          whiteSpace: "pre-wrap",
          color: "#e9eef7",
        }}
      >
        {esc(b.markdown)}
      </pre>
    </details>
  );
}

function RecordPane({
  attempt,
  word,
  note,
  wordVariant,
}: {
  attempt: Attempt;
  word: string;
  note: string;
  wordVariant: BadgeVariant;
}) {
  const siblings = attemptsOf(attempt.wo);
  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        margin: "0 .8rem",
      }}
      aria-label="Attempt record"
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: ".3rem",
          marginBottom: ".7rem",
        }}
        className="attempt-head"
      >
        <h1
          style={{
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: "1.05rem",
            margin: 0,
            color: "#e9eef7",
          }}
        >
          <button
            className="idbtn"
            data-action="copy"
            data-copy={attempt.id}
            title={`copy ${attempt.id}`}
            onClick={() => copyId(attempt.id)}
            style={{
              background: "none",
              border: "none",
              color: "#e9eef7",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: "1.05rem",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {esc(attempt.id)}
          </button>
        </h1>
        <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap", alignItems: "center" }}>
          <Badge variant={attempt.kind === "fix" ? "fix" : "keeper"}>
            {attempt.kind === "fix" ? `fix ${attempt.number} of ${siblings.length}` : "first attempt"}
          </Badge>
          <Badge variant={wordVariant}>{esc(word)}</Badge>
          <span
            style={{
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: ".72rem",
              color: "#93a0bb",
            }}
          >
            {esc(note)}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: ".9rem",
            flexWrap: "wrap",
            color: "#93a0bb",
            fontFamily: "var(--mono, ui-monospace, monospace)",
            fontSize: ".74rem",
          }}
          className="ids"
        >
          <span>work order <b style={{ color: "#e9eef7", fontWeight: 500 }}>{esc(attempt.wo)}</b></span>
          <span>session <b style={{ color: "#e9eef7", fontWeight: 500 }}>{attempt.session ? esc(attempt.session) : "none yet"}</b></span>
          <span>port <b style={{ color: "#e9eef7", fontWeight: 500 }}>{attempt.port}</b></span>
          <span>
            {attempt.slot ? (
              <>slot <b style={{ color: "#e9eef7", fontWeight: 500 }}>{attempt.slot}</b></>
            ) : attempt.capacity === "pending" ? (
              <>queue <b style={{ color: "#e9eef7", fontWeight: 500 }}>#waiting</b></>
            ) : (
              <b style={{ color: "#e9eef7", fontWeight: 500 }}>slot released</b>
            )}
          </span>
          {attempt.fixOf && <span>fix of <b style={{ color: "#e9eef7", fontWeight: 500 }}>{esc(attempt.fixOf)}</b></span>}
        </div>
      </div>

      <FactsSection attempt={attempt} />
      <StepsSection attempt={attempt} />
      {attempt.lastKnown && (
        <div
          style={{
            border: "1px solid rgba(255,165,24, .3)",
            borderRadius: "3px",
            padding: ".75rem .8rem",
            margin: ".45rem 0",
            background: "rgba(74, 222, 128, .05)",
            fontSize: ".78rem",
            color: "#fbbf24",
          }}
        >
          The runner did not answer at {esc(attempt.observedAt)}. Unknown is its own state — not "no", not a pass. Nothing on this page was upgraded.
          <br />
          Last known at <b style={{ color: "#e9eef7" }}>{esc(attempt.lastKnown.at)}</b>:{" "}
          {FACTS_ORDER.map((k) => `${k} ${attempt.lastKnown!.facts[k]}`).join(" · ")}
          .
        </div>
      )}

      <div style={{ marginBottom: ".95rem" }}>
        <h2
          style={{
            fontSize: ".72rem",
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "#93a0bb",
            margin: "0 0 .5rem",
            fontWeight: 600,
          }}
        >
          Model &amp; cost
          <span
            style={{
              color: "#78849f",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: ".64rem",
              textTransform: "none",
              marginLeft: "auto",
            }}
          >
            reach: {esc(attempt.cost?.note ? attempt.cost.note : "to the last observation")}
          </span>
        </h2>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "max-content minmax(0,1fr)",
            gap: ".2rem .8rem",
            margin: 0,
            fontSize: ".8rem",
          }}
        >
          <dt style={{ color: "#93a0bb" }}>implementer</dt>
          <dd
            style={{
              margin: 0,
              overflowWrap: "anywhere",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: ".76rem",
            }}
          >
            {esc(attempt.model.implementer)}
          </dd>
          <dt style={{ color: "#93a0bb" }}>fallback</dt>
          <dd
            style={{
              margin: 0,
              overflowWrap: "anywhere",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: ".76rem",
            }}
          >
            {esc(attempt.model.fallback)}
          </dd>
          <dt style={{ color: "#93a0bb" }}>reviewer seat</dt>
          <dd
            style={{
              margin: 0,
              overflowWrap: "anywhere",
              fontFamily: "var(--mono, ui-monospace, monospace)",
              fontSize: ".76rem",
            }}
          >
            {esc(attempt.model.reviewer)}
          </dd>
          <dt style={{ color: "#93a0bb" }}>cost</dt>
          <dd style={{ margin: 0 }}>
            {attempt.cost ? (
              <span
                style={{
                  fontFamily: "var(--mono, ui-monospace, monospace)",
                  fontSize: ".76rem",
                }}
              >
                {attempt.cost.steps} steps · {attempt.cost.minutes} lane min · ${attempt.cost.usd}
              </span>
            ) : (
              <span style={{ color: "#78849f" }}>nothing measured yet; the attempt has not started</span>
            )}
          </dd>
        </dl>
      </div>

      <WorktreeSection attempt={attempt} />
      <ReadinessSection attempt={attempt} />
      <ReceiptsSection attempt={attempt} />
      <BriefSection attempt={attempt} />
    </section>
  );
}

function OperationsPane({ attempt, word }: { attempt: Attempt; word: string }) {
  const legalOps = ["reconcile", "stop", "collect", "fix", "merge"];
  const isUnknown = word === "unknown";

  return (
    <aside
      style={{ flex: "0 0 260px", minWidth: 0, display: "flex", flexDirection: "column" }}
      aria-label="Operations"
    >
      <Card title="Operations" padded>
        <div style={{ display: "flex", flexDirection: "column", gap: ".45rem" }}>
          {legalOps.map((op) => {
            const isLegal = attempt.legal.includes(op);
            const notOffered = attempt.notOffered.find(([o]) => o === op);

            if (!isLegal && !notOffered) return null;

            const disabledForUnknown = isUnknown && (op === "stop" || op === "collect" || op === "merge");

            if (!isLegal && notOffered) {
              return (
                <div
                  key={op}
                  className="notoff"
                  style={{
                    display: "flex",
                    gap: ".45rem",
                    alignItems: "baseline",
                    color: "#78849f",
                    fontSize: ".76rem",
                    padding: ".75rem 0",
                  }}
                >
                  <b style={{ color: "#93a0bb", fontWeight: 500 }}>{esc(OP_LABELS[op] || op)}</b>
                  <span style={{ color: "#78849f" }}>{esc(notOffered[1])}</span>
                </div>
              );
            }

            if (isLegal && disabledForUnknown) {
              return (
                <div
                  key={op}
                  className="notoff"
                  style={{
                    display: "flex",
                    gap: ".45rem",
                    alignItems: "baseline",
                    color: "#78849f",
                    fontSize: ".76rem",
                    padding: ".75rem 0",
                  }}
                >
                  <b style={{ color: "#93a0bb", fontWeight: 500 }}>{esc(OP_LABELS[op] || op)}</b>
                  <span>unknown outcome: this operation is not enabled until the runner answers</span>
                </div>
              );
            }

            const opCls =
              op === "merge" ? "merge"
              : op === "stop" ? "danger"
              : "";
            return (
              <button
                key={op}
                className={`op ${opCls}`}
                data-action="op"
                data-op={op}
                data-att={attempt.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  textAlign: "left",
                  background: "rgba(148,163,184,.05)",
                  border: `1px solid ${
                    op === "merge" ? "rgba(52,200,159,.4)" : op === "stop" ? "rgba(251,113,133,.4)" : "rgba(148,163,184,.2)"
                  }`,
                  borderRadius: "3px",
        padding: ".75rem .8rem",
                  cursor: "pointer",
                  marginBottom: ".45rem",
                  fontSize: ".85rem",
                  color: op === "merge" ? "#34d399" : op === "stop" ? "#fb7185" : "#e9eef7",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: ".45rem",
                    flexWrap: "wrap",
                    fontWeight: 600,
                  }}
                >
                  <b>{esc(OP_LABELS[op] || op)}</b>
                  {attempt.fixOf && op === "fix" && (
                    <span
                      style={{
                        fontFamily: "var(--mono, ui-monospace, monospace)",
                        fontSize: ".72rem",
                        color: "#78849f",
                        borderLeft: "1px solid rgba(148,163,184,.13)",
                        paddingLeft: ".4rem",
                      }}
                    >
                      on {esc(attempt.wo)}
                    </span>
                  )}
                  {op === "merge" && attempt.mergeHead && (
                    <span
                      style={{
                        fontFamily: "var(--mono, ui-monospace, monospace)",
                        fontSize: ".72rem",
                        color: "#78849f",
                        borderLeft: "1px solid rgba(148,163,184,.13)",
                        paddingLeft: ".4rem",
                      }}
                    >
                      {esc(attempt.mergeHead)}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    color: "#93a0bb",
                    fontSize: ".73rem",
                    lineHeight: "1.35",
                  }}
                >
                  {esc(OP_DESC[op] || "")}
                </span>
              </button>
            );
          })}
        </div>

        {attempt.notOffered && attempt.notOffered.length > 0 && (
          <div className="notoff-wrap" style={{ marginTop: ".7rem" }}>
            <h3
              style={{
                fontSize: ".62rem",
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "#78849f",
                fontWeight: 600,
                margin: "0 0 .3rem",
              }}
            >
              Not offered, and why
            </h3>
            {attempt.notOffered.map(([op, why]) => (
              <div
                key={op}
                className="notoff"
                style={{
                  display: "flex",
                  gap: ".45rem",
                  alignItems: "baseline",
                  color: "#78849f",
                  fontSize: ".76rem",
                  padding: ".75rem 0",
                }}
              >
                <b style={{ color: "#93a0bb", fontWeight: 500 }}>{esc(OP_LABELS[op] || op)}</b>
                <span>{esc(why)}</span>
              </div>
            ))}
          </div>
        )}

        {attempt.receipts.decision && attempt.receipts.decision.pending && (
          <div
            style={{
              border: "1px solid rgba(192,132,252,.4)",
              borderLeft: "3px solid #c084fc",
              borderRadius: "3px",
              padding: ".75rem .8rem",
              margin: ".8rem 0",
              background: "color-mix(in srgb, #c084fc 6%, rgba(148,163,184,.05))",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: ".5rem",
                alignItems: "center",
                flexWrap: "wrap",
                color: "#e9eef7",
                fontSize: ".8rem",
              }}
            >
              <b>Open decision · {esc(attempt.receipts.decision.id)}</b>
              <Badge variant="blocked">{esc(attempt.receipts.decision.door)} door</Badge>
            </div>
            <p style={{ color: "#e9eef7", margin: ".35rem 0", fontSize: ".84rem" }}>{esc(attempt.receipts.decision.question)}</p>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content minmax(0,1fr)",
                gap: ".2rem .8rem",
              }}
            >
              <dt style={{ color: "#93a0bb" }}>scope</dt>
              <dd style={{ margin: 0, fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".74rem" }}>{esc(attempt.receipts.decision.scope)}</dd>
              <dt style={{ color: "#93a0bb" }}>asked</dt>
              <dd style={{ margin: 0, fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: ".74rem" }}>{esc(attempt.receipts.decision.askedAt)}</dd>
              <dt style={{ color: "#93a0bb" }}>answer</dt>
              <dd style={{ margin: 0, color: "#78849f" }}>none — silence is not approval</dd>
            </dl>
          </div>
        )}
      </Card>
    </aside>
  );
}
