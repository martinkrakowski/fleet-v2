// @generated use-case scaffold — implemented for lane DT10b.
/**
 * InspectDaemonStatusUseCase implements InspectDaemonStatusPort: the read-only
 * `daemon status` check (daemon-tick plan §3.1). It resolves the tick interval
 * (the request, else the merge policy, else the default), reads the status
 * record, re-validates it and evaluates its health at the caller's clock.
 * Unknown stays unknown: a missing, unreadable, malformed or throwing read is a
 * non-zero outcome with a fixed code, never a healthy status, and a configured
 * policy that cannot be read never falls back to the default interval. Never
 * throws, never writes, never echoes a path or an error message.
 */

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  DAEMON_DEFAULT_INTERVAL_SECONDS,
  evaluateDaemonStatusHealth,
  readDaemonStatusRecord,
} from '../../domain/daemon-tick.js';
import type { DaemonStatusPort } from '../ports/out/DaemonStatusPort.out-port.js';
import type { MergePolicyPort } from '../ports/out/MergePolicyPort.out-port.js';
import type {
  InspectDaemonStatusPort,
  InspectDaemonStatusRefusalReason,
  InspectDaemonStatusRequest,
  InspectDaemonStatusResult,
} from '../ports/in/InspectDaemonStatusPort.in-port.js';

const MAX_INTERVAL_SECONDS = 3_600;

export interface InspectDaemonStatusDependencies {
  readonly status: Pick<DaemonStatusPort, 'read'>;
  readonly policy?: Pick<MergePolicyPort, 'readMergePolicy'>;
}

function refuse(reasonCode: InspectDaemonStatusRefusalReason): InspectDaemonStatusResult {
  return { outcome: 'refused', exitCode: 1, status: null, health: null, reasonCode };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isValidInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_INTERVAL_SECONDS;
}

export class InspectDaemonStatusUseCase implements InspectDaemonStatusPort {
  constructor(private readonly deps: InspectDaemonStatusDependencies) {}

  async inspectStatus(request: InspectDaemonStatusRequest): Promise<InspectDaemonStatusResult> {
    try {
      return await this.inspect(request);
    } catch {
      return refuse('invalid-request');
    }
  }

  private async inspect(request: unknown): Promise<InspectDaemonStatusResult> {
    if (!isPlainObject(request)) {
      return refuse('invalid-request');
    }
    const nowIso = request.nowIso;
    if (typeof nowIso !== 'string' || !isZonedIsoDateTime(nowIso)) {
      return refuse('invalid-clock');
    }
    const interval = await this.resolveInterval(request.intervalSeconds);
    if (interval === 'invalid-interval' || interval === 'policy-unreadable') {
      return refuse(interval);
    }

    const read = await this.readStatus();
    if (read === 'unreadable') {
      return refuse('status-unreadable');
    }
    if (read === 'missing') {
      return { outcome: 'missing', exitCode: 1, status: null, health: null, reasonCode: 'status-missing' };
    }
    const validated = readDaemonStatusRecord(read);
    if (!validated.ok) {
      return refuse('status-unreadable');
    }
    const health = evaluateDaemonStatusHealth(validated.record, nowIso, interval);
    if (health.reasons.includes('invalid-clock')) {
      return refuse('invalid-clock');
    }
    return {
      outcome: 'ok',
      exitCode: health.exitCode,
      status: validated.record,
      health,
      reasonCode: health.reasons[0] ?? null,
    };
  }

  /** The request's interval, else the policy's, else the default; a configured policy that cannot be read refuses. */
  private async resolveInterval(
    requested: unknown,
  ): Promise<number | 'invalid-interval' | 'policy-unreadable'> {
    if (requested !== undefined) {
      return isValidInterval(requested) ? requested : 'invalid-interval';
    }
    const policy = this.deps.policy;
    if (policy === undefined) {
      return DAEMON_DEFAULT_INTERVAL_SECONDS;
    }
    try {
      const answer: unknown = await policy.readMergePolicy();
      if (!isPlainObject(answer) || answer.outcome !== 'known' || !isPlainObject(answer.daemon)) {
        return 'policy-unreadable';
      }
      const interval = answer.daemon.intervalSeconds;
      return isValidInterval(interval) ? interval : 'policy-unreadable';
    } catch {
      return 'policy-unreadable';
    }
  }

  /** The raw record for `ok`, `missing`, or `unreadable` for anything else (including a throw). */
  private async readStatus(): Promise<unknown> {
    try {
      const read: unknown = await this.deps.status.read();
      if (!isPlainObject(read)) {
        return 'unreadable';
      }
      if (read.status === 'missing') {
        return 'missing';
      }
      return read.status === 'ok' ? read.record : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }
}
