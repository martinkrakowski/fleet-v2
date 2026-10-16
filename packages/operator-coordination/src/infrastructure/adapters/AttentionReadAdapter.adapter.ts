/**
 * AttentionReadAdapter implements AttentionReadPort over the existing Waves
 * attention and project-staleness read endpoints, an injected reader, or a
 * local summary store.
 *
 * Reads are bounded to one project and are never cached or rewritten here.
 * Known absence is null; a failed read throws instead of returning an empty
 * summary that a caller could mistake for a healthy project.
 *
 * The Waves endpoints have exactly one documented response shape: both
 * `/api/v1/attention` and `/api/v1/projects` return a top-level JSON array of
 * camelCase objects (attention items keyed by `projectId` with integer counts;
 * project items keyed by `id`). Any other shape — an object envelope such as
 * `{ data: [...] }`, snake_case keys, a missing or non-integer count — fails
 * the read instead of being guessed into numbers. A project that is absent
 * from the attention list is unknown (null), never a zeroed summary.
 */

import type { ProjectAttentionSummaryRecord } from '../../domain/coordination-records.js';
import type { AttentionReadPort } from '../../application/ports/out/AttentionReadPort.out-port.js';
import type { WavesHttpClient, WavesHttpResponse } from './WavesHttpClient.adapter.js';
import { scrubAndTruncate } from './WavesHttpClient.adapter.js';

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

/** Keys written in the server's snake_case naming scheme instead of the documented camelCase. */
const SNAKE_CASE_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

const ATTENTION_COUNT_FIELDS = [
  'staleWorkOrderCount',
  'awaitingDecisionCount',
  'deliveryGapCount',
] as const;

/** One documented attention item: counts are present, integer and non-negative. */
interface WavesAttentionItem {
  readonly projectId: string;
  readonly staleWorkOrderCount: number;
  readonly awaitingDecisionCount: number;
  readonly deliveryGapCount: number;
  readonly summaryText: string;
  readonly observedAtIso: string;
}

/** One documented project item: identity is `id`; nothing else is guessed from it. */
interface WavesProjectItem {
  readonly id: string;
}

type Scrub = (text: string) => string;

function attentionShapeFailure(detail: string): Error {
  return new Error(
    `Waves attention read failed: unexpected /api/v1/attention response shape: ${detail}`,
  );
}

function projectsShapeFailure(detail: string): Error {
  return new Error(
    `Waves projects read failed: unexpected /api/v1/projects response shape: ${detail}`,
  );
}

function assertNoSnakeCaseKeys(
  item: Record<string, unknown>,
  index: number,
  scrub: Scrub,
  failure: (detail: string) => Error,
): void {
  for (const key of Object.keys(item)) {
    if (SNAKE_CASE_KEY.test(key)) {
      throw failure(
        `item at index ${index} has a snake_case key "${scrub(key)}"; the documented shape uses camelCase keys`,
      );
    }
  }
}

function parseAttentionResponse(data: unknown, scrub: Scrub): readonly WavesAttentionItem[] {
  if (!Array.isArray(data)) {
    throw attentionShapeFailure('expected a top-level array of attention items');
  }
  const items: WavesAttentionItem[] = [];
  data.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw attentionShapeFailure(`item at index ${index} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    assertNoSnakeCaseKeys(item, index, scrub, attentionShapeFailure);
    if (typeof item.projectId !== 'string' || item.projectId.length === 0) {
      throw attentionShapeFailure(
        `item at index ${index} requires a non-empty string projectId`,
      );
    }
    for (const field of ATTENTION_COUNT_FIELDS) {
      const value = item[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw attentionShapeFailure(
          `item at index ${index} requires a non-negative integer ${field}`,
        );
      }
    }
    if (typeof item.summaryText !== 'string') {
      throw attentionShapeFailure(`item at index ${index} requires a string summaryText`);
    }
    if (typeof item.observedAtIso !== 'string') {
      throw attentionShapeFailure(`item at index ${index} requires a string observedAtIso`);
    }
    items.push({
      projectId: item.projectId,
      staleWorkOrderCount: item.staleWorkOrderCount as number,
      awaitingDecisionCount: item.awaitingDecisionCount as number,
      deliveryGapCount: item.deliveryGapCount as number,
      summaryText: item.summaryText,
      observedAtIso: item.observedAtIso,
    });
  });
  return items;
}

function parseProjectsResponse(data: unknown, scrub: Scrub): readonly WavesProjectItem[] {
  if (!Array.isArray(data)) {
    throw projectsShapeFailure('expected a top-level array of project items');
  }
  const items: WavesProjectItem[] = [];
  data.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw projectsShapeFailure(`item at index ${index} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    assertNoSnakeCaseKeys(item, index, scrub, projectsShapeFailure);
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw projectsShapeFailure(`item at index ${index} requires a non-empty string id`);
    }
    items.push({ id: item.id });
  });
  return items;
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
      throw new Error(`Waves attention read failed: ${client.scrub(msg)}`);
    }

    if (attentionRes.status === 401 || projectsRes.status === 401) {
      throw new Error('Waves attention read failed: HTTP 401 unauthorized');
    }

    if (attentionRes.status < 200 || attentionRes.status >= 300) {
      const snippet = scrubAndTruncate(client.scrub(attentionRes.body));
      throw new Error(
        `Waves attention read failed: HTTP ${attentionRes.status}${snippet ? ` - ${snippet}` : ''}`,
      );
    }

    if (projectsRes.status < 200 || projectsRes.status >= 300) {
      const snippet = scrubAndTruncate(client.scrub(projectsRes.body));
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

    // Both responses must carry the documented shape, or the read fails closed.
    const attentionItems = parseAttentionResponse(parsedAttention, (text) => client.scrub(text));
    const projectItems = parseProjectsResponse(parsedProjects, (text) => client.scrub(text));

    if (!projectItems.some((project) => project.id === projectId)) {
      // Known absence: the project is not in the projects list.
      return null;
    }

    const attentionItem = attentionItems.find((item) => item.projectId === projectId);
    if (attentionItem === undefined) {
      // The project exists but has no attention item: its attention state is
      // unknown, never a zeroed summary presented as a healthy project.
      return null;
    }

    return {
      projectId,
      staleWorkOrderCount: attentionItem.staleWorkOrderCount,
      awaitingDecisionCount: attentionItem.awaitingDecisionCount,
      deliveryGapCount: attentionItem.deliveryGapCount,
      summaryText: attentionItem.summaryText,
      observedAtIso: attentionItem.observedAtIso,
    };
  }
}
