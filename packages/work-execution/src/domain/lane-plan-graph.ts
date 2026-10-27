/**
 * The cross-plan dependency check of work-board plan §3.2: nodes are lanes,
 * an edge runs from a lane to each lane it waits on (`after`, and the
 * previous lane of each `exclusiveOrder` entry); a reference whose plan or
 * lane is not in the set is unresolved and adds no edge (it computes as
 * `after-unresolved` on the board, and is checked again when its plan
 * arrives). Iterative depth-first search with an explicit stack (never
 * recursive); returns the first cycle found in dependency order, or null.
 */

import type { PlannedLaneRef } from './lane-plan-records.js';

export interface LanePlanGraphLane {
  readonly laneId: string;
  /** Former ids (a stored LanePlanRecord's lanes). */
  readonly aliases?: readonly string[];
  /** A sidecar lane's former id. */
  readonly renamedFrom?: string | null;
  readonly after: readonly PlannedLaneRef[];
}

export interface LanePlanGraphPlan {
  readonly projectId: string;
  readonly planId: string;
  readonly lanes: readonly LanePlanGraphLane[];
  readonly exclusiveOrder?: readonly { readonly lanes: readonly string[] }[];
}

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

type PlanKey = string;
type NodeKey = string;

interface DfsFrame {
  readonly node: NodeKey;
  readonly neighbors: readonly NodeKey[];
  index: number;
}

/** The first cycle found, as lane references in dependency order, or null. Never throws. */
export function findLanePlanCycle(plans: readonly LanePlanGraphPlan[]): readonly PlannedLaneRef[] | null {
  try {
    return findLanePlanCycleUnchecked(plans);
  } catch {
    return null;
  }
}

function findLanePlanCycleUnchecked(
  plans: readonly LanePlanGraphPlan[],
): readonly PlannedLaneRef[] | null {
  const planByKey = new Map<PlanKey, LanePlanGraphPlan>();
  for (const plan of plans) {
    planByKey.set(`${plan.projectId}/${plan.planId}`, plan);
  }

  // Visit plans in ascending key order (code-unit compare; keys are unique after dedup).
  const sortedKeys = [...planByKey.keys()].sort((a, b) => (a < b ? -1 : 1));
  const adjacency = buildAdjacency(sortedKeys, planByKey);

  const color = new Map<NodeKey, number>();
  const path: NodeKey[] = [];
  const frames: DfsFrame[] = [];

  for (const planKey of sortedKeys) {
    const plan = planByKey.get(planKey) as LanePlanGraphPlan;
    for (const lane of plan.lanes) {
      const start = `${planKey}/${lane.laneId}`;
      const startColor = color.get(start);
      if (startColor !== undefined && startColor !== WHITE) {
        continue;
      }
      color.set(start, GREY);
      path.push(start);
      frames.push({ node: start, neighbors: adjacency.get(start) ?? [], index: 0 });
      while (frames.length > 0) {
        const top = frames[frames.length - 1] as DfsFrame;
        if (top.index < top.neighbors.length) {
          const next = top.neighbors[top.index];
          top.index += 1;
          const nextColor = color.get(next);
          if (nextColor === undefined || nextColor === WHITE) {
            color.set(next, GREY);
            path.push(next);
            frames.push({ node: next, neighbors: adjacency.get(next) ?? [], index: 0 });
          } else if (nextColor === GREY) {
            return cycleForPath(path, next);
          }
        } else {
          color.set(top.node, BLACK);
          path.pop();
          frames.pop();
        }
      }
    }
  }

  return null;
}

function buildAdjacency(
  sortedKeys: readonly PlanKey[],
  planByKey: ReadonlyMap<PlanKey, LanePlanGraphPlan>,
): Map<NodeKey, readonly NodeKey[]> {
  const adjacency = new Map<NodeKey, NodeKey[]>();
  for (const planKey of sortedKeys) {
    const plan = planByKey.get(planKey) as LanePlanGraphPlan;
    const resolved = resolveLaneIds(plan);
    const exclusiveEdges = collectExclusiveEdges(plan, resolved);
    for (const lane of plan.lanes) {
      const source = `${planKey}/${lane.laneId}`;
      const edges: NodeKey[] = [];
      for (const ref of lane.after) {
        const targetPlanKey = `${ref.projectId}/${ref.planId}`;
        const targetPlan = planByKey.get(targetPlanKey);
        if (targetPlan === undefined) {
          continue;
        }
        const targetLaneId = resolveLaneIds(targetPlan).get(ref.laneId);
        if (targetLaneId === undefined) {
          continue;
        }
        edges.push(`${targetPlanKey}/${targetLaneId}`);
      }
      const fromExclusive = exclusiveEdges.get(source);
      if (fromExclusive !== undefined) {
        for (const target of fromExclusive) {
          edges.push(target);
        }
      }
      adjacency.set(source, edges);
    }
  }
  return adjacency;
}

function resolveLaneIds(plan: LanePlanGraphPlan): Map<string, string> {
  const current = new Set<string>();
  for (const lane of plan.lanes) {
    current.add(lane.laneId);
  }
  const resolved = new Map<string, string>();
  for (const lane of plan.lanes) {
    resolved.set(lane.laneId, lane.laneId);
    const aliases = lane.aliases;
    if (aliases !== undefined) {
      for (const alias of aliases) {
        if (!current.has(alias)) {
          resolved.set(alias, lane.laneId);
        }
      }
    }
    const renamedFrom = lane.renamedFrom;
    if (renamedFrom !== undefined && renamedFrom !== null && !current.has(renamedFrom)) {
      resolved.set(renamedFrom, lane.laneId);
    }
  }
  return resolved;
}

function collectExclusiveEdges(
  plan: LanePlanGraphPlan,
  resolved: ReadonlyMap<string, string>,
): Map<NodeKey, NodeKey[]> {
  const map = new Map<NodeKey, NodeKey[]>();
  for (const entry of plan.exclusiveOrder ?? []) {
    for (let k = 1; k < entry.lanes.length; k += 1) {
      const fromResolved = resolved.get(entry.lanes[k]);
      const toResolved = resolved.get(entry.lanes[k - 1]);
      if (fromResolved === undefined || toResolved === undefined) {
        continue;
      }
      const fromKey = `${plan.projectId}/${plan.planId}/${fromResolved}`;
      const toKey = `${plan.projectId}/${plan.planId}/${toResolved}`;
      const targets = map.get(fromKey);
      if (targets === undefined) {
        map.set(fromKey, [toKey]);
      } else {
        targets.push(toKey);
      }
    }
  }
  return map;
}

function cycleForPath(path: readonly NodeKey[], greyNode: NodeKey): readonly PlannedLaneRef[] {
  return path.slice(path.indexOf(greyNode)).map((nodeKey) => nodeKeyToRef(nodeKey));
}

function nodeKeyToRef(nodeKey: NodeKey): PlannedLaneRef {
  const parts = nodeKey.split('/');
  return { projectId: parts[0], planId: parts[1], laneId: parts[2] };
}

/** `p/plan/A -> p/plan/B -> p/plan/A`: ids only, safe to print in a refusal. */
export function formatLanePlanCycle(cycle: readonly PlannedLaneRef[]): string {
  if (cycle.length === 0) {
    return '';
  }
  const rendered = cycle.map((ref) => `${ref.projectId}/${ref.planId}/${ref.laneId}`);
  return [...rendered, rendered[0]].join(' -> ');
}
