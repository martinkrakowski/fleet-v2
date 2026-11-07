/**
 * GiveToolPermissionVerdictUseCase implements GiveToolPermissionVerdictPort.
 * It records the first verdict on one pending request; the first verdict
 * wins, the same decision again changes nothing, and a different decision is
 * a conflict that returns the stored first verdict. An unknown request id is
 * unknown, never allowed; a verdict after the deadline is expired and changes
 * nothing. The actor id is the caller's, never the body.
 */

import type {
  PermissionRequestRecord,
  PermissionVerdictRecord,
} from '../../domain/entities/PermissionRequest.js';
import type { PermissionRequestRepositoryPort } from '../ports/out/PermissionRequestRepositoryPort.out-port.js';
import type {
  GiveToolPermissionVerdictOutcome,
  GiveToolPermissionVerdictPort,
} from '../ports/in/GiveToolPermissionVerdictPort.in-port.js';

export interface GiveToolPermissionVerdictDependencies {
  readonly repository: PermissionRequestRepositoryPort;
  readonly clock?: { nowIso: () => string };
  readonly now?: () => number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class GiveToolPermissionVerdictUseCase implements GiveToolPermissionVerdictPort {
  private readonly repository: PermissionRequestRepositoryPort;
  private readonly clock: { nowIso: () => string };
  private readonly now: () => number;

  constructor(options: GiveToolPermissionVerdictDependencies) {
    this.repository = options.repository;
    this.clock = options.clock ?? { nowIso: () => new Date().toISOString() };
    this.now = options.now ?? Date.now;
  }

  async giveToolPermissionVerdict(
    body: unknown,
    requestId: string,
    actorId: string,
    threadId?: string,
  ): Promise<GiveToolPermissionVerdictOutcome> {
    try {
      return this.execute(body, requestId, actorId, threadId);
    } catch {
      return { outcome: 'refused', reason: 'internal-error' };
    }
  }

  private read(requestId: string): PermissionRequestRecord | undefined {
    try {
      return this.repository.find(requestId);
    } catch {
      // A repository read that throws is a failed read, not a bug: report it
      // as unknown so the caller treats the request id as unresolvable.
      return undefined;
    }
  }

  private execute(
    body: unknown,
    requestId: string,
    actorId: string,
    threadId?: string,
  ): GiveToolPermissionVerdictOutcome {
    if (!isPlainObject(body)) {
      return { outcome: 'refused', reason: 'body-not-an-object' };
    }

    let decision: unknown;
    try {
      decision = body.decision;
    } catch {
      return { outcome: 'refused', reason: 'body-not-an-object' };
    }
    if (decision === undefined) {
      return { outcome: 'refused', reason: 'decision-missing' };
    }
    if (decision !== 'allow' && decision !== 'deny') {
      return { outcome: 'refused', reason: 'decision-invalid' };
    }
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { outcome: 'refused', reason: 'request-id-invalid' };
    }

    const record = this.read(requestId);
    if (record === undefined) {
      return { outcome: 'unknown' };
    }

    if (threadId !== undefined && record.threadId !== threadId) {
      return { outcome: 'unknown' };
    }

    if (record.state === 'expired') {
      return { outcome: 'expired' };
    }

    const verdict: PermissionVerdictRecord = {
      decision,
      actorId,
      decidedAtIso: this.clock.nowIso(),
    };

    if (record.verdict !== undefined) {
      const result = this.repository.recordVerdict(requestId, verdict);
      if (result.outcome === 'unknown') {
        return { outcome: 'unknown' };
      }
      if (result.outcome === 'expired') {
        return { outcome: 'expired' };
      }
      const first = this.read(requestId)?.verdict;
      if (first === undefined) {
        return { outcome: 'unknown' };
      }
      // A stored verdict already existed, so the outcome is unchanged or conflict.
      return {
        outcome: result.outcome === 'recorded' ? 'unchanged' : result.outcome,
        verdict: first,
      };
    }

    if (this.now() >= Date.parse(record.deadlineAtIso)) {
      this.repository.expire(requestId, 'timed-out', this.clock.nowIso());
      return { outcome: 'expired' };
    }

    const result = this.repository.recordVerdict(requestId, verdict);
    if (result.outcome === 'recorded') {
      return { outcome: 'recorded', verdict };
    }
    if (result.outcome === 'expired') {
      return { outcome: 'expired' };
    }
    if (result.outcome === 'unchanged' || result.outcome === 'conflict') {
      const first = this.read(requestId)?.verdict;
      if (first === undefined) {
        return { outcome: 'unknown' };
      }
      return { outcome: result.outcome, verdict: first };
    }
    return { outcome: 'unknown' };
  }
}
