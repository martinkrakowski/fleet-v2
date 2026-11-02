// Implemented for migration step 2 — registration only, no dispatch authority.
/**
 * RegisterWorkOrderUseCase: record one approved bounded work unit with its
 * base commit, owned paths, policy revision and prerequisites. Recording is
 * registration, not dispatch: invalid input, duplicate identities, conflicting
 * path ownership on active work orders and missing prerequisites are rejected
 * explicitly and authorize nothing. The risk label is recorded at registration
 * (absent = high) and is never changed afterwards.
 */

import {
  DEFAULT_WORK_ORDER_RISK,
  parseWorkOrderRisk,
} from '../../domain/execution-records.js';
import type { PlanRef, WorkOrderRecord } from '../../domain/execution-records.js';
import type { BaseBranchValue } from '../../domain/base-branch.js';
import {
  DEFAULT_BASE_BRANCH,
  parseBaseBranch,
} from '../../domain/base-branch.js';
import type {
  RegisterWorkOrderPort,
  RegisterWorkOrderRequest,
  RegisterWorkOrderResult,
} from '../ports/in/RegisterWorkOrderPort.in-port.js';
import type { LanePlanRepositoryPort } from '../ports/out/LanePlanRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

export interface RegisterWorkOrderDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  /**
   * When present, a new work order requires an active profile for its
   * projectId (decision D4). Both composition roots pass it; it stays
   * optional only for unit tests that exercise the work-order rules alone.
   */
  readonly profileRead?: ProjectProfileReadPort;
  /**
   * When present, an optional plan link is verified against the lane-plan
   * store: the plan must exist and name the lane (current id or alias).
   * It stays optional for unit tests that exercise the work-order rules
   * alone.
   */
  readonly lanePlanRepo?: LanePlanRepositoryPort;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Terminal work orders no longer claim their paths against new lanes. */
function isActiveWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state !== 'merged' && state !== 'stopped';
}

/** Exact match, or one path nested underneath the other. */
function pathsOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The payload's base branch: `main` when the key is absent, the parsed string
 * when it parses, and a rejection otherwise (CB1). The value is stored on the
 * record every time, including the default.
 */
type RegisteredBaseBranch =
  | { readonly accepted: true; readonly value: BaseBranchValue }
  | { readonly accepted: false };

function registeredBaseBranch(request: RegisterWorkOrderRequest): RegisteredBaseBranch {
  // An explicit `undefined` (a CLI flag omitted via `optStr`) is absent, the
  // same as a missing key.
  if (request.baseBranch === undefined) {
    return { accepted: true, value: DEFAULT_BASE_BRANCH };
  }
  const parsed = parseBaseBranch(request.baseBranch);
  if (parsed === undefined) {
    return { accepted: false };
  }
  return { accepted: true, value: parsed };
}

export class RegisterWorkOrderUseCase implements RegisterWorkOrderPort {
  constructor(private readonly deps?: RegisterWorkOrderDependencies) {}

  async registerWorkOrder(request: RegisterWorkOrderRequest): Promise<RegisterWorkOrderResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }

    const requiredFields: readonly (keyof RegisterWorkOrderRequest)[] = [
      'workOrderId',
      'projectId',
      'taskId',
      'laneId',
      'repository',
      'baseCommit',
      'policyRevision',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'rejected', reason: `Missing required work order fields: ${missingFields.join(', ')}` };
    }
    if (!Array.isArray(request.ownedPaths) || request.ownedPaths.length === 0) {
      return { outcome: 'rejected', reason: 'Work order must own at least one path' };
    }
    if (request.ownedPaths.some((path) => !isNonEmpty(path))) {
      return { outcome: 'rejected', reason: 'Work order owned paths must be non-empty strings' };
    }

    // Plan A5: an absent label is high risk; any other value is refused, never guessed.
    const risk =
      request.risk === undefined ? DEFAULT_WORK_ORDER_RISK : parseWorkOrderRisk(request.risk);
    if (risk === undefined) {
      return { outcome: 'rejected', reason: "Work order risk must be 'standard' or 'high'" };
    }

    // CB1: the base branch is decided before any store access; an unparsable
    // value is rejected with its reason code and nothing is written.
    const baseBranchDecision = registeredBaseBranch(request);
    if (!baseBranchDecision.accepted) {
      return { outcome: 'rejected', reason: 'invalid-base-branch' };
    }

    // One trimmed id for the profile check, the conflict listing and the save.
    const projectId = request.projectId.trim();

    // The optional plan link (WB4a) is decided before any later store access:
    // both fields or neither, the caller's planProjectId — when present — must
    // equal the work order's own project, and a configured lane-plan repo
    // verifies the plan and lane exist. A refusal writes nothing.
    const planLink = await this.resolvePlanLink(request, projectId);
    if (!planLink.ok) {
      return { outcome: 'rejected', reason: planLink.reason };
    }

    if (this.deps.profileRead) {
      const profile = await this.deps.profileRead.readProjectProfile(projectId);
      if (profile === null) {
        return {
          outcome: 'rejected',
          reason: `project ${projectId} has no profile; register it with 'fleet-v2 projects add', or 'fleet-v2 projects adopt' when it already has work orders`,
        };
      }
      if (profile.status !== 'active') {
        return {
          outcome: 'rejected',
          reason: `project ${projectId} is retired; it accepts no new work orders — register the work under a new project id`,
        };
      }
    }

    const existingById = await this.deps.workOrderRepo.findWorkOrderById(request.workOrderId);
    if (existingById !== null) {
      return { outcome: 'rejected', reason: `Work order already registered: ${request.workOrderId}` };
    }

    const existing = await this.deps.workOrderRepo.listWorkOrdersByProject(projectId);

    // Lineage (WO-1): a new work order may name the terminal work order it supersedes. Validated
    // after the duplicate-id check and the project listing, before the path-overlap loop; the
    // listing above is the full candidate set for the "already superseded" scan because a
    // successor is always in its parent's project.
    if (request.supersedesWorkOrderId !== undefined) {
      const supersededId =
        typeof request.supersedesWorkOrderId === 'string'
          ? request.supersedesWorkOrderId.trim()
          : '';
      if (supersededId === '') {
        return {
          outcome: 'rejected',
          reason: 'supersedesWorkOrderId must be a non-empty string',
        };
      }
      if (supersededId === request.workOrderId.trim()) {
        return { outcome: 'rejected', reason: 'A work order cannot supersede itself' };
      }
      const superseded = await this.deps.workOrderRepo.findWorkOrderById(supersededId);
      if (superseded === null) {
        return {
          outcome: 'rejected',
          reason: `Superseded work order not found: ${supersededId}`,
        };
      }
      if (superseded.projectId !== projectId) {
        return {
          outcome: 'rejected',
          reason: `Superseded work order is in another project: ${supersededId}`,
        };
      }
      if (superseded.state !== 'stopped' && superseded.state !== 'merged') {
        return {
          outcome: 'rejected',
          reason: `Superseded work order is not terminal: ${supersededId} (${superseded.state})`,
        };
      }
      const priorSuccessor = existing.find(
        (order) => order.supersedesWorkOrderId === supersededId,
      );
      if (priorSuccessor !== undefined) {
        return {
          outcome: 'rejected',
          reason: `Work order ${supersededId} is already superseded by ${priorSuccessor.id}`,
        };
      }
    }

    for (const order of existing) {
      if (!isActiveWorkOrder(order.state)) {
        continue;
      }
      const conflictingPath = order.ownedPaths.find((owned) =>
        request.ownedPaths.some((path) => pathsOverlap(path, owned)),
      );
      if (conflictingPath !== undefined) {
        return {
          outcome: 'rejected',
          reason: `Owned path conflicts with active work order ${order.id}: ${conflictingPath}`,
        };
      }
    }

    const prerequisites = request.prerequisiteWorkOrderIds ?? [];
    for (const prerequisiteId of prerequisites) {
      const prerequisite = await this.deps.workOrderRepo.findWorkOrderById(prerequisiteId);
      if (!prerequisite) {
        return { outcome: 'rejected', reason: `Missing prerequisite work order: ${prerequisiteId}` };
      }
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    const record: WorkOrderRecord = {
      id: request.workOrderId,
      projectId,
      taskId: request.taskId,
      laneId: request.laneId,
      repository: request.repository,
      baseCommit: request.baseCommit,
      ownedPaths: [...request.ownedPaths],
      policyRevision: request.policyRevision,
      risk,
      baseBranch: baseBranchDecision.value,
      prerequisiteWorkOrderIds: [...prerequisites],
      ...(planLink.planRef !== undefined ? { planRef: planLink.planRef } : {}),
      ...(request.supersedesWorkOrderId !== undefined
        ? { supersedesWorkOrderId: request.supersedesWorkOrderId.trim() }
        : {}),
      state: 'approved',
      revision: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    await this.deps.workOrderRepo.saveWorkOrder(record);
    return { outcome: 'registered', workOrder: record };
  }

  /**
   * The optional plan link (WB4a): absent fields keep the record planRef-less
   * exactly as today; both fields must be present and non-empty; `planProjectId`
   * must equal the work order's own project; a configured lane-plan repo
   * verifies the plan exists and names the lane (current id or alias).
   */
  private async resolvePlanLink(
    request: RegisterWorkOrderRequest,
    projectId: string,
  ): Promise<
    | { readonly ok: true; readonly planRef?: PlanRef }
    | { readonly ok: false; readonly reason: string }
  > {
    if (request.planId === undefined && request.planLaneId === undefined) {
      return { ok: true };
    }
    const planId = typeof request.planId === 'string' ? request.planId.trim() : '';
    const laneId = typeof request.planLaneId === 'string' ? request.planLaneId.trim() : '';
    if (planId === '' || laneId === '') {
      return { ok: false, reason: 'plan-ref-incomplete' };
    }
    if (request.planProjectId !== undefined && request.planProjectId.trim() !== projectId) {
      return { ok: false, reason: 'plan-project-mismatch' };
    }
    const lanePlanRepo = this.deps?.lanePlanRepo;
    if (lanePlanRepo !== undefined) {
      const plan = await lanePlanRepo.findLanePlan(projectId, planId);
      if (plan === null) {
        return { ok: false, reason: 'plan-not-found' };
      }
      const lane = plan.lanes.find(
        (candidate) => candidate.laneId === laneId || candidate.aliases.includes(laneId),
      );
      if (lane === undefined) {
        return { ok: false, reason: 'lane-not-found' };
      }
    }
    return { ok: true, planRef: { projectId, planId, laneId } };
  }

  async execute(input?: unknown): Promise<RegisterWorkOrderResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    return this.registerWorkOrder(input as RegisterWorkOrderRequest);
  }
}
