/** The `attempt` command group of the CLI driver; its entries moved verbatim from the command table. */

import { AttemptRevisionConflictError, historyEntryOf, nextAttemptRevision, SeatPlan, selectReviewSeat, selectSeat } from '@fleet/work-execution';
import { isSameModelFamily, underlyingModelFamily as evidenceFamily } from '@fleet/evidence-and-acceptance';
import { join } from 'node:path';
import type { AttemptRecord, AttemptSeatOverrideRecord, CommandCompletionReceipt } from '@fleet/work-execution';
import { unhealthySeatIdsOf } from '../seat-plan.js';
import { str, optStr, num, optNum, strArr, nested, enumOf, jsonStrArr, derivedV2Model, CliUsageError } from './payload.js';
import type { CommandHandler } from './payload.js';

export const attemptCommands: Readonly<Record<string, CommandHandler>> = {
    dispatch: async (p, rt) => {
      for (const field of [
        'model',
        'agent',
        'variant',
        'modelAssignment',
        'runnerPort',
        'remotePort',
        'runnerHost',
        'host',
      ]) {
        if (p[field] !== undefined) {
          throw new CliUsageError(
            `'${field}' is forbidden and must not be specified; the seat is determined by the frozen brief manifest`,
          );
        }
      }
      // D4: the CLI no longer accepts runner capability overrides —
      // requirements come from the brief only, so a supplied one is a usage
      // error (exit 2), never a weaker or stronger dispatch profile.
      if (p['requiredCapabilities'] !== undefined) {
        throw new CliUsageError(
          "'--requiredCapabilities' is forbidden; runner requirements come from the brief only",
        );
      }

      const attemptId = str(p, 'attemptId');
      const existing = await rt.execution.attemptRepository.findAttemptById(attemptId);
      const worktreePath = str(p, 'worktreePath');

      // Seat override from --seat-override and --override-reason
      let seatOverride = nested<AttemptSeatOverrideRecord>(p, 'seatOverride');
      const seatOverrideStr = optStr(p, 'seatOverride');
      if (!seatOverride && seatOverrideStr) {
        const colonIndex = seatOverrideStr.lastIndexOf(':');
        let model = seatOverrideStr;
        let variant: string | undefined;
        if (colonIndex !== -1 && colonIndex > seatOverrideStr.indexOf('/')) {
          model = seatOverrideStr.slice(0, colonIndex);
          variant = seatOverrideStr.slice(colonIndex + 1);
        }
        const reason = str(p, 'overrideReason');
        const setBy = str(p, 'overrideSetBy') || process.env.USER || 'operator';
        const expiresAtIso =
          optStr(p, 'overrideExpiresAt') ?? optStr(p, 'overrideExpiresAtIso') ?? '';
        const agent = optStr(p, 'overrideAgent');
        seatOverride = {
          model,
          ...(variant ? { variant } : {}),
          ...(agent ? { agent } : {}),
          reason,
          setBy,
          expiresAtIso,
        };
      } else if (seatOverride && !seatOverride.reason && optStr(p, 'overrideReason')) {
        seatOverride = { ...seatOverride, reason: str(p, 'overrideReason') };
      }

      const reviewerSeat =
        optStr(p, 'reviewerSeat') ??
        optStr(p, 'reviewerModel') ??
        existing?.reviewerSeat ??
        undefined;

      const briefPackagePath =
        str(p, 'briefPackagePath') ||
        (worktreePath === '' ? '' : join(worktreePath, '.lane', 'brief.md'));

      return rt.execution.dispatchAttempt.dispatchAttempt({
        attemptId,
        workOrderId: str(p, 'workOrderId') || existing?.workOrderId || '',
        worktreePath,
        briefPackagePath,
        briefDigest: str(p, 'briefDigest') || existing?.briefDigest || '',
        baseCommit: str(p, 'baseCommit') || existing?.baseCommit || '',
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        nowIso: optStr(p, 'nowIso'),
        seatOverride,
        reviewerSeat,
        // H9a2: a v2 installation never defaults the seat tool; v1 and
        // absent installations keep the legacy opencode default.
        installationSchemaVersion: rt.installation?.schemaVersion,
      });
    },
    reconcile: async (p, rt) =>
      rt.execution.reconcileAttempt.reconcileAttempt({
        attemptId: str(p, 'attemptId'),
        nowIso: optStr(p, 'nowIso'),
      }),
    stop: async (p, rt) =>
      rt.execution.stopAttempt.stopAttempt({
        attemptId: str(p, 'attemptId'),
        gracePeriodSeconds: optNum(p, 'gracePeriodSeconds'),
        nowIso: optStr(p, 'nowIso'),
      }),
    collect: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      if (attempt === null) {
        return { outcome: 'refused', reason: `Attempt not found: ${attemptId}` };
      }
      const receipt =
        nested<CommandCompletionReceipt>(p, 'completionReceipt') ?? attempt.completionReceipt;
      if (receipt === null || receipt === undefined) {
        return {
          outcome: 'refused',
          reason: 'Attempt has no recorded completion receipt; reconcile it first',
        };
      }
      return rt.execution.collectAttemptArtifacts.collectAttemptArtifacts({
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt.workOrderId,
        worktreePath: str(p, 'worktreePath') || attempt.worktreePath,
        baseCommit: str(p, 'baseCommit') || attempt.baseCommit,
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        completionReceipt: receipt,
      });
    },
    usage: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      if (attempt === null) {
        return { outcome: 'refused', reason: `Attempt not found: ${attemptId}` };
      }
      const measureAndSave = async (base: AttemptRecord) => {
        const measured = await rt.execution.opencodeDbUsage.readUsage({ attempt: base });
        await rt.execution.attemptRepository.saveAttempt({
          ...base,
          usage: measured.usage,
          updatedAtIso: new Date().toISOString(),
          revision: nextAttemptRevision(base),
        });
        return measured;
      };
      try {
        return await measureAndSave(attempt);
      } catch (error) {
        if (!(error instanceof AttemptRevisionConflictError)) {
          throw error;
        }
        // Re-read once and measure again from the fresh record, so an older
        // measurement (or another session's usage) never overwrites a newer one.
        const fresh = await rt.execution.attemptRepository.findAttemptById(attemptId);
        if (fresh === null) {
          return { outcome: 'refused', reason: `Attempt not found: ${attemptId}` };
        }
        return measureAndSave(fresh);
      }
    },
    fix: async (p, rt) => {
      const extra = p['unhealthySeatIds'] === undefined ? [] : jsonStrArr(p, 'unhealthySeatIds', 'attempt fix');
      const unhealthySeatIds = [...new Set([...unhealthySeatIdsOf(derivedV2Model(rt)), ...extra])];
      return rt.execution.prepareFixAttempt.prepareFixAttempt({
        fixAttemptId: str(p, 'fixAttemptId'),
        workOrderId: str(p, 'workOrderId'),
        priorAttemptId: str(p, 'priorAttemptId'),
        worktreePath: str(p, 'worktreePath'),
        baseCommit: str(p, 'baseCommit'),
        numberedFixes: strArr(p, 'numberedFixes'),
        nowIso: optStr(p, 'nowIso'),
        ...(unhealthySeatIds.length > 0 ? { unhealthySeatIds } : {}),
      });
    },
    'next-seat': async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const role = enumOf(p, 'role', ['fix', 'review'] as const, "attempt next-seat '--role'");
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      if (attempt === null) {
        return { outcome: 'refused', reason: 'Attempt not found: ' + attemptId };
      }
      if (!attempt.seatPlan) {
        return { outcome: 'refused', reason: 'Attempt ' + attemptId + ' carries no seat plan' };
      }
      const created = SeatPlan.create(attempt.seatPlan);
      if (!created.success || created.value === undefined) {
        return { outcome: 'refused', reason: 'Attempt ' + attemptId + ' carries an invalid seat plan' };
      }
      const lane = [...(await rt.execution.attemptRepository.listAttemptsByWorkOrder(attempt.workOrderId))].sort(
        (left, right) => left.createdAtIso.localeCompare(right.createdAtIso),
      );
      const unhealthySeatIds = unhealthySeatIdsOf(derivedV2Model(rt));
      const selection =
        role === 'fix'
          ? selectSeat({
              plan: created.value,
              role: 'fix',
              history: lane.map((attempt) => historyEntryOf(attempt)),
              unhealthySeatIds,
            })
          : selectReviewSeat({
              plan: created.value,
              round: attempt.fixNumber,
              implementerModels: lane
                .map((record) => record.runner?.model ?? null)
                .filter((model): model is string => typeof model === 'string' && model.trim() !== ''),
              sameFamily: (left, right) => isSameModelFamily(evidenceFamily(left), evidenceFamily(right)),
              unhealthySeatIds,
            });
      if (!selection.ok) {
        return { outcome: 'refused', reason: selection.reason };
      }
      return { outcome: 'selected', role, seatIndex: selection.seatIndex, seat: selection.seat };
    },
    accept: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      const result = await rt.execution.requestAttemptAcceptance.requestAttemptAcceptance({
        attemptId,
        candidateHeadSha: str(p, 'candidateHeadSha') || attempt?.artifacts?.headCommit || '',
        reviewerModel: str(p, 'reviewerModel'),
      });
      // A6: the accept trigger runs auto-merge in the same invocation when the
      // attempt is accepted; off leaves today's result byte-for-byte unchanged.
      if (result.outcome === 'accepted') {
        const autoMerge = await rt.execution.autoMergeAttempt.autoMergeAttempt({ attemptId });
        return autoMerge.outcome === 'off' ? result : { ...result, autoMerge };
      }
      return result;
    },
    'auto-merge': async (p, rt) =>
      rt.execution.autoMergeAttempt.autoMergeAttempt({ attemptId: str(p, 'attemptId') }),
};
