/**
 * The free-tier engine of the shared onboarding flow (free-seat plan FS4),
 * pure half: validate a v2 installation value exactly as the loader does,
 * summarise its free seats and role chains, draft the candidate `policy`
 * change for the flag (F8's canonical form), and render the status and impact
 * lines the CLI shows. Nothing here touches a filesystem, a subprocess, the
 * network or the clock; the compare-and-swap write lives in
 * `hosts/write-node.ts` and the probing lives in `doctor/probes-node.ts`,
 * following the doctor's `probes.ts` / `probes-node.ts` convention.
 */

import {
  deriveInstallationModel,
  isFleetInstallationV2,
  parseInstallation,
  validateSeatPolicy,
} from '@fleet/installation';

import type {
  FleetInstallation,
  HostSection,
  SeatRole,
} from '@fleet/installation';

import type { HostDraftCandidate } from '../hosts/draft.js';

/** The two directions the flag can be flipped. */
export type FreeTierAction = 'on' | 'off';

/** The three written states of `policy.useFreeSeats`. */
export type FreeTierSetting = 'absent' | 'true' | 'false';

/** One role's seat counts: file chain steps vs derived (in-use) chain length. */
export interface FreeTierRoleCount {
  readonly role: SeatRole;
  readonly inFile: number;
  readonly inUse: number;
}

/** The free-tier view of an installation: flag, free seats and role counts. */
export interface FreeTierSummary {
  readonly setting: FreeTierSetting;
  readonly enabled: boolean; // setting !== 'false'
  readonly freeSeatIds: readonly string[]; // seats with costClass 'free', in file order
  readonly roles: readonly FreeTierRoleCount[];
}

/** The loader's v2 rules on a raw value, in the loader's order. */
export type ValidateV2Result =
  | { readonly ok: true; readonly installation: FleetInstallation }
  | {
      readonly ok: false;
      readonly installation?: FleetInstallation;
      readonly errors: readonly string[];
    };

/** The outcome of drafting a flag change. */
export type FreeTierDraft =
  | { readonly status: 'invalid'; readonly errors: readonly string[] }
  | { readonly status: 'unchanged'; readonly summary: FreeTierSummary }
  | {
      readonly status: 'draft';
      readonly candidate: HostDraftCandidate;
      readonly before: FreeTierSummary;
      readonly after?: FreeTierSummary;
      readonly errors: readonly string[];
    };

/**
 * The loader's v2 rules on a value, in the loader's order
 * (`packages/installation/src/load.ts`): parse, refuse a non-v2 value, then
 * derive the model and run the seat policy on the derived chains with the
 * file chains handed along so reference errors name file positions.
 */
export function validateV2InstallationValue(value: unknown): ValidateV2Result {
  const parsed = parseInstallation(value);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  if (!isFleetInstallationV2(parsed.installation)) {
    return {
      ok: false,
      errors: ['installation: the candidate is not a schema version 2 file'],
    };
  }
  const installation = parsed.installation;
  const { model, errors: modelErrors } = deriveInstallationModel(installation);
  const errors = [
    ...(modelErrors ?? []),
    ...validateSeatPolicy(model, installation.chains),
  ];
  if (errors.length === 0) {
    return { ok: true, installation };
  }
  return { ok: false, installation, errors };
}

const FREE_TIER_ROLES: readonly SeatRole[] = [
  'implementer',
  'reviewer',
  'high-risk-reviewer',
];

/** Summarise the free-tier view of a parsed installation. */
export function summariseFreeTier(
  installation: FleetInstallation,
): FreeTierSummary {
  const flag = installation.policy?.useFreeSeats;
  const setting: FreeTierSetting =
    flag === undefined ? 'absent' : flag ? 'true' : 'false';

  const freeSeatIds: string[] = [];
  for (const seat of installation.seats ?? []) {
    if (seat.costClass === 'free') {
      freeSeatIds.push(seat.id);
    }
  }

  const derived = deriveInstallationModel(installation);
  const roles: FreeTierRoleCount[] = [];
  for (const role of FREE_TIER_ROLES) {
    const fileChain = installation.chains?.[role];
    if (fileChain === undefined || fileChain.length === 0) continue;
    roles.push({
      role,
      inFile: fileChain.length,
      inUse: derived.model.chains?.[role]?.length ?? 0,
    });
  }

  return { setting, enabled: setting !== 'false', freeSeatIds, roles };
}

/**
 * Draft the candidate file value for a flag change, from the raw value
 * (never from the parsed one). `off` writes `useFreeSeats: false` (creating
 * `policy` if needed); `on` removes the key when it holds `false` and the
 * `policy` object too when nothing else is left in it. The candidate is judged
 * exactly as the loader would, so a draft that leaves a role empty still
 * reports the loader's error.
 */
export function draftFreeTier(
  current: unknown,
  action: FreeTierAction,
): FreeTierDraft {
  const parsed = parseInstallation(current);
  if (!parsed.ok) {
    return { status: 'invalid', errors: parsed.errors };
  }
  if (!isFleetInstallationV2(parsed.installation)) {
    return {
      status: 'invalid',
      errors: ['installation: the candidate is not a schema version 2 file'],
    };
  }

  const before = summariseFreeTier(parsed.installation);
  if (
    (action === 'off' && before.setting === 'false') ||
    (action === 'on' && before.setting !== 'false')
  ) {
    return { status: 'unchanged', summary: before };
  }

  const next: Record<string, unknown> = {
    ...(current as Record<string, unknown>),
  };
  const rawPolicy = next.policy;
  const policyCopy: Record<string, unknown> =
    typeof rawPolicy === 'object' &&
    rawPolicy !== null &&
    !Array.isArray(rawPolicy)
      ? { ...(rawPolicy as Record<string, unknown>) }
      : {};
  if (action === 'off') {
    policyCopy.useFreeSeats = false;
    next.policy = policyCopy;
  } else {
    delete policyCopy.useFreeSeats;
    if (Object.keys(policyCopy).length === 0) {
      delete next.policy;
    } else {
      next.policy = policyCopy;
    }
  }

  const candidate: HostDraftCandidate = {
    ...next,
    schemaVersion: 2,
    hosts: (next.hosts ?? {}) as Readonly<Record<string, HostSection>>,
  };

  const checked = validateV2InstallationValue(candidate);
  const after =
    checked.installation !== undefined
      ? summariseFreeTier(checked.installation)
      : undefined;
  return {
    status: 'draft',
    candidate,
    before,
    after,
    errors: checked.ok ? [] : checked.errors,
  };
}

/** Render the free-tier status lines for a summary. */
export function renderFreeTierStatus(summary: FreeTierSummary): string[] {
  const lines: string[] = [];
  if (summary.setting === 'false') {
    lines.push('free-tier: off (policy.useFreeSeats false)');
  } else if (summary.setting === 'true') {
    lines.push('free-tier: on (policy.useFreeSeats true)');
  } else {
    lines.push('free-tier: on (policy.useFreeSeats absent; absent means on)');
  }
  if (summary.freeSeatIds.length === 0) {
    lines.push('free seats: none declared');
  } else if (summary.enabled) {
    lines.push(`free seats (in use): ${summary.freeSeatIds.join(', ')}`);
  } else {
    lines.push(`free seats (disabled): ${summary.freeSeatIds.join(', ')}`);
  }
  for (const role of summary.roles) {
    lines.push(
      `chains.${role.role}: ${role.inUse} of ${role.inFile} seats in use`,
    );
  }
  return lines;
}

/** Render the impact lines of a flag change: before -> after. */
export function renderFreeTierImpact(
  before: FreeTierSummary,
  after: FreeTierSummary,
): string[] {
  const lines: string[] = [];
  lines.push(
    `free-tier: ${before.enabled ? 'on' : 'off'} -> ${
      after.enabled ? 'on' : 'off'
    }`,
  );
  const seatsTail =
    after.freeSeatIds.length === 0
      ? 'none (no seat is declared free)'
      : after.freeSeatIds.join(', ');
  lines.push(
    after.enabled ? `seats enabled: ${seatsTail}` : `seats disabled: ${seatsTail}`,
  );
  for (const role of before.roles) {
    const afterRole = after.roles.find((entry) => entry.role === role.role);
    lines.push(
      `chains.${role.role}: ${role.inUse} -> ${afterRole?.inUse ?? 0} seats in use`,
    );
  }
  return lines;
}
