/**
 * UN1: the explicit `uncertain` outcome for interrupted side effects. A one-way
 * step whose effect may or may not have landed is not merely `ambiguous`: the
 * uncertainty forbids an automatic retry and names why the outcome is unknown.
 * This extends the existing `ambiguous` handling — the pending intent keeps
 * `reconciliation: 'ambiguous'` so every existing consumer already understands
 * it; nothing here duplicates the ambiguous machinery. Pure: no store, no
 * clock, no I/O.
 */

import { snapshotPlainDataRecord } from './plain-record-reads.js';
import { LANE_RUN_KEY_STEPS } from './lane-run-records.js';
import type { LaneRunKeyStep } from './lane-run-records.js';

/**
 * The steps whose side effect can be interrupted mid-flight and whose retry is
 * forbidden while the effect is unproven: `dispatch` starts a runner, `push`
 * publishes a head, `merge-enqueue` enqueues a merge, `premerge` posts a
 * commit status. `gate` is deliberately absent — an unknown gate read gets
 * its one automatic retry under a retry key (GU1).
 */
export const UNCERTAIN_STEPS = ['dispatch', 'push', 'merge-enqueue', 'premerge'] as const satisfies readonly LaneRunKeyStep[];
export type UncertainStep = (typeof UNCERTAIN_STEPS)[number];

/** Whether the step may carry an `uncertain` result. O(1) over a 4-element list. */
export function isUncertainStep(step: unknown): step is UncertainStep {
  return step === 'dispatch' || step === 'push' || step === 'merge-enqueue' || step === 'premerge';
}

/** What an observation of the interrupted step's side effect proves. */
export const INTERRUPTED_INTENT_OBSERVATIONS = ['proves-done', 'proves-not-done', 'unavailable'] as const;
export type InterruptedIntentObservation = (typeof INTERRUPTED_INTENT_OBSERVATIONS)[number];

export type InterruptedIntentClassification =
  | { readonly outcome: 'reconciled'; readonly reasonCode: 'observed-done' }
  | { readonly outcome: 'uncertain'; readonly reasonCode: 'observed-not-done' }
  | { readonly outcome: 'uncertain'; readonly reasonCode: 'unobservable' }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-input' | 'unknown-step' | 'unknown-observation' }
  | null;

/**
 * Classify an observation of an interrupted side effect. Uncertainty closes
 * only by proving the effect happened: `proves-not-done` stays `uncertain`
 * (the owner/orchestrator resolves it, so nothing re-runs automatically), as
 * does an unavailable observation. A declared key step outside the uncertain
 * set with a valid observation is simply not this classification's business:
 * null. Hostile input (null, primitives, getters, proxies, prototype
 * pollution) refuses with a typed reason, never a pass. The input is a flat
 * `{ step, observation }` record: any extra own key — including the `0` and
 * `length` of an array-like — refuses with `invalid-input` rather than being
 * classified, so a hostile `{ step, observation, 0: 'x',
 * length: Number.MAX_SAFE_INTEGER }` can never read as data.
 *
 * Cost bound: `snapshotPlainDataRecord` runs in O(K) over the own keys of the
 * flat `{ step, observation }` input (its own `Reflect.ownKeys` is bounded
 * there); the extra-key check below is `Object.keys` over the snapshot copy,
 * the same O(K) enumeration the snapshot has already paid, and the rest of
 * this function performs O(1) property lookups on the snapshot.
 */
export function classifyInterruptedIntent(input: unknown): InterruptedIntentClassification {
  let snapshot: Record<string, unknown> | null;
  try {
    snapshot = snapshotPlainDataRecord(input);
  } catch {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  if (snapshot === null) {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  // The input must be the flat `{ step, observation }` record. Any other own
  // key — a canonical array index, an enormous `length`, or any extra data —
  // marks the input as array-like or padded, and is refused before any value
  // is classified. `Object.keys` on the null-prototype copy the snapshot
  // already built is safe: the copy has no getters, no symbols and no
  // inherited surprises, so this is the same O(K) walk the snapshot paid.
  for (const key of Object.keys(snapshot)) {
    if (key !== 'step' && key !== 'observation') {
      return { outcome: 'refused', reason: 'invalid-input' };
    }
  }
  const step = snapshot.step;
  const observation = snapshot.observation;
  if (observation !== 'proves-done' && observation !== 'proves-not-done' && observation !== 'unavailable') {
    return { outcome: 'refused', reason: 'unknown-observation' };
  }
  const declaredStep = (LANE_RUN_KEY_STEPS as readonly unknown[]).includes(step) ? (step as LaneRunKeyStep) : null;
  if (declaredStep === null) {
    return { outcome: 'refused', reason: 'unknown-step' };
  }
  if (!isUncertainStep(declaredStep)) {
    return null;
  }
  if (observation === 'proves-done') {
    return { outcome: 'reconciled', reasonCode: 'observed-done' };
  }
  if (observation === 'proves-not-done') {
    return { outcome: 'uncertain', reasonCode: 'observed-not-done' };
  }
  return { outcome: 'uncertain', reasonCode: 'unobservable' };
}
