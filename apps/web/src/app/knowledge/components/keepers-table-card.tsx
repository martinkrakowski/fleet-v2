"use client";

import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@fleet/ui";
import type { Keeper } from "../fixture";
import styles from "../knowledge.module.css";

export function KeepersTableCard({ keepers }: { keepers: Keeper[] }) {
  return (
    <Card>
      <CardHeader
        title="Keepers"
        actions={
          <span className={styles.meta}>{keepers.length} in scope</span>
        }
      />
      <CardBody flush>
        <TableContainer>
          <Table>
            <Thead>
              <Tr>
                <Th mono>entry</Th>
                <Th>claim</Th>
                <Th>scope</Th>
                <Th mono>source</Th>
                <Th>checked</Th>
                <Th mono>supersedes</Th>
                <Th mono align="right">
                  reuse
                </Th>
                <Th align="right">wrong turns</Th>
              </Tr>
            </Thead>
            <Tbody>
              {keepers.map((k) => (
                <Tr key={k.id}>
                  <Td mono>
                    {k.id} {k.v}
                  </Td>
                  <Td className={styles.tdClaim}>{k.claim}</Td>
                  <Td>
                    {k.project} · {k.paths}
                  </Td>
                  <Td mono className={styles.tdSrc}>
                    {k.source}
                  </Td>
                  <Td>{k.checked}</Td>
                  <Td mono>{k.supersedes}</Td>
                  <Td mono align="right">
                    {k.used}×
                  </Td>
                  <Td align="right">
                    {k.wrongTurns ? (
                      <Badge
                        kind="failed"
                        title="wrong turns reported against this keeper"
                      >
                        {k.wrongTurns}
                      </Badge>
                    ) : (
                      <span className={styles.none}>0</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
      </CardBody>
    </Card>
  );
}