// @generated adapter stub — edit freely
/**
 * ChainRepositoryAdapter implements ChainRepositoryPort
 *
 * This adapter was generated from the port interface. The file store lands in
 * a later lane; until then every method refuses to run (CO7 declares the port only).
 */

import type {
  ChainIntentCommand,
  ChainOutcomeCommand,
  ChainReadCommand,
  ChainRecordDecision,
  ChainRecordRead,
  ChainRepositoryPort,
} from '../../application/ports/out/ChainRepositoryPort.out-port.js';

export class ChainRepositoryAdapter implements ChainRepositoryPort {
  recordChainIntent(_command: ChainIntentCommand): Promise<ChainRecordDecision> {
    throw new Error('Not implemented: ChainRepositoryAdapter.recordChainIntent');
  }

  recordChainOutcome(_command: ChainOutcomeCommand): Promise<ChainRecordDecision> {
    throw new Error('Not implemented: ChainRepositoryAdapter.recordChainOutcome');
  }

  readChain(_command: ChainReadCommand): Promise<ChainRecordRead> {
    throw new Error('Not implemented: ChainRepositoryAdapter.readChain');
  }
}
