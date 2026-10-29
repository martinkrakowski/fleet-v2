// Implemented adapter — conductor gate receipts (KF-13a).
/**
 * GateReceiptAdapter implements GateReceiptPort by in-process delegation to
 * the evidence context's RecordVerificationReceipt use case. It owns every
 * mapping; the composition root only binds the delegates. It never throws:
 * every failure is a typed unavailable result, and receipts are recorded in
 * order, stopping at the first rejection (never a partial guess).
 */

import type {
  EvidenceResultValue,
  VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import type { GatePredicateVerdict } from '../../application/ports/out/GatePredicatePort.out-port.js';
import type {
  GateReceiptPort,
  RecordGateReceiptsRequest,
  RecordGateReceiptsResult,
} from '../../application/ports/out/GateReceiptPort.out-port.js';

export interface GateReceiptDelegates {
  readonly recordVerificationReceipt: (request: {
    readonly assessmentId: string;
    readonly receipt: VerificationReceiptRecord;
  }) => Promise<
    { readonly outcome: 'recorded' } | { readonly outcome: 'rejected'; readonly reason: string }
  >;
  readonly assessmentIdOf: (attemptId: string) => string;
  readonly receiptIdOf?: (attemptId: string, procedureName: string, head: string) => string;
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The gate verdict → evidence result mapping: `pass` is a passing result,
 * `fail` is the failing one, and `unknown`/`skipped` map to the non-passing
 * value that means not established — never a passing value.
 */
function resultOf(verdict: GatePredicateVerdict): EvidenceResultValue {
  if (verdict === 'pass') {
    return 'pass';
  }
  if (verdict === 'fail') {
    return 'fail';
  }
  return 'unknown';
}

function defaultReceiptId(attemptId: string, procedureName: string, head: string): string {
  return 'verify-' + attemptId + '-' + procedureName + '-' + head.slice(0, 12);
}

export class GateReceiptAdapter implements GateReceiptPort {
  constructor(private readonly delegates: GateReceiptDelegates) {}

  async recordGateReceipts(request: RecordGateReceiptsRequest): Promise<RecordGateReceiptsResult> {
    const { recordVerificationReceipt, assessmentIdOf, receiptIdOf } = this.delegates;
    const assessmentId = assessmentIdOf(request.attemptId);
    if (!isNonEmptyTrimmed(assessmentId)) {
      return { outcome: 'unavailable', reason: 'No assessment exists for the attempt' };
    }
    let recordedCount = 0;
    for (const receipt of request.receipts) {
      const id =
        receiptIdOf === undefined
          ? defaultReceiptId(request.attemptId, receipt.procedureName, request.candidateHeadSha)
          : receiptIdOf(request.attemptId, receipt.procedureName, request.candidateHeadSha);
      const verificationReceipt: VerificationReceiptRecord = {
        id,
        assessmentId,
        projectId: request.projectId,
        attemptId: request.attemptId,
        candidateHeadSha: request.candidateHeadSha,
        hostId: request.hostId,
        procedureName: receipt.procedureName,
        result: resultOf(receipt.result),
        exitCode: receipt.exitCode,
        ...(receipt.coverage !== undefined ? { coverage: receipt.coverage } : {}),
        evidenceRef: request.evidenceRef,
        policyRevision: request.policyRevision,
        completedAtIso: request.completedAtIso,
      };
      let outcome: { readonly outcome: 'recorded' } | {
        readonly outcome: 'rejected';
        readonly reason: string;
      };
      try {
        outcome = await recordVerificationReceipt({ assessmentId, receipt: verificationReceipt });
      } catch {
        return { outcome: 'unavailable', reason: 'The evidence context could not record the receipt' };
      }
      if (outcome.outcome === 'rejected') {
        return { outcome: 'unavailable', reason: outcome.reason };
      }
      recordedCount += 1;
    }
    return { outcome: 'recorded', count: recordedCount };
  }
}
