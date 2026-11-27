/**
 * The `plan` command group of the CLI driver (WB7a): import a plan sidecar,
 * check the markdown workbook against it, link a pull request to a lane,
 * declare a lane's step, record a brief-file read and list imported plans.
 * This module owns only argument handling, confirmation and output; every
 * rule about a plan comes from the work-execution use cases and stores.
 *
 * A declined confirmation prints `nothing changed` and exits 1. Usage errors
 * (unknown flag, missing flag, malformed tokens) write one line and exit 2.
 * Files are read locally only — a plan import never fetches from a forge (D10).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BOARD_DECLARATION_STEPS,
  PLAN_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  type LanePlanRecord,
  parseLanePlanSidecar,
} from '@fleet/work-execution';

import { confirmFromStdin } from './hosts.js';
import type { CliIo } from './index.js';
import type { FleetCliRuntime } from './composition.js';
import { CliUsageError } from './commands/payload.js';
import { comparePlanMarkdownToSidecar } from './plan-check.js';

/** Options the driver and tests inject; the default reads stdin like hosts. */
export interface PlanCliOptions {
  /**
   * The confirmation gate for a write. The default reads one line from stdin
   * and accepts only an explicit y/yes; a declined or closed stdin refuses.
   */
  readonly confirm?: (question: string) => Promise<boolean>;
}

const PLAN_HELP = `Usage: fleet-v2 plan <subcommand> [flags]

Work with the imported lane plans of one project. Every change is confirmed
unless --yes is given; a declined confirmation prints 'nothing changed' and
exits 1. Files are read locally; an import never fetches from a forge.

  import <file> --project <id> [--yes] [--json]
                      read one <plan>.workbook.json sidecar file, import it
                      and sync the plan's decision owner items
  check <sidecar> <markdown> [--json]
                      compare the markdown workbook table against the sidecar
                      and report drift; exit 1 when they differ
  link-pr <planId>/<laneId> <repository>#<number> --project <id> [--yes] [--json]
                      link one pull request to one lane
  declare <planId>/<laneId> --project <id> --step <step> --seat-role <role>
      --model <id> [--yes] [--json]
                      record a lane's step declaration (declared, not observed)
  brief-check <planId>/<laneId> --project <id> [--worktree <path>] [--yes] [--json]
                      read the lane's brief file and record its sha256 and
                      byte length; an unreadable brief is recorded as failed
  list [--project <id>] [--json]
                      print one line per imported plan

Exit codes: 0 completed, 1 refused/not found/drift (or a declined
confirmation), 2 usage error.`;

type PlanSubcommand = 'import' | 'check' | 'link-pr' | 'declare' | 'brief-check' | 'list';

/** Which flags each subcommand accepts; anything else is a usage error. */
const SUBCOMMAND_FLAGS: Readonly<Record<PlanSubcommand, ReadonlySet<string>>> = {
  import: new Set(['project', 'yes', 'json']),
  check: new Set(['json']),
  'link-pr': new Set(['project', 'yes', 'json']),
  declare: new Set(['project', 'step', 'seat-role', 'model', 'yes', 'json']),
  'brief-check': new Set(['project', 'worktree', 'yes', 'json']),
  list: new Set(['project', 'json']),
};

/** How many positional tokens each subcommand takes. */
const SUBCOMMAND_POSITIONALS: Readonly<Record<PlanSubcommand, number>> = {
  import: 1,
  check: 2,
  'link-pr': 2,
  declare: 1,
  'brief-check': 1,
  list: 0,
};

interface ParsedPlanTokens {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

function isHelpToken(token: string): boolean {
  return token === 'help' || token === '--help' || token === '-h';
}

/** Parse one invocation; every unknown flag or missing value is a usage error. */
function parsePlanTokens(tokens: readonly string[], subcommand: PlanSubcommand): ParsedPlanTokens {
  const allowed = SUBCOMMAND_FLAGS[subcommand];
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--') || token === '--') {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const flag = separator === -1 ? body : body.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
    if (!allowed.has(flag)) {
      throw new CliUsageError(`Unknown plan ${subcommand} option: --${flag}`);
    }
    if (flag === 'yes' || flag === 'json') {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`--${flag} takes no value`);
      }
      flags[flag] = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliUsageError(`--${flag} requires a value`);
      }
      value = next;
      index += 1;
    }
    if (value.trim() === '') {
      throw new CliUsageError(`--${flag} requires a value`);
    }
    flags[flag] = value;
  }
  const expected = SUBCOMMAND_POSITIONALS[subcommand];
  if (positionals.length !== expected) {
    throw new CliUsageError(`plan ${subcommand} takes ${expected} positional argument(s)`);
  }
  return { positionals, flags };
}

/** One `<planId>/<laneId>` token; ids never contain `/`, so it splits back exactly. */
function parsePlanLaneToken(token: string, subcommand: string): {
  readonly planId: string;
  readonly laneId: string;
} {
  const separator = token.indexOf('/');
  const planId = separator === -1 ? '' : token.slice(0, separator);
  const laneId = separator === -1 ? '' : token.slice(separator + 1);
  if (separator <= 0 || separator === token.length - 1) {
    throw new CliUsageError(`plan ${subcommand} requires <planId>/<laneId>, not '${token}'`);
  }
  if (!PLAN_ID_PATTERN.test(planId) || !PLANNED_LANE_ID_PATTERN.test(laneId)) {
    throw new CliUsageError(`plan ${subcommand} requires <planId>/<laneId>, not '${token}'`);
  }
  return { planId, laneId };
}

/** One `<owner/repo>#<number>` token with a positive pull-request number. */
function parseRepositoryNumberToken(token: string, subcommand: string): {
  readonly repository: string;
  readonly number: number;
} {
  const hash = token.indexOf('#');
  const repository = hash === -1 ? '' : token.slice(0, hash);
  const numberText = hash === -1 ? '' : token.slice(hash + 1);
  if (hash <= 0 || hash === token.length - 1 || !/^[^/\s#]+\/[^/\s#]+$/.test(repository) || !/^\d+$/.test(numberText)) {
    throw new CliUsageError(`plan ${subcommand} requires <repository>#<number>, not '${token}'`);
  }
  const number = Number(numberText);
  if (!Number.isInteger(number) || number < 1) {
    throw new CliUsageError(`plan ${subcommand} requires a positive pull-request number, not '${token}'`);
  }
  return { repository, number };
}

/** The confirmation gate; `--yes` skips it. */
async function confirmWrite(
  io: CliIo,
  options: PlanCliOptions,
  question: string,
): Promise<boolean> {
  const confirm = options.confirm ?? confirmFromStdin(io);
  return confirm(question);
}

function declined(io: CliIo): number {
  io.stderr('nothing changed\n');
  return 1;
}

/**
 * Read a local file, or null when it cannot be read; the error names the
 * file, never its contents. An unreadable file is a refusal (exit 1), not a
 * usage error.
 */
function readLocalFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** `plan import` / `plan check` opening: read the file or report and exit 1. */
function readLocalFile(filePath: string, io: CliIo): string | null {
  const content = readLocalFileOrNull(filePath);
  if (content === null) {
    io.stderr(`cannot read '${filePath}'\n`);
    return null;
  }
  return content;
}

/** `plan import <file> --project <id> [--yes] [--json]`. */
async function planImport(
  tokens: readonly string[],
  io: CliIo,
  rt: FleetCliRuntime,
  options: PlanCliOptions,
): Promise<number> {
  const parsed = parsePlanTokens(tokens, 'import');
  const projectId = typeof parsed.flags['project'] === 'string' ? parsed.flags['project'] : '';
  if (projectId === '') {
    throw new CliUsageError('plan import requires --project <id>');
  }
  const file = parsed.positionals[0];
  const content = readLocalFile(file, io);
  if (content === null) {
    return 1;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    io.stderr(`plan import: '${file}' is not valid JSON\n`);
    return 1;
  }
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    io.stderr(`plan import: '${file}' must hold one JSON object\n`);
    return 1;
  }
  const sidecarResult = parseLanePlanSidecar(parsedJson);
  if (!sidecarResult.ok) {
    // The sidecar is machine input; its errors are not operator wording.
    io.stderr(`plan import: '${file}' is not a valid plan sidecar\n`);
    return 1;
  }
  const sidecar = sidecarResult.sidecar;
  let previousDecisionIds: readonly string[] | null = null;
  try {
    const previous = await rt.execution.lanePlanRepository.findLanePlan(projectId, sidecar.planId);
    if (previous !== null) {
      previousDecisionIds = previous.decisions.map((decision) => decision.id);
    }
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (
    parsed.flags['yes'] !== true &&
    !(await confirmWrite(
      io,
      options,
      `Import plan ${sidecar.planId} revision ${String(sidecar.revision)} into project ${projectId}? [y/N] `,
    ))
  ) {
    return declined(io);
  }
  const result = await rt.execution.importLanePlan.importLanePlan({
    sidecar: parsedJson,
    requestedProjectId: projectId,
  });
  if (result.outcome === 'refused') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  const sync = await rt.execution.syncPlanDecisions.execute({
    projectId,
    planId: result.plan.planId,
    previousDecisionIds,
  });
  if (parsed.flags['json'] === true) {
    io.stdout(`${JSON.stringify({ import: result, sync })}\n`);
  } else {
    io.stdout(
      `${result.outcome === 'imported' ? 'imported' : 'unchanged'} plan ${result.plan.planId} revision ${String(result.plan.revision)}\n`,
    );
    const synced = sync.decisions.filter((decision) => decision.outcome !== 'refused').length;
    io.stdout(`synced ${String(synced)} of ${String(sync.decisions.length)} decision items (${sync.outcome})\n`);
  }
  if (sync.outcome !== 'synced') {
    return 1;
  }
  return 0;
}

/** `plan check <sidecar> <markdown> [--json]`. */
function planCheck(tokens: readonly string[], io: CliIo): number {
  const parsed = parsePlanTokens(tokens, 'check');
  const sidecarFile = parsed.positionals[0];
  const markdownFile = parsed.positionals[1];
  const content = readLocalFile(sidecarFile, io);
  if (content === null) {
    return 1;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    io.stderr(`plan check: '${sidecarFile}' is not valid JSON\n`);
    return 1;
  }
  const sidecarResult = parseLanePlanSidecar(parsedJson);
  if (!sidecarResult.ok) {
    return 1;
  }
  const markdown = readLocalFile(markdownFile, io);
  if (markdown === null) {
    return 1;
  }
  const comparison = comparePlanMarkdownToSidecar(sidecarResult.sidecar, markdown);
  if (comparison.outcome === 'in-sync') {
    if (parsed.flags['json'] === true) {
      io.stdout(`${JSON.stringify(comparison)}\n`);
    } else {
      io.stdout('plan in sync\n');
    }
    return 0;
  }
  if (parsed.flags['json'] === true) {
    io.stdout(`${JSON.stringify(comparison)}\n`);
  } else {
    for (const drift of comparison.drifts) {
      io.stdout(`drift ${drift.kind} ${drift.laneId}: ${drift.detail}\n`);
    }
  }
  return 1;
}

/** `plan link-pr <planId>/<laneId> <repository>#<number> --project <id> [--yes] [--json]`. */
async function planLinkPr(
  tokens: readonly string[],
  io: CliIo,
  rt: FleetCliRuntime,
  options: PlanCliOptions,
): Promise<number> {
  const parsed = parsePlanTokens(tokens, 'link-pr');
  const projectId = typeof parsed.flags['project'] === 'string' ? parsed.flags['project'] : '';
  if (projectId === '') {
    throw new CliUsageError('plan link-pr requires --project <id>');
  }
  const { planId, laneId } = parsePlanLaneToken(parsed.positionals[0], 'link-pr');
  const { repository, number } = parseRepositoryNumberToken(parsed.positionals[1], 'link-pr');
  if (
    parsed.flags['yes'] !== true &&
    !(await confirmWrite(
      io,
      options,
      `Link ${repository}#${String(number)} to lane ${planId}/${laneId} in project ${projectId}? [y/N] `,
    ))
  ) {
    return declined(io);
  }
  const result = await rt.execution.linkPullRequest.linkPullRequest({
    repository,
    number,
    projectId,
    planId,
    laneId,
    source: 'cli',
  });
  if (result.outcome === 'refused') {
    io.stderr(`${result.reason}\n`);
    return 1;
  }
  if (parsed.flags['json'] === true) {
    io.stdout(`${JSON.stringify(result)}\n`);
  } else {
    io.stdout(`${result.outcome} ${repository}#${String(number)} on lane ${planId}/${laneId}\n`);
  }
  return 0;
}

/** `plan declare <planId>/<laneId> --project <id> --step <step> --seat-role <role> --model <id> [--yes] [--json]`. */
async function planDeclare(
  tokens: readonly string[],
  io: CliIo,
  rt: FleetCliRuntime,
  options: PlanCliOptions,
): Promise<number> {
  const parsed = parsePlanTokens(tokens, 'declare');
  const projectId = typeof parsed.flags['project'] === 'string' ? parsed.flags['project'] : '';
  if (projectId === '') {
    throw new CliUsageError('plan declare requires --project <id>');
  }
  const step = typeof parsed.flags['step'] === 'string' ? parsed.flags['step'] : '';
  if (!(BOARD_DECLARATION_STEPS as readonly string[]).includes(step)) {
    throw new CliUsageError(`'--step' must be one of: ${BOARD_DECLARATION_STEPS.join(', ')}`);
  }
  const seatRole = typeof parsed.flags['seat-role'] === 'string' ? parsed.flags['seat-role'] : '';
  if (seatRole === '') {
    throw new CliUsageError('plan declare requires --seat-role <role>');
  }
  const model = typeof parsed.flags['model'] === 'string' ? parsed.flags['model'] : '';
  if (model === '') {
    throw new CliUsageError('plan declare requires --model <id>');
  }
  const { planId, laneId } = parsePlanLaneToken(parsed.positionals[0], 'declare');
  if (
    parsed.flags['yes'] !== true &&
    !(await confirmWrite(
      io,
      options,
      `Declare step ${step} for lane ${planId}/${laneId} in project ${projectId}? [y/N] `,
    ))
  ) {
    return declined(io);
  }
  const result = await rt.execution.declareLaneActivity.execute(
    {
      lane: { kind: 'plan', projectId, planId, laneId },
      step: step as (typeof BOARD_DECLARATION_STEPS)[number],
      seatRole,
      model,
    },
    'cli',
  );
  if (result.outcome !== 'declared') {
    io.stderr(`${'reason' in result ? result.reason : 'the declaration was refused'}\n`);
    return 1;
  }
  if (parsed.flags['json'] === true) {
    io.stdout(`${JSON.stringify(result)}\n`);
  } else {
    io.stdout(`declared ${step} on lane ${planId}/${laneId}, lapses at ${result.lapsesAtIso}\n`);
  }
  return 0;
}

/** `plan brief-check <planId>/<laneId> --project <id> [--worktree <path>] [--yes] [--json]`. */
async function planBriefCheck(
  tokens: readonly string[],
  io: CliIo,
  rt: FleetCliRuntime,
  options: PlanCliOptions,
): Promise<number> {
  const parsed = parsePlanTokens(tokens, 'brief-check');
  const projectId = typeof parsed.flags['project'] === 'string' ? parsed.flags['project'] : '';
  if (projectId === '') {
    throw new CliUsageError('plan brief-check requires --project <id>');
  }
  const { planId, laneId } = parsePlanLaneToken(parsed.positionals[0], 'brief-check');
  let plan: LanePlanRecord | null = null;
  try {
    plan = await rt.execution.lanePlanRepository.findLanePlan(projectId, planId);
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const lane = plan?.lanes.find((entry) => entry.laneId === laneId) ?? null;
  if (plan === null || lane === null || lane.brief === null) {
    io.stderr(`plan brief-check: lane ${planId}/${laneId} was not found in project ${projectId} or has no brief\n`);
    return 1;
  }
  const worktree = typeof parsed.flags['worktree'] === 'string' ? parsed.flags['worktree'] : '.';
  const briefPath = resolve(worktree, lane.brief);
  if (
    parsed.flags['yes'] !== true &&
    !(await confirmWrite(
      io,
      options,
      `Record the brief read of lane ${planId}/${laneId} (file ${lane.brief})? [y/N] `,
    ))
  ) {
    return declined(io);
  }
  const record = (outcome: 'read' | 'failed', sha256: string | null, bytes: number | null) =>
    rt.execution.recordBriefRead.execute(
      {
        lane: { kind: 'plan', projectId, planId, laneId },
        path: lane.brief as string,
        outcome,
        sha256,
        bytes,
      },
      'cli',
    );
  let briefBytes: Buffer;
  try {
    briefBytes = readFileSync(briefPath);
  } catch {
    const result = await record('failed', null, null);
    if (result.outcome !== 'recorded') {
      io.stderr(`${'reason' in result ? result.reason : 'the brief read could not be recorded'}\n`);
      return 1;
    }
    io.stderr(`plan brief-check: the brief file '${briefPath}' could not be read and was recorded as failed\n`);
    return 1;
  }
  const sha256 = createHash('sha256').update(briefBytes).digest('hex');
  const result = await record('read', sha256, briefBytes.byteLength);
  if (result.outcome !== 'recorded') {
    io.stderr(`${'reason' in result ? result.reason : 'the brief read could not be recorded'}\n`);
    return 1;
  }
  if (parsed.flags['json'] === true) {
    io.stdout(`${JSON.stringify(result)}\n`);
  } else {
    io.stdout(`brief read of lane ${planId}/${laneId}: ${sha256} ${String(briefBytes.byteLength)} bytes\n`);
  }
  return 0;
}

/** `plan list [--project <id>] [--json]`. */
async function planList(tokens: readonly string[], io: CliIo, rt: FleetCliRuntime): Promise<number> {
  const parsed = parsePlanTokens(tokens, 'list');
  const projectId = typeof parsed.flags['project'] === 'string' ? parsed.flags['project'] : undefined;
  const records = await rt.execution.lanePlanRepository.listLanePlans(projectId);
  if (parsed.flags['json'] === true) {
    io.stdout(
      `${JSON.stringify(
        records.map((record) => ({
          projectId: record.projectId,
          planId: record.planId,
          revision: record.revision,
          lanes: record.lanes.length,
          decisions: record.decisions.length,
        })),
      )}\n`,
    );
    return 0;
  }
  for (const record of records) {
    io.stdout(
      `${record.projectId} ${record.planId} revision ${String(record.revision)} lanes ${String(record.lanes.length)} decisions ${String(record.decisions.length)}\n`,
    );
  }
  return 0;
}

/**
 * Print the plan help and return 0 when the line asks for help (`help`,
 * `--help`, `-h`, as the subcommand or anywhere after it); otherwise
 * undefined. Needs no runtime, so `runCli` can answer it before composing one.
 */
export function planHelpOnly(argv: readonly string[], io: CliIo): number | undefined {
  const subcommand = argv[0] ?? '';
  if (
    isHelpToken(subcommand) ||
    argv.slice(1).some((token) => token === '--help' || token === '-h' || token === 'help')
  ) {
    io.stdout(`${PLAN_HELP}\n`);
    return 0;
  }
  return undefined;
}

/** `fleet-v2 plan <subcommand>` dispatch. */
export async function planCommand(
  argv: readonly string[],
  io: CliIo,
  rt: FleetCliRuntime,
  options: PlanCliOptions = {},
): Promise<number> {
  const helpExit = planHelpOnly(argv, io);
  if (helpExit !== undefined) {
    return helpExit;
  }
  const subcommand = argv[0] ?? '';
  const rest = argv.slice(1);
  try {
    switch (subcommand) {
      case 'import':
        return await planImport(rest, io, rt, options);
      case 'check':
        return planCheck(rest, io);
      case 'link-pr':
        return await planLinkPr(rest, io, rt, options);
      case 'declare':
        return await planDeclare(rest, io, rt, options);
      case 'brief-check':
        return await planBriefCheck(rest, io, rt, options);
      case 'list':
        return await planList(rest, io, rt);
      default:
        io.stderr(
          `Unknown plan subcommand: ${subcommand === '' ? '(none)' : subcommand}\nRun 'fleet-v2 plan --help'.\n`,
        );
        return 2;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
