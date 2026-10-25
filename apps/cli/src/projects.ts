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
in full, register a project, edit an active profile or retire it. Every
change is confirmed unless --yes is given; a declined confirmation prints
'nothing changed' and exits 1.

  list [--status active|retired] [--json]
                      print one line per profile, or the use-case result as
                      one JSON document with --json
  show <projectId> [--json]
                      print every profile field; clones and last probe checks
                      get their own lines
  add --project-id <id> --display-name <s> --repository <s>
      --dispatcher-host <h> --policy-revision <s> --max-lanes <n>
      [--default-branch <b>]
      [--clones h=/path:/worktreeRoot,...]
      [--gate-procedures a,b] [--allowed-prefixes x,y]
      [--runner-capabilities k=true,k2=false]
      [--yes]
                      register a new project profile (revision 0)
  edit <projectId> [same optional field flags as add except --project-id]
      [--yes]
                      change only the fields named on the command line, each
                      confirmed after its diff; lists/maps replace the whole
                      value
  retire <projectId> [--yes]
                      mark a project profile retired (history is kept)

Exit codes: 0 completed, 1 refused/rejected/not-found (or a declined
confirmation), 2 usage error.`;

type ProjectsSubcommand = 'list' | 'show' | 'add' | 'edit' | 'retire';

/** Which flags each subcommand accepts; anything else is a usage error. */
const SUBCOMMAND_FLAGS: Readonly<Record<ProjectsSubcommand, ReadonlySet<string>>> = {
  list: new Set(['status', 'json']),
  show: new Set(['json']),
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
    if (isHelpToken(token)) {
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
function requireProjectId(parsed: Extract<ParsedTokens, { ok: true }>, subcommand: ProjectsSubcommand): string {
  const id = parsed.positional[0] ?? '';
  if (id.trim() === '') {
    throw new Error(`projects ${subcommand} requires a project id`);
  }
  return id.trim();
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
    io.stdout(`  ${check.result}  ${check.name}  ${check.host ?? '-'}  ${check.detail}\n`);
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
  const parsed = parseProjectsTokens(tokens, 'show');
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.flags.help === true) {
    io.stdout(`${PROJECTS_HELP}\n`);
    return 0;
  }
  const unexpected = expectPositionals(parsed, 1, 'show');
  if (unexpected !== null) {
    io.stderr(`${unexpected}\n`);
    return 2;
  }
  const projectId = requireProjectId(parsed, 'show');
  const result = await runtime.coordination.inspectProjectProfile.inspectProjectProfile({ projectId });
  if (parsed.flags.json === true) {
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

/** The typed registration fields one add invocation parsed. */
interface AddArgs {
  readonly projectId: string;
  readonly displayName: string;
  readonly repository: string;
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
  const required: Readonly<Array<readonly [string, string]>> = [
    ['project-id', 'projectId'],
    ['display-name', 'displayName'],
    ['repository', 'repository'],
    ['dispatcher-host', 'designatedDispatcherHost'],
    ['policy-revision', 'policyRevision'],
    ['max-lanes', 'maxConcurrentLanes'],
  ];
  const values: Record<string, string> = {};
  for (const [flag, field] of required) {
    const value = parsed.flags[flag];
    if (typeof value !== 'string') {
      return { ok: false, error: `projects add requires --${flag}` };
    }
    values[field] = value;
  }
  const maxLanes = parsePositiveInteger('max-lanes', values['maxConcurrentLanes']);
  if (maxLanes === null) {
    return { ok: false, error: `--max-lanes must be a positive integer, not '${values['maxConcurrentLanes']}'` };
  }
  let clones: Readonly<Record<string, ProjectCloneRecord>> | undefined;
  if (parsed.flags.clones !== undefined) {
    const parsedClones = parseClones(String(parsed.flags.clones));
    if (!parsedClones.ok) {
      return { ok: false, error: parsedClones.error };
    }
    clones = parsedClones.clones;
  }
  let capabilities: Readonly<Record<string, boolean | string>> = {};
  if (parsed.flags['runner-capabilities'] !== undefined) {
    const parsedCapabilities = parseRunnerCapabilities(String(parsed.flags['runner-capabilities']));
    if (!parsedCapabilities.ok) {
      return { ok: false, error: parsedCapabilities.error };
    }
    capabilities = parsedCapabilities.capabilities;
  }
  const defaultBranch =
    typeof parsed.flags['default-branch'] === 'string' ? parsed.flags['default-branch'] : undefined;
  const gateProcedures =
    typeof parsed.flags['gate-procedures'] === 'string'
      ? splitList(parsed.flags['gate-procedures'])
      : undefined;
  const defaultAllowedPathPrefixes =
    typeof parsed.flags['allowed-prefixes'] === 'string'
      ? splitList(parsed.flags['allowed-prefixes'])
      : undefined;
  return {
    ok: true,
    args: {
      projectId: values.projectId,
      displayName: values.displayName,
      repository: values.repository,
      designatedDispatcherHost: values.designatedDispatcherHost,
      policyRevision: values.policyRevision,
      maxConcurrentLanes: maxLanes,
      runnerCapabilities: capabilities,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      ...(clones !== undefined ? { clones } : {}),
      ...(gateProcedures !== undefined ? { gateProcedures } : {}),
      ...(defaultAllowedPathPrefixes !== undefined ? { defaultAllowedPathPrefixes } : {}),
      yes: parsed.flags.yes === true,
    },
  };
}

/** Print the registration candidate: `register project <id>` then each field. */
function printRegisterCandidate(io: CliIo, args: AddArgs): void {
  io.stdout(`register project ${args.projectId}\n`);
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
  printRegisterCandidate(io, args);
  if (!args.yes) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`register project ${args.projectId}? [y/N]`))) {
      io.stdout('nothing changed\n');
      return 1;
    }
  }
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

type ParsedEdit =
  | { readonly ok: true; readonly projectId: string; readonly changes: EditChanges; readonly yes: boolean }
  | { readonly ok: false; readonly error: string };

function parseEditArgs(tokens: readonly string[]): ParsedEdit {
  const parsed = parseProjectsTokens(tokens, 'edit');
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.flags.help === true) {
    return { ok: false, error: '' };
  }
  const unexpected = expectPositionals(parsed, 1, 'edit');
  if (unexpected !== null) {
    return { ok: false, error: unexpected };
  }
  const projectId = requireProjectId(parsed, 'edit');
  const changes: EditChanges = {};
  if (parsed.flags['display-name'] !== undefined) {
    changes.displayName = String(parsed.flags['display-name']);
  }
  if (parsed.flags.repository !== undefined) {
    changes.repository = String(parsed.flags.repository);
  }
  if (parsed.flags['dispatcher-host'] !== undefined) {
    changes.designatedDispatcherHost = String(parsed.flags['dispatcher-host']);
  }
  if (parsed.flags['policy-revision'] !== undefined) {
    changes.policyRevision = String(parsed.flags['policy-revision']);
  }
  if (parsed.flags['max-lanes'] !== undefined) {
    const maxLanes = parsePositiveInteger('max-lanes', String(parsed.flags['max-lanes']));
    if (maxLanes === null) {
      return { ok: false, error: `--max-lanes must be a positive integer, not '${String(parsed.flags['max-lanes'])}'` };
    }
    changes.maxConcurrentLanes = maxLanes;
  }
  if (parsed.flags['default-branch'] !== undefined) {
    changes.defaultBranch = String(parsed.flags['default-branch']);
  }
  if (parsed.flags.clones !== undefined) {
    const parsedClones = parseClones(String(parsed.flags.clones));
    if (!parsedClones.ok) {
      return { ok: false, error: parsedClones.error };
    }
    changes.clones = parsedClones.clones;
  }
  if (parsed.flags['gate-procedures'] !== undefined) {
    changes.gateProcedures = splitList(String(parsed.flags['gate-procedures']));
  }
  if (parsed.flags['allowed-prefixes'] !== undefined) {
    changes.defaultAllowedPathPrefixes = splitList(String(parsed.flags['allowed-prefixes']));
  }
  if (parsed.flags['runner-capabilities'] !== undefined) {
    const parsedCapabilities = parseRunnerCapabilities(String(parsed.flags['runner-capabilities']));
    if (!parsedCapabilities.ok) {
      return { ok: false, error: parsedCapabilities.error };
    }
    changes.runnerCapabilities = parsedCapabilities.capabilities;
  }
  if (Object.keys(changes).length === 0) {
    return { ok: false, error: `projects edit requires at least one field flag` };
  }
  return { ok: true, projectId, changes, yes: parsed.flags.yes === true };
}

async function projectsEdit(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
): Promise<number> {
  const parsed = parseEditArgs(tokens);
  if (!parsed.ok) {
    if (parsed.error !== '') {
      io.stderr(`${parsed.error}\n`);
      return 2;
    }
    io.stdout(`${PROJECTS_HELP}\n`);
    return 0;
  }
  const inspected = await runtime.coordination.inspectProjectProfile.inspectProjectProfile({
    projectId: parsed.projectId,
  });
  if (inspected.outcome === 'rejected') {
    io.stderr(`${inspected.reason}\n`);
    return 1;
  }
  if (inspected.outcome !== 'found') {
    io.stderr(`project ${parsed.projectId} is not registered\n`);
    return 1;
  }
  const profile = inspected.profile;
  for (const [field, next] of Object.entries(parsed.changes)) {
    io.stdout(`- ${field}: ${renderFieldValue(field, profile[field as keyof typeof profile])}\n`);
    io.stdout(`+ ${field}: ${renderFieldValue(field, next)}\n`);
  }
  if (!parsed.yes) {
    const confirm = options.confirm ?? confirmFromStdin(io);
    if (!(await confirm(`update project ${parsed.projectId}? [y/N]`))) {
      io.stdout('nothing changed\n');
      return 1;
    }
  }
  const result = await runtime.coordination.updateProjectProfile.updateProjectProfile({
    projectId: parsed.projectId,
    expectedRevision: profile.revision,
    changes: parsed.changes,
  });
  if (result.outcome === 'rejected') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  io.stdout(`updated project ${parsed.projectId} (rev ${result.profile.revision})\n`);
  return 0;
}

async function projectsRetire(
  tokens: readonly string[],
  io: CliIo,
  runtime: FleetCliRuntime,
  options: ProjectsCliOptions,
): Promise<number> {
  const parsed = parseProjectsTokens(tokens, 'retire');
  if (!parsed.ok) {
    io.stderr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.flags.help === true) {
    io.stdout(`${PROJECTS_HELP}\n`);
    return 0;
  }
  const unexpected = expectPositionals(parsed, 1, 'retire');
  if (unexpected !== null) {
    io.stderr(`${unexpected}\n`);
    return 2;
  }
  const projectId = requireProjectId(parsed, 'retire');
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
  if (parsed.flags.yes !== true) {
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
    case 'add':
      return projectsAdd(argv.slice(1), io, runtime, options);
    case 'edit':
      return projectsEdit(argv.slice(1), io, runtime, options);
    case 'retire':
      return projectsRetire(argv.slice(1), io, runtime, options);
    default:
      io.stderr(`Unknown projects subcommand: ${subcommand === '' ? '(none)' : subcommand}\n`);
      return 2;
  }
}
