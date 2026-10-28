// Implemented use case — auto-merge policy station (AM4a-3, through the merge).
/**
 * AutoMergeAttemptUseCase implements AutoMergeAttemptPort.
 *
 * It decides whether one collected attempt may merge under `policy.autoMerge`
 * and routes every exception by the plan's §4 table. The setting is read
 * field by field through AutoMergeSettingsPort; `off` is today's behaviour:
 * nothing further is read and nothing is written. Records, forge history,
 * one-way doors (A4), the frozen gate and the exact-head acceptance evidence
 * follow; every failed or unexpected read ends in a not-merged outcome,
 * never in a merge.
 *
 * A `ci-pending`-only block is recorded once as a first look in the
 * execution journal (an `accept` entry with a dedicated id that can never be
 * mistaken for a stored gate outcome) and waits; the next run re-assesses at
 * the same head and a remaining `ci-pending` blocker falls to `onBlocked`.
 * No timer runs.
 *
 * An eligible attempt is granted one `merge-pr` policy grant at its accepted
 * head, the setting is re-read (A7) and a change stops before the forge, and
 * the merge runs through ExecuteAuthorizedForgeAction with the grant id and its
 * policy decision revision. Forge refusals ask the owner whatever onBlocked
 * says; an ambiguous or thrown forge outcome suspends auto-merge; a refusal
 * with no kind is a moved head only when the stored head moved. An empty
 * blocker list is never read as pending; unreadable facts route to attention
 * rather than being guessed.
 */

import type {
  AutoMergeAttemptPort,
  AutoMergeAttemptRequest,
  AutoMergeAttemptResult,
  AutoMergeRoute,
  AutoMergeRouteOutcome,
} from '../ports/in/AutoMergeAttemptPort.in-port.js';
import type { AutoMergeSettingsPort } from '../ports/out/AutoMergeSettingsPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type {
  EvaluateAttemptGatePort,
  EvaluateAttemptGateResult,
} from '../ports/in/EvaluateAttemptGatePort.in-port.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentResult,
} from '../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AutoMergeOwnerRoutingPort } from '../ports/out/AutoMergeOwnerRoutingPort.out-port.js';
import type {
  PolicyMergeGrantPort,
  PolicyMergeGrantResult,
} from '../ports/out/PolicyMergeGrantPort.out-port.js';
import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionResult,
} from '../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../domain/execution-records.js';
import type { WorkOrderStateValue } from '../../domain/value-objects/WorkOrderState.vo.js';
import { resolveWorkOrderRisk } from '../../domain/execution-records.js';
import { readExactPlainRecord } from '../../domain/plain-record-reads.js';
import {
  AUTO_MERGE_HEAD_PATTERN,
  AUTO_MERGE_ROUTE_RULE,
  autoMergeActionId,
  autoMergeBlockersOf,
  autoMergeDecisionRevision,
  autoMergeDoorsOf,
  autoMergeFirstLookEntryId,
  autoMergeForgeEntryPrefix,
  autoMergeIneligibility,
  autoMergeRoutingKey,
  isCiPendingOnly,
  readAutoMergeSettingsAnswer,
  type AutoMergeBlocker,
  type AutoMergeOnBlocked,
  type AutoMergeReason,
  type AutoMergeSettings,
} from '../../domain/auto-merge.js';

export interface AutoMergeAttemptDependencies {
  readonly settings: AutoMergeSettingsPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly attemptOwnerDecisionPort?: AttemptOwnerDecisionPort;
  readonly evaluateAttemptGate?: EvaluateAttemptGatePort;
  readonly acceptancePort?: AcceptanceAssessmentPort;
  readonly routing?: AutoMergeOwnerRoutingPort;
  readonly policyMergeGrant?: PolicyMergeGrantPort; // called in AM4a-3
  readonly executeForgeAction?: ExecuteAuthorizedForgeActionPort; // called in AM4a-3
  readonly nowIso: () => string;
}

const MAX_ATTEMPT_ID = 256;
const MAX_DETAIL_TEXT = 300;
const NOT_IMPLEMENTED = 'Not implemented: AutoMergeAttemptUseCase';

/** Everything `notMerged` needs besides the reason and detail. */
interface RoutingContext {
  readonly attemptId: string;
  readonly projectId: string | null;
  readonly workOrderId: string | null;
  readonly head: string | null;
  readonly onBlocked: AutoMergeOnBlocked | null;
  readonly routing?: AutoMergeOwnerRoutingPort;
}

export class AutoMergeAttemptUseCase implements AutoMergeAttemptPort {
  constructor(private readonly deps?: AutoMergeAttemptDependencies) {}

  async autoMergeAttempt(request: AutoMergeAttemptRequest): Promise<AutoMergeAttemptResult> {
    const deps = this.deps;
    if (!deps) {
      throw new Error(NOT_IMPLEMENTED);
    }

    // 1. Request validation: exactly one trimmed non-empty `attemptId`.
    const parsed = readExactPlainRecord(request, ['attemptId']);
    const attemptId =
      parsed !== null && typeof parsed.attemptId === 'string' ? parsed.attemptId.trim() : null;
    if (attemptId === null || attemptId.length === 0 || attemptId.length > MAX_ATTEMPT_ID) {
      return this.notMerged(emptyContext(deps), 'invalid-request', 'the request names no attempt');
    }

    // 2. The setting is read first. `off` is today's behaviour: no other port
    // is called and nothing is written. Unreadable is deferred until the work
    // order is known, so the attention item can address it.
    let settings: ReturnType<typeof readAutoMergeSettingsAnswer>;
    try {
      settings = readAutoMergeSettingsAnswer(await deps.settings.readAutoMergeSettings());
    } catch {
      settings = { kind: 'unreadable', reason: 'settings port threw' };
    }
    if (settings.kind === 'off') {
      return { outcome: 'off' };
    }

    // 3. The attempt, then its work order. A failed read is `records-unreadable`;
    // a known absence names itself. All three have no work order to address.
    let attempt: AttemptRecord | null = null;
    let workOrder: WorkOrderRecord | null = null;
    try {
      attempt = await deps.attemptRepo.findAttemptById(attemptId);
      if (attempt !== null) {
        workOrder = await deps.workOrderRepo.findWorkOrderById(attempt.workOrderId);
      }
    } catch {
      return this.notMerged(emptyContext(deps), 'records-unreadable', 'the execution records could not be read');
    }
    if (attempt === null) {
      return this.notMerged(emptyContext(deps), 'attempt-missing', 'no attempt record answers');
    }
    if (workOrder === null) {
      return this.notMerged(
        emptyContext(deps, attempt),
        'work-order-missing',
        'the attempt names no readable work order',
      );
    }

    const ctx: RoutingContext = {
      attemptId: attempt.id,
      projectId: workOrder.projectId,
      workOrderId: workOrder.id,
      head: null,
      onBlocked: settings.kind === 'on' ? settings.settings.onBlocked : null,
      routing: deps.routing,
    };

    // 4. An unreadable setting is treated as off for this run: no grant, an attention item.
    if (settings.kind === 'unreadable') {
      return this.notMerged(ctx, 'settings-unreadable', settings.reason, ['the auto-merge setting could not be read']);
    }

    // 5. Closed work orders are never auto-merged.
    if (workOrder.state === 'merged' || workOrder.state === 'stopped') {
      return this.notMerged(ctx, 'work-order-closed', 'the work order is ' + workOrder.state);
    }

    // 6. The head must be the exact collected commit id.
    const head = attempt.artifacts?.headCommit;
    if (typeof head !== 'string' || !AUTO_MERGE_HEAD_PATTERN.test(head)) {
      return this.notMerged(ctx, 'no-head', 'the attempt has no collected head commit');
    }
    const headCtx: RoutingContext = { ...ctx, head };

    // 7. Forge history: every attempt of the work order, this attempt included.
    const entries = await this.readForgeHistory(deps, workOrder.id, attempt.id);
    if (entries === null) {
      return this.notMerged(headCtx, 'forge-history-unreadable', 'the forge history could not be read', [
        'the forge history could not be read',
      ]);
    }

    // 8. Forge-history accounting for the whole work order (before doors/gate/acceptance).
    const forgeEntries = entries.filter((entry) => entry.action === 'forge');

    // 8a. This head's own action: one grant per (attempt, head), never a second.
    // Checked first: a definitive own result wins over any other unaccounted entry.
    const prefix = autoMergeForgeEntryPrefix(attempt.id, head);
    const own = forgeEntries.filter((entry) => entry.attemptId === attempt.id && entry.id.startsWith(prefix));
    const ownHasIntent = own.some((entry) => entry.status === 'intent-recorded');
    const ownHasResult = own.some(
      (entry) => entry.status === 'completed' || entry.status === 'refused' || entry.status === 'ambiguous',
    );
    if (ownHasIntent && ownHasResult) {
      return this.notMerged(headCtx, 'already-attempted', 'this head was already tried once');
    }

    // 8b. Any ambiguous forge entry suspends auto-merge for the whole work order.
    const ambiguousCount = forgeEntries.filter((entry) => entry.status === 'ambiguous').length;
    if (ambiguousCount > 0) {
      return this.notMerged(
        headCtx,
        'forge-suspended',
        ambiguousCount + ' ambiguous forge entries',
        ['an ambiguous forge entry suspends auto-merge until it is reconciled'],
      );
    }

    // 8c. This attempt's own intent with no recorded outcome suspends (today's behaviour).
    if (ownHasIntent) {
      return this.notMerged(headCtx, 'forge-suspended', 'the merge intent has no recorded outcome', [
        'the merge intent has no recorded outcome',
      ]);
    }

    // 8d. Group every forge entry by its action id; an id that cannot be parsed
    // makes the forge history unreadable.
    const groups = new Map<string, ActionJournalEntryRecord[]>();
    for (const entry of forgeEntries) {
      const actionId = parseForgeActionId(entry.id);
      if (actionId === null) {
        return this.notMerged(headCtx, 'forge-history-unreadable', 'a forge history entry id could not be read', [
          'a forge history entry id could not be read',
        ]);
      }
      const group = groups.get(actionId) ?? [];
      group.push(entry);
      groups.set(actionId, group);
    }

    // 8e. A forge action whose intent was recorded but whose outcome is unknown suspends.
    for (const group of groups.values()) {
      const groupHasIntent = group.some((entry) => entry.status === 'intent-recorded');
      const groupHasResult = group.some(
        (entry) => entry.status === 'completed' || entry.status === 'refused' || entry.status === 'ambiguous',
      );
      if (groupHasIntent && !groupHasResult) {
        return this.notMerged(headCtx, 'forge-suspended', 'a forge action has no recorded outcome', [
          'a forge action has no recorded outcome',
        ]);
      }
    }

    // 8f. A completed merge the work order does not record suspends: a merge happened
    // but was not recorded. Step 5 already excluded merged/stopped; the guard keeps
    // the rule explicit against the full state union.
    if ((workOrder.state as WorkOrderStateValue) !== 'merged') {
      for (const group of groups.values()) {
        const completedMerge = group.some((entry) => entry.status === 'completed' && isCompletedMergeEntry(entry));
        if (completedMerge) {
          return this.notMerged(headCtx, 'forge-suspended', 'a merge completed but was not recorded', [
            'a merge completed but was not recorded',
          ]);
        }
      }
    }

    // 10. One-way doors, then risk and forge mode (A4, in the domain's order).
    const doors = await this.readDoors(deps, attempt.id);
    const ineligibility = autoMergeIneligibility({
      doors,
      risk: resolveWorkOrderRisk(workOrder),
      allowHighRisk: settings.settings.allowHighRisk,
      forgeMode: settings.settings.forgeMode,
    });
    if (ineligibility !== null) {
      return this.notMerged(headCtx, ineligibility, 'needs an owner merge', ['needs an owner merge']);
    }

    // 11. The frozen gate answers first; anything but `passed` blocks.
    if (!deps.evaluateAttemptGate) {
      return this.notMerged(headCtx, 'gate-not-passed', 'gate port not wired', ['gate port not wired']);
    }
    let verdict: EvaluateAttemptGateResult;
    try {
      verdict = await deps.evaluateAttemptGate.evaluateAttemptGate({ attemptId: attempt.id, candidateHeadSha: head });
    } catch {
      return this.notMerged(headCtx, 'gate-not-passed', 'the gate evaluation threw', ['the gate evaluation threw']);
    }
    if (verdict.verdict !== 'passed') {
      const line = verdict.reason.slice(0, MAX_DETAIL_TEXT);
      return this.notMerged(headCtx, 'gate-not-passed', line, [line]);
    }

    // 12. Exact-head acceptance evidence; a receipt for another head is stale.
    if (!deps.acceptancePort) {
      return this.notMerged(headCtx, 'acceptance-unreadable', 'acceptance port not wired', [
        'the acceptance evidence could not be read',
      ]);
    }
    let assessment: AcceptanceAssessmentResult;
    try {
      assessment = await deps.acceptancePort.assessHeadAcceptance({
        attemptId: attempt.id,
        workOrderId: workOrder.id,
        candidateHeadSha: head,
        policyRevision: workOrder.policyRevision,
      });
    } catch {
      return this.notMerged(headCtx, 'acceptance-unreadable', 'the acceptance evidence could not be read', [
        'the acceptance evidence could not be read',
      ]);
    }

    if (assessment.outcome === 'accepted') {
      const stale =
        assessment.assessedHeadSha !== head ||
        typeof assessment.receiptId !== 'string' ||
        assessment.receiptId.length === 0;
      if (stale) {
        return this.notMerged(headCtx, 'acceptance-blocked', 'the acceptance evidence is stale', [
          'stale: the acceptance evidence does not cover this head',
        ]);
      }
      // Eligible: one grant, an A7 re-read, then the merge.
      return this.performMerge(deps, headCtx, attempt, workOrder, head, assessment.receiptId, settings.settings);
    }
    const blockers: readonly AutoMergeBlocker[] = autoMergeBlockersOf(
      assessment.outcome === 'rejected' || assessment.outcome === 'unknown' ? assessment.blockerDetails : undefined,
      'acceptance did not pass',
    );

    // 13. A `ci-pending`-only block gets exactly one first look.
    if (!isCiPendingOnly(blockers)) {
      return this.notMerged(headCtx, 'acceptance-blocked', 'acceptance did not pass', blockers.map((b) => b.text));
    }

    let recentEntries: readonly ActionJournalEntryRecord[];
    try {
      recentEntries = await deps.journal.listJournalEntriesForAttempt(attempt.id);
    } catch {
      return this.notMerged(headCtx, 'first-look-unrecorded', 'the journal could not be re-read');
    }
    const firstLookId = autoMergeFirstLookEntryId(attempt.id, head);
    const firstLook = recentEntries.find((entry) => entry.id === firstLookId) ?? null;
    if (firstLook === null) {
      const recordedAtIso = deps.nowIso();
      try {
        await deps.journal.appendJournalEntry({
          id: firstLookId,
          attemptId: attempt.id,
          workOrderId: workOrder.id,
          action: 'accept',
          status: 'refused',
          baseCommit: attempt.baseCommit,
          recordedAtIso,
          sessionId: null,
          detail: 'auto-merge first look: ci-pending',
        });
      } catch {
        return this.notMerged(headCtx, 'first-look-unrecorded', 'the first look could not be recorded');
      }
      return { outcome: 'waiting', reason: 'ci-pending-first-look', headSha: head, firstLookAtIso: recordedAtIso };
    }

    // 14. The second look: a remaining `ci-pending` blocker falls to `onBlocked`.
    const firstLookAt = firstLook.recordedAtIso;
    return this.notMerged(
      headCtx,
      'ci-pending-second-look',
      'first look at ' + firstLookAt,
      blockers.map((blocker) => blocker.text),
    );
  }

  async execute(input?: unknown): Promise<AutoMergeAttemptResult> {
    if (!this.deps || !input || typeof input !== 'object') {
      throw new Error(NOT_IMPLEMENTED);
    }
    return this.autoMergeAttempt(input as AutoMergeAttemptRequest);
  }

  /** Every attempt of the work order plus this one, deduplicated, read concurrently. */
  private async readForgeHistory(
    deps: AutoMergeAttemptDependencies,
    workOrderId: string,
    attemptId: string,
  ): Promise<readonly ActionJournalEntryRecord[] | null> {
    let attemptIds: string[];
    try {
      const listed = await deps.attemptRepo.listAttemptsByWorkOrder(workOrderId);
      const ids = new Set<string>(listed.map((record) => record.id));
      ids.add(attemptId);
      attemptIds = [...ids];
    } catch {
      return null;
    }
    try {
      const listed = await Promise.all(attemptIds.map((id) => deps.journal.listJournalEntriesForAttempt(id)));
      return listed.flat();
    } catch {
      return null;
    }
  }

  private async readDoors(deps: AutoMergeAttemptDependencies, attemptId: string) {
    if (!deps.attemptOwnerDecisionPort) {
      return { kind: 'unreadable' as const };
    }
    try {
      return await deps.attemptOwnerDecisionPort
        .readAttemptOwnerDecisionReferences({ attemptId })
        .then((answer) => autoMergeDoorsOf(answer));
    } catch {
      return { kind: 'unreadable' as const };
    }
  }

  /**
   * AM4a-3 step 4.4: the eligible attempt gets one policy grant, the setting is
   * re-read (A7), and the merge runs through ExecuteAuthorizedForgeAction with
   * the grant id and the policy decision revision. Every §4 forge exception is
   * routed here; an ambiguous or thrown forge outcome suspends auto-merge.
   */
  private async performMerge(
    deps: AutoMergeAttemptDependencies,
    ctx: RoutingContext,
    attempt: AttemptRecord,
    workOrder: WorkOrderRecord,
    head: string,
    receiptId: string,
    settings: AutoMergeSettings,
  ): Promise<AutoMergeAttemptResult> {
    // 1. Both dependencies are required; otherwise the merge is not wired.
    if (!deps.policyMergeGrant || !deps.executeForgeAction) {
      return this.notMerged(ctx, 'merge-not-wired', 'the merge step is not wired yet');
    }

    // 2. One policy grant for this head. A refusal, a throw or an unexpected
    // answer is a refused grant; a superseded grant is noted and not routed.
    let grant: PolicyMergeGrantResult;
    try {
      grant = await deps.policyMergeGrant.issuePolicyMergeGrant({
        projectId: workOrder.projectId,
        workOrderId: workOrder.id,
        attemptId: attempt.id,
        expectedHeadSha: head,
        policyRevision: workOrder.policyRevision,
        acceptanceReceiptId: receiptId,
        settingRevision: settings.revision,
      });
    } catch {
      return this.notMerged(ctx, 'grant-refused', 'the policy grant could not be issued', [
        'the policy grant could not be issued',
      ]);
    }
    if (grant.outcome === 'superseded') {
      return this.notMerged(ctx, 'grant-superseded', 'the grant was superseded');
    }
    if (grant.outcome === 'refused') {
      const line = grant.reason.slice(0, MAX_DETAIL_TEXT);
      return this.notMerged(ctx, 'grant-refused', line, [line]);
    }
    if (grant.outcome !== 'issued') {
      return this.notMerged(ctx, 'grant-refused', 'the grant answer was unexpected', [
        'the grant answer was unexpected',
      ]);
    }
    if (
      typeof grant.grantId !== 'string' ||
      grant.grantId.trim() === '' ||
      grant.decisionRevision !== autoMergeDecisionRevision(settings.revision)
    ) {
      return this.notMerged(ctx, 'grant-revision-mismatch', 'the grant does not name the setting revision', [
        'the grant does not name the setting revision',
      ]);
    }

    // 3. A7: the setting is re-read; a change stops before the forge and leaves
    // the grant unspent for the writer to cancel.
    let reread: ReturnType<typeof readAutoMergeSettingsAnswer>;
    try {
      reread = readAutoMergeSettingsAnswer(await deps.settings.readAutoMergeSettings());
    } catch {
      reread = { kind: 'unreadable', reason: 'settings port threw' };
    }
    if (
      reread.kind !== 'on' ||
      reread.settings.revision !== settings.revision ||
      reread.settings.forgeMode !== settings.forgeMode
    ) {
      return this.notMerged(ctx, 'setting-changed', 'the auto-merge setting changed after the grant was issued');
    }

    // 4. The merge runs only at the same head, with the grant and the decision
    // revision that authorised it (A8).
    let forgeResult: ExecuteAuthorizedForgeActionResult;
    try {
      forgeResult = await deps.executeForgeAction.executeAuthorizedForgeAction({
        actionId: autoMergeActionId(attempt.id, head),
        attemptId: attempt.id,
        workOrderId: workOrder.id,
        kind: 'merge-pr',
        expectedHeadSha: head,
        authorizationGrantId: grant.grantId,
        authorizedBy: grant.decisionRevision,
      });
    } catch {
      return this.notMerged(ctx, 'forge-ambiguous', 'the forge action threw', ['the forge action threw']);
    }
    if (forgeResult.outcome === 'executed') {
      return {
        outcome: 'merged',
        attemptId: attempt.id,
        headSha: head,
        ...(forgeResult.pullRequestNumber !== undefined ? { pullRequestNumber: forgeResult.pullRequestNumber } : {}),
        decisionRevision: grant.decisionRevision,
      };
    }
    if (forgeResult.forgeAmbiguous === true) {
      return this.notMerged(ctx, 'forge-ambiguous', forgeResult.reason, [forgeResult.reason]);
    }
    if (forgeResult.forgeRefusalKind !== undefined) {
      return this.notMerged(ctx, 'forge-refused', forgeResult.reason, [
        'refusal kind: ' + forgeResult.forgeRefusalKind,
        forgeResult.reason.slice(0, MAX_DETAIL_TEXT),
      ]);
    }
    // A refusal with no forge kind: a moved head goes back through acceptance at
    // its new head; otherwise the refusal happened before the grant was spent.
    let currentAttempt: AttemptRecord | null;
    try {
      currentAttempt = await deps.attemptRepo.findAttemptById(attempt.id);
    } catch {
      currentAttempt = null;
    }
    if (currentAttempt === null || currentAttempt.artifacts?.headCommit !== head) {
      return this.notMerged(ctx, 'head-moved', 'the attempt head moved during the merge attempt');
    }
    return this.notMerged(ctx, 'forge-refused-before-grant', forgeResult.reason, [
      forgeResult.reason.slice(0, MAX_DETAIL_TEXT),
    ]);
  }

  /**
   * Build the not-merged result and route it. The route follows the plan's §4
   * table; `on-blocked` resolves through the setting. A routing failure never
   * changes the outcome.
   */
  private async notMerged(
    ctx: RoutingContext,
    reason: AutoMergeReason,
    detail: string | null,
    lines: readonly string[] = [],
  ): Promise<AutoMergeAttemptResult> {
    const rule = AUTO_MERGE_ROUTE_RULE[reason];
    let route: AutoMergeRoute = rule === 'on-blocked' ? (ctx.onBlocked === 'ask-owner' ? 'owner-question' : 'attention') : rule;
    let routeOutcome: AutoMergeRouteOutcome = 'none';
    if (route !== 'none' && ctx.workOrderId !== null && ctx.projectId !== null) {
      if (!ctx.routing) {
        routeOutcome = 'not-wired';
      } else {
        const notice = {
          key: autoMergeRoutingKey(ctx.attemptId, ctx.head, reason),
          projectId: ctx.projectId,
          workOrderId: ctx.workOrderId,
          attemptId: ctx.attemptId,
          headSha: ctx.head,
          reason,
          lines,
        };
        try {
          const answer =
            route === 'attention' ? await ctx.routing.recordAttention(notice) : await ctx.routing.askOwner(notice);
          routeOutcome = answer.outcome;
        } catch {
          routeOutcome = 'failed';
        }
      }
    }
    if (route === 'none' || ctx.workOrderId === null || ctx.projectId === null) {
      route = 'none';
      routeOutcome = 'none';
    }
    return { outcome: 'not-merged', reason, route, routeOutcome, detail };
  }
}

/**
 * The action id of a forge journal entry: the part of the id between `forge:`
 * and the trailing `:<status>:<seq>`. Parsed from the right so action ids that
 * themselves contain `:` still parse; null when the id is not parseable.
 */
const FORGE_ENTRY_STATUSES: readonly string[] = ['intent-recorded', 'completed', 'refused', 'ambiguous'];

/** `forge:<actionId>:<status>:<seq>`, parsed from the right; any malformed part makes the id unreadable. */
function parseForgeActionId(id: string): string | null {
  if (!id.startsWith('forge:')) {
    return null;
  }
  const parts = id.slice('forge:'.length).split(':');
  if (parts.length < 3) {
    return null;
  }
  const seq = parts[parts.length - 1];
  const status = parts[parts.length - 2];
  const actionId = parts.slice(0, parts.length - 2).join(':');
  if (!/^[1-9][0-9]{0,8}$/.test(seq) || !FORGE_ENTRY_STATUSES.includes(status) || actionId === '' || actionId.startsWith(':') || actionId.endsWith(':')) {
    return null;
  }
  return actionId;
}

/**
 * True when a completed forge entry records a merge rather than another forge
 * action. The executor writes `pull request #<n>` for a push-and-open and no
 * PR number for a merge; when the kind cannot be told from the entry it is
 * treated as a merge (fail closed).
 */
function isCompletedMergeEntry(entry: ActionJournalEntryRecord): boolean {
  return typeof entry.detail !== 'string' || !/\bpull request\b/.test(entry.detail);
}

function emptyContext(deps: AutoMergeAttemptDependencies, attempt?: AttemptRecord): RoutingContext {
  return {
    attemptId: attempt?.id ?? '',
    projectId: null,
    workOrderId: null,
    head: null,
    onBlocked: null,
    routing: deps.routing,
  };
}
