/**
 * The merge train's pure state machine. It is total: every (state, event)
 * pair answers, no pair throws, and the only moves are the edges listed in
 * the merge-acceleration plan. Anything else is refused with a reason.
 */

import type { TrainEventValue } from './value-objects/TrainEvent.vo.js';
import type { TrainStateValue } from './value-objects/TrainState.vo.js';

/** The outcome of one transition: the next state, or a refusal reason. */
export type TrainTransitionOk = { readonly ok: true; readonly state: TrainStateValue };

export type TrainTransitionRefused = { readonly ok: false; readonly reason: string };

export type TrainTransitionResult = TrainTransitionOk | TrainTransitionRefused;

type TrainTransitionTable = Readonly<
  Record<TrainStateValue, Partial<Record<TrainEventValue, TrainStateValue>>>
>;

/**
 * Every legal edge of the train lifecycle:
 *
 * waiting → eligible → batched → candidate-built → validating;
 * validating → ready-to-promote on a passed gate, → splitting on a failed one;
 * splitting → waiting once the split is done;
 * ready-to-promote → promoting → landed, or → invalidated on a conflict;
 * invalidated → waiting once the entry is requeued. `landed` is terminal.
 */
const TRANSITIONS: TrainTransitionTable = Object.freeze({
  waiting: { 'became-eligible': 'eligible' },
  eligible: { batched: 'batched' },
  batched: { 'candidate-built': 'candidate-built' },
  'candidate-built': { 'gate-started': 'validating' },
  validating: {
    'gate-passed': 'ready-to-promote',
    'gate-failed': 'splitting',
  },
  splitting: { 'split-done': 'waiting' },
  'ready-to-promote': { 'promotion-started': 'promoting' },
  promoting: {
    'promotion-landed': 'landed',
    'promotion-conflict': 'invalidated',
  },
  invalidated: { requeued: 'waiting' },
  landed: {},
});

/**
 * Move the train one step. Returns `{ ok: true, state }` with the next state,
 * or `{ ok: false, reason }` for any pair the table does not name — including
 * every event out of the terminal `landed` state and any unknown state or
 * event. It never throws and never mutates its arguments.
 */
export function nextTrainState(state: TrainStateValue, event: TrainEventValue): TrainTransitionResult {
  const edges = TRANSITIONS[state];
  if (edges === undefined) {
    return { ok: false, reason: `unknown train state: ${String(state)}` };
  }
  const next = edges[event];
  if (next === undefined) {
    return { ok: false, reason: `no transition from ${String(state)} on ${String(event)}` };
  }
  return { ok: true, state: next };
}
