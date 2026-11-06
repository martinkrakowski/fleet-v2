/**
 * Seat and chain policy (plan section 3, lane O5). Pure: no filesystem,
 * environment or clock access. The loader runs `validateSeatPolicy` on every
 * v2 installation so a hand-edited file cannot bypass it; v1 files are never
 * refused by policy and only reported through `v1FamilyWarnings`.
 *
 * The model-family rule is copied here rather than imported from
 * `@fleet/evidence-and-acceptance`: installation must not depend on it.
 */

// Hashing is pure computation: it performs no I/O.
import { createHash } from 'node:crypto';

import { containsSecretShape } from '@fleet/shared';

import type {
  AutoMergePolicy,
  ChainRole,
  ChainStep,
  ChainsSection,
  ConductorReaperRepairKind,
  FleetInstallationModel,
  LiveTailContent,
  MergePolicyRead,
  MergeVetoMode,
  PolicySection,
  ResolvedConductorPolicy,
  ResolvedConductorReaperDiskPolicy,
  ResolvedConductorReaperPolicy,
  ResolvedConductorReaperWorktreePolicy,
  ResolvedMergeDaemonPolicy,
  ResolvedMergeRepositoryPolicy,
  SeatModel,
  SeatRole,
} from './types.js';
import { hasUnknownKeys, isPlainRecord, readBoundedInteger, readOwnDataProperty } from './policy-read.js';

/** Roles whose chain must not share a family with the implementer chain. */
const REVIEWER_ROLES: readonly Exclude<SeatRole, 'implementer'>[] = [
  'reviewer',
  'high-risk-reviewer',
];

const CHAIN_ROLES: readonly ChainRole[] = ['implementer', 'fix', 'reviewer', 'high-risk-reviewer'];

/** The seat role a chain's seats must hold: the fix chain is an implementer chain. */
function requiredSeatRole(chain: ChainRole): SeatRole {
  return chain === 'fix' ? 'implementer' : chain;
}

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

function seatSteps(chains: ChainsSection | undefined, role: ChainRole): readonly ChainStep[] {
  return chains?.[role] ?? [];
}

/**
 * Validate the seat and chain policy of a derived v2 model and return every
 * violation as an error string. Rules: every chain references existing seats;
 * a seat's roles include the chain's role; the fix chain's seats hold
 * `implementer`, and the fix chain counts as an implementer chain for the
 * family rule; no seat in the reviewer or high-risk-reviewer chain shares a
 * family with any seat in the implementer chain; a seat holding implementer
 * and a reviewer role is refused; a free seat is never the only seat of a
 * role; forbidden routes refuse matching seats; the per-lane cost ceiling is
 * a positive number when present.
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

  const chainSeatIds = new Map<ChainRole, string[]>();
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
      if (!seat.roles.includes(requiredSeatRole(role))) {
        errors.push(
          `chains.${role}[${index}]: seat "${step.seatId}" does not hold the role "${requiredSeatRole(role)}"`,
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
      const modelLooksFree =
        seat.model.toLowerCase().endsWith(':free') || seat.model.toLowerCase().endsWith('-free');
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
  const implementerIds = [
    ...(chainSeatIds.get('implementer') ?? []),
    ...(chainSeatIds.get('fix') ?? []),
  ];
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

/** The tail content an installation gets when `policy.liveTail` is absent (D10). */
export const DEFAULT_LIVE_TAIL_CONTENT: LiveTailContent = 'summaries';

/**
 * The effective live-tail content: `full` only when the policy says exactly
 * `full`; absent, malformed or anything else is `summaries`.
 */
export function resolveLiveTailContent(policy: PolicySection | undefined): LiveTailContent {
  if (policy?.liveTail?.content === 'full') {
    return 'full';
  }
  return DEFAULT_LIVE_TAIL_CONTENT;
}

/** Auto-merge for an installation without `policy.autoMerge`: off (plan A1, the owner's default). */
export const DEFAULT_AUTO_MERGE_POLICY: AutoMergePolicy = Object.freeze({
  enabled: false,
  allowHighRisk: false,
  onBlocked: 'ask-owner',
});

/**
 * The effective auto-merge policy: the block's values only when all three are
 * well-typed (`enabled` and `allowHighRisk` booleans, `onBlocked` exactly
 * `ask-owner` or `hold`); absent or malformed in any field is the default (off).
 * Always a fresh frozen object with the keys in canonical order.
 */
export function resolveAutoMergePolicy(policy: PolicySection | undefined): AutoMergePolicy {
  const block = policy?.autoMerge;
  if (
    block === undefined ||
    typeof block?.enabled !== 'boolean' ||
    typeof block?.allowHighRisk !== 'boolean' ||
    (block?.onBlocked !== 'ask-owner' && block?.onBlocked !== 'hold')
  ) {
    return Object.freeze({ ...DEFAULT_AUTO_MERGE_POLICY });
  }
  return Object.freeze({
    enabled: block.enabled,
    allowHighRisk: block.allowHighRisk,
    onBlocked: block.onBlocked,
  });
}

/** Repair kinds in canonical order; the first four are record-only (D14); `merged-worktree` and
 * `orphan-session` are destructive (D17). `orphan-session` stays last. */
export const CONDUCTOR_REAPER_REPAIR_KINDS: readonly ConductorReaperRepairKind[] = Object.freeze([
  'dead-attempt', 'leaked-slot', 'stale-stop', 'stale-attention', 'merged-worktree', 'orphan-session',
]);

/** The destructive repair kinds: an opt-in per installation, never a default (D14, D17). */
export const CONDUCTOR_DESTRUCTIVE_REPAIR_KINDS: readonly ConductorReaperRepairKind[] = Object.freeze([
  'orphan-session', 'merged-worktree',
]);

/** Inclusive integer bounds per number, in minutes (K2 brief, decision 4). */
export const CONDUCTOR_MINUTE_BOUNDS = Object.freeze({
  stopGraceMinutes: Object.freeze({ min: 5, max: 480 }),
  intervalMinutes: Object.freeze({ min: 1, max: 1440 }),
  graceMinutes: Object.freeze({ min: 4, max: 1440 }),
  staleStopMinutes: Object.freeze({ min: 5, max: 1440 }),
});

const CONDUCTOR_KEYS: readonly string[] = ['enabled', 'stopGraceMinutes', 'reaper'];

const CONDUCTOR_REAPER_KEYS: readonly string[] = [
  'enabled',
  'intervalMinutes',
  'graceMinutes',
  'staleStopMinutes',
  'repairs',
  'worktrees',
  'disk',
];

const CONDUCTOR_REAPER_WORKTREE_KEYS: readonly string[] = [
  'retentionHours',
  'maxRemovalsPerPass',
  'passBudgetSeconds',
];

const CONDUCTOR_REAPER_DISK_KEYS: readonly string[] = [
  'minFreePercent',
  'clearFreePercent',
];

/** Inclusive integer bounds for `policy.conductor.reaper.worktrees` (KWp; the plan fixes none). */
export const CONDUCTOR_REAPER_WORKTREE_BOUNDS: Readonly<
  Record<string, Readonly<{ min: number; max: number }>>
> = Object.freeze({
  retentionHours: Object.freeze({ min: 1, max: 8760 }),
  maxRemovalsPerPass: Object.freeze({ min: 1, max: 1000 }),
  passBudgetSeconds: Object.freeze({ min: 1, max: 3600 }),
});

/** Inclusive integer bounds for `policy.conductor.reaper.disk` (KWp; the plan fixes none). */
export const CONDUCTOR_REAPER_DISK_BOUNDS: Readonly<
  Record<string, Readonly<{ min: number; max: number }>>
> = Object.freeze({
  minFreePercent: Object.freeze({ min: 0, max: 100 }),
  clearFreePercent: Object.freeze({ min: 0, max: 100 }),
});

function readConductorRepairs(
  value: unknown,
): Readonly<Record<ConductorReaperRepairKind, boolean>> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const repairs: Record<ConductorReaperRepairKind, boolean> = {
    'dead-attempt': false,
    'leaked-slot': false,
    'stale-stop': false,
    'stale-attention': false,
    'merged-worktree': false,
    'orphan-session': false,
  };
  for (const key of Object.keys(value)) {
    const kind = key as ConductorReaperRepairKind;
    if (!CONDUCTOR_REAPER_REPAIR_KINDS.includes(kind)) {
      return undefined;
    }
    const flag = readOwnDataProperty(value, kind);
    if (typeof flag !== 'boolean') {
      return undefined;
    }
    repairs[kind] = flag;
  }
  return Object.freeze(repairs);
}

function readConductorWorktrees(
  value: unknown,
): ResolvedConductorReaperWorktreePolicy | undefined {
  if (!isPlainRecord(value) || hasUnknownKeys(value, CONDUCTOR_REAPER_WORKTREE_KEYS)) {
    return undefined;
  }
  const retentionHours = readBoundedInteger(
    readOwnDataProperty(value, 'retentionHours'),
    CONDUCTOR_REAPER_WORKTREE_BOUNDS.retentionHours,
  );
  if (Object.hasOwn(value, 'retentionHours') && retentionHours === undefined) {
    return undefined;
  }
  const maxRemovalsPerPass = readBoundedInteger(
    readOwnDataProperty(value, 'maxRemovalsPerPass'),
    CONDUCTOR_REAPER_WORKTREE_BOUNDS.maxRemovalsPerPass,
  );
  if (Object.hasOwn(value, 'maxRemovalsPerPass') && maxRemovalsPerPass === undefined) {
    return undefined;
  }
  const passBudgetSeconds = readBoundedInteger(
    readOwnDataProperty(value, 'passBudgetSeconds'),
    CONDUCTOR_REAPER_WORKTREE_BOUNDS.passBudgetSeconds,
  );
  if (Object.hasOwn(value, 'passBudgetSeconds') && passBudgetSeconds === undefined) {
    return undefined;
  }
  return Object.freeze({
    retentionHours: retentionHours ?? 24,
    maxRemovalsPerPass: maxRemovalsPerPass ?? 10,
    passBudgetSeconds: passBudgetSeconds ?? 120,
  });
}

function readConductorDisk(value: unknown): ResolvedConductorReaperDiskPolicy | undefined {
  if (!isPlainRecord(value) || hasUnknownKeys(value, CONDUCTOR_REAPER_DISK_KEYS)) {
    return undefined;
  }
  const minFreePercent = readBoundedInteger(
    readOwnDataProperty(value, 'minFreePercent'),
    CONDUCTOR_REAPER_DISK_BOUNDS.minFreePercent,
  );
  if (Object.hasOwn(value, 'minFreePercent') && minFreePercent === undefined) {
    return undefined;
  }
  const clearFreePercent = readBoundedInteger(
    readOwnDataProperty(value, 'clearFreePercent'),
    CONDUCTOR_REAPER_DISK_BOUNDS.clearFreePercent,
  );
  if (Object.hasOwn(value, 'clearFreePercent') && clearFreePercent === undefined) {
    return undefined;
  }
  if ((minFreePercent ?? 15) >= (clearFreePercent ?? 20)) {
    return undefined;
  }
  return Object.freeze({
    minFreePercent: minFreePercent ?? 15,
    clearFreePercent: clearFreePercent ?? 20,
  });
}

function freshDefaultConductorRepairs(): Readonly<Record<ConductorReaperRepairKind, boolean>> {
  return Object.freeze({
    'dead-attempt': false,
    'leaked-slot': false,
    'stale-stop': false,
    'stale-attention': false,
    'merged-worktree': false,
    'orphan-session': false,
  });
}

function freshDefaultConductorWorktrees(): ResolvedConductorReaperWorktreePolicy {
  return Object.freeze({
    retentionHours: 24,
    maxRemovalsPerPass: 10,
    passBudgetSeconds: 120,
  });
}

function freshDefaultConductorDisk(): ResolvedConductorReaperDiskPolicy {
  return Object.freeze({
    minFreePercent: 15,
    clearFreePercent: 20,
  });
}

function freshDefaultConductorReaper(): ResolvedConductorReaperPolicy {
  return Object.freeze({
    enabled: true,
    intervalMinutes: 10,
    graceMinutes: 5,
    staleStopMinutes: 30,
    repairs: freshDefaultConductorRepairs(),
    worktrees: freshDefaultConductorWorktrees(),
    disk: freshDefaultConductorDisk(),
  });
}

function freshDefaultConductorPolicy(): ResolvedConductorPolicy {
  return Object.freeze({
    enabled: false,
    stopGraceMinutes: 45,
    reaper: freshDefaultConductorReaper(),
  });
}

/**
 * The conductor for an installation without `policy.conductor`: off; the reaper reports on
 * its default schedule and repairs nothing (D12, D13, D14). Deeply frozen.
 */
export const DEFAULT_CONDUCTOR_POLICY: ResolvedConductorPolicy = freshDefaultConductorPolicy();

/**
 * The effective conductor policy: the block's own data properties with every absent optional
 * field defaulted, only when every present block is a plain record with only known keys, a
 * boolean `enabled`, and well-formed optional fields (booleans, integers within
 * CONDUCTOR_MINUTE_BOUNDS / CONDUCTOR_REAPER_WORKTREE_BOUNDS / CONDUCTOR_REAPER_DISK_BOUNDS,
 * only known repair kinds, and an ordered disk pair); absent or malformed anywhere is the
 * whole default (off, report-only). Always a fresh, deeply frozen object with the keys in
 * canonical order.
 */
export function resolveConductorPolicy(policy: PolicySection | undefined): ResolvedConductorPolicy {
  if (!isPlainRecord(policy) || !Object.hasOwn(policy, 'conductor')) {
    return freshDefaultConductorPolicy();
  }
  const block = readOwnDataProperty(policy, 'conductor');
  if (!isPlainRecord(block) || hasUnknownKeys(block, CONDUCTOR_KEYS)) {
    return freshDefaultConductorPolicy();
  }
  const enabled = readOwnDataProperty(block, 'enabled');
  if (typeof enabled !== 'boolean') {
    return freshDefaultConductorPolicy();
  }
  const stopGraceMinutes = readBoundedInteger(
    readOwnDataProperty(block, 'stopGraceMinutes'),
    CONDUCTOR_MINUTE_BOUNDS.stopGraceMinutes,
  );
  if (Object.hasOwn(block, 'stopGraceMinutes') && stopGraceMinutes === undefined) {
    return freshDefaultConductorPolicy();
  }
  let reaper: ResolvedConductorReaperPolicy | undefined;
  if (Object.hasOwn(block, 'reaper')) {
    const reaperValue = readOwnDataProperty(block, 'reaper');
    if (!isPlainRecord(reaperValue) || hasUnknownKeys(reaperValue, CONDUCTOR_REAPER_KEYS)) {
      return freshDefaultConductorPolicy();
    }
    const reaperEnabled = readOwnDataProperty(reaperValue, 'enabled');
    if (typeof reaperEnabled !== 'boolean') {
      return freshDefaultConductorPolicy();
    }
    const intervalMinutes = readBoundedInteger(
      readOwnDataProperty(reaperValue, 'intervalMinutes'),
      CONDUCTOR_MINUTE_BOUNDS.intervalMinutes,
    );
    if (Object.hasOwn(reaperValue, 'intervalMinutes') && intervalMinutes === undefined) {
      return freshDefaultConductorPolicy();
    }
    const graceMinutes = readBoundedInteger(
      readOwnDataProperty(reaperValue, 'graceMinutes'),
      CONDUCTOR_MINUTE_BOUNDS.graceMinutes,
    );
    if (Object.hasOwn(reaperValue, 'graceMinutes') && graceMinutes === undefined) {
      return freshDefaultConductorPolicy();
    }
    const staleStopMinutes = readBoundedInteger(
      readOwnDataProperty(reaperValue, 'staleStopMinutes'),
      CONDUCTOR_MINUTE_BOUNDS.staleStopMinutes,
    );
    if (Object.hasOwn(reaperValue, 'staleStopMinutes') && staleStopMinutes === undefined) {
      return freshDefaultConductorPolicy();
    }
    let repairs: Readonly<Record<ConductorReaperRepairKind, boolean>> | undefined;
    if (Object.hasOwn(reaperValue, 'repairs')) {
      repairs = readConductorRepairs(readOwnDataProperty(reaperValue, 'repairs'));
      if (repairs === undefined) {
        return freshDefaultConductorPolicy();
      }
    }
    let worktrees: ResolvedConductorReaperWorktreePolicy | undefined;
    if (Object.hasOwn(reaperValue, 'worktrees')) {
      worktrees = readConductorWorktrees(readOwnDataProperty(reaperValue, 'worktrees'));
      if (worktrees === undefined) {
        return freshDefaultConductorPolicy();
      }
    }
    let disk: ResolvedConductorReaperDiskPolicy | undefined;
    if (Object.hasOwn(reaperValue, 'disk')) {
      disk = readConductorDisk(readOwnDataProperty(reaperValue, 'disk'));
      if (disk === undefined) {
        return freshDefaultConductorPolicy();
      }
    }
    reaper = Object.freeze({
      enabled: reaperEnabled,
      intervalMinutes: intervalMinutes ?? 10,
      graceMinutes: graceMinutes ?? 5,
      staleStopMinutes: staleStopMinutes ?? 30,
      repairs: repairs ?? freshDefaultConductorRepairs(),
      worktrees: worktrees ?? freshDefaultConductorWorktrees(),
      disk: disk ?? freshDefaultConductorDisk(),
    });
  }
  return Object.freeze({
    enabled,
    stopGraceMinutes: stopGraceMinutes ?? 45,
    reaper: reaper ?? freshDefaultConductorReaper(),
  });
}

/** Inclusive integer bounds for `policy.board` (WB6p). The first three mirror
 * work-execution's `isValidPolicy` (work-board.ts:172-176); forgeSyncMinutes
 * mirrors the conductor's intervalMinutes (WB7c consumes it). */
export const BOARD_BOUNDS: Readonly<
  Record<string, Readonly<{ min: number; max: number }>>
> = Object.freeze({
  forgeStaleMinutes: Object.freeze({ min: 1, max: 1440 }),
  declarationTtlMinutes: Object.freeze({ min: 1, max: 10080 }),
  doneWindowDays: Object.freeze({ min: 1, max: 3650 }),
  forgeSyncMinutes: Object.freeze({ min: 1, max: 1440 }),
});

const BOARD_KEYS: readonly string[] = [
  'forgeStaleMinutes', 'declarationTtlMinutes', 'doneWindowDays', 'forgeSyncMinutes',
];

/** The board policy for an installation without `policy.board` (WB6p):
 * the plan's defaults (D3, D6, §3.4; forgeSyncMinutes per WB7c). Deeply frozen. */
export const DEFAULT_BOARD_POLICY: ResolvedBoardPolicy = Object.freeze({
  forgeStaleMinutes: 15,
  declarationTtlMinutes: 90,
  doneWindowDays: 14,
  forgeSyncMinutes: 10,
});

export interface ResolvedBoardPolicy {
  readonly forgeStaleMinutes: number;
  readonly declarationTtlMinutes: number;
  readonly doneWindowDays: number;
  readonly forgeSyncMinutes: number;
}

function freshDefaultBoardPolicy(): ResolvedBoardPolicy {
  return Object.freeze({ ...DEFAULT_BOARD_POLICY });
}

/**
 * The effective board policy: the block's own data properties with every
 * absent field defaulted, only when the block is a plain record with only
 * known keys and every present field is an integer within BOARD_BOUNDS;
 * absent or malformed anywhere is the whole default (fail closed). Always a
 * fresh, frozen object with the keys in canonical order.
 */
export function resolveBoardPolicy(policy: PolicySection | undefined): ResolvedBoardPolicy {
  if (!isPlainRecord(policy) || !Object.hasOwn(policy, 'board')) {
    return freshDefaultBoardPolicy();
  }
  const block = readOwnDataProperty(policy, 'board');
  if (!isPlainRecord(block) || hasUnknownKeys(block, BOARD_KEYS)) {
    return freshDefaultBoardPolicy();
  }
  const values: Record<string, number> = {};
  for (const key of BOARD_KEYS) {
    const value = readBoundedInteger(readOwnDataProperty(block, key), BOARD_BOUNDS[key]);
    if (Object.hasOwn(block, key) && value === undefined) {
      return freshDefaultBoardPolicy();
    }
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return Object.freeze({
    forgeStaleMinutes: values.forgeStaleMinutes ?? DEFAULT_BOARD_POLICY.forgeStaleMinutes,
    declarationTtlMinutes: values.declarationTtlMinutes ?? DEFAULT_BOARD_POLICY.declarationTtlMinutes,
    doneWindowDays: values.doneWindowDays ?? DEFAULT_BOARD_POLICY.doneWindowDays,
    forgeSyncMinutes: values.forgeSyncMinutes ?? DEFAULT_BOARD_POLICY.forgeSyncMinutes,
  });
}

/** Inclusive bounds for `policy.merge.repos` and `policy.daemon` (daemon tick plan D-DT9; lane DTP). */
export const MERGE_POLICY_BOUNDS = Object.freeze({
  repositories: Object.freeze({ min: 0, max: 256 }),
  keyPartLength: Object.freeze({ min: 1, max: 100 }),
  projectIdLength: Object.freeze({ min: 1, max: 128 }),
  requiredContexts: Object.freeze({ min: 1, max: 16 }),
  requiredContextLength: Object.freeze({ min: 1, max: 64 }),
  macosProcedureLength: Object.freeze({ min: 1, max: 200 }),
  maxAttempts: Object.freeze({ min: 1, max: 32 }),
  checksGraceMinutes: Object.freeze({ min: 1, max: 1440 }),
  holdConfidence: Object.freeze({ min: 0, max: 1 }),
  intervalSeconds: Object.freeze({ min: 10, max: 3600 }),
  budgetSeconds: Object.freeze({ min: 5, max: 600 }),
  settleSeconds: Object.freeze({ min: 0, max: 600 }),
});

/** The defaults of an absent `policy.daemon` (D-DT9). */
export const DEFAULT_MERGE_DAEMON_POLICY: ResolvedMergeDaemonPolicy = Object.freeze({
  intervalSeconds: 60,
  budgetSeconds: 45,
  settleSeconds: 20,
});

/**
 * The per-repository defaults. `shadow` is `true` (the manifest contract wins over the daemon tick
 * plan's "absent shadow = false"); `checksGraceMinutes` 30 and the `maxAttempts` bound 32 are lane
 * decisions, the plan fixing only the default 9.
 */
export const DEFAULT_MERGE_REPOSITORY_SETTINGS = Object.freeze({
  shadow: true,
  unattended: false,
  requiredContexts: Object.freeze(['gate', 'premerge']) as readonly string[],
  updateBranch: false,
  macosProcedure: null,
  maxAttempts: 9,
  checksGraceMinutes: 30,
  veto: Object.freeze({ mode: 'off' as MergeVetoMode, holdConfidence: 0.8 as number }),
});

const MERGE_REPOSITORY_KEYS: readonly string[] = [
  'projectId',
  'shadow',
  'unattended',
  'requiredContexts',
  'updateBranch',
  'macosProcedure',
  'maxAttempts',
  'checksGraceMinutes',
  'veto',
];
const MERGE_KEYS: readonly string[] = ['repos'];
const MERGE_VETO_KEYS: readonly string[] = ['mode', 'holdConfidence'];
const MERGE_VETO_MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'live']);
const MERGE_DAEMON_KEYS: readonly string[] = ['intervalSeconds', 'budgetSeconds', 'settleSeconds'];
const MERGE_REPOSITORY_KEY_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;

/** The owner and repo of a `policy.merge.repos` key, or undefined when the key is not `<owner>/<repo>`. */
export function parseMergeRepositoryKey(
  key: string,
): { readonly owner: string; readonly repo: string } | undefined {
  const match = MERGE_REPOSITORY_KEY_PATTERN.exec(key);
  if (match === null) {
    return undefined;
  }
  const [, owner, repo] = match;
  const bounds = MERGE_POLICY_BOUNDS.keyPartLength;
  for (const part of [owner, repo]) {
    if (part.length < bounds.min || part.length > bounds.max || part === '.' || part === '..') {
      return undefined;
    }
  }
  return { owner, repo };
}

type MergeReadFailure = { readonly ok: false; readonly reason: string };
type MergeReadResult<T> = { readonly ok: true; readonly value: T } | MergeReadFailure;

const MERGE_INVALID: MergeReadFailure = Object.freeze({ ok: false, reason: 'policy-merge-invalid' });
const MERGE_SECRET: MergeReadFailure = Object.freeze({ ok: false, reason: 'policy-secret-shape' });
const MERGE_TOO_LARGE: MergeReadFailure = Object.freeze({ ok: false, reason: 'policy-too-large' });
const DAEMON_INVALID: MergeReadFailure = Object.freeze({ ok: false, reason: 'policy-daemon-invalid' });

function mergeOk<T>(value: T): MergeReadResult<T> {
  return { ok: true, value };
}

/** A string within the length bounds that is not blank; a secret-shaped string is its own refusal. */
function readMergeString(
  value: unknown,
  bounds: Readonly<{ min: number; max: number }>,
): MergeReadResult<string> {
  if (typeof value !== 'string') {
    return MERGE_INVALID;
  }
  if (containsSecretShape(value)) {
    return MERGE_SECRET;
  }
  if (value.length < bounds.min || value.length > bounds.max || value.trim() === '') {
    return MERGE_INVALID;
  }
  return mergeOk(value);
}

function readMergeRequiredContexts(value: unknown): MergeReadResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return MERGE_INVALID;
  }
  const bounds = MERGE_POLICY_BOUNDS.requiredContexts;
  if (value.length < bounds.min || value.length > bounds.max) {
    return MERGE_INVALID;
  }
  const contexts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const read = readMergeString(
      readOwnDataProperty(value as unknown as Record<string, unknown>, String(index)),
      MERGE_POLICY_BOUNDS.requiredContextLength,
    );
    if (!read.ok) {
      return read;
    }
    if (contexts.includes(read.value)) {
      return MERGE_INVALID;
    }
    contexts.push(read.value);
  }
  return mergeOk(Object.freeze(contexts));
}

function readMergeVeto(
  value: unknown,
): MergeReadResult<{ readonly mode: MergeVetoMode; readonly holdConfidence: number }> {
  if (!isPlainRecord(value) || hasUnknownKeys(value, MERGE_VETO_KEYS)) {
    return MERGE_INVALID;
  }
  let mode: MergeVetoMode = DEFAULT_MERGE_REPOSITORY_SETTINGS.veto.mode;
  if (Object.hasOwn(value, 'mode')) {
    const written = readOwnDataProperty(value, 'mode');
    if (typeof written !== 'string' || !MERGE_VETO_MODES.has(written)) {
      return MERGE_INVALID;
    }
    mode = written as MergeVetoMode;
  }
  let holdConfidence = DEFAULT_MERGE_REPOSITORY_SETTINGS.veto.holdConfidence;
  if (Object.hasOwn(value, 'holdConfidence')) {
    const written = readOwnDataProperty(value, 'holdConfidence');
    const bounds = MERGE_POLICY_BOUNDS.holdConfidence;
    if (
      typeof written !== 'number' ||
      !Number.isFinite(written) ||
      written < bounds.min ||
      written > bounds.max
    ) {
      return MERGE_INVALID;
    }
    holdConfidence = written;
  }
  return mergeOk(Object.freeze({ mode, holdConfidence }));
}

function readMergeBoolean(
  entry: Record<string, unknown>,
  key: string,
  fallback: boolean,
): MergeReadResult<boolean> {
  if (!Object.hasOwn(entry, key)) {
    return mergeOk(fallback);
  }
  const written = readOwnDataProperty(entry, key);
  return typeof written === 'boolean' ? mergeOk(written) : MERGE_INVALID;
}

function readMergeInteger(
  entry: Record<string, unknown>,
  key: string,
  bounds: Readonly<{ min: number; max: number }>,
  fallback: number,
): MergeReadResult<number> {
  if (!Object.hasOwn(entry, key)) {
    return mergeOk(fallback);
  }
  const written = readBoundedInteger(readOwnDataProperty(entry, key), bounds);
  return written === undefined ? MERGE_INVALID : mergeOk(written);
}

function readMergeContextsField(
  entry: Record<string, unknown>,
  fallback: readonly string[],
): MergeReadResult<readonly string[]> {
  if (!Object.hasOwn(entry, 'requiredContexts')) {
    return mergeOk(Object.freeze([...fallback]));
  }
  return readMergeRequiredContexts(readOwnDataProperty(entry, 'requiredContexts'));
}

function readMergeMacosField(
  entry: Record<string, unknown>,
  fallback: string | null,
): MergeReadResult<string | null> {
  if (!Object.hasOwn(entry, 'macosProcedure')) {
    return mergeOk(fallback);
  }
  return readMergeString(
    readOwnDataProperty(entry, 'macosProcedure'),
    MERGE_POLICY_BOUNDS.macosProcedureLength,
  );
}

function readMergeVetoField(
  entry: Record<string, unknown>,
  fallback: { readonly mode: MergeVetoMode; readonly holdConfidence: number },
): MergeReadResult<{ readonly mode: MergeVetoMode; readonly holdConfidence: number }> {
  if (!Object.hasOwn(entry, 'veto')) {
    return mergeOk(Object.freeze({ ...fallback }));
  }
  return readMergeVeto(readOwnDataProperty(entry, 'veto'));
}

function readMergeRepository(
  repositoryKey: string,
  entry: unknown,
): MergeReadResult<ResolvedMergeRepositoryPolicy> {
  if (containsSecretShape(repositoryKey)) {
    return MERGE_SECRET;
  }
  const parts = parseMergeRepositoryKey(repositoryKey);
  if (parts === undefined || !isPlainRecord(entry) || hasUnknownKeys(entry, MERGE_REPOSITORY_KEYS)) {
    return MERGE_INVALID;
  }
  const defaults = DEFAULT_MERGE_REPOSITORY_SETTINGS;
  const projectId = readMergeString(
    readOwnDataProperty(entry, 'projectId'),
    MERGE_POLICY_BOUNDS.projectIdLength,
  );
  if (!projectId.ok) {
    return projectId;
  }
  const shadow = readMergeBoolean(entry, 'shadow', defaults.shadow);
  if (!shadow.ok) {
    return shadow;
  }
  const unattended = readMergeBoolean(entry, 'unattended', defaults.unattended);
  if (!unattended.ok) {
    return unattended;
  }
  const updateBranch = readMergeBoolean(entry, 'updateBranch', defaults.updateBranch);
  if (!updateBranch.ok) {
    return updateBranch;
  }
  const requiredContexts = readMergeContextsField(entry, defaults.requiredContexts);
  if (!requiredContexts.ok) {
    return requiredContexts;
  }
  const macosProcedure = readMergeMacosField(entry, defaults.macosProcedure);
  if (!macosProcedure.ok) {
    return macosProcedure;
  }
  const maxAttempts = readMergeInteger(
    entry,
    'maxAttempts',
    MERGE_POLICY_BOUNDS.maxAttempts,
    defaults.maxAttempts,
  );
  if (!maxAttempts.ok) {
    return maxAttempts;
  }
  const checksGraceMinutes = readMergeInteger(
    entry,
    'checksGraceMinutes',
    MERGE_POLICY_BOUNDS.checksGraceMinutes,
    defaults.checksGraceMinutes,
  );
  if (!checksGraceMinutes.ok) {
    return checksGraceMinutes;
  }
  const veto = readMergeVetoField(entry, defaults.veto);
  if (!veto.ok) {
    return veto;
  }
  return mergeOk(
    Object.freeze({
      owner: parts.owner,
      repo: parts.repo,
      repositoryKey,
      projectId: projectId.value,
      shadow: shadow.value,
      unattended: unattended.value,
      requiredContexts: requiredContexts.value,
      updateBranch: updateBranch.value,
      macosProcedure: macosProcedure.value,
      maxAttempts: maxAttempts.value,
      checksGraceMinutes: checksGraceMinutes.value,
      veto: veto.value,
    }),
  );
}

function readMergeRepositories(
  value: unknown,
): MergeReadResult<readonly ResolvedMergeRepositoryPolicy[]> {
  if (!isPlainRecord(value)) {
    return MERGE_INVALID;
  }
  const keys = Object.keys(value);
  if (keys.length > MERGE_POLICY_BOUNDS.repositories.max) {
    return MERGE_TOO_LARGE;
  }
  const repositories: ResolvedMergeRepositoryPolicy[] = [];
  for (const key of keys) {
    const read = readMergeRepository(key, readOwnDataProperty(value, key));
    if (!read.ok) {
      return read;
    }
    repositories.push(read.value);
  }
  repositories.sort(compareRepositoryKeys);
  return mergeOk(Object.freeze(repositories));
}

function readMergeSection(
  policy: Record<string, unknown>,
): MergeReadResult<readonly ResolvedMergeRepositoryPolicy[]> {
  if (!Object.hasOwn(policy, 'merge')) {
    return mergeOk(Object.freeze([]));
  }
  const block = readOwnDataProperty(policy, 'merge');
  if (!isPlainRecord(block) || hasUnknownKeys(block, MERGE_KEYS)) {
    return MERGE_INVALID;
  }
  if (!Object.hasOwn(block, 'repos')) {
    return mergeOk(Object.freeze([]));
  }
  return readMergeRepositories(readOwnDataProperty(block, 'repos'));
}

function readDaemonSection(
  policy: Record<string, unknown>,
): MergeReadResult<ResolvedMergeDaemonPolicy> {
  if (!Object.hasOwn(policy, 'daemon')) {
    return mergeOk(Object.freeze({ ...DEFAULT_MERGE_DAEMON_POLICY }));
  }
  const block = readOwnDataProperty(policy, 'daemon');
  if (!isPlainRecord(block) || hasUnknownKeys(block, MERGE_DAEMON_KEYS)) {
    return DAEMON_INVALID;
  }
  const defaults = DEFAULT_MERGE_DAEMON_POLICY;
  const intervalSeconds = readMergeInteger(
    block,
    'intervalSeconds',
    MERGE_POLICY_BOUNDS.intervalSeconds,
    defaults.intervalSeconds,
  );
  const budgetSeconds = readMergeInteger(
    block,
    'budgetSeconds',
    MERGE_POLICY_BOUNDS.budgetSeconds,
    defaults.budgetSeconds,
  );
  const settleSeconds = readMergeInteger(
    block,
    'settleSeconds',
    MERGE_POLICY_BOUNDS.settleSeconds,
    defaults.settleSeconds,
  );
  if (!intervalSeconds.ok || !budgetSeconds.ok || !settleSeconds.ok) {
    return DAEMON_INVALID;
  }
  if (budgetSeconds.value >= intervalSeconds.value) {
    return DAEMON_INVALID;
  }
  return mergeOk(
    Object.freeze({
      intervalSeconds: intervalSeconds.value,
      budgetSeconds: budgetSeconds.value,
      settleSeconds: settleSeconds.value,
    }),
  );
}

/** Bytewise (UTF-16 code unit) order: the digest input must not depend on the locale. */
function compareBytewise(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function compareRepositoryKeys(
  left: Pick<ResolvedMergeRepositoryPolicy, 'repositoryKey'>,
  right: Pick<ResolvedMergeRepositoryPolicy, 'repositoryKey'>,
): number {
  if (left.repositoryKey < right.repositoryKey) {
    return -1;
  }
  return left.repositoryKey > right.repositoryKey ? 1 : 0;
}

/**
 * The effective merge policy: `policy.merge.repos` and `policy.daemon` normalized with every
 * default applied, at their `policyRevision`. An absent `policy.merge` is a valid empty
 * configuration and an absent `policy.daemon` is the D-DT9 defaults; anything malformed anywhere
 * in either section (wrong type, unknown key or enum, out-of-range number, bad repository key,
 * missing `projectId`, empty or sparse `requiredContexts`, secret-shaped text, more than 256
 * repositories) refuses the whole section. Never salvages a field, never substitutes a default for
 * a written value, never throws and never runs a getter. `reason` is a code, never a value.
 * Repositories come back sorted by `repositoryKey`; `requiredContexts` keep their written order.
 */
export function resolveMergePolicy(policy: PolicySection | undefined): MergePolicyRead {
  try {
    if (!isPlainRecord(policy)) {
      return Object.freeze({ outcome: 'invalid', reason: 'policy-unreadable' });
    }
    const merge = readMergeSection(policy);
    if (!merge.ok) {
      return Object.freeze({ outcome: 'invalid', reason: merge.reason });
    }
    const daemon = readDaemonSection(policy);
    if (!daemon.ok) {
      return Object.freeze({ outcome: 'invalid', reason: daemon.reason });
    }
    return Object.freeze({
      outcome: 'resolved',
      policyRevision: mergePolicyRevision({ repositories: merge.value, daemon: daemon.value }),
      repositories: merge.value,
      daemon: daemon.value,
    });
  } catch {
    return Object.freeze({ outcome: 'invalid', reason: 'policy-unreadable' });
  }
}

/**
 * The canonical JSON the merge-policy revision hashes: `daemon` (`budgetSeconds`,
 * `intervalSeconds`, `settleSeconds`) then `merge.repos` keyed by `repositoryKey` in ascending
 * order, each entry with its keys in alphabetical order and `requiredContexts` sorted ascending,
 * no whitespace. Pass the resolved sections so an absent block hashes as its default.
 */
export function canonicalMergePolicyJson(input: {
  readonly repositories: readonly ResolvedMergeRepositoryPolicy[];
  readonly daemon: ResolvedMergeDaemonPolicy;
}): string {
  const repos: Record<string, unknown> = {};
  for (const repository of [...input.repositories].sort(compareRepositoryKeys)) {
    repos[repository.repositoryKey] = {
      checksGraceMinutes: repository.checksGraceMinutes,
      macosProcedure: repository.macosProcedure,
      maxAttempts: repository.maxAttempts,
      projectId: repository.projectId,
      requiredContexts: [...repository.requiredContexts].sort(compareBytewise),
      shadow: repository.shadow,
      unattended: repository.unattended,
      updateBranch: repository.updateBranch,
      veto: {
        holdConfidence: repository.veto.holdConfidence,
        mode: repository.veto.mode,
      },
    };
  }
  return JSON.stringify({
    daemon: {
      budgetSeconds: input.daemon.budgetSeconds,
      intervalSeconds: input.daemon.intervalSeconds,
      settleSeconds: input.daemon.settleSeconds,
    },
    merge: { repos },
  });
}

/**
 * First 12 hex characters of sha256 over `canonicalMergePolicyJson(input)`. Hashing is pure
 * computation and performs no I/O. The digest covers both normalized sections, so a change to any
 * field, to the repository set or to a daemon setting changes the revision.
 */
export function mergePolicyRevision(input: {
  readonly repositories: readonly ResolvedMergeRepositoryPolicy[];
  readonly daemon: ResolvedMergeDaemonPolicy;
}): string {
  return createHash('sha256').update(canonicalMergePolicyJson(input)).digest('hex').slice(0, 12);
}
