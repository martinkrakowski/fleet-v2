// Implemented use case — acceptance & forge station (cross-context step).
/**
 * ExecuteAuthorizedForgeActionUseCase implements
 * ExecuteAuthorizedForgeActionPort.
 *
 * It applies one scoped push/PR or merge action only after the attempt's
 * collected head matches the expected head, a merge additionally carries an
 * acceptance receipt for that head, and the authorization grant is durably
 * consumed for exactly this action. Intent is journalled before the forge
 * subprocess runs; ambiguous forge outcomes are reported for reconciliation
 * rather than guessed, and lanes gain no forge credentials here.
 */

import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionRequest,
  ExecuteAuthorizedForgeActionResult,
} from '../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { AcceptanceEvidencePort } from '../ports/out/AcceptanceEvidencePort.out-port.js';
import type { OwnerDecisionPort } from '../ports/out/OwnerDecisionPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ForgeActionPort } from '../ports/out/ForgeActionPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../domain/execution-records.js';
import { WorkOrder } from '../../domain/entities/WorkOrder.js';

export interface ExecuteAuthorizedForgeActionDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly workOrderRepo: WorkOrderRepositoryPort;
  /** Append-only evidence; the intent entry is durable before the forge runs. */
  readonly journal: ExecutionJournalPort;
  /** Durably binds one authorization grant to exactly one action. */
  readonly authorizationPort: ActionAuthorizationPort;
  /** Performs the credential-bearing forge operation behind a port. */
  readonly forgePort: ForgeActionPort;
  /** Out-port for reading acceptance assessment evidence from the evidence context. */
  readonly acceptanceEvidencePort?: AcceptanceEvidencePort;
  /**
   * Out-port for resolving the attempt's frozen one-way doors through owner
   * coordination; the same resolution acceptance uses, so a door that is now
   * undecided, declined or unknown also refuses the forge action.
   */
  readonly ownerDecisionPort?: OwnerDecisionPort;
  /** Out-port for reading the one-way doors the frozen brief named for this attempt. */
  readonly attemptOwnerDecisionPort?: AttemptOwnerDecisionPort;
  /** Non-authoritative cache of accepted-receipt id per head. */
  readonly acceptedReceiptByHead?: Readonly<Record<string, string>>;
  /**
   * Composition-root clock for journal and revision timestamps; the
   * wall-clock default is a scaffold convenience, not an authority source.
   */
  readonly now?: () => string;
}

export class ExecuteAuthorizedForgeActionUseCase implements ExecuteAuthorizedForgeActionPort {
  constructor(private readonly deps?: ExecuteAuthorizedForgeActionDependencies) {}

  async executeAuthorizedForgeAction(
    request: ExecuteAuthorizedForgeActionRequest,
  ): Promise<ExecuteAuthorizedForgeActionResult> {
    const deps = this.deps;
    if (!deps) {
      throw new Error('Not implemented: ExecuteAuthorizedForgeActionUseCase');
    }

    const attempt = await deps.attemptRepo.findAttemptById(request.attemptId);
    const workOrder = await deps.workOrderRepo.findWorkOrderById(request.workOrderId);
    if (attempt === null || workOrder === null) {
      return { outcome: 'refused', reason: 'Attempt or work order not found' };
    }

    // A moved head invalidates the readiness the action was authorised on.
    if (attempt.artifacts?.headCommit !== request.expectedHeadSha) {
      return {
        outcome: 'refused',
        reason: 'Moved head: attempt headCommit does not match expectedHeadSha',
      };
    }

    // One-way doors are re-checked at merge/push-and-open time through the
    // same owner-decision ports acceptance used: an owner decision withdrawn
    // after a stored acceptance still refuses the forge action, and the
    // refusal happens before any authorization grant is consumed.
    if (request.kind === 'merge-pr' || request.kind === 'push-and-open-pr') {
      const doorBlockers = await this.collectForgeDoorBlockers(deps, request);
      if (doorBlockers.length > 0) {
        return { outcome: 'refused', reason: doorBlockers.join('; ') };
      }
    }

    // Merge requires current-head acceptance; old readiness is not a receipt.
    // An out-port reads the evidence context's assessment; the merge proceeds
    // only when the assessment state is 'accepted', its head equals the request head,
    // its policy revision equals the attempt's, and its receipt id is non-null.
    // Stale or blocked -> refuse.
    if (request.kind === 'merge-pr') {
      if (!deps.acceptanceEvidencePort) {
        return {
          outcome: 'refused',
          reason: 'Cannot merge without a configured acceptance evidence port',
        };
      }
      let acceptance: Awaited<ReturnType<AcceptanceEvidencePort['readAcceptance']>>;
      try {
        acceptance = await deps.acceptanceEvidencePort.readAcceptance({
          attemptId: request.attemptId,
          candidateHeadSha: request.expectedHeadSha,
        });
      } catch (error: unknown) {
        // An evidence read that fails is not an absent assessment: it is an
        // unreadable one, and an unreadable assessment never merges.
        return {
          outcome: 'refused',
          reason: `Cannot merge: acceptance evidence could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (acceptance.outcome !== 'found') {
        return {
          outcome: 'refused',
          reason: `Cannot merge: acceptance assessment not found for attempt ${request.attemptId}`,
        };
      }
      const assessment = acceptance.assessment;
      if (assessment.state === 'stale') {
        return {
          outcome: 'refused',
          reason: 'Cannot merge: acceptance assessment is stale',
        };
      }
      if (assessment.state === 'blocked') {
        return {
          outcome: 'refused',
          reason: 'Cannot merge: acceptance assessment is blocked',
        };
      }
      if (assessment.state !== 'accepted') {
        return {
          outcome: 'refused',
          reason: `Cannot merge: assessment state is '${assessment.state}', expected 'accepted'`,
        };
      }
      if (assessment.candidateHeadSha !== request.expectedHeadSha) {
        return {
          outcome: 'refused',
          reason: `Cannot merge: assessment head '${assessment.candidateHeadSha}' does not match expectedHeadSha '${request.expectedHeadSha}'`,
        };
      }
      if (assessment.policyRevision !== workOrder.policyRevision) {
        return {
          outcome: 'refused',
          reason: `Cannot merge: assessment policy revision '${assessment.policyRevision}' does not match attempt policy revision '${workOrder.policyRevision}'`,
        };
      }
      if (!assessment.acceptanceReceiptId) {
        return {
          outcome: 'refused',
          reason: 'Cannot merge: acceptance assessment has no receipt ID',
        };
      }
    }

    if (typeof deps.forgePort.isConfigured === 'function' && !deps.forgePort.isConfigured()) {
      return {
        outcome: 'refused',
        reason: 'unavailable',
      };
    }

    const authorization = await deps.authorizationPort.consumeActionAuthorization({
      authorizationGrantId: request.authorizationGrantId,
      actionId: request.actionId,
      actionKind: request.kind,
      expectedHeadSha: request.expectedHeadSha,
      attemptId: request.attemptId,
    });
    if (authorization.outcome !== 'consumed') {
      await this.appendJournal(deps, request, attempt, 'refused', authorization.reason);
      return { outcome: 'refused', reason: authorization.reason };
    }

    // Intent is durable before the forge subprocess runs.
    await this.appendJournal(
      deps,
      request,
      attempt,
      'intent-recorded',
      `kind=${request.kind} expectedHeadSha=${request.expectedHeadSha}`,
    );

    const forgeResult = await deps.forgePort.performForgeAction({
      actionId: request.actionId,
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      kind: request.kind,
      expectedHeadSha: request.expectedHeadSha,
      branchName: `feat/${workOrder.laneId}`,
    });

    if (forgeResult.outcome === 'executed') {
      await this.appendJournal(
        deps,
        request,
        attempt,
        'completed',
        forgeResult.pullRequestNumber !== undefined
          ? `pull request #${forgeResult.pullRequestNumber}`
          : null,
      );
      if (request.kind === 'merge-pr') {
        await this.markMerged(deps, workOrder);
      }
      return forgeResult.pullRequestNumber !== undefined
        ? {
            outcome: 'executed',
            pullRequestNumber: forgeResult.pullRequestNumber,
            headSha: forgeResult.headSha,
          }
        : { outcome: 'executed', headSha: forgeResult.headSha };
    }
    if (forgeResult.outcome === 'ambiguous') {
      await this.appendJournal(deps, request, attempt, 'ambiguous', forgeResult.reason);
      return {
        outcome: 'refused',
        reason: `Ambiguous forge response requires reconciliation: ${forgeResult.reason}`,
      };
    }
    await this.appendJournal(deps, request, attempt, 'refused', forgeResult.reason);
    return { outcome: 'refused', reason: forgeResult.reason };
  }

  async execute(input?: unknown): Promise<ExecuteAuthorizedForgeActionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ExecuteAuthorizedForgeActionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: ExecuteAuthorizedForgeActionUseCase');
    }
    return this.executeAuthorizedForgeAction(input as ExecuteAuthorizedForgeActionRequest);
  }

  /** A completed merge advances the work order to the terminal 'merged' state. */
  private async markMerged(
    deps: ExecuteAuthorizedForgeActionDependencies,
    workOrderRecord: WorkOrderRecord,
  ): Promise<void> {
    const workOrder = WorkOrder.fromRecord(workOrderRecord);
    await deps.workOrderRepo.saveWorkOrder({
      ...workOrderRecord,
      state: 'merged',
      revision: workOrder.nextRevision(),
      updatedAtIso: deps.now?.() ?? new Date().toISOString(),
    });
  }

  private async appendJournal(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
    attempt: AttemptRecord,
    status: ActionJournalEntryRecord['status'],
    detail: string | null,
  ): Promise<void> {
    const priorEntries = await deps.journal.listJournalEntriesForAttempt(request.attemptId);
    const sequence = priorEntries.length + 1;
    const entry: ActionJournalEntryRecord = {
      id: `forge:${request.actionId}:${status}:${sequence}`,
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      action: 'forge',
      baseCommit: attempt.baseCommit,
      recordedAtIso: deps.now?.() ?? new Date().toISOString(),
      status,
      sessionId: null,
      detail,
    };
    await deps.journal.appendJournalEntry(entry);
  }

  /**
   * Merge-time re-check of the attempt's one-way doors. The doors come from
   * the attempt record through the attempt owner-decision port and every
   * reference is resolved through the same owner-decision port acceptance
   * used. An attempt recorded before doors were frozen, a reference that
   * cannot be seen approved, or an unreadable port all refuse the action.
   */
  private async collectForgeDoorBlockers(
    deps: ExecuteAuthorizedForgeActionDependencies,
    request: ExecuteAuthorizedForgeActionRequest,
  ): Promise<string[]> {
    const blockers: string[] = [];
    const attemptOwnerDecisionPort = deps.attemptOwnerDecisionPort;
    if (attemptOwnerDecisionPort === undefined) {
      return [
        `owner decision references for attempt '${request.attemptId}' could not be read: no attempt owner decision port is configured`,
      ];
    }
    let recorded: Awaited<
      ReturnType<AttemptOwnerDecisionPort['readAttemptOwnerDecisionReferences']>
    >;
    try {
      recorded = await attemptOwnerDecisionPort.readAttemptOwnerDecisionReferences({
        attemptId: request.attemptId,
      });
    } catch (error: unknown) {
      return [
        `owner decision references for attempt '${request.attemptId}' could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }
    if (recorded.outcome !== 'recorded') {
      return [
        `owner decision references for attempt '${request.attemptId}' are unknown: ${recorded.reason}`,
      ];
    }
    for (const reference of recorded.ownerDecisionReferences) {
      const ownerDecisionPort = deps.ownerDecisionPort;
      if (ownerDecisionPort === undefined) {
        blockers.push(
          `owner decision '${reference}' could not be resolved: no owner decision port is configured`,
        );
        continue;
      }
      let decision;
      try {
        decision = await ownerDecisionPort.resolveOwnerDecision({
          decisionReference: reference,
          candidateHeadSha: request.expectedHeadSha,
        });
      } catch (error: unknown) {
        blockers.push(
          `owner decision '${reference}' could not be resolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (decision.outcome === 'approved') {
        continue;
      }
      if (decision.outcome === 'not-approved') {
        blockers.push(`owner decision '${reference}' is not approved: ${decision.reason}`);
      } else {
        blockers.push(`owner decision '${reference}' is unknown: ${decision.reason}`);
      }
    }
    return blockers;
  }
}
