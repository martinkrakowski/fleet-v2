/**
 * The derived v2 model (plan section 1). Pure: no filesystem, environment or
 * clock access. The loader maps a file of either version onto this model and
 * derives every runner capability `source`; a file can never choose it (D4).
 */

import type {
  ChainStep,
  DecisionsSectionV2,
  DerivedRunnerCapabilities,
  FleetInstallation,
  FleetInstallationModel,
  ForgeSection,
  ForgeSectionV2,
  HostModel,
  HostRole,
  HostRunnerModel,
  HostSection,
  MutableHostModel,
  SeatModel,
  SeatSection,
} from './types.js';

/**
 * Warning recorded in the load result when a v1 file still carries the
 * `shelf.baseUrl`/`keyFile` transport (D1): the fields are accepted and
 * ignored, and nothing consumes them today. The warning names no values.
 */
export const V1_SHELF_IGNORED_WARNING =
  'shelf: v1 shelf fields are accepted and ignored (D1); nothing consumes them today';

export interface ModelOutcome {
  readonly model: FleetInstallationModel;
  readonly warnings: string[];
}

/** Capabilities a v1 or env-only runner asserts today, before D4 declarations. */
const LEGACY_ASSERTED_CAPABILITIES: DerivedRunnerCapabilities = {
  source: 'legacy-asserted',
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
};

/** Capabilities of a v2 runner that carries no declaration block. */
const UNDECLARED_CAPABILITIES: DerivedRunnerCapabilities = {
  source: 'undeclared',
  filesystemScope: 'unknown',
  networkEgressRestricted: null,
  cpuAndMemoryLimited: null,
  processTreeTermination: null,
};

/**
 * Map an installation of either file version onto the v2 model and derive
 * every runner capability `source` (D4): `declared` for a v2 runner with a
 * capabilities block, `undeclared` for one without, `legacy-asserted` only
 * for the v1 and env-only mapping. A v1 `shelf` section is ignored with a
 * warning naming D1 and never reaches the model.
 */
export function deriveInstallationModel(installation: FleetInstallation): ModelOutcome {
  return installation.schemaVersion === 2
    ? deriveModelFromV2(installation)
    : deriveModelFromV1(installation);
}

/** Copy a parsed v2 file onto the model, deriving each runner's source. */
function deriveModelFromV2(installation: FleetInstallation): ModelOutcome {
  const hosts: Record<string, HostModel> = Object.create(null);
  const fileHosts: Readonly<Record<string, HostSection>> = installation.hosts ?? {};
  for (const name of Object.keys(fileHosts)) {
    const host = fileHosts[name];
    hosts[name] = {
      transport: host.transport,
      ...(host.sshAlias !== undefined ? { sshAlias: host.sshAlias } : {}),
      worktreeRoot: host.worktreeRoot,
      ...(host.tmpDir !== undefined ? { tmpDir: host.tmpDir } : {}),
      roles: host.roles,
      ...(host.runner !== undefined ? { runner: deriveHostRunner(host.runner) } : {}),
    };
  }
  const v2Shelf = installation.shelf !== undefined && 'provider' in installation.shelf
    ? installation.shelf
    : undefined;
  return {
    model: {
      schemaVersion: 2,
      hosts,
      ...(installation.tools !== undefined ? { tools: [...installation.tools] } : {}),
      ...(installation.seats !== undefined ? { seats: installation.seats.map(copySeat) } : {}),
      ...(installation.chains !== undefined ? { chains: installation.chains } : {}),
      ...(installation.policy !== undefined ? { policy: installation.policy } : {}),
      ...(v2Shelf !== undefined ? { shelf: v2Shelf } : {}),
      ...(installation.forge !== undefined ? { forge: v2ForgeOf(installation.forge) } : {}),
      ...(installation.verification !== undefined
        ? { verification: { procedures: installation.verification.procedures } }
        : {}),
      ...(installation.waves !== undefined ? { waves: installation.waves } : {}),
      ...(installation.decisions !== undefined
        ? { decisions: copyDecisions(installation.decisions) }
        : {}),
    },
    warnings: [],
  };
}

/** Field-by-field copy of the decisions block (D3): no extra key survives. */
function copyDecisions(decisions: DecisionsSectionV2): DecisionsSectionV2 {
  if (decisions.provider === 'none' || decisions.provider === 'answer-file') {
    return { ...decisions };
  }
  return {
    provider: 'jev',
    model: decisions.model,
    keyFile: decisions.keyFile,
    minConfidence: decisions.minConfidence,
    monthlyBudgetUsd: decisions.monthlyBudgetUsd,
    assumedCostPerCallUsd: decisions.assumedCostPerCallUsd,
    acknowledgeProseLeavesHost: decisions.acknowledgeProseLeavesHost,
    ...(decisions.disabledProjects !== undefined
      ? { disabledProjects: [...decisions.disabledProjects] }
      : {}),
  };
}

function deriveHostRunner(runner: NonNullable<HostSection['runner']>): HostRunnerModel {
  const capabilities: DerivedRunnerCapabilities =
    runner.capabilities === undefined
      ? UNDECLARED_CAPABILITIES
      : { source: 'declared', ...runner.capabilities };
  const common = {
    port: runner.port,
    ...(runner.authFile !== undefined ? { authFile: runner.authFile } : {}),
    capabilities,
    ...(runner.maxLanes !== undefined ? { maxLanes: runner.maxLanes } : {}),
  };
  if (runner.kind === 'agy') {
    return {
      kind: 'agy',
      ...common,
      agyMode: runner.agyMode,
      ...(runner.agyAcknowledgement !== undefined
        ? { agyAcknowledgement: runner.agyAcknowledgement }
        : {}),
    };
  }
  return { kind: 'opencode', ...common };
}

function copySeat(seat: SeatSection): SeatModel {
  return {
    id: seat.id,
    tool: seat.tool,
    model: seat.model,
    ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
    ...(seat.agent !== undefined ? { agent: seat.agent } : {}),
    roles: seat.roles,
    costClass: seat.costClass,
  };
}

/**
 * Map every v1 section onto the v2 model (plan section 1): the runner and its
 * fallback chain become one host's runner and the implementer chain, the
 * reviewer becomes the reviewer chain, the worktree and verification ssh
 * hosts become ssh hosts, and verification, forge (mode `github`) and waves
 * carry over. A runner mapped from v1 or the environment asserts today's
 * capabilities as `legacy-asserted`.
 */
function deriveModelFromV1(installation: FleetInstallation): ModelOutcome {
  const warnings: string[] = [];
  if (installation.shelf !== undefined) {
    warnings.push(V1_SHELF_IGNORED_WARNING);
  }

  const hosts: Record<string, MutableHostModel> = Object.create(null);
  const runner = installation.runner;
  const laneAlias = installation.worktree?.sshHost ?? runner?.host;
  const laneRunner: HostRunnerModel | undefined =
    runner === undefined
      ? undefined
      : {
          kind: 'opencode',
          ...(runner.remotePort !== undefined ? { port: runner.remotePort } : {}),
          capabilities: LEGACY_ASSERTED_CAPABILITIES,
        };
  const laneRoles: HostRole[] = ['lane-runner'];
  if (laneAlias !== undefined) {
    hosts[laneAlias] = {
      transport: 'ssh',
      sshAlias: laneAlias,
      roles: laneRoles,
      ...(laneRunner !== undefined ? { runner: laneRunner } : {}),
    };
  } else if (laneRunner !== undefined) {
    hosts['local'] = {
      transport: 'local',
      roles: laneRoles,
      runner: laneRunner,
    };
  }
  const verification = installation.verification;
  const verifierAlias = verification !== undefined && 'sshHost' in verification
    ? verification.sshHost
    : undefined;
  if (verifierAlias !== undefined) {
    const existing = hosts[verifierAlias];
    if (existing !== undefined) {
      existing.roles = [...existing.roles, 'verifier'];
    } else {
      hosts[verifierAlias] = {
        transport: 'ssh',
        sshAlias: verifierAlias,
        roles: ['verifier'],
      };
    }
  }

  const seats: SeatModel[] = [];
  const implementerSteps: ChainStep[] = [];
  const reviewer = installation.reviewer;
  const reviewerSeat: SeatModel | undefined =
    reviewer?.model === undefined
      ? undefined
      : {
          id: 'reviewer',
          tool: 'opencode',
          model: reviewer.model,
          ...(reviewer.variant !== undefined ? { variant: reviewer.variant } : {}),
          ...(reviewer.agent !== undefined ? { agent: reviewer.agent } : {}),
          roles: ['reviewer'],
        };
  const implementerSeat: SeatModel | undefined =
    runner?.model === undefined
      ? undefined
      : {
          id: 'implementer',
          tool: 'opencode',
          model: runner.model,
          ...(runner.variant !== undefined ? { variant: runner.variant } : {}),
          ...(runner.agent !== undefined ? { agent: runner.agent } : {}),
          roles: ['implementer'],
        };
  if (implementerSeat !== undefined) {
    seats.push(implementerSeat);
    implementerSteps.push({ seatId: implementerSeat.id });
    const fallbacks = runner?.fallbackChain ?? [];
    for (let index = 0; index < fallbacks.length; index += 1) {
      const fallback = fallbacks[index];
      if (fallback.model === undefined) {
        continue;
      }
      const seat: SeatModel = {
        id: `implementer-fallback-${index + 1}`,
        tool: 'opencode',
        model: fallback.model,
        ...(fallback.variant !== undefined ? { variant: fallback.variant } : {}),
        ...(fallback.agent !== undefined ? { agent: fallback.agent } : {}),
        roles: ['implementer'],
      };
      seats.push(seat);
      implementerSteps.push({ seatId: seat.id });
    }
  }
  if (reviewerSeat !== undefined) {
    seats.push(reviewerSeat);
  }

  const tools: string[] = [];
  for (const seat of seats) {
    if (!tools.includes(seat.tool)) {
      tools.push(seat.tool);
    }
  }

  const forge = installation.forge;
  const model: FleetInstallationModel = {
    schemaVersion: 2,
    hosts,
    ...(tools.length > 0 ? { tools } : {}),
    ...(seats.length > 0 ? { seats } : {}),
    ...(
      implementerSteps.length > 0 || reviewerSeat !== undefined
        ? {
            chains: {
              ...(implementerSteps.length > 0 ? { implementer: implementerSteps } : {}),
              ...(reviewerSeat !== undefined
                ? { reviewer: [{ seatId: reviewerSeat.id }] }
                : {}),
            },
          }
        : {}
    ),
    ...(forge !== undefined ? { forge: v2ForgeOf(forge) } : {}),
    ...(verification !== undefined ? { verification: { procedures: verification.procedures } } : {}),
    ...(installation.waves !== undefined ? { waves: installation.waves } : {}),
  };
  return { model, warnings };
}

/** The v2 form of a forge section: v1 owner/repository becomes mode `github` (D6). */
function v2ForgeOf(forge: ForgeSection | ForgeSectionV2): ForgeSectionV2 {
  if ('mode' in forge) {
    return forge;
  }
  return { mode: 'github', owner: forge.owner, repo: forge.repo };
}
