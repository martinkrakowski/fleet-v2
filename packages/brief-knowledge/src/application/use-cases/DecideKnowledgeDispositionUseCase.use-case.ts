// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * DecideKnowledgeDispositionUseCase: accept, defer, reject or flag a policy
 * proposal with checker identity and reasons. Deliberate disposition — not
 * capture — promotes a candidate into reusable context, and a policy
 * proposal never becomes an accepted keeper.
 */

import { containsSecretShape } from '@fleet/shared';
import { KnowledgeEntry } from '../../domain/entities/KnowledgeEntry.js';
import { KNOWLEDGE_DISPOSITIONS } from '../../domain/value-objects/KnowledgeDisposition.vo.js';
import { MAX_OVERRIDE_REASON_CHARS } from '../../domain/knowledge-records.js';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  DecideKnowledgeDispositionPort,
  DecideKnowledgeDispositionRequest,
  DecideKnowledgeDispositionResult,
} from '../ports/in/DecideKnowledgeDispositionPort.in-port.js';
import type {
  AppendDecisionOutcome,
  DecisionReceiptJournalPort,
} from '../ports/out/DecisionReceiptJournalPort.out-port.js';
import { CLAIM_TRIAGE_CONSUMER } from '../ports/out/DecisionReceiptJournalPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface DecideKnowledgeDispositionDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
  /**
   * When configured, every decided disposition appends a best-effort triage
   * outcome line (plan §5); a journal failure never fails the disposition.
   */
  readonly journal?: DecisionReceiptJournalPort;
}

export const POLICY_PROPOSAL_PATTERN = /\b(rules?|seats?|hosts?|permissions?|policy|policies)\b/i;

export class DecideKnowledgeDispositionUseCase implements DecideKnowledgeDispositionPort {
  constructor(private readonly deps?: DecideKnowledgeDispositionDependencies) {}

  async execute(request: DecideKnowledgeDispositionRequest): Promise<DecideKnowledgeDispositionResult> {
    return this.decideKnowledgeDisposition(request);
  }

  async decideKnowledgeDisposition(
    request: DecideKnowledgeDispositionRequest,
  ): Promise<DecideKnowledgeDispositionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: DecideKnowledgeDispositionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: DecideKnowledgeDispositionUseCase');
    }
    if (isBlank(request.entryId)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a non-empty entryId' };
    }
    if (!KNOWLEDGE_DISPOSITIONS.includes(request.disposition)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a valid disposition' };
    }
    if (isBlank(request.checkerId)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a non-empty checkerId' };
    }
    if (isBlank(request.reason)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a non-empty reason' };
    }
    // (a) The existing non-empty `reason` above stands on its own: an
    // `overrideReason` never substitutes for it. A provided one must still be
    // a usable declared field — bounded and credential-free, refused never
    // redacted.
    if (request.overrideReason !== undefined) {
      // A blank or non-string value is not refused here: for a flagged
      // acceptance check (c) below refuses it with its own reason, and an
      // unflagged disposition never records one at all.
      if (
        typeof request.overrideReason === 'string' &&
        request.overrideReason.length > MAX_OVERRIDE_REASON_CHARS
      ) {
        return {
          outcome: 'rejected',
          reason: `DecideKnowledgeDisposition requires an overrideReason of at most ${MAX_OVERRIDE_REASON_CHARS} characters`,
        };
      }
      if (containsSecretShape(request.overrideReason)) {
        return {
          outcome: 'rejected',
          reason: 'DecideKnowledgeDisposition refuses an overrideReason with a credential shape',
        };
      }
    }

    const repo = this.deps.repo;
    const entry = await repo.findEntryById(request.entryId);
    if (!entry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.entryId}` };
    }

    // (b) The policy proposal guard is unchanged and runs on its own: an
    // `overrideReason` never substitutes for the regex.
    if (request.disposition === 'accepted' && POLICY_PROPOSAL_PATTERN.test(entry.claimText)) {
      return {
        outcome: 'rejected',
        reason: 'A policy proposal never becomes an accepted keeper; coordinate it as policy',
      };
    }

    // (c) A triage flag demands a recorded justification for acceptance, in
    // addition to — never instead of — (a) and (b). Unflagged entries and
    // non-accepted dispositions never require one.
    const acceptsFlaggedCandidate =
      request.disposition === 'accepted' && entry.triageFlag !== undefined;
    if (acceptsFlaggedCandidate && isBlank(request.overrideReason)) {
      return {
        outcome: 'rejected',
        reason: 'A triage-flagged candidate cannot be accepted without a non-empty overrideReason',
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    let updated: KnowledgeEntryRecord;
    try {
      const aggregate = KnowledgeEntry.fromRecord(entry);
      updated = aggregate.decideDisposition({
        disposition: request.disposition,
        checkerId: request.checkerId,
        reason: request.reason,
        // Recorded on the entry exactly when a flagged candidate is accepted;
        // elsewhere the field is not part of the disposition.
        ...(acceptsFlaggedCandidate ? { overrideReason: request.overrideReason } : {}),
        nowIso,
      });
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    await repo.saveEntry(updated);
    await this.appendTriageOutcome(updated, request.disposition, nowIso);

    return { outcome: 'decided', entry: updated };
  }

  /**
   * Best effort by contract: the outcome joins the disposition to the
   * attempt's settled triage receipt when one exists, and any failure — a
   * journal that throws, an unwritable store, a missing receipt — never
   * fails the disposition that was already recorded.
   */
  private async appendTriageOutcome(
    entry: KnowledgeEntryRecord,
    disposition: DecideKnowledgeDispositionRequest['disposition'],
    nowIso: string,
  ): Promise<void> {
    const journal = this.deps?.journal;
    if (!journal) {
      return;
    }
    const outcome: AppendDecisionOutcome = {
      consumer: CLAIM_TRIAGE_CONSUMER,
      contextRef: `triage:${entry.sourceAttemptId}`,
      kind: 'triage-disposition',
      // Declared ids only, per the journal port: the candidate id and the
      // disposition the checker recorded. Never claim text.
      value: [entry.id, disposition],
      at: nowIso,
    };
    try {
      await journal.appendOutcome(outcome);
    } catch {
      // Recording the outcome is never worth failing the recorded disposition.
    }
  }
}

function isValidRequest(request: unknown): request is DecideKnowledgeDispositionRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
