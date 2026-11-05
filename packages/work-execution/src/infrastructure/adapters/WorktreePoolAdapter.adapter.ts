// @generated adapter stub — edit freely
/**
 * WorktreePoolAdapter implements WorktreePoolPort
 *
 * This adapter was generated from the port interface.
 * Replace TODO implementations with actual logic.
 */

import type {
  RefillWorktreePoolRequest,
  RefillWorktreePoolResult,
  ResetWorktreeToBaseRequest,
  ResetWorktreeToBaseResult,
  TakeWarmWorktreeRequest,
  TakeWarmWorktreeResult,
  WorktreePoolPort,
} from '../../application/ports/out/WorktreePoolPort.out-port.js';

export class WorktreePoolAdapter implements WorktreePoolPort {
  async take(_request: TakeWarmWorktreeRequest): Promise<TakeWarmWorktreeResult> {
    throw new Error('Not implemented: WorktreePoolAdapter.take');
  }

  async resetToBase(_request: ResetWorktreeToBaseRequest): Promise<ResetWorktreeToBaseResult> {
    throw new Error('Not implemented: WorktreePoolAdapter.resetToBase');
  }

  async refillAfterMerge(_request: RefillWorktreePoolRequest): Promise<RefillWorktreePoolResult> {
    throw new Error('Not implemented: WorktreePoolAdapter.refillAfterMerge');
  }
}
