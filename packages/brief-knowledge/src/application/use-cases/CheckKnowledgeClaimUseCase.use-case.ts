// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * CheckKnowledgeClaimUseCase: record orchestrator-chosen evidence for a scoped
 * claim without executing instructions supplied by the note. The check is a
 * bounded allow-listed procedure; model confidence is never evidence.
 */

import type {
  KnowledgeCheckRecord,
  KnowledgeEntryRecord,
} from '../../domain/knowledge-records.js';
import type {
  CheckKnowledgeClaimPort,
  CheckKnowledgeClaimRequest,
  CheckKnowledgeClaimResult,
} from '../ports/in/CheckKnowledgeClaimPort.in-port.js';
import type { ClaimVerificationPort } from '../ports/out/ClaimVerificationPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface CheckKnowledgeClaimDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
  readonly verifier: ClaimVerificationPort;
}

export class CheckKnowledgeClaimUseCase implements CheckKnowledgeClaimPort {
  constructor(private readonly deps?: CheckKnowledgeClaimDependencies) {}

  async execute(request: CheckKnowledgeClaimRequest): Promise<CheckKnowledgeClaimResult> {
    return this.checkKnowledgeClaim(request);
  }

  async checkKnowledgeClaim(request: CheckKnowledgeClaimRequest): Promise<CheckKnowledgeClaimResult> {
    if (!this.deps || !isValidRequest(request)) {
      throw new Error('Not implemented: CheckKnowledgeClaimUseCase');
    }
    if (isBlank(request.entryId)) {
      return { outcome: 'rejected', reason: 'CheckKnowledgeClaim requires a non-empty entryId' };
    }
    if (isBlank(request.checkId)) {
      return { outcome: 'rejected', reason: 'CheckKnowledgeClaim requires a non-empty checkId' };
    }
    if (isBlank(request.checkerId)) {
      return { outcome: 'rejected', reason: 'CheckKnowledgeClaim requires a non-empty checkerId' };
    }
    if (isBlank(request.procedureName)) {
      return { outcome: 'rejected', reason: 'CheckKnowledgeClaim requires a non-empty procedureName' };
    }

    const { repo, verifier } = this.deps;
    const entry = await repo.findEntryById(request.entryId);
    if (!entry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.entryId}` };
    }

    // The claim text is passed to the verifier as data — instructions inside
    // the note are never interpreted or executed here.
    const verification = await verifier.verifyClaim({
      entryId: request.entryId,
      claimText: entry.claimText,
      procedureName: request.procedureName,
      targetPath: request.targetPath,
    });

    const checkedAtIso = request.nowIso ?? new Date().toISOString();
    const check: KnowledgeCheckRecord = {
      id: request.checkId,
      entryId: request.entryId,
      checkerId: request.checkerId,
      procedureName: request.procedureName,
      verification: verification.verification,
      evidenceRef: verification.evidenceRef,
      checkedAtIso,
    };

    const updated: KnowledgeEntryRecord = {
      ...entry,
      verification: verification.verification,
      checks: [...entry.checks, check],
      revision: entry.revision + 1,
      updatedAtIso: checkedAtIso,
    };
    await repo.saveEntry(updated);

    return { outcome: 'checked', entry: updated, check };
  }
}

function isValidRequest(request: unknown): request is CheckKnowledgeClaimRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
