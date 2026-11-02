// Implemented for lane WB4a — import of one validated plan sidecar revision.
/**
 * ImportLanePlanUseCase: import one validated sidecar revision per
 * (projectId, planId) (work-board plan §3.2). Recording is import, not
 * dispatch: it authorizes nothing. The requested project must equal the
 * sidecar's project; a revision must be greater than the stored one (same
 * revision + same digest is a no-op, anything else is stale); the graph of
 * every stored plan plus the incoming file is checked for a cycle; a lane
 * removed from the sidecar stays as `dropped`, never deleted. Every refusal
 * returns immediately and writes nothing.
 */

import type {
  LanePlanRecord,
  LanePlanSidecar,
  PlannedLaneRecord,
  PlannedLaneRef,
} from '../../domain/lane-plan-records.js';
import { parseLanePlanSidecar } from '../../domain/lane-plan-sidecar.js';
import { LanePlan } from '../../domain/entities/LanePlan.js';
import type { LanePlanGraphPlan } from '../../domain/lane-plan-graph.js';
import { findLanePlanCycle, formatLanePlanCycle } from '../../domain/lane-plan-graph.js';
import type {
  ImportLanePlanPort,
  ImportLanePlanRequest,
  ImportLanePlanRefusalCode,
  ImportLanePlanResult,
} from '../ports/in/ImportLanePlanPort.in-port.js';
import type { LanePlanRepositoryPort } from '../ports/out/LanePlanRepositoryPort.out-port.js';

export interface ImportLanePlanDependencies {
  readonly lanePlanRepo: LanePlanRepositoryPort;
  /** Infrastructure-supplied: sha256 hex of canonicalLanePlanSidecarJson (lane-plan-records.ts:125). */
  readonly computeDigest: (sidecar: LanePlanSidecar) => string;
  /** Fresh clock, read once per call, before the record is built. */
  readonly nowIso: () => string;
}

function refusal(code: ImportLanePlanRefusalCode, reason: string): ImportLanePlanResult {
  return { outcome: 'refused', code, reason };
}

function staleRevision(): ImportLanePlanResult {
  return refusal('stale-revision', 'import refused: revision is not greater than the stored revision');
}

/** The graph plan of a stored record: stored lanes carry their aliases. */
function lanePlanGraphPlanFromRecord(record: LanePlanRecord): LanePlanGraphPlan {
  return {
    projectId: record.projectId,
    planId: record.planId,
    lanes: record.lanes.map((lane) => ({
      laneId: lane.laneId,
      aliases: lane.aliases,
      after: lane.after,
    })),
    exclusiveOrder: record.exclusiveOrder,
  };
}

/** The graph plan of the incoming sidecar: sidecar lanes carry renamedFrom. */
function lanePlanGraphPlanFromSidecar(sidecar: LanePlanSidecar): LanePlanGraphPlan {
  return {
    projectId: sidecar.projectId,
    planId: sidecar.planId,
    lanes: sidecar.lanes.map((lane) => ({
      laneId: lane.laneId,
      renamedFrom: lane.renamedFrom,
      after: lane.after,
    })),
    exclusiveOrder: sidecar.exclusiveOrder,
  };
}

/** Stored lanes no incoming lane names (neither laneId nor renamedFrom), re-stamped dropped, sorted by laneId. */
function droppedLanesFrom(stored: LanePlanRecord, sidecar: LanePlanSidecar): PlannedLaneRecord[] {
  const incomingNames = new Set<string>();
  for (const lane of sidecar.lanes) {
    incomingNames.add(lane.laneId);
    if (lane.renamedFrom !== null) {
      incomingNames.add(lane.renamedFrom);
    }
  }
  return stored.lanes
    .filter((lane) => !incomingNames.has(lane.laneId))
    .map((lane) => ({ ...lane, status: 'dropped' as const }))
    .sort((a, b) => a.laneId.localeCompare(b.laneId));
}

export class ImportLanePlanUseCase implements ImportLanePlanPort {
  constructor(private readonly deps: ImportLanePlanDependencies) {}

  async importLanePlan(request: ImportLanePlanRequest): Promise<ImportLanePlanResult> {
    const requestedProject = request.requestedProjectId;
    if (typeof requestedProject !== 'string' || requestedProject.trim().length === 0) {
      return refusal('request', 'requestedProjectId must be a non-empty string');
    }
    const parsed = parseLanePlanSidecar(request.sidecar);
    if (!parsed.ok) {
      return refusal('sidecar-invalid', parsed.errors.join('; '));
    }
    const sidecar = parsed.sidecar;
    if (sidecar.projectId !== requestedProject.trim()) {
      return refusal('project-mismatch', 'requested project does not match the sidecar project');
    }

    const { projectId, planId } = sidecar;
    const stored = await this.deps.lanePlanRepo.findLanePlan(projectId, planId);
    const digest = this.deps.computeDigest(sidecar);
    if (stored !== null && sidecar.revision < stored.revision) {
      return staleRevision();
    }
    if (stored !== null && sidecar.revision === stored.revision) {
      return digest === stored.digest
        ? { outcome: 'unchanged', plan: stored }
        : staleRevision();
    }

    const cycle = await this.findCycle(sidecar, projectId, planId);
    if (cycle !== null) {
      return refusal('plan-cycle', formatLanePlanCycle(cycle));
    }

    const importedAtIso = this.deps.nowIso();
    const built = LanePlan.fromSidecar(sidecar, { digest, importedAtIso });
    if (!built.success) {
      return refusal('sidecar-invalid', 'sidecar could not be built into a plan record');
    }
    let record = built.value.toRecord();
    if (stored !== null && sidecar.revision > stored.revision) {
      const merged: LanePlanRecord = {
        ...record,
        lanes: [...record.lanes, ...droppedLanesFrom(stored, sidecar)],
      };
      const revalidated = LanePlan.create(merged);
      if (!revalidated.success) {
        return refusal('sidecar-invalid', 'merged plan record failed validation');
      }
      record = revalidated.value.toRecord();
    }

    try {
      await this.deps.lanePlanRepo.saveLanePlan(record);
    } catch {
      return refusal('store', 'the store refused the save');
    }
    return { outcome: 'imported', plan: record, digest };
  }

  /** Every stored plan plus the incoming sidecar, excluding the stored self being replaced. */
  private async findCycle(
    sidecar: LanePlanSidecar,
    projectId: string,
    planId: string,
  ): Promise<readonly PlannedLaneRef[] | null> {
    const plans: LanePlanGraphPlan[] = [];
    const storedPlans = await this.deps.lanePlanRepo.listLanePlans();
    for (const storedPlan of storedPlans) {
      if (storedPlan.projectId === projectId && storedPlan.planId === planId) {
        continue;
      }
      plans.push(lanePlanGraphPlanFromRecord(storedPlan));
    }
    plans.push(lanePlanGraphPlanFromSidecar(sidecar));
    return findLanePlanCycle(plans);
  }
}
