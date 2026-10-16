/**
 * Pure serializer for the v2 file form (plan section 1), for a later
 * `init --migrate`. The output has a stable section and key order regardless
 * of how the input object was built, and a runner capability `source` is
 * never written: it is not a file field (D4).
 */

import type {
  ChainsSection,
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
  return `${JSON.stringify(document, null, 2)}\n`;
}

function serializeHosts(
  hosts: Readonly<Record<string, HostSection>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of [...Object.keys(hosts)].sort()) {
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
  return out;
}

function serializeChains(chains: ChainsSection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const role of ['implementer', 'reviewer', 'high-risk-reviewer'] as const) {
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
  for (const name of [...Object.keys(record)].sort()) {
    const procedure = record[name];
    const out: Record<string, unknown> = { command: procedure.command };
    if (procedure.args !== undefined) {
      out.args = [...procedure.args];
    }
    procedures[name] = out;
  }
  return { procedures };
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
