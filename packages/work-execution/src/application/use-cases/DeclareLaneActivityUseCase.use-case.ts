// Implemented for lane WB4c — `plan declare`: record a lane's step declaration.
/**
 * DeclareLaneActivityUseCase records one declaration (work-board plan §3.5):
 * "declared, not observed". The declared and lapse times come from a fresh
 * clock read at the top of each call, never the body. The store keeps every
 * declaration and deletes nothing — the board, not this use case, judges
 * lapse and clears no guard.
 */

import type { LaneDeclarationRecord } from '../../domain/lane-activity-records.js';
import { parseLaneDeclarationBody } from '../../domain/lane-activity-records.js';
import { CANONICAL_ISO_PATTERN } from '../../domain/lane-plan-records.js';
import { DEFAULT_BOARD_POLICY } from '../../domain/work-board-facts.js';
import type {
  DeclareLaneActivityPort,
  DeclareLaneActivityRefusalCode,
  DeclareLaneActivityResult,
} from '../ports/in/DeclareLaneActivityPort.in-port.js';
import type { DeclarationRepositoryPort } from '../ports/out/DeclarationRepositoryPort.out-port.js';

export interface DeclareLaneActivityDependencies {
  readonly declarations: DeclarationRepositoryPort;
  /** Fresh clock, read once per call, before the record is built. */
  readonly nowIso: () => string;
  /** Defaults to the board policy's declaration TTL (90 minutes). */
  readonly ttlMinutes?: number;
}

function refusal(code: DeclareLaneActivityRefusalCode, reason: string): DeclareLaneActivityResult {
  return { outcome: 'refused', code, reason };
}

function isUsableActor(actor: unknown): actor is string {
  return typeof actor === 'string' && actor.trim().length > 0;
}

export class DeclareLaneActivityUseCase implements DeclareLaneActivityPort {
  constructor(private readonly deps: DeclareLaneActivityDependencies) {}

  async execute(body: unknown, actor: string): Promise<DeclareLaneActivityResult> {
    if (!isUsableActor(actor)) {
      return refusal('refused', 'actor must be a non-empty string');
    }
    const nowIso = this.deps.nowIso();
    if (!CANONICAL_ISO_PATTERN.test(nowIso)) {
      return refusal('clock', 'the clock returned a non-canonical time');
    }
    const ttlMinutes = this.deps.ttlMinutes ?? DEFAULT_BOARD_POLICY.declarationTtlMinutes;
    const parsed = parseLaneDeclarationBody(body, nowIso, ttlMinutes);
    if (!parsed.ok) {
      return refusal('refused', parsed.error);
    }
    return this.append(parsed.record);
  }

  private async append(record: LaneDeclarationRecord): Promise<DeclareLaneActivityResult> {
    try {
      const saved = await this.deps.declarations.append(record);
      if (saved.outcome !== 'saved') {
        return refusal('store', saved.reason);
      }
    } catch {
      return refusal('store', 'the declaration store refused the write');
    }
    return { outcome: 'declared', declaration: record, lapsesAtIso: record.lapsesAtIso };
  }
}
