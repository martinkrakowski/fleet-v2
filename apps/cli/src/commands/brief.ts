/** The `brief` command group of the CLI driver; its entries moved verbatim from the command table. */

import { resolve as resolvePath } from 'node:path';

import { parseSeatTool, unhealthySeatIdsFromCatalog } from '@fleet/work-execution';
import type { AuthorBriefRequest, BuildFactPackFact, AcceptanceSpecProps, BriefContextDecision, BriefModelAssignment } from '@fleet/work-execution';
import { FACT_PACK_MAX_FACTS } from '@fleet/work-execution';
import { str, optStr, strOrNull, num, strArr, nested, nestedArr, jsonStrArr, jsonObj, derivedV2Model, briefSeatPlan, safeJsonParse, CliUsageError } from './payload.js';
import type { CommandHandler, Payload } from './payload.js';
import type { FleetCliRuntime } from '../composition.js';

export const briefCommands: Readonly<Record<string, CommandHandler>> = {
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
      // H8: the seat tool is required and frozen into the manifest, so it is
      // covered by the digest. Missing or undeclared is a usage error (exit
      // 2), never a default to opencode.
      const nestedAssignment = nested<BriefModelAssignment>(p, 'modelAssignment');
      const rawSeatTool = p['seatTool'] ?? nestedAssignment?.seatTool;
      const seatTool = parseSeatTool(rawSeatTool);
      if (seatTool === undefined) {
        throw new CliUsageError(
          'brief prepare requires --seatTool naming a declared runner kind (opencode or agy)',
        );
      }
      if (
        nestedAssignment !== undefined &&
        nestedAssignment.seatTool !== undefined &&
        nestedAssignment.seatTool !== seatTool
      ) {
        throw new CliUsageError(
          `'--seatTool ${String(seatTool)}' conflicts with the seat tool in --modelAssignment`,
        );
      }
      const seatPlan = briefSeatPlan(p, rt);
      const unhealthy = new Set(unhealthySeatIdsFromCatalog(derivedV2Model(rt)));
      const planSeatForAssignment =
        seatPlan !== undefined && nestedAssignment === undefined && optStr(p, 'model') === undefined
          ? seatPlan['first-pass'].find((seat) => !unhealthy.has(seat.id))
          : undefined;
      if (
        seatPlan !== undefined &&
        nestedAssignment === undefined &&
        optStr(p, 'model') === undefined &&
        planSeatForAssignment === undefined
      ) {
        throw new CliUsageError(
          'Every first-pass seat of the seat plan is unhealthy; pass --model to choose one',
        );
      }
      let modelAssignment: BriefModelAssignment;
      if (nestedAssignment !== undefined) {
        modelAssignment = { ...nestedAssignment, seatTool };
      } else if (planSeatForAssignment !== undefined) {
        modelAssignment = {
          model: planSeatForAssignment.model,
          variant: planSeatForAssignment.variant ?? 'default',
          fallbackModel: str(p, 'fallbackModel') || planSeatForAssignment.model,
          seatTool,
          ...(planSeatForAssignment.agent !== undefined ? { agent: planSeatForAssignment.agent } : {}),
        } as BriefModelAssignment;
      } else {
        modelAssignment = {
          model: str(p, 'model'),
          variant: str(p, 'variant') || 'default',
          fallbackModel: str(p, 'fallbackModel'),
          seatTool,
        };
      }
      return rt.execution.prepareBriefPackage.prepareBriefPackage({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        policyRevision: str(p, 'policyRevision'),
        modelAssignment,
        independentReviewer: str(p, 'independentReviewer'),
        ownedPaths: strArr(p, 'ownedPaths'),
        // The edit-only diff check's allowed prefixes: one JSON array (or an
        // array in --json). A malformed value is a usage error (exit 2),
        // never a silent empty list.
        allowedPathPrefixes: jsonStrArr(p, 'allowedPathPrefixes', 'brief prepare'),
        permissions: strArr(p, 'permissions'),
        acceptanceChecks: strArr(p, 'acceptanceChecks'),
        acceptanceSpec: jsonObj(p, 'acceptanceSpec', 'brief prepare') as AcceptanceSpecProps | undefined,
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        resourceBounds: nested<Record<string, string>>(p, 'resourceBounds') ?? {},
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        ownerDecisionReferences: strArr(p, 'ownerDecisionReferences'),
        contextDecisions,
        attemptId: optStr(p, 'attemptId'),
        worktreePath: optStr(p, 'worktreePath'),
        handWrittenBriefPath: strOrNull(p, 'handWrittenBriefPath'),
        ...(seatPlan !== undefined ? { seatPlan } : {}),
      });
    },

    author: async (p, rt) => authorBriefCommand(p, rt),
};

// ---------------------------------------------------------------------------
// CO17c: `brief author` helpers. Every read of an untrusted payload value goes
// through `readArgument` / `copyUntrusted`: no method of the value is called,
// no getter runs, and any throw during inspection is a fixed-message usage
// error that never echoes the thrown text.
// ---------------------------------------------------------------------------

const UNREADABLE = 'brief author could not read its arguments';
const FACTS_SHAPE = "brief author requires a JSON array of fact objects in '--facts'";
const DECISION_SHAPE = "brief author contextDecisions requires a non-empty 'decisionBecause' for each item";
const COPY_MAX_DEPTH = 16;
const COPY_MAX_NODES = 5000;

interface CopyBudget {
  nodes: number;
}

function refuseUnreadable(): never {
  throw new CliUsageError(UNREADABLE);
}

/** One own data property's value; an accessor or a trap that misbehaves is a refusal. */
function ownDataValue(owner: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!('value' in descriptor)) {
    return refuseUnreadable();
  }
  return descriptor.value as unknown;
}

/** A bounded array length read once from a value `Array.isArray` accepted. */
function readLength(value: object, max: number = COPY_MAX_NODES): number {
  const length = ownDataValue(value, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > max) {
    return refuseUnreadable();
  }
  return length;
}

function copyArray(value: object, depth: number, budget: CopyBudget, knownLength?: number): unknown[] {
  const length = knownLength ?? readLength(value);
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    out.push(copyNode(ownDataValue(value, String(index)), depth + 1, budget));
  }
  return out;
}

function copyRecord(value: object, depth: number, budget: CopyBudget): Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return refuseUnreadable();
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    // defineProperty makes `__proto__` an ordinary own key of the copy.
    Object.defineProperty(out, key, {
      value: copyNode(ownDataValue(value, key), depth + 1, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function copyNode(value: unknown, depth: number, budget: CopyBudget, knownLength?: number): unknown {
  budget.nodes += 1;
  if (depth > COPY_MAX_DEPTH || budget.nodes > COPY_MAX_NODES) {
    return refuseUnreadable();
  }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : refuseUnreadable();
  }
  if (typeof value !== 'object') {
    return refuseUnreadable();
  }
  return Array.isArray(value) ? copyArray(value, depth, budget, knownLength) : copyRecord(value, depth, budget);
}

/** Copy one untrusted value into fresh plain containers, or refuse it as usage. */
function copyUntrusted<T>(value: T, knownLength?: number): T {
  try {
    return copyNode(value, 0, { nodes: 0 }, knownLength) as T;
  } catch {
    return refuseUnreadable();
  }
}

/** Read one payload field exactly once; a throwing getter is a usage error. */
function readArgument(p: Payload, key: string): unknown {
  try {
    return p[key];
  } catch {
    return refuseUnreadable();
  }
}

interface ArgumentReader {
  /** The field's value, read once and deep-copied into plain data. */
  safe(key: string): unknown;
  /** The field through a shared coercion helper, over the safe copy. */
  via<T>(key: string, read: (payload: Payload) => T): T;
  opt(key: string): string | undefined;
  required(key: string): string;
  raw(key: string): unknown;
  /** A field that may be a JSON document in a string: parsed first, then copied under the same bounds. */
  json(key: string): unknown;
  /** A string list; only primitives are coerced, anything else is a usage error. */
  strings(key: string): string[];
  /** A number; an object is a usage error rather than being coerced. */
  number(key: string, fallback: number): number;
}

function makeReader(p: Payload): ArgumentReader {
  const safe = (key: string): unknown => copyUntrusted(readArgument(p, key));
  const via = <T>(key: string, read: (payload: Payload) => T): T => read({ [key]: safe(key) });
  const wrongType = (key: string): never => {
    throw new CliUsageError(`brief author --${key} has the wrong type`);
  };
  const isObjectLike = (value: unknown): boolean =>
    (typeof value === 'object' && value !== null) || typeof value === 'function';
  return {
    safe,
    via,
    raw: (key) => readArgument(p, key),
    json: (key) => {
      const value = readArgument(p, key);
      if (typeof value !== 'string') {
        return copyUntrusted(value);
      }
      const parsed = safeJsonParse(value);
      return parsed === undefined ? value : copyUntrusted(parsed);
    },
    strings: (key) => {
      const value = safe(key);
      if (Array.isArray(value) && value.some((item) => item === undefined || item === null || isObjectLike(item))) {
        return wrongType(key);
      }
      if (isObjectLike(value) && !Array.isArray(value)) {
        return wrongType(key);
      }
      return strArr({ [key]: value }, key);
    },
    number: (key, fallback) => {
      const value = safe(key);
      return isObjectLike(value) ? wrongType(key) : num({ [key]: value }, key, fallback);
    },
    opt: (key) => via(key, (payload) => optStr(payload, key)),
    required: (key) => {
      const value = via(key, (payload) => str(payload, key)).trim();
      if (value === '') {
        throw new CliUsageError(`brief author requires --${key}`);
      }
      return value;
    },
  };
}

interface AuthorScalars {
  workOrderId: string;
  laneId: string;
  projectId: string;
  taskId: string;
  repository: string;
  baseCommit: string;
  policyRevision: string;
  implementerModel: string;
  fallbackModel: string;
  independentReviewer: string;
  authorModel: string;
  checkoutPath: string;
  repositoryPath: string;
  worktreePath: string;
  briefsDir: string;
}

function readScalars(read: ArgumentReader): AuthorScalars {
  const workOrderId = read.required('workOrderId');
  const laneId = read.required('laneId');
  const projectId = read.required('projectId');
  const taskId = read.required('taskId');
  const repository = read.required('repository');
  const baseCommit = read.required('baseCommit');
  const policyRevision = read.required('policyRevision');
  const implementerModel = read.required('model');
  const fallbackModel = read.required('fallbackModel');
  const independentReviewer = read.required('independentReviewer');
  const authorModel = read.required('authorModel');
  const checkoutPath = read.required('checkoutPath');
  const repositoryPath = read.required('repositoryPath');

  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
    throw new CliUsageError('brief author requires --baseCommit as 40 to 64 lowercase hex characters');
  }
  const worktreePath = read.required('worktreePath');
  // Not just the literal `/`: `/.`, `/foo/..`, `//` and friends all
  // resolve to the filesystem root and are refused the same way.
  if (!worktreePath.startsWith('/') || resolvePath(worktreePath) === '/') {
    throw new CliUsageError('brief author requires an absolute --worktreePath that is not the filesystem root');
  }
  const briefsDir = read.required('briefsDir');
  if (!briefsDir.startsWith('/') || briefsDir.split('/').includes('..')) {
    throw new CliUsageError("brief author requires an absolute --briefsDir with no '..' segment");
  }
  // The seat answer is the only prose: operator-supplied prose or a
  // hand-written path is refused before the use case is called.
  if (read.opt('proseMarkdown') !== undefined) {
    throw new CliUsageError('brief author takes the brief from the seat; --proseMarkdown is not accepted');
  }
  if (read.opt('handWrittenBriefPath') !== undefined) {
    throw new CliUsageError('brief author takes the brief from the seat; --handWrittenBriefPath is not accepted');
  }
  return {
    workOrderId, laneId, projectId, taskId, repository, baseCommit, policyRevision, implementerModel,
    fallbackModel, independentReviewer, authorModel, checkoutPath, repositoryPath, worktreePath, briefsDir,
  };
}

/** The facts input as an array: one JSON array, bounded before any element is read. */
function readFactsList(read: ArgumentReader): readonly unknown[] {
  const rawFacts = read.raw('facts');
  if (rawFacts === undefined) {
    throw new CliUsageError(FACTS_SHAPE);
  }
  let source: unknown = rawFacts;
  if (typeof rawFacts === 'string') {
    source = safeJsonParse(rawFacts);
  }
  let length: number;
  try {
    if (!Array.isArray(source)) {
      throw new CliUsageError(FACTS_SHAPE);
    }
    // The count limit wins over the copy bound, so only an integer is required here.
    length = readLength(source, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    if (error instanceof CliUsageError && error.message === FACTS_SHAPE) {
      throw error;
    }
    return refuseUnreadable();
  }
  if (length > FACT_PACK_MAX_FACTS) {
    throw new CliUsageError('brief author accepts at most 32 facts');
  }
  return copyUntrusted(source, length) as unknown[];
}

function malformedFact(index: number): CliUsageError {
  return new CliUsageError(`brief author fact ${index} is malformed`);
}

function factString(record: Record<string, unknown>, key: string, index: number): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw malformedFact(index);
  }
  return value;
}

function factNumber(record: Record<string, unknown>, key: string, index: number): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw malformedFact(index);
  }
  return value;
}

/** One fact from a safe plain copy; the allowlist drops every other key. */
function copyFact(fact: unknown, index: number): BuildFactPackFact {
  if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
    throw new CliUsageError(`brief author fact ${index} is missing`);
  }
  const record = fact as Record<string, unknown>;
  const kind = record['kind'];
  const label = record['label'];
  if (typeof kind !== 'string' || typeof label !== 'string' || label === '') {
    throw malformedFact(index);
  }
  if (kind === 'file-list') {
    return { kind, label, pathPrefix: factString(record, 'pathPrefix', index) };
  }
  if (kind === 'file-range') {
    return {
      kind, label, path: factString(record, 'path', index),
      fromLine: factNumber(record, 'fromLine', index), toLine: factNumber(record, 'toLine', index),
    };
  }
  if (kind === 'matching-lines') {
    return { kind, label, path: factString(record, 'path', index), token: factString(record, 'token', index) };
  }
  throw malformedFact(index);
}

function readFacts(read: ArgumentReader): BuildFactPackFact[] {
  return readFactsList(read).map((fact, index) => copyFact(fact, index));
}

/** The seat tool, as `brief prepare` freezes it, and the payload's own assignment. */
function readSeatTool(
  read: ArgumentReader,
): { nestedAssignment: BriefModelAssignment | undefined; seatTool: NonNullable<ReturnType<typeof parseSeatTool>> } {
  const nestedAssignment = read.via('modelAssignment', (payload) => nested<BriefModelAssignment>(payload, 'modelAssignment'));
  const seatTool = parseSeatTool(read.safe('seatTool') ?? nestedAssignment?.seatTool);
  if (seatTool === undefined) {
    throw new CliUsageError('brief author requires --seatTool naming a declared runner kind (opencode or agy)');
  }
  if (
    nestedAssignment !== undefined &&
    nestedAssignment.seatTool !== undefined &&
    nestedAssignment.seatTool !== seatTool
  ) {
    throw new CliUsageError(`'--seatTool ${String(seatTool)}' conflicts with the seat tool in --modelAssignment`);
  }
  return { nestedAssignment, seatTool };
}

function decisionString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliUsageError(DECISION_SHAPE);
  }
  return value;
}

/** Each decision is rebuilt from an allowlisted key set over a safe plain copy. */
function readContextDecisions(read: ArgumentReader): BriefContextDecision[] {
  const raw = read.via('contextDecisions', (payload) => nestedArr<unknown>(payload, 'contextDecisions')) ?? [];
  return raw.map((decision) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new CliUsageError(DECISION_SHAPE);
    }
    const record = decision as Record<string, unknown>;
    return {
      proposalId: decisionString(record, 'proposalId'),
      knowledgeEntryId: decisionString(record, 'knowledgeEntryId'),
      version: decisionString(record, 'version'),
      proposedBecause: decisionString(record, 'proposedBecause'),
      accepted: record['accepted'] === true,
      decisionBecause: decisionString(record, 'decisionBecause'),
    };
  });
}

type SeatPlanValue = ReturnType<typeof briefSeatPlan>;

function buildModelAssignment(
  scalars: AuthorScalars,
  read: ArgumentReader,
  seat: ReturnType<typeof readSeatTool>,
  seatPlan: SeatPlanValue,
  rt: FleetCliRuntime,
): BriefModelAssignment {
  const { nestedAssignment, seatTool } = seat;
  if (nestedAssignment !== undefined) {
    return { ...nestedAssignment, seatTool };
  }
  // `--model` was read once and `required` guarantees it, so the seat plan's
  // auto-selection by health never applies here.
  const unhealthy = new Set(unhealthySeatIdsFromCatalog(derivedV2Model(rt)));
  const planSeat = seatPlan?.['first-pass'].find((candidate) => !unhealthy.has(candidate.id));
  if (seatPlan !== undefined && scalars.implementerModel === '' && planSeat === undefined) {
    throw new CliUsageError('Every first-pass seat of the seat plan is unhealthy; pass --model to choose one');
  }
  if (seatPlan !== undefined && scalars.implementerModel === '' && planSeat !== undefined) {
    return {
      model: planSeat.model,
      variant: planSeat.variant ?? 'default',
      fallbackModel: scalars.fallbackModel || planSeat.model,
      seatTool,
      ...(planSeat.agent !== undefined ? { agent: planSeat.agent } : {}),
    } as BriefModelAssignment;
  }
  return {
    model: scalars.implementerModel,
    variant: read.via('variant', (payload) => str(payload, 'variant')) || 'default',
    fallbackModel: scalars.fallbackModel,
    seatTool,
  };
}

function readSeatPlan(read: ArgumentReader, rt: FleetCliRuntime): SeatPlanValue {
  // The plan is read through the guarded helper, but only from a fresh plain
  // payload built from single reads: the raw payload object never reaches it.
  const plan = briefSeatPlan(
    { seatPlan: read.json('seatPlan'), seatPlanFromInstallation: read.safe('seatPlanFromInstallation') },
    rt,
  );
  return plan === undefined ? undefined : copyUntrusted(plan);
}

function buildPrepare(
  scalars: AuthorScalars,
  read: ArgumentReader,
  modelAssignment: BriefModelAssignment,
  contextDecisions: BriefContextDecision[],
  allowedPathPrefixes: string[],
  acceptanceSpec: Record<string, unknown> | undefined,
  seatPlan: SeatPlanValue,
): AuthorBriefRequest['prepare'] {
  const prepare = {
    workOrderId: scalars.workOrderId,
    projectId: scalars.projectId,
    taskId: scalars.taskId,
    laneId: scalars.laneId,
    repository: scalars.repository,
    baseCommit: scalars.baseCommit,
    policyRevision: scalars.policyRevision,
    modelAssignment,
    independentReviewer: scalars.independentReviewer,
    ownedPaths: read.strings('ownedPaths'),
    allowedPathPrefixes,
    permissions: read.strings('permissions'),
    acceptanceChecks: read.strings('acceptanceChecks'),
    acceptanceSpec,
    stepLimit: read.number('stepLimit', 200),
    timeLimitSeconds: read.number('timeLimitSeconds', 3600),
    resourceBounds: read.via('resourceBounds', (payload) => nested<Record<string, string>>(payload, 'resourceBounds')) ?? {},
    expectedArtifacts: read.strings('expectedArtifacts'),
    ownerDecisionReferences: read.strings('ownerDecisionReferences'),
    contextDecisions,
    attemptId: read.opt('attemptId'),
    worktreePath: scalars.worktreePath,
    ...(seatPlan !== undefined ? { seatPlan } : {}),
  };
  return prepare as AuthorBriefRequest['prepare'];
}

/**
 * CO17c: `brief author` builds one request, calls the use case once, and
 * returns its result unchanged. The seat's answer is the only prose: the
 * handler validates the invocation shape (exit 2 on a malformed one),
 * never dispatches, writes nothing and prints nothing itself.
 */
async function authorBriefCommand(p: Payload, rt: FleetCliRuntime): Promise<unknown> {
  const read = makeReader(p);
  const scalars = readScalars(read);
  const facts = readFacts(read);
  const seat = readSeatTool(read);
  const contextDecisions = readContextDecisions(read);
  const allowedPathPrefixes = jsonStrArr({ allowedPathPrefixes: read.json('allowedPathPrefixes') }, 'allowedPathPrefixes', 'brief author');
  const acceptanceSpec = jsonObj({ acceptanceSpec: read.json('acceptanceSpec') }, 'acceptanceSpec', 'brief author');
  const seatPlan = readSeatPlan(read, rt);
  const modelAssignment = buildModelAssignment(scalars, read, seat, seatPlan, rt);
  const authorVariant = read.opt('authorVariant');
  const authorAgent = read.opt('authorAgent');
  return rt.execution.authorBrief.authorBrief({
    workOrderId: scalars.workOrderId,
    laneId: scalars.laneId,
    prepare: buildPrepare(scalars, read, modelAssignment, contextDecisions, allowedPathPrefixes, acceptanceSpec, seatPlan),
    factPack: { repositoryPath: scalars.repositoryPath, commit: scalars.baseCommit, facts },
    seat: {
      model: scalars.authorModel,
      ...(authorVariant !== undefined ? { variant: authorVariant } : {}),
      ...(authorAgent !== undefined ? { agent: authorAgent } : {}),
    },
    checkoutPath: scalars.checkoutPath,
    briefsDir: scalars.briefsDir,
  });
}
