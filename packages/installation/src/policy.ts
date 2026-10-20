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
 * The underlying model family of a model id — one family per vendor line
 * (owner decision 2026-10-16): the id is lowercased and trimmed, cut at the
 * first `#` (any `#variant`), everything up to and including the last `/` is
 * dropped (every provider prefix), the remainder is cut at the first `:` or
 * `@` (`:nitro`, `:free`, `@20250929`, ...), and the family is then the
 * leading run of ASCII letters only, stopping at the first character that is
 * not `a`-`z`. Every model of a vendor line is one family, so tier words
 * before the first digit never split a line: `claude-opus-5-5`,
 * `claude-3-5-sonnet-20241022` and `claude-haiku-4-5` are all `claude`;
 * `grok-4.7` and `grok-code-fast-4.7` are `grok`; `gemini-flash-latest` and
 * `models/gemini-2.5-pro` are `gemini`; `gpt-5` and `gpt-oss-120b` are `gpt`;
 * `glm-z1-32b` is `glm`; `laguna-s-2.1` is `laguna`;
 * `space-bunny-free` is `space`.
 *
 * An empty family (from `''`, `'4o-mini'`, `'/'`, `'z-ai/'`, `'#low'`) is
 * invalid; callers comparing families must fail closed and treat an empty
 * family as equal to every other family. The installation parser refuses a
 * seat whose model yields an empty family.
 */
export function underlyingModelFamily(model: string): string {
  let value = model.trim().toLowerCase();
  const hashIndex = value.indexOf('#');
  if (hashIndex !== -1) {
    value = value.slice(0, hashIndex);
  }
  const separatorIndex = value.lastIndexOf('/');
  if (separatorIndex !== -1) {
    value = value.slice(separatorIndex + 1);
  }
  const specialIndex = value.search(/[:@]/);
  if (specialIndex !== -1) {
    value = value.slice(0, specialIndex);
  }
  const letters = /^[a-z]*/.exec(value);
  return letters === null ? '' : letters[0];
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
 *
 * `fileChains` are the chains as the installation file writes them. The two
 * reference rules report the positions of the chains they iterate, so the
 * loader hands the file chains in whenever the derived chains differ from
 * the file (`useFreeSeats` false drops free seats, FS1): the errors then
 * name the file's positions, and every other rule keeps running on the
 * derived chains. Without the parameter the derived chains are checked, as
 * before, and each reference error is still reported once.
 */
export function validateSeatPolicy(
  installation: FleetInstallationModel,
  fileChains?: ChainsSection,
): string[] {
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
    const ids: string[] = [];
    for (const step of seatSteps(chains, role)) {
      if (seatsById.has(step.seatId)) {
        ids.push(step.seatId);
      }
    }
    chainSeatIds.set(role, ids);
  }

  // The two reference rules report the positions of the chains they
  // iterate: the file chains when they are handed in (the flag is off, so
  // the derived chains lost their free seats), the derived chains
  // otherwise. One iteration over one chain set keeps every reference
  // error singular.
  for (const role of CHAIN_ROLES) {
    const steps = seatSteps(fileChains ?? chains, role);
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
    }
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

  // With the flag off, a seat that looks free but is declared paid or
  // plan-quota is refused: the declaration is the source of truth, and the
  // pattern is a backstop against a mislabelled seat surviving (F2).
  if (policy?.useFreeSeats === false) {
    for (const seat of seats) {
      if (seat.costClass !== 'paid' && seat.costClass !== 'plan-quota') {
        continue;
      }
      const variant = seat.variant;
      const variantLooksFree =
        variant !== undefined &&
        (variant.toLowerCase() === 'free' || variant.toLowerCase().endsWith('-free'));
      const modelLooksFree = seat.model.endsWith(':free') || seat.model.endsWith('-free');
      if (modelLooksFree || variantLooksFree) {
        const variantPart = variantLooksFree ? ` variant "${variant}"` : '';
        errors.push(
          `seats.${seat.id}: model "${seat.model}"${variantPart} looks free but costClass is "${seat.costClass}"; declare it free or remove it`,
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
