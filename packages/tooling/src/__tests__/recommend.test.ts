import { describe, expect, it } from 'vitest';

import { validateSeatPolicy } from '@fleet/installation';

import { RECOMMENDER_VERSION, recommendSeats } from '../recommend.js';
import type { AllowedRouteRule, DetectedTool, ModelInfo, ModelsByTool } from '../recommend.js';
import type { PolicySection } from '@fleet/installation';

function tool(id: DetectedTool['id'], signIn: DetectedTool['signIn'] = 'signed-in'): DetectedTool {
  return { id, signIn };
}

function model(id: string, costClass?: ModelInfo['costClass'], variant?: string): ModelInfo {
  return { id, ...(costClass === undefined ? {} : { costClass }), ...(variant === undefined ? {} : { variant }) };
}

const NO_POLICY: PolicySection = {};

/** Every catalogue fixture runs through the loader's own validator. */
function expectValidCatalogue(input: {
  tools: readonly DetectedTool[];
  models: ModelsByTool;
  policy?: PolicySection;
  allowedRoutes?: readonly AllowedRouteRule[];
}) {
  const result = recommendSeats({
    tools: input.tools,
    models: input.models,
    policy: input.policy ?? NO_POLICY,
    ...(input.allowedRoutes === undefined ? {} : { allowedRoutes: input.allowedRoutes }),
  });
  expect(result.outcome).toBe('catalogue');
  if (result.outcome !== 'catalogue') {
    throw new Error('expected a catalogue');
  }
  const errors = validateSeatPolicy({
    schemaVersion: 2,
    hosts: {},
    seats: result.seats,
    chains: result.chains,
    policy: input.policy ?? NO_POLICY,
  });
  expect(errors).toEqual([]);
  return result;
}

describe('recommendSeats', () => {
  it('is versioned, starting at 1', () => {
    expect(RECOMMENDER_VERSION).toBe('1');
    const result = recommendSeats({ tools: [], models: {}, policy: NO_POLICY });
    expect(result.version).toBe('1');
  });

  describe('table: only free seats', () => {
    const tools = [tool('opencode'), tool('grok')];
    const models: ModelsByTool = {
      opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('glm-5.3-flash', 'free')],
      grok: [model('grok-4.7-fast', 'free'), model('grok-code-fast-4.7', 'free')],
    };

    it('builds a free implementer chain and a free reviewer chain', () => {
      const result = expectValidCatalogue({ tools, models });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-nvidia-z-ai-glm-5.3',
        'opencode-glm-5.3-flash',
      ]);
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual([
        'grok-grok-4.7-fast',
        'grok-grok-code-fast-4.7',
      ]);
      // Same strongest seat holds both reviewer roles.
      expect(result.seats.find((seat) => seat.id === 'grok-grok-4.7-fast')?.roles).toEqual([
        'reviewer',
        'high-risk-reviewer',
      ]);
      expect(result.seats.every((seat) => seat.costClass === 'free')).toBe(true);
    });

    it('gives every seat a one-line reason', () => {
      const result = expectValidCatalogue({ tools, models });
      expect(Object.keys(result.reasons).sort()).toEqual(
        result.seats.map((seat) => seat.id).sort(),
      );
      for (const reason of Object.values(result.reasons)) {
        expect(reason).not.toContain('\n');
      }
      expect(result.reasons['opencode-nvidia-z-ai-glm-5.3']).toContain('implementer');
      expect(result.reasons['grok-grok-4.7-fast']).toContain('strongest seat');
    });
  });

  describe('table: free plus paid', () => {
    const tools = [tool('opencode'), tool('grok')];
    const models: ModelsByTool = {
      opencode: [
        model('openrouter/z-ai/glm-5.3-flash', 'paid'),
        model('nvidia/z-ai/glm-5.3', 'free'),
      ],
      grok: [model('grok-4.7')],
    };

    it('places the paid seat after the free seat in the implementer chain', () => {
      const result = expectValidCatalogue({ tools, models });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-nvidia-z-ai-glm-5.3',
        'opencode-openrouter-z-ai-glm-5.3-flash',
      ]);
      expect(result.seats.find((seat) => seat.id === 'opencode-nvidia-z-ai-glm-5.3')?.costClass).toBe(
        'free',
      );
      expect(
        result.seats.find((seat) => seat.id === 'opencode-openrouter-z-ai-glm-5.3-flash')?.costClass,
      ).toBe('paid');
      // grok-4.7 is the strongest family absent from the implementer chain.
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7']);
      expect(result.reasons['opencode-openrouter-z-ai-glm-5.3-flash']).toContain(
        'paid only after',
      );
    });
  });

  describe('table: a single tool', () => {
    it('refuses the catalogue when no seat of another family can review', () => {
      const result = recommendSeats({
        tools: [tool('opencode')],
        models: { opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')] },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('no reviewer');
      }
    });

    it('accepts a single tool whose read-only sibling serves as reviewer', () => {
      const result = expectValidCatalogue({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast', 'paid')],
        },
      });
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7-fast']);
    });

    it('refuses a single free implementer seat: a free seat is never the only seat of a role', () => {
      const result = recommendSeats({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free')],
          grok: [model('grok-4.7-fast')],
        },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('only seat of a role');
      }
    });
  });

  describe('table: unknown model lists and unknown sign-in', () => {
    it('skips a tool whose model list is unknown, with a reason', () => {
      const result = recommendSeats({
        tools: [tool('opencode'), tool('grok')],
        models: { opencode: 'unknown', grok: [model('grok-4.7')] },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      expect(result.skipped.join(' ')).toContain('model list is unknown');
    });

    it('skips a tool that is not signed in, with a reason', () => {
      const result = recommendSeats({
        tools: [tool('opencode', 'signed-out'), tool('grok', 'unknown')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free')],
          grok: [model('grok-4.7')],
        },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      expect(result.skipped.join(' ')).toContain('signed-out');
      expect(result.skipped.join(' ')).toContain('"unknown"');
    });

    it('refuses paid-only implementers: paid is never proposed ahead of a free or plan seat', () => {
      const result = recommendSeats({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('openrouter/z-ai/glm-5.3-flash', 'paid')],
          grok: [model('grok-4.7')],
        },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('paid seats are proposed only after');
      }
    });

    it('skips a mixed-cost model without a cost class, with a reason', () => {
      const result = recommendSeats({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast')],
        },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      expect(result.skipped.join(' ')).toContain('no cost class given for a mixed-cost tool');
    });
  });

  describe('table: forbidden routes are respected', () => {
    const tools = [tool('opencode'), tool('grok')];
    const models: ModelsByTool = {
      opencode: [
        model('nvidia/z-ai/glm-5.3', 'free'),
        model('glm-5.3-flash', 'free'),
        model('openrouter/anthropic/claude-sonnet-4-5', 'paid'),
      ],
      grok: [model('grok-4.7')],
    };

    it('excludes forbidden seats from the chains and still returns a valid catalogue', () => {
      const policy: PolicySection = {
        forbiddenRoutes: [{ tool: 'opencode', modelPattern: '*claude*' }],
      };
      const result = expectValidCatalogue({ tools, models, policy });
      const seatIds = result.seats.map((seat) => seat.id);
      expect(seatIds).not.toContain('opencode-openrouter-anthropic-claude-sonnet-4-5');
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-nvidia-z-ai-glm-5.3',
        'opencode-glm-5.3-flash',
      ]);
    });

    it('refuses the catalogue when a forbidden route removes every implementer', () => {
      const policy: PolicySection = {
        forbiddenRoutes: [
          { tool: 'opencode', modelPattern: '*glm*' },
          { tool: 'opencode', modelPattern: '*claude*' },
        ],
      };
      const result = recommendSeats({ tools, models, policy });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('no implementer seat');
      }
    });
  });

  describe('table: the policy allow-list gates the candidate pool', () => {
    const tools = [tool('opencode'), tool('claude-code'), tool('grok')];
    const models: ModelsByTool = {
      opencode: [
        model('nvidia/z-ai/glm-5.3', 'free'),
        model('glm-5.3-flash', 'free'),
        model('xai/grok-4.7', 'free'),
      ],
      'claude-code': [model('claude-sonnet-4-5')],
      grok: [model('grok-4.7'), model('grok-4.7-fast')],
    };
    const allowedRoutes: AllowedRouteRule[] = [
      { tool: 'opencode', modelPattern: 'nvidia/*' },
      { tool: 'claude-code', modelPattern: 'claude-*' },
      { tool: 'grok', modelPattern: 'grok-4.7' },
    ];

    it('never ranks a disallowed candidate, not even as a lower-ranked entry', () => {
      const result = expectValidCatalogue({ tools, models, allowedRoutes });
      // Without the allow-list, glm-5.3-flash would sit lower in the
      // implementer chain and xai/grok-4.7 would be the strongest reviewer;
      // both are gone, and so is the disallowed grok-4.7-fast.
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-nvidia-z-ai-glm-5.3',
        'claude-code-claude-sonnet-4-5',
      ]);
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7']);
      const ranked = JSON.stringify({
        seats: result.seats,
        chains: result.chains,
        reasons: result.reasons,
      });
      expect(ranked).not.toContain('glm-5.3-flash');
      expect(ranked).not.toContain('xai/grok-4.7');
      expect(ranked).not.toContain('grok-4.7-fast');
      // Every dropped candidate is recorded with a reason.
      expect(result.skipped).toHaveLength(3);
      expect(result.skipped.join(' ')).toContain('not on the policy allow-list');
    });

    it('admits nothing when the allow-list is present but empty', () => {
      const result = recommendSeats({ tools, models, policy: NO_POLICY, allowedRoutes: [] });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('no implementer seat');
        expect(result.skipped).toHaveLength(6);
        expect(result.skipped.join(' ')).toContain('not on the policy allow-list');
      }
    });
  });

  describe('table: strength ordering and plan-quota implementers', () => {
    it('prefers the strongest plan-quota implementer and the strongest disjoint reviewer', () => {
      const result = expectValidCatalogue({
        tools: [tool('claude-code'), tool('opencode'), tool('grok')],
        models: {
          'claude-code': [model('claude-sonnet-4-5')],
          opencode: [model('nvidia/z-ai/glm-5.3', 'plan-quota'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast')],
        },
      });
      // The free seat comes first, then plan-quota seats strongest first.
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-xai-grok-4.7',
        'opencode-nvidia-z-ai-glm-5.3',
        'claude-code-claude-sonnet-4-5',
      ]);
      // claude-opus is not offered; glm-5.3 outranks claude-sonnet but shares
      // the implementer family, so the reviewer is grok-4.7-fast.
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7-fast']);
    });

    it('ranks an unlisted family below every listed family, in first-seen order', () => {
      const result = expectValidCatalogue({
        tools: [tool('opencode'), tool('agy'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          agy: [model('future-model-9', 'free')],
          grok: [model('grok-4.7-fast'), model('grok-code-fast-4.7')],
        },
      });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-nvidia-z-ai-glm-5.3',
        'opencode-xai-grok-4.7',
        'agy-future-model-9',
      ]);
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7-fast']);
    });
  });

  describe('table: variants and seat ids', () => {
    it('carries the variant on the seat and into a unique seat id', () => {
      const result = expectValidCatalogue({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free', 'none'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast')],
        },
      });
      const seat = result.seats.find((entry) => entry.id === 'opencode-nvidia-z-ai-glm-5.3-none');
      expect(seat?.variant).toBe('none');
      expect(seat?.model).toBe('nvidia/z-ai/glm-5.3');
    });
  });

  it('runs the validator on every catalogue fixture and expects no errors', () => {
    const fixtures: Array<{
      tools: readonly DetectedTool[];
      models: ModelsByTool;
      policy: PolicySection;
    }> = [
      {
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('glm-5.3-flash', 'free')],
          grok: [model('grok-4.7-fast', 'free'), model('grok-code-fast-4.7', 'free')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [
            model('openrouter/z-ai/glm-5.3-flash', 'paid'),
            model('nvidia/z-ai/glm-5.3', 'free'),
          ],
          grok: [model('grok-4.7')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast', 'paid')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('claude-code'), tool('opencode'), tool('grok')],
        models: {
          'claude-code': [model('claude-sonnet-4-5')],
          opencode: [model('nvidia/z-ai/glm-5.3', 'plan-quota'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('agy'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          agy: [model('future-model-9', 'free')],
          grok: [model('grok-4.7-fast'), model('grok-code-fast-4.7')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free', 'none'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [
            model('nvidia/z-ai/glm-5.3', 'free'),
            model('glm-5.3-flash', 'free'),
            model('openrouter/anthropic/claude-sonnet-4-5', 'paid'),
          ],
          grok: [model('grok-4.7')],
        },
        policy: { forbiddenRoutes: [{ tool: 'opencode', modelPattern: '*claude*' }] },
      },
    ];
    for (const fixture of fixtures) {
      const result = recommendSeats(fixture);
      expect(result.outcome).toBe('catalogue');
      if (result.outcome !== 'catalogue') {
        throw new Error('expected a catalogue');
      }
      expect(
        validateSeatPolicy({
          schemaVersion: 2,
          hosts: {},
          seats: result.seats,
          chains: result.chains,
          policy: fixture.policy,
        }),
      ).toEqual([]);
    }
  });

  it('never returns an invalid catalogue: an invalid policy is refused', () => {
    const result = recommendSeats({
      tools: [tool('opencode'), tool('grok')],
      models: {
        opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('glm-5.3-flash', 'free')],
        grok: [model('grok-4.7-fast'), model('grok-code-fast-4.7')],
      },
      policy: { perLaneCostCeiling: -1 },
    });
    expect(result.outcome).toBe('no-valid-catalogue');
    if (result.outcome === 'no-valid-catalogue') {
      expect(result.reasons.join(' ')).toContain('perLaneCostCeiling');
    }
  });
});
