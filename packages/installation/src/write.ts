/**
 * Pure serializer for the v2 file form (plan section 1), for a later
 * `init --migrate`. The output has a stable section and key order regardless
 * of how the input object was built, and a runner capability `source` is
 * never written: it is not a file field (D4).
 */

import { copyDecisions } from './decision-consumers.js';
import {
  AGY_ACKNOWLEDGEMENT_KEYS,
  AGY_HOST_RUNNER_KEYS,
  AUTO_MERGE_KEYS,
  BOARD_KEYS,
  CAPABILITY_KEYS,
  CHAIN_KEYS,
  CHAIN_STEP_KEYS,
  CONDUCTOR_KEYS,
  CONDUCTOR_REAPER_DISK_KEYS,
  CONDUCTOR_REAPER_KEYS,
  CONDUCTOR_REAPER_REPAIR_KINDS,
  CONDUCTOR_REAPER_WORKTREE_KEYS,
  DAEMON_KEYS,
  FORBIDDEN_ROUTE_KEYS,
  GATE_SLOT_KEYS,
  GITHUB_FORGE_KEYS,
  GIT_SHELF_KEYS,
  HOST_KEYS,
  HOST_ROLES,
  HOST_RUNNER_KEYS,
  LIVE_TAIL_KEYS,
  LOCAL_SHELF_KEYS,
  MERGE_KEYS,
  MERGE_REPO_KEYS,
  MERGE_VETO_KEYS,
  NO_FORGE_KEYS,
  POLICY_DAEMON_KEYS,
  POLICY_KEYS,
  PROCEDURE_COVERAGE_KEYS,
  PROCEDURE_KEYS,
  SEATS_POLICY_KEYS,
  TELEMETRY_POLICY_KEYS,
  V2_ROOT_KEYS,
  V2_SEAT_KEYS,
  V2_VERIFICATION_KEYS,
  WAVES_KEYS,
} from './keys.js';
import { isPlainRecord, readOwnDataProperty } from './policy-read.js';
import type {
  AgyAcknowledgement,
  AutoMergePolicy,
  BoardPolicySection,
  ChainsSection,
  ConductorPolicy,
  ConductorReaperDiskPolicy,
  ConductorReaperPolicy,
  ConductorReaperWorktreePolicy,
  DaemonSection,
  DecisionsSectionV2,
  FleetInstallation,
  FleetInstallationV2,
  ForbiddenRouteRule,
  ForgeSectionV2,
  GateSlotSection,
  HostRunnerSection,
  HostSection,
  LiveTailPolicy,
  MergeDaemonSection,
  MergePolicySection,
  MergeRepositoryPolicy,
  MergeVetoPolicy,
  PolicySection,
  ProcedureCoverage,
  RunnerCapabilityDeclaration,
  SeatSection,
  SeatsPolicy,
  ShelfSectionV2,
  TelemetryPolicy,
  VerificationProcedure,
  VerificationProceduresSection,
  WavesSection,
} from './types.js';

/**
 * Narrow a parsed installation to the v2 file shape. `parseInstallation` has
 * already validated the section split; this guard only reads the version.
 */
export function isFleetInstallationV2(
  installation: FleetInstallation,
): installation is FleetInstallationV2 {
  return isPlainRecord(installation) && readOwnDataProperty(installation, 'schemaVersion') === 2;
}

/** Serialize a v2 installation as pretty JSON with a stable key order. */
export function writeInstallationV2(installation: FleetInstallationV2): string {
  const document = serializeByKeys(installation, V2_ROOT_KEYS, {
    schemaVersion: () => 2,
    hosts: (hosts) => serializeHosts(hosts as Readonly<Record<string, HostSection>>),
    tools: (tools) => [...(tools as readonly string[])],
    seats: (seats) => (seats as readonly SeatSection[]).map(serializeSeat),
    chains: (chains) => serializeChains(chains as ChainsSection),
    policy: (policy) => serializePolicy(policy as PolicySection),
    shelf: (shelf) => serializeShelf(shelf as ShelfSectionV2),
    forge: (forge) => serializeForge(forge as ForgeSectionV2),
    verification: (verification) =>
      serializeVerification(verification as VerificationProceduresSection),
    waves: (waves) => serializeByKeys(waves as WavesSection, WAVES_KEYS),
    decisions: (decisions) => serializeDecisions(decisions as DecisionsSectionV2),
    daemon: (daemon) => serializeByKeys(daemon as DaemonSection, DAEMON_KEYS),
  });
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** UTF-16 code-unit order: identical to the default sort(), stated explicitly (Sonar S2871). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Write the present keys of one block in the given canonical order. Reads only
 * own data properties, so a getter never runs; an accessor property is skipped
 * like an absent field. Arrays are shallow-copied, plain records re-created
 * from their own data properties, and nested blocks go through `overrides`.
 */
function serializeByKeys(
  block: object,
  keys: readonly string[],
  overrides?: Readonly<Record<string, (value: unknown) => unknown>>,
): Record<string, unknown> {
  const record = block as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readOwnDataProperty(record, key);
    if (value === undefined) {
      continue;
    }
    const override = overrides?.[key];
    if (override !== undefined) {
      out[key] = override(value);
    } else if (Array.isArray(value)) {
      out[key] = [...value];
    } else if (typeof value === 'object' && value !== null) {
      out[key] = Object.fromEntries(
        Object.keys(value as Record<string, unknown>).map((entryKey) => [
          entryKey,
          readOwnDataProperty(value as Record<string, unknown>, entryKey),
        ]),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function serializeHosts(
  hosts: Readonly<Record<string, HostSection>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of [...Object.keys(hosts)].sort(compareCodeUnits)) {
    const host = readOwnDataProperty(hosts, name);
    if (host !== undefined) {
      out[name] = serializeHost(host as HostSection);
    }
  }
  return out;
}

function serializeHost(host: HostSection): Record<string, unknown> {
  return serializeByKeys(host, HOST_KEYS, {
    roleAliases: (roleAliases) => serializeByKeys(roleAliases as object, HOST_ROLES),
    runner: (runner) => serializeHostRunner(runner as HostRunnerSection),
  });
}

function serializeHostRunner(runner: HostRunnerSection): Record<string, unknown> {
  // The discriminator goes through the own-data-property reader too: a getter
  // never runs, and an accessor or absent kind falls to the default (opencode)
  // branch like any other field rather than throwing.
  const kind = readOwnDataProperty(runner as unknown as Readonly<Record<string, unknown>>, 'kind');
  const keys = kind === 'agy' ? AGY_HOST_RUNNER_KEYS : HOST_RUNNER_KEYS;
  return serializeByKeys(runner, keys, {
    capabilities: (capabilities) =>
      serializeByKeys(capabilities as RunnerCapabilityDeclaration, CAPABILITY_KEYS),
    gateSlot: (gateSlot) => serializeByKeys(gateSlot as GateSlotSection, GATE_SLOT_KEYS),
    agyAcknowledgement: (acknowledgement) =>
      serializeByKeys(acknowledgement as AgyAcknowledgement, AGY_ACKNOWLEDGEMENT_KEYS),
  });
}

function serializeSeat(seat: SeatSection): Record<string, unknown> {
  return serializeByKeys(seat, V2_SEAT_KEYS);
}

function serializeChains(chains: ChainsSection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const role of CHAIN_KEYS) {
    const steps = chains[role];
    if (steps === undefined) {
      continue;
    }
    out[role] = steps.map((step) => serializeByKeys(step, CHAIN_STEP_KEYS));
  }
  return out;
}

function serializePolicy(policy: PolicySection): Record<string, unknown> {
  return serializeByKeys(policy, POLICY_KEYS, {
    forbiddenRoutes: (routes) =>
      (routes as readonly ForbiddenRouteRule[]).map((route) =>
        serializeByKeys(route, FORBIDDEN_ROUTE_KEYS),
      ),
    liveTail: (liveTail) => serializeByKeys(liveTail as LiveTailPolicy, LIVE_TAIL_KEYS),
    autoMerge: (autoMerge) => serializeByKeys(autoMerge as AutoMergePolicy, AUTO_MERGE_KEYS),
    conductor: (conductor) => serializeConductorPolicy(conductor as ConductorPolicy),
    board: (board) => serializeByKeys(board as BoardPolicySection, BOARD_KEYS),
    telemetry: (telemetry) =>
      serializeByKeys(telemetry as TelemetryPolicy, TELEMETRY_POLICY_KEYS),
    seats: (seats) => serializeByKeys(seats as SeatsPolicy, SEATS_POLICY_KEYS),
    merge: (merge) => serializeMergePolicy(merge as MergePolicySection),
    daemon: (daemon) => serializeByKeys(daemon as MergeDaemonSection, POLICY_DAEMON_KEYS),
  });
}

function serializeMergePolicy(merge: MergePolicySection): Record<string, unknown> {
  return serializeByKeys(merge, MERGE_KEYS, {
    repos: (repos) => serializeMergeRepos(repos as Readonly<Record<string, MergeRepositoryPolicy>>),
  });
}

function serializeMergeRepos(
  repos: Readonly<Record<string, MergeRepositoryPolicy>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(repos)) {
    const repo = readOwnDataProperty(repos, key);
    if (repo === undefined) {
      continue;
    }
    out[key] = serializeMergeRepository(repo as MergeRepositoryPolicy);
  }
  return out;
}

function serializeMergeRepository(repo: MergeRepositoryPolicy): Record<string, unknown> {
  return serializeByKeys(repo, MERGE_REPO_KEYS, {
    veto: (veto) => serializeByKeys(veto as MergeVetoPolicy, MERGE_VETO_KEYS),
  });
}

function serializeConductorPolicy(
  conductor: NonNullable<PolicySection['conductor']>,
): Record<string, unknown> {
  return serializeByKeys(conductor, CONDUCTOR_KEYS, {
    reaper: (reaper) => serializeConductorReaper(reaper as ConductorReaperPolicy),
  });
}

function serializeConductorReaper(
  reaper: NonNullable<NonNullable<PolicySection['conductor']>['reaper']>,
): Record<string, unknown> {
  return serializeByKeys(reaper, CONDUCTOR_REAPER_KEYS, {
    repairs: (repairs) => {
      const out: Record<string, unknown> = {};
      const written = repairs as Record<string, unknown>;
      for (const kind of CONDUCTOR_REAPER_REPAIR_KINDS) {
        const flag = readOwnDataProperty(written, kind);
        if (flag !== undefined) {
          out[kind] = flag;
        }
      }
      return out;
    },
    worktrees: (worktrees) =>
      serializeByKeys(worktrees as ConductorReaperWorktreePolicy, CONDUCTOR_REAPER_WORKTREE_KEYS),
    disk: (disk) =>
      serializeByKeys(disk as ConductorReaperDiskPolicy, CONDUCTOR_REAPER_DISK_KEYS),
  });
}

function serializeShelf(shelf: ShelfSectionV2): Record<string, unknown> {
  // Read the discriminator through the own-data-property reader so an accessor
  // never runs; an unreadable provider falls to the default branch.
  return readOwnDataProperty(shelf as unknown as Readonly<Record<string, unknown>>, 'provider') === 'local'
    ? serializeByKeys(shelf, LOCAL_SHELF_KEYS)
    : serializeByKeys(shelf, GIT_SHELF_KEYS);
}

function serializeForge(forge: ForgeSectionV2): Record<string, unknown> {
  return readOwnDataProperty(forge as unknown as Readonly<Record<string, unknown>>, 'mode') === 'none'
    ? serializeByKeys(forge, NO_FORGE_KEYS)
    : serializeByKeys(forge, GITHUB_FORGE_KEYS);
}

function serializeVerification(
  verification: VerificationProceduresSection,
): Record<string, unknown> {
  return serializeByKeys(verification, V2_VERIFICATION_KEYS, {
    procedures: (procedures) =>
      serializeProcedures(procedures as Readonly<Record<string, VerificationProcedure>>),
  });
}

function serializeProcedures(
  procedures: Readonly<Record<string, VerificationProcedure>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of [...Object.keys(procedures)].sort(compareCodeUnits)) {
    const procedure = readOwnDataProperty(procedures, name);
    if (procedure === undefined) {
      continue;
    }
    out[name] = serializeByKeys(procedure as VerificationProcedure, PROCEDURE_KEYS, {
      coverage: (coverage) =>
        serializeByKeys(coverage as ProcedureCoverage, PROCEDURE_COVERAGE_KEYS),
    });
  }
  return out;
}

function serializeDecisions(decisions: DecisionsSectionV2): Record<string, unknown> {
  // The same field-by-field copy the model uses; written in the same key order.
  return { ...copyDecisions(decisions) };
}
