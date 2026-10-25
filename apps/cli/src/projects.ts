/**
 * `fleet-v2 projects` (lane P6a): list, show, add, edit and retire project
 * profiles through the operator-coordination use cases. This module owns only
 * argument handling, confirmation and output; every rule about a profile
 * comes from the use cases and the ProjectProfile entity:
 *
 * - list/show read without mutating state; list narrows by --status and
 *   prints one line per profile (or the use-case result with --json);
 * - add prints the candidate, confirms it, then registers (revision 0);
 * - edit inspects the profile, builds changes from only the flags given,
 *   prints a diff and confirms before updating with the revision it read;
 * - retire inspects, confirms, then retires with the revision it read.
 *
 * A declined confirmation prints `nothing changed` and exits 1. Usage errors
 * (unknown flag, missing required flag, bad --max-lanes, malformed --clones)
 * exit 2 with one line naming the problem. Results map through the shared
 * `exitCodeForResult` semantics: rejected/not-found print the reason and exit
 * 1, success exits 0.
 */

import { confirmFromStdin } from './hosts.js';
import { exitCodeForResult, type CliIo } from './index.js';
import type { FleetCliRuntime } from './composition.js';
import type { ProjectCloneRecord } from '@fleet/operator-coordination';

/** Options the driver and tests inject; the default reads stdin like hosts. */
export interface ProjectsCliOptions {
  /**
   * The confirmation gate for a write. The default reads one line from stdin
   * and accepts only an explicit y/yes; a declined or closed stdin refuses.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
}

const PROJECTS_HELP = `Usage: fleet-v2 projects <subcommand> [flags]

Manage project profiles: list active or retired profiles, show one profile
in full, register a project, probe it read-only, adopt a project that
already has work orders, edit an active profile or retire it. Every change
is confirmed unless --yes is given; a declined confirmation prints 'nothing
changed' and exits 1.

  list [--status active|retired] [--json]
                      print one line per profile, or the use-case result as
                      one JSON document with --json
  show <projectId> [--json]
                      print every profile field; clones and last probe checks
                      get their own lines
  probe <projectId> [--json]
                      run the read-only project probe and record its receipt;
                      one line per check, then recorded or not recorded
  add --project-id <id> --display-name <s> --repository <s>
      --dispatcher-host <h> --policy-revision <s> --max-lanes <n>
      [--default-branch <b>]
      [--clones h=/path:/worktreeRoot,...]
      [--gate-procedures a,b] [--allowed-prefixes x,y]
      [--runner-capabilities k=true,k2=false]
      [--yes]
                      register a new project profile (revision 0)
  adopt [<projectId>] [flags as add except --project-id]
      [--yes]
                      with no id, list projects that have work orders but no
                      profile; with an id, adopt one (register its profile)
  edit <projectId> [same optional field flags as add except --project-id]
      [--yes]
                      change only the fields named on the command line, each
                      confirmed after its diff; lists/maps replace the whole
                      value
  retire <projectId> [--yes]
                      mark a project profile retired (history is kept)

Exit codes: 0 completed, 1 refused/rejected/not-found (or a declined
confirmation), 2 usage error.`;

type ProjectsSubcommand = 'list' | 'show' | 'probe' | 'add' | 'adopt' | 'edit' | 'retire';

/** Which flags each subcommand accepts; anything else is a usage error. */
const SUBCOMMAND_FLAGS: Readonly<Record<ProjectsSubcommand, ReadonlySet<string>>> = {
  list: new Set(['status', 'json']),
  show: new Set(['json']),
  probe: new Set(['json']),
  add: new Set([
    'project-id',
    'display-name',
    'repository',
    'dispatcher-host',
    'policy-revision',
    'max-lanes',
    'default-branch',
    'clones',
    'gate-procedures',
    'allowed-prefixes',
    'runner-capabilities',
    'yes',
  ]),
  adopt: new Set([
    'display-name',
    'repository',
    'dispatcher-host',
    'policy-revision',
    'max-lanes',
    'default-branch',
    'clones',
    'gate-procedures',
    'allowed-prefixes',
    'runner-capabilities',
    'yes',
  ]),
  edit: new Set([
    'display-name',
    'repository',
    'dispatcher-host',
    'policy-revision',
    'max-lanes',
    'default-branch',
    'clones',
    'gate-procedures',
    'allowed-prefixes',
    'runner-capabilities',
    'yes',
  ]),
  retire: new Set(['yes']),
};

/** The parsed tokens of one invocation, before shape validation. */
type ParsedTokens =
  | { readonly ok: true; readonly positional: readonly string[]; readonly flags: Readonly<Record<string, string | true>> }
  | { readonly ok: false; readonly error: string };

function isHelpToken(token: string): boolean {
  return token === 'help' || token === '--help' || token === '-h';
}

/** Parse one invocation; every unknown flag or missing value is a usage error. */
function parseProjectsTokens(tokens: readonly string[], subcommand: ProjectsSubcommand): ParsedTokens {
  const allowed = SUBCOMMAND_FLAGS[subcommand];
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // `help` is a word only in the first position; the flags count anywhere.
    if (token === '--help' || token === '-h' || (index === 0 && token === 'help')) {
      return { ok: true, positional: [], flags: { help: true } };
    }
    if (!token.startsWith('--') || token === '--') {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
    if (!allowed.has(flag)) {
      return { ok: false, error: `Unknown projects ${subcommand} option: --${flag}` };
    }
    if (flag === 'yes' || flag === 'json') {
      if (inlineValue !== undefined) {
        return { ok: false, error: `--${flag} takes no value` };
      }
      flags[flag] = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `--${flag} requires a value` };
      }
      value = next;
      index += 1;
    }
    if (value.trim() === '') {
      return { ok: false, error: `--${flag} requires a value` };
    }
    flags[flag] = value;
  }
  return { ok: true, positional, flags };
}

/** The one project id a show/edit/retire subcommand requires. */
function requireProjectId(parsed: Extract<ParsedTokens, { ok: true }>): string | null {
  const id = (parsed.positional[0] ?? '').trim();
  return id === '' ? null : id;
}

/** Reject unexpected positional tokens; every subcommand picks its count. */
function expectPositionals(parsed: Extract<ParsedTokens, { ok: true }>, count: number, subcommand: ProjectsSubcommand): string | null {
  if (parsed.positional.length === count) {
    return null;
  }
  if (parsed.positional.length > count) {
    return `Unexpected argument: ${parsed.positional[count]}`;
  }
  return `projects ${subcommand} requires a project id`;
}

type SingleProjectCommand =
  | {
      readonly projectId: string;
      readonly flags: Readonly<Record<string, string | true>>;
    }
  | { readonly exit: number };

/**
 * Shared opening for `<subcommand> <projectId> [flags]`: parse tokens, handle
 * `--help`, require exactly one positional project id, and report usage errors
 * with exit code 2.
 */
function parseSingleProjectCommand(
  tokens: readonly string[],
  subcommand: ProjectsSubcommand,
  io: CliIo,
): SingleProjectCommand {
  const parsed = parseProjectsTokens(tokens, subcommand);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return { exit: 2 };
  }
  if (parsed.flags.help === true) {
    io.stdout(`${PROJECTS_HELP}\n`);
    return { exit: 0 };
  }
  const unexpected = expectPositionals(parsed, 1, subcommand);
  if (unexpected !== null) {
    io.stderr(`${unexpected}\n`);
    return { exit: 2 };
  }
  const projectId = requireProjectId(parsed);
  if (projectId === null) {
    io.stderr(`projects ${subcommand} requires a project id\n`);
    return { exit: 2 };
  }
  return { projectId, flags: parsed.flags };
}

function parsePositiveInteger(flag: string, value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function parseClones(value: string): { readonly ok: true; readonly clones: Readonly<Record<string, ProjectCloneRecord>> } | { readonly ok: false; readonly error: string } {
  const clones: Record<string, ProjectCloneRecord> = {};
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry === '') {
      return { ok: false, error: '--clones requires entries h=/path:/worktreeRoot' };
    }
    const equals = entry.indexOf('=');
    if (equals === -1) {
      return { ok: false, error: `--clones entry '${entry}' is missing '='` };
    }
    const host = entry.slice(0, equals).trim();
    const rest = entry.slice(equals + 1);
    const colon = rest.indexOf(':');
    if (colon === -1) {
      return { ok: false, error: `--clones entry '${entry}' is missing ':'` };
    }
    const path = rest.slice(0, colon);
    const worktreeRoot = rest.slice(colon + 1);
    if (host === '' || path.trim() === '' || worktreeRoot.trim() === '') {
      return { ok: false, error: `--clones entry '${entry}' requires host, path and worktreeRoot` };
    }
    clones[host] = { path: path.trim(), worktreeRoot: worktreeRoot.trim() };
  }
  return { ok: true, clones };
}

function parseRunnerCapabilities(value: string): { readonly ok: true; readonly capabilities: Readonly<Record<string, boolean | string>> } | { readonly ok: false; readonly error: string } {
  const capabilities: Record<string, boolean | string> = {};
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (entry === '') {
      return { ok: false, error: '--runner-capabilities requires entries k=true,k2=false' };
    }
    const equals = entry.indexOf('=');
    if (equals === -1) {
      return { ok: false, error: `--runner-capabilities entry '${entry}' is missing '='` };
    }
    const name = entry.slice(0, equals).trim();
    const rawValue = entry.slice(equals + 1).trim();
    if (name === '' || rawValue === '') {
      return { ok: false, error: `--runner-capabilities entry '${entry}' requires a name and a value` };
    }
    capabilities[name] = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue;
  }
  return { ok: true, capabilities };
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Render one field as a single scalar line value (lists/maps are flattened). */
function renderFieldValue(field: string, value: unknown): string {
  if (field === 'maxConcurrentLanes') {
    return String(value);
  }
  if (field === 'defaultBranch') {
    return value === null ? 'none' : String(value);
  }
  if (field === 'clones') {
    const clones = value as Readonly<Record<string, ProjectCloneRecord>>;
    return Object.entries(clones)
      .map(([host, clone]) => `${host}=${clone.path}:${clone.worktreeRoot}`)
      .join(', ');
  }
  if (field === 'gateProcedures' || field === 'defaultAllowedPathPrefixes') {
    return (value as readonly string[]).join(', ');
  }
  if (field === 'runnerCapabilities') {
    return Object.entries(value as Readonly<Record<string, boolean | string>>)
      .map(([name, cap]) => `${name}=${String(cap)}`)
      .join(', ');
  }
  return String(value);
}

const SCALAR_FIELDS: readonly { readonly field: keyof import('@fleet/operator-coordination').ProjectProfileRecord; readonly label: string }[] = [
  { field: 'projectId', label: 'projectId' },
  { field: 'displayName', label: 'displayName' },
  { field: 'repository', label: 'repository' },
  { field: 'designatedDispatcherHost', label: 'designatedDispatcherHost' },
  { field: 'policyRevision', label: 'policyRevision' },
  { field: 'maxConcurrentLanes', label: 'maxConcurrentLanes' },
  { field: 'runnerCapabilities', label: 'runnerCapabilities' },
  { field: 'revision', label: 'revision' },
  { field: 'updatedAtIso', label: 'updatedAtIso' },
  { field: 'status', label: 'status' },
  { field: 'defaultBranch', label: 'defaultBranch' },
];

function formatProbeCheckLine(check: {
  readonly result: string;
  readonly name: string;
  readonly host: string | null;
  readonly detail: string;
}): string {
  return `${check.result}  ${check.name}  ${check.host ?? '-'}  ${check.detail}\n`;
}

/** Print one profile in full (show): scalars, one line per clone, probe checks. */
function printProfile(io: CliIo, profile: import('@fleet/operator-coordination').ProjectProfileRecord): void {
  for (const { field, label } of SCALAR_FIELDS) {
    io.stdout(`${label}: ${renderFieldValue(field, profile[field])}\n`);
  }
  for (const [host, clone] of Object.entries(profile.clones)) {
    io.stdout(`clone ${host}: ${clone.path} (worktrees ${clone.worktreeRoot})\n`);
  }
  io.stdout(`gateProcedures: ${renderFieldValue('gateProcedures', profile.gateProcedures)}\n`);
  io.stdout(`defaultAllowedPathPrefixes: ${renderFieldValue('defaultAllowedPathPrefixes', profile.defaultAllowedPathPrefixes)}\n`);
  if (profile.lastProbe === null) {
    io.stdout('lastProbe: none\n');
    return;
  }
  io.stdout(`lastProbe: probedAt ${profile.lastProbe.probedAtIso} from ${profile.lastProbe.probedFrom}\n`);
  for (const check of profile.lastProbe.checks) {
    io.stdout(`  ${formatProbeCheckLine(check)}`);
  }
}

/** The worst probe result across the receipt's checks, or none. */
function probeWorst(receipt: import('@fleet/operator-coordination').ProjectProfileRecord['lastProbe']): 'pass' | 'fail' | 'unknown' | 'none' {
  if (receipt === null || receipt.checks.length === 0) {
    return 'none';
  }
  const rank = { pass: 0, unknown: 1, fail: 2 } as const;
  let worst: 'pass' | 'unknown' | 'fail' = 'pass';
  for (const check of receipt.checks) {
    if (rank[check.result] > rank[worst]) {
      worst = check.result;
    }
  }
  return worst;
}

async function projectsList(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
): Promise<number> {
  const parsed = parseProjectsTokens(tokens, 'list');
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.flags.help === true) {
    io.stdout(`${PROJECTS_HELP}\n`);
    return 0;
  }
  const unexpected = expectPositionals(parsed, 0, 'list');
  if (unexpected !== null) {
    io.stderr(`${unexpected}\n`);
    return 2;
  }
  let status: 'active' | 'retired' | undefined;
  if (parsed.flags.status !== undefined) {
    const raw = String(parsed.flags.status);
    if (raw !== 'active' && raw !== 'retired') {
      io.stderr('--status must be active or retired\n');
      return 2;
    }
    status = raw;
  }
  const result = await runtime.coordination.listProjectProfiles.listProjectProfiles({
    ...(status !== undefined ? { status } : {}),
  });
  if (parsed.flags.json === true) {
    io.stdout(`${JSON.stringify(result)}\n`);
    return exitCodeForResult(result);
  }
  if (result.outcome === 'rejected') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  for (const profile of result.profiles) {
    io.stdout(
      `${profile.projectId}  ${profile.status}  rev ${profile.revision}  ${profile.repository}  probe ${probeWorst(profile.lastProbe)}\n`,
    );
  }
  return 0;
}

async function projectsShow(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
): Promise<number> {
  const command = parseSingleProjectCommand(tokens, 'show', io);
  if ('exit' in command) {
    return command.exit;
  }
  const { projectId, flags } = command;
  const result = await runtime.coordination.inspectProjectProfile.inspectProjectProfile({ projectId });
  if (flags.json === true) {
    io.stdout(`${JSON.stringify(result)}\n`);
    return exitCodeForResult(result);
  }
  if (result.outcome === 'rejected') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  if (result.outcome !== 'found') {
    io.stderr(`project ${projectId} is not registered\n`);
    return 1;
  }
  printProfile(io, result.profile);
  return 0;
}

type ProbeSuccessResult = Extract<
  Awaited<ReturnType<FleetCliRuntime['execution']['probeProject']['execute']>>,
  { readonly outcome: 'probed' }
>;

function probeExitCode(result: ProbeSuccessResult): number {
  const allPass = result.report.checks.every((check) => check.result === 'pass');
  return allPass && result.recorded ? 0 : 1;
}

function printProbeReport(io: CliIo, result: ProbeSuccessResult): void {
  for (const check of result.report.checks) {
    io.stdout(formatProbeCheckLine(check));
  }
  if (result.recorded) {
    io.stdout('recorded\n');
  } else {
    io.stdout(`not recorded: ${result.recordReason}\n`);
  }
}

async function projectsProbe(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
): Promise<number> {
  const command = parseSingleProjectCommand(tokens, 'probe', io);
  if ('exit' in command) {
    return command.exit;
  }
  const { projectId, flags } = command;
  const result = await runtime.execution.probeProject.execute({ projectId });
  if (result.outcome === 'rejected' || result.outcome === 'not-found') {
    if (flags.json === true) {
      io.stdout(`${JSON.stringify(result)}\n`);
      return 1;
    }
    const reason =
      result.outcome === 'rejected' ? result.reason : `project ${projectId} is not registered`;
    io.stderr(`${reason}\n`);
    return 1;
  }
  const exitCode = probeExitCode(result);
  if (flags.json === true) {
    io.stdout(`${JSON.stringify(result)}\n`);
    return exitCode;
  }
  printProbeReport(io, result);
  return exitCode;
}

/** Common registration fields parsed from add/adopt flags. */
interface RegistrationFieldArgs {
  readonly displayName: string;
  /** Omitted when the candidate's single repository should be used. */
  readonly repository?: string;
  readonly designatedDispatcherHost: string;
  readonly policyRevision: string;
  readonly maxConcurrentLanes: number;
  readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
  readonly defaultBranch?: string;
  readonly clones?: Readonly<Record<string, ProjectCloneRecord>>;
  readonly gateProcedures?: readonly string[];
  readonly defaultAllowedPathPrefixes?: readonly string[];
  readonly yes: boolean;
}

/** The typed registration fields one add invocation parsed. */
interface AddArgs extends RegistrationFieldArgs {
  readonly projectId: string;
  readonly repository: string;
}

type ParsedRegistrationFields =
  | { readonly ok: true; readonly fields: RegistrationFieldArgs }
  | { readonly ok: false; readonly error: string };

function optionalStringFlag(
  flags: Readonly<Record<string, string | true>>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function optionalListFlag(
  flags: Readonly<Record<string, string | true>>,
  name: string,
): readonly string[] | undefined {
  const value = optionalStringFlag(flags, name);
  return value === undefined ? undefined : splitList(value);
}

type ParsedClonesAndCapabilities =
  | {
      readonly ok: true;
      readonly clones?: Readonly<Record<string, ProjectCloneRecord>>;
      readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
    }
  | { readonly ok: false; readonly error: string };

function parseOptionalClonesAndCapabilities(
  flags: Readonly<Record<string, string | true>>,
): ParsedClonesAndCapabilities {
  let clones: Readonly<Record<string, ProjectCloneRecord>> | undefined;
  if (flags.clones !== undefined) {
    const parsedClones = parseClones(String(flags.clones));
    if (!parsedClones.ok) {
      return parsedClones;
    }
    clones = parsedClones.clones;
  }
  let runnerCapabilities: Readonly<Record<string, boolean | string>> = {};
  if (flags['runner-capabilities'] !== undefined) {
    const parsedCapabilities = parseRunnerCapabilities(String(flags['runner-capabilities']));
    if (!parsedCapabilities.ok) {
      return parsedCapabilities;
    }
    runnerCapabilities = parsedCapabilities.capabilities;
  }
  return {
    ok: true,
    ...(clones !== undefined ? { clones } : {}),
    runnerCapabilities,
  };
}

function buildRegistrationFields(
  flags: Readonly<Record<string, string | true>>,
  base: {
    readonly displayName: string;
    readonly designatedDispatcherHost: string;
    readonly policyRevision: string;
    readonly maxConcurrentLanes: number;
    readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
    readonly clones?: Readonly<Record<string, ProjectCloneRecord>>;
  },
): RegistrationFieldArgs {
  const repository = optionalStringFlag(flags, 'repository');
  const defaultBranch = optionalStringFlag(flags, 'default-branch');
  const gateProcedures = optionalListFlag(flags, 'gate-procedures');
  const defaultAllowedPathPrefixes = optionalListFlag(flags, 'allowed-prefixes');
  return {
    ...base,
    ...(repository !== undefined ? { repository } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(gateProcedures !== undefined ? { gateProcedures } : {}),
    ...(defaultAllowedPathPrefixes !== undefined ? { defaultAllowedPathPrefixes } : {}),
    yes: flags.yes === true,
  };
}

function parseRegistrationFieldFlags(
  flags: Readonly<Record<string, string | true>>,
  subcommand: 'add' | 'adopt',
  defaultDisplayName?: string,
): ParsedRegistrationFields {
  const displayName = optionalStringFlag(flags, 'display-name') ?? defaultDisplayName;
  if (displayName === undefined) {
    return { ok: false, error: `projects ${subcommand} requires --display-name` };
  }
  const required: Readonly<Array<readonly [string, string]>> = [
    ['dispatcher-host', 'designatedDispatcherHost'],
    ['policy-revision', 'policyRevision'],
    ['max-lanes', 'maxConcurrentLanes'],
  ];
  const values: Record<string, string> = {};
  for (const [flag, field] of required) {
    const value = flags[flag];
    if (typeof value !== 'string') {
      return { ok: false, error: `projects ${subcommand} requires --${flag}` };
    }
    values[field] = value;
  }
  const maxLanes = parsePositiveInteger('max-lanes', values['maxConcurrentLanes']);
  if (maxLanes === null) {
    return {
      ok: false,
      error: `--max-lanes must be a positive integer, not '${values['maxConcurrentLanes']}'`,
    };
  }
  const parsedMaps = parseOptionalClonesAndCapabilities(flags);
  if (!parsedMaps.ok) {
    return parsedMaps;
  }
  return {
    ok: true,
    fields: buildRegistrationFields(flags, {
      displayName,
      designatedDispatcherHost: values.designatedDispatcherHost,
      policyRevision: values.policyRevision,
      maxConcurrentLanes: maxLanes,
      runnerCapabilities: parsedMaps.runnerCapabilities,
      ...(parsedMaps.clones !== undefined ? { clones: parsedMaps.clones } : {}),
    }),
  };
}

type ParsedAdd =
  | { readonly ok: true; readonly args: AddArgs }
  | { readonly ok: false; readonly error: string };

function parseAddArgs(tokens: readonly string[]): ParsedAdd {
  const parsed = parseProjectsTokens(tokens, 'add');
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.flags.help === true) {
    return { ok: false, error: '' };
  }
  const unexpected = expectPositionals(parsed, 0, 'add');
  if (unexpected !== null) {
    return { ok: false, error: unexpected };
  }
  const projectId = parsed.flags['project-id'];
  if (typeof projectId !== 'string') {
    return { ok: false, error: 'projects add requires --project-id' };
  }
  const common = parseRegistrationFieldFlags(parsed.flags, 'add');
  if (!common.ok) {
    return common;
  }
  if (common.fields.repository === undefined) {
    return { ok: false, error: 'projects add requires --repository' };
  }
  return {
    ok: true,
    args: {
      ...common.fields,
      projectId,
      repository: common.fields.repository,
    },
  };
}

/** Print the registration candidate: `<verb> project <id>` then each field. */
function printRegisterCandidate(
  io: CliIo,
  args: AddArgs,
  verb: 'register' | 'adopt' = 'register',
): void {
  io.stdout(`${verb} project ${args.projectId}\n`);
  io.stdout(`  displayName: ${args.displayName}\n`);
  io.stdout(`  repository: ${args.repository}\n`);
  io.stdout(`  designatedDispatcherHost: ${args.designatedDispatcherHost}\n`);
  io.stdout(`  policyRevision: ${args.policyRevision}\n`);
  io.stdout(`  maxConcurrentLanes: ${args.maxConcurrentLanes}\n`);
  io.stdout(`  runnerCapabilities: ${renderFieldValue('runnerCapabilities', args.runnerCapabilities)}\n`);
  if (args.defaultBranch !== undefined) {
    io.stdout(`  defaultBranch: ${args.defaultBranch}\n`);
  }
  if (args.clones !== undefined) {
    for (const [host, clone] of Object.entries(args.clones)) {
      io.stdout(`  clone ${host}: ${clone.path} (worktrees ${clone.worktreeRoot})\n`);
    }
  }
  if (args.gateProcedures !== undefined) {
    io.stdout(`  gateProcedures: ${args.gateProcedures.join(', ')}\n`);
  }
  if (args.defaultAllowedPathPrefixes !== undefined) {
    io.stdout(`  defaultAllowedPathPrefixes: ${args.defaultAllowedPathPrefixes.join(', ')}\n`);
  }
}

async function registerConfirmedCandidate(
  io: CliIo,
  runtime: FleetCliRuntime,
  args: AddArgs,
): Promise<number> {
  const result = await runtime.coordination.registerProjectProfile.registerProjectProfile({
    projectId: args.projectId,
    displayName: args.displayName,
    repository: args.repository,
    designatedDispatcherHost: args.designatedDispatcherHost,
    policyRevision: args.policyRevision,
    maxConcurrentLanes: args.maxConcurrentLanes,
    runnerCapabilities: args.runnerCapabilities,
    ...(args.defaultBranch !== undefined ? { defaultBranch: args.defaultBranch } : {}),
    ...(args.clones !== undefined ? { clones: args.clones } : {}),
    ...(args.gateProcedures !== undefined ? { gateProcedures: args.gateProcedures } : {}),
    ...(args.defaultAllowedPathPrefixes !== undefined
      ? { defaultAllowedPathPrefixes: args.defaultAllowedPathPrefixes }
      : {}),
  });
  if (result.outcome === 'rejected') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  io.stdout(`registered project ${args.projectId} (rev 0)\n`);
  return 0;
}

/** Shared confirm-then-register tail of `add` and `adopt`. */
async function confirmAndRegisterCandidate(
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
  args: AddArgs,
  verb: 'register' | 'adopt',
): Promise<number> {
  if (!args.yes) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`${verb} project ${args.projectId}? [y/N]`))) {
      io.stdout('nothing changed\n');
      return 1;
    }
  }
  return registerConfirmedCandidate(io, runtime, args);
}

async function projectsAdd(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
): Promise<number> {
  const parsed = parseAddArgs(tokens);
  if (!parsed.ok) {
    if (parsed.error !== '') {
      io.stderr(`${parsed.error}\n`);
      return 2;
    }
    io.stdout(`${PROJECTS_HELP}\n`);
    return 0;
  }
  const args = parsed.args;
  printRegisterCandidate(io, args, 'register');
  return confirmAndRegisterCandidate(io, runtime, options, args, 'register');
}

/** The typed registration fields one adopt invocation parsed. */
interface AdoptArgs extends RegistrationFieldArgs {
  readonly projectId: string;
}

function parseAdoptArgs(
  tokens: readonly string[],
  io: CliIo,
): AdoptArgs | { readonly exit: number } {
  const command = parseSingleProjectCommand(tokens, 'adopt', io);
  if ('exit' in command) {
    return command;
  }
  const common = parseRegistrationFieldFlags(command.flags, 'adopt', command.projectId);
  if (!common.ok) {
    io.stderr(`${common.error}\n`);
    return { exit: 2 };
  }
  return {
    ...common.fields,
    projectId: command.projectId,
  };
}

async function listAdoptionCandidates(io: CliIo, runtime: FleetCliRuntime): Promise<number> {
  const listed = await runtime.execution.listUnregisteredProjects.execute();
  if (listed.projects.length === 0) {
    io.stdout('none\n');
    return 0;
  }
  for (const p of listed.projects) {
    io.stdout(
      `${p.projectId}  orders ${p.workOrderCount} (active ${p.activeWorkOrderCount})  repos ${p.repositories.join(',')}  last ${p.lastUpdatedAtIso}\n`,
    );
  }
  return 0;
}

async function reportMissingAdoptCandidate(
  io: CliIo,
  runtime: FleetCliRuntime,
  projectId: string,
): Promise<number> {
  const inspected = await runtime.coordination.inspectProjectProfile.inspectProjectProfile({
    projectId,
  });
  if (inspected.outcome === 'found') {
    io.stderr(`project ${projectId} is already registered\n`);
  } else if (inspected.outcome === 'rejected') {
    io.stderr(`${inspected.reason}\n`);
  } else {
    io.stderr(`project ${projectId} has no work orders to adopt\n`);
  }
  return 1;
}

function buildAdoptCandidate(
  args: AdoptArgs,
  repositories: readonly string[],
  io: CliIo,
): AddArgs | null {
  let repository = args.repository;
  if (repository === undefined) {
    if (repositories.length !== 1) {
      const count = repositories.length === 0 ? 'no' : String(repositories.length);
      const list = repositories.join(',') || 'none';
      io.stderr(
        `--repository is required: project ${args.projectId} has ${count} repositories (${list})\n`,
      );
      return null;
    }
    repository = repositories[0];
  }
  return {
    ...args,
    repository,
  };
}

async function projectsAdopt(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
): Promise<number> {
  // With no id, list adoption candidates: projects that have work orders but
  // no profile. Read-only; exit 0.
  if (tokens.length === 0) {
    return listAdoptionCandidates(io, runtime);
  }
  const args = parseAdoptArgs(tokens, io);
  if ('exit' in args) {
    return args.exit;
  }
  const listed = await runtime.execution.listUnregisteredProjects.execute();
  const candidate = listed.projects.find((p) => p.projectId === args.projectId);
  if (candidate === undefined) {
    return reportMissingAdoptCandidate(io, runtime, args.projectId);
  }
  const fullArgs = buildAdoptCandidate(args, candidate.repositories, io);
  if (fullArgs === null) {
    return 1;
  }
  printRegisterCandidate(io, fullArgs, 'adopt');
  if (!candidate.repositories.includes(fullArgs.repository)) {
    io.stdout(
      `warning: ${fullArgs.repository} is not among the repositories its work orders name (${candidate.repositories.join(', ')})\n`,
    );
  }
  return confirmAndRegisterCandidate(io, runtime, options, fullArgs, 'adopt');
}

/** The one field map an edit invocation parsed, keyed by record field name. */
type EditChanges = Partial<{
  displayName: string;
  repository: string;
  designatedDispatcherHost: string;
  policyRevision: string;
  maxConcurrentLanes: number;
  runnerCapabilities: Readonly<Record<string, boolean | string>>;
  defaultBranch: string | null;
  clones: Readonly<Record<string, ProjectCloneRecord>>;
  gateProcedures: readonly string[];
  defaultAllowedPathPrefixes: readonly string[];
}>;

type ParsedEditChanges =
  | { readonly ok: true; readonly changes: EditChanges }
  | { readonly ok: false; readonly error: string };

type ScalarStringEditField =
  | 'displayName'
  | 'repository'
  | 'designatedDispatcherHost'
  | 'policyRevision'
  | 'defaultBranch';

function applyStringEditFlags(
  flags: Readonly<Record<string, string | true>>,
  changes: EditChanges,
  specs: Readonly<Array<readonly [string, ScalarStringEditField]>>,
): void {
  for (const [flag, field] of specs) {
    if (flags[flag] !== undefined) {
      changes[field] = String(flags[flag]);
    }
  }
}

function parseEditChanges(
  flags: Readonly<Record<string, string | true>>,
): ParsedEditChanges {
  const changes: EditChanges = {};
  applyStringEditFlags(flags, changes, [
    ['display-name', 'displayName'],
    ['repository', 'repository'],
    ['dispatcher-host', 'designatedDispatcherHost'],
    ['policy-revision', 'policyRevision'],
  ]);
  if (flags['max-lanes'] !== undefined) {
    const maxLanes = parsePositiveInteger('max-lanes', String(flags['max-lanes']));
    if (maxLanes === null) {
      return { ok: false, error: `--max-lanes must be a positive integer, not '${String(flags['max-lanes'])}'` };
    }
    changes.maxConcurrentLanes = maxLanes;
  }
  applyStringEditFlags(flags, changes, [['default-branch', 'defaultBranch']]);
  if (flags.clones !== undefined) {
    const parsedClones = parseClones(String(flags.clones));
    if (!parsedClones.ok) {
      return { ok: false, error: parsedClones.error };
    }
    changes.clones = parsedClones.clones;
  }
  if (flags['gate-procedures'] !== undefined) {
    changes.gateProcedures = splitList(String(flags['gate-procedures']));
  }
  if (flags['allowed-prefixes'] !== undefined) {
    changes.defaultAllowedPathPrefixes = splitList(String(flags['allowed-prefixes']));
  }
  if (flags['runner-capabilities'] !== undefined) {
    const parsedCapabilities = parseRunnerCapabilities(String(flags['runner-capabilities']));
    if (!parsedCapabilities.ok) {
      return { ok: false, error: parsedCapabilities.error };
    }
    changes.runnerCapabilities = parsedCapabilities.capabilities;
  }
  if (Object.keys(changes).length === 0) {
    return { ok: false, error: `projects edit requires at least one field flag` };
  }
  return { ok: true, changes };
}

async function projectsEdit(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
): Promise<number> {
  const command = parseSingleProjectCommand(tokens, 'edit', io);
  if ('exit' in command) {
    return command.exit;
  }
  const { projectId, flags } = command;
  const parsed = parseEditChanges(flags);
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  const inspected = await runtime.coordination.inspectProjectProfile.inspectProjectProfile({
    projectId,
  });
  if (inspected.outcome === 'rejected') {
    io.stderr(`${inspected.reason}\n`);
    return 1;
  }
  if (inspected.outcome !== 'found') {
    io.stderr(`project ${projectId} is not registered\n`);
    return 1;
  }
  const profile = inspected.profile;
  for (const [field, next] of Object.entries(parsed.changes)) {
    io.stdout(`- ${field}: ${renderFieldValue(field, profile[field as keyof typeof profile])}\n`);
    io.stdout(`+ ${field}: ${renderFieldValue(field, next)}\n`);
  }
  if (flags.yes !== true) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`update project ${projectId}? [y/N]`))) {
      io.stdout('nothing changed\n');
      return 1;
    }
  }
  const result = await runtime.coordination.updateProjectProfile.updateProjectProfile({
    projectId,
    expectedRevision: profile.revision,
    changes: parsed.changes,
  });
  if (result.outcome === 'rejected') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  io.stdout(`updated project ${projectId} (rev ${result.profile.revision})\n`);
  return 0;
}

async function projectsRetire(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
): Promise<number> {
  const command = parseSingleProjectCommand(tokens, 'retire', io);
  if ('exit' in command) {
    return command.exit;
  }
  const { projectId, flags } = command;
  const inspected = await runtime.coordination.inspectProjectProfile.inspectProjectProfile({ projectId });
  if (inspected.outcome === 'rejected') {
    io.stderr(`${inspected.reason}\n`);
    return 1;
  }
  if (inspected.outcome !== 'found') {
    io.stderr(`project ${projectId} is not registered\n`);
    return 1;
  }
  const profile = inspected.profile;
  io.stdout(`retire project ${projectId} at rev ${profile.revision}\n`);
  if (flags.yes !== true) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`retire project ${projectId}? [y/N]`))) {
      io.stdout('nothing changed\n');
      return 1;
    }
  }
  const result = await runtime.coordination.retireProjectProfile.retireProjectProfile({
    projectId,
    expectedRevision: profile.revision,
  });
  if (result.outcome === 'rejected') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  io.stdout(`retired project ${projectId}\n`);
  return 0;
}

/** `fleet-v2 projects <subcommand>` dispatch. */
export async function projectsCommand(
  argv: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions = {},
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (isHelpToken(subcommand)) {
    io.stdout(`${PROJECTS_HELP}\n`);
    return 0;
  }
  switch (subcommand) {
    case 'list':
      return projectsList(argv.slice(1), io, runtime);
    case 'show':
      return projectsShow(argv.slice(1), io, runtime);
    case 'probe':
      return projectsProbe(argv.slice(1), io, runtime);
    case 'add':
      return projectsAdd(argv.slice(1), io, runtime, options);
    case 'adopt':
      return projectsAdopt(argv.slice(1), io, runtime, options);
    case 'edit':
      return projectsEdit(argv.slice(1), io, runtime, options);
    case 'retire':
      return projectsRetire(argv.slice(1), io, runtime, options);
    default:
      io.stderr(`Unknown projects subcommand: ${subcommand === '' ? '(none)' : subcommand}\n`);
      return 2;
  }
}
