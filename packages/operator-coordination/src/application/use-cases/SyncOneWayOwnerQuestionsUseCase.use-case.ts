/**
 * SyncOneWayOwnerQuestionsUseCase implements SyncOneWayOwnerQuestionsPort. For
 * each open one-way owner question it reads the linked coordination request
 * and its verified decision through the existing DecisionTransportPort: a
 * verified approved answer moves the question to answered (shape accept,
 * answeredVia signed-decision); a verified declined answer moves it to
 * rejected; anything else — awaiting, unverified or unreadable — leaves the
 * question unchanged.
 *
 * The decision transport and the coordination request are only ever read: no
 * step of a sync writes a CoordinationRequest, and only a signed decision
 * answers a one-way question. The answered-at moment comes from the injected
 * clock, and a save that loses a revision race leaves the question for the
 * next run.
 */

import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import { OwnerQuestion } from '../../domain/entities/OwnerQuestion.js';
import type { OwnerQuestionClock } from '../ports/in/AskOwnerQuestionPort.in-port.js';
import type {
  SyncOneWayOwnerQuestionsPort,
  SyncOneWayOwnerQuestionsResult,
} from '../ports/in/SyncOneWayOwnerQuestionsPort.in-port.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { DecisionTransportPort } from '../ports/out/DecisionTransportPort.out-port.js';
import type { OwnerQuestionRepositoryPort } from '../ports/out/OwnerQuestionRepositoryPort.out-port.js';

export interface SyncOneWayOwnerQuestionsDependencies {
  readonly ownerQuestionRepo: OwnerQuestionRepositoryPort;
  readonly requestRepo: CoordinationRequestRepositoryPort;
  readonly decisionTransport: DecisionTransportPort;
  readonly clock: OwnerQuestionClock;
}

export class SyncOneWayOwnerQuestionsUseCase implements SyncOneWayOwnerQuestionsPort {
  constructor(private readonly deps?: SyncOneWayOwnerQuestionsDependencies) {}

  async syncOneWayOwnerQuestions(): Promise<SyncOneWayOwnerQuestionsResult> {
    return this.execute();
  }

  async execute(): Promise<SyncOneWayOwnerQuestionsResult> {
    // Unconfigured is 501 and is checked before any work is done.
    if (!this.deps) {
      throw new Error('Not implemented: SyncOneWayOwnerQuestionsUseCase');
    }
    const open = await this.deps.ownerQuestionRepo.list({ state: 'open' });
    const answered: OwnerQuestionRecord[] = [];
    const rejected: OwnerQuestionRecord[] = [];
    const unchanged: OwnerQuestionRecord[] = [];

    for (const record of open) {
      if (record.doorKind !== 'one-way') {
        continue;
      }
      const linkedRequestId = record.linkedRequestId;
      if (linkedRequestId === null) {
        unchanged.push(record);
        continue;
      }
      // The linked request is only ever read, never written.
      let linked: Awaited<ReturnType<typeof this.deps.requestRepo.findRequestById>>;
      try {
        linked = await this.deps.requestRepo.findRequestById(linkedRequestId);
      } catch {
        unchanged.push(record);
        continue;
      }
      if (linked === null) {
        unchanged.push(record);
        continue;
      }
      let state: 'approved' | 'declined' | 'awaiting-decision';
      try {
        const answer = await this.deps.decisionTransport.readDecisionAnswer({
          requestId: linked.id,
          projectId: linked.projectId,
          actionScope: linked.actionScope,
          expectedHeadSha: linked.expectedHeadSha,
        });
        state = answer.state;
      } catch {
        // An unreadable decision is unchanged, never an approval or refusal.
        unchanged.push(record);
        continue;
      }

      if (state !== 'approved' && state !== 'declined') {
        unchanged.push(record);
        continue;
      }

      try {
        const current = OwnerQuestion.fromRecord(record);
        const transitioned = current.transitionTo(state === 'approved' ? 'answered' : 'rejected', {
          answer: {
            shape: state === 'approved' ? 'accept' : 'reject',
            optionId:
              state === 'approved' ? current.toRecord().recommendation.optionId : null,
            text: null,
            reason: null,
            questionRevision: record.revision,
            answeredVia: 'signed-decision',
            answeredAt: this.deps.clock.nowIso(),
            sessionId: null,
          },
        });
        // The repository requires record.revision === expectedRevision + 1.
        const syncedRecord = { ...transitioned.toRecord(), revision: record.revision + 1 };
        await this.deps.ownerQuestionRepo.save(syncedRecord, record.revision);
        if (state === 'approved') {
          answered.push(syncedRecord);
        } else {
          rejected.push(syncedRecord);
        }
      } catch {
        // A lost revision race (another writer moved first) or a record that
        // no longer validates leaves this question open; the run continues
        // with the others instead of failing for all of them.
        unchanged.push(record);
      }
    }
    return { outcome: 'synced', answered, rejected, unchanged };
  }
}
