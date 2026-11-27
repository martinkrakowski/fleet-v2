// @generated use-case scaffold — refined for lane DT4.
import type { MergeQueueEnqueueCommand, MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { MergeEnqueueDecision } from '../../domain/merge-queue-operations.js';
import type { EnqueueMergePort } from '../ports/in/EnqueueMergePort.in-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { KillallHaltMarkerPort } from '../ports/out/KillallHaltMarkerPort.out-port.js';
import type { KillallTrainPausePort } from '../ports/out/KillallTrainPausePort.out-port.js';
import type { IsProxy } from '@fleet/shared';
import { isTrainStepBlocked } from './chain-pass-halt.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Enqueue one pull request head; validates the request envelope before delegating. */
export class EnqueueMergeUseCase implements EnqueueMergePort {
  constructor(
    private readonly deps: {
      readonly queue: MergeQueueRepositoryPort;
      /** KA3-1: the conductor halt; absent or null reads as not halted here. */
      readonly halt?: Pick<ConductorHaltPort, 'read'> | null;
      /** KA3-1: the killall halt marker; absent or without `read` reads as not halted. */
      readonly killallHalt?: Pick<KillallHaltMarkerPort, 'read'> | null;
      /** KA3-1: the killall train pause; absent reads as not paused. */
      readonly killallTrainPause?: Pick<KillallTrainPausePort, 'read'> | null;
      /** Fix round 2: the trusted Proxy detector (`types.isProxy`, bound in
       * infrastructure), so a Proxy port is refused before its traps run.
       * Absent, the neutral detector keeps the prior behaviour. */
      readonly isProxy?: IsProxy;
    },
  ) {}

  async enqueue(request: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision> {
    if (!this.isValidRequest(request)) {
      return { outcome: 'refused', reason: 'invalid-repository' };
    }
    // KA3-1, fail closed: a halted conductor, a halted killall marker or a
    // paused merge train refuses the enqueue before the queue is touched.
    if (await isTrainStepBlocked(this.deps, false, this.deps.isProxy)) {
      return { outcome: 'refused', reason: 'halted' };
    }
    return this.deps.queue.enqueueMergeEntry(request);
  }

  private isValidRequest(request: MergeQueueEnqueueCommand): boolean {
    const { owner, repo } = request.repository;
    if (!REPOSITORY_SEGMENT_PATTERN.test(owner) || !REPOSITORY_SEGMENT_PATTERN.test(repo)) {
      return false;
    }
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      return false;
    }
    return Number.isSafeInteger(request.pullRequest) && request.pullRequest >= 1;
  }
}
