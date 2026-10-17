/**
 * `fleet-v2 init` (plan section 5, lane O10a): the NON-INTERACTIVE engine
 * and command. Every step is driven by flags; the interactive prompts are
 * the next lane (O10b) and will feed the same engine answers.
 *
 * This module owns only argument handling and output; every rule about the
 * file comes from the engine and the loader:
 *
 * - detection runs through `detectInitEnvironment` on the injected executor;
 * - the plan is `buildInitPlan(answers, detected)`, whose candidate is
 *   checked by the real `parseInstallation`;
 * - writes are the H2 write-node's compare-and-swap write under
 *   `<file>.lock`; an existing file is never overwritten without `--force`;
 * - after a write the doctor engine runs and its lines are printed — the
 *   doctor's own command owns the doctor exit code, so init exits 0 on a
 *   completed write (0 done, 1 refused, 2 usage).
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  buildInitPlan,
  createNodeDoctorExecutor,
  createNodeDoctorProbes,
  detectInitEnvironment,
  readInstallationFile,
  readHashOf,
  runDoctor,
  writeInstallation,
  type DoctorCommandExecutor,
  type DoctorLine,
  type DoctorProbes,
  type InitAnswers,
  type InitHostAnswer,
  type InitPlanResult,
} from "@fleet/onboarding";
import { isToolId, BUILT_IN_TOOLS } from "@fleet/tooling";
import {
  loadInstallation,
  resolveInstallationFile,
  type LoadResult,
} from "@fleet/installation";

import { formatDoctorLine, type CliIo } from "./index.js";

/** Options the driver and tests inject; every default composes the real thing. */
export interface InitCliOptions {
  /** Installation file; the loader's own resolution applies when omitted. */
  readonly installationFile?: string;
  /**
   * Executor for the detection probes; the node doctor executor composes
   * when omitted. Tests substitute it wholesale.
   */
  readonly detectionExecutor?: DoctorCommandExecutor;
  /** The doctor probes the post-write doctor run uses; real ones by default. */
  readonly doctorProbes?: DoctorProbes;
  /**
   * The loader for the post-write doctor run; the real `loadInstallation`
   * against the written file by default. Injectable for tests.
   */
  readonly loadForDoctor?: (file: string) => LoadResult;
}

const INIT_HELP = `Usage: fleet-v2 init [flags]

Non-interactive first-run setup (plan section 5): every step is a flag.
Without --yes the plan and the file it would write are printed and nothing
is written. With --yes the file is written through the engine's
compare-and-swap write under <file>.lock (an existing file is never
overwritten without --force), then the doctor engine runs and its lines are
printed.

  --profile single|multi      one local host doing every role, or named
                              hosts from --hosts
  --tools <a,b,c>             built-in tool ids to enable ('claude' is
                              accepted as an alias for claude-code)
  --recommend                 let the seat recommender propose seats and
                              chains; a catalogue it cannot build is
                              reported, not fatal
  --isolation none|container  the runner capability declaration (D4, D5):
                              none writes all three booleans false and
                              filesystemScope "inherited-directory";
                              container writes them true and
                              "scoped-worktree"
  --forge none|github         the v2 forge mode (D6)
  --forgeRepo owner/repo      required with --forge github
  --shelf local|git           the keeper shelf provider (D1); absent means
                              local
  --shelfRepo <path>          required with --shelf git (the shelf
                              repository directory)
  --hosts <json>              --profile multi only: one JSON array of host
                              drafts in the shape 'hosts add' drafts:
                              [{"name":..., "transport":..., "sshAlias"?,
                              "worktreeRoot":..., "roles":[...],
                              "runner"?:{...}}]
  --yes                       write the file and run doctor
  --force                     replace an existing installation file

The chosen isolation is applied to every drafted runner that does not name
its own declaration. With --isolation none, dispatch will refuse until the
declaration changes. The credential checklist (step 10) lists the credential
files the chosen features need with their chmod 600 commands and creates
none.

Exit codes: 0 done (plan printed, or file written), 1 refused, 2 usage
error.`;

interface InitArgs {
  readonly answers: InitAnswers;
  readonly yes: boolean;
  readonly force: boolean;
}

type ParsedInitArgs =
  | { readonly ok: true; readonly help: boolean; readonly args: InitArgs }
  | { readonly ok: false; readonly error: string };

/**
 * The value flags. The brief's own spellings are `--forgeRepo` and
 * `--shelfRepo`; their kebab-case forms are accepted as the same flags,
 * since the rest of this CLI is kebab-case.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "profile",
  "tools",
  "isolation",
  "forge",
  "forgeRepo",
  "forge-repo",
  "shelf",
  "shelfRepo",
  "shelf-repo",
  "hosts",
]);

/** Normalise the accepted spellings to one canonical name. */
const FLAG_ALIASES: Readonly<Record<string, string>> = {
  "forge-repo": "forgeRepo",
  "shelf-repo": "shelfRepo",
};
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "recommend",
  "yes",
  "force",
]);

/**
 * Tool aliases the plan's own example command uses: `claude` names the
 * claude-code tool. Anything else must be a built-in id.
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code",
};

function isHelpToken(token: string): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

function usage(error: string): ParsedInitArgs {
  return { ok: false, error: `${error}\n${INIT_HELP}` };
}

/** The keys one host draft may carry (the `hosts add` draft shape). */
const HOST_DRAFT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "transport",
  "sshAlias",
  "worktreeRoot",
  "tmpDir",
  "roles",
  "runner",
]);

/**
 * The shape every host draft must have before the engine sees it: an
 * object with a string `name`, a `roles` array and a string
 * `worktreeRoot`, and no key outside the draft shape. Any problem is a
 * usage error, never a cast past it.
 */
function hostDraftShapeError(
  drafts: readonly unknown[],
): string | undefined {
  const expected = `expected keys: ${[...HOST_DRAFT_KEYS].join(", ")}`;
  for (const [index, draft] of drafts.entries()) {
    if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
      return `--hosts: entry ${index} is not a host draft object (${expected})`;
    }
    const entry = draft as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!HOST_DRAFT_KEYS.has(key)) {
        return `--hosts: entry ${index} has unknown key '${key}' (${expected})`;
      }
    }
    if (typeof entry.name !== "string") {
      return `--hosts: entry ${index} needs a string 'name' (${expected})`;
    }
    if (!Array.isArray(entry.roles)) {
      return `--hosts: entry ${index} needs a 'roles' array (${expected})`;
    }
    if (typeof entry.worktreeRoot !== "string") {
      return `--hosts: entry ${index} needs a string 'worktreeRoot' (${expected})`;
    }
  }
  return undefined;
}

/**
 * Parse one init invocation; every problem is a usage message, never a
 * guess. Flag values are validated here so the engine only ever sees typed
 * answers.
 */
function parseInitArgs(tokens: readonly string[]): ParsedInitArgs {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isHelpToken(token)) {
      return {
        ok: true,
        help: true,
        args: { answers: undefined as never, yes: false, force: false },
      };
    }
    if (!token.startsWith("--") || token === "--") {
      return usage(`Unexpected argument: ${token}`);
    }
    const body = token.slice(2);
    const separator = body.indexOf("=");
    const rawFlag = separator === -1 ? body : body.slice(0, separator);
    const flag = FLAG_ALIASES[rawFlag] ?? rawFlag;
    let value = separator === -1 ? undefined : body.slice(separator + 1);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (value !== undefined) {
        return usage(`--${flag} takes no value`);
      }
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      return usage(`Unknown init option: --${flag}`);
    }
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined) {
        return usage(`--${flag} requires a value`);
      }
      value = next;
      index += 1;
    }
    if (values.has(flag)) {
      return usage(`--${flag} was given more than once`);
    }
    values.set(flag, value);
  }

  const profile = values.get("profile");
  if (profile !== "single" && profile !== "multi") {
    return usage('--profile must be "single" or "multi"');
  }
  const toolsText = values.get("tools");
  if (toolsText === undefined) {
    return usage(
      "--tools is required (a comma-separated list of built-in tool ids)",
    );
  }
  const tools = toolsText
    .split(",")
    .map((entry) => TOOL_ALIASES[entry.trim()] ?? entry.trim());
  if (tools.some((tool) => tool === "")) {
    return usage(
      "--tools must name built-in tool ids, e.g. opencode,claude-code",
    );
  }
  for (const tool of tools) {
    if (!isToolId(tool)) {
      return usage(
        `--tools: '${tool}' is not a built-in tool (built in: ${BUILT_IN_TOOLS.map((entry) => entry.id).join(", ")})`,
      );
    }
  }
  const isolation = values.get("isolation");
  if (isolation === undefined) {
    return usage("--isolation is required (none, container or custom)");
  }
  if (
    isolation !== "none" &&
    isolation !== "container" &&
    isolation !== "custom"
  ) {
    return usage("--isolation must be none, container or custom");
  }
  if (isolation === "custom") {
    return usage(
      "--isolation custom needs the four declaration values, which only the interactive path asks for; use none or container here",
    );
  }
  const forge = values.get("forge");
  if (forge === undefined) {
    return usage("--forge is required (none or github)");
  }
  if (forge !== "none" && forge !== "github") {
    return usage("--forge must be none or github");
  }
  const forgeRepo = values.get("forgeRepo");
  if (forge === "github" && forgeRepo === undefined) {
    return usage("--forge github requires --forgeRepo owner/repo");
  }
  if (forge === "none" && forgeRepo !== undefined) {
    return usage("--forgeRepo belongs to --forge github");
  }
  // Plan step 9, "default no → local": an absent --shelf means local.
  const shelf = values.get("shelf") ?? "local";
  if (shelf !== "local" && shelf !== "git") {
    return usage("--shelf must be local or git");
  }
  const shelfRepo = values.get("shelfRepo");
  if (shelf === "git" && shelfRepo === undefined) {
    return usage("--shelf git requires --shelfRepo <path>");
  }
  if (shelf === "local" && shelfRepo !== undefined) {
    return usage("--shelfRepo belongs to --shelf git");
  }
  let hosts: readonly InitHostAnswer[] | undefined;
  const hostsText = values.get("hosts");
  if (hostsText !== undefined) {
    if (profile !== "multi") {
      return usage("--hosts belongs to --profile multi");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(hostsText);
    } catch {
      return usage("--hosts must be one JSON array of host drafts");
    }
    if (!Array.isArray(parsedJson)) {
      return usage("--hosts must be one JSON array of host drafts");
    }
    const shapeError = hostDraftShapeError(parsedJson);
    if (shapeError !== undefined) {
      return usage(shapeError);
    }
    hosts = parsedJson as readonly InitHostAnswer[];
  } else if (profile === "multi") {
    return usage("--profile multi requires --hosts <json>");
  }
  return {
    ok: true,
    help: false,
    args: {
      answers: {
        profile,
        tools,
        recommend: booleans.has("recommend"),
        isolation,
        ...(forge === "github" && forgeRepo !== undefined ? { forgeRepo } : {}),
        forge,
        shelf,
        ...(shelf === "git" && shelfRepo !== undefined ? { shelfRepo } : {}),
        ...(hosts !== undefined ? { hosts } : {}),
      },
      yes: booleans.has("yes"),
      force: booleans.has("force"),
    },
  };
}

function printErrors(io: CliIo, errors: readonly string[]): void {
  for (const error of errors) {
    io.stderr(`${error}\n`);
  }
}

/** The seat recommendation as the table step 5 shows, or its refusal reasons. */
function printRecommendation(
  io: CliIo,
  answers: InitAnswers,
  plan: InitPlanResult,
): void {
  if (!answers.recommend || !plan.ok) {
    return;
  }
  const recommendation = plan.plan.recommendation;
  if (recommendation === undefined) {
    return;
  }
  io.stdout("seats\n");
  if (recommendation.outcome === "catalogue") {
    for (const seat of recommendation.seats) {
      io.stdout(
        `  ${seat.id}  ${seat.tool} ${seat.model}${seat.variant !== undefined ? `#${seat.variant}` : ""}  ${seat.roles.join(", ")}  ${seat.costClass}\n`,
      );
      const reason = recommendation.reasons[seat.id];
      if (reason !== undefined) {
        io.stdout(`    ${reason}\n`);
      }
    }
  } else {
    for (const reason of recommendation.reasons) {
      io.stdout(`  no catalogue: ${reason}\n`);
    }
  }
  for (const skip of recommendation.skipped) {
    io.stdout(`  skipped: ${skip}\n`);
  }
}

/** The credential checklist (step 10): paths and chmod commands, created never. */
function printCredentialChecklist(
  io: CliIo,
  credentials: readonly { path?: string; command: string; note?: string }[],
): void {
  io.stdout("credential checklist (nothing is created)\n");
  if (credentials.length === 0) {
    io.stdout("  no credential files are needed for the chosen features\n");
    return;
  }
  for (const credential of credentials) {
    io.stdout(`  ${credential.command}\n`);
    if (credential.note !== undefined) {
      io.stdout(`    ${credential.note}\n`);
    }
  }
}

/**
 * `fleet-v2 init`: detect, plan, print (and with --yes write and doctor).
 * Exit codes: 0 done, 1 refused, 2 usage error.
 */
export async function initCommand(
  argv: readonly string[],
  io: CliIo,
  options: InitCliOptions = {},
): Promise<number> {
  const parsed = parseInitArgs(argv);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${INIT_HELP}\n`);
    return 0;
  }
  const { answers, yes, force } = parsed.args;
  const file =
    options.installationFile ??
    resolveInstallationFile(undefined, process.env, process.cwd());

  const read = await readInstallationFile(file);
  if (read.status === "unreadable") {
    io.stderr(
      `${file}: could not be read (${read.reason}); nothing was written\n`,
    );
    return 1;
  }
  if (read.status === "read" && !force) {
    io.stderr(
      `refusing to overwrite an existing installation file (${file}); pass --force to replace it\n`,
    );
    return 1;
  }

  const detection = await detectInitEnvironment(
    options.detectionExecutor ?? createNodeDoctorExecutor(),
    answers.tools,
  );
  const plan = buildInitPlan(answers, detection);
  if (!plan.ok) {
    io.stderr("init refused:\n");
    printErrors(io, plan.errors);
    return 1;
  }

  io.stdout("installation plan\n");
  io.stdout(
    `  profile ${answers.profile}  tools ${answers.tools.join(", ")}\n`,
  );
  io.stdout(
    `  isolation ${answers.isolation}  forge ${answers.forge}  shelf ${answers.shelf}\n`,
  );
  for (const missing of plan.plan.missingTools) {
    io.stdout(
      `  missing tool: ${missing}${plan.plan.requiredMissingTools.includes(missing) ? " (needed by the chosen features)" : ""}\n`,
    );
  }
  if (plan.plan.isolationNote !== undefined) {
    io.stdout(`  ${plan.plan.isolationNote}\n`);
  }
  printRecommendation(io, answers, plan);
  printCredentialChecklist(io, plan.plan.credentials);
  io.stdout(`would write ${file}:\n`);
  io.stdout(plan.plan.text);

  if (!yes) {
    io.stdout("nothing was written (pass --yes to write)\n");
    return 0;
  }

  // A first write may target a directory that does not exist yet; the write
  // node locks `<file>.lock` in it and never creates directories itself.
  if (read.status === "absent") {
    await mkdir(dirname(file), { recursive: true });
  }
  const result = await writeInstallation({
    file,
    candidate: plan.plan.candidate,
    expectedHash: readHashOf(read),
  });
  if (result.status === "refused") {
    printErrors(io, result.errors);
    io.stderr("nothing was written\n");
    return 1;
  }
  io.stdout(`written ${file} (sha256 ${result.hash})\n`);

  // The doctor engine over the freshly written file. Its lines are printed;
  // the doctor command owns the doctor exit code, so init stays 0 (done).
  const loadResult = options.loadForDoctor
    ? options.loadForDoctor(file)
    : loadInstallation({ file });
  if (loadResult.status === "invalid") {
    io.stderr("the written file failed to load:\n");
    printErrors(io, loadResult.errors);
    return 1;
  }
  if (loadResult.status === "absent") {
    io.stderr("the written file could not be loaded back\n");
    return 1;
  }
  const probes = options.doctorProbes ?? createNodeDoctorProbes();
  return runDoctorAfterWrite(loadResult, probes, io);
}

/** Print the doctor lines and finish; the exit code stays init's own. */
async function runDoctorAfterWrite(
  loadResult: Exclude<LoadResult, { status: "invalid" }>,
  probes: DoctorProbes,
  io: CliIo,
): Promise<number> {
  const lines: DoctorLine[] = [];
  for await (const doctorLine of runDoctor(loadResult, probes, {
    probeSeats: false,
    env: process.env,
  })) {
    lines.push(doctorLine);
    io.stdout(`${formatDoctorLine(doctorLine)}\n`);
  }
  if (lines.some((line) => line.status !== "PASS")) {
    io.stdout(
      "doctor reported non-PASS lines; run fleet-v2 doctor for the authoritative report and exit code\n",
    );
  }
  return 0;
}
