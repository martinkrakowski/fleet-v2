/** The `evidence` command group of the CLI driver; its entries moved verbatim from the command table. */

import { resolveInstallationHostForRole } from '@fleet/work-execution';
import type { FindingDispositionRecord, ReviewKind, ReviewReceiptRecord, VerificationReceiptRecord } from '@fleet/evidence-and-acceptance';
import { str, optStr, evidenceAssessmentId, strArr, requiredNested, bindImplementerSeat, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const evidenceCommands: Readonly<Record<string, CommandHandler>> = {
    'request-verification': async (p, rt) => {
      // A v2 installation names the verifier host itself (plan section 8);
      // the operator never supplies one. The host comes from the
      // installation's hosts entry — the verifier host's name, and with no
      // verifier role the orchestrator host's name, so verification runs
      // locally instead of being refused (plan section 3: "none: local").
      // A usage error precedes the seat binding: no domain lookup is owed to
      // a request the boundary refuses.
      const v2HostId =
        resolveInstallationHostForRole(rt.installation, 'verifier') ??
        resolveInstallationHostForRole(rt.installation, 'orchestrator');
      if (rt.installation?.schemaVersion === 2) {
        if (p['hostId'] !== undefined) {
          throw new CliUsageError(
            "'hostId' is not accepted for a v2 installation; the host comes from the installation's hosts entry (the verifier host's name, or the orchestrator's when none is a verifier)",
          );
        }
      }
      // The assessment records the attempt's own implementer seat at creation;
      // an unresolvable seat is a typed rejection, never an assumed model.
      const seat = await bindImplementerSeat(rt, p);
      if (!seat.bound) {
        return seat.rejection;
      }
      return rt.evidence.requestVerification.requestVerification({
        assessmentId: evidenceAssessmentId(p),
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        hostId: v2HostId ?? str(p, 'hostId'),
        implementerModel: seat.implementerModel,
        requiredChecks: strArr(p, 'requiredChecks'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'record-verification': async (p, rt) => {
      const receipt = requiredNested<VerificationReceiptRecord>(p, 'receipt', 'evidence record-verification');
      return rt.evidence.recordVerificationReceipt.recordVerificationReceipt({
        assessmentId: evidenceAssessmentId(p, receipt.attemptId),
        receipt,
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'request-review': async (p, rt) => {
      const seat = await bindImplementerSeat(rt, p);
      if (!seat.bound) {
        return seat.rejection;
      }
      const kind = str(p, 'kind');
      const requestId = optStr(p, 'requestId');
      return rt.evidence.requestIndependentReview.requestIndependentReview({
        assessmentId: evidenceAssessmentId(p),
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        implementerModel: seat.implementerModel,
        reviewerModel: str(p, 'reviewerModel'),
        diffSummary: optStr(p, 'diffSummary'),
        nowIso: optStr(p, 'nowIso'),
        // Conductor fields are forwarded only when present, so existing manual
        // payloads are unchanged and the use case validates them.
        ...(kind !== '' ? { kind: kind as ReviewKind } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    },
    'record-review': async (p, rt) => {
      const seat = await bindImplementerSeat(rt, p);
      if (!seat.bound) {
        return seat.rejection;
      }
      const receipt = requiredNested<ReviewReceiptRecord>(p, 'receipt', 'evidence record-review');
      const supplied = receipt.implementerModel;
      if (typeof supplied === 'string' && supplied.trim() !== '' && supplied.trim() !== seat.implementerModel) {
        throw new CliUsageError(
          `evidence record-review refuses implementerModel '${supplied.trim()}': attempt '${str(p, 'attemptId')}' was dispatched on seat '${seat.implementerModel}'`,
        );
      }
      // The receipt's implementer field restates the recorded seat; it is
      // bound, never caller-authored.
      return rt.evidence.recordReviewReceipt.recordReviewReceipt({
        assessmentId: evidenceAssessmentId(p, receipt.attemptId),
        receipt: { ...receipt, implementerModel: seat.implementerModel },
        nowIso: optStr(p, 'nowIso'),
      });
    },
    disposition: async (p, rt) =>
      rt.evidence.recordFindingDisposition.recordFindingDisposition({
        assessmentId: evidenceAssessmentId(p),
        disposition: requiredNested<FindingDispositionRecord>(p, 'disposition', 'evidence disposition'),
        nowIso: optStr(p, 'nowIso'),
      }),
    assess: async (p, rt) => {
      // Owner decision references are frozen into the brief package and read
      // from the attempt record; supplying them here would let a caller name
      // the one-way doors it is judged against.
      if (p['ownerDecisionReferences'] !== undefined) {
        throw new CliUsageError(
          "'--ownerDecisionReferences' is forbidden; owner decisions come from the attempt record",
        );
      }
      return rt.evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId: evidenceAssessmentId(p),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    inspect: async (p, rt) =>
      rt.evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
        assessmentId: optStr(p, 'assessmentId'),
        candidateHeadSha: optStr(p, 'candidateHeadSha'),
      }),
};
