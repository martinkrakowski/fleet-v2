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

function validateRequest(
  request: ImportLanePlanRequest,
): { ok: true; sidecar: LanePlanSidecar } | { ok: false; result: ImportLanePlanResult } {
  const requestedProject = request.requestedProjectId;
  if (typeof requestedProject !== 'string' || requestedProject.trim().length === 0) {
    return { ok: false, result: refusal('request', 'requestedProjectId must be a non-empty string') };
  }
  const parsed = parseLanePlanSidecar(request.sidecar);
  if (!parsed.ok) {
    return { ok: false, result: refusal('sidecar-invalid', parsed.errors.join('; ')) };
  }
  const sidecar = parsed.sidecar;
  if (sidecar.projectId !== requestedProject.trim()) {
    return { ok: false, result: refusal('project-mismatch', 'requested project does not match the sidecar project') };
  }
  return { ok: true, sidecar };
}

function checkRevision(
  sidecar: LanePlanSidecar,
  stored: LanePlanRecord | null,
  digest: string,
): ImportLanePlanResult | null {
  if (stored === null) {
    return null;
  }
  if (sidecar.revision < stored.revision) {
    return staleRevision();
  }
  if (sidecar.revision === stored.revision) {
    if (digest === stored.digest) {
      return { outcome: 'unchanged', plan: stored };
    }
    return staleRevision();
  }
  return null;
}

function buildCandidateRecord(
  sidecar: LanePlanSidecar,
  stored: LanePlanRecord | null,
  meta: { digest: string; importedAtIso: string },
): { ok: true; record: LanePlanRecord } | { ok: false; result: ImportLanePlanResult } {
  const built = LanePlan.fromSidecar(sidecar, meta);
  if (!built.success) {
    return { ok: false, result: refusal('sidecar-invalid', 'sidecar could not be built into a plan record') };
  }
  const baseRecord = built.value.toRecord();
  if (stored === null || sidecar.revision <= stored.revision) {
    return { ok: true, record: baseRecord };
  }
  const merged: LanePlanRecord = {
    ...baseRecord,
    lanes: [...baseRecord.lanes, ...droppedLanesFrom(stored, sidecar)],
  };
  const revalidated = LanePlan.create(merged);
  if (!revalidated.success) {
    return { ok: false, result: refusal('sidecar-invalid', 'merged plan record failed validation') };
  }
  return { ok: true, record: revalidated.value.toRecord() };
}

export class ImportLanePlanUseCase implements ImportLanePlanPort {
  constructor(private readonly deps: ImportLanePlanDependencies) {}

  async importLanePlan(request: ImportLanePlanRequest): Promise<ImportLanePlanResult> {
    const validated = validateRequest(request);
    if (!validated.ok) {
      return validated.result;
    }
    const sidecar = validated.sidecar;
    const { projectId, planId } = sidecar;

    let stored: LanePlanRecord | null;
    try {
      stored = await this.deps.lanePlanRepo.findLanePlan(projectId, planId);
    } catch {
      return refusal('store', 'the store could not be read');
    }

    const digest = this.deps.computeDigest(sidecar);

    const revisionCheck = checkRevision(sidecar, stored, digest);
    if (revisionCheck !== null) {
      return revisionCheck;
    }

    const candidate = buildCandidateRecord(sidecar, stored, {
      digest,
      importedAtIso: this.deps.nowIso(),
    });
    if (!candidate.ok) {
      return candidate.result;
    }

    return this.persistCandidate(candidate.record, digest);
  }

  private async persistCandidate(
    candidate: LanePlanRecord,
    digest: string,
  ): Promise<ImportLanePlanResult> {
    try {
      if (typeof this.deps.lanePlanRepo.saveLanePlanIfAcyclic === 'function') {
        const saveResult = await this.deps.lanePlanRepo.saveLanePlanIfAcyclic(candidate);
        if (saveResult.outcome === 'cycle') {
          return refusal('plan-cycle', formatLanePlanCycle(saveResult.cycle));
        }
      } else {
        const cycle = await this.findCycle(candidate);
        if (cycle !== null) {
          return refusal('plan-cycle', formatLanePlanCycle(cycle));
        }
        await this.deps.lanePlanRepo.saveLanePlan(candidate);
      }
    } catch {
      return refusal('store', 'the store refused the save');
    }
    return { outcome: 'imported', plan: candidate, digest };
  }

  /** Every stored plan plus the incoming candidate record, excluding the stored self being replaced. */
  private async findCycle(
    candidate: LanePlanRecord,
  ): Promise<readonly PlannedLaneRef[] | null> {
    const plans: LanePlanGraphPlan[] = [];
    const storedPlans = await this.deps.lanePlanRepo.listLanePlans();
    for (const storedPlan of storedPlans) {
      if (storedPlan.projectId === candidate.projectId && storedPlan.planId === candidate.planId) {
        continue;
      }
      plans.push(lanePlanGraphPlanFromRecord(storedPlan));
    }
    plans.push(lanePlanGraphPlanFromRecord(candidate));
    return findLanePlanCycle(plans);
  }
}
