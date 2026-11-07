/**
 * StartChainPort: start one chain for a project. Records a ChainRecord v1 as a
 * keyed intent, creates `chain/<name>` from `main` at the recorded commit
 * through the forge, and reconciles the result. An existing branch at that
 * commit reconciles as started; one at another commit refuses; a repeated call
 * with the same key returns the recorded outcome without a second forge write.
 * Reasons are fixed codes, never an echoed input.
 */

import type { ChainRecord, ChainRepositoryRef } from '../../../domain/chain-records.js';

export interface StartChainCommand {
  readonly repository: ChainRepositoryRef;
  /** The bare name, `example` for `chain/example`. */
  readonly chainName: string;
  /** 40 lowercase hex: the commit of `main` the chain starts at. */
  readonly expectedHeadSha: string;
  /** The keyed intent id: one per chain start. */
  readonly actionKey: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

export const START_CHAIN_REASONS = [
  'invalid-request',
  'invalid-repository',
  'invalid-chain-name',
  'invalid-expected-head',
  'invalid-action-key',
  'invalid-now',
  'invalid-deadline',
  'chain-already-started',
  'chain-start-in-flight',
  'chain-start-refused',
  'action-key-conflict',
  'intent-refused',
  'forge-refused',
  'branch-exists-at-other-commit',
  'unresolved',
] as const;
export type StartChainReason = (typeof START_CHAIN_REASONS)[number];

export type StartChainDecision =
  | { readonly outcome: 'started'; readonly record: ChainRecord }
  | { readonly outcome: 'refused'; readonly reason: StartChainReason; readonly record: ChainRecord | null }
  | { readonly outcome: 'unknown'; readonly reason: StartChainReason; readonly record: ChainRecord | null };

export interface StartChainPort {
  startChain(command: StartChainCommand): Promise<StartChainDecision>;
}
