// Implemented for lane WB4c — `plan brief-check`: record one brief-file read.
/**
 * RecordBriefReadUseCase records one brief read (work-board plan §3.6): the
 * read moment comes from a fresh clock read at the top of each call, never
 * the body. A `failed` read is a valid record — the board names a failed
 * last read beside the guard — and stores null digest and byte count,
 * echoing nothing from the body.
 */

import type { BriefReadRecord } from '../../domain/lane-activity-records.js';
import { parseBriefReadBody } from '../../domain/lane-activity-records.js';
import { CANONICAL_ISO_PATTERN } from '../../domain/lane-plan-records.js';
import type {
  RecordBriefReadPort,
  RecordBriefReadRefusalCode,
  RecordBriefReadResult,
} from '../ports/in/RecordBriefReadPort.in-port.js';
import type { BriefReadRepositoryPort } from '../ports/out/BriefReadRepositoryPort.out-port.js';

export interface RecordBriefReadDependencies {
  readonly briefReads: BriefReadRepositoryPort;
  /** Fresh clock, read once per call, before the record is built. */
  readonly nowIso: () => string;
}

function refusal(code: RecordBriefReadRefusalCode, reason: string): RecordBriefReadResult {
  return { outcome: 'refused', code, reason };
}

function isUsableActor(actor: unknown): actor is string {
  return typeof actor === 'string' && actor.trim().length > 0;
}

export class RecordBriefReadUseCase implements RecordBriefReadPort {
  constructor(private readonly deps: RecordBriefReadDependencies) {}

  async execute(body: unknown, actor: string): Promise<RecordBriefReadResult> {
    if (!isUsableActor(actor)) {
      return refusal('refused', 'actor must be a non-empty string');
    }
    const nowIso = this.deps.nowIso();
    if (!CANONICAL_ISO_PATTERN.test(nowIso)) {
      return refusal('clock', 'the clock returned a non-canonical time');
    }
    const parsed = parseBriefReadBody(body, nowIso);
    if (!parsed.ok) {
      return refusal('refused', parsed.error);
    }
    return this.put(parsed.record);
  }

  private async put(record: BriefReadRecord): Promise<RecordBriefReadResult> {
    try {
      const saved = await this.deps.briefReads.put(record);
      if (saved.outcome !== 'saved') {
        return refusal('store', saved.reason);
      }
    } catch {
      return refusal('store', 'the brief-read store refused the write');
    }
    return { outcome: 'recorded', read: record };
  }
}
