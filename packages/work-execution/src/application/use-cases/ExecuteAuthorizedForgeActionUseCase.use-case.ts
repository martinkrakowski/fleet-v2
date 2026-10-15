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
  /** Accepted-receipt id per head; a merge without a receipt is refused. */
  readonly acceptedReceiptByHead?: Readonly<Record<string, string>>;
  /**
   * Composition-root clock for journal and revision timestamps; the
   * wall-clock default is a scaffold convenience, not an authority source.
   */
  readonly now?: () => string;
}

export class ExecuteAuthorizedForgeActionUseCase implements ExecuteAuthorizedForgeActionPort {
  /** Monotonic per-instance sequence keeping journal entry ids unique. */
  private journalSequence = 0;

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

    // Merge requires current-head acceptance; old readiness is not a receipt.
    // A missing receipt registry refuses the merge unconditionally: an
    // unconfigured acceptance delegate is never a pass.
    if (
      request.kind === 'merge-pr' &&
      !deps.acceptedReceiptByHead?.[request.expectedHeadSha]
    ) {
      return {
        outcome: 'refused',
        reason: 'Cannot merge without an acceptance receipt for expectedHeadSha',
      };
    }

    const authorization = await deps.authorizationPort.consumeActionAuthorization({
      authorizationGrantId: request.authorizationGrantId,
      actionId: request.actionId,
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
    const entry: ActionJournalEntryRecord = {
      id: `forge:${request.actionId}:${status}:${++this.journalSequence}`,
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
}
