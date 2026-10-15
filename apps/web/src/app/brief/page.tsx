"use client";

import { useState } from "react";
import { AlertBox, Button, PageHeader } from "@fleet/ui";
import { FIXTURE } from "./fixture";
import { WorkOrderListCard } from "./components/work-order-list-card";
import { BriefManifestCard } from "./components/brief-manifest-card";
import { ProposalTableCard } from "./components/proposal-table-card";
import { FrozenBriefCard } from "./components/frozen-brief-card";
import styles from "./brief.module.css";

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

export default function BriefPage() {
  const [briefWo, setBriefWo] = useState("wo-0144");
  const [include, setInclude] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FIXTURE.proposals.map((p) => [p.id, p.include]))
  );
  const [frozen, setFrozen] = useState<ClientFrozen | null>(null);
  const [dispatchedWo, setDispatchedWo] = useState<string | null>(null);
  const [confirmFreezeOpen, setConfirmFreezeOpen] = useState(false);

  const woIds = Object.keys(FIXTURE.workOrders);
  const frozenIds = woIds.filter((w) => Boolean(FIXTURE.frozenPackages[w]) || frozen?.wo === w);
  const unfrozenIds = woIds.filter((w) => !frozenIds.includes(w));
  const sel = woIds.includes(briefWo) ? briefWo : unfrozenIds[0] || frozenIds[0] || woIds[0];
  const W = FIXTURE.workOrders[sel];
  const isFrozen = frozenIds.includes(sel);

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
    ? { digest: frozen.digest, frozenAt: frozen.frozenAt, manifest: W.manifest ?? {}, markdown: frozen.markdown, original: undefined as string | undefined }
    : pkg;

  const metaFor = (woId: string, isWoFrozen: boolean) =>
    isWoFrozen
      ? FIXTURE.frozenPackages[woId]?.digest ?? frozen?.digest ?? "frozen"
      : "needs a brief";

  const includedCount = FIXTURE.proposals.filter((p) => Boolean(include[p.id])).length;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="Brief"
        description={
          <>
            One work order has no frozen package. Include or exclude the rows the retrieval proposed;
            the freeze computes the digest and locks the rows; dispatch is a separate button — freeze
            does not dispatch. Neither button fetches on this station. The rendered brief is
            read-only — nothing inside it is a control.
          </>
        }
        actions={
          <Button
            variant="solid"
            tone="accent"
            onClick={() => setConfirmFreezeOpen(true)}
            disabled={isFrozen || includedCount === 0}
          >
            Freeze the brief
          </Button>
        }
      />
      <div className={styles.grid}>
        <WorkOrderListCard
          workOrders={FIXTURE.workOrders}
          unfrozenIds={unfrozenIds}
          frozenIds={frozenIds}
          selectedId={sel}
          metaFor={metaFor}
          onSelect={setBriefWo}
        />
        <div className={styles.stack}>
          {!isFrozen || !shown ? (
            <>
              <BriefManifestCard woId={sel} manifest={W.manifest} />
              <ProposalTableCard
                proposals={FIXTURE.proposals}
                include={include}
                locked={false}
                onToggle={(proposalId) =>
                  setInclude((s) => ({ ...s, [proposalId]: !s[proposalId] }))
                }
              />
            </>
          ) : (
            <>
              {fresh ? (
                <ProposalTableCard
                  proposals={FIXTURE.proposals}
                  include={include}
                  locked
                  headerNote={`locked · ${shown.digest}`}
                  onToggle={() => undefined}
                />
              ) : null}
              <FrozenBriefCard
                digest={shown.digest}
                frozenAt={shown.frozenAt}
                original={shown.original}
                manifest={shown.manifest}
                markdown={shown.markdown}
                fresh={Boolean(fresh)}
                dispatched={dispatchedWo === sel}
                onDispatch={dispatch}
              />
            </>
          )}
        </div>
      </div>
      <AlertBox
        open={confirmFreezeOpen}
        tone="accent"
        title={`Freeze the brief for ${sel}`}
        meta={`${includedCount} of ${FIXTURE.proposals.length} rows included`}
        confirmLabel="Freeze the brief"
        cancelLabel="Cancel"
        confirmDisabled={includedCount === 0}
        onCancel={() => setConfirmFreezeOpen(false)}
        onConfirm={() => {
          setConfirmFreezeOpen(false);
          freeze();
        }}
      >
        Freeze is its own step. Dispatch follows separately as a second button. Neither button
        fetches on this station: the live freeze route is not here, and the pending include and
        exclude choices above are client state until a freeze writes a digest.
      </AlertBox>
    </div>
  );
}
