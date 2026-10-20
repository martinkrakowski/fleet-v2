// AllowedSeatAdapter tests (free-seat plan FS3a-B): the flag-on behaviour, and
// with the flag off the paid/free/variant/mixed/unknown cases for a dispatch
// triple and a reviewer model.
import { describe, expect, it } from 'vitest';

import { AllowedSeatAdapter } from '../AllowedSeatAdapter.adapter.js';
import type { AllowedSeatCatalogueSeat } from '../../../application/ports/out/AllowedSeatPort.out-port.js';

const seats: readonly AllowedSeatCatalogueSeat[] = [
  {
    id: 'paid',
    tool: 'opencode',
    model: 'b/paid-model',
    variant: 'default',
    costClass: 'paid',
  },
  { id: 'glm-free', tool: 'opencode', model: 'nvidia/z-ai/glm-5.3', variant: 'default', costClass: 'free' },
  { id: 'xy-paid', tool: 'opencode', model: 'x/y', costClass: 'paid' },
  { id: 'xy-paid-default', tool: 'opencode', model: 'x/y', variant: 'default', costClass: 'paid' },
  { id: 'xy-free', tool: 'opencode', model: 'x/y', variant: 'Free', costClass: 'free' },
  { id: 'twin-free', tool: 'opencode', model: 't/twin', costClass: 'free' },
  { id: 'twin-paid', tool: 'opencode', model: 't/twin', costClass: 'paid' },
];

describe('AllowedSeatAdapter', () => {
  it('allows an unknown triple when the flag is absent', () => {
    const adapter = new AllowedSeatAdapter({ seats });
    expect(adapter.checkDispatchSeat({ tool: 'opencode', model: 'unknown/model' })).toEqual({
      allowed: true,
      useFreeSeats: true,
    });
  });

  it('allows an unknown triple when the flag is true', () => {
    const adapter = new AllowedSeatAdapter({ seats, policy: { useFreeSeats: true } });
    expect(adapter.checkDispatchSeat({ tool: 'opencode', model: 'unknown/model' })).toEqual({
      allowed: true,
      useFreeSeats: true,
    });
  });

  describe('with the flag false', () => {
    const adapter = new AllowedSeatAdapter({ seats, policy: { useFreeSeats: false } });

    it('allows a paid seat and records the flag value it saw', () => {
      expect(
        adapter.checkDispatchSeat({ tool: 'opencode', model: 'b/paid-model', variant: 'default' }),
      ).toEqual({ allowed: true, useFreeSeats: false });
    });

    it('refuses the free glm seat naming its id', () => {
      expect(
        adapter.checkDispatchSeat({ tool: 'opencode', model: 'nvidia/z-ai/glm-5.3', variant: 'default' }),
      ).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason:
          'Seat (tool opencode, model nvidia/z-ai/glm-5.3, variant default) is a free seat (glm-free); policy.useFreeSeats is false',
      });
    });

    it('allows x/y without a variant and refuses its free variant', () => {
      expect(adapter.checkDispatchSeat({ tool: 'opencode', model: 'x/y' })).toEqual({
        allowed: true,
        useFreeSeats: false,
      });
      expect(adapter.checkDispatchSeat({ tool: 'opencode', model: 'x/y', variant: 'free' })).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason:
          'Seat (tool opencode, model x/y, variant free) is a free seat (xy-free); policy.useFreeSeats is false',
      });
    });

    it('refuses a twin match of mixed cost class naming both ids', () => {
      expect(adapter.checkDispatchSeat({ tool: 'opencode', model: 't/twin' })).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason:
          'Seat (tool opencode, model t/twin, variant none) matches catalogue seats of mixed cost class (twin-free, twin-paid); policy.useFreeSeats is false, so the ambiguous match is refused',
      });
    });

    it('refuses a paid model on another tool as not in the catalogue', () => {
      expect(adapter.checkDispatchSeat({ tool: 'agy', model: 'b/paid-model' })).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason:
          "Seat (tool agy, model b/paid-model, variant none) is not in the installation's seat catalogue; policy.useFreeSeats is false, so only a catalogue seat that is not free may run",
      });
    });

    it('allows a paid reviewer model', () => {
      expect(adapter.checkReviewerModel({ model: 'b/paid-model' })).toEqual({
        allowed: true,
        useFreeSeats: false,
      });
    });

    it('refuses the x/y:free reviewer form through the variant seat', () => {
      expect(adapter.checkReviewerModel({ model: 'x/y:free' })).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason: 'Reviewer model x/y:free is a free seat (xy-free); policy.useFreeSeats is false',
      });
    });

    it('matches a reviewer model variant case-insensitively against a paid seat (FS3a review)', () => {
      // `x/y:Default` must match the seat whose variant is `default` even
      // though the query spells it with an uppercase D.
      expect(adapter.checkReviewerModel({ model: 'x/y:Default' })).toEqual({
        allowed: true,
        useFreeSeats: false,
      });
    });

    it('refuses a reviewer model whose variant case differs from a free seat (FS3a review)', () => {
      // `x/y:FREE` and a seat with variant `Free` declared free must be
      // refused, not missed by a case-sensitive comparison.
      expect(adapter.checkReviewerModel({ model: 'x/y:FREE' })).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason: 'Reviewer model x/y:FREE is a free seat (xy-free); policy.useFreeSeats is false',
      });
    });

    it('matches a padded model after trimming (FS3a review)', () => {
      expect(adapter.checkDispatchSeat({ tool: 'opencode', model: ' x/y ' })).toEqual({
        allowed: true,
        useFreeSeats: false,
      });
    });

    it('refuses an unknown reviewer model as not in the catalogue', () => {
      expect(adapter.checkReviewerModel({ model: 'nope/unknown' })).toEqual({
        allowed: false,
        useFreeSeats: false,
        reason:
          "Reviewer model nope/unknown is not in the installation's seat catalogue; policy.useFreeSeats is false, so only a catalogue seat that is not free may run",
      });
    });
  });
});
