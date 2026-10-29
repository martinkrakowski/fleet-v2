/**
 * Payload coercion helpers, shared command-table types and the per-group
 * support code; imported only by the `commands/<group>` modules and the CLI
 * root (which keeps `extractStateDirOption` and `exitCodeForResult`).
 */

import { readFileSync } from 'node:fs';

import { SeatPlan, type SeatPlanProps } from '@fleet/work-execution';
import { resolveImplementerSeat } from '@fleet/work-execution/use-cases';
import { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';
import type { RankingTrialContextFigures, TrialFigure } from '@fleet/brief-knowledge';
import type { AskOwnerQuestionRequest, OwnerQuestionState } from '@fleet/operator-coordination';
import {
  deriveInstallationModel,
  isFleetInstallationV2,
  type FleetInstallationModel,
} from '@fleet/installation';

import type { FleetCliRuntime } from '../composition.js';
import { seatPlanFromInstallation } from '../seat-plan.js';

/** Signalled for argument-shape problems; reported as exit code 2. */
export class CliUsageError extends Error {}

export type Payload = Record<string, unknown>;

export type CommandHandler = (payload: Payload, runtime: FleetCliRuntime) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Payload coercion helpers. Values arrive from `--json` (typed JSON) or from
// flags (strings); every helper normalizes without inventing data.
// ---------------------------------------------------------------------------

export function str(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function optStr(payload: Payload, key: string): string | undefined {
  const value = str(payload, key);
  return value.trim() === '' ? undefined : value;
}

/**
 * The assessment id is derived from the attempt, never freely chosen. An
 * explicit override is accepted only when it agrees with the attempt's own
 * assessment id; a mismatching one is refused at the boundary. Commands whose
 * attempt arrives inside a nested receipt pass that attempt id, so a bare
 * legacy id cannot be written to by omitting the top-level `attemptId`.
 */
export function evidenceAssessmentId(p: Payload, nestedAttemptId?: unknown): string {
  const nested =
    typeof nestedAttemptId === 'string' && nestedAttemptId.trim() !== '' ? nestedAttemptId : undefined;
  const attemptId = optStr(p, 'attemptId') ?? nested;
  const explicit = optStr(p, 'assessmentId');
  const derived = attemptId ? assessmentIdForAttempt(attemptId) : '';
  if (explicit && derived && explicit !== derived) {
    throw new CliUsageError(
      `'assessmentId' ${explicit} does not match attempt ${attemptId}; its assessment id is ${derived}`,
    );
  }
  return explicit || derived;
}

export function strOrNull(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

export function num(payload: Payload, key: string, fallback: number): number {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function optNum(payload: Payload, key: string): number | undefined {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function strArr(payload: Payload, key: string): string[] {
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
export function nested<T>(payload: Payload, key: string): T | undefined {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as T)
    : undefined;
}

/** A nested JSON object the request shape requires; a usage error when absent. */
export function requiredNested<T>(payload: Payload, key: string, label: string): T {
  const value = nested<T>(payload, key);
  if (value === undefined) {
    throw new CliUsageError(`${label} requires a JSON object in '--${key}'`);
  }
  return value;
}

/** A closed enum value the request shape requires; a usage error when absent. */
export function enumOf<T extends string>(payload: Payload, key: string, allowed: readonly T[], label: string): T {
  const value = str(payload, key);
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new CliUsageError(`${label} must be one of: ${allowed.join(', ')}`);
}

export function nestedArr<T>(payload: Payload, key: string): T[] | undefined {
  const value = payload[key];
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/**
 * A JSON array of strings the request shape requires: the flag value is one
 * JSON document (e.g. --allowedPathPrefixes '["packages/x/src"]'). Anything
 * else is a usage error, never a guess.
 */
export function jsonStrArr(payload: Payload, key: string, label: string): string[] {
  const value = payload[key];
  if (value === undefined) return [];
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new CliUsageError(`${label} requires a JSON array of strings in '--${key}'`);
  }
  return parsed as string[];
}

/**
 * A JSON object the request carries: the flag value is one JSON document
 * (e.g. --acceptanceSpec '{"commitRequired":true,...}') or an object under
 * --json. Absent is undefined (the use case decides); anything else is a
 * usage error.
 */
export function jsonObj(payload: Payload, key: string, label: string): Record<string, unknown> | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliUsageError(`${label} requires a JSON object in '--${key}'`);
  }
  return parsed as Record<string, unknown>;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
/** Result outcomes that report a refusal, gap or unknown and exit non-zero. */
export const NON_ZERO_OUTCOMES: ReadonlySet<string> = new Set([
  'rejected',
  'refused',
  'blocked',
  'not-found',
  'unavailable',
  'delivery-gap',
  'delivery-failed',
  'stale',
  'no-free-slot',
  'no-capacity',
  'busy-worktree',
  'still-running',
  'not-merged',
  'unknown',
]);

/** A latency figure as the report prints it: ms when measured, the port's
 * not-persisted sentinel when the settled lines carried no measurement. */
export function latencyText(figure: TrialFigure): string {
  return typeof figure === 'number' ? `${figure}ms` : figure;
}

/** One contextRef's trial figures as one report line (plan §4, K4). */
export function decisionsReportLine(figure: RankingTrialContextFigures): string {
  const unknownText =
    Object.keys(figure.unknownRateByReason).length === 0
      ? 'none'
      : Object.entries(figure.unknownRateByReason)
          .map(([reason, rate]) => `${reason}:${rate}`)
          .join(',');
  const yesNo = (value: boolean | 'tie' | null): string =>
    value === null ? 'n/a' : value === 'tie' ? 'tie' : value ? 'yes' : 'no';
  return [
    figure.contextRef,
    `calls=${figure.calls}`,
    `orderChanged=${figure.orderChanged ? 'yes' : 'no'}`,
    `top1Changed=${figure.top1Changed ? 'yes' : 'no'}`,
    `kendallTau=${figure.kendallTau === null ? 'n/a' : figure.kendallTau}`,
    `unknown=${unknownText}`,
    `lowestConfidence=${figure.lowestConfidence === null ? 'n/a' : figure.lowestConfidence}`,
    `latencyP50=${latencyText(figure.latencyP50Ms)}`,
    `latencyP95=${latencyText(figure.latencyP95Ms)}`,
    `costUsd=${figure.costUsd}`,
    `estimatedCalls=${figure.estimatedCalls}`,
    `selectionRecorded=${figure.selectionRecorded ? 'yes' : 'no'}`,
    `agreesDecided=${yesNo(figure.selectionAgreesWithDecided)}`,
    `agreesLexical=${yesNo(figure.selectionAgreesWithLexical)}`,
  ].join(' ');
}
/**
 * Bind an independent review request to the implementer seat the attempt
 * actually ran on. Independence is a fact about the lane, so the operator
 * never supplies it: the attempt's recorded seat is read back, and a supplied
 * `implementerModel` is accepted only when it restates that seat. An attempt
 * with no recorded seat is a typed rejection, not an assumed model.
 */
export async function bindImplementerSeat(
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

export const OWNER_QUESTION_STATES: readonly OwnerQuestionState[] = [
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
export const TERMINAL_WAIT_STATES: readonly OwnerQuestionState[] = [
  'answered',
  'acknowledged',
  'rejected',
  'expired',
];

/** An ISO timestamp with an explicit zone, as `questions list --since` requires. */
export const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export const DEFAULT_WAIT_MAX_MS = 30 * 60 * 1000;
export const DEFAULT_WAIT_INTERVAL_MS = 15 * 1000;

/** `questions` subcommands whose first bare argument is the question id. */
export const QUESTIONS_POSITIONAL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'show',
  'answer',
  'acknowledge',
  'wait',
]);

/** The first bare positional token, trimmed; '' when none was given. */
export function firstPositional(payload: Payload): string {
  const positionals = payload['positional'];
  const first = Array.isArray(positionals) ? positionals[0] : undefined;
  return typeof first === 'string' ? first.trim() : '';
}

/** The positional question id a `questions` subcommand requires. */
export function questionIdPositional(payload: Payload, subcommand: string): string {
  const id = firstPositional(payload);
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
export function readQuestionFile(filePath: string): AskOwnerQuestionRequest {
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
export function parseDurationOption(payload: Payload, key: string, fallbackMs: number): number {
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
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The derived v2 model of the runtime's installation, or undefined for v1 or none. */
export function derivedV2Model(rt: FleetCliRuntime): FleetInstallationModel | undefined {
  const installation = rt.installation;
  if (installation === undefined || !isFleetInstallationV2(installation)) {
    return undefined;
  }
  return deriveInstallationModel(installation).model;
}

/** brief prepare's seat plan from --seatPlan or --seatPlanFromInstallation; undefined when neither. */
export function briefSeatPlan(p: Payload, rt: FleetCliRuntime): SeatPlanProps | undefined {
  const explicit = p['seatPlan'];
  const raw = p['seatPlanFromInstallation'];
  if (raw !== undefined && raw !== true && raw !== false && raw !== 'true' && raw !== 'false') {
    throw new CliUsageError("'--seatPlanFromInstallation' takes no value, or true or false");
  }
  const fromInstallation = raw === true || raw === 'true';
  if (explicit !== undefined && fromInstallation) {
    throw new CliUsageError("brief prepare takes '--seatPlan' or '--seatPlanFromInstallation', not both");
  }
  if (explicit !== undefined) {
    const parsed = typeof explicit === 'string' ? safeJsonParse(explicit) : explicit;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CliUsageError("brief prepare requires a JSON object in '--seatPlan'");
    }
    // Validate the shape before any field is read, so a malformed plan is a usage error (exit 2).
    if (!SeatPlan.create(parsed).success) {
      throw new CliUsageError("'--seatPlan' is not a valid seat plan");
    }
    return parsed as SeatPlanProps;
  }
  if (!fromInstallation) {
    return undefined;
  }
  const model = derivedV2Model(rt);
  if (model === undefined) {
    throw new CliUsageError("'--seatPlanFromInstallation' needs a v2 installation");
  }
  const built = seatPlanFromInstallation(model);
  if ('reason' in built) {
    throw new CliUsageError(built.reason);
  }
  return built.plan;
}
