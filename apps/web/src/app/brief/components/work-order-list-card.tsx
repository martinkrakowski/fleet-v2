"use client";

import { Card, CardBody, CardHeader } from "@fleet/ui";
import type { WorkOrderFixture } from "../fixture";
import styles from "../brief.module.css";

export interface WorkOrderListCardProps {
  workOrders: Record<string, WorkOrderFixture>;
  unfrozenIds: string[];
  frozenIds: string[];
  selectedId: string;
  metaFor: (woId: string, isFrozen: boolean) => string;
  onSelect: (woId: string) => void;
}

function WorkOrderItem({
  woId,
  wo,
  isFrozen,
  isSelected,
  meta,
  onSelect,
}: {
  woId: string;
  wo: WorkOrderFixture;
  isFrozen: boolean;
  isSelected: boolean;
  meta: string;
  onSelect: (woId: string) => void;
}) {
  return (
    <button
      type="button"
      className={[styles.woItem, isFrozen ? "" : styles.needs]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onSelect(woId)}
      aria-current={isSelected}
    >
      <span className={styles.woTitle}>{wo.task}</span>
      <span className={styles.woMeta}>
        {woId} · {wo.lane} · {meta}
      </span>
    </button>
  );
}

export function WorkOrderListCard({
  workOrders,
  unfrozenIds,
  frozenIds,
  selectedId,
  metaFor,
  onSelect,
}: WorkOrderListCardProps) {
  return (
    <Card aria-label="Work orders">
      <CardHeader title="Work orders" subtitle={`${unfrozenIds.length} need a brief`} />
      <CardBody>
        {unfrozenIds.map((woId) => (
          <WorkOrderItem
            key={woId}
            woId={woId}
            wo={workOrders[woId]}
            isFrozen={false}
            isSelected={selectedId === woId}
            meta={metaFor(woId, false)}
            onSelect={onSelect}
          />
        ))}
        {frozenIds.length > 0 ? <div className={styles.listHead}>frozen packages</div> : null}
        {frozenIds.map((woId) => (
          <WorkOrderItem
            key={woId}
            woId={woId}
            wo={workOrders[woId]}
            isFrozen
            isSelected={selectedId === woId}
            meta={metaFor(woId, true)}
            onSelect={onSelect}
          />
        ))}
      </CardBody>
    </Card>
  );
}
