// Implemented for lane D5a (decision port plan, 2026-10-16, "Budget").
/**
 * createRankingAdvice assembles the KnowledgeRankingAdvicePort an installation
 * gets from its v2 `decisions` block:
 *  - no block, or `provider: 'none'` → NullRankingAdviceAdapter (no journal);
 *  - jev or answer-file without a `stateDir` → the inner port wrapped by
 *    BudgetedRankingAdviceAdapter over NotConfiguredReceiptJournal, so every
 *    call answers `unknown/not-configured` and the provider is never
 *    contacted (invariant 5: without a durable receipt store nothing is made);
 *  - `provider: 'jev'` → BudgetedRankingAdviceAdapter(JevRankingAdviceAdapter,
 *    FileDecisionReceiptJournalAdapter(stateDir), provider 'jev', assumed
 *    cost `assumedCostPerCallUsd`, budget `monthlyBudgetUsd`, sub-budget
 *    `consumers['knowledge-ranking'].monthlyBudgetUsd` when declared);
 *  - `provider: 'answer-file'` → BudgetedRankingAdviceAdapter(
 *    AnswerFileRankingAdviceAdapter(answerFile), File journal, provider
 *    'answer-file', assumed cost 0, budget Number.MAX_SAFE_INTEGER — a
 *    recorded answer is free and always within budget).
 *
 * The `decisions` parameter is structurally identical to the v2 decisions
 * block in @fleet/installation. brief-knowledge may not depend on that
 * package (no workspace dependency; layer-rules.yaml allows only
 * @fleet/shared here), so the shape is declared locally; the structural
 * typing keeps them assignment-compatible in both directions.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import type {
  KnowledgeRankingAdvicePort,
} from '../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import { JevRankingAdviceAdapter } from './JevRankingAdviceAdapter.adapter.js';
import { AnswerFileRankingAdviceAdapter } from './AnswerFileRankingAdviceAdapter.adapter.js';
import { NullRankingAdviceAdapter } from './NullRankingAdviceAdapter.adapter.js';
import { BudgetedRankingAdviceAdapter } from './BudgetedRankingAdviceAdapter.adapter.js';
import { FileDecisionReceiptJournalAdapter } from './FileDecisionReceiptJournalAdapter.adapter.js';
import { NotConfiguredReceiptJournal } from './NotConfiguredReceiptJournal.adapter.js';

/**
 * Local structural mirror of the installation v2 `decisions` block
 * (`DecisionsSectionV2` in @fleet/installation); see the header note.
 */
export type RankingAdviceDecisions =
  | { readonly provider: 'none' }
  | {
      readonly provider: 'jev';
      readonly model: string;
      readonly keyFile: string;
      readonly minConfidence: number;
      readonly monthlyBudgetUsd: number;
      readonly assumedCostPerCallUsd: number;
      readonly acknowledgeProseLeavesHost: true;
      readonly disabledProjects?: readonly string[];
      readonly consumers?: RankingAdviceConsumers;
    }
  | {
      readonly provider: 'answer-file';
      readonly answerFile: string;
      readonly consumers?: RankingAdviceConsumers;
    };

/**
 * Per-consumer settings (plan §2): an absent `monthlyBudgetUsd` means the
 * consumer has no sub-budget clause and only the block total applies. Mirrors
 * `DecisionConsumers` in @fleet/installation; brief-knowledge may not depend on
 * that package.
 */
export interface RankingAdviceConsumers {
  readonly 'knowledge-ranking'?: {
    readonly minConfidence?: number;
    readonly monthlyBudgetUsd?: number;
  };
}

/**
 * The ranking consumer's own sub-budget, when the installation declares one.
 * Anything else (no map, no entry, no budget) has no clause at all.
 */
function rankingConsumerBudgetUsd(decisions: RankingAdviceDecisions): number | undefined {
  if (decisions.provider === 'none') {
    return undefined;
  }
  const budgetUsd = decisions.consumers?.['knowledge-ranking']?.monthlyBudgetUsd;
  return typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) && budgetUsd > 0
    ? budgetUsd
    : undefined;
}

export interface CreateRankingAdviceOptions {
  /** The installation's v2 `decisions` block; undefined means 'none'. */
  readonly decisions?: RankingAdviceDecisions;
  /** Durable state dir; without it no decision may be made (invariant 5). */
  readonly stateDir?: string;
  /** Injected transport for the jev provider; required when provider is 'jev'. */
  readonly fetch?: typeof fetch;
  /** Injected key reader; defaults to the Jev adapter's `readKeyFile`. */
  readonly readKey?: (path: string) => Promise<string>;
  /** Injected answer-file reader; defaults to `fs.readFile`. */
  readonly readAnswerFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export function createRankingAdvice(options: CreateRankingAdviceOptions): KnowledgeRankingAdvicePort {
  const { decisions, stateDir } = options;

  // Invariant 6: off by default — no provider unless the block declares one.
  if (!decisions || decisions.provider === 'none') {
    return new NullRankingAdviceAdapter();
  }

  if (decisions.provider === 'jev') {
    if (typeof options.fetch !== 'function') {
      throw new Error('createRankingAdvice requires an injected fetch for the jev provider');
    }
    const inner = new JevRankingAdviceAdapter({
      model: decisions.model,
      keyFile: decisions.keyFile,
      // The consumer's own threshold wins over the block's: a declared
      // `consumers['knowledge-ranking'].minConfidence` gates ranking answers
      // strictly, and only an absent one falls back to the block (plan §2).
      minConfidence:
        decisions.consumers?.['knowledge-ranking']?.minConfidence ?? decisions.minConfidence,
      ...(decisions.disabledProjects === undefined
        ? {}
        : { disabledProjects: decisions.disabledProjects }),
      fetch: options.fetch,
      ...(options.readKey === undefined ? {} : { readKey: options.readKey }),
    });
    // No stateDir → no durable receipt store → nothing is made (invariant 5);
    // NotConfiguredReceiptJournal refuses every reserve and the provider is
    // never contacted.
    const journal =
      stateDir === undefined || stateDir.trim().length === 0
        ? new NotConfiguredReceiptJournal()
        : new FileDecisionReceiptJournalAdapter(stateDir);
    const consumerBudgetUsd = rankingConsumerBudgetUsd(decisions);
    return new BudgetedRankingAdviceAdapter({
      inner,
      journal,
      provider: 'jev',
      assumedCostUsd: decisions.assumedCostPerCallUsd,
      monthlyBudgetUsd: decisions.monthlyBudgetUsd,
      ...(consumerBudgetUsd === undefined ? {} : { consumerBudgetUsd }),
    });
  }

  // provider: 'answer-file'
  const inner = new AnswerFileRankingAdviceAdapter(
    decisions.answerFile,
    options.readAnswerFile ?? fsReadFile,
  );
  const journal =
    stateDir === undefined || stateDir.trim().length === 0
      ? new NotConfiguredReceiptJournal()
      : new FileDecisionReceiptJournalAdapter(stateDir);
  const consumerBudgetUsd = rankingConsumerBudgetUsd(decisions);
  return new BudgetedRankingAdviceAdapter({
    inner,
    journal,
    provider: 'answer-file',
    // A recorded answer is free: assume no cost and never exhaust a budget.
    assumedCostUsd: 0,
    monthlyBudgetUsd: Number.MAX_SAFE_INTEGER,
    ...(consumerBudgetUsd === undefined ? {} : { consumerBudgetUsd }),
  });
}
