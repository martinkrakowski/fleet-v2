/**
 * StallAttentionAdapter implements StallAttentionPort by delegating in-process
 * to operator-coordination's record, clear and list attention use cases, bound
 * by the composition root (the delegate pattern of ChainAttentionAdapter).
 *
 * One item per stalled run: kind `conductor-stall`, subject `{ kind: 'run',
 * ref: <runId> }`, so a repeat refreshes the open item and a second never
 * appears. The summary is fixed text composed here from ids, the park class or the state
 * and the age rounded down to five minutes (so an item is not rewritten every
 * pass for a minute's change), and starts with the stall key `stall:<runId>`.
 * Never caller text, never a path. Clear resolves by key as `resolved` via
 * `machine`. A refused or thrown delegate call is a refusal value; the
 * adapter never throws.
 */

import { containsSecretShape } from '@fleet/shared';

import { LANE_RUN_ID_PATTERN } from '../../domain/lane-run-records.js';
import { parseParkClass } from '../../domain/park-class.js';
import { STALL_ATTENTION_KIND, stallAttentionKey } from '../../domain/stall-attention.js';
import { LANE_RUN_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type {
  ClearStallAttentionCommand,
  ClearStallAttentionResult,
  ListOpenStallAttentionResult,
  RaiseStallAttentionCommand,
  RaiseStallAttentionResult,
  StallAttentionPort,
} from '../../application/ports/out/StallAttentionPort.out-port.js';

/** The actor stall items are raised and resolved as. */
export const STALL_ATTENTION_ACTOR = 'conductor';

const CLEAR_VIA = 'machine';
const AGE_BUCKET_MINUTES = 5;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORK_ORDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface StallAttentionDelegate {
  readonly recordAttentionItem?: (body: unknown, actor: string) => Promise<unknown>;
  readonly clearAttentionItem?: (request: unknown, via: string, actor: string) => Promise<unknown>;
  readonly listAttentionItems?: (request: {
    readonly kind: string;
    readonly state: 'open';
  }) => Promise<unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own data property only: an accessor reads as undefined and never runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && LANE_RUN_ID_PATTERN.test(value);
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) && !containsSecretShape(value);
}

function validWorkOrderId(value: unknown): value is string {
  return typeof value === 'string' && WORK_ORDER_ID_PATTERN.test(value) && !containsSecretShape(value);
}

function summaryOf(runId: string, workOrderId: string, parkClass: string, ageMinutes: number): string {
  const bucket = Math.floor(ageMinutes / AGE_BUCKET_MINUTES) * AGE_BUCKET_MINUTES;
  return `${stallAttentionKey(runId)} class=${parkClass} parked>=${bucket}m work-order=${workOrderId}`;
}

function idleSummaryOf(runId: string, workOrderId: string, state: string, ageMinutes: number): string {
  const bucket = Math.floor(ageMinutes / AGE_BUCKET_MINUTES) * AGE_BUCKET_MINUTES;
  return `${stallAttentionKey(runId)} state=${state} idle>=${bucket}m work-order=${workOrderId}`;
}

export class StallAttentionAdapter implements StallAttentionPort {
  constructor(private readonly delegate?: StallAttentionDelegate) {}

  async raiseStallAttention(raw: RaiseStallAttentionCommand): Promise<RaiseStallAttentionResult> {
    try {
      const projectId = ownValue(raw, 'projectId');
      const runId = ownValue(raw, 'runId');
      const workOrderId = ownValue(raw, 'workOrderId');
      const ageMinutes = ownValue(raw, 'ageMinutes');
      const parkClass = parseParkClass(ownValue(raw, 'parkClass'));
      const state = ownValue(raw, 'state');
      const hasParkClass = ownValue(raw, 'parkClass') !== undefined;
      const hasState = state !== undefined;
      // Exactly one of `parkClass` (parked) and `state` (idle) is allowed; both or neither is malformed.
      if (hasParkClass === hasState) {
        return { outcome: 'refused', reasonCode: 'invalid-request' };
      }
      let summary: string;
      if (hasParkClass) {
        if (
          !validProjectId(projectId) ||
          !validRunId(runId) ||
          !validWorkOrderId(workOrderId) ||
          parkClass === undefined ||
          typeof ageMinutes !== 'number' ||
          !Number.isSafeInteger(ageMinutes) ||
          ageMinutes < 0
        ) {
          return { outcome: 'refused', reasonCode: 'invalid-request' };
        }
        summary = summaryOf(runId, workOrderId, parkClass, ageMinutes);
      } else {
        if (
          !validProjectId(projectId) ||
          !validRunId(runId) ||
          !validWorkOrderId(workOrderId) ||
          typeof state !== 'string' ||
          !LANE_RUN_STATES.includes(state as LaneRunStateValue) ||
          typeof ageMinutes !== 'number' ||
          !Number.isSafeInteger(ageMinutes) ||
          ageMinutes < 0
        ) {
          return { outcome: 'refused', reasonCode: 'invalid-request' };
        }
        summary = idleSummaryOf(runId, workOrderId, state, ageMinutes);
      }
      const record = this.delegate?.recordAttentionItem;
      if (record === undefined) {
        return { outcome: 'refused', reasonCode: 'not-configured' };
      }
      const answer = await record(
        {
          projectId,
          kind: STALL_ATTENTION_KIND,
          subject: { kind: 'run', ref: runId },
          workOrderId,
          summary,
        },
        STALL_ATTENTION_ACTOR,
      );
      if (
        isPlainObject(answer) &&
        (answer.outcome === 'raised' || answer.outcome === 'refreshed' || answer.outcome === 'reopened')
      ) {
        return { outcome: answer.outcome, reasonCode: null };
      }
      if (isPlainObject(answer) && answer.outcome === 'refused') {
        return { outcome: 'refused', reasonCode: typeof answer.code === 'string' ? answer.code : 'unreadable' };
      }
      return { outcome: 'refused', reasonCode: 'unreadable' };
    } catch {
      return { outcome: 'refused', reasonCode: 'unreadable' };
    }
  }

  async clearStallAttention(raw: ClearStallAttentionCommand): Promise<ClearStallAttentionResult> {
    try {
      const projectId = ownValue(raw, 'projectId');
      const runId = ownValue(raw, 'runId');
      if (!validProjectId(projectId) || !validRunId(runId)) {
        return { outcome: 'refused', reasonCode: 'invalid-request' };
      }
      const clear = this.delegate?.clearAttentionItem;
      if (clear === undefined) {
        return { outcome: 'refused', reasonCode: 'not-configured' };
      }
      const answer = await clear(
        {
          action: 'resolve',
          projectId,
          kind: STALL_ATTENTION_KIND,
          subject: { kind: 'run', ref: runId },
          reason: 'resolved',
        },
        CLEAR_VIA,
        STALL_ATTENTION_ACTOR,
      );
      if (
        isPlainObject(answer) &&
        (answer.outcome === 'cleared' || answer.outcome === 'unchanged' || answer.outcome === 'not-found')
      ) {
        return { outcome: answer.outcome, reasonCode: null };
      }
      if (isPlainObject(answer) && answer.outcome === 'refused') {
        return { outcome: 'refused', reasonCode: typeof answer.code === 'string' ? answer.code : 'unreadable' };
      }
      return { outcome: 'refused', reasonCode: 'unreadable' };
    } catch {
      return { outcome: 'refused', reasonCode: 'unreadable' };
    }
  }

  async listOpenStallAttention(): Promise<ListOpenStallAttentionResult> {
    try {
      const list = this.delegate?.listAttentionItems;
      if (list === undefined) {
        return { outcome: 'unavailable' };
      }
      const answer = await list({ kind: STALL_ATTENTION_KIND, state: 'open' });
      const entries = ownValue(answer, 'items');
      if (!Array.isArray(entries)) {
        return { outcome: 'unavailable' };
      }
      const items: ClearStallAttentionCommand[] = [];
      for (const entry of entries) {
        const item = ownValue(entry, 'item');
        const projectId = ownValue(item, 'projectId');
        const subject = ownValue(item, 'subject');
        const runId = ownValue(subject, 'ref');
        if (ownValue(item, 'kind') === STALL_ATTENTION_KIND && ownValue(subject, 'kind') === 'run' && validProjectId(projectId) && validRunId(runId)) {
          items.push({ projectId, runId });
        }
      }
      return { outcome: 'found', items };
    } catch {
      return { outcome: 'unavailable' };
    }
  }
}
