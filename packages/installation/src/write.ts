/**
 * Pure serializer for the v2 file form (plan section 1), for a later
 * `init --migrate`. The output has a stable section and key order regardless
 * of how the input object was built, and a runner capability `source` is
 * never written: it is not a file field (D4).
 */

import { copyDecisions } from './decision-consumers.js';
import { CONDUCTOR_REAPER_REPAIR_KINDS } from './policy.js';
import { TELEMETRY_POLICY_KEYS } from './telemetry-policy.js';
import { SEATS_POLICY_KEYS } from './seats-policy.js';
import type {
  ChainsSection,
  DecisionsSectionV2,
  FleetInstallation,
  FleetInstallationV2,
  ForgeSectionV2,
  HostSection,
  PolicySection,
  SeatSection,
  ShelfSectionV2,
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
  return installation.schemaVersion === 2;
}

/** Serialize a v2 installation as pretty JSON with a stable key order. */
export function writeInstallationV2(installation: FleetInstallationV2): string {
  const document: Record<string, unknown> = { schemaVersion: 2 };
  document.hosts = serializeHosts(installation.hosts);
  if (installation.tools !== undefined) {
    document.tools = [...installation.tools];
  }
  if (installation.seats !== undefined) {
    document.seats = installation.seats.map(serializeSeat);
  }
  if (installation.chains !== undefined) {
    document.chains = serializeChains(installation.chains);
  }
  if (installation.policy !== undefined) {
    document.policy = serializePolicy(installation.policy);
  }
  if (installation.shelf !== undefined) {
    document.shelf = serializeShelf(installation.shelf);
  }
  // Forge is required in a v2 file (D6); the writer always emits the mode.
  document.forge = serializeForge(installation.forge);
  if (installation.verification !== undefined) {
    document.verification = serializeVerification(installation.verification);
  }
  if (installation.waves !== undefined) {
    document.waves = serializeWaves(installation.waves);
  }
  if (installation.decisions !== undefined) {
    document.decisions = serializeDecisions(installation.decisions);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** UTF-16 code-unit order: identical to the default sort(), stated explicitly (Sonar S2871). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeHosts(
  hosts: Readonly<Record<string, HostSection>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of [...Object.keys(hosts)].sort(compareCodeUnits)) {
    out[name] = serializeHost(hosts[name]);
  }
  return out;
}

function serializeHost(host: HostSection): Record<string, unknown> {
  const out: Record<string, unknown> = { transport: host.transport };
  if (host.sshAlias !== undefined) {
    out.sshAlias = host.sshAlias;
  }
  out.worktreeRoot = host.worktreeRoot;
  if (host.tmpDir !== undefined) {
    out.tmpDir = host.tmpDir;
  }
  out.roles = [...host.roles];
  if (host.runner !== undefined) {
    const runner: Record<string, unknown> = {
      kind: host.runner.kind,
      port: host.runner.port,
    };
    if (host.runner.authFile !== undefined) {
      runner.authFile = host.runner.authFile;
    }
    if (host.runner.capabilities !== undefined) {
      const capabilities = host.runner.capabilities;
      // Field by field: a `source` on the input never reaches the file.
      runner.capabilities = {
        networkEgressRestricted: capabilities.networkEgressRestricted,
        cpuAndMemoryLimited: capabilities.cpuAndMemoryLimited,
        processTreeTermination: capabilities.processTreeTermination,
        filesystemScope: capabilities.filesystemScope,
      };
    }
    if (host.runner.maxLanes !== undefined) {
      runner.maxLanes = host.runner.maxLanes;
    }
    if (host.runner.kind === 'agy') {
      runner.agyMode = host.runner.agyMode;
      if (host.runner.agyAcknowledgement !== undefined) {
        runner.agyAcknowledgement = {
          textVersion: host.runner.agyAcknowledgement.textVersion,
          acceptedAt: host.runner.agyAcknowledgement.acceptedAt,
        };
      }
    }
    out.runner = runner;
  }
  return out;
}

function serializeSeat(seat: SeatSection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: seat.id,
    tool: seat.tool,
    model: seat.model,
  };
  if (seat.variant !== undefined) {
    out.variant = seat.variant;
  }
  if (seat.agent !== undefined) {
    out.agent = seat.agent;
  }
  out.roles = [...seat.roles];
  out.costClass = seat.costClass;
  if (seat.health !== undefined) {
    out.health = seat.health;
  }
  return out;
}

function serializeChains(chains: ChainsSection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const role of ['implementer', 'fix', 'reviewer', 'high-risk-reviewer'] as const) {
    const steps = chains[role];
    if (steps === undefined) {
      continue;
    }
    out[role] = steps.map((step) => {
      const stepOut: Record<string, unknown> = { seatId: step.seatId };
      if (step.triggers !== undefined) {
        stepOut.triggers = [...step.triggers];
      }
      return stepOut;
    });
  }
  return out;
}

function serializePolicy(policy: PolicySection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (policy.forbiddenRoutes !== undefined) {
    out.forbiddenRoutes = policy.forbiddenRoutes.map((route) => ({
      tool: route.tool,
      modelPattern: route.modelPattern,
    }));
  }
  if (policy.perLaneCostCeiling !== undefined) {
    out.perLaneCostCeiling = policy.perLaneCostCeiling;
  }
  if (policy.useFreeSeats !== undefined) {
    out.useFreeSeats = policy.useFreeSeats;
  }
  if (policy.liveTail !== undefined) {
    out.liveTail = { content: policy.liveTail.content };
  }
  if (policy.autoMerge !== undefined) {
    out.autoMerge = {
      enabled: policy.autoMerge.enabled,
      allowHighRisk: policy.autoMerge.allowHighRisk,
      onBlocked: policy.autoMerge.onBlocked,
    };
  }
  if (policy.conductor !== undefined) {
    const conductor: Record<string, unknown> = { enabled: policy.conductor.enabled };
    if (policy.conductor.stopGraceMinutes !== undefined) {
      conductor.stopGraceMinutes = policy.conductor.stopGraceMinutes;
    }
    if (policy.conductor.reaper !== undefined) {
      const reaper: Record<string, unknown> = { enabled: policy.conductor.reaper.enabled };
      if (policy.conductor.reaper.intervalMinutes !== undefined) {
        reaper.intervalMinutes = policy.conductor.reaper.intervalMinutes;
      }
      if (policy.conductor.reaper.graceMinutes !== undefined) {
        reaper.graceMinutes = policy.conductor.reaper.graceMinutes;
      }
      if (policy.conductor.reaper.staleStopMinutes !== undefined) {
        reaper.staleStopMinutes = policy.conductor.reaper.staleStopMinutes;
      }
      if (policy.conductor.reaper.repairs !== undefined) {
        const repairs: Record<string, unknown> = {};
        for (const kind of CONDUCTOR_REAPER_REPAIR_KINDS) {
          if (policy.conductor.reaper.repairs[kind] !== undefined) {
            repairs[kind] = policy.conductor.reaper.repairs[kind];
          }
        }
        reaper.repairs = repairs;
      }
      conductor.reaper = reaper;
    }
    out.conductor = conductor;
  }
  if (policy.telemetry !== undefined) {
    out.telemetry = serializePolicyBlock(policy.telemetry, TELEMETRY_POLICY_KEYS);
  }
  if (policy.seats !== undefined) {
    out.seats = serializePolicyBlock(policy.seats, SEATS_POLICY_KEYS);
  }
  return out;
}

/**
 * A policy block's present keys in the given order; arrays and plain objects are copied one level deep.
 */
function serializePolicyBlock(block: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = block as Readonly<Record<string, unknown>>;
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      out[key] = [...value];
    } else if (typeof value === 'object' && value !== null) {
      out[key] = { ...value };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function serializeShelf(shelf: ShelfSectionV2): Record<string, unknown> {
  if (shelf.provider === 'local') {
    return { provider: 'local' };
  }
  return {
    provider: 'git',
    repoDir: shelf.repoDir,
    branch: shelf.branch,
    pathPrefix: shelf.pathPrefix,
  };
}

function serializeForge(forge: ForgeSectionV2): Record<string, unknown> {
  if (forge.mode === 'none') {
    return { mode: 'none' };
  }
  return { mode: 'github', owner: forge.owner, repo: forge.repo };
}

function serializeVerification(
  verification: VerificationProceduresSection,
): Record<string, unknown> {
  const procedures: Record<string, unknown> = {};
  const record: Readonly<Record<string, VerificationProcedure>> = verification.procedures;
  for (const name of [...Object.keys(record)].sort(compareCodeUnits)) {
    const procedure = record[name];
    const out: Record<string, unknown> = { command: procedure.command };
    if (procedure.args !== undefined) {
      out.args = [...procedure.args];
    }
    if (procedure.coverage !== undefined) {
      out.coverage = {
        reader: procedure.coverage.reader,
        unitKind: procedure.coverage.unitKind,
        minUnits: procedure.coverage.minUnits,
      };
    }
    procedures[name] = out;
  }
  return { procedures };
}

function serializeDecisions(decisions: DecisionsSectionV2): Record<string, unknown> {
  // The same field-by-field copy the model uses; written in the same key order.
  return { ...copyDecisions(decisions) };
}


function serializeWaves(waves: WavesSection): Record<string, unknown> {
  const out: Record<string, unknown> = {
    baseUrl: waves.baseUrl,
    tokenFile: waves.tokenFile,
  };
  if (waves.caFile !== undefined) {
    out.caFile = waves.caFile;
  }
  if (waves.ownerPublicKey !== undefined) {
    out.ownerPublicKey = waves.ownerPublicKey;
  }
  return out;
}
