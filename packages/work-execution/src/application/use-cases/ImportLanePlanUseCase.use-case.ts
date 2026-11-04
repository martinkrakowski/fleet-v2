// Implemented for lane WB4a — import of one validated plan sidecar revision.
// hosted here: the index barrels are owned by the cutover lane; no new file until that lane merges
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
  PullRequestLinkRecord,
} from '../../domain/lane-plan-records.js';
import {
  PULL_REQUEST_LINK_RECORD_VERSION,
  PULL_REQUEST_LINK_SOURCES,
} from '../../domain/lane-plan-records.js';
import { parseLanePlanSidecar } from '../../domain/lane-plan-sidecar.js';
import { LanePlan } from '../../domain/entities/LanePlan.js';
import { PullRequestLink } from '../../domain/entities/PullRequestLink.js';
import type { LanePlanGraphPlan } from '../../domain/lane-plan-graph.js';
import { findLanePlanCycle, formatLanePlanCycle } from '../../domain/lane-plan-graph.js';
import type {
  ImportLanePlanPort,
  ImportLanePlanRequest,
  ImportLanePlanRefusalCode,
  ImportLanePlanResult,
  LinkPullRequestPort,
  LinkPullRequestRequest,
  LinkPullRequestRefusalCode,
  LinkPullRequestResult,
  MergedPrLinkOutcome,
} from '../ports/in/ImportLanePlanPort.in-port.js';
import type {
  LanePlanRepositoryPort,
  SavePullRequestLinkResult,
} from '../ports/out/LanePlanRepositoryPort.out-port.js';

export interface ImportLanePlanDependencies {
  readonly lanePlanRepo: LanePlanRepositoryPort;
  /** Infrastructure-supplied: sha256 hex of canonicalLanePlanSidecarJson (lane-plan-records.ts:125). */
  readonly computeDigest: (sidecar: LanePlanSidecar) => string;
  /** Fresh clock, read once per call, before the record is built. */
  readonly nowIso: () => string;
}

function refusal(
  code: ImportLanePlanRefusalCode,
  reason: string,
): { outcome: 'refused'; code: ImportLanePlanRefusalCode; reason: string } {
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

    // Read the clock once; the same stamp is used for importedAtIso and every backfilled link.
    const nowIso = this.deps.nowIso();
    const candidate = buildCandidateRecord(sidecar, stored, {
      digest,
      importedAtIso: nowIso,
    });
    if (!candidate.ok) {
      return candidate.result;
    }

    const persisted = await this.persistCandidate(candidate.record, digest);
    if (persisted.outcome !== 'imported') {
      return persisted;
    }

    const links = await this.backfillMergedPrLinks(persisted.plan, nowIso);
    return { outcome: 'imported', plan: persisted.plan, digest: persisted.digest, links };
  }

  private async persistCandidate(
    candidate: LanePlanRecord,
    digest: string,
  ): Promise<
    | { readonly outcome: 'imported'; readonly plan: LanePlanRecord; readonly digest: string }
    | { readonly outcome: 'refused'; readonly code: ImportLanePlanRefusalCode; readonly reason: string }
  > {
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

  /**
   * Backfill every lane's `mergedPr` as a sidecar link (WB4b). Runs only on
   * the 'imported' path, after the plan record is persisted; one per-lane
   * outcome is reported in `result.links`, and the import never fails because
   * a backfilled PR was already linked to another lane.
   */
  private async backfillMergedPrLinks(
    plan: LanePlanRecord,
    nowIso: string,
  ): Promise<readonly MergedPrLinkOutcome[]> {
    const outcomes: MergedPrLinkOutcome[] = [];
    for (const lane of plan.lanes) {
      if (lane.mergedPr === null) {
        continue;
      }
      const result = await runLinkPullRequest(this.deps.lanePlanRepo, () => nowIso, {
        repository: lane.mergedPr.repository,
        number: lane.mergedPr.number,
        projectId: plan.projectId,
        planId: plan.planId,
        laneId: lane.laneId,
        source: 'sidecar',
      });
      const base = {
        repository: lane.mergedPr.repository,
        number: lane.mergedPr.number,
        laneId: lane.laneId,
      };
      if (result.outcome === 'linked') {
        outcomes.push({ ...base, outcome: 'linked', code: null });
      } else if (result.outcome === 'unchanged') {
        outcomes.push({ ...base, outcome: 'unchanged', code: null });
      } else {
        outcomes.push({
          ...base,
          outcome: 'refused',
          code: result.code === 'pr-already-linked' ? 'pr-already-linked' : null,
        });
      }
    }
    return outcomes;
  }
}

function linkRefusal(code: LinkPullRequestRefusalCode, reason: string): LinkPullRequestResult {
  return { outcome: 'refused', code, reason };
}

function validateLinkPullRequestRequest(
  request: LinkPullRequestRequest,
): { ok: true } | { ok: false; result: LinkPullRequestResult } {
  if (
    typeof request.repository !== 'string' ||
    request.repository.trim().length === 0 ||
    /[\r\n]/.test(request.repository)
  ) {
    return { ok: false, result: linkRefusal('invalid', 'repository must be a non-empty single-line string') };
  }
  if (!Number.isSafeInteger(request.number) || request.number < 1) {
    return { ok: false, result: linkRefusal('invalid', 'number must be a positive integer') };
  }
  if (typeof request.projectId !== 'string' || request.projectId.trim().length === 0) {
    return { ok: false, result: linkRefusal('invalid', 'projectId must be a non-empty string') };
  }
  if (
    request.planId !== null &&
    (typeof request.planId !== 'string' || request.planId.trim().length === 0)
  ) {
    return { ok: false, result: linkRefusal('invalid', 'planId must be a non-empty string or null') };
  }
  if (typeof request.laneId !== 'string' || request.laneId.trim().length === 0) {
    return { ok: false, result: linkRefusal('invalid', 'laneId must be a non-empty string') };
  }
  if (!PULL_REQUEST_LINK_SOURCES.includes(request.source)) {
    return {
      ok: false,
      result: linkRefusal('invalid', 'source must be one of fleet-forge-action, run, sidecar, cli'),
    };
  }
  return { ok: true };
}

/**
 * Resolve a lane by its current id or an alias, exactly as
 * RegisterWorkOrderUseCase's plan link does (WB4a). The link is stored under
 * the lane's current id, never the alias.
 */
async function resolveLaneCurrentId(
  lanePlanRepo: LanePlanRepositoryPort,
  projectId: string,
  planId: string,
  requestedLaneId: string,
): Promise<
  | { readonly resolved: true; readonly laneId: string; readonly plan: LanePlanRecord }
  | { readonly resolved: false; readonly result: LinkPullRequestResult }
> {
  let plan: LanePlanRecord | null;
  try {
    plan = await lanePlanRepo.findLanePlan(projectId, planId);
  } catch {
    return { resolved: false, result: linkRefusal('store', 'the store could not be read') };
  }
  if (plan === null) {
    return { resolved: false, result: linkRefusal('unknown-lane', 'the plan is not imported') };
  }
  const lane = plan.lanes.find(
    (candidate) =>
      candidate.laneId === requestedLaneId || candidate.aliases.includes(requestedLaneId),
  );
  if (lane === undefined) {
    return {
      resolved: false,
      result: linkRefusal('unknown-lane', 'the plan names no lane with that id'),
    };
  }
  return { resolved: true, laneId: lane.laneId, plan };
}

function buildLinkRecord(
  request: LinkPullRequestRequest,
  resolvedLaneId: string,
  nowIso: () => string,
): { ok: true; record: PullRequestLinkRecord } | { ok: false; result: LinkPullRequestResult } {
  let linkedAtIso: string;
  try {
    linkedAtIso = nowIso();
  } catch {
    return { ok: false, result: linkRefusal('invalid', 'the link record was refused') };
  }
  const created = PullRequestLink.create({
    version: PULL_REQUEST_LINK_RECORD_VERSION,
    repository: request.repository,
    number: request.number,
    projectId: request.projectId,
    planId: request.planId,
    laneId: resolvedLaneId,
    source: request.source,
    linkedAtIso,
  });
  if (!created.success) {
    return { ok: false, result: linkRefusal('invalid', 'the link record was refused') };
  }
  return { ok: true, record: created.value.toRecord() };
}

async function resolveAliasUnchangedLink(
  lanePlanRepo: LanePlanRepositoryPort,
  request: LinkPullRequestRequest,
  plan: LanePlanRecord | null,
  resolvedLaneId: string,
): Promise<PullRequestLinkRecord | null> {
  if (request.planId === null || plan === null) {
    return null;
  }
  const existing = await lanePlanRepo.findPullRequestLink(request.repository, request.number);
  if (
    existing === null ||
    existing.projectId !== request.projectId ||
    existing.planId !== request.planId
  ) {
    return null;
  }
  const storedLane = plan.lanes.find(
    (candidate) =>
      candidate.laneId === existing.laneId || candidate.aliases.includes(existing.laneId),
  );
  if (storedLane !== undefined && storedLane.laneId === resolvedLaneId) {
    return existing;
  }
  return null;
}

/**
 * The shared link code path of LinkPullRequestUseCase and the mergedPr
 * backfill on import. Never throws; every failure is a refusal result.
 */
async function runLinkPullRequest(
  lanePlanRepo: LanePlanRepositoryPort,
  nowIso: () => string,
  request: LinkPullRequestRequest,
): Promise<LinkPullRequestResult> {
  const validated = validateLinkPullRequestRequest(request);
  if (!validated.ok) {
    return validated.result;
  }

  let resolvedLaneId = request.laneId;
  let plan: LanePlanRecord | null = null;
  if (request.planId !== null) {
    const resolved = await resolveLaneCurrentId(
      lanePlanRepo,
      request.projectId,
      request.planId,
      request.laneId,
    );
    if (!resolved.resolved) {
      return resolved.result;
    }
    resolvedLaneId = resolved.laneId;
    plan = resolved.plan;
  }

  const built = buildLinkRecord(request, resolvedLaneId, nowIso);
  if (!built.ok) {
    return built.result;
  }
  const record = built.record;

  let saveResult: SavePullRequestLinkResult;
  try {
    saveResult = await lanePlanRepo.savePullRequestLink(record);
  } catch {
    return linkRefusal('store', 'the store refused the save');
  }

  if (saveResult.outcome === 'saved') {
    return { outcome: 'linked', link: saveResult.link };
  }
  if (saveResult.outcome === 'unchanged') {
    return { outcome: 'unchanged', link: saveResult.link };
  }
  if (saveResult.code === 'pr-already-linked') {
    try {
      const aliasMatch = await resolveAliasUnchangedLink(
        lanePlanRepo,
        request,
        plan,
        resolvedLaneId,
      );
      if (aliasMatch !== null) {
        return { outcome: 'unchanged', link: aliasMatch };
      }
    } catch {
      return linkRefusal('store', 'the store could not be read');
    }
    return linkRefusal(
      'pr-already-linked',
      `the pull request is already linked to lane ${saveResult.linkedLaneId}`,
    );
  }
  if (saveResult.code === 'invalid') {
    return linkRefusal('invalid', 'the link record was refused');
  }
  return linkRefusal('store', 'the store refused the save');
}

export interface LinkPullRequestDependencies {
  readonly lanePlanRepo: LanePlanRepositoryPort;
  /** Fresh clock, read once per call, before the record is built. */
  readonly nowIso: () => string;
}

/** Link one pull request to one lane (work-board plan §3.2 "PR links are unique"). */
export class LinkPullRequestUseCase implements LinkPullRequestPort {
  constructor(private readonly deps: LinkPullRequestDependencies) {}

  async linkPullRequest(request: LinkPullRequestRequest): Promise<LinkPullRequestResult> {
    return runLinkPullRequest(this.deps.lanePlanRepo, this.deps.nowIso, request);
  }
}
