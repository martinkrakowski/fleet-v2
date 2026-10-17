/**
 * Fleet CLI driver: the operator-facing application boundary across the four
 * bounded contexts. Subcommands map one JSON payload (or `--kebab-case` flags)
 * onto one application port call and print the typed result to stdout as one
 * JSON document.
 *
 * Exit codes: 0 for completed operations, 1 for refusal-family results and
 * unexpected errors, 2 for usage errors. All I/O goes through the injected
 * `CliIo`, so package code never touches `console`.
 */

import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import type {
  AttemptSeatOverrideRecord,
  BriefContextDecision,
  BriefModelAssignment,
  CommandCompletionReceipt,
} from '@fleet/work-execution';
import { resolveImplementerSeat } from '@fleet/work-execution/use-cases';
import type {
  FindingDispositionRecord,
  ReviewReceiptRecord,
  VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import {
  KNOWLEDGE_DISPOSITIONS,
  KNOWLEDGE_REUSE_OUTCOMES,
  type RecordContextSelectionItem,
} from '@fleet/brief-knowledge';
import { COORDINATION_KINDS } from '@fleet/operator-coordination';
import type {
  AnswerOwnerQuestionRequest,
  AskOwnerQuestionRequest,
  ListOwnerQuestionsRequest,
  OwnerQuestionState,
} from '@fleet/operator-coordination';

import { loadInstallation, type LoadResult } from '@fleet/installation';
import type {
  DoctorLine,
  DoctorProbes,
} from '@fleet/onboarding';
import {
  createNodeDoctorProbes,
  doctorExitCode,
  runDoctor,
} from '@fleet/onboarding';

import {
  assessmentIdForAttempt,
  createFleetCliRuntime,
  forgeActionScope,
  resolveRunnerSettings,
  type FleetCliRuntime,
} from './composition.js';

export { resolveRunnerSettings };

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Default process-stream I/O; used by `main` and any caller omitting `io`. */
const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Signalled for argument-shape problems; reported as exit code 2. */
class CliUsageError extends Error {}

type Payload = Record<string, unknown>;

type CommandHandler = (payload: Payload, runtime: FleetCliRuntime) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Payload coercion helpers. Values arrive from `--json` (typed JSON) or from
// flags (strings); every helper normalizes without inventing data.
// ---------------------------------------------------------------------------

function str(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function optStr(payload: Payload, key: string): string | undefined {
  const value = str(payload, key);
  return value.trim() === '' ? undefined : value;
}

function strOrNull(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function num(payload: Payload, key: string, fallback: number): number {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optNum(payload: Payload, key: string): number | undefined {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strArr(payload: Payload, key: string): string[] {
  const value = payload[key];
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return [];
}

/**
 * Pass one nested JSON object through to a typed request field. The receiving
 * use case validates the record; the driver only guarantees it is an object.
 */
function nested<T>(payload: Payload, key: string): T | undefined {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as T)
    : undefined;
}

/** A nested JSON object the request shape requires; a usage error when absent. */
function requiredNested<T>(payload: Payload, key: string, label: string): T {
  const value = nested<T>(payload, key);
  if (value === undefined) {
    throw new CliUsageError(`${label} requires a JSON object in '--${key}'`);
  }
  return value;
}

/** A closed enum value the request shape requires; a usage error when absent. */
function enumOf<T extends string>(payload: Payload, key: string, allowed: readonly T[], label: string): T {
  const value = str(payload, key);
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new CliUsageError(`${label} must be one of: ${allowed.join(', ')}`);
}

function nestedArr<T>(payload: Payload, key: string): T[] | undefined {
  const value = payload[key];
  return Array.isArray(value) ? (value as T[]) : undefined;
}

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Options for `parseFlags`; only the `questions` id subcommands opt in today. */
interface ParseFlagsOptions {
  /**
   * Collect bare positional tokens (the question id) under the `positional`
   * key instead of refusing them; handlers that read `positional` validate it.
   */
  readonly allowPositional?: boolean;
}

/**
 * Parse remaining tokens into a payload: flags first, `--json` overlay last.
 * Bare positional tokens are a usage error unless `allowPositional` is set,
 * so a mistyped argument never silently disappears.
 */
function parseFlags(tokens: readonly string[], options?: ParseFlagsOptions): Payload {
  const payload: Payload = {};
  const positionals: string[] = [];
  let jsonPayload: Payload | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      const raw = tokens[index + 1];
      if (raw === undefined) {
        throw new CliUsageError('--json requires a JSON payload argument');
      }
      index += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new CliUsageError(
          `--json payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CliUsageError('--json payload must be a JSON object');
      }
      jsonPayload = parsed as Payload;
      continue;
    }
    if (!token.startsWith('--') || token === '--') {
      if (options?.allowPositional === true) {
        positionals.push(token);
        continue;
      }
      throw new CliUsageError(`Unexpected argument: ${token}`);
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const key = kebabToCamel(separator === -1 ? body : body.slice(0, separator));
    if (separator !== -1) {
      payload[key] = body.slice(separator + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      payload[key] = true;
      continue;
    }
    payload[key] = next;
    index += 1;
  }
  if (jsonPayload !== undefined) {
    Object.assign(payload, jsonPayload);
  }
  if (positionals.length > 0) {
    payload['positional'] = positionals;
  }
  return payload;
}

/**
 * Strip the global `--state-dir <path>` / `--state-dir=<path>` option from any
 * position so it never reaches group dispatch or `parseFlags`, falling back to
 * the `FLEET_STATE_DIR` environment value when the flag is omitted. Valid
 * paths are normalized with `path.resolve`; a missing, empty or malformed
 * value is a usage error.
 */
export function extractStateDirOption(
  argv: readonly string[],
  envStateDir?: string,
): { readonly stateDir?: string; readonly restArgv: readonly string[] } {
  let stateDir: string | undefined;
  const restArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--state-dir') {
      const value = argv[index + 1];
      index += 1;
      if (
        value === undefined ||
        value.trim() === '' ||
        value.startsWith('--') ||
        value.includes('\0')
      ) {
        throw new CliUsageError('Invalid --state-dir value');
      }
      stateDir = resolve(value);
      continue;
    }
    if (token.startsWith('--state-dir=')) {
      const value = token.slice('--state-dir='.length);
      if (value.trim() === '' || value.startsWith('--') || value.includes('\0')) {
        throw new CliUsageError('Invalid --state-dir value');
      }
      stateDir = resolve(value);
      continue;
    }
    restArgv.push(token);
  }
  if (stateDir === undefined) {
    const fromEnv = envStateDir?.trim();
    if (fromEnv !== undefined && fromEnv !== '') {
      stateDir = resolve(fromEnv);
    }
  }
  return { stateDir, restArgv };
}

/** Result outcomes that report a refusal, gap or unknown and exit non-zero. */
const NON_ZERO_OUTCOMES: ReadonlySet<string> = new Set([
  'rejected',
  'refused',
  'blocked',
  'not-found',
  'unavailable',
  'delivery-gap',
  'delivery-failed',
  'stale',
  'no-free-slot',
  'busy-worktree',
  'still-running',
  'unknown',
]);

function exitCodeForResult(result: unknown, group?: string, subcommand?: string): number {
  if (typeof result === 'object' && result !== null && 'outcome' in result) {
    const outcome = (result as { outcome: unknown }).outcome;
    if (typeof outcome === 'string') {
      // `questions wait` reports the settled lifecycle state itself: answered
      // and acknowledged complete the wait, while rejected, expired and
      // timeout are refusal-family exits with the state named in the body.
      if (group === 'questions' && subcommand === 'wait') {
        return outcome === 'answered' || outcome === 'acknowledged' ? 0 : 1;
      }
      if (NON_ZERO_OUTCOMES.has(outcome)) return 1;
    }
  }
  return 0;
}

/**
 * Bind an independent review request to the implementer seat the attempt
 * actually ran on. Independence is a fact about the lane, so the operator
 * never supplies it: the attempt's recorded seat is read back, and a supplied
 * `implementerModel` is accepted only when it restates that seat. An attempt
 * with no recorded seat is a typed rejection, not an assumed model.
 */
async function bindImplementerSeat(
  runtime: FleetCliRuntime,
  payload: Payload,
): Promise<
  | { readonly bound: true; readonly implementerModel: string }
  | { readonly bound: false; readonly rejection: { outcome: 'rejected'; reason: string } }
> {
  const attemptId = str(payload, 'attemptId');
  const attempt = await runtime.execution.attemptRepository.findAttemptById(attemptId);
  if (attempt === null) {
    return {
      bound: false,
      rejection: { outcome: 'rejected', reason: `Attempt not found: '${attemptId}'` },
    };
  }
  const seat = await resolveImplementerSeat(attempt, {
    artifactPort: runtime.execution.attemptArtifact,
  });
  if (seat.outcome === 'unknown') {
    return { bound: false, rejection: { outcome: 'rejected', reason: seat.reason } };
  }
  const supplied = optStr(payload, 'implementerModel');
  if (supplied !== undefined && supplied.trim() !== seat.model) {
    throw new CliUsageError(
      `evidence request-review refuses implementerModel '${supplied.trim()}': attempt '${attemptId}' was dispatched on seat '${seat.model}'`,
    );
  }
  return { bound: true, implementerModel: seat.model };
}

// ---------------------------------------------------------------------------
// `questions` helpers. The group takes the question id as a positional
// argument and reads the ask payload from a file, so it carries a few small
// boundary helpers; every domain rule stays in the use cases.
// ---------------------------------------------------------------------------

const OWNER_QUESTION_STATES: readonly OwnerQuestionState[] = [
  'open',
  'answered',
  'rejected',
  'expired',
  'acknowledged',
];

/**
 * The lifecycle states that settle a `questions wait` poll. `open` keeps the
 * poll running; every other state ends it with the wait exit code.
 */
const TERMINAL_WAIT_STATES: readonly OwnerQuestionState[] = [
  'answered',
  'acknowledged',
  'rejected',
  'expired',
];

/** An ISO timestamp with an explicit zone, as `questions list --since` requires. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const DEFAULT_WAIT_MAX_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_INTERVAL_MS = 15 * 1000;

/** `questions` subcommands whose first bare argument is the question id. */
const QUESTIONS_POSITIONAL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'show',
  'answer',
  'acknowledge',
  'wait',
]);

/** The positional question id a `questions` subcommand requires. */
function questionIdPositional(payload: Payload, subcommand: string): string {
  const positionals = payload['positional'];
  const first = Array.isArray(positionals) ? positionals[0] : undefined;
  const id = typeof first === 'string' ? first.trim() : '';
  if (id === '') {
    throw new CliUsageError(`questions ${subcommand} requires a question id: fleet-v2 questions ${subcommand} <id>`);
  }
  return id;
}

/**
 * Read and parse the JSON question record handed to `questions ask --file`.
 * The driver only guarantees one readable JSON object; the ask use case owns
 * every domain rule about the record's contents.
 */
function readQuestionFile(filePath: string): AskOwnerQuestionRequest {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CliUsageError(
      `questions ask cannot read '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CliUsageError(
      `questions ask file '${filePath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`questions ask file '${filePath}' must hold one JSON object`);
  }
  return parsed as AskOwnerQuestionRequest;
}

/**
 * Parse a duration flag like `30m`, `15s`, `500ms` or `2h`. A bare number is
 * refused so the unit is always explicit; the subcommand default applies when
 * the flag is absent.
 */
function parseDurationOption(payload: Payload, key: string, fallbackMs: number): number {
  const raw = optStr(payload, key);
  if (raw === undefined) return fallbackMs;
  const match = /^(\d+)(ms|s|m|h)$/.exec(raw);
  if (match === null) {
    throw new CliUsageError(
      `'--${key}' must be a duration with a unit of ms, s, m or h (e.g. 30m), not '${raw}'`,
    );
  }
  const unitMs = match[2] === 'ms' ? 1 : match[2] === 's' ? 1000 : match[2] === 'm' ? 60_000 : 3_600_000;
  return Number(match[1]) * unitMs;
}

/** Sleep for one poll interval; the only timer the CLI driver creates itself. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Command table. Each handler builds one typed request from the payload; the
// use case owns every behavioural decision.
// ---------------------------------------------------------------------------

const COMMANDS: Readonly<Record<string, Readonly<Record<string, CommandHandler>>>> = {
  'work-order': {
    register: async (p, rt) =>
      rt.execution.registerWorkOrder.registerWorkOrder({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        ownedPaths: strArr(p, 'ownedPaths'),
        policyRevision: str(p, 'policyRevision'),
        prerequisiteWorkOrderIds: strArr(p, 'prerequisiteWorkOrderIds'),
        nowIso: optStr(p, 'nowIso'),
      }),
    inspect: async (p, rt) =>
      rt.execution.inspectWorkOrder.inspectWorkOrder({ workOrderId: str(p, 'workOrderId') }),
  },
  brief: {
    prepare: async (p, rt) => {
      const contextDecisions = nestedArr<BriefContextDecision>(p, 'contextDecisions') ?? [];
      for (const decision of contextDecisions) {
        if (
          !decision ||
          typeof decision !== 'object' ||
          typeof decision.decisionBecause !== 'string' ||
          decision.decisionBecause.trim() === ''
        ) {
          throw new CliUsageError(
            "brief prepare contextDecisions requires a non-empty 'decisionBecause' for each item",
          );
        }
      }
      return rt.execution.prepareBriefPackage.prepareBriefPackage({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        policyRevision: str(p, 'policyRevision'),
        modelAssignment:
          nested<BriefModelAssignment>(p, 'modelAssignment') ?? {
            model: str(p, 'model'),
            variant: str(p, 'variant') || 'default',
            fallbackModel: str(p, 'fallbackModel'),
          },
        independentReviewer: str(p, 'independentReviewer'),
        ownedPaths: strArr(p, 'ownedPaths'),
        permissions: strArr(p, 'permissions'),
        acceptanceChecks: strArr(p, 'acceptanceChecks'),
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        resourceBounds: nested<Record<string, string>>(p, 'resourceBounds') ?? {},
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        ownerDecisionReferences: strArr(p, 'ownerDecisionReferences'),
        contextDecisions,
        attemptId: optStr(p, 'attemptId'),
        worktreePath: optStr(p, 'worktreePath'),
        handWrittenBriefPath: strOrNull(p, 'handWrittenBriefPath'),
      });
    },
  },
  capacity: {
    reserve: async (p, rt) => {
      // The runner's installation entry feeds capacity maxSlots (plan item 4):
      // a declared maxLanes is the host budget, and a conflicting operator
      // value is a usage error rather than a silent override.
      const declaredMaxLanes = rt.execution.runnerMaxLanes;
      if (declaredMaxLanes !== undefined && p['maxSlots'] !== undefined) {
        const supplied = num(p, 'maxSlots', declaredMaxLanes);
        if (supplied !== declaredMaxLanes) {
          throw new CliUsageError(
            `'--maxSlots ${supplied}' conflicts with the runner's declared maxLanes ${declaredMaxLanes}; the installation feeds capacity maxSlots`,
          );
        }
      }
      return rt.execution.reserveExecutionCapacity.reserveExecutionCapacity({
        reservationId: str(p, 'reservationId'),
        attemptId: str(p, 'attemptId'),
        workOrderId: str(p, 'workOrderId'),
        hostId: str(p, 'hostId'),
        worktreePath: str(p, 'worktreePath'),
        maxSlots: declaredMaxLanes ?? num(p, 'maxSlots', 1),
        nowIso: optStr(p, 'nowIso'),
      });
    },
  },
  attempt: {
    dispatch: async (p, rt) => {
      for (const field of [
        'model',
        'agent',
        'variant',
        'modelAssignment',
        'runnerPort',
        'remotePort',
        'runnerHost',
        'host',
      ]) {
        if (p[field] !== undefined) {
          throw new CliUsageError(
            `'${field}' is forbidden and must not be specified; the seat is determined by the frozen brief manifest`,
          );
        }
      }
      // D4: the CLI no longer accepts runner capability overrides —
      // requirements come from the brief only, so a supplied one is a usage
      // error (exit 2), never a weaker or stronger dispatch profile.
      if (p['requiredCapabilities'] !== undefined) {
        throw new CliUsageError(
          "'--requiredCapabilities' is forbidden; runner requirements come from the brief only",
        );
      }

      const attemptId = str(p, 'attemptId');
      const existing = await rt.execution.attemptRepository.findAttemptById(attemptId);
      const worktreePath = str(p, 'worktreePath');

      // Seat override from --seat-override and --override-reason
      let seatOverride = nested<AttemptSeatOverrideRecord>(p, 'seatOverride');
      const seatOverrideStr = optStr(p, 'seatOverride');
      if (!seatOverride && seatOverrideStr) {
        const colonIndex = seatOverrideStr.lastIndexOf(':');
        let model = seatOverrideStr;
        let variant: string | undefined;
        if (colonIndex !== -1 && colonIndex > seatOverrideStr.indexOf('/')) {
          model = seatOverrideStr.slice(0, colonIndex);
          variant = seatOverrideStr.slice(colonIndex + 1);
        }
        const reason = str(p, 'overrideReason');
        const setBy = str(p, 'overrideSetBy') || process.env.USER || 'operator';
        const expiresAtIso =
          optStr(p, 'overrideExpiresAt') ?? optStr(p, 'overrideExpiresAtIso') ?? '';
        const agent = optStr(p, 'overrideAgent');
        seatOverride = {
          model,
          ...(variant ? { variant } : {}),
          ...(agent ? { agent } : {}),
          reason,
          setBy,
          expiresAtIso,
        };
      } else if (seatOverride && !seatOverride.reason && optStr(p, 'overrideReason')) {
        seatOverride = { ...seatOverride, reason: str(p, 'overrideReason') };
      }

      const reviewerSeat =
        optStr(p, 'reviewerSeat') ??
        optStr(p, 'reviewerModel') ??
        existing?.reviewerSeat ??
        undefined;

      const briefPackagePath =
        str(p, 'briefPackagePath') ||
        (worktreePath === '' ? '' : join(worktreePath, '.lane', 'brief.md'));

      return rt.execution.dispatchAttempt.dispatchAttempt({
        attemptId,
        workOrderId: str(p, 'workOrderId') || existing?.workOrderId || '',
        worktreePath,
        briefPackagePath,
        briefDigest: str(p, 'briefDigest') || existing?.briefDigest || '',
        baseCommit: str(p, 'baseCommit') || existing?.baseCommit || '',
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        nowIso: optStr(p, 'nowIso'),
        seatOverride,
        reviewerSeat,
      });
    },
    reconcile: async (p, rt) =>
      rt.execution.reconcileAttempt.reconcileAttempt({
        attemptId: str(p, 'attemptId'),
        nowIso: optStr(p, 'nowIso'),
      }),
    stop: async (p, rt) =>
      rt.execution.stopAttempt.stopAttempt({
        attemptId: str(p, 'attemptId'),
        gracePeriodSeconds: optNum(p, 'gracePeriodSeconds'),
        nowIso: optStr(p, 'nowIso'),
      }),
    collect: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      if (attempt === null) {
        return { outcome: 'refused', reason: `Attempt not found: ${attemptId}` };
      }
      const receipt =
        nested<CommandCompletionReceipt>(p, 'completionReceipt') ?? attempt.completionReceipt;
      if (receipt === null || receipt === undefined) {
        return {
          outcome: 'refused',
          reason: 'Attempt has no recorded completion receipt; reconcile it first',
        };
      }
      return rt.execution.collectAttemptArtifacts.collectAttemptArtifacts({
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt.workOrderId,
        worktreePath: str(p, 'worktreePath') || attempt.worktreePath,
        baseCommit: str(p, 'baseCommit') || attempt.baseCommit,
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        completionReceipt: receipt,
      });
    },
    fix: async (p, rt) =>
      rt.execution.prepareFixAttempt.prepareFixAttempt({
        fixAttemptId: str(p, 'fixAttemptId'),
        workOrderId: str(p, 'workOrderId'),
        priorAttemptId: str(p, 'priorAttemptId'),
        worktreePath: str(p, 'worktreePath'),
        baseCommit: str(p, 'baseCommit'),
        numberedFixes: strArr(p, 'numberedFixes'),
        nowIso: optStr(p, 'nowIso'),
      }),
    accept: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      return rt.execution.requestAttemptAcceptance.requestAttemptAcceptance({
        attemptId,
        candidateHeadSha: str(p, 'candidateHeadSha') || attempt?.artifacts?.headCommit || '',
        reviewerModel: str(p, 'reviewerModel'),
      });
    },
  },
  forge: {
    execute: async (p, rt) => {
      const kind = str(p, 'kind');
      if (kind !== 'push-and-open-pr' && kind !== 'merge-pr') {
        throw new CliUsageError("forge kind must be 'push-and-open-pr' or 'merge-pr'");
      }
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      return rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: str(p, 'actionId') || `forge-${attemptId}`,
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt?.workOrderId || '',
        kind,
        expectedHeadSha: str(p, 'expectedHeadSha') || attempt?.artifacts?.headCommit || '',
        authorizationGrantId: str(p, 'authorizationGrantId'),
      });
    },
  },
  evidence: {
    'request-verification': async (p, rt) => {
      // The assessment records the attempt's own implementer seat at creation;
      // an unresolvable seat is a typed rejection, never an assumed model.
      const seat = await bindImplementerSeat(rt, p);
      if (!seat.bound) {
        return seat.rejection;
      }
      return rt.evidence.requestVerification.requestVerification({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        hostId: str(p, 'hostId'),
        implementerModel: seat.implementerModel,
        requiredChecks: strArr(p, 'requiredChecks'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'record-verification': async (p, rt) =>
      rt.evidence.recordVerificationReceipt.recordVerificationReceipt({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        receipt: requiredNested<VerificationReceiptRecord>(p, 'receipt', 'evidence record-verification'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'request-review': async (p, rt) => {
      const seat = await bindImplementerSeat(rt, p);
      if (!seat.bound) {
        return seat.rejection;
      }
      return rt.evidence.requestIndependentReview.requestIndependentReview({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        implementerModel: seat.implementerModel,
        reviewerModel: str(p, 'reviewerModel'),
        diffSummary: optStr(p, 'diffSummary'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'record-review': async (p, rt) => {
      const seat = await bindImplementerSeat(rt, p);
      if (!seat.bound) {
        return seat.rejection;
      }
      const receipt = requiredNested<ReviewReceiptRecord>(p, 'receipt', 'evidence record-review');
      const supplied = receipt.implementerModel;
      if (typeof supplied === 'string' && supplied.trim() !== '' && supplied.trim() !== seat.implementerModel) {
        throw new CliUsageError(
          `evidence record-review refuses implementerModel '${supplied.trim()}': attempt '${str(p, 'attemptId')}' was dispatched on seat '${seat.implementerModel}'`,
        );
      }
      // The receipt's implementer field restates the recorded seat; it is
      // bound, never caller-authored.
      return rt.evidence.recordReviewReceipt.recordReviewReceipt({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        receipt: { ...receipt, implementerModel: seat.implementerModel },
        nowIso: optStr(p, 'nowIso'),
      });
    },
    disposition: async (p, rt) =>
      rt.evidence.recordFindingDisposition.recordFindingDisposition({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        disposition: requiredNested<FindingDispositionRecord>(p, 'disposition', 'evidence disposition'),
        nowIso: optStr(p, 'nowIso'),
      }),
    assess: async (p, rt) => {
      // Owner decision references are frozen into the brief package and read
      // from the attempt record; supplying them here would let a caller name
      // the one-way doors it is judged against.
      if (p['ownerDecisionReferences'] !== undefined) {
        throw new CliUsageError(
          "'--ownerDecisionReferences' is forbidden; owner decisions come from the attempt record",
        );
      }
      const attemptId = optStr(p, 'attemptId');
      return rt.evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId: str(p, 'assessmentId') || (attemptId ? assessmentIdForAttempt(attemptId) : ''),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    inspect: async (p, rt) =>
      rt.evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
        assessmentId: optStr(p, 'assessmentId'),
        candidateHeadSha: optStr(p, 'candidateHeadSha'),
      }),
  },
  knowledge: {
    'capture-notes': async (p, rt) =>
      rt.knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes({
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        workOrderId: str(p, 'workOrderId'),
        headCommitSha: str(p, 'headCommitSha'),
        notesMarkdown: strOrNull(p, 'notesMarkdown'),
        pathPrefixes: strArr(p, 'pathPrefixes'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'check-claim': async (p, rt) =>
      rt.knowledge.checkKnowledgeClaim.checkKnowledgeClaim({
        checkId: str(p, 'checkId'),
        entryId: str(p, 'entryId'),
        checkerId: str(p, 'checkerId'),
        procedureName: str(p, 'procedureName'),
        targetPath: optStr(p, 'targetPath'),
        nowIso: optStr(p, 'nowIso'),
      }),
    decide: async (p, rt) =>
      rt.knowledge.decideKnowledgeDisposition.decideKnowledgeDisposition({
        entryId: str(p, 'entryId'),
        disposition: enumOf(p, 'disposition', KNOWLEDGE_DISPOSITIONS, 'knowledge disposition'),
        checkerId: str(p, 'checkerId'),
        reason: str(p, 'reason'),
        nowIso: optStr(p, 'nowIso'),
      }),
    publish: async (p, rt) =>
      rt.knowledge.publishAcceptedKeeper.publishAcceptedKeeper({
        entryId: str(p, 'entryId'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'propose-context': async (p, rt) =>
      rt.knowledge.proposeBriefContext.proposeBriefContext({
        projectId: str(p, 'projectId'),
        laneId: str(p, 'laneId'),
        taskSummary: str(p, 'taskSummary'),
        pathPrefixes: strArr(p, 'pathPrefixes'),
        maxEntries: optNum(p, 'maxEntries'),
        maxTotalChars: optNum(p, 'maxTotalChars'),
      }),
    'select-context': async (p, rt) => {
      const selections = nestedArr<RecordContextSelectionItem>(p, 'selections') ?? [];
      for (const selection of selections) {
        if (
          !selection ||
          typeof selection !== 'object' ||
          typeof selection.decisionBecause !== 'string' ||
          selection.decisionBecause.trim() === ''
        ) {
          throw new CliUsageError(
            "knowledge select-context requires a non-empty 'decisionBecause' for each item",
          );
        }
      }
      return rt.knowledge.recordContextSelection.recordContextSelection({
        attemptId: str(p, 'attemptId'),
        selections,
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'record-reuse': async (p, rt) =>
      rt.knowledge.recordKnowledgeReuse.recordKnowledgeReuse({
        reuseId: str(p, 'reuseId'),
        entryId: str(p, 'entryId'),
        attemptId: str(p, 'attemptId'),
        outcome: enumOf(p, 'outcome', KNOWLEDGE_REUSE_OUTCOMES, 'knowledge reuse outcome'),
        evidenceRef: optStr(p, 'evidenceRef'),
        nowIso: optStr(p, 'nowIso'),
      }),
    supersede: async (p, rt) =>
      rt.knowledge.supersedeKnowledgeEntry.supersedeKnowledgeEntry({
        olderEntryId: str(p, 'olderEntryId'),
        newerEntryId: str(p, 'newerEntryId'),
        checkerId: str(p, 'checkerId'),
        reason: str(p, 'reason'),
        nowIso: optStr(p, 'nowIso'),
      }),
  },
  coordination: {
    'register-profile': async (p, rt) =>
      rt.coordination.registerProjectProfile.registerProjectProfile({
        projectId: str(p, 'projectId'),
        displayName: str(p, 'displayName'),
        repository: str(p, 'repository'),
        designatedDispatcherHost: str(p, 'designatedDispatcherHost'),
        policyRevision: str(p, 'policyRevision'),
        maxConcurrentLanes: num(p, 'maxConcurrentLanes', 1),
        runnerCapabilities: nested<Record<string, boolean | string>>(p, 'runnerCapabilities') ?? {},
        nowIso: optStr(p, 'nowIso'),
      }),
    capabilities: async (p, rt) =>
      rt.coordination.inspectConfiguredCapabilities.inspectConfiguredCapabilities({
        projectId: str(p, 'projectId'),
        requiredCapabilities: strArr(p, 'requiredCapabilities'),
      }),
    'request-decision': async (p, rt) =>
      rt.coordination.requestScopedDecision.requestScopedDecision({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: strOrNull(p, 'expectedHeadSha'),
        proposalDigest: str(p, 'proposalDigest'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'resolve-auth': async (p, rt) =>
      rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: str(p, 'projectId'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        authorizationGrantId: optStr(p, 'authorizationGrantId'),
      }),
    'consume-auth': async (p, rt) =>
      rt.coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: str(p, 'consumptionId'),
        grantId: str(p, 'grantId'),
        actionId: str(p, 'actionId'),
        actionScope: str(p, 'actionScope') || (str(p, 'actionKind') ? forgeActionScope(str(p, 'actionKind')) : ''),
        attemptId: str(p, 'attemptId'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'publish-observation': async (p, rt) =>
      rt.coordination.publishProjectObservation.publishProjectObservation({
        observationId: str(p, 'observationId'),
        projectId: str(p, 'projectId'),
        eventKind: str(p, 'eventKind'),
        sourceAttemptId: strOrNull(p, 'sourceAttemptId'),
        payloadSummary: str(p, 'payloadSummary'),
        nowIso: optStr(p, 'nowIso'),
      }),
    attention: async (p, rt) =>
      rt.coordination.readProjectAttention.readProjectAttention({
        projectId: str(p, 'projectId'),
      }),
    'send-relay': async (p, rt) =>
      rt.coordination.sendFleetRelay.sendFleetRelay({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        recipientId: str(p, 'recipientId'),
        summary: str(p, 'summary'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'ack-relay': async (p, rt) =>
      rt.coordination.recordRelayAcknowledgement.recordRelayAcknowledgement({
        acknowledgementId: str(p, 'acknowledgementId'),
        requestId: str(p, 'requestId'),
        recipientId: str(p, 'recipientId'),
        responseSummary: str(p, 'responseSummary'),
        provenance: str(p, 'provenance'),
        nowIso: optStr(p, 'nowIso'),
      }),
    outstanding: async (p, rt) =>
      rt.coordination.inspectOutstandingCoordination.inspectOutstandingCoordination({
        projectId: optStr(p, 'projectId'),
      }),
  },
  questions: {
    ask: async (p, rt) => {
      const filePath = optStr(p, 'file');
      if (filePath === undefined) {
        throw new CliUsageError(
          "questions ask requires '--file <path>' pointing at one JSON question record",
        );
      }
      return rt.coordination.askOwnerQuestion.askOwnerQuestion(readQuestionFile(filePath));
    },
    list: async (p, rt) => {
      const state = optStr(p, 'state');
      const since = optStr(p, 'since');
      if (since !== undefined && (!ISO_WITH_ZONE.test(since) || Number.isNaN(Date.parse(since)))) {
        throw new CliUsageError(
          "questions list '--since' must be an ISO timestamp with an explicit zone (e.g. 2026-10-16T08:00:00Z or +02:00)",
        );
      }
      const request: ListOwnerQuestionsRequest = {
        ...(state !== undefined
          ? { state: enumOf(p, 'state', OWNER_QUESTION_STATES, 'questions list state') }
          : {}),
        ...(since !== undefined ? { since } : {}),
      };
      return rt.coordination.listOwnerQuestions.listOwnerQuestions(request);
    },
    show: async (p, rt) =>
      rt.coordination.readOwnerQuestion.readOwnerQuestion({
        questionId: questionIdPositional(p, 'show'),
      }),
    answer: async (p, rt) => {
      const questionId = questionIdPositional(p, 'answer');
      const revision = num(p, 'revision', Number.NaN);
      if (!Number.isInteger(revision) || revision < 1) {
        throw new CliUsageError(
          "questions answer requires '--revision <n>' naming the question revision you are answering",
        );
      }
      const accepts = p['accept'] === true;
      const rejects = p['reject'] === true;
      const optionId = optStr(p, 'option');
      const text = optStr(p, 'text');
      const reason = optStr(p, 'reason');
      const shapeCount = (accepts ? 1 : 0) + (rejects ? 1 : 0) + (optionId !== undefined ? 1 : 0);
      if (shapeCount !== 1) {
        throw new CliUsageError(
          "questions answer requires exactly one of '--accept', '--reject' or '--option <id>'",
        );
      }
      if (accepts && (reason !== undefined || text !== undefined)) {
        throw new CliUsageError("'--accept' records the recommendation and takes no '--reason' or '--text'");
      }
      if (rejects && (optionId !== undefined || text !== undefined)) {
        throw new CliUsageError("'--reject' takes an optional '--reason' only");
      }
      if (optionId === undefined && text !== undefined) {
        throw new CliUsageError("'--text' answers alongside '--option <id>'");
      }
      const request: AnswerOwnerQuestionRequest = {
        questionId,
        questionRevision: revision,
        shape: accepts ? 'accept' : rejects ? 'reject' : 'answer',
        answeredVia: 'cli',
        ...(optionId !== undefined ? { optionId } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
      return rt.coordination.answerOwnerQuestion.answerOwnerQuestion(request);
    },
    sync: async (_p, rt) => rt.coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions(),
    expire: async (_p, rt) => rt.coordination.expireOwnerQuestions.expireOwnerQuestions(),
    acknowledge: async (p, rt) => {
      const by = optStr(p, 'by');
      if (by === undefined) {
        throw new CliUsageError("questions acknowledge requires '--by <name>' naming who acted on the answer");
      }
      return rt.coordination.acknowledgeOwnerAnswer.acknowledgeOwnerAnswer({
        questionId: questionIdPositional(p, 'acknowledge'),
        by,
      });
    },
    wait: async (p, rt) => {
      const questionId = questionIdPositional(p, 'wait');
      const maxMs = parseDurationOption(p, 'max', DEFAULT_WAIT_MAX_MS);
      const intervalMs = parseDurationOption(p, 'interval', DEFAULT_WAIT_INTERVAL_MS);
      if (intervalMs <= 0) {
        throw new CliUsageError("'--interval' must be greater than zero");
      }
      const deadline = Date.now() + maxMs;
      for (;;) {
        // Every round syncs first: a one-way question is settled by the signed
        // owner decision its linked request carries, never by this poll.
        await rt.coordination.syncOneWayOwnerQuestions.syncOneWayOwnerQuestions();
        const read = await rt.coordination.readOwnerQuestion.readOwnerQuestion({ questionId });
        if (read.outcome === 'found' && TERMINAL_WAIT_STATES.includes(read.question.state)) {
          return { outcome: read.question.state, question: read.question };
        }
        if (Date.now() >= deadline) {
          return {
            outcome: 'timeout',
            ...(read.outcome === 'found' ? { question: read.question } : {}),
            reason:
              read.outcome === 'found'
                ? `the question is still ${read.question.state} after the waited time`
                : 'no owner question is recorded for that id',
          };
        }
        await sleep(Math.min(intervalMs, deadline - Date.now()));
      }
    },
  },
};

// ---------------------------------------------------------------------------
// `doctor`: read-only installation checks with real probes
// ---------------------------------------------------------------------------

export interface DoctorCliOptions {
  /**
   * Pre-loaded installation; the existing loader composes one when omitted.
   * A `missing` or `invalid` result is refused with exit 1, never checked.
   */
  readonly loadResult?: LoadResult;
  /** Probe implementation; the node probes compose one when omitted. */
  readonly probes?: DoctorProbes;
}

const DOCTOR_HELP = `Usage: fleet-v2 doctor [--probe-seats] [--json]

Read-only checks over the loaded installation: hosts and roles, platform
tools, configured tool versions, credential file modes (never contents), the
bundled ocm-run hash and each configured seat.

  --probe-seats  run each seat's one-step probe (a live model call). Seat
                 probes run from the operator's machine — the host running
                 fleet-v2 doctor — never on a remote host.
  --json         print one JSON document per doctor line

Exit codes: 0 all PASS, 1 any FAIL or UNKNOWN — and also a missing or invalid
installation, which doctor refuses to check — 2 usage error. Without
--probe-seats every seat is reported UNKNOWN, so doctor exits 1 whenever the
installation defines seats.`;

/** Parse doctor's own flags; `--json` here selects output shape, not a payload. */
function parseDoctorFlags(tokens: readonly string[]): {
  probeSeats: boolean;
  json: boolean;
} {
  let probeSeats = false;
  let json = false;
  for (const token of tokens) {
    if (token === '--probe-seats') {
      probeSeats = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    throw new CliUsageError(`Unknown doctor option: ${token}\n${DOCTOR_HELP}`);
  }
  return { probeSeats, json };
}

function formatDoctorLine(doctorLine: DoctorLine): string {
  return `${doctorLine.status} ${doctorLine.scope} ${doctorLine.subject} ${doctorLine.check} — ${doctorLine.detail}`;
}

/**
 * Run the doctor engine over the installation and print one line per check.
 * The exit code follows `doctorExitCode`: 0 only when every line passed. A
 * missing or invalid installation is refused with exit 1, not a usage error.
 */
export async function doctorCommand(
  argv: readonly string[],
  io: CliIo,
  options: DoctorCliOptions = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(`${DOCTOR_HELP}\n`);
    return 0;
  }
  const { probeSeats, json } = parseDoctorFlags(argv);
  const loadResult = options.loadResult ?? loadInstallation();
  if (loadResult.status === 'invalid') {
    io.stderr(`installation invalid (${loadResult.file}):\n`);
    for (const error of loadResult.errors) {
      io.stderr(`${error}\n`);
    }
    io.stderr('doctor refuses to run checks against an invalid installation\n');
    return 1;
  }
  if (loadResult.status === 'absent') {
    io.stderr('installation missing: doctor has no installation to check\n');
    return 1;
  }
  const probes = options.probes ?? createNodeDoctorProbes();
  const lines: DoctorLine[] = [];
  for await (const doctorLine of runDoctor(loadResult, probes, { probeSeats })) {
    lines.push(doctorLine);
    io.stdout(json ? `${JSON.stringify(doctorLine)}\n` : `${formatDoctorLine(doctorLine)}\n`);
  }
  return doctorExitCode(lines);
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const QUESTIONS_HELP = `Usage: fleet-v2 questions <subcommand> [flags]

Owner questions the orchestrator asks the owner to answer. A two-way question
is answered here; a one-way question is answered only by the owner's signed
decision file for its linked request, which 'questions sync' and 'questions
wait' pick up. An answer records advice and unblocks; it grants nothing,
fires no action and touches no coordination request.

  ask --file <path>              record one new question from a JSON file
                                 carrying questionId, askedBy, title, body,
                                 options, recommendation, and optionally
                                 doorKind ('two-way' is the only door this
                                 CLI can answer), linkedRequestId, blocks
                                 and expiresAt
  list [--state <s>] [--since <iso>]
                                 list questions, optionally only one state
                                 (open, answered, rejected, expired,
                                 acknowledged) and/or asked at or after an
                                 ISO timestamp with an explicit zone
                                 (e.g. 2026-10-16T08:00:00Z or +02:00)
  show <id>                      print one question's full record
  answer <id> --revision <n>     answer a two-way question at the revision
                                 you saw, with exactly one of:
    --accept                       record the recommended option
    --reject [--reason <text>]     reject it, with an optional reason
    --option <id> [--text <text>]  answer with another option and free text
  sync                           re-read every open one-way question's linked
                                 signed decision and settle answered/rejected
  expire                         move open two-way questions past their
                                 expiry to expired; they stay blocking and
                                 are re-asked, never dropped
  acknowledge <id> --by <name>   record that the asker acted on the answer
  wait <id> [--max 30m] [--interval 15s]
                                 poll until the question settles, syncing
                                 one-way questions each round; exits 0
                                 answered/acknowledged, 1 rejected/expired/
                                 timeout (the JSON body says which)

Durations take a unit of ms, s, m or h. Exit codes: 0 completed,
1 refused/rejected/blocked/unknown/not-found, 2 usage error.`;

const HELP_TEXT = `fleet-v2 — Fleet CLI operator driver across the four bounded contexts.

Usage: fleet-v2 [--state-dir <path>] <command> <subcommand> [--json '<payload>'] [--flag value ...]

Global state option: --state-dir <path> (or the FLEET_STATE_DIR environment
variable) selects the directory that backs durable CLI state; it may appear
in any position, and every store is in-memory when neither is given.

Pass the full typed request as one JSON object with --json, or supply fields
as --kebab-case flags (arrays as comma-separated values). The typed result
prints to stdout as one JSON document.

doctor prints one check per line (JSON documents with --json). Without
--probe-seats every seat is UNKNOWN, so doctor exits 1 when seats exist.

Commands:
  work-order register|inspect
  doctor [--probe-seats] [--json]
  brief prepare
  capacity reserve
  attempt dispatch|reconcile|stop|collect|fix|accept
  forge execute
  evidence request-verification|record-verification|request-review|record-review|disposition|assess|inspect
  knowledge capture-notes|check-claim|decide|publish|propose-context|select-context|record-reuse|supersede
  coordination register-profile|capabilities|request-decision|resolve-auth|consume-auth|publish-observation|attention|send-relay|ack-relay|outstanding
  questions ask|list|show|answer|sync|expire|acknowledge|wait
  help | --help

Exit codes: 0 completed, 1 refused/rejected/blocked/unknown result, 2 usage error.`;

function groupHelp(group: string): string {
  const subcommands = Object.keys(COMMANDS[group] ?? {}).sort();
  return `Usage: fleet-v2 ${group} <subcommand> [--json '<payload>'] [--flag value ...]\nSubcommands: ${subcommands.join(', ')}\nSee: fleet-v2 --help`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
  runtime?: FleetCliRuntime,
  doctorOptions?: DoctorCliOptions,
): Promise<number> {
  try {
    const { stateDir, restArgv } = extractStateDirOption(argv, process.env.FLEET_STATE_DIR);
    if (restArgv.length === 0) {
      io.stderr(`${HELP_TEXT}\n`);
      return 2;
    }
    // The doctor reads the installation itself and refuses a missing or
    // invalid one with exit 1; it never composes the state-backed runtime.
    const group = restArgv[0];
    if (group === 'doctor') {
      return await doctorCommand(restArgv.slice(1), io, doctorOptions ?? {});
    }
    // The questions group carries its own help block; a help request never
    // composes the runtime and never counts as a usage error.
    if (
      group === 'questions' &&
      (restArgv[1] === 'help' ||
        restArgv.slice(1).includes('--help') ||
        restArgv.slice(1).includes('-h'))
    ) {
      io.stdout(`${QUESTIONS_HELP}\n`);
      return 0;
    }
    // An explicitly injected runtime stays authoritative; only a call without
    // one composes a fresh runtime bound to the resolved state directory.
    let activeRuntime: FleetCliRuntime;
    if (runtime !== undefined) {
      activeRuntime = runtime;
    } else {
      const loadResult = loadInstallation();
      if (loadResult.status === 'invalid') {
        io.stderr(`installation invalid (${loadResult.file}):\n`);
        for (const error of loadResult.errors) {
          io.stderr(`${error}\n`);
        }
        return 2;
      }
      activeRuntime = createFleetCliRuntime({
        stateDir,
        installation: loadResult.installation,
      });
    }
    if (group === 'help' || group === '--help' || group === '-h') {
      io.stdout(`${HELP_TEXT}\n`);
      return 0;
    }
    const subcommands = COMMANDS[group];
    if (subcommands === undefined) {
      io.stderr(`Unknown command: ${group}\nRun 'fleet-v2 --help' for the available commands.\n`);
      return 2;
    }
    let subcommand: string | null = null;
    let rest: readonly string[] = [];
    if (restArgv.length > 1 && !restArgv[1].startsWith('--')) {
      subcommand = restArgv[1];
      rest = restArgv.slice(2);
    } else {
      rest = restArgv.slice(1);
    }
    if (subcommand === null) {
      io.stderr(`${groupHelp(group)}\n`);
      return 2;
    }
    const handler = subcommands[subcommand];
    if (handler === undefined) {
      io.stderr(`Unknown ${group} subcommand: ${subcommand}\n${groupHelp(group)}\n`);
      return 2;
    }
    const allowPositional =
      group === 'questions' && QUESTIONS_POSITIONAL_SUBCOMMANDS.has(subcommand);
    const payload = parseFlags(rest, { allowPositional });
    const result = await handler(payload, activeRuntime);
    io.stdout(`${JSON.stringify(result)}\n`);
    return exitCodeForResult(result, group, subcommand);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Process entry point. Runs the CLI against the real argument vector and
 * process streams and carries the exit code through `process.exitCode`.
 */
export function main(): void {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
