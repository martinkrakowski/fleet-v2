import { describe, expect, it } from 'vitest';

import { TrainEvent, TRAIN_EVENTS } from '../value-objects/TrainEvent.vo.js';
import type { TrainEventValue } from '../value-objects/TrainEvent.vo.js';
import { TRAIN_STATES, TrainState } from '../value-objects/TrainState.vo.js';
import type { TrainStateValue } from '../value-objects/TrainState.vo.js';
import { nextTrainState } from '../train-state.js';

/** Every legal edge of the train lifecycle, in one table. */
const LEGAL_EDGES: readonly { from: TrainStateValue; event: TrainEventValue; to: TrainStateValue }[] = [
  { from: 'waiting', event: 'became-eligible', to: 'eligible' },
  { from: 'eligible', event: 'batched', to: 'batched' },
  { from: 'batched', event: 'candidate-built', to: 'candidate-built' },
  { from: 'candidate-built', event: 'gate-started', to: 'validating' },
  { from: 'validating', event: 'gate-passed', to: 'ready-to-promote' },
  { from: 'validating', event: 'gate-failed', to: 'splitting' },
  { from: 'splitting', event: 'split-done', to: 'waiting' },
  { from: 'ready-to-promote', event: 'promotion-started', to: 'promoting' },
  { from: 'promoting', event: 'promotion-landed', to: 'landed' },
  { from: 'promoting', event: 'promotion-conflict', to: 'invalidated' },
  { from: 'invalidated', event: 'requeued', to: 'waiting' },
];

describe('nextTrainState — legal edges', () => {
  for (const edge of LEGAL_EDGES) {
    it(`moves ${edge.from} to ${edge.to} on ${edge.event}`, () => {
      const result = nextTrainState(edge.from, edge.event);
      expect(result).toEqual({ ok: true, state: edge.to });
    });
  }
});

describe('nextTrainState — illegal pairs', () => {
  it('refuses an inherited property name as a state or an event', () => {
    expect(nextTrainState('validating', 'toString' as TrainEventValue).ok).toBe(false);
    expect(nextTrainState('toString' as TrainStateValue, TRAIN_EVENTS[0] as TrainEventValue).ok).toBe(false);
  });

  const legal = new Set(LEGAL_EDGES.map((edge) => `${edge.from}|${edge.event}`));

  for (const from of TRAIN_STATES) {
    for (const event of TRAIN_EVENTS) {
      if (legal.has(`${from}|${event}`)) {
        continue;
      }
      it(`refuses ${from} on ${event}`, () => {
        const result = nextTrainState(from, event);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toContain(from);
          expect(result.reason).toContain(event);
        }
      });
    }
  }

  it('refuses an unknown state without throwing', () => {
    const result = nextTrainState('no-such-state' as TrainStateValue, 'batched' as TrainEventValue);
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown event without throwing', () => {
    const result = nextTrainState('waiting', 'no-such-event' as TrainEventValue);
    expect(result.ok).toBe(false);
  });
});

describe('nextTrainState — landed is terminal', () => {
  for (const event of TRAIN_EVENTS) {
    it(`refuses ${event} out of landed`, () => {
      const result = nextTrainState('landed', event);
      expect(result.ok).toBe(false);
    });
  }
});

describe('nextTrainState — gate failure never reaches ready-to-promote', () => {
  it('moves validating to splitting on gate-failed, never to ready-to-promote', () => {
    const result = nextTrainState('validating', 'gate-failed');
    expect(result).toEqual({ ok: true, state: 'splitting' });
    expect(result.ok && result.state === 'ready-to-promote').toBe(false);
  });

  it('keeps the train out of ready-to-promote after a full failed-gate loop', () => {
    let state: TrainStateValue = 'waiting';
    const steps: TrainEventValue[] = [
      'became-eligible',
      'batched',
      'candidate-built',
      'gate-started',
      'gate-failed',
      'split-done',
    ];
    for (const step of steps) {
      const result = nextTrainState(state, step);
      expect(result.ok).toBe(true);
      if (result.ok) {
        state = result.state;
      }
    }
    expect(state).toBe('waiting');
  });
});

describe('train state and event value objects', () => {
  it('accepts every listed state and event name', () => {
    expect(TRAIN_STATES.length).toBe(10);
    expect(TRAIN_EVENTS.length).toBe(11);
  });

  it('refuses names outside the closed sets', () => {
    expect(TrainState.create('queued').success).toBe(false);
    expect(TrainEvent.create('merged').success).toBe(false);
  });
});
