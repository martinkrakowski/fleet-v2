"use client";

import { useState, type ReactNode } from "react";
import { Card, RouteChip } from "@fleet/ui";
import { FIXTURE, type ProposalFixture } from "./fixture";
import { md } from "./markdown";

const FREEZE_ROUTE_NOTE = "gap · the live freeze route is not on this station";

const kindClass = (kind: ProposalFixture["kind"]) =>
  kind === "keeper" ? "keeper" : kind === "candidate" ? "candidate" : "l3";

function clientDigest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `sha256:${h.toString(16).padStart(8, "0")}…${(h % 0xffff).toString(16).padStart(4, "0")}`;
}

function composeMarkdown(woId: string, include: Record<string, boolean>): string {
  const W = FIXTURE.workOrders[woId];
  const rows = FIXTURE.proposals.filter((p) => include[p.id]);
  const bounds = W.manifest?.bounds ?? "—";
  const owned = W.manifest?.["owned paths"] ?? "—";
  return `# ${woId} · ${W.lane}\n\n${W.task}.\n\n## Bounds\n${bounds}. Owned paths ${owned}.\n\n## Context selected for this brief\n| Entry | Claim |\n|---|---|\n${rows
    .map((p) => `| ${p.id} ${p.v} | ${p.claim} |`)
    .join("\n")}\n\nWrite \`.lane/notes.md\` before you stop: one claim per line, with the path it is about.`;
}

interface ClientFrozen {
  wo: string;
  digest: string;
  frozenAt: string;
  markdown: string;
}

function ProposalRow({ p, locked, included, onToggle }: { p: ProposalFixture; locked: boolean; included: boolean; onToggle?: () => void }) {
  return (
    <tr className={included ? "" : "excluded"}>
      <td className="inc">
        {locked ? (
          <span className={`lockstamp ${included ? "in" : "out"}`}>{included ? "included" : "excluded"}</span>
        ) : (
          <label className="switch">
            <input type="checkbox" checked={included} onChange={onToggle} />
            <span className="track" />
          </label>
        )}
      </td>
      <td className="mono">{p.id} {p.v}</td>
      <td><span className={`badge ${kindClass(p.kind)}`}>{p.kind}</span></td>
      <td className="claim"><span className="c">{p.claim}</span></td>
      <td className="src">{p.scope}</td>
      <td className="mono src">{p.source}</td>
      <td className="why">{p.why.map(([k, v]) => <span className="chip" key={k}>{k} · {v}</span>)}</td>
    </tr>
  );
}

export default function BriefPage() {
  const [briefWo, setBriefWo] = useState("wo-0144");
  const [include, setInclude] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FIXTURE.proposals.map((p) => [p.id, p.include]))
  );
  const [frozen, setFrozen] = useState<ClientFrozen | null>(null);
  const [dispatchedWo, setDispatchedWo] = useState<string | null>(null);

  const woIds = Object.keys(FIXTURE.workOrders);
  const frozenIds = woIds.filter((w) => Boolean(FIXTURE.frozenPackages[w]) || frozen?.wo === w);
  const unfrozenIds = woIds.filter((w) => !frozenIds.includes(w));
  const sel = woIds.includes(briefWo) ? briefWo : unfrozenIds[0] || frozenIds[0] || woIds[0];
  const W = FIXTURE.workOrders[sel];
  const isFrozen = frozenIds.includes(sel);
  const includedCount = FIXTURE.proposals.filter((p) => include[p.id]).length;

  const freeze = () => {
    const markdown = composeMarkdown(sel, include);
    setFrozen({ wo: sel, digest: clientDigest(markdown), frozenAt: "14:02:10Z", markdown });
    setDispatchedWo(null);
  };

  const dispatch = () => {
    setDispatchedWo(sel);
  };

  const fresh = frozen?.wo === sel;
  const pkg = FIXTURE.frozenPackages[sel];
  const shown = fresh
    ? { digest: frozen.digest, frozenAt: frozen.frozenAt, manifest: W.manifest ?? {}, markdown: frozen.markdown, original: undefined }
    : pkg;

  let main: ReactNode;
  if (!isFrozen || !shown) {
    main = (
      <>
        <Card className="pad manifest">
          <h2>Manifest <span className="meta"><RouteChip gap>gap · no package read</RouteChip></span></h2>
          <dl className="kv">
            {Object.entries(W.manifest ?? {}).flatMap(([k, v]) => [
              <dt key={k}>{k}</dt>,
              <dd key={`${k}-dd`}>{v}</dd>
            ])}
          </dl>
        </Card>
        <Card className="pad rows-card">
          <h2>Rows the retrieval proposed <span className="meta"><RouteChip>POST /v1/knowledge/proposals</RouteChip><span className="meta">{includedCount} of {FIXTURE.proposals.length} included</span></span></h2>
          <div className="tablewrap inner">
            <table className="grid rows">
              <thead><tr><th>include</th><th>entry</th><th>kind</th><th>claim</th><th>scope</th><th>source</th><th>matched because</th></tr></thead>
              <tbody>
                {FIXTURE.proposals.map((p) => (
                  <ProposalRow
                    key={p.id}
                    p={p}
                    locked={false}
                    included={Boolean(include[p.id])}
                    onToggle={() => setInclude((s) => ({ ...s, [p.id]: !s[p.id] }))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="freeze-bar">
            <span className="sum">{includedCount} of {FIXTURE.proposals.length} rows included · freeze computes the digest · nothing changes after</span>
            <button className="btn primary" onClick={freeze} disabled={includedCount === 0}>Freeze the brief</button>
            <RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>
          </div>
          <p className="note info">Freeze is its own step. Dispatch follows separately as a second button. Neither button fetches on this station: the live freeze route is not here, and the pending include and exclude choices above are client state until a freeze writes a digest.</p>
        </Card>
      </>
    );
  } else {
    main = (
      <>
        {fresh ? (
          <Card className="pad rows-card">
            <h2>Rows as frozen <span className="meta">locked · {shown.digest}</span></h2>
            <div className="tablewrap inner">
              <table className="grid rows">
                <thead><tr><th>row</th><th>entry</th><th>kind</th><th>claim</th><th>scope</th><th>source</th><th>matched because</th></tr></thead>
                <tbody>
                  {FIXTURE.proposals.map((p) => (
                    <ProposalRow key={p.id} p={p} locked included={Boolean(include[p.id])} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
        <Card className="pad frozen-card">
          <div className="brief-stamp">
            <span>digest <b>{shown.digest}</b></span>
            <span>frozen <b>{shown.frozenAt}</b></span>
            {shown.original ? <span>original <b>{shown.original}</b></span> : null}
            <RouteChip gap>gap · no package read</RouteChip>
          </div>
          <dl className="kv manifest-dl">
            {Object.entries(shown.manifest).flatMap(([k, v]) => [
              <dt key={k}>{k}</dt>,
              <dd key={`${k}-dd`}>{v}</dd>
            ])}
          </dl>
          <div className="md" dangerouslySetInnerHTML={{ __html: md(shown.markdown) }} />
          {fresh ? (
            <div className="freeze-bar">
              {dispatchedWo === sel ? (
                <p className="note info">Dispatch was pressed. No request left this station — the live freeze and dispatch routes are not on this station, so nothing was recorded.</p>
              ) : (
                <>
                  <span className="sum">the package is frozen; the intent is not recorded yet</span>
                  <button className="btn primary" onClick={dispatch}>Dispatch the intent</button>
                  <RouteChip>POST /v1/attempts</RouteChip>
                  <span className="sum">a separate step — the Line holds the intent until a slot frees</span>
                </>
              )}
            </div>
          ) : (
            <p className="note ok">Frozen and dispatched. The digest is the truth the runner was held to.</p>
          )}
        </Card>
      </>
    );
  }

  const woItem = (w: string, isWoFrozen: boolean) => {
    const wo = FIXTURE.workOrders[w];
    const meta = isWoFrozen
      ? FIXTURE.frozenPackages[w]?.digest ?? frozen?.digest ?? "frozen"
      : "needs a brief";
    return (
      <button
        key={w}
        className={`woitem ${isWoFrozen ? "" : "needs"}`}
        onClick={() => setBriefWo(w)}
        aria-current={sel === w}
      >
        <span className="t">{wo.task}</span>
        <span className="m">{w} · {wo.lane} · {meta}</span>
      </button>
    );
  };

  return (
    <div className="fc">
      <style>{`
        .fc{ color-scheme:dark; --bg:#05070d; --bg-raise:#101623; --bg-sink:#04060b; --card:#0a0e18;
          --card-sheen:linear-gradient(180deg,rgba(255,255,255,.028),rgba(255,255,255,.008) 42%,rgba(255,255,255,0));
          --line:rgba(148,163,184,.13); --line-soft:rgba(148,163,184,.08); --line-strong:rgba(148,163,184,.28);
          --text:#e9eef7; --muted:#93a0bb; --faint:#78849f;
          --cyan:#22d3ee; --emerald:#34d399; --amber:#fbbf24; --violet:#c084fc; --slate:#7d8aa5;
          --glow-cyan:rgba(34,211,238,.13); --glow-violet:rgba(192,132,252,.11);
          --radius-card:3px; --radius:3px;
          --sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
          --display:"Space Grotesk",var(--sans);
          --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
          background:
            radial-gradient(60rem 40rem at 12% -12%,var(--glow-cyan),transparent 70%),
            radial-gradient(52rem 36rem at 88% -10%,var(--glow-violet),transparent 72%),
            var(--bg);
          color:var(--text); font-family:var(--sans); font-size:13px; line-height:1.45;
          min-height:100vh; padding:1rem 1.1rem 1.4rem; -webkit-font-smoothing:antialiased; }
        .fc *{ box-sizing:border-box }
        .fc ::selection{ background:var(--cyan); color:var(--bg) }
        .fc code,.fc .mono{ font-family:var(--mono); font-size:.92em }
        .fc button{ font:inherit; color:inherit }
        .fc :focus-visible{ outline:2px solid var(--cyan); outline-offset:2px }
        .fc .vh-top{ display:flex; align-items:center; gap:.8rem; flex-wrap:wrap; margin:0 0 .15rem }
        .fc h1{ font-family:var(--display); font-size:1.35rem; letter-spacing:-.01em; margin:0; line-height:1.2 }
        .fc h2{ font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin:0 0 .5rem; font-weight:600; display:flex; align-items:baseline; gap:.5rem; flex-wrap:wrap }
        .fc h2 .meta{ color:var(--faint); font-family:var(--mono); font-size:.64rem; letter-spacing:0; text-transform:none; margin-left:auto; display:inline-flex; gap:.4rem; align-items:center; flex-wrap:wrap; font-weight:400 }
        .fc .lede{ color:var(--muted); margin:.2rem 0 .9rem; max-width:80ch }
        .fc .lede code{ color:var(--text) }
        .fc .route{ display:inline-flex; align-items:center; font-family:var(--mono); font-size:.6rem; letter-spacing:.02em; color:var(--faint); border:1px solid var(--line-soft); border-radius:999px; padding:.06rem .5rem; white-space:nowrap }
        .fc .route.gap{ color:var(--amber); border:1px dashed color-mix(in srgb,var(--amber) 40%,transparent) }
        .fc .card{ background:var(--card-sheen),var(--card); border:1px solid var(--line); border-radius:var(--radius-card) }
        .fc .card.pad{ padding:.75rem .9rem }
        .fc .brief-grid{ display:grid; grid-template-columns:23rem minmax(0,1fr); gap:.8rem; align-items:start }
        .fc .pane{ display:flex; flex-direction:column; min-height:0; background:var(--card-sheen),var(--card); border:1px solid var(--line); border-radius:var(--radius-card) }
        .fc .pane>header{ flex:none; padding:.75rem .8rem; border-bottom:1px solid var(--line-soft); display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; min-height:2.3rem }
        .fc .pane>header h2{ margin:0; flex:none }
        .fc .pane>header .meta{ margin-left:auto; color:var(--faint); font-family:var(--mono); font-size:.64rem }
        .fc .pane>.body{ flex:1; min-height:0; overflow:auto; padding:.75rem .8rem }
        .fc .woitem{ display:flex; flex-direction:column; gap:.15rem; width:100%; text-align:left; background:var(--bg-sink); border:1px solid var(--line-soft); border-radius:var(--radius); padding:.75rem .8rem; margin-bottom:.4rem; cursor:pointer; color:var(--muted) }
        .fc .woitem:hover{ border-color:var(--line-strong) }
        .fc .woitem[aria-current="true"]{ border-color:var(--cyan); box-shadow:0 0 0 3px color-mix(in srgb,var(--cyan) 14%,transparent) }
        .fc .woitem .t{ color:var(--text); font-size:.8rem }
        .fc .woitem .m{ font-family:var(--mono); font-size:.64rem; color:var(--faint) }
        .fc .woitem.needs .m{ color:var(--amber) }
        .fc .listhead{ margin:.9rem 0 .35rem; font-size:.6rem; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); font-weight:600 }
        .fc dl.kv{ display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.2rem .8rem; margin:0; font-size:.8rem }
        .fc dl.kv dt{ color:var(--muted) }
        .fc dl.kv dd{ margin:0; overflow-wrap:anywhere }
        .fc .tablewrap{ overflow:auto; padding:.75rem }
        .fc .tablewrap.inner{ border:1px solid var(--line-soft); border-radius:var(--radius); margin-top:.3rem; padding:.75rem }
        .fc table.grid{ width:100%; border-collapse:collapse }
        .fc table.grid th{ text-align:left; color:var(--faint); font-family:var(--mono); font-size:.6rem; letter-spacing:.12em; text-transform:uppercase; font-weight:500; padding:.75rem; border-bottom:1px solid var(--line); white-space:nowrap; position:sticky; top:0; background:var(--card); z-index:1 }
        .fc table.grid td{ padding:.75rem; border-bottom:1px solid var(--line-soft); vertical-align:top }
        .fc table.grid tr:last-child td{ border-bottom:none }
        .fc table.rows td.claim{ max-width:36ch } .fc table.rows td.mono{ white-space:nowrap; font-size:.74rem }
        .fc table.rows td.why{ max-width:30ch } .fc table.rows td.src{ white-space:nowrap; font-size:.72rem }
        .fc table.rows tr.excluded td.claim,.fc table.rows tr.excluded td.why{ color:var(--faint) }
        .fc table.rows tr.excluded td.claim .c{ text-decoration:line-through; text-decoration-color:var(--line-strong) }
        .fc table.rows td.inc{ width:3.4rem; text-align:center }
        .fc .switch{ display:inline-flex; align-items:center; gap:.45rem; cursor:pointer; user-select:none }
        .fc .switch input{ position:absolute; opacity:0; width:0; height:0 }
        .fc .switch .track{ width:1.9rem; height:1.05rem; border-radius:999px; border:1px solid var(--line-strong); background:var(--bg-sink); position:relative; transition:.15s; flex:none }
        .fc .switch .track::after{ content:""; position:absolute; top:1px; left:1px; width:.78rem; height:.78rem; border-radius:50%; background:var(--muted); transition:.15s }
        .fc .switch input:checked + .track{ background:color-mix(in srgb,var(--cyan) 20%,var(--bg-sink)); border-color:var(--cyan) }
        .fc .switch input:checked + .track::after{ left:calc(100% - .9rem); background:var(--cyan) }
        .fc .switch input:focus-visible + .track{ outline:2px solid var(--cyan); outline-offset:2px }
        .fc .freeze-bar{ display:flex; gap:.8rem; align-items:center; flex-wrap:wrap; margin-top:.8rem; padding-top:.75rem; border-top:1px solid var(--line) }
        .fc .freeze-bar .sum{ color:var(--muted); font-size:.76rem }
        .fc .lockstamp{ display:inline-flex; gap:.3rem; align-items:center; font-family:var(--mono); font-size:.62rem; color:var(--muted); white-space:nowrap }
        .fc .lockstamp.in{ color:var(--emerald) } .fc .lockstamp.out{ color:var(--faint) }
        .fc .badge{ display:inline-flex; align-items:center; gap:.25rem; border:1px solid currentColor; border-radius:999px; background:color-mix(in srgb, currentColor 9%, transparent); font-family:var(--mono); font-size:.6rem; letter-spacing:.05em; padding:.03rem .45rem; text-transform:uppercase; white-space:nowrap; font-weight:500 }
        .fc .badge.keeper{ color:var(--emerald) } .fc .badge.candidate{ color:var(--amber) } .fc .badge.l3{ color:var(--violet) }
        .fc .chip{ display:inline-block; border:1px solid var(--line); border-radius:999px; padding:.02rem .45rem; font-family:var(--mono); font-size:.6rem; color:var(--muted); white-space:nowrap; margin:.06rem .18rem .06rem 0 }
        .fc .btn{ background:var(--bg-sink); border:1px solid var(--line-strong); border-radius:var(--radius); cursor:pointer; padding:.35rem .7rem; display:inline-flex; align-items:center; gap:.4rem; color:var(--text) }
        .fc .btn:hover{ border-color:var(--text) }
        .fc .btn[disabled]{ opacity:.5; cursor:default }
        .fc .btn.primary{ border-color:color-mix(in srgb,var(--cyan) 55%,transparent); color:var(--cyan) }
        .fc .note{ border:1px solid var(--amber); border-radius:var(--radius); color:var(--amber); padding:.75rem .8rem; font-size:.78rem; background:var(--bg-raise); margin:.45rem 0 }
        .fc .note b{ color:var(--text); font-weight:500 }
        .fc .note.ok{ border-color:var(--emerald); color:var(--emerald) }
        .fc .note.info{ border-color:var(--line-strong); color:var(--muted) }
        .fc .brief-stamp{ display:flex; gap:.8rem; flex-wrap:wrap; align-items:center; color:var(--faint); font-family:var(--mono); font-size:.68rem; margin:0 0 .7rem; padding-bottom:.75rem; border-bottom:1px dashed var(--line) }
        .fc .brief-stamp b{ color:var(--muted); font-weight:500 }
        .fc .manifest-dl{ margin-bottom:.6rem }
        .fc .rows-card{ margin-top:.8rem }
        .fc .frozen-card{ margin-top:.8rem }
        .fc .rows-card:first-child,.fc .frozen-card:first-child{ margin-top:0 }
        .fc .md{ max-width:72ch }
        .fc .md h1{ font-size:1.12rem; margin:0 0 .6rem; font-family:var(--display) }
        .fc .md h2{ font-size:.95rem; letter-spacing:0; text-transform:none; color:var(--text); margin:1rem 0 .35rem; font-weight:600 }
        .fc .md h3{ font-size:.88rem; margin:.8rem 0 .3rem }
        .fc .md p{ margin:0 0 .6rem; color:var(--text) }
        .fc .md ul,.fc .md ol{ margin:0 0 .6rem; padding-left:1.3rem }
        .fc .md li{ margin:.18rem 0 }
        .fc .md code{ background:color-mix(in srgb,var(--cyan) 10%,transparent); border-radius:4px; padding:.05rem .3rem; color:var(--cyan) }
        .fc .md pre{ background:var(--bg-sink); border:1px solid var(--line); border-radius:var(--radius); padding:.75rem .8rem; overflow:auto }
        .fc .md pre code{ background:none; color:var(--text); padding:0 }
        .fc .md table{ border-collapse:collapse; margin:.4rem 0 .8rem; font-size:.8rem }
        .fc .md th,.fc .md td{ border:1px solid var(--line); padding:.75rem; text-align:left }
        @media (max-width:72rem){
          .fc .brief-grid{ grid-template-columns:1fr }
        }
      `}</style>
      <div className="vh-top">
        <h1>Brief</h1>
        <RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>
      </div>
      <p className="lede">One work order has no frozen package. Include or exclude the rows the retrieval proposed; the freeze computes the digest and locks the rows; dispatch is a separate button — freeze does not dispatch. Neither button fetches on this station. The rendered brief is read-only — nothing inside it is a control.</p>
      <div className="brief-grid">
        <aside className="pane" aria-label="Work orders">
          <header><h2>Work orders</h2><span className="meta">{unfrozenIds.length} need a brief</span></header>
          <div className="body">
            {unfrozenIds.map((w) => woItem(w, false))}
            {frozenIds.length ? <div className="listhead">frozen packages</div> : null}
            {frozenIds.map((w) => woItem(w, true))}
          </div>
        </aside>
        <div>{main}</div>
      </div>
    </div>
  );
}
