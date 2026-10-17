/**
 * The init engine's plan step (plan section 5, lane O10a): operator answers
 * in, one schema version 2 candidate installation out, or the reasons it is
 * refused. Pure: no filesystem, subprocess, network, clock or console —
 * every observation about the environment enters through `InitDetection`,
 * and the only formatting here is data the caller prints.
 *
 * This lane builds the NON-INTERACTIVE path only: every field is supplied
 * by flags or defaults. The shape of `InitAnswers` is the shape the
 * interactive lane (O10b) will collect one prompt at a time, so a prompt
 * can later supply exactly the same answers to the same function.
 *
 * No rule of the file format is decided here: the candidate is checked with
 * the real `parseInstallation` before it is returned, so a plan can only
 * ever propose what the loader would accept.
 */

import { join } from "node:path";

import {
  parseInstallation,
  type ChainsSection,
  type HostSection,
  type RunnerCapabilityDeclaration,
  type SeatSection,
  type VerificationProceduresSection,
  type WavesSection,
} from "@fleet/installation";
import { isToolId, recommendSeats } from "@fleet/tooling";
import type {
  ModelInfo,
  ModelInfoList,
  SeatRecommendation,
} from "@fleet/tooling";

import type { HostDraftCandidate, HostDraftInput } from "../hosts/draft.js";
import { draftHost } from "../hosts/draft.js";
import { serialiseInstallationCandidate } from "../hosts/write.js";
import type { InitDetection } from "./detect.js";

/** The two profiles init can set up (plan section 5, step 2). */
export type InitProfile = "single" | "multi";

/** The isolation answers (plan section 5, step 4 / D4, D5). */
export type InitIsolation = "none" | "container" | "custom";

/** The forge answers (plan section 5, step 6 / D6). */
export type InitForge = "none" | "github";

/** The shelf answers (plan section 5, step 9 / D1). */
export type InitShelf = "local" | "git";

/** One host draft for the multi profile, in the shape `hosts add` drafts. */
export type InitHostAnswer = HostDraftInput;

/**
 * Everything the operator (or, in the next lane, a prompt) has answered.
 * `seats`, `verification` and `waves` are the sections the answers carry
 * verbatim; the engine invents nothing for them.
 */
export interface InitAnswers {
  readonly profile: InitProfile;
  /** Built-in tool ids; validated here with the tooling package's rule. */
  readonly tools: readonly string[];
  /** True when the seat recommender proposes the seats and chains. */
  readonly recommend: boolean;
  /** Operator-named seats, used verbatim when `recommend` is false. */
  readonly seats?: readonly SeatSection[];
  readonly isolation: InitIsolation;
  /**
   * The declaration `--isolation custom` asserts (D4, D5): each value asked
   * one at a time in the interactive lane, carried whole here. It must not
   * carry a `source` — the loader derives it.
   */
  readonly isolationCustom?: RunnerCapabilityDeclaration;
  readonly forge: InitForge;
  /** `owner/repo` for a github forge. */
  readonly forgeRepo?: string;
  readonly verification?: VerificationProceduresSection;
  readonly waves?: WavesSection;
  readonly shelf: InitShelf;
  /** The shelf repository directory for a git shelf. */
  readonly shelfRepo?: string;
  /** The host drafts for the multi profile; the single profile drafts its own. */
  readonly hosts?: readonly InitHostAnswer[];
}

/** One entry of the credential checklist (plan section 5, step 10). */
export interface InitCredentialEntry {
  /** The credential file's path, when the feature names one. */
  readonly path?: string;
  /** The command that puts the credential in place, or checks it. */
  readonly command: string;
  readonly note?: string;
}

/**
 * One accepted plan. `candidate` is the v2 file value a write would put on
 * disk and `text` is its exact bytes (the v2 writer's stable order); the
 * rest is what the CLI prints around it.
 */
export interface InitPlan {
  readonly candidate: HostDraftCandidate;
  readonly text: string;
  /**
   * Platform tools the detection could not confirm. Never fatal by itself:
   * only the entries also named in `requiredMissingTools` refuse the plan.
   */
  readonly missingTools: readonly string[];
  /** Missing tools the chosen features cannot do without; a refusal. */
  readonly requiredMissingTools: readonly string[];
  /** The recommender's outcome, when the answers asked for one. */
  readonly recommendation: SeatRecommendation | undefined;
  /** The isolation warning, when the declaration is `none` (D5). */
  readonly isolationNote: string | undefined;
  /** The credential checklist (step 10): paths listed, never created. */
  readonly credentials: readonly InitCredentialEntry[];
}

export type InitPlanResult =
  | { readonly ok: true; readonly plan: InitPlan }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The single profile's host: the machine init runs on, doing every role. */
const SINGLE_HOST_NAME = "this-machine";

/** The single profile's runner port (the example installation's value). */
const SINGLE_RUNNER_PORT = 46000;

/** The single profile's lane budget. */
const SINGLE_MAX_LANES = 1;

/** The git shelf's default branch and path prefix (plan D1 plumbing). */
const GIT_SHELF_BRANCH = "fleet-keepers";
const GIT_SHELF_PATH_PREFIX = "keepers";

/**
 * The isolation declaration each answer writes (D4, D5): `none` asserts
 * nothing is limited and the worktree scope is inherited, `container`
 * asserts every limit and the scoped worktree (the developer asserts their
 * container provides them), `custom` takes the answered values verbatim.
 */
function isolationDeclaration(
  answers: InitAnswers,
  errors: string[],
): RunnerCapabilityDeclaration | undefined {
  if (answers.isolation === "none") {
    return {
      networkEgressRestricted: false,
      cpuAndMemoryLimited: false,
      processTreeTermination: false,
      filesystemScope: "inherited-directory",
    };
  }
  if (answers.isolation === "container") {
    return {
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: "scoped-worktree",
    };
  }
  const custom = answers.isolationCustom;
  if (custom === undefined) {
    errors.push(
      "isolation: custom needs the four declaration values (isolationCustom); the non-interactive path cannot ask for them",
    );
    return undefined;
  }
  if (Object.hasOwn(custom, "source")) {
    errors.push(
      "isolationCustom.source: is derived by the loader and is never drafted",
    );
    return undefined;
  }
  const {
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    filesystemScope,
  } = custom;
  if (
    typeof networkEgressRestricted !== "boolean" ||
    typeof cpuAndMemoryLimited !== "boolean" ||
    typeof processTreeTermination !== "boolean" ||
    (filesystemScope !== "inherited-directory" &&
      filesystemScope !== "scoped-worktree")
  ) {
    errors.push(
      'isolationCustom: must carry networkEgressRestricted, cpuAndMemoryLimited and processTreeTermination as booleans and filesystemScope as "inherited-directory" or "scoped-worktree"',
    );
    return undefined;
  }
  return {
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    filesystemScope,
  };
}

/** Parse an `owner/repo` answer; the parts are validated by the loader. */
function parseForgeRepo(
  forgeRepo: string | undefined,
  errors: string[],
): { readonly owner: string; readonly repo: string } | undefined {
  if (forgeRepo === undefined) {
    errors.push("forge: mode github requires an owner/repo (forgeRepo)");
    return undefined;
  }
  const separator = forgeRepo.indexOf("/");
  const owner = separator === -1 ? "" : forgeRepo.slice(0, separator);
  const repo = forgeRepo.slice(separator + 1);
  if (owner === "" || repo === "" || forgeRepo.includes(" ")) {
    errors.push("forgeRepo: must be owner/repo");
    return undefined;
  }
  return { owner, repo };
}

/**
 * Which missing platform tools the chosen features cannot do without: `gh`
 * for a github forge, `git` for a git shelf, `ssh` for any ssh host, and
 * `curl` for waves. Everything else is reported and never fatal.
 */
function requiredToolNames(answers: InitAnswers): ReadonlySet<string> {
  const required = new Set<string>();
  if (answers.forge === "github") {
    required.add("gh");
  }
  if (answers.shelf === "git") {
    required.add("git");
  }
  if ((answers.hosts ?? []).some((host) => host.transport === "ssh")) {
    required.add("ssh");
  }
  if (answers.waves !== undefined) {
    required.add("curl");
  }
  return required;
}

/**
 * Build the plan: answers and detection in, one loader-checked candidate
 * out, or the reasons there is none. The recommendation outcome, when one
 * was asked for, is reported in the plan either way — a recommender that
 * finds no valid catalogue is a reported skip, not a refusal, because seats
 * can be added later (plan section 5, step 5) and the installation file is
 * valid without them.
 */
export function buildInitPlan(
  answers: InitAnswers,
  detected: InitDetection,
): InitPlanResult {
  const errors: string[] = [];

  if (answers.tools.length === 0) {
    errors.push("tools: at least one tool is required");
  }
  for (const tool of answers.tools) {
    if (!isToolId(tool)) {
      errors.push(`tools: '${tool}' is not a built-in tool`);
    }
  }

  const declaration = isolationDeclaration(answers, errors);

  // Hosts: the single profile drafts its one local host around the detected
  // working directory; the multi profile drafts the answered entries and
  // applies the chosen isolation declaration to every runner that does not
  // name its own.
  const hostDrafts: HostDraftInput[] = [];
  if (answers.profile === "single") {
    if (answers.hosts !== undefined) {
      errors.push("hosts: only the multi profile takes host drafts");
    }
    const worktreeRoot = join(detected.cwd, "worktrees");
    hostDrafts.push({
      name: SINGLE_HOST_NAME,
      transport: "local",
      worktreeRoot,
      tmpDir: join(worktreeRoot, ".tmp"),
      roles: ["orchestrator", "lane-runner", "verifier"],
      runner: {
        kind: "opencode",
        port: SINGLE_RUNNER_PORT,
        maxLanes: SINGLE_MAX_LANES,
        ...(declaration !== undefined ? { capabilities: declaration } : {}),
      },
    });
  } else {
    const answered = answers.hosts ?? [];
    if (answered.length === 0) {
      errors.push("hosts: the multi profile requires host drafts (--hosts)");
    }
    hostDrafts.push(...answered);
  }

  const hosts: Record<string, HostSection> = Object.create(null);
  for (const input of hostDrafts) {
    const withIsolation =
      input.runner === undefined ||
      input.runner.capabilities !== undefined ||
      declaration === undefined
        ? input
        : { ...input, runner: { ...input.runner, capabilities: declaration } };
    const drafted = draftHost(withIsolation);
    if (drafted.ok) {
      hosts[drafted.draft.name] = drafted.draft.host;
    } else {
      errors.push(...drafted.errors);
    }
  }

  // Forge (D6): required in every v2 file.
  let forge:
    | { readonly mode: "none" }
    | { readonly mode: "github"; owner: string; repo: string };
  if (answers.forge === "none") {
    forge = { mode: "none" };
  } else {
    const parsed = parseForgeRepo(answers.forgeRepo, errors);
    forge =
      parsed === undefined
        ? // Placeholder; the errors above refuse the plan before any write.
          { mode: "none" }
        : { mode: "github", owner: parsed.owner, repo: parsed.repo };
  }

  // Shelf (D1): local is today's file behaviour; git is the plumbing-only
  // provider with the engine's fixed branch and path prefix.
  let shelf:
    | { readonly provider: "local" }
    | {
        readonly provider: "git";
        repoDir: string;
        branch: string;
        pathPrefix: string;
      }
    | undefined;
  if (answers.shelf === "local") {
    shelf = { provider: "local" };
  } else if (answers.shelfRepo === undefined) {
    errors.push(
      "shelf: provider git requires a repository directory (shelfRepo)",
    );
  } else {
    shelf = {
      provider: "git",
      repoDir: answers.shelfRepo,
      branch: GIT_SHELF_BRANCH,
      pathPrefix: GIT_SHELF_PATH_PREFIX,
    };
  }

  // Missing platform tools: reported, fatal only where a feature needs them.
  const missing = detected.platformTools
    .filter((tool) => !tool.present)
    .map((tool) => tool.name);
  const required = requiredToolNames(answers);
  const requiredMissing = missing.filter((name) => required.has(name));
  for (const name of requiredMissing) {
    errors.push(`tools: ${name} is missing, and the chosen features need it`);
  }

  // Seats: the recommender's proposal, or the operator's own seats.
  let recommendation: SeatRecommendation | undefined;
  let seats: readonly SeatSection[] | undefined;
  let chains: ChainsSection | undefined;
  if (answers.recommend) {
    const models: Record<string, ModelInfoList> = {};
    for (const detectedTool of detected.enabledTools) {
      models[detectedTool.id] =
        detectedTool.models === "unknown"
          ? "unknown"
          : ("source" in detectedTool.models
              ? detectedTool.models.models
              : detectedTool.models
            ).flatMap((model): ModelInfo[] =>
              model.variants !== undefined && model.variants.length > 0
                ? model.variants.map((variant) => ({ id: model.id, variant }))
                : [{ id: model.id }],
            );
    }
    recommendation = recommendSeats({
      tools: detected.enabledTools.map((tool) => ({
        id: tool.id,
        signIn: tool.signIn,
      })),
      models,
      policy: {},
    });
    if (recommendation.outcome === "catalogue") {
      seats = recommendation.seats;
      chains = recommendation.chains;
    }
  } else if (answers.seats !== undefined) {
    seats = answers.seats;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const candidate: HostDraftCandidate = {
    schemaVersion: 2,
    hosts,
    tools: [...answers.tools],
    ...(seats !== undefined ? { seats } : {}),
    ...(chains !== undefined ? { chains } : {}),
    ...(shelf !== undefined ? { shelf } : {}),
    forge,
    ...(answers.verification !== undefined
      ? { verification: answers.verification }
      : {}),
    ...(answers.waves !== undefined ? { waves: answers.waves } : {}),
  };

  // The loader has the last word, here as everywhere: a plan the real
  // parser refuses is a refusal with the loader's own text.
  const parsed = parseInstallation(candidate);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }

  const credentials: InitCredentialEntry[] = [];
  for (const input of hostDrafts) {
    if (input.runner?.authFile !== undefined) {
      credentials.push({
        path: input.runner.authFile,
        command: `chmod 600 ${input.runner.authFile}`,
      });
    }
  }
  if (answers.waves?.tokenFile !== undefined) {
    credentials.push({
      path: answers.waves.tokenFile,
      command: `chmod 600 ${answers.waves.tokenFile}`,
    });
  }
  if (answers.forge === "github") {
    credentials.push({
      command: "gh auth status",
      note: "a github forge uses gh's own credential store; run 'gh auth login' if it is not signed in — init never reads or creates it",
    });
  }

  return {
    ok: true,
    plan: {
      candidate,
      text: serialiseInstallationCandidate(candidate),
      missingTools: missing,
      requiredMissingTools: requiredMissing,
      recommendation,
      isolationNote:
        answers.isolation === "none"
          ? "isolation is 'none': dispatch will refuse until the declaration changes"
          : undefined,
      credentials,
    },
  };
}
