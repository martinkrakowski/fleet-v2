/**
 * InspectHeadCiStateUseCase answers the CI state of one exact head as
 * `pending | passed | failed | unknown` with a reason code, over the existing
 * forge-evidence port. Unknown is never a pass and this use case never throws:
 * an unbound forge, an invalid head, a throwing or mismatched answer, no
 * checks or a not-applicable result all read as `unknown`.
 */

import type { ForgeEvidencePort, ForgeCheckStatus } from '../ports/out/ForgeEvidencePort.out-port.js';
import type {
  HeadCiReason,
  HeadCiState,
  InspectHeadCiStatePort,
  InspectHeadCiStateRequest,
  InspectHeadCiStateResult,
} from '../ports/in/InspectHeadCiStatePort.in-port.js';

export interface InspectHeadCiStateDependencies {
  readonly forgeEvidence?: ForgeEvidencePort;
}

const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

const STATE_BY_CI: ReadonlyMap<string, HeadCiState> = new Map([
  ['pass', 'passed'],
  ['fail', 'failed'],
  ['pending', 'pending'],
]);

const READ_REASON: HeadCiReason = 'read';
const UNREADABLE_REASON: HeadCiReason = 'unreadable';

function unknownResult(candidateHeadSha: string, reason: HeadCiReason): InspectHeadCiStateResult {
  return { candidateHeadSha, state: 'unknown', reason };
}

function mapReadStatus(status: ForgeCheckStatus): InspectHeadCiStateResult {
  const mapped = STATE_BY_CI.get(status.ciState);
  if (mapped === undefined) {
    // `unknown`, `not-applicable` and anything unrecognised are not a pass.
    return unknownResult(status.candidateHeadSha, UNREADABLE_REASON);
  }
  return { candidateHeadSha: status.candidateHeadSha, state: mapped, reason: READ_REASON };
}

export class InspectHeadCiStateUseCase implements InspectHeadCiStatePort {
  constructor(private readonly deps?: InspectHeadCiStateDependencies) {}

  async inspectHeadCiState(request: InspectHeadCiStateRequest): Promise<InspectHeadCiStateResult> {
    if (typeof request?.candidateHeadSha !== 'string' || !HEAD_SHA_PATTERN.test(request.candidateHeadSha)) {
      const echoed = typeof request?.candidateHeadSha === 'string' ? request.candidateHeadSha : '';
      return unknownResult(echoed, 'invalid-head');
    }
    const candidateHeadSha = request.candidateHeadSha;
    const forgeEvidence = this.deps?.forgeEvidence;
    if (forgeEvidence === undefined) {
      return unknownResult(candidateHeadSha, 'not-configured');
    }
    let status: ForgeCheckStatus;
    try {
      status = await forgeEvidence.readForgeCheckStatus({ candidateHeadSha });
    } catch {
      return unknownResult(candidateHeadSha, UNREADABLE_REASON);
    }
    // The evidence must be shown to be for the asked head; an answer read for
    // another head (wrong-head race) is unreadable, never a pass.
    if (status.candidateHeadSha !== candidateHeadSha) {
      return unknownResult(candidateHeadSha, UNREADABLE_REASON);
    }
    return mapReadStatus(status);
  }
}
