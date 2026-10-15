"use client";

import {
  Badge,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  RouteChip,
  Switch,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@fleet/ui";
import type { ProposalFixture } from "../fixture";
import styles from "../brief.module.css";

const FREEZE_ROUTE_NOTE = "gap · the live freeze route is not on this station";

const badgeKind = (kind: ProposalFixture["kind"]) =>
  kind === "keeper" ? "keeper" : kind === "candidate" ? "candidate" : "candidate";

export interface ProposalTableCardProps {
  proposals: ProposalFixture[];
  include: Record<string, boolean>;
  locked: boolean;
  headerNote?: string;
  onToggle: (proposalId: string) => void;
}

export function ProposalTableCard({
  proposals,
  include,
  locked,
  headerNote,
  onToggle,
}: ProposalTableCardProps) {
  const includedCount = proposals.filter((p) => Boolean(include[p.id])).length;

  return (
    <Card>
      <CardHeader
        title={locked ? "Rows as frozen" : "Rows the retrieval proposed"}
        subtitle={headerNote}
        actions={
          locked ? null : (
            <>
              <RouteChip>POST /v1/knowledge/proposals</RouteChip>
              <span className={styles.sum}>
                {includedCount} of {proposals.length} included
              </span>
            </>
          )
        }
      />
      <CardBody flush>
        <TableContainer>
          <Table>
            <Thead>
              <Tr>
                <Th align="center">{locked ? "row" : "include"}</Th>
                <Th mono>entry</Th>
                <Th>kind</Th>
                <Th>claim</Th>
                <Th>scope</Th>
                <Th mono>source</Th>
                <Th>matched because</Th>
              </Tr>
            </Thead>
            <Tbody>
              {proposals.map((p) => {
                const included = Boolean(include[p.id]);
                return (
                  <Tr key={p.id} className={included ? undefined : styles.rowExcluded}>
                    <Td align="center">
                      {locked ? (
                        <span
                          className={[styles.lockStamp, included ? styles.lockIn : styles.lockOut]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {included ? "included" : "excluded"}
                        </span>
                      ) : (
                        <Switch
                          checked={included}
                          onChange={() => onToggle(p.id)}
                          label={`Include ${p.id}`}
                        />
                      )}
                    </Td>
                    <Td mono>
                      {p.id} {p.v}
                    </Td>
                    <Td>
                      <Badge kind={badgeKind(p.kind)}>{p.kind}</Badge>
                    </Td>
                    <Td className={styles.claimCell}>
                      <span className={styles.claimText}>{p.claim}</span>
                    </Td>
                    <Td mono>{p.scope}</Td>
                    <Td mono>{p.source}</Td>
                    <Td className={styles.whyCell}>
                      {p.why.map(([k, v]) => (
                        <Chip key={k} mono>
                          {k} · {v}
                        </Chip>
                      ))}
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </TableContainer>
      </CardBody>
      {locked ? null : (
        <CardFooter>
          <div className={styles.freezeBar}>
            <span className={styles.sum}>
              {includedCount} of {proposals.length} rows included · freeze computes the digest ·
              nothing changes after
            </span>
            <RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
