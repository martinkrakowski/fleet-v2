/**
 * ListConductorPassesUseCase: list the recorded conductor passes newest first,
 * at most a bounded limit. Read-only: it never writes and never contacts a
 * runner. Each view is built field by field without the stored holder id; an
 * unreadable trace store is reported unreadable, never an error.
 */

import type { ConductorPassTracePort } from '../ports/out/ConductorPassTracePort.out-port.js';
import type { ConductorPassTraceRecord } from '../../domain/conductor-pass-trace.js';
import type {
  ConductorPassView,
  ListConductorPassesPort,
  ListConductorPassesRequest,
  ListConductorPassesResult,
} from '../ports/in/ListConductorPassesPort.in-port.js';
import { LIST_CONDUCTOR_PASSES_MAX_LIMIT } from '../ports/in/ListConductorPassesPort.in-port.js';

/** The limit: undefined defaults to 32; a number or digit string in 1..32, else null. */
function normaliseLimit(value: unknown): number | null {
  if (value === undefined) {
    return LIST_CONDUCTOR_PASSES_MAX_LIMIT;
  }
  let limit: number;
  if (typeof value === 'number') {
    limit = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    limit = Number(value);
  } else {
    return null;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_CONDUCTOR_PASSES_MAX_LIMIT) {
    return null;
  }
  return limit;
}

/** One view: every field of the record except the stored holder id, never a spread. */
function viewOf(trace: ConductorPassTraceRecord): ConductorPassView {
  return {
    schemaVersion: trace.schemaVersion,
    passId: trace.passId,
    nowIso: trace.nowIso,
    halted: trace.halted,
    progressed: trace.progressed,
    maxActiveRuns: trace.maxActiveRuns,
    passConcurrency: trace.passConcurrency,
    dispatchStaggerMs: trace.dispatchStaggerMs,
    runs: trace.runs,
    attention: trace.attention,
  };
}

export class ListConductorPassesUseCase implements ListConductorPassesPort {
  constructor(private readonly deps?: { readonly passTrace: Pick<ConductorPassTracePort, 'list'> }) {}

  async execute(input?: unknown): Promise<ListConductorPassesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListConductorPassesUseCase');
    }
    const isPlainObject =
      typeof input === 'object' &&
      input !== null &&
      (Object.getPrototypeOf(input) === Object.prototype ||
        Object.getPrototypeOf(input) === null);
    if (!isPlainObject) {
      return { outcome: 'rejected', reason: 'invalid-limit' };
    }
    const limit = normaliseLimit((input as Record<string, unknown>).limit);
    if (limit === null) {
      return { outcome: 'rejected', reason: 'invalid-limit' };
    }
    return this.listConductorPasses({ limit });
  }

  async listConductorPasses(request: ListConductorPassesRequest): Promise<ListConductorPassesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ListConductorPassesUseCase');
    }
    const limit = normaliseLimit(request.limit);
    if (limit === null) {
      return { outcome: 'rejected', reason: 'invalid-limit' };
    }
    const listed = await this.deps.passTrace.list();
    if (listed.outcome === 'unreadable') {
      return { outcome: 'listed', store: 'unreadable', passes: [], total: 0, truncated: false };
    }
    const total = listed.traces.length;
    const passes = [...listed.traces]
      .reverse()
      .slice(0, limit)
      .map(viewOf);
    return {
      outcome: 'listed',
      store: 'readable',
      passes,
      total,
      truncated: total > limit,
    };
  }
}
