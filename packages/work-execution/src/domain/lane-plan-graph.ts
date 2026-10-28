/**
 * The cross-plan dependency check of work-board plan §3.2: nodes are lanes,
 * an edge runs from a lane to each lane it waits on (`after`, and the
 * previous lane of each `exclusiveOrder` entry); a reference whose plan or
 * lane is not in the set is unresolved and adds no edge (it computes as
 * `after-unresolved` on the board, and is checked again when its plan
 * arrives). Iterative depth-first search with an explicit stack (never
 * recursive); returns the first cycle found in dependency order, or null.
 * A malformed lane or reference is skipped locally — it adds no edge and
 * never hides a cycle among the well-formed remainder.
 *
 * An ambiguous alias (several lanes carry the former id) becomes one virtual
 * node per (plan, alias): a reference naming it adds a single edge to that
 * node, and the node carries one edge to each lane carrying the alias, built
 * once per (plan, alias). Total edges grow with references plus lanes, never
 * with their product. Virtual node keys start with a prefix no lane key can
 * have (lane ids cannot contain `:`), and a virtual node never appears in a
 * returned cycle: only lanes carry refs.
 */

import {
  PLAN_ID_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
} from './lane-plan-records.js';
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

/** No lane key can start with this: lane ids cannot contain `:`. */
const ALIAS_NODE_PREFIX = 'alias:';

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

interface GraphData {
  readonly adjacency: Map<NodeKey, readonly NodeKey[]>;
  readonly refs: Map<NodeKey, PlannedLaneRef>;
}

/** The first cycle found, as lane references in dependency order, or null. */
export function findLanePlanCycle(plans: readonly LanePlanGraphPlan[]): readonly PlannedLaneRef[] | null {
  const planByKey = new Map<PlanKey, LanePlanGraphPlan>();
  for (const plan of plans) {
    planByKey.set(`${plan.projectId}/${plan.planId}`, plan);
  }

  // Visit plans in ascending key order (code-unit compare; keys are unique after dedup).
  const sortedKeys = [...planByKey.keys()].sort((a, b) => (a < b ? -1 : 1));
  const { adjacency, refs } = buildAdjacency(sortedKeys, planByKey);

  const color = new Map<NodeKey, number>();
  const path: NodeKey[] = [];
  const frames: DfsFrame[] = [];

  for (const planKey of sortedKeys) {
    const plan = planByKey.get(planKey) as LanePlanGraphPlan;
    for (const lane of lanesOf(plan)) {
      const laneId = lane.laneId;
      if (!isString(laneId)) {
        continue;
      }
      const start = `${planKey}/${laneId}`;
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
            return cycleForPath(path, next, refs);
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
): GraphData {
  const edgeLists = new Map<NodeKey, NodeKey[]>();
  const refs = new Map<NodeKey, PlannedLaneRef>();
  // Resolved ids are computed once per plan key, never per reference.
  const resolvedByKey = new Map<PlanKey, Map<string, readonly string[]>>(
    sortedKeys.map((key) => [key, resolveLaneIds(planByKey.get(key) as LanePlanGraphPlan)]),
  );
  // Each ambiguous name gets one virtual node per plan, created on first use;
  // its edges to the lanes carrying the name are built once, never per ref.
  const aliasNodes = new Map<PlanKey, Map<string, NodeKey>>();
  const resolveTargetNode = (
    planKey: PlanKey,
    name: string,
    targetLaneIds: readonly string[],
  ): NodeKey => {
    let forPlan = aliasNodes.get(planKey);
    if (forPlan === undefined) {
      forPlan = new Map();
      aliasNodes.set(planKey, forPlan);
    }
    const existing = forPlan.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const nodeKey = `${ALIAS_NODE_PREFIX}${planKey}/${name}`;
    const targets: NodeKey[] = [];
    for (const targetLaneId of targetLaneIds) {
      targets.push(`${planKey}/${targetLaneId}`);
    }
    edgeLists.set(nodeKey, targets);
    forPlan.set(name, nodeKey);
    return nodeKey;
  };
  for (const planKey of sortedKeys) {
    const plan = planByKey.get(planKey) as LanePlanGraphPlan;
    const resolved = resolvedByKey.get(planKey) as Map<string, readonly string[]>;
    const exclusiveEdges = collectExclusiveEdges(planKey, plan, resolved, resolveTargetNode);
    for (const lane of lanesOf(plan)) {
      const laneId = lane.laneId;
      if (!isString(laneId)) {
        continue;
      }
      const source = `${planKey}/${laneId}`;
      refs.set(source, { projectId: plan.projectId, planId: plan.planId, laneId });
      // A duplicate laneId appends its edges to the existing entry. Each
      // target is deduplicated once per source when the list is frozen.
      const edges = edgeLists.get(source) ?? [];
      const afterRefs = Array.isArray(lane.after) ? lane.after : [];
      for (const candidate of afterRefs) {
        if (!isValidRef(candidate)) {
          continue;
        }
        const targetPlanKey = `${candidate.projectId}/${candidate.planId}`;
        const targetResolved = resolvedByKey.get(targetPlanKey);
        if (targetResolved === undefined) {
          continue;
        }
        const targetLaneIds = targetResolved.get(candidate.laneId);
        if (targetLaneIds === undefined) {
          continue;
        }
        if (targetLaneIds.length === 1) {
          edges.push(`${targetPlanKey}/${targetLaneIds[0] as string}`);
        } else {
          edges.push(resolveTargetNode(targetPlanKey, candidate.laneId, targetLaneIds));
        }
      }
      const fromExclusive = exclusiveEdges.get(source);
      if (fromExclusive !== undefined) {
        for (const target of fromExclusive) {
          edges.push(target);
        }
      }
      edgeLists.set(source, edges);
    }
  }
  const adjacency = new Map<NodeKey, readonly NodeKey[]>();
  for (const [node, edges] of edgeLists) {
    adjacency.set(node, edges.length > 1 ? [...new Set(edges)] : edges);
  }
  return { adjacency, refs };
}

/** Total adjacency entries across every node of the built graph. */
export function laneGraphEdgeCount(plans: readonly LanePlanGraphPlan[]): number {
  const planByKey = new Map<PlanKey, LanePlanGraphPlan>();
  for (const plan of plans) {
    planByKey.set(`${plan.projectId}/${plan.planId}`, plan);
  }
  const sortedKeys = [...planByKey.keys()].sort((a, b) => (a < b ? -1 : 1));
  const { adjacency } = buildAdjacency(sortedKeys, planByKey);
  let count = 0;
  for (const edges of adjacency.values()) {
    count += edges.length;
  }
  return count;
}

function lanesOf(plan: LanePlanGraphPlan): readonly LanePlanGraphLane[] {
  return Array.isArray(plan.lanes) ? plan.lanes : [];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isValidRef(candidate: unknown): candidate is PlannedLaneRef {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const ref = candidate as PlannedLaneRef;
  return isString(ref.projectId) && isString(ref.planId) && isString(ref.laneId);
}

/**
 * Every name usable as a dependency target maps to the current lane ids it
 * resolves to. A current lane id wins over any alias; an ambiguous alias
 * (two lanes carrying it) resolves to every lane carrying it.
 */
function resolveLaneIds(plan: LanePlanGraphPlan): Map<string, readonly string[]> {
  const lanes = lanesOf(plan);
  const current = new Set<string>();
  for (const lane of lanes) {
    if (isString(lane.laneId)) {
      current.add(lane.laneId);
    }
  }
  const resolved = new Map<string, string[]>();
  for (const laneId of current) {
    resolved.set(laneId, [laneId]);
  }
  for (const lane of lanes) {
    const laneId = lane.laneId;
    if (!isString(laneId)) {
      continue;
    }
    const aliases = lane.aliases;
    if (aliases !== undefined) {
      for (const alias of aliases) {
        if (!isString(alias) || current.has(alias)) {
          continue;
        }
        addResolution(resolved, alias, laneId);
      }
    }
    const renamedFrom = lane.renamedFrom;
    if (isString(renamedFrom) && !current.has(renamedFrom)) {
      addResolution(resolved, renamedFrom, laneId);
    }
  }
  return resolved;
}

function addResolution(resolved: Map<string, string[]>, name: string, laneId: string): void {
  const targets = resolved.get(name);
  if (targets === undefined) {
    resolved.set(name, [laneId]);
    return;
  }
  if (!targets.includes(laneId)) {
    targets.push(laneId);
  }
}

/**
 * Each lane resolving an entry's `lanes[k]` waits on the lanes resolving
 * `lanes[k - 1]`. An ambiguous target name collapses to its virtual node, so
 * the edge count grows with the from-side lanes, never with their product.
 */
function collectExclusiveEdges(
  planKey: PlanKey,
  plan: LanePlanGraphPlan,
  resolved: ReadonlyMap<string, readonly string[]>,
  resolveTargetNode: (planKey: PlanKey, name: string, targets: readonly string[]) => NodeKey,
): Map<NodeKey, NodeKey[]> {
  const map = new Map<NodeKey, NodeKey[]>();
  const entries = Array.isArray(plan.exclusiveOrder) ? plan.exclusiveOrder : [];
  for (const entry of entries) {
    const names = Array.isArray(entry.lanes) ? entry.lanes : [];
    for (let k = 1; k < names.length; k += 1) {
      const fromTargets = resolved.get(names[k]);
      const toTargets = resolved.get(names[k - 1]);
      if (fromTargets === undefined || toTargets === undefined) {
        continue;
      }
      const toNode = resolveTargetNode(planKey, names[k - 1], toTargets);
      for (const fromResolved of fromTargets) {
        const fromKey = `${planKey}/${fromResolved}`;
        const targets = map.get(fromKey) ?? [];
        targets.push(toNode);
        map.set(fromKey, targets);
      }
    }
  }
  return map;
}

function cycleForPath(
  path: readonly NodeKey[],
  greyNode: NodeKey,
  refs: ReadonlyMap<NodeKey, PlannedLaneRef>,
): readonly PlannedLaneRef[] {
  const start = path.indexOf(greyNode);
  const cycle: PlannedLaneRef[] = [];
  for (let k = start; k < path.length; k += 1) {
    const nodeKey = path[k];
    const nodeRef = refs.get(nodeKey);
    if (nodeRef !== undefined) {
      cycle.push(nodeRef);
    }
  }
  return cycle;
}

/** `p/plan/A -> p/plan/B -> p/plan/A`: ids only, safe to print in a refusal. */
export function formatLanePlanCycle(cycle: readonly PlannedLaneRef[]): string {
  if (cycle.length === 0) {
    return '';
  }
  const rendered = cycle.map(renderCycleNode);
  return [...rendered, rendered[0]].join(' -> ');
}

function renderCycleNode(ref: PlannedLaneRef): string {
  const wellFormed =
    PLAN_PROJECT_ID_PATTERN.test(ref.projectId) &&
    PLAN_ID_PATTERN.test(ref.planId) &&
    PLANNED_LANE_ID_PATTERN.test(ref.laneId);
  if (!wellFormed) {
    return '<invalid id>';
  }
  return `${ref.projectId}/${ref.planId}/${ref.laneId}`;
}