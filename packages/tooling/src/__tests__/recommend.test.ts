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
  allAgyHostsFull?: boolean;
}) {
  const result = recommendSeats({
    tools: input.tools,
    models: input.models,
    policy: input.policy ?? NO_POLICY,
    ...(input.allowedRoutes === undefined ? {} : { allowedRoutes: input.allowedRoutes }),
    ...(input.allAgyHostsFull === undefined ? {} : { allAgyHostsFull: input.allAgyHostsFull }),
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

  it('golden: the default output is unchanged by FS2', () => {
    const onlyFree = recommendSeats({
      tools: [tool('opencode'), tool('grok')],
      models: {
        opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('glm-5.3-flash', 'free')],
        grok: [model('grok-4.7-fast', 'free'), model('grok-code-fast-4.7', 'free')],
      },
      policy: NO_POLICY,
    });
    expect(onlyFree).toMatchSnapshot();

    const freePlusPaid = recommendSeats({
      tools: [tool('opencode'), tool('grok')],
      models: {
        opencode: [
          model('openrouter/z-ai/glm-5.3-flash', 'paid'),
          model('nvidia/z-ai/glm-5.3', 'free'),
        ],
        grok: [model('grok-4.7')],
      },
      policy: NO_POLICY,
    });
    expect(freePlusPaid).toMatchSnapshot();
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

    it('refuses a paid sibling that now shares the implementer model family', () => {
      // The vendor-line rule folds grok-4.7-fast into the `grok` family of
      // the xai/grok-4.7 implementer seat, so no disjoint reviewer remains.
      const result = recommendSeats({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          grok: [model('grok-4.7-fast', 'paid')],
        },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('no reviewer');
      }
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
          grok: [model('gemini-3.8-pro')],
        },
      });
      // The free seat comes first, then plan-quota seats strongest first.
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-xai-grok-4.7',
        'opencode-nvidia-z-ai-glm-5.3',
        'claude-code-claude-sonnet-4-5',
      ]);
      // gemini-3.8-pro is the only candidate whose vendor-line family is
      // absent from the implementer chain (grok, glm and claude are all
      // taken), so it is the reviewer.
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-gemini-3.8-pro']);
    });

    it('refuses a Sonnet implementer with an Opus reviewer: both are the claude family', () => {
      // One family per vendor line (owner rule): claude-sonnet and
      // claude-opus share the `claude` family, so the strongest disjoint
      // reviewer no longer exists.
      const result = recommendSeats({
        tools: [tool('claude-code'), tool('grok')],
        models: {
          'claude-code': [model('claude-sonnet-4-5', 'plan-quota')],
          grok: [model('claude-opus-5-5')],
        },
        policy: NO_POLICY,
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('no reviewer');
      }
    });

    it('ranks an unlisted family below every listed family, in first-seen order', () => {
      const result = expectValidCatalogue({
        tools: [tool('opencode'), tool('agy'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          agy: [model('future-model-9', 'free')],
          grok: [model('gemini-3.1-pro')],
        },
      });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-nvidia-z-ai-glm-5.3',
        'opencode-xai-grok-4.7',
        'agy-future-model-9',
      ]);
      // The gemini family is unlisted, so it ranks below every listed
      // family; it is the only disjoint reviewer candidate here.
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-gemini-3.1-pro']);
    });
  });

  describe('table: variants and seat ids', () => {
    it('carries the variant on the seat and into a unique seat id', () => {
      const result = expectValidCatalogue({
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free', 'none'), model('xai/grok-4.7', 'free')],
          grok: [model('gemini-3.1-pro')],
        },
      });
      const seat = result.seats.find((entry) => entry.id === 'opencode-nvidia-z-ai-glm-5.3-none');
      expect(seat?.variant).toBe('none');
      expect(seat?.model).toBe('nvidia/z-ai/glm-5.3');
    });
  });

  describe('table: an agy seat follows the runner mode (D7)', () => {
    const tools = [tool('opencode'), tool('agy'), tool('grok')];
    const models: ModelsByTool = {
      opencode: [model('nvidia/z-ai/glm-5.3', 'free')],
      agy: [model('future-model-9', 'free')],
      grok: [model('gemini-3.1-pro')],
    };

    it('treats an agy seat as edit-only by default, and says so on its reason line', () => {
      const result = expectValidCatalogue({ tools, models });
      const agySeat = result.seats.find((seat) => seat.id === 'agy-future-model-9');
      expect(agySeat?.roles).toEqual(['implementer']);
      expect(result.reasons['agy-future-model-9']).toContain(
        'agy seat treated edit-only (default): the orchestrator runs its checks and commits',
      );
    });

    it('treats an agy seat as full only when told every agy host is full', () => {
      const result = expectValidCatalogue({ tools, models, allAgyHostsFull: true });
      expect(result.reasons['agy-future-model-9']).toContain(
        'agy seat treated full: every agy lane-runner host is full',
      );
    });

    it('an explicit allAgyHostsFull: false is the default treatment', () => {
      const omitted = recommendSeats({ tools, models, policy: NO_POLICY });
      const explicitFalse = recommendSeats({
        tools,
        models,
        policy: NO_POLICY,
        allAgyHostsFull: false,
      });
      expect(explicitFalse).toEqual(omitted);
    });
  });

  describe('table: policy.useFreeSeats false', () => {
    const tools = [tool('opencode'), tool('grok')];
    const freePlusPaidModels: ModelsByTool = {
      opencode: [
        model('openrouter/z-ai/glm-5.3-flash', 'paid'),
        model('nvidia/z-ai/glm-5.3', 'free'),
      ],
      grok: [model('grok-4.7')],
    };
    const onlyFreeModels: ModelsByTool = {
      opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('glm-5.3-flash', 'free')],
      grok: [model('grok-4.7-fast', 'free'), model('grok-code-fast-4.7', 'free')],
    };

    it('skips free seats, lets a paid seat lead, and keeps the paid-free chain', () => {
      const result = expectValidCatalogue({
        tools,
        models: freePlusPaidModels,
        policy: { useFreeSeats: false },
      });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-openrouter-z-ai-glm-5.3-flash',
      ]);
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7']);
      expect(result.seats.some((seat) => seat.costClass === 'free')).toBe(false);
      expect(result.skipped.join(' ')).toContain('nvidia/z-ai/glm-5.3');
      expect(result.skipped.join(' ')).toContain('policy.useFreeSeats is false');
      expect(result.reasons['opencode-openrouter-z-ai-glm-5.3-flash']).toContain(
        'a paid seat may lead',
      );
    });

    it('lets paid-only implementers through when the flag is false', () => {
      const result = expectValidCatalogue({
        tools,
        models: {
          opencode: [model('openrouter/z-ai/glm-5.3-flash', 'paid')],
          grok: [model('grok-4.7')],
        },
        policy: { useFreeSeats: false },
      });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-openrouter-z-ai-glm-5.3-flash',
      ]);
    });

    it('refuses the catalogue when every implementer is free', () => {
      const result = recommendSeats({
        tools,
        models: onlyFreeModels,
        policy: { useFreeSeats: false },
      });
      expect(result.outcome).toBe('no-valid-catalogue');
      if (result.outcome === 'no-valid-catalogue') {
        expect(result.reasons.join(' ')).toContain('no implementer seat');
        expect(result.skipped).toHaveLength(4);
        for (const skip of result.skipped) {
          expect(skip).toContain('it is a free seat and policy.useFreeSeats is false');
        }
      }
    });

    it('skips mislabelled free-looking seats while keeping the paid one', () => {
      const result = expectValidCatalogue({
        tools,
        models: {
          opencode: [
            model('openrouter/poolside/laguna-s-2.1:free', 'paid'),
            model('openrouter/minimax/minimax-m3', 'paid', 'FREE'),
            model('openrouter/z-ai/glm-5.3-flash', 'paid'),
          ],
          grok: [model('grok-4.7')],
        },
        policy: { useFreeSeats: false },
      });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-openrouter-z-ai-glm-5.3-flash',
      ]);
      const looksFreeSkips = result.skipped.filter((skip) => skip.includes('looks free'));
      expect(looksFreeSkips).toHaveLength(2);
    });

    it('skips a model ending -free and a variant ending -free, both declared paid', () => {
      const result = expectValidCatalogue({
        tools,
        models: {
          opencode: [
            model('openrouter/poolside/laguna-s-2.1-free', 'paid'),
            model('openrouter/minimax/minimax-m3', 'paid', 'fast-free'),
            model('openrouter/z-ai/glm-5.3-flash', 'paid'),
          ],
          grok: [model('grok-4.7')],
        },
        policy: { useFreeSeats: false },
      });
      expect(result.chains.implementer?.map((step) => step.seatId)).toEqual([
        'opencode-openrouter-z-ai-glm-5.3-flash',
      ]);
      expect(result.chains.reviewer?.map((step) => step.seatId)).toEqual(['grok-grok-4.7']);
      const looksFreeSkips = result.skipped.filter((skip) => skip.includes('looks free'));
      expect(looksFreeSkips).toHaveLength(2);
      expect(looksFreeSkips.join(' ')).toContain('laguna-s-2.1-free');
      expect(looksFreeSkips.join(' ')).toContain('minimax-m3');
    });

    it('explicit true equals absent', () => {
      const withTrue = recommendSeats({
        tools,
        models: onlyFreeModels,
        policy: { useFreeSeats: true },
      });
      const withAbsent = recommendSeats({ tools, models: onlyFreeModels, policy: NO_POLICY });
      expect(withTrue).toEqual(withAbsent);

      const withTruePaid = recommendSeats({
        tools,
        models: freePlusPaidModels,
        policy: { useFreeSeats: true },
      });
      const withAbsentPaid = recommendSeats({
        tools,
        models: freePlusPaidModels,
        policy: NO_POLICY,
      });
      expect(withTruePaid).toEqual(withAbsentPaid);
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
          grok: [model('gemini-3.1-pro', 'paid')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('claude-code'), tool('opencode'), tool('grok')],
        models: {
          'claude-code': [model('claude-sonnet-4-5')],
          opencode: [model('nvidia/z-ai/glm-5.3', 'plan-quota'), model('xai/grok-4.7', 'free')],
          grok: [model('gemini-3.1-pro')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('agy'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free'), model('xai/grok-4.7', 'free')],
          agy: [model('future-model-9', 'free')],
          grok: [model('gemini-3.1-pro')],
        },
        policy: NO_POLICY,
      },
      {
        tools: [tool('opencode'), tool('grok')],
        models: {
          opencode: [model('nvidia/z-ai/glm-5.3', 'free', 'none'), model('xai/grok-4.7', 'free')],
          grok: [model('gemini-3.1-pro')],
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
