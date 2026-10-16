/**
 * AttentionReadAdapter implements AttentionReadPort over the existing Waves
 * attention and project-staleness read endpoints, an injected reader, or a
 * local summary store.
 *
 * Reads are bounded to one project and are never cached or rewritten here.
 * Known absence is null; a failed read throws instead of returning an empty
 * summary that a caller could mistake for a healthy project.
 */

import type { ProjectAttentionSummaryRecord } from '../../domain/coordination-records.js';
import type { AttentionReadPort } from '../../application/ports/out/AttentionReadPort.out-port.js';
import type { WavesHttpClient, WavesHttpResponse } from './WavesHttpClient.adapter.js';
import { scrubAndTruncate, scrubToken } from './WavesHttpClient.adapter.js';

export type AttentionReader = (
  projectId: string,
) =>
  | Promise<ProjectAttentionSummaryRecord | null>
  | ProjectAttentionSummaryRecord
  | null;

export interface AttentionReadAdapterOptions {
  /** Existing Waves read boundary for one project. */
  readonly read?: AttentionReader;
  /** Locally held summaries, used when no reader is configured. */
  readonly summaries?: Readonly<Record<string, ProjectAttentionSummaryRecord>>;
  /** Optional Waves HTTP client for reading attention and project status. */
  readonly client?: WavesHttpClient;
}

function copy(summary: ProjectAttentionSummaryRecord): ProjectAttentionSummaryRecord {
  return { ...summary };
}

interface ExtractedProject {
  readonly id: string;
  readonly lastPush?: string;
}

function findProjectInResponse(data: unknown, projectId: string): ExtractedProject | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string' && item === projectId) {
        return { id: item };
      }
      if (typeof item === 'object' && item !== null) {
        const id =
          (item as { id?: unknown; projectId?: unknown }).id ??
          (item as { projectId?: unknown }).projectId;
        if (typeof id === 'string' && id === projectId) {
          const lastPush =
            typeof (item as { lastPush?: unknown }).lastPush === 'string'
              ? (item as { lastPush: string }).lastPush
              : undefined;
          return { id: projectId, lastPush };
        }
      }
    }
    return null;
  }
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.projects)) {
      return findProjectInResponse(record.projects, projectId);
    }
    if (Object.hasOwn(record, projectId)) {
      const val = record[projectId];
      const lastPush =
        typeof val === 'object' &&
        val !== null &&
        typeof (val as { lastPush?: unknown }).lastPush === 'string'
          ? (val as { lastPush: string }).lastPush
          : undefined;
      return { id: projectId, lastPush };
    }
  }
  return null;
}

interface ExtractedAttention {
  readonly staleWorkOrderCount: number;
  readonly awaitingDecisionCount: number;
  readonly deliveryGapCount: number;
  readonly summaryText: string;
  readonly observedAtIso?: string;
}

function extractAttentionFields(
  obj: Record<string, unknown>,
  projectId: string,
): ExtractedAttention {
  const stale = typeof obj.staleWorkOrderCount === 'number' ? obj.staleWorkOrderCount : 0;
  const awaiting = typeof obj.awaitingDecisionCount === 'number' ? obj.awaitingDecisionCount : 0;
  const gap = typeof obj.deliveryGapCount === 'number' ? obj.deliveryGapCount : 0;
  const summary =
    typeof obj.summaryText === 'string' ? obj.summaryText : `attention for ${projectId}`;
  const observed = typeof obj.observedAtIso === 'string' ? obj.observedAtIso : undefined;
  return {
    staleWorkOrderCount: stale,
    awaitingDecisionCount: awaiting,
    deliveryGapCount: gap,
    summaryText: summary,
    observedAtIso: observed,
  };
}

function findAttentionInResponse(data: unknown, projectId: string): ExtractedAttention | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'object' && item !== null) {
        const id =
          (item as { projectId?: unknown; id?: unknown }).projectId ??
          (item as { id?: unknown }).id;
        if (id === projectId) {
          return extractAttentionFields(item as Record<string, unknown>, projectId);
        }
      }
    }
    return null;
  }
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return findAttentionInResponse(record.items, projectId);
    }
    if (Array.isArray(record.attention)) {
      return findAttentionInResponse(record.attention, projectId);
    }
    if (Object.hasOwn(record, projectId)) {
      const val = record[projectId];
      if (typeof val === 'object' && val !== null) {
        return extractAttentionFields(val as Record<string, unknown>, projectId);
      }
    }
  }
  return null;
}

export class AttentionReadAdapter implements AttentionReadPort {
  constructor(private readonly options: AttentionReadAdapterOptions = {}) {}

  async fetchProjectAttention(projectId: string): Promise<ProjectAttentionSummaryRecord | null> {
    const { read, summaries, client } = this.options;
    if (client !== undefined) {
      return this.fetchFromClient(client, projectId);
    }
    if (read !== undefined) {
      // A failed read is an error, never an empty summary.
      const fetched = await read(projectId);
      return fetched === null ? null : copy(fetched);
    }
    const stored = summaries?.[projectId];
    return stored === undefined ? null : copy(stored);
  }

  private async fetchFromClient(
    client: WavesHttpClient,
    projectId: string,
  ): Promise<ProjectAttentionSummaryRecord | null> {
    let attentionRes: WavesHttpResponse;
    let projectsRes: WavesHttpResponse;

    try {
      [attentionRes, projectsRes] = await Promise.all([
        client.get('/api/v1/attention'),
        client.get('/api/v1/projects'),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Waves attention read failed: ${scrubToken(msg, client.getLoadedToken())}`);
    }

    if (attentionRes.status === 401 || projectsRes.status === 401) {
      throw new Error('Waves attention read failed: HTTP 401 unauthorized');
    }

    if (attentionRes.status < 200 || attentionRes.status >= 300) {
      const snippet = scrubAndTruncate(attentionRes.body, client.getLoadedToken());
      throw new Error(
        `Waves attention read failed: HTTP ${attentionRes.status}${snippet ? ` - ${snippet}` : ''}`,
      );
    }

    if (projectsRes.status < 200 || projectsRes.status >= 300) {
      const snippet = scrubAndTruncate(projectsRes.body, client.getLoadedToken());
      throw new Error(
        `Waves projects read failed: HTTP ${projectsRes.status}${snippet ? ` - ${snippet}` : ''}`,
      );
    }

    let parsedAttention: unknown;
    try {
      parsedAttention = JSON.parse(attentionRes.body);
    } catch {
      throw new Error('Waves attention read failed: invalid JSON response');
    }

    let parsedProjects: unknown;
    try {
      parsedProjects = JSON.parse(projectsRes.body);
    } catch {
      throw new Error('Waves projects read failed: invalid JSON response');
    }

    const projectInfo = findProjectInResponse(parsedProjects, projectId);
    if (projectInfo === null) {
      // Known absence is null
      return null;
    }

    const attentionItem = findAttentionInResponse(parsedAttention, projectId);
    if (attentionItem !== null) {
      return {
        projectId,
        staleWorkOrderCount: attentionItem.staleWorkOrderCount,
        awaitingDecisionCount: attentionItem.awaitingDecisionCount,
        deliveryGapCount: attentionItem.deliveryGapCount,
        summaryText: attentionItem.summaryText,
        observedAtIso:
          attentionItem.observedAtIso ?? projectInfo.lastPush ?? new Date().toISOString(),
      };
    }

    return {
      projectId,
      staleWorkOrderCount: 0,
      awaitingDecisionCount: 0,
      deliveryGapCount: 0,
      summaryText: `no attention items for ${projectId}`,
      observedAtIso: projectInfo.lastPush ?? new Date().toISOString(),
    };
  }
}
