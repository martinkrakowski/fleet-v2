// @generated outbound contract scaffold — refined for step 4.
/**
 * Run allow-listed checks on the configured verification host and return
 * completed command receipts.
 */

import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';
import type { CheckCoverage } from '../../../domain/check-coverage.js';

export interface ExecuteVerificationCheckRequest {
  readonly hostId: string;
  readonly candidateHeadSha: string;
  readonly procedureName: string;
}

export interface ExecuteVerificationCheckResult {
  readonly result: EvidenceResultValue;
  readonly exitCode: number | null;
  readonly coverage?: CheckCoverage;
  readonly outputSummary: string;
  readonly completedAtIso: string;
}

export interface VerificationExecutorPort {
  executeVerificationCheck(request: ExecuteVerificationCheckRequest): Promise<ExecuteVerificationCheckResult>;
}
