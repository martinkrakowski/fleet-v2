/**
 * The pure, serializable facts of a plan's machine workbook (work-board plan §3.2):
 * planned lanes, their dependencies, packages, shared files, decisions and serial
 * orders; ids, enums and bounded plain text only, never a credential or client
 * content; a planned lane grants nothing and owns no path until it is registered
 * as a work order.
 */

import type { PlanRef } from './execution-records.js';

export const LANE_PLAN_SIDECAR_SCHEMA_VERSION = 1 as const;

export const PLANNED_LANE_STATUSES = ['planned', 'deferred', 'dropped'] as const;
export type PlannedLaneStatus = (typeof PLANNED_LANE_STATUSES)[number];

export const PLANNED_LANE_TIERS = [0, 1, 2] as const;
export type PlannedLaneTier = (typeof PLANNED_LANE_TIERS)[number];

export const PLAN_DECISION_STATES = ['open', 'decided'] as const;
export type PlanDecisionState = (typeof PLAN_DECISION_STATES)[number];

/** Ids never contain `/`, so `<projectId>/<planId>/<laneId>` always splits back exactly. */
export const PLAN_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PLANNED_LANE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PLAN_DECISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** A workspace name (`work-execution` for packages/work-execution/, `cli` for apps/cli/) or `docs`. */
export const PLAN_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const LANE_PLAN_LIMITS = Object.freeze({
  lanes: 300,
  after: 32,
  packages: 16,
  sharedFiles: 16,
  laneDecisions: 16,
  decisions: 100,
  exclusiveOrders: 16,
  exclusiveOrderLanes: 300,
  errors: 50,
  scopeBytes: 300,
  questionBytes: 400,
  defaultBytes: 300,
  pathBytes: 256,
  repositoryBytes: 200,
});

/** A lane anywhere: every `after` form resolves to this full reference. */
export type PlannedLaneRef = PlanRef;

export interface PullRequestRef {
  readonly repository: string;
  readonly number: number;
}

export interface PlannedLaneSidecar {
  readonly laneId: string;
  readonly renamedFrom: string | null;
  readonly scope: string;
  readonly packages: readonly string[];
  readonly sharedFiles: readonly string[];
  readonly tier: PlannedLaneTier;
  readonly after: readonly PlannedLaneRef[];
  readonly decisions: readonly string[];
  readonly status: PlannedLaneStatus;
  readonly brief: string | null;
  readonly mergedPr: PullRequestRef | null;
}

export interface PlanDecisionSidecar {
  readonly id: string;
  readonly question: string;
  readonly default: string;
  readonly state: PlanDecisionState;
}

export interface ExclusiveOrderSidecar {
  readonly file: string;
  readonly lanes: readonly string[];
}

/** A validated, normalized sidecar: every default filled, every `after` resolved. */
export interface LanePlanSidecar {
  readonly schemaVersion: typeof LANE_PLAN_SIDECAR_SCHEMA_VERSION;
  readonly projectId: string;
  readonly planId: string;
  readonly revision: number;
  readonly doc: string;
  readonly lanes: readonly PlannedLaneSidecar[];
  readonly decisions: readonly PlanDecisionSidecar[];
  readonly exclusiveOrder: readonly ExclusiveOrderSidecar[];
}
