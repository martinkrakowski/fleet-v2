import { describe, expect, it } from 'vitest';

import { ContextSelection } from '../value-objects/ContextSelection.vo.js';
import type { ContextSelectionProps } from '../value-objects/ContextSelection.vo.js';
import { RetrievalBudget } from '../value-objects/RetrievalBudget.vo.js';
import type { RetrievalBudgetProps } from '../value-objects/RetrievalBudget.vo.js';

describe('ContextSelection edges', () => {
  const selectionProps = (): ContextSelectionProps => ({
    attemptId: 'attempt-1',
    knowledgeEntryId: 'entry-1',
    version: 'v1',
    accepted: true,
    decisionBecause: 'operator chose it',
  });

  it('rejects whitespace-only fields with an error naming the field', () => {
    const cases: Array<[string, Partial<ContextSelectionProps>]> = [
      ['attemptId', { attemptId: '   ' }],
      ['knowledgeEntryId', { knowledgeEntryId: '   ' }],
      ['version', { version: '   ' }],
      ['decisionBecause', { decisionBecause: '   ' }],
    ];
    for (const [field, overrides] of cases) {
      const result = ContextSelection.create({ ...selectionProps(), ...overrides });
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(new RegExp(field));
    }
  });

  it('rejects a non-boolean accepted', () => {
    const result = ContextSelection.create({
      attemptId: 'attempt-1',
      knowledgeEntryId: 'entry-1',
      version: 'v1',
      accepted: 'yes',
      decisionBecause: 'operator chose it',
    } as unknown as ContextSelectionProps);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/accepted/);
  });

  it('compares by value across every field', () => {
    const base = ContextSelection.create(selectionProps()).value as ContextSelection;
    const same = ContextSelection.create(selectionProps()).value as ContextSelection;
    expect(base.equals(same)).toBe(true);

    const variants: Array<Partial<ContextSelectionProps>> = [
      { attemptId: 'attempt-2' },
      { knowledgeEntryId: 'entry-2' },
      { version: 'v2' },
      { accepted: false },
      { decisionBecause: 'another reason' },
    ];
    for (const overrides of variants) {
      const other = ContextSelection.create({ ...selectionProps(), ...overrides }).value as ContextSelection;
      expect(base.equals(other)).toBe(false);
    }
  });

  it('does not observe later mutation of the object passed to create', () => {
    const props = {
      attemptId: 'attempt-1',
      knowledgeEntryId: 'entry-1',
      version: 'v1',
      accepted: true,
      decisionBecause: 'operator chose it',
    };
    const selection = ContextSelection.create(props).value as ContextSelection;
    props.attemptId = 'mutated-attempt';
    props.accepted = false;
    expect(selection.getProps()).toEqual(selectionProps());
  });

  it('returns a fresh copy from getProps', () => {
    const selection = ContextSelection.create(selectionProps()).value as ContextSelection;
    const first = selection.getProps();
    (first as { attemptId: string }).attemptId = 'mutated-attempt';
    const second = selection.getProps();
    expect(second).toEqual(selectionProps());
    expect(second).not.toBe(first);
  });
});

describe('RetrievalBudget edges', () => {
  const budgetProps = (): RetrievalBudgetProps => ({ maxEntries: 1, maxTotalChars: 1 });

  it('succeeds for positive integer bounds', () => {
    const result = RetrievalBudget.create(budgetProps());
    expect(result.success).toBe(true);
    expect(result.value?.getMaxEntries()).toBe(1);
    expect(result.value?.getMaxTotalChars()).toBe(1);
  });

  it('rejects non-positive-integer bounds in every field', () => {
    const badValues: Array<unknown> = [1.5, NaN, Infinity, '5'];
    for (const value of badValues) {
      for (const field of ['maxEntries', 'maxTotalChars'] as const) {
        const props = { ...budgetProps(), [field]: value } as unknown as RetrievalBudgetProps;
        const result = RetrievalBudget.create(props);
        expect(result.success).toBe(false);
        expect(result.error?.message).toMatch(new RegExp(field));
      }
    }
  });

  it('compares by value across both fields', () => {
    const base = RetrievalBudget.create(budgetProps()).value as RetrievalBudget;
    expect(base.equals(RetrievalBudget.create(budgetProps()).value as RetrievalBudget)).toBe(true);
    expect(
      base.equals(RetrievalBudget.create({ maxEntries: 2, maxTotalChars: 1 }).value as RetrievalBudget),
    ).toBe(false);
    expect(
      base.equals(RetrievalBudget.create({ maxEntries: 1, maxTotalChars: 2 }).value as RetrievalBudget),
    ).toBe(false);
  });

  it('returns a fresh copy from getProps', () => {
    const budget = RetrievalBudget.create(budgetProps()).value as RetrievalBudget;
    const first = budget.getProps();
    (first as { maxEntries: number }).maxEntries = 99;
    const second = budget.getProps();
    expect(second).toEqual(budgetProps());
    expect(second).not.toBe(first);
  });
});
