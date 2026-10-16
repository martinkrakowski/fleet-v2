/**
 * Seat and chain policy (plan section 3, lane O5). Pure: no filesystem,
 * environment or clock access. The loader runs `validateSeatPolicy` on every
 * v2 installation so a hand-edited file cannot bypass it; v1 files are never
 * refused by policy and only reported through `v1FamilyWarnings`.
 *
 * The model-family rule is copied here rather than imported from
 * `@fleet/evidence-and-acceptance`: installation must not depend on it.
 */

import type {
  ChainStep,
  ChainsSection,
  FleetInstallationModel,
  SeatModel,
  SeatRole,
} from './types.js';

/** Roles whose chain must not share a family with the implementer chain. */
const REVIEWER_ROLES: readonly Exclude<SeatRole, 'implementer'>[] = [
  'reviewer',
  'high-risk-reviewer',
];

const CHAIN_ROLES: readonly SeatRole[] = ['implementer', 'reviewer', 'high-risk-reviewer'];

/**
 * Size, speed and cost suffixes stripped from a model name, repeatedly, to
 * reach the underlying model family. `flashx` precedes `flash` so the longer
 * suffix is removed whole.
 */
const FAMILY_SUFFIXES: readonly string[] = [
  'flashx',
  'flash',
  'prime',
  'preview',
  'mini',
  'lite',
  'free',
  'paid',
];

/** Strip one trailing size/speed/cost suffix (`-flash`, `:free`, ...) if present. */
function stripOneFamilySuffix(value: string): string {
  for (const suffix of FAMILY_SUFFIXES) {
    for (const separator of [':', '-']) {
      const token = separator + suffix;
      if (value.endsWith(token) && value.length > token.length) {
        return value.slice(0, value.length - token.length);
      }
    }
  }
  return value;
}

/**
 * The underlying model family of a model id: every provider prefix (all
 * leading path segments up to the model name), any `#variant`, anything from
 * the first `:` after the model name (`:nitro`, `:thinking`, `:free`/`:paid`,
 * ...), any `@...` suffix (`@20250929`, ...) and the size and speed suffixes
 * are stripped, and the remainder is compared case-insensitively.
 * `openrouter/z-ai/glm-5.3`, `nvidia/z-ai/glm-5.3-flash` and
 * `z-ai/glm-5.3#none` share one family.
 *
 * An empty family (from `''`, `'/'`, `'z-ai/'`, `'#low'`) is invalid; callers
 * comparing families must fail closed and treat an empty family as equal to
 * every other family. The installation parser refuses a seat whose model
 * yields an empty family.
 */
export function underlyingModelFamily(model: string): string {
  let value = model.trim();
  const hashIndex = value.indexOf('#');
  if (hashIndex !== -1) {
    value = value.slice(0, hashIndex);
  }
  const separatorIndex = value.lastIndexOf('/');
  if (separatorIndex !== -1) {
    value = value.slice(separatorIndex + 1);
  }
  const colonIndex = value.indexOf(':');
  if (colonIndex !== -1) {
    value = value.slice(0, colonIndex);
  }
  const atIndex = value.indexOf('@');
  if (atIndex !== -1) {
    value = value.slice(0, atIndex);
  }
  value = value.toLowerCase();
  for (;;) {
    const stripped = stripOneFamilySuffix(value);
    if (stripped === value) {
      return value;
    }
    value = stripped;
  }
}

/** Compile a glob (`*`, `?`) on a model id into a case-insensitive RegExp. */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (const character of pattern) {
    if (character === '*') {
      source += '.*';
    } else if (character === '?') {
      source += '.';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function seatSteps(chains: ChainsSection | undefined, role: SeatRole): readonly ChainStep[] {
  return chains?.[role] ?? [];
}

/**
 * Validate the seat and chain policy of a derived v2 model and return every
 * violation as an error string. Rules: every chain references existing seats;
 * a seat's roles include the chain's role; no seat in the reviewer or
 * high-risk-reviewer chain shares a family with any seat in the implementer
 * chain; a seat holding implementer and a reviewer role is refused; a free
 * seat is never the only seat of a role; forbidden routes refuse matching
 * seats; the per-lane cost ceiling is a positive number when present.
 */
export function validateSeatPolicy(installation: FleetInstallationModel): string[] {
  const errors: string[] = [];
  const seats = installation.seats ?? [];
  const chains = installation.chains;
  const policy = installation.policy;

  const seatsById = new Map<string, SeatModel>();
  for (const seat of seats) {
    seatsById.set(seat.id, seat);
  }

  // A seat whose model yields an empty model family is refused: an empty
  // family can never prove reviewer independence.
  for (const seat of seats) {
    if (underlyingModelFamily(seat.model) === '') {
      errors.push(`seats.${seat.id}: model "${seat.model}" yields an empty model family`);
    }
  }

  // A seat holding implementer and a reviewer role is refused.
  for (const seat of seats) {
    const holdsImplementer = seat.roles.includes('implementer');
    const holdsReviewer = seat.roles.some((role) => role !== 'implementer');
    if (holdsImplementer && holdsReviewer) {
      errors.push(`seats.${seat.id}: a seat must not hold implementer and a reviewer role`);
    }
  }

  const chainSeatIds = new Map<SeatRole, string[]>();
  for (const role of CHAIN_ROLES) {
    const steps = seatSteps(chains, role);
    const ids: string[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const seat = seatsById.get(step.seatId);
      if (seat === undefined) {
        errors.push(`chains.${role}[${index}]: references unknown seat "${step.seatId}"`);
        continue;
      }
      if (!seat.roles.includes(role)) {
        errors.push(
          `chains.${role}[${index}]: seat "${step.seatId}" does not hold the role "${role}"`,
        );
      }
      ids.push(step.seatId);
    }
    chainSeatIds.set(role, ids);
  }

  // A free seat is never the only seat of a role.
  for (const role of CHAIN_ROLES) {
    const ids = chainSeatIds.get(role) ?? [];
    if (ids.length === 1) {
      const seat = seatsById.get(ids[0]);
      if (seat !== undefined && seat.costClass === 'free') {
        errors.push(
          `chains.${role}: the free seat "${seat.id}" must not be the only seat of the role`,
        );
      }
    }
  }

  // No seat holding a reviewer role shares a family with any implementer
  // seat, whether or not the seat is a chain member.
  const implementerIds = chainSeatIds.get('implementer') ?? [];
  const implementerFamilies = new Set(
    implementerIds
      .map((id) => seatsById.get(id))
      .filter((seat): seat is SeatModel => seat !== undefined)
      .map((seat) => underlyingModelFamily(seat.model)),
  );
  if (implementerFamilies.size > 0) {
    const chainIdsByRole = new Map<SeatRole, Set<string>>(
      REVIEWER_ROLES.map((role) => [role, new Set(chainSeatIds.get(role) ?? [])]),
    );
    for (const seat of seats) {
      const reviewerRole = seat.roles.find((role) => role !== 'implementer');
      if (reviewerRole === undefined) {
        continue;
      }
      const seatFamily = underlyingModelFamily(seat.model);
      const shares = [...implementerFamilies].some(
        (family) => family === seatFamily || family === '' || seatFamily === '',
      );
      if (shares) {
        const inChain = chainIdsByRole.get(reviewerRole)?.has(seat.id) ?? false;
        errors.push(
          `${inChain ? `chains.${reviewerRole}` : `seats.${seat.id}`}: seat "${seat.id}" shares the implementer chain's model family (${seat.model})`,
        );
      }
    }
  }

  // Forbidden routes refuse matching seats.
  for (const [index, route] of (policy?.forbiddenRoutes ?? []).entries()) {
    const matcher = globToRegExp(route.modelPattern);
    for (const seat of seats) {
      if (seat.tool === route.tool && matcher.test(seat.model)) {
        errors.push(
          `policy.forbiddenRoutes[${index}]: seat "${seat.id}" matches the forbidden route (${seat.model})`,
        );
      }
    }
  }

  // The per-lane cost ceiling is a positive number when present.
  const ceiling = policy?.perLaneCostCeiling;
  if (ceiling !== undefined && !(typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0)) {
    errors.push('policy.perLaneCostCeiling: must be a positive number');
  }

  return errors;
}

/**
 * The v1 policy report (never a refusal): when the mapped v1 reviewer seat
 * shares the implementer chain's model family, the loader records this
 * warning instead of refusing, so v1 behaviour is kept.
 */
export const V1_FAMILY_WARNING_PREFIX = 'policy: v1 reviewer shares the implementer model family';

export function v1FamilyWarnings(installation: FleetInstallationModel): string[] {
  const seats = installation.seats ?? [];
  const chains = installation.chains;
  const implementerFamilies = new Set(
    seatSteps(chains, 'implementer')
      .map((step) => seats.find((seat) => seat.id === step.seatId))
      .filter((seat): seat is SeatModel => seat !== undefined)
      .map((seat) => underlyingModelFamily(seat.model)),
  );
  if (implementerFamilies.size === 0) {
    return [];
  }
  const warnings: string[] = [];
  for (const role of REVIEWER_ROLES) {
    for (const step of seatSteps(chains, role)) {
      const seat = seats.find((candidate) => candidate.id === step.seatId);
      if (seat !== undefined) {
        const seatFamily = underlyingModelFamily(seat.model);
        const shares = [...implementerFamilies].some(
          (family) => family === seatFamily || family === '' || seatFamily === '',
        );
        if (shares) {
          warnings.push(
            `${V1_FAMILY_WARNING_PREFIX} (${seat.model}); v1 files are warned, not refused`,
          );
        }
      }
    }
  }
  return warnings;
}
