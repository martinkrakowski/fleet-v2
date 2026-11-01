"use client";

import { Fragment, useState } from "react";
import { Chip, Table, TableContainer, Tbody, Td, Th, Thead, Tr } from "@fleet/ui";
import type { ScheduleHostView, ScheduleRowView } from "../map-schedule";
import {
  packagesText,
  placementText,
  slotText,
} from "../schedule-view";
import styles from "../conductor.module.css";

function overlapChips(row: ScheduleRowView) {
  if (row.overlapsWith.length === 0) {
    return null;
  }
  return <Chip tone="warn">overlaps {row.overlapsWith.length}</Chip>;
}

function workOrderText(row: ScheduleRowView) {
  if (!row.workOrderUnreadable) {
    return null;
  }
  return <span className={styles.unreadable}>work order unreadable</span>;
}

function detailText(row: ScheduleRowView): string {
  const parts: string[] = [];
  if (row.pendingStep !== null) {
    parts.push(
      `pending step ${row.pendingStep.step} (${row.pendingStep.reconciliation})`,
    );
  }
  if (row.park !== null) {
    parts.push(`park reason ${row.park.reason} · ${row.park.qualifier}`);
  }
  if (row.leaseLapsed === true) {
    parts.push("lease lapsed");
  }
  if (row.leaseLapsed === false) {
    parts.push("lease held");
  }
  if (row.overlapsWith.length > 0) {
    parts.push(`overlaps with ${row.overlapsWith.join(", ")}`);
  }
  return parts.join(" · ");
}

function SlotList({ host }: { host: ScheduleHostView }) {
  return (
    <div className={styles.hostGroup}>
      <span className={styles.hostName}>{host.hostName}</span>
      <ul className={styles.slotList}>
        {host.slots.map((slot) => (
          <li key={slot.slotIndex} className={styles.slotItem}>
            slot {slot.slotIndex} · {slot.runId ?? "in-flight start"}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ScheduleBoard({
  visibleRows,
  hosts,
}: {
  visibleRows: readonly ScheduleRowView[];
  hosts: readonly ScheduleHostView[];
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const caption = "Live runs in creation order";

  return (
    <div>
      <TableContainer className={styles.boardWrap}>
        <Table>
          <caption>{caption}</caption>
          <Thead>
            <Tr>
              <Th>Run</Th>
              <Th>State</Th>
              <Th>Round</Th>
              <Th>Placement</Th>
              <Th>Slot</Th>
              <Th>Packages</Th>
            </Tr>
          </Thead>
          <Tbody>
            {visibleRows.map((row) => {
              const selected = selectedRunId === row.runId;
              const detail = detailText(row);
              return (
                <Fragment key={row.runId}>
                  <Tr>
                    <Td mono data-label="Run">
                      <button
                        type="button"
                        className={styles.runToggle}
                        aria-expanded={selected}
                        onClick={() =>
                          setSelectedRunId(selected ? null : row.runId)
                        }
                      >
                        {row.runId}
                      </button>
                      {overlapChips(row)}
                      {workOrderText(row)}
                    </Td>
                    <Td data-label="State">{row.state}</Td>
                    <Td data-label="Round">{row.round}</Td>
                    <Td data-label="Placement">{placementText(row)}</Td>
                    <Td mono data-label="Slot">{slotText(row)}</Td>
                    <Td mono data-label="Packages">{packagesText(row)}</Td>
                  </Tr>
                  {selected ? (
                    <Tr>
                      <Td className={styles.detailRow} colSpan={6}>
                        {detail === ""
                          ? "No pending step, park record, lease lapse or overlap recorded."
                          : detail}
                      </Td>
                    </Tr>
                  ) : null}
                </Fragment>
              );
            })}
          </Tbody>
        </Table>
      </TableContainer>
      <section className={styles.hostSection} aria-label="Host slots">
        <h2 className={styles.hostHeading}>Host slots</h2>
        {hosts.map((host) => (
          <SlotList key={host.hostName} host={host} />
        ))}
      </section>
    </div>
  );
}
