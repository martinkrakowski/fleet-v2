"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Card, Fact } from "@fleet/ui";
import {
  attempts,
  capacity,
  install,
  workOrders,
  type AttemptSummary,
  type FactName,
  type FactState
} from "./fixture";
import styles from "./line.module.css";

const FACT_ORDER: FactName[] = ["reachable", "prepared", "active", "ended", "collected"];
const FACT_WORDS: Record<FactName, string> = {
  reachable: "Runner reachable",
  prepared: "Workspace prepared",
  active: "Worker command active",
  ended: "Worker command ended",
  collected: "Artifacts collected"
};
const STATE_ORDER: Record<string, number> = {
  unknown: 0,
  blocked: 1,
  active: 2,
  queued: 3,
  accepted: 4,
  failed: 5,
  ended: 6
};
const STATE_FILTERS = ["", "unknown", "blocked", "active", "queued", "accepted", "failed", "ended"];

function summary(a: AttemptSummary): [word: string, note: string] {
  if (a.receipts.decision && a.receipts.decision.pending) {
    return ["blocked", `waiting on decision ${a.receipts.decision.id}`];
  }
  if (a.facts.reachable === "unknown" || a.facts.ended === "unknown") {
    return ["unknown", a.lastKnown ? `runner silent since ${a.lastKnown.at}` : "runner silent"];
  }
  if (a.capacity === "pending") return ["queued", "intent recorded · waiting for a slot"];
  if (a.receipts.acceptance) return ["accepted", `accepted at ${a.receipts.acceptance.head}`];
  if (a.receipts.verification && !a.receipts.verification.pass) {
    return ["failed", `check failed at ${a.receipts.verification.head}`];
  }
  if (a.facts.active === "yes") {
    return ["active", `running · ${a.cost ? `${a.cost.minutes} lane min` : ""}`];
  }
  if (a.facts.ended === "yes") {
    return ["ended", a.facts.collected === "yes" ? "ended · collected" : "ended · artifacts not collected"];
  }
  return ["ended", "ended"];
}

const woOf = (a: AttemptSummary) => workOrders[a.wo];
const attemptsOf = (wo: string) => attempts.filter((a) => a.wo === wo);
const attemptHref = (a: AttemptSummary) => `/attempt?id=${a.id}`;
const isLive = (a: AttemptSummary) => a.facts.active === "yes" && a.facts.ended === "no";

function queuePos(a: AttemptSummary): number {
  const q = attempts
    .filter((x) => x.capacity === "pending")
    .sort((x, y) => (x.queuedAt ?? "").localeCompare(y.queuedAt ?? ""));
  return q.findIndex((x) => x.id === a.id) + 1;
}

function FactCell({ attempt, name }: { attempt: AttemptSummary; name: FactName }) {
  const value = attempt.facts[name];
  const state: FactState = attempt.stale ? "stale" : value;
  let tip = `${FACT_WORDS[name]}: ${value} · observed ${attempt.observedAt} · ${attempt.observedFrom}`;
  if (value === "unknown" && attempt.lastKnown) {
    tip += ` · last known ${attempt.lastKnown.at}: ${attempt.lastKnown.facts[name]}`;
  }
  return (
    <td className={styles.fact} title={tip}>
      <Fact state={state} />
    </td>
  );
}

function LiveClock({ startMinutes }: { startMinutes: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const total = startMinutes * 60 + elapsed;
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return <span className={`${styles.mono} ${styles.clock}`}>{mm}:{ss}</span>;
}

function AttemptRow({ attempt }: { attempt: AttemptSummary }) {
  const router = useRouter();
  const [word, note] = summary(attempt);
  const wo = woOf(attempt);
  const href = attemptHref(attempt);
  const idSub = attempt.capacity === "pending"
    ? `queued #${queuePos(attempt)} · ${attempt.queueBound} bound · no session`
    : attempt.session
      ? `${attempt.session} · port ${attempt.port}${attempt.slot ? ` · slot ${attempt.slot}` : ""}`
      : "ended · slot released";
  const silent = attempt.facts.reachable === "unknown" && attempt.lastKnown
    ? ` · silent since ${attempt.lastKnown.at}`
    : "";
  const live = isLive(attempt);
  return (
    <tr className={styles.row} onClick={() => router.push(href)}>
      <td className={styles.cAtt}>
        <Link className={styles.idlink} href={href} onClick={(e) => e.stopPropagation()}>
          {attempt.id}
        </Link>{" "}
        <Badge tone={attempt.kind === "fix" ? "fix" : "first"}>
          {attempt.kind === "fix" ? `fix ${attempt.number}` : "first"}
        </Badge>
        <span className={styles.sub}>
          {idSub}
          {silent}
        </span>
      </td>
      <td>
        <span className={styles.task} title={wo.task}>{wo.task}</span>
        <span className={`${styles.sub} ${styles.mono}`}>{attempt.wo} · {wo.lane}</span>
      </td>
      {FACT_ORDER.map((name) => (
        <FactCell key={name} attempt={attempt} name={name} />
      ))}
      <td className={styles.cState}>
        <span className={styles.stateword}>
          {live ? <i className={styles.pulseDot} aria-hidden="true" /> : null}
          <Badge tone={word}>{word}</Badge>
          {live ? <LiveClock startMinutes={attempt.cost?.minutes ?? 0} /> : null}
        </span>
        <span className={styles.sub}>{note}</span>
      </td>
      <td className={styles.cObs}>
        <b className={`${styles.mono} ${styles.t}`}>{attempt.observedAt}</b>
        <span className={styles.sub} title={attempt.observedFrom}>{attempt.observedFrom}</span>
      </td>
      <td className={styles.cGo}>›</td>
    </tr>
  );
}

interface AttentionItem {
  kind: string;
  tt: ReactNode;
  ss: string;
  rr?: ReactNode;
}

function attentionItems(): AttentionItem[] {
  const items: AttentionItem[] = [];
  attempts.forEach((a) => {
    const [word, note] = summary(a);
    if (word === "unknown") {
      items.push({
        kind: styles.attnUnknown,
        tt: <><b>{a.id}</b> runner did not answer</>,
        ss: `${note} · slot ${a.slot} stays held · reconcile returns 409, not a guess`
      });
    }
    const decision = a.receipts.decision;
    if (word === "blocked" && decision) {
      items.push({
        kind: styles.attnBlocked,
        tt: <><b>{a.wo}</b> waits on decision {decision.id}</>,
        ss: `${note} · a ${decision.door} door · silence is not approval`,
        rr: (
          <a className={styles.wavesLink} href={install.wavesInboxUrl} target="_blank" rel="noopener noreferrer">
            answer in Waves
          </a>
        )
      });
    }
    if (word === "ended" && a.receipts.completion && a.facts.collected !== "yes") {
      items.push({
        kind: styles.attnCollect,
        tt: <><b>{a.id}</b> ended · artifacts not collected</>,
        ss: `completion ${a.receipts.completion.id} · collect is legal now`
      });
    }
    if (word === "failed") {
      const openFix = attemptsOf(a.wo).find(
        (x) => x.id !== a.id && (x.capacity === "held" || x.capacity === "pending")
      );
      items.push({
        kind: styles.attnFailed,
        tt: <><b>{a.id}</b> verification failed</>,
        ss: `${note}${openFix ? ` · a fix is already open: ${openFix.id}` : ""}`
      });
    }
    if (word === "queued") {
      items.push({
        kind: styles.attnQueued,
        tt: <><b>{a.id}</b> queued for a slot</>,
        ss: `${note}${a.queueBound ? ` · ${a.queueBound} bound` : ""} · no session yet, so withdraw is the only word`
      });
    }
    if (word === "accepted" && a.receipts.acceptance && a.legal.includes("merge")) {
      items.push({
        kind: styles.attnMergeable,
        tt: <><b>{a.wo}</b> accepted at <span className={styles.mono}>{a.receipts.acceptance.head}</span></>,
        ss: `pull request ${a.pullRequest} · merge is legal`
      });
    }
  });
  return items;
}

export default function LinePage() {
  const [showEnded, setShowEnded] = useState(true);
  const [stateFilter, setStateFilter] = useState("");

  const scoped = attempts;
  const rows = useMemo(
    () =>
      scoped
        .filter((a) => showEnded || a.capacity !== "released")
        .filter((a) => !stateFilter || summary(a)[0] === stateFilter)
        .sort((x, y) => {
          const p = woOf(x).project.localeCompare(woOf(y).project);
          if (p) return p;
          const s = STATE_ORDER[summary(x)[0]] - STATE_ORDER[summary(y)[0]];
          if (s) return s;
          return (y.startedAt ?? y.queuedAt ?? "").localeCompare(x.startedAt ?? x.queuedAt ?? "");
        }),
    [scoped, showEnded, stateFilter]
  );

  const queued = scoped.filter((a) => a.capacity === "pending").length;
  const unknown = scoped.filter((a) => summary(a)[0] === "unknown").length;
  const blocked = scoped.filter((a) => summary(a)[0] === "blocked").length;
  const heldAttempts = attempts
    .filter((a) => a.capacity === "held")
    .sort((x, y) => (x.slot ?? 0) - (y.slot ?? 0));
  const pendingAttempts = attempts
    .filter((a) => a.capacity === "pending")
    .sort((x, y) => (x.queuedAt ?? "").localeCompare(y.queuedAt ?? ""));
  const queuedAll = pendingAttempts.length;
  const attention = useMemo(() => attentionItems(), []);

  const body: ReactNode[] = [];
  let lastProject: string | null = null;
  rows.forEach((a) => {
    const project = woOf(a).project;
    if (project !== lastProject) {
      lastProject = project;
      const n = rows.filter((r) => woOf(r).project === project).length;
      body.push(
        <tr key={`group-${project}`} className={styles.group}>
          <td colSpan={10}>{project} · {n} attempt{n === 1 ? "" : "s"}</td>
        </tr>
      );
    }
    body.push(<AttemptRow key={a.id} attempt={a} />);
  });

  return (
    <main className={styles.page}>
      <div className={styles.vhTop}>
        <h1 className={styles.title}>Line</h1>
        <span className={`${styles.route} ${styles.routeGap}`} title="a route the plan does not name yet">
          gap · no list route: GET /v1/attempts is missing
        </span>
      </div>
      <p className={styles.lede}>
        Attempts for <b>every project</b>, five runner facts kept apart. A branch is not an
        attempt; a fix is a fresh attempt on the same work order. <b>Unknown</b> holds its
        slot until the runner answers — it is never read as idle, never as a pass. The state
        word is derived, and labelled as derived.
      </p>
      <div className={styles.counts}>
        <Card className={styles.count}>
          <div className={styles.countN}>{queued}</div>
          <div className={styles.countL}>queued</div>
          <div className={styles.countH}>intents recorded · no session yet · waiting for a slot</div>
        </Card>
        <Card className={`${styles.count} ${styles.countUnknown}`}>
          <div className={styles.countN}>{unknown}</div>
          <div className={styles.countL}>unknown</div>
          <div className={styles.countH}>runner could not be read · not idle, not a pass · holds its slot</div>
        </Card>
        <Card className={`${styles.count} ${styles.countBlocked}`}>
          <div className={styles.countN}>{blocked}</div>
          <div className={styles.countL}>blocked</div>
          <div className={styles.countH}>waiting on a signed decision in Waves · silence is not approval</div>
        </Card>
        <Card className={styles.count}>
          <div className={styles.countN}>
            {heldAttempts.length}
            <small>/{capacity.slots}</small>
          </div>
          <div className={styles.countL}>slots held</div>
          <div className={styles.countH}>
            {capacity.host} · port {capacity.port} · {queuedAll} queued intent{queuedAll === 1 ? "" : "s"} behind them
          </div>
        </Card>
      </div>
      <div className={styles.linetools}>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />
          <span className={styles.track} />
          <span>show ended</span>
        </label>
        <label className={styles.selfilter}>
          state
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            {STATE_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s || "every state"}
              </option>
            ))}
          </select>
        </label>
        <span className={`${styles.tally} ${styles.mono}`}>
          {rows.length} of {scoped.length} shown{stateFilter ? " · filtered" : ""}
        </span>
      </div>
      <div className={styles.linegrid}>
        <Card className={styles.tablewrap}>
          {rows.length > 0 ? (
            <table className={styles.grid}>
              <thead>
                <tr>
                  <th className={styles.cAtt}>attempt</th>
                  <th>work order</th>
                  {FACT_ORDER.map((name, i) => (
                    <th
                      key={name}
                      className={`${styles.fact}${i === 0 ? ` ${styles.factFirst}` : ""}${i === FACT_ORDER.length - 1 ? ` ${styles.factLast}` : ""}`}
                    >
                      {name}
                    </th>
                  ))}
                  <th className={styles.cState}>state</th>
                  <th className={styles.cObs}>observed</th>
                  <th className={styles.cGo}></th>
                </tr>
              </thead>
              <tbody>{body}</tbody>
            </table>
          ) : (
            <div className={styles.empty}>
              Nothing matches this filter — that is not “nothing running”. {scoped.length}{" "}
              attempt{scoped.length === 1 ? "" : "s"} in scope; the state filter or the
              show-ended toggle hides the rest. A capped or offline station is a note like
              this one, never an empty table.
            </div>
          )}
        </Card>
        <aside className={styles.rail}>
          <Card className={styles.pad}>
            <h2 className={styles.h2}>
              Capacity
              <span className={styles.meta}>gap · no capacity route</span>
            </h2>
            <div className={styles.kvline}>
              {capacity.host} · port {capacity.port} · {heldAttempts.length} of {capacity.slots} slots held
            </div>
            <div className={styles.seats}>
              {Array.from({ length: capacity.slots }, (_, i) => {
                const holder = heldAttempts.find((a) => a.slot === i + 1);
                return (
                  <div
                    key={i}
                    className={`${styles.seat}${holder ? ` ${styles.seatHeld}` : ""}`}
                    title={holder ? `${holder.id} · ${summary(holder)[1]}` : "free"}
                  >
                    <b>slot {i + 1}</b>
                    <span className={styles.who}>{holder ? `…${holder.id.slice(-5)}` : "free"}</span>
                  </div>
                );
              })}
            </div>
            {pendingAttempts.length > 0 ? (
              <div>
                <span className={styles.qLbl}>queued behind them</span>
                {pendingAttempts.map((a) => (
                  <Link key={a.id} className={styles.qitem} href={attemptHref(a)} title={a.id}>
                    <b className={styles.mono}>{a.id}</b>
                    <span>{a.wo}</span>
                    <span className={styles.mono}>{a.queueBound} bound</span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className={styles.qNone}>no queued intents</div>
            )}
            <p className={styles.capnote}>
              Unknown holds its slot. A slot frees only when a completion receipt is written.
            </p>
          </Card>
          <Card className={styles.pad}>
            <h2 className={styles.h2}>
              Needs attention
              <span className={styles.meta}>{attention.length}</span>
            </h2>
            {attention.length > 0 ? (
              attention.map((item, i) => (
                <div key={i} className={`${styles.attn} ${item.kind}`}>
                  <div className={styles.tt}>{item.tt}</div>
                  <div className={styles.ss}>{item.ss}</div>
                  {item.rr ? <div className={styles.rr}>{item.rr}</div> : null}
                </div>
              ))
            ) : (
              <div className={styles.empty}>
                Nothing needs the operator right now. The counts above are work, not health.
              </div>
            )}
          </Card>
        </aside>
      </div>
    </main>
  );
}
