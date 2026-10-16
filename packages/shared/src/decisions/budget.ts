// Decision kernel (lane K1): the pure budget decision rule. Pure: no I/O,
// no dependencies, no `node:` imports.
//
// The same at-the-cap comparison the journal uses today: refuse when the
// assumed cost would take spend to or past the budget.

export interface BudgetInput {
  readonly consumerSpend: number;
  /** Omit when the consumer has no sub-budget (only the total applies). */
  readonly consumerBudget?: number;
  readonly totalSpend: number;
  readonly totalBudget: number;
  readonly assumedCost: number;
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: 'consumer-budget' | 'total-budget' };

/**
 * Refuse when `consumerSpend + assumed >= consumerBudget` (only when
 * `consumerBudget` is given) or `totalSpend + assumed >= totalBudget`.
 */
export function budgetAllows(input: BudgetInput): BudgetDecision {
  const { consumerSpend, consumerBudget, totalSpend, totalBudget, assumedCost } = input;
  if (consumerBudget !== undefined && consumerSpend + assumedCost >= consumerBudget) {
    return { ok: false, reason: 'consumer-budget' };
  }
  if (totalSpend + assumedCost >= totalBudget) {
    return { ok: false, reason: 'total-budget' };
  }
  return { ok: true };
}
