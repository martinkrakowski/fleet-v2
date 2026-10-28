// Implemented adapter — conductor review & CI station (cross-context step).
/**
 * CiStateAdapter implements CiStatePort by in-process delegation to the
 * evidence context's InspectHeadCiState use case. Unknown is never a pass:
 * an invalid head, an unconfigured delegate, a throw, a mismatched head or an
 * unreadable answer all answer `unknown` with a reason code.
 */

import { HEAD_CI_REASONS, HEAD_CI_STATES } from '@fleet/evidence-and-acceptance';
import type {
  InspectHeadCiStatePort,
  InspectHeadCiStateResult,
} from '@fleet/evidence-and-acceptance';
import type {
  CiStatePort,
  HeadCiStateRead,
  ReadHeadCiStateRequest,
} from '../../application/ports/out/CiStatePort.out-port.js';

const HEAD_PATTERN = /^[0-9a-f]{40}$/;
const HEAD_CI_STATE_VALUES: readonly string[] = HEAD_CI_STATES;
const HEAD_CI_REASON_VALUES: readonly string[] = HEAD_CI_REASONS;

export interface CiStateDelegates {
  readonly inspectHeadCiState?: InspectHeadCiStatePort['inspectHeadCiState'];
}

function isHeadCiState(value: unknown): boolean {
  return typeof value === 'string' && HEAD_CI_STATE_VALUES.includes(value);
}

function isHeadCiReason(value: unknown): boolean {
  return typeof value === 'string' && HEAD_CI_REASON_VALUES.includes(value);
}

export class CiStateAdapter implements CiStatePort {
  constructor(private readonly delegates: CiStateDelegates = {}) {}

  async readHeadCiState({ headSha }: ReadHeadCiStateRequest): Promise<HeadCiStateRead> {
    if (!HEAD_PATTERN.test(headSha)) {
      return { headSha, state: 'unknown', reason: 'invalid-head' };
    }
    if (!this.delegates.inspectHeadCiState) {
      return { headSha, state: 'unknown', reason: 'not-configured' };
    }
    let answer: InspectHeadCiStateResult;
    try {
      answer = await this.delegates.inspectHeadCiState({ candidateHeadSha: headSha });
    } catch {
      return { headSha, state: 'unknown', reason: 'unreadable' };
    }
    if (
      answer.candidateHeadSha !== headSha ||
      !isHeadCiState(answer.state) ||
      !isHeadCiReason(answer.reason) ||
      (answer.reason === 'read' && answer.state === 'unknown')
    ) {
      return { headSha, state: 'unknown', reason: 'unreadable' };
    }
    return { headSha, state: answer.state, reason: answer.reason };
  }
}
