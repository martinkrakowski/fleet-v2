"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  RouteChip,
} from "@fleet/ui";
import { PROJECT, candidates, keepers } from "./fixture";
import {
  CandidateCard,
  type Disposition,
  type DispositionKind,
} from "./components/candidate-card";
import { KeepersTableCard } from "./components/keepers-table-card";
import styles from "./knowledge.module.css";

export default function KnowledgePage() {
  const [dispositions, setDispositions] = useState<
    Record<string, Disposition>
  >({});
  const project = useSearchParams().get("project") ?? PROJECT;

  const cands = candidates.filter((c) => c.project === project);
  const keeps = keepers.filter((k) =>
    k.project.split(",").map((s) => s.trim()).includes(project),
  );
  const open = cands.filter((c) => dispositions[c.id] === undefined).length;

  const onDisposition = (id: string, kind: DispositionKind) => {
    const at = new Date().toISOString().slice(11, 19) + "Z";
    setDispositions((prev) => ({ ...prev, [id]: { kind, at } }));
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Knowledge"
        description={
          <>
            Two lists. A keeper is published only from a head that carries an
            acceptance receipt; anything else stays a candidate, is rejected,
            or leaves the product as a policy proposal. Nothing on this page
            writes a policy.
          </>
        }
        actions={
          <RouteChip gap>gap · list routes are not on this station</RouteChip>
        }
      />
      <div className={styles.stack}>
        <Card>
          <CardHeader
            title="Candidates"
            subtitle={`${open} open · ${cands.length} in scope`}
          />
          <CardBody>
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
                <EmptyState
                  title="No candidates in this project scope."
                  description="That is a scope note, not “nothing running”."
                />
              )}
            </div>
          </CardBody>
        </Card>
        <KeepersTableCard keepers={keeps} />
      </div>
    </div>
  );
}