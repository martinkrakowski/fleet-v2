/**
 * The pure markdown-vs-sidecar plan drift checker (WB7a): compare a plan's
 * markdown workbook table against its parsed sidecar. No filesystem, no
 * clock, no I/O — the `plan check` command reads the files and calls this.
 * Never throws: malformed or empty markdown returns structured drift.
 */

import { PLANNED_LANE_ID_PATTERN, type LanePlanSidecar, type PlannedLaneTier } from '@fleet/work-execution';

/** One drift finding: the kind, the lane it names and a neutral detail. */
export interface PlanDrift {
  readonly kind: 'missing-in-markdown' | 'extra-in-markdown' | 'tier-mismatch' | 'after-mismatch';
  readonly laneId: string;
  readonly detail: string;
}

export type PlanCheckResult =
  | { readonly outcome: 'in-sync' }
  | { readonly outcome: 'drift'; readonly drifts: readonly PlanDrift[] };

/** One markdown table row parsed into its sidecar-facing fields. */
interface MarkdownLane {
  readonly laneId: string;
  readonly tier: PlannedLaneTier | null;
  readonly after: readonly string[];
}

/** A full after reference as the sidecar writes it: `projectId/planId/laneId`. */
function fullRef(projectId: string, planId: string, laneId: string): string {
  return `${projectId}/${planId}/${laneId}`;
}

/** A markdown after token normalized against the plan's own project and plan. */
function normalizeAfterToken(token: string, projectId: string, planId: string): string | null {
  const cleaned = token.trim().replace(/[`,]/g, '');
  if (cleaned === '' || cleaned === '—' || cleaned === '-' || cleaned.toLowerCase() === 'none') {
    return null;
  }
  const parts = cleaned.split('/').filter((part) => part !== '');
  if (parts.length === 1) {
    return fullRef(projectId, planId, parts[0]);
  }
  if (parts.length === 2) {
    return fullRef(projectId, parts[0], parts[1]);
  }
  if (parts.length === 3) {
    return fullRef(parts[0], parts[1], parts[2]);
  }
  return fullRef(projectId, planId, cleaned);
}

/** Parse the tier cell; null when the cell does not carry 0, 1 or 2. */
function parseTierCell(cell: string): PlannedLaneTier | null {
  const match = /^\s*`?\[?\(?([012])\)?\]?`?\s*$/.exec(cell.replace(/[*_]/g, ''));
  return match === null ? null : (Number(match[1]) as PlannedLaneTier);
}

/** Split the after cell into normalized reference strings, in order. */
function parseAfterCell(cell: string, projectId: string, planId: string): readonly string[] {
  const tokens = cell.split(/[\s,|]+/).filter((token) => token.trim() !== '');
  const refs: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeAfterToken(token, projectId, planId);
    if (normalized !== null) {
      refs.push(normalized);
    }
  }
  return refs;
}

/**
 * Parse the markdown table rows whose first column is a lane id. Header,
 * separator and section rows are skipped; a lane row with an unreadable tier
 * cell keeps `tier: null` so the comparison can report it.
 */
export function parsePlanMarkdownLanes(
  markdown: string,
  projectId: string,
  planId: string,
): readonly MarkdownLane[] {
  const lanes: MarkdownLane[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) {
      continue;
    }
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    const laneId = (cells[0] ?? '').replace(/[`*]/g, '');
    // The header row names its columns; a section row carries no tier cell.
    // Neither is a lane row, and neither is ever a finding.
    if (laneId.toLowerCase() === 'lane' || cells.slice(1).every((cell) => cell === '')) {
      continue;
    }
    if (!PLANNED_LANE_ID_PATTERN.test(laneId)) {
      continue;
    }
    const tier = cells.length > 1 ? parseTierCell(cells[1]) : null;
    const after = cells.length > 2 ? parseAfterCell(cells[2], projectId, planId) : [];
    lanes.push({ laneId, tier, after });
  }
  return lanes;
}

/** Sort by lane id, then kind, so the report is stable. */
function compareDrifts(a: PlanDrift, b: PlanDrift): number {
  return a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/**
 * Compare the parsed sidecar against the markdown table. Empty or malformed
 * markdown leaves every sidecar lane missing-in-markdown — a structured
 * drift, never a clean pass.
 */
export function comparePlanMarkdownToSidecar(
  sidecar: LanePlanSidecar,
  markdown: string,
): PlanCheckResult {
  const drifts: PlanDrift[] = [];
  const rows = parsePlanMarkdownLanes(markdown, sidecar.projectId, sidecar.planId);
  const byLaneId = new Map<string, MarkdownLane>();
  for (const row of rows) {
    if (!byLaneId.has(row.laneId)) {
      byLaneId.set(row.laneId, row);
    }
  }
  const sidecarIds = new Set<string>();
  for (const lane of sidecar.lanes) {
    sidecarIds.add(lane.laneId);
    const row = byLaneId.get(lane.laneId);
    if (row === undefined) {
      drifts.push({
        kind: 'missing-in-markdown',
        laneId: lane.laneId,
        detail: 'the sidecar lane has no markdown table row',
      });
      continue;
    }
    if (row.tier === null || row.tier !== lane.tier) {
      drifts.push({
        kind: 'tier-mismatch',
        laneId: lane.laneId,
        detail:
          row.tier === null
            ? `the sidecar tier is ${String(lane.tier)} and the markdown tier cell is unreadable`
            : `the sidecar tier is ${String(lane.tier)} and the markdown tier is ${String(row.tier)}`,
      });
    }
    const expected = lane.after.map((ref) => fullRef(ref.projectId, ref.planId, ref.laneId));
    const same =
      expected.length === row.after.length &&
      expected.every((ref, index) => ref === row.after[index]);
    if (!same) {
      drifts.push({
        kind: 'after-mismatch',
        laneId: lane.laneId,
        detail: `the sidecar after list is ${expected.length === 0 ? 'empty' : expected.join(', ')}`,
      });
    }
  }
  for (const row of rows) {
    if (!sidecarIds.has(row.laneId)) {
      drifts.push({
        kind: 'extra-in-markdown',
        laneId: row.laneId,
        detail: 'the markdown table row names no sidecar lane',
      });
    }
  }
  if (drifts.length === 0) {
    return { outcome: 'in-sync' };
  }
  return { outcome: 'drift', drifts: drifts.sort(compareDrifts) };
}
