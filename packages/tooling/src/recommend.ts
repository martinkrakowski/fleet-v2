/**
 * The seat recommender (plan section 3, lane O6). Pure and versioned: no
 * filesystem, environment, clock or network access, no console output. The
 * caller supplies what the detectors observed; the recommender turns it into
 * a seat catalogue with chains and a one-line reason per seat.
 *
 * Rules, in order:
 * - Implementer chain: seats from tools that can run commands or are
 *   edit-only (a read-only tool can only review). Free and plan-quota seats
 *   come first, then paid seats; a paid seat is proposed only after a
 *   working free or plan-quota seat, so an input with no free or plan-quota
 *   implementer seat yields no catalogue at all. With `policy.useFreeSeats`
 *   false, free and free-looking candidates are skipped with a reason and a
 *   paid seat may lead.
 * - Reviewer and high-risk reviewer: the strongest seat whose model family
 *   is absent from the implementer chain (the same strongest seat holds both
 *   reviewer roles). Strength comes from the ordered table below.
 * - Tools whose sign-in could not be confirmed and model lists reported
 *   `unknown` are skipped, and the skip is recorded with a reason.
 * - The policy gates the candidate pool before any ranking: forbidden
 *   routes refuse matching candidates outright, and an allow-list (`allowedRoutes`
 *   in the input), when the caller names one, admits only matching
 *   candidates. A disallowed candidate is skipped with a reason and never
 *   appears in the output, not even as a lower-ranked chain entry.
 * - An agy seat follows the runner mode (plan D7): it is treated
 *   edit-only — the orchestrator runs its checks and commits — unless the
 *   input says every agy lane-runner host in the installation is `full`.
 *   The treatment is stated on every agy seat's reason line.
 * - The catalogue must pass `@fleet/installation`'s `validateSeatPolicy`.
 *   The recommender never returns an invalid catalogue: if no valid one can
 *   be built, the typed `no-valid-catalogue` result carries the reasons.
 *
 * Two policy rules shape the chains beyond the ordering above: a free seat
 * must not be the only seat of a role, and no seat holding a reviewer role
 * may share a model family with the implementer chain. Both are enforced by
 * the validator; the selection below never builds a chain that violates
 * them, and refuses the catalogue when no valid assignment exists. Absent
 * or true changes nothing.
 */

import {
  underlyingModelFamily,
  validateSeatPolicy,
  type ChainStep,
  type ChainsSection,
  type CostClass,
  type FleetInstallationModel,
  type PolicySection,
  type SeatSection,
} from '@fleet/installation';

import { agyCapabilitiesFor } from './agy.js';
import { BUILT_IN_TOOLS } from './descriptors.js';
import type { AgyMode, SignInStatus, ToolCapabilities, ToolDescriptor, ToolId } from './types.js';

/** Version of the recommender's output shape. Starts at `1`. */
export const RECOMMENDER_VERSION = '1' as const;

/** One detected tool the recommender may draw seats from. */
export interface DetectedTool {
  readonly id: ToolId;
  /** Only a tool confirmed signed in contributes seats. */
  readonly signIn: SignInStatus;
}

/** One model a tool can serve, as the caller resolved its cost. */
export interface ModelInfo {
  readonly id: string;
  readonly variant?: string;
  /**
   * The cost class of a seat on this model. Optional only when the tool's
   * descriptor cost source already determines it (`plan-quota`, `free-tier`
   * or `pay-per-token`); a `mixed` tool must name it per model.
   */
  readonly costClass?: CostClass;
}

/** A tool's model information: a non-empty list or explicitly `unknown`. */
export type ModelInfoList = readonly ModelInfo[] | 'unknown';

/** Model information per tool id; a missing entry counts as `unknown`. */
export type ModelsByTool = Readonly<Partial<Record<ToolId, ModelInfoList>>>;

/** The policy shape the recommender respects and passes through. */
export type RecommendPolicy = PolicySection;

/**
 * One allow-list rule of the recommender input: a built-in tool and a glob
 * (`*`, `?`) over the model ids it may serve, matched like a forbidden
 * route. A candidate is admitted only by a rule naming its tool whose
 * pattern matches its model id.
 */
export interface AllowedRouteRule {
  readonly tool: ToolId;
  readonly modelPattern: string;
}

/** A catalogue the recommender could build and validate. */
export interface SeatCatalogueResult {
  readonly version: typeof RECOMMENDER_VERSION;
  readonly outcome: 'catalogue';
  readonly seats: readonly SeatSection[];
  readonly chains: ChainsSection;
  /** One line per seat id, stating why the seat is in the catalogue. */
  readonly reasons: Readonly<Record<string, string>>;
  /** One line per skipped tool or model, stating why it was skipped. */
  readonly skipped: readonly string[];
}

/** No valid catalogue exists; the reasons say what was missing or refused. */
export interface NoValidCatalogueResult {
  readonly version: typeof RECOMMENDER_VERSION;
  readonly outcome: 'no-valid-catalogue';
  readonly reasons: readonly string[];
  readonly skipped: readonly string[];
}

export type SeatRecommendation = SeatCatalogueResult | NoValidCatalogueResult;

/**
 * Ordered model tiers, strongest first. This table is data fleet
 * maintains: it is a fixed ordering used to pick reviewers, not a claim
 * about model quality, and it is the only place strength is defined. The
 * keys are the tier names produced by the tooling-local `modelTier` (the
 * old pre-digit prefix), never by `underlyingModelFamily`: since the
 * owner decision of 2026-10-16 the family is the vendor line only (one
 * family per vendor line, e.g. every Claude model is `claude`), which can
 * no longer rank tiers. A tier not listed ranks below every listed tier,
 * in first-seen order.
 */
const STRENGTH_ORDER: readonly string[] = [
  'claude-opus',
  'glm',
  'claude-sonnet',
  'grok',
  'claude-haiku',
];

/**
 * The tooling-local strength tier of a model id: the same pre-processing as
 * `underlyingModelFamily` (lowercase, trim, cut at `#`, drop the provider
 * prefix, cut at `:` or `@`) and then the leading run of letters and hyphens
 * before the first digit, with a trailing hyphen trimmed. An id with no
 * digit keeps its whole remaining name, so `space-bunny-free` is a tier of
 * its own. Used ONLY for strength ranking above; the reviewer/implementer
 * disjointness check keeps using `underlyingModelFamily` (the vendor-line
 * family), so a Sonnet implementer refuses an Opus reviewer.
 */
function modelTier(id: string): string {
  let value = id.trim().toLowerCase();
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
  const digitIndex = value.search(/[0-9]/);
  if (digitIndex !== -1) {
    value = value.slice(0, digitIndex);
  }
  if (value.endsWith('-')) {
    value = value.slice(0, -1);
  }
  return value;
}

/** Cost-class ordering: free first, then plan-quota, then paid. */
const COST_RANK: Readonly<Record<CostClass, number>> = {
  free: 0,
  'plan-quota': 1,
  paid: 2,
};

/** One usable (tool, model) pair the recommender may turn into a seat. */
interface Candidate {
  readonly tool: ToolId;
  readonly displayName: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly costClass: CostClass;
  readonly family: string;
  /** Tooling-local strength tier (`modelTier`), never the family. */
  readonly tier: string;
  /** Lower is stronger; unlisted tiers rank after the listed ones. */
  readonly strength: number;
}

const SEAT_ID_SAFE = /[^A-Za-z0-9._-]+/g;

function sanitizeSeatIdPart(value: string): string {
  const sanitized = value.replace(SEAT_ID_SAFE, '-');
  return sanitized === '' ? 'model' : sanitized;
}

/** A deterministic, unique seat id from tool, model and variant. */
function seatId(candidate: Candidate, used: ReadonlySet<string>): string {
  let id = `${candidate.tool}-${sanitizeSeatIdPart(candidate.modelId)}`;
  if (candidate.variant !== undefined) {
    id += `-${sanitizeSeatIdPart(candidate.variant)}`;
  }
  let unique = id;
  let counter = 2;
  while (used.has(unique)) {
    unique = `${id}-${counter}`;
    counter += 1;
  }
  return unique;
}

/** Compile a forbidden-route glob (`*`, `?`) into a case-insensitive RegExp. */
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

/** True when a model id or variant looks free (the F2 backstop pattern). */
function looksFree(modelId: string, variant: string | undefined): boolean {
  return (
    modelId.toLowerCase().endsWith(':free') ||
    modelId.toLowerCase().endsWith('-free') ||
    (variant !== undefined &&
      (variant.toLowerCase() === 'free' || variant.toLowerCase().endsWith('-free')))
  );
}

/**
 * Resolve one model entry onto a candidate. `undefined` marks a model the
 * recommender must skip; the returned reason says why.
 */
function resolveModel(
  tool: ToolId,
  displayName: string,
  info: ModelInfo,
  tierSeenOrder: Map<string, number>,
): { candidate?: Candidate; skipReason?: string } {
  const id = info.id.trim();
  if (id === '') {
    return { skipReason: `model on ${displayName} skipped: the model id is empty` };
  }
  const descriptor = BUILT_IN_TOOLS.find((entry) => entry.id === tool);
  if (descriptor === undefined) {
    return { skipReason: `model ${id} on ${tool} skipped: ${tool} is not a built-in tool` };
  }
  let costClass = info.costClass;
  if (costClass === undefined) {
    if (descriptor.costSource === 'plan-quota') {
      costClass = 'plan-quota';
    } else if (descriptor.costSource === 'free-tier') {
      costClass = 'free';
    } else if (descriptor.costSource === 'pay-per-token') {
      costClass = 'paid';
    } else {
      return {
        skipReason: `model ${id} on ${displayName} skipped: no cost class given for a mixed-cost tool`,
      };
    }
  }
  const family = underlyingModelFamily(id);
  if (family === '') {
    return { skipReason: `model ${id} on ${displayName} skipped: its model family is empty` };
  }
  const tier = modelTier(id);
  if (!tierSeenOrder.has(tier)) {
    tierSeenOrder.set(tier, tierSeenOrder.size);
  }
  const strengthIndex = STRENGTH_ORDER.indexOf(tier);
  const strength =
    strengthIndex === -1 ? STRENGTH_ORDER.length + (tierSeenOrder.get(tier) ?? 0) : strengthIndex;
  return {
    candidate: {
      tool,
      displayName,
      modelId: id,
      variant: info.variant,
      costClass,
      family,
      tier,
      strength,
    },
  };
}

/** Candidates ordered strongest first (lower rank is stronger). */
function byStrength(left: Candidate, right: Candidate): number {
  return left.strength - right.strength;
}

/**
 * Implementer order: free and plan-quota first, then paid; within a cost
 * class, strongest first, ties in input order (the sort is stable).
 */
function byImplementerOrder(left: Candidate, right: Candidate): number {
  const cost = COST_RANK[left.costClass] - COST_RANK[right.costClass];
  if (cost !== 0) {
    return cost;
  }
  return left.strength - right.strength;
}

interface ReviewerPick {
  readonly seat: Candidate;
  /** A second seat so a free strongest seat is not the only reviewer. */
  readonly extra?: Candidate;
}

/**
 * Pick the reviewer and high-risk reviewer: the strongest candidate whose
 * family is absent from the implementer chain. A free seat must not be the
 * only seat of a role, so a free strongest seat is followed by the next
 * strongest candidate, and with no such companion the catalogue is refused.
 */
function pickReviewers(candidates: readonly Candidate[]): ReviewerPick | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const sorted = [...candidates].sort(byStrength);
  const strongest = sorted[0];
  if (strongest.costClass !== 'free') {
    return { seat: strongest };
  }
  if (sorted.length > 1) {
    return { seat: strongest, extra: sorted[1] };
  }
  return undefined;
}

/**
 * The mode an agy seat is treated as (plan D7): edit-only unless the
 * caller says every agy lane-runner host in the installation is `full`.
 * The default is the conservative one: an installation the caller says
 * nothing about never gets a seat assumed to run commands.
 */
function agySeatMode(allAgyHostsFull: boolean): AgyMode {
  return allAgyHostsFull ? 'full' : 'edit-only';
}

/**
 * The capabilities a seat on this tool has under the resolved agy mode.
 * Only agy has mode-keyed capabilities (plan D7); every other tool is
 * fully described by its single capability set.
 */
function seatCapabilities(descriptor: ToolDescriptor, agyMode: AgyMode): ToolCapabilities {
  return descriptor.id === 'agy' ? agyCapabilitiesFor(agyMode) : descriptor.capabilities;
}

/**
 * One clause stating how an agy seat is treated (plan D7), appended to the
 * seat's reason line; empty for every other tool.
 */
function modeClause(tool: ToolId, agyMode: AgyMode): string {
  if (tool !== 'agy') {
    return '';
  }
  return agyMode === 'full'
    ? '; agy seat treated full: every agy lane-runner host is full'
    : '; agy seat treated edit-only (default): the orchestrator runs its checks and commits';
}

/**
 * Recommend seats and chains for the detected tools. Pure: the same input
 * always yields the same output, and nothing outside `input` is read.
 */
export function recommendSeats(input: {
  tools: readonly DetectedTool[];
  models: ModelsByTool;
  policy: RecommendPolicy;
  /**
   * True only when every agy lane-runner host in the installation declares
   * `agyMode: full` (plan D7). Default false: an agy seat is treated as
   * edit-only — the orchestrator runs its checks and commits — unless the
   * caller says otherwise.
   */
  allAgyHostsFull?: boolean;
  /**
   * Optional allow-list over the candidate pool. When present, only
   * candidates admitted by at least one rule are ranked at all — a
   * candidate outside it is skipped with a reason and never appears in the
   * output, not even as a lower-ranked entry or an extra reviewer seat. An
   * empty list admits nothing; an omitted one leaves the pool to the
   * policy's forbidden routes alone.
   */
  allowedRoutes?: readonly AllowedRouteRule[];
}): SeatRecommendation {
  const skipped: string[] = [];
  const tierSeenOrder = new Map<string, number>();
  const agyMode = agySeatMode(input.allAgyHostsFull === true);
  const freeSeatsOff = input.policy.useFreeSeats === false;

  // Usable candidates, per tool, in input order. Tools whose sign-in could
  // not be confirmed and model lists reported `unknown` are skipped.
  const candidates: Candidate[] = [];
  const seenTools = new Set<ToolId>();
  for (const detected of input.tools) {
    if (seenTools.has(detected.id)) {
      skipped.push(`tool ${detected.id} skipped: reported more than once; the first report wins`);
      continue;
    }
    seenTools.add(detected.id);
    const descriptor = BUILT_IN_TOOLS.find((entry) => entry.id === detected.id);
    if (descriptor === undefined) {
      skipped.push(`tool ${detected.id} skipped: not a built-in tool`);
      continue;
    }
    if (detected.signIn !== 'signed-in') {
      skipped.push(
        `tool ${descriptor.displayName} skipped: sign-in status is "${detected.signIn}", not "signed-in"`,
      );
      continue;
    }
    const models = input.models[detected.id];
    if (models === undefined || models === 'unknown') {
      skipped.push(
        `tool ${descriptor.displayName} skipped: its model list is unknown, so no seat can be named`,
      );
      continue;
    }
    if (models.length === 0) {
      skipped.push(`tool ${descriptor.displayName} skipped: its model list is empty`);
      continue;
    }
    for (const info of models) {
      const resolved = resolveModel(detected.id, descriptor.displayName, info, tierSeenOrder);
      if (resolved.skipReason !== undefined) {
        skipped.push(resolved.skipReason);
      } else if (resolved.candidate !== undefined) {
        candidates.push(resolved.candidate);
      }
    }
  }

  // Forbidden routes refuse matching seats outright.
  const forbidden = (input.policy.forbiddenRoutes ?? []).map((route) => ({
    route,
    matcher: globToRegExp(route.modelPattern),
  }));
  const notForbidden = candidates.filter(
    (candidate) =>
      !forbidden.some(
        ({ route, matcher }) => route.tool === candidate.tool && matcher.test(candidate.modelId),
      ),
  );

  // The allow-list, when the input names one, admits only matching
  // candidates. The gate runs here, before any ranking or role selection:
  // a disallowed candidate is skipped with a reason and can never re-enter
  // the output as a lower-ranked entry, an extra reviewer seat or any other
  // seat.
  const allowList = input.allowedRoutes?.map((rule) => ({
    tool: rule.tool,
    matcher: globToRegExp(rule.modelPattern),
  }));
  const allowed: Candidate[] = [];
  for (const candidate of notForbidden) {
    if (
      allowList !== undefined &&
      !allowList.some(({ tool, matcher }) => tool === candidate.tool && matcher.test(candidate.modelId))
    ) {
      skipped.push(
        `model ${candidate.modelId} on ${candidate.displayName} skipped: it is not on the policy allow-list`,
      );
      continue;
    }
    allowed.push(candidate);
  }

  // With policy.useFreeSeats false, free and free-looking candidates are
  // skipped with a reason before any ranking or role selection, so a paid
  // seat may lead the implementer chain.
  const eligible: Candidate[] = [];
  for (const candidate of allowed) {
    if (freeSeatsOff && candidate.costClass === 'free') {
      skipped.push(
        `model ${candidate.modelId} on ${candidate.displayName} skipped: it is a free seat and policy.useFreeSeats is false`,
      );
    } else if (freeSeatsOff && looksFree(candidate.modelId, candidate.variant)) {
      skipped.push(
        `model ${candidate.modelId} on ${candidate.displayName} skipped: its model or variant looks free but its cost class is "${candidate.costClass}", and policy.useFreeSeats is false`,
      );
    } else {
      eligible.push(candidate);
    }
  }

  // Implementer candidates: tools that can run commands, plus edit-only
  // tools whose checks and commits the orchestrator runs. A read-only tool
  // can only review. An agy seat's capabilities follow its mode (D7):
  // edit-only by default, `full` only when every agy lane-runner host is.
  const implementerCandidates = eligible.filter((candidate) => {
    const descriptor = BUILT_IN_TOOLS.find((entry) => entry.id === candidate.tool);
    if (descriptor === undefined) {
      return false;
    }
    const capabilities = seatCapabilities(descriptor, agyMode);
    return capabilities.canRunCommands || !capabilities.readOnlyMode;
  });

  // Paid seats are proposed only after a working free or plan-quota seat.
  const freeOrPlan = implementerCandidates.filter(
    (candidate) => COST_RANK[candidate.costClass] <= COST_RANK['plan-quota'],
  );
  const paidImplementers = implementerCandidates.filter(
    (candidate) => COST_RANK[candidate.costClass] === COST_RANK.paid,
  );
  if (!freeSeatsOff && freeOrPlan.length === 0 && paidImplementers.length > 0) {
    return {
      version: RECOMMENDER_VERSION,
      outcome: 'no-valid-catalogue',
      reasons: [
        'no implementer seat: paid seats are proposed only after a working free or plan-quota seat, and none is available',
      ],
      skipped,
    };
  }

  const implementerOrdered = [...freeOrPlan, ...paidImplementers].sort(byImplementerOrder);

  // A free seat must not be the only seat of a role.
  if (implementerOrdered.length === 1 && implementerOrdered[0].costClass === 'free') {
    return {
      version: RECOMMENDER_VERSION,
      outcome: 'no-valid-catalogue',
      reasons: [
        `no implementer chain: the only implementer seat (${implementerOrdered[0].modelId} on ${implementerOrdered[0].displayName}) is free, and a free seat must not be the only seat of a role`,
      ],
      skipped,
    };
  }

  // Reviewer candidates: every usable seat whose family is absent from the
  // implementer chain (read-only tools can review; so can every other tool).
  const implementerFamilies = new Set(implementerOrdered.map((candidate) => candidate.family));
  const reviewerCandidates = eligible.filter((candidate) => !implementerFamilies.has(candidate.family));
  const reviewerPick = pickReviewers(reviewerCandidates);
  if (implementerOrdered.length === 0 || reviewerPick === undefined) {
    const reasons: string[] = [];
    if (implementerOrdered.length === 0) {
      reasons.push('no implementer seat: no signed-in tool with a known model list can implement');
    }
    reasons.push(
      'no reviewer: no seat whose model family is absent from the implementer chain can serve as reviewer and high-risk reviewer',
    );
    return {
      version: RECOMMENDER_VERSION,
      outcome: 'no-valid-catalogue',
      reasons,
      skipped,
    };
  }

  // Assemble the catalogue.
  const usedIds = new Set<string>();
  const seats: SeatSection[] = [];
  const reasons: Record<string, string> = {};
  const implementerSteps: ChainStep[] = [];
  for (const candidate of implementerOrdered) {
    const id = seatId(candidate, usedIds);
    usedIds.add(id);
    seats.push({
      id,
      tool: candidate.tool,
      model: candidate.modelId,
      ...(candidate.variant === undefined ? {} : { variant: candidate.variant }),
      roles: ['implementer'],
      costClass: candidate.costClass,
    });
    reasons[id] =
      candidate.costClass === 'paid'
        ? freeSeatsOff
          ? `implementer: paid seat on ${candidate.displayName} (${candidate.modelId}); policy.useFreeSeats is false, so no free seat is proposed and a paid seat may lead${modeClause(candidate.tool, agyMode)}`
          : `implementer: paid seat on ${candidate.displayName} (${candidate.modelId}); paid only after the free or plan-quota seats${modeClause(candidate.tool, agyMode)}`
        : `implementer: ${candidate.costClass} seat on ${candidate.displayName} (${candidate.modelId}); free and plan-quota seats come first${modeClause(candidate.tool, agyMode)}`;
    implementerSteps.push({ seatId: id });
  }

  const reviewerSteps: ChainStep[] = [];
  const addReviewerSeat = (candidate: Candidate, reason: string): void => {
    const id = seatId(candidate, usedIds);
    usedIds.add(id);
    seats.push({
      id,
      tool: candidate.tool,
      model: candidate.modelId,
      ...(candidate.variant === undefined ? {} : { variant: candidate.variant }),
      roles: ['reviewer', 'high-risk-reviewer'],
      costClass: candidate.costClass,
    });
    reasons[id] = `${reason}${modeClause(candidate.tool, agyMode)}`;
    reviewerSteps.push({ seatId: id });
  };
  addReviewerSeat(
    reviewerPick.seat,
    `reviewer and high-risk reviewer: strongest seat (${reviewerPick.seat.modelId} on ${reviewerPick.seat.displayName}) whose model family is absent from the implementer chain`,
  );
  if (reviewerPick.extra !== undefined) {
    addReviewerSeat(
      reviewerPick.extra,
      `reviewer and high-risk reviewer: second seat (${reviewerPick.extra.modelId} on ${reviewerPick.extra.displayName}) so the free seat is not the only seat of the role`,
    );
  }

  const chains: ChainsSection = {
    implementer: implementerSteps,
    reviewer: reviewerSteps,
    'high-risk-reviewer': reviewerSteps,
  };

  // Fail closed: the catalogue is returned only when the loader's own
  // validator accepts it.
  const model: FleetInstallationModel = {
    schemaVersion: 2,
    hosts: {},
    seats,
    chains,
    policy: input.policy,
  };
  const errors = validateSeatPolicy(model);
  if (errors.length > 0) {
    return {
      version: RECOMMENDER_VERSION,
      outcome: 'no-valid-catalogue',
      reasons: ['the built catalogue failed the seat-policy validator:', ...errors],
      skipped,
    };
  }

  return {
    version: RECOMMENDER_VERSION,
    outcome: 'catalogue',
    seats,
    chains,
    reasons,
    skipped,
  };
}
