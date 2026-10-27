import { isAbsolute } from 'node:path';

import { isValidHostName } from '@fleet/shared';

import { AGY_SECURITY_TEXT_VERSION } from './agy-security.js';

import type {
  AutoMergePolicy,
  ChainStep,
  ChainTrigger,
  ChainsSection,
  CostClass,
  CoverageReaderName,
  CoverageUnitKind,
  DecisionConsumers,
  DecisionsSectionV2,
  FallbackSeat,
  FleetInstallation,
  FleetInstallationV2,
  ForgeSection,
  ForgeSectionV2,
  HostRole,
  HostSection,
  HostRunnerSection,
  LiveTailPolicy,
  PolicySection,
  ProcedureCoverage,
  ReviewerSection,
  RunnerCapabilityDeclaration,
  RunnerSection,
  SeatHealth,
  SeatSection,
  SeatRole,
  ShelfSection,
  ShelfSectionV2,
  VerificationProcedure,
  VerificationProceduresSection,
  VerificationSection,
  WavesSection,
  WorktreeSection,
} from './types.js';

export type ParseResult =
  | { ok: true; installation: FleetInstallation }
  | { ok: false; errors: string[] };

type JsonObject = { readonly [key: string]: unknown };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const V1_ROOT_KEYS: readonly string[] = [
  'schemaVersion',
  'runner',
  'worktree',
  'verification',
  'forge',
  'reviewer',
  'waves',
  'shelf',
];
const V2_ROOT_KEYS: readonly string[] = [
  'schemaVersion',
  'hosts',
  'tools',
  'seats',
  'chains',
  'policy',
  'shelf',
  'forge',
  'verification',
  'waves',
  'decisions',
];
const RUNNER_KEYS: readonly string[] = [
  'agent',
  'model',
  'variant',
  'remotePort',
  'host',
  'ocmRunBin',
  'fallbackChain',
];
const WORKTREE_KEYS: readonly string[] = ['sshHost'];
const VERIFICATION_KEYS: readonly string[] = ['sshHost', 'procedures'];
const V2_VERIFICATION_KEYS: readonly string[] = ['procedures'];
const PROCEDURE_KEYS: readonly string[] = ['command', 'args', 'coverage'];
const PROCEDURE_COVERAGE_KEYS: readonly string[] = [
  'reader',
  'unitKind',
  'minUnits',
];
const READER_UNIT_KINDS: Readonly<Record<CoverageReaderName, CoverageUnitKind>> = {
  'vitest-summary': 'tests',
  'hexagen-lint-json': 'files',
  'eslint-json': 'files',
};
const FORGE_KEYS: readonly string[] = ['owner', 'repo'];
const SEAT_KEYS: readonly string[] = ['agent', 'model', 'variant'];
const WAVES_KEYS: readonly string[] = [
  'baseUrl',
  'tokenFile',
  'caFile',
  'ownerPublicKey',
];
const SHELF_KEYS: readonly string[] = ['baseUrl', 'keyFile'];
const HOST_KEYS: readonly string[] = [
  'transport',
  'sshAlias',
  'worktreeRoot',
  'tmpDir',
  'roles',
  'runner',
];
const HOST_RUNNER_KEYS: readonly string[] = [
  'kind',
  'port',
  'authFile',
  'capabilities',
  'maxLanes',
];
// An agy runner carries the mode and, for `full`, the security acknowledgement (D7).
const AGY_HOST_RUNNER_KEYS: readonly string[] = [
  ...HOST_RUNNER_KEYS,
  'agyMode',
  'agyAcknowledgement',
];
const AGY_ACKNOWLEDGEMENT_KEYS: readonly string[] = [
  'textVersion',
  'acceptedAt',
];
const CAPABILITY_KEYS: readonly string[] = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'filesystemScope',
];
const V2_SEAT_KEYS: readonly string[] = [
  'id',
  'tool',
  'model',
  'variant',
  'agent',
  'roles',
  'costClass',
  'health',
];
const CHAIN_KEYS: readonly (keyof ChainsSection)[] = [
  'implementer',
  'reviewer',
  'high-risk-reviewer',
  'fix',
];
const CHAIN_STEP_KEYS: readonly string[] = ['seatId', 'triggers'];
const POLICY_KEYS: readonly string[] = [
  'forbiddenRoutes',
  'perLaneCostCeiling',
  'useFreeSeats',
  'liveTail',
  'autoMerge',
];
const FORBIDDEN_ROUTE_KEYS: readonly string[] = ['tool', 'modelPattern'];
const LIVE_TAIL_KEYS: readonly string[] = ['content'];
const AUTO_MERGE_KEYS: readonly string[] = ['enabled', 'allowHighRisk', 'onBlocked'];
const GIT_SHELF_KEYS: readonly string[] = [
  'provider',
  'repoDir',
  'branch',
  'pathPrefix',
];
const GITHUB_FORGE_KEYS: readonly string[] = ['mode', 'owner', 'repo'];
const NO_DECISIONS_KEYS: readonly string[] = ['provider'];
const JEV_DECISIONS_KEYS: readonly string[] = [
  'provider',
  'model',
  'keyFile',
  'minConfidence',
  'monthlyBudgetUsd',
  'assumedCostPerCallUsd',
  'acknowledgeProseLeavesHost',
  'disabledProjects',
  'consumers',
];
const ANSWER_FILE_DECISIONS_KEYS: readonly string[] = [
  'provider',
  'answerFile',
  'consumers',
];
// Per-consumer settings (K3): two known consumers, each with its own keys.
const DECISION_CONSUMERS_KEYS: readonly (keyof DecisionConsumers)[] = [
  'knowledge-ranking',
  'claim-triage',
];
const KNOWLEDGE_RANKING_CONSUMER_KEYS: readonly string[] = [
  'minConfidence',
  'monthlyBudgetUsd',
];
const CLAIM_TRIAGE_CONSUMER_KEYS: readonly string[] = [
  'minConfidence',
  'monthlyBudgetUsd',
  'acknowledgeCandidateClaimsLeaveHost',
];

const HOST_ROLES: readonly HostRole[] = [
  'orchestrator',
  'lane-runner',
  'verifier',
];
const SEAT_ROLES: readonly SeatRole[] = [
  'implementer',
  'reviewer',
  'high-risk-reviewer',
];
const COST_CLASSES: readonly CostClass[] = ['free', 'plan-quota', 'paid'];
const SEAT_HEALTH_VALUES: readonly SeatHealth[] = ['healthy', 'unhealthy'];
const CHAIN_TRIGGERS: readonly ChainTrigger[] = [
  '429',
  '402',
  'timeout',
  'quota',
  'no-commit',
];

const PROCEDURE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FORBIDDEN_PROCEDURE_NAMES: ReadonlySet<string> = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'hasownproperty',
]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function collectUnknownKeys(
  record: JsonObject,
  allowedKeys: readonly string[],
  parentPath: string,
  errors: string[],
): void {
  const path = parentPath === '' ? 'installation' : parentPath;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}: unknown key`);
    }
  }
}

function readRequiredString(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  return readOptionalString(record, key, fieldPath, errors);
}

function readOptionalString(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isNonEmptyString(value)) {
    errors.push(`${fieldPath}: must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function readOptionalPort(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    errors.push(`${fieldPath}: must be an integer 1..65535`);
    return undefined;
  }
  return value;
}

function readRequiredPort(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  return readOptionalPort(record, key, fieldPath, errors);
}

function readRequiredBoolean(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): boolean | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'boolean') {
    errors.push(`${fieldPath}: must be a boolean`);
    return undefined;
  }
  return value;
}

function readOptionalPositiveInteger(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push(`${fieldPath}: must be an integer 1 or greater`);
    return undefined;
  }
  return value;
}

function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function readRequiredHttpsUrl(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  return readOptionalHttpsUrl(record, key, fieldPath, errors);
}

function readOptionalHttpsUrl(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isNonEmptyString(value) || !isHttpsUrl(value.trim())) {
    errors.push(`${fieldPath}: must be an https URL`);
    return undefined;
  }
  return value.trim();
}

function readRequiredAbsolutePath(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  return readOptionalAbsolutePath(record, key, fieldPath, errors);
}

function readOptionalAbsolutePath(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isNonEmptyString(value) || !isAbsolute(value.trim())) {
    errors.push(`${fieldPath}: must be an absolute path`);
    return undefined;
  }
  return value.trim();
}

function isCanonicalBase64Of32Bytes(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  const buffer = Buffer.from(value, 'base64');
  return buffer.length === 32 && buffer.toString('base64') === value;
}

function readOptionalOwnerPublicKey(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'string' || !isCanonicalBase64Of32Bytes(value)) {
    errors.push(`${fieldPath}: must be base64 of exactly 32 bytes`);
    return undefined;
  }
  return value;
}

function readOptionalStringArray(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string[] | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    errors.push(`${fieldPath}: must be an array`);
    return undefined;
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isNonEmptyString(entry)) {
      errors.push(`${fieldPath}[${index}]: must be a non-empty string`);
      continue;
    }
    entries.push(entry.trim());
  }
  return entries;
}

/**
 * Build a seat (`agent`/`model` required, `variant` optional). Returns
 * `undefined` once any error is recorded; the caller then skips the seat.
 */
function buildSeat(
  entry: JsonObject,
  entryPath: string,
  errors: string[],
): FallbackSeat | undefined {
  const agent = readRequiredString(
    entry,
    'agent',
    `${entryPath}.agent`,
    errors,
  );
  const model = readRequiredString(
    entry,
    'model',
    `${entryPath}.model`,
    errors,
  );
  const variant = readOptionalString(
    entry,
    'variant',
    `${entryPath}.variant`,
    errors,
  );
  if (agent === undefined || model === undefined) {
    return undefined;
  }
  return {
    agent,
    model,
    ...(variant !== undefined ? { variant } : {}),
  };
}

function parseFallbackChain(
  section: JsonObject,
  errors: string[],
): readonly FallbackSeat[] | undefined {
  if (!Object.hasOwn(section, 'fallbackChain')) {
    return undefined;
  }
  const value = section.fallbackChain;
  if (!Array.isArray(value)) {
    errors.push('runner.fallbackChain: must be an array');
    return undefined;
  }
  const seats: FallbackSeat[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `runner.fallbackChain[${index}]`;
    const entry = value[index];
    if (!isJsonObject(entry)) {
      errors.push(`${entryPath}: must be an object`);
      continue;
    }
    collectUnknownKeys(entry, SEAT_KEYS, entryPath, errors);
    const seat = buildSeat(entry, entryPath, errors);
    if (seat !== undefined) {
      seats.push(seat);
    }
  }
  return seats;
}

function parseRunnerSection(
  value: JsonObject,
  errors: string[],
): RunnerSection | undefined {
  if (!Object.hasOwn(value, 'runner')) {
    return undefined;
  }
  const section = value.runner;
  if (!isJsonObject(section)) {
    errors.push('runner: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, RUNNER_KEYS, 'runner', errors);
  const agent = readRequiredString(section, 'agent', 'runner.agent', errors);
  const model = readRequiredString(section, 'model', 'runner.model', errors);
  const variant = readOptionalString(
    section,
    'variant',
    'runner.variant',
    errors,
  );
  const remotePort = readOptionalPort(
    section,
    'remotePort',
    'runner.remotePort',
    errors,
  );
  const host = readOptionalString(section, 'host', 'runner.host', errors);
  const ocmRunBin = readOptionalString(
    section,
    'ocmRunBin',
    'runner.ocmRunBin',
    errors,
  );
  const fallbackChain = parseFallbackChain(section, errors);
  if (agent === undefined || model === undefined) {
    return undefined;
  }
  const runner: RunnerSection = {
    agent,
    model,
    ...(variant !== undefined ? { variant } : {}),
    ...(remotePort !== undefined ? { remotePort } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(ocmRunBin !== undefined ? { ocmRunBin } : {}),
    ...(fallbackChain !== undefined ? { fallbackChain } : {}),
  };
  return runner;
}

function parseWorktreeSection(
  value: JsonObject,
  errors: string[],
): WorktreeSection | undefined {
  if (!Object.hasOwn(value, 'worktree')) {
    return undefined;
  }
  const section = value.worktree;
  if (!isJsonObject(section)) {
    errors.push('worktree: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, WORKTREE_KEYS, 'worktree', errors);
  const sshHost = readRequiredString(
    section,
    'sshHost',
    'worktree.sshHost',
    errors,
  );
  if (sshHost === undefined) {
    return undefined;
  }
  return { sshHost };
}

function parseProcedureCoverage(
  entry: JsonObject,
  procedurePath: string,
  errors: string[],
): ProcedureCoverage | undefined {
  if (!Object.hasOwn(entry, 'coverage')) {
    return undefined;
  }
  const p = `${procedurePath}.coverage`;
  const value = entry.coverage;
  if (!isJsonObject(value)) {
    errors.push(`${p}: must be an object`);
    return undefined;
  }
  collectUnknownKeys(value, PROCEDURE_COVERAGE_KEYS, p, errors);

  const reader = value.reader;
  if (!Object.hasOwn(value, 'reader')) {
    errors.push(`${p}.reader: required`);
    return undefined;
  }
  if (typeof reader !== 'string') {
    errors.push(
      `${p}.reader: must be one of vitest-summary, hexagen-lint-json, eslint-json`,
    );
    return undefined;
  }
  if (!Object.hasOwn(READER_UNIT_KINDS, reader)) {
    errors.push(
      `${p}.reader: must be one of vitest-summary, hexagen-lint-json, eslint-json`,
    );
    return undefined;
  }
  const readerName = reader as CoverageReaderName;

  const unitKind = value.unitKind;
  if (!Object.hasOwn(value, 'unitKind')) {
    errors.push(`${p}.unitKind: required`);
    return undefined;
  }
  if (unitKind !== 'tests' && unitKind !== 'files' && unitKind !== 'checks') {
    errors.push(`${p}.unitKind: must be one of tests, files, checks`);
    return undefined;
  }
  if (unitKind !== READER_UNIT_KINDS[readerName]) {
    errors.push(`${p}.unitKind: does not match the reader`);
    return undefined;
  }

  const minUnits = value.minUnits;
  if (!Object.hasOwn(value, 'minUnits')) {
    errors.push(`${p}.minUnits: required`);
    return undefined;
  }
  if (
    typeof minUnits !== 'number' ||
    !Number.isSafeInteger(minUnits) ||
    minUnits < 1
  ) {
    errors.push(`${p}.minUnits: must be an integer 1 or greater`);
    return undefined;
  }

  return { reader: readerName, unitKind, minUnits };
}

function parseProcedures(
  record: JsonObject,
  errors: string[],
): Readonly<Record<string, VerificationProcedure>> {
  const procedures: Record<string, VerificationProcedure> = Object.create(null);
  for (const name of Object.keys(record)) {
    if (
      !PROCEDURE_NAME_PATTERN.test(name) ||
      FORBIDDEN_PROCEDURE_NAMES.has(name.toLowerCase())
    ) {
      errors.push('verification.procedures: invalid procedure name');
      continue;
    }
    const procedurePath = `verification.procedures.${name}`;
    const entry = record[name];
    if (!isJsonObject(entry)) {
      errors.push(`${procedurePath}: must be an object`);
      continue;
    }
    collectUnknownKeys(entry, PROCEDURE_KEYS, procedurePath, errors);
    const command = readRequiredString(
      entry,
      'command',
      `${procedurePath}.command`,
      errors,
    );
    const args = readOptionalStringArray(
      entry,
      'args',
      `${procedurePath}.args`,
      errors,
    );
    const coverage = parseProcedureCoverage(entry, procedurePath, errors);
    if (command === undefined) {
      continue;
    }
    procedures[name] = {
      command,
      ...(args !== undefined ? { args } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
    };
  }
  return procedures;
}

function parseVerificationSection(
  value: JsonObject,
  errors: string[],
): VerificationSection | undefined {
  if (!Object.hasOwn(value, 'verification')) {
    return undefined;
  }
  const section = value.verification;
  if (!isJsonObject(section)) {
    errors.push('verification: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, VERIFICATION_KEYS, 'verification', errors);
  const sshHost = readOptionalString(
    section,
    'sshHost',
    'verification.sshHost',
    errors,
  );
  let procedures: Readonly<Record<string, VerificationProcedure>> | undefined;
  if (!Object.hasOwn(section, 'procedures')) {
    errors.push('verification.procedures: required');
  } else {
    const rawProcedures = section.procedures;
    if (!isJsonObject(rawProcedures)) {
      errors.push('verification.procedures: must be an object');
    } else {
      procedures = parseProcedures(rawProcedures, errors);
    }
  }
  if (procedures === undefined) {
    return undefined;
  }
  return {
    procedures,
    ...(sshHost !== undefined ? { sshHost } : {}),
  };
}

function parseForgeSection(
  value: JsonObject,
  errors: string[],
): ForgeSection | undefined {
  if (!Object.hasOwn(value, 'forge')) {
    return undefined;
  }
  const section = value.forge;
  if (!isJsonObject(section)) {
    errors.push('forge: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, FORGE_KEYS, 'forge', errors);
  const owner = readRequiredString(section, 'owner', 'forge.owner', errors);
  const repo = readRequiredString(section, 'repo', 'forge.repo', errors);
  if (owner === undefined || repo === undefined) {
    return undefined;
  }
  return { owner, repo };
}

function parseReviewerSection(
  value: JsonObject,
  errors: string[],
): ReviewerSection | undefined {
  if (!Object.hasOwn(value, 'reviewer')) {
    return undefined;
  }
  const section = value.reviewer;
  if (!isJsonObject(section)) {
    errors.push('reviewer: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, SEAT_KEYS, 'reviewer', errors);
  return buildSeat(section, 'reviewer', errors);
}

function parseWavesSection(
  value: JsonObject,
  errors: string[],
): WavesSection | undefined {
  if (!Object.hasOwn(value, 'waves')) {
    return undefined;
  }
  const section = value.waves;
  if (!isJsonObject(section)) {
    errors.push('waves: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, WAVES_KEYS, 'waves', errors);
  const baseUrl = readRequiredHttpsUrl(
    section,
    'baseUrl',
    'waves.baseUrl',
    errors,
  );
  const tokenFile = readRequiredAbsolutePath(
    section,
    'tokenFile',
    'waves.tokenFile',
    errors,
  );
  const caFile = readOptionalAbsolutePath(
    section,
    'caFile',
    'waves.caFile',
    errors,
  );
  const ownerPublicKey = readOptionalOwnerPublicKey(
    section,
    'ownerPublicKey',
    'waves.ownerPublicKey',
    errors,
  );
  if (baseUrl === undefined || tokenFile === undefined) {
    return undefined;
  }
  return {
    baseUrl,
    tokenFile,
    ...(caFile !== undefined ? { caFile } : {}),
    ...(ownerPublicKey !== undefined ? { ownerPublicKey } : {}),
  };
}

function parseShelfSection(
  value: JsonObject,
  errors: string[],
): ShelfSection | undefined {
  if (!Object.hasOwn(value, 'shelf')) {
    return undefined;
  }
  const section = value.shelf;
  if (!isJsonObject(section)) {
    errors.push('shelf: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, SHELF_KEYS, 'shelf', errors);
  const baseUrl = readRequiredHttpsUrl(
    section,
    'baseUrl',
    'shelf.baseUrl',
    errors,
  );
  const keyFile = readRequiredAbsolutePath(
    section,
    'keyFile',
    'shelf.keyFile',
    errors,
  );
  if (baseUrl === undefined || keyFile === undefined) {
    return undefined;
  }
  return { baseUrl, keyFile };
}

// ---------------------------------------------------------------------------
// Schema v2 sections
// ---------------------------------------------------------------------------

/**
 * The loader's host-map key rule, exported for the composition roots' adapters
 * (H3b): a host name passed to a runner adapter must be one the loader would
 * accept as a v2 `hosts` key, so an unvalidated name can never reach a
 * subprocess. The implementation lives in `@fleet/shared` so the runtime
 * adapters validate with the same rule without a cross-context dependency.
 */
export { isValidHostName };

function readRequiredEnum<T extends string>(
  record: JsonObject,
  key: string,
  fieldPath: string,
  allowed: readonly T[],
  problem: string,
  errors: string[],
): T | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  const value = record[key];
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  errors.push(`${fieldPath}: ${problem}`);
  return undefined;
}

function parseRunnerCapabilities(
  runner: JsonObject,
  runnerPath: string,
  errors: string[],
): RunnerCapabilityDeclaration | undefined {
  if (!Object.hasOwn(runner, 'capabilities')) {
    return undefined;
  }
  const section = runner.capabilities;
  const fieldPath = `${runnerPath}.capabilities`;
  if (!isJsonObject(section)) {
    errors.push(`${fieldPath}: must be an object`);
    return undefined;
  }
  collectUnknownKeys(section, CAPABILITY_KEYS, fieldPath, errors);
  const networkEgressRestricted = readRequiredBoolean(
    section,
    'networkEgressRestricted',
    `${fieldPath}.networkEgressRestricted`,
    errors,
  );
  const cpuAndMemoryLimited = readRequiredBoolean(
    section,
    'cpuAndMemoryLimited',
    `${fieldPath}.cpuAndMemoryLimited`,
    errors,
  );
  const processTreeTermination = readRequiredBoolean(
    section,
    'processTreeTermination',
    `${fieldPath}.processTreeTermination`,
    errors,
  );
  const filesystemScope = readRequiredEnum(
    section,
    'filesystemScope',
    `${fieldPath}.filesystemScope`,
    ['scoped-worktree', 'inherited-directory'],
    'must be a known filesystem scope',
    errors,
  );
  if (
    networkEgressRestricted === undefined ||
    cpuAndMemoryLimited === undefined ||
    processTreeTermination === undefined ||
    filesystemScope === undefined
  ) {
    return undefined;
  }
  return {
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    filesystemScope,
  };
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function parseAgyAcknowledgement(
  runner: JsonObject,
  runnerPath: string,
  errors: string[],
): { textVersion: string; acceptedAt: string } | undefined {
  if (!Object.hasOwn(runner, 'agyAcknowledgement')) {
    return undefined;
  }
  const section = runner.agyAcknowledgement;
  const fieldPath = `${runnerPath}.agyAcknowledgement`;
  if (!isJsonObject(section)) {
    errors.push(`${fieldPath}: must be an object`);
    return undefined;
  }
  collectUnknownKeys(section, AGY_ACKNOWLEDGEMENT_KEYS, fieldPath, errors);
  const textVersion = readRequiredString(
    section,
    'textVersion',
    `${fieldPath}.textVersion`,
    errors,
  );
  const acceptedAt = readRequiredString(
    section,
    'acceptedAt',
    `${fieldPath}.acceptedAt`,
    errors,
  );
  if (acceptedAt !== undefined && !isIsoTimestamp(acceptedAt)) {
    errors.push(`${fieldPath}.acceptedAt: must be an ISO 8601 timestamp`);
    return undefined;
  }
  if (textVersion === undefined || acceptedAt === undefined) {
    return undefined;
  }
  if (textVersion !== AGY_SECURITY_TEXT_VERSION) {
    errors.push(
      `${fieldPath}: agyAcknowledgement is stale; re-confirm with init or /settings`,
    );
    return undefined;
  }
  return { textVersion, acceptedAt };
}

function parseHostRunner(
  runner: JsonObject,
  runnerPath: string,
  errors: string[],
): HostRunnerSection | undefined {
  collectUnknownKeys(runner, AGY_HOST_RUNNER_KEYS, runnerPath, errors);
  const kind = readRequiredEnum(
    runner,
    'kind',
    `${runnerPath}.kind`,
    ['opencode', 'agy'],
    'must be a known runner kind',
    errors,
  );
  // The agy-only fields are unknown keys on an opencode runner (D7).
  if (kind === 'opencode') {
    for (const agyOnlyKey of ['agyMode', 'agyAcknowledgement']) {
      if (Object.hasOwn(runner, agyOnlyKey)) {
        errors.push(`${runnerPath}: unknown key`);
      }
    }
  }
  const port = readRequiredPort(runner, 'port', `${runnerPath}.port`, errors);
  const authFile = readOptionalAbsolutePath(
    runner,
    'authFile',
    `${runnerPath}.authFile`,
    errors,
  );
  const capabilities = parseRunnerCapabilities(runner, runnerPath, errors);
  const maxLanes = readOptionalPositiveInteger(
    runner,
    'maxLanes',
    `${runnerPath}.maxLanes`,
    errors,
  );
  let agyMode: 'edit-only' | 'full' | undefined;
  let agyAcknowledgement:
    { textVersion: string; acceptedAt: string } | undefined;
  if (kind === 'agy') {
    agyMode = readRequiredEnum(
      runner,
      'agyMode',
      `${runnerPath}.agyMode`,
      ['edit-only', 'full'],
      'must be a known agy runner mode',
      errors,
    );
    agyAcknowledgement = parseAgyAcknowledgement(runner, runnerPath, errors);
    // Loader rule (D7): `full` requires a declared isolation floor and a
    // current acknowledgement of the security text. The messages name the
    // field and the rule, never the file's values.
    if (agyMode === 'full') {
      const floorOk =
        capabilities !== undefined &&
        capabilities.filesystemScope === 'scoped-worktree' &&
        capabilities.networkEgressRestricted === true &&
        capabilities.processTreeTermination === true;
      if (!floorOk) {
        errors.push(
          `${runnerPath}.agyMode: full requires the declared isolation floor` +
            ' (scoped-worktree filesystem, restricted network egress, process tree termination)',
        );
      }
      if (!Object.hasOwn(runner, 'agyAcknowledgement')) {
        errors.push(
          `${runnerPath}.agyAcknowledgement: full requires an acknowledgement of the current security text`,
        );
      }
    }
  }
  if (kind === undefined || port === undefined) {
    return undefined;
  }
  const common = {
    port,
    ...(authFile !== undefined ? { authFile } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(maxLanes !== undefined ? { maxLanes } : {}),
  };
  if (kind === 'agy') {
    if (agyMode === undefined) {
      return undefined;
    }
    return {
      kind,
      ...common,
      agyMode,
      ...(agyAcknowledgement !== undefined ? { agyAcknowledgement } : {}),
    };
  }
  return { kind: 'opencode', ...common };
}

function parseRoles<T extends string>(
  entry: JsonObject,
  parentPath: string,
  allowed: readonly T[],
  problem: string,
  errors: string[],
): T[] | undefined {
  const rolesPath = `${parentPath}.roles`;
  if (!Object.hasOwn(entry, 'roles')) {
    errors.push(`${rolesPath}: required`);
    return undefined;
  }
  const value = entry.roles;
  if (!Array.isArray(value)) {
    errors.push(`${rolesPath}: must be an array`);
    return undefined;
  }
  const roles: T[] = [];
  let repeated = false;
  for (let index = 0; index < value.length; index += 1) {
    const role = value[index];
    if (
      typeof role !== 'string' ||
      !(allowed as readonly string[]).includes(role)
    ) {
      errors.push(`${rolesPath}[${index}]: ${problem}`);
      continue;
    }
    if ((roles as readonly string[]).includes(role)) {
      repeated = true;
      continue;
    }
    roles.push(role as T);
  }
  if (roles.length === 0) {
    errors.push(`${rolesPath}: at least one role is required`);
    return undefined;
  }
  if (repeated) {
    errors.push(`${rolesPath}: roles must not repeat`);
  }
  return roles;
}

/**
 * Validate that an SSH host string is safe to pass to subprocess commands.
 * Matches `^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$` and does not start with `-`.
 *
 * The same rule `WorkspaceAdapter` applies before an ssh destination reaches
 * an argv; it is copied here on purpose so the loader is the first gate, and
 * importing a context package into the loader would invert the dependency
 * direction.
 */
const SAFE_SSH_HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;

export function isSafeSshHost(host: string): boolean {
  if (typeof host !== 'string' || host.startsWith('-')) {
    return false;
  }
  const atIndex = host.indexOf('@');
  if (atIndex !== -1 && host.slice(atIndex + 1).startsWith('-')) {
    return false;
  }
  return SAFE_SSH_HOST_PATTERN.test(host);
}

function parseHost(
  entry: JsonObject,
  hostPath: string,
  errors: string[],
): HostSection | undefined {
  collectUnknownKeys(entry, HOST_KEYS, hostPath, errors);
  const transport = readRequiredEnum(
    entry,
    'transport',
    `${hostPath}.transport`,
    ['local', 'ssh'],
    'must be "local" or "ssh"',
    errors,
  );
  let sshAlias: string | undefined;
  if (Object.hasOwn(entry, 'sshAlias')) {
    if (transport === 'local') {
      errors.push(
        `${hostPath}.sshAlias: must be absent when transport is "local"`,
      );
    } else {
      sshAlias = readOptionalString(
        entry,
        'sshAlias',
        `${hostPath}.sshAlias`,
        errors,
      );
      if (sshAlias !== undefined && !isSafeSshHost(sshAlias)) {
        // The value never appears in the message: an alias is operator input.
        errors.push(
          `${hostPath}.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option`,
        );
        sshAlias = undefined;
      }
    }
  } else if (transport === 'ssh') {
    errors.push(`${hostPath}.sshAlias: required when transport is "ssh"`);
  }
  const worktreeRoot = readRequiredAbsolutePath(
    entry,
    'worktreeRoot',
    `${hostPath}.worktreeRoot`,
    errors,
  );
  const tmpDir = readOptionalAbsolutePath(
    entry,
    'tmpDir',
    `${hostPath}.tmpDir`,
    errors,
  );
  const roles = parseRoles(
    entry,
    hostPath,
    HOST_ROLES,
    'must be a known host role',
    errors,
  );
  let runner: HostRunnerSection | undefined;
  if (Object.hasOwn(entry, 'runner')) {
    const runnerValue = entry.runner;
    if (!isJsonObject(runnerValue)) {
      errors.push(`${hostPath}.runner: must be an object`);
    } else {
      runner = parseHostRunner(runnerValue, `${hostPath}.runner`, errors);
    }
  }
  if (
    transport === undefined ||
    worktreeRoot === undefined ||
    roles === undefined
  ) {
    return undefined;
  }
  // A lane-runner host without a runner block is an undeclared runner (D4):
  // the loader refuses it instead of deriving an undispatchable host.
  if (roles.includes('lane-runner') && !Object.hasOwn(entry, 'runner')) {
    errors.push(
      `${hostPath}.runner: required when the host holds the lane-runner role`,
    );
  }
  return {
    transport,
    ...(sshAlias !== undefined ? { sshAlias } : {}),
    worktreeRoot,
    ...(tmpDir !== undefined ? { tmpDir } : {}),
    roles,
    ...(runner !== undefined ? { runner } : {}),
  };
}

function parseV2Hosts(
  value: JsonObject,
  errors: string[],
): Readonly<Record<string, HostSection>> | undefined {
  if (!Object.hasOwn(value, 'hosts')) {
    errors.push('hosts: required');
    return undefined;
  }
  const section = value.hosts;
  if (!isJsonObject(section)) {
    errors.push('hosts: must be an object');
    return undefined;
  }
  const hosts: Record<string, HostSection> = Object.create(null);
  for (const name of Object.keys(section)) {
    if (!isValidHostName(name)) {
      errors.push('hosts: invalid host name');
      continue;
    }
    const entry = section[name];
    if (!isJsonObject(entry)) {
      errors.push(`hosts.${name}: must be an object`);
      continue;
    }
    const host = parseHost(entry, `hosts.${name}`, errors);
    if (host !== undefined) {
      hosts[name] = host;
    }
  }
  let orchestrators = 0;
  let laneRunners = 0;
  const dialPorts = new Map<number, string>();
  for (const [name, host] of Object.entries(hosts)) {
    if (host.roles.includes('orchestrator')) {
      orchestrators += 1;
      // The runtime always forces a local orchestrator executor, so an
      // orchestrator host reached over ssh could never run it (plan section 1).
      if (host.transport !== 'local') {
        errors.push(
          `hosts.${name}.transport: must be "local" when the host holds the orchestrator role`,
        );
      }
    }
    if (host.roles.includes('lane-runner')) {
      laneRunners += 1;
    }
    // Every host with a runner takes part in the dial-port rule, whatever the
    // runner kind: a local host dials its own `port`, an ssh host the
    // `port + 1` forward. Two equal dial ports would race for one server.
    if (host.runner !== undefined) {
      const dialPort =
        host.transport === 'local' ? host.runner.port : host.runner.port + 1;
      if (dialPort > 65535) {
        // An ssh host on 65535 would need forward port 65536, which cannot be bound.
        errors.push(
          `hosts.${name}.runner.port: must leave room for the ssh forward port`,
        );
      } else if (dialPorts.has(dialPort)) {
        errors.push(
          `hosts.${name}.runner.port: derived dial port must be unique across hosts`,
        );
      } else {
        dialPorts.set(dialPort, name);
      }
    }
  }
  if (orchestrators !== 1) {
    errors.push('hosts: exactly one host must hold the orchestrator role');
  }
  // At least one lane-runner host is required (H9a1); several lane-runner
  // hosts now load. The host a lane runs on is chosen when capacity is
  // reserved (H9a2), not here.
  if (laneRunners < 1) {
    errors.push('hosts: at least one host must hold the lane-runner role');
  }
  return hosts;
}

function parseV2Tools(
  value: JsonObject,
  errors: string[],
): string[] | undefined {
  if (!Object.hasOwn(value, 'tools')) {
    return undefined;
  }
  const section = value.tools;
  if (!Array.isArray(section)) {
    errors.push('tools: must be an array');
    return undefined;
  }
  const tools: string[] = [];
  let repeated = false;
  for (let index = 0; index < section.length; index += 1) {
    const entry = section[index];
    if (!isNonEmptyString(entry)) {
      errors.push(`tools[${index}]: must be a non-empty string`);
      continue;
    }
    const tool = entry.trim();
    if (tools.includes(tool)) {
      repeated = true;
      continue;
    }
    tools.push(tool);
  }
  if (repeated) {
    errors.push('tools: entries must be unique');
  }
  return tools;
}

function parseV2Seats(
  value: JsonObject,
  errors: string[],
): SeatSection[] | undefined {
  if (!Object.hasOwn(value, 'seats')) {
    return undefined;
  }
  const section = value.seats;
  if (!Array.isArray(section)) {
    errors.push('seats: must be an array');
    return undefined;
  }
  const seats: SeatSection[] = [];
  const seenIds = new Set<string>();
  let repeated = false;
  for (let index = 0; index < section.length; index += 1) {
    const seatPath = `seats[${index}]`;
    const entry = section[index];
    if (!isJsonObject(entry)) {
      errors.push(`${seatPath}: must be an object`);
      continue;
    }
    collectUnknownKeys(entry, V2_SEAT_KEYS, seatPath, errors);
    const id = readRequiredString(entry, 'id', `${seatPath}.id`, errors);
    const tool = readRequiredString(entry, 'tool', `${seatPath}.tool`, errors);
    const model = readRequiredString(
      entry,
      'model',
      `${seatPath}.model`,
      errors,
    );
    const variant = readOptionalString(
      entry,
      'variant',
      `${seatPath}.variant`,
      errors,
    );
    const agent = readOptionalString(
      entry,
      'agent',
      `${seatPath}.agent`,
      errors,
    );
    const roles = parseRoles(
      entry,
      seatPath,
      SEAT_ROLES,
      'must be a known seat role',
      errors,
    );
    const costClass = readRequiredEnum(
      entry,
      'costClass',
      `${seatPath}.costClass`,
      COST_CLASSES,
      'must be a known cost class',
      errors,
    );
    let health: SeatHealth | undefined;
    if (Object.hasOwn(entry, 'health')) {
      health = readRequiredEnum(
        entry,
        'health',
        `${seatPath}.health`,
        SEAT_HEALTH_VALUES,
        'must be healthy or unhealthy',
        errors,
      );
    }
    if (id !== undefined) {
      if (seenIds.has(id)) {
        repeated = true;
      } else {
        seenIds.add(id);
      }
    }
    if (
      id === undefined ||
      tool === undefined ||
      model === undefined ||
      roles === undefined ||
      costClass === undefined
    ) {
      continue;
    }
    seats.push({
      id,
      tool,
      model,
      ...(variant !== undefined ? { variant } : {}),
      ...(agent !== undefined ? { agent } : {}),
      roles,
      costClass,
      ...(health !== undefined ? { health } : {}),
    });
  }
  if (repeated) {
    errors.push('seats: seat ids must be unique');
  }
  return seats;
}

function parseChainSteps(
  entry: unknown,
  chainPath: string,
  errors: string[],
): ChainStep[] | undefined {
  if (!Array.isArray(entry)) {
    errors.push(`${chainPath}: must be an array`);
    return undefined;
  }
  if (entry.length === 0) {
    errors.push(`${chainPath}: must be a non-empty array`);
    return undefined;
  }
  const steps: ChainStep[] = [];
  for (let index = 0; index < entry.length; index += 1) {
    const stepPath = `${chainPath}[${index}]`;
    const step = entry[index];
    if (!isJsonObject(step)) {
      errors.push(`${stepPath}: must be an object`);
      continue;
    }
    collectUnknownKeys(step, CHAIN_STEP_KEYS, stepPath, errors);
    const seatId = readRequiredString(
      step,
      'seatId',
      `${stepPath}.seatId`,
      errors,
    );
    let triggers: ChainTrigger[] | undefined;
    if (Object.hasOwn(step, 'triggers')) {
      const triggerValue = step.triggers;
      if (!Array.isArray(triggerValue)) {
        errors.push(`${stepPath}.triggers: must be an array`);
      } else {
        const list: ChainTrigger[] = [];
        for (
          let triggerIndex = 0;
          triggerIndex < triggerValue.length;
          triggerIndex += 1
        ) {
          const trigger = triggerValue[triggerIndex];
          const known =
            typeof trigger === 'string'
              ? CHAIN_TRIGGERS.find((candidate) => candidate === trigger)
              : undefined;
          if (known === undefined) {
            errors.push(
              `${stepPath}.triggers[${triggerIndex}]: must be a known trigger`,
            );
            continue;
          }
          list.push(known);
        }
        triggers = list;
      }
    }
    if (seatId === undefined) {
      continue;
    }
    steps.push({
      seatId,
      ...(triggers !== undefined ? { triggers } : {}),
    });
  }
  return steps;
}

function parseV2Chains(
  value: JsonObject,
  knownSeatIds: ReadonlySet<string>,
  errors: string[],
): ChainsSection | undefined {
  if (!Object.hasOwn(value, 'chains')) {
    return undefined;
  }
  const section = value.chains;
  if (!isJsonObject(section)) {
    errors.push('chains: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, CHAIN_KEYS, 'chains', errors);
  const chains: Mutable<ChainsSection> = {};
  for (const role of CHAIN_KEYS) {
    if (!Object.hasOwn(section, role)) {
      continue;
    }
    const steps = parseChainSteps(section[role], `chains.${role}`, errors);
    if (steps === undefined) {
      continue;
    }
    for (let index = 0; index < steps.length; index += 1) {
      if (!knownSeatIds.has(steps[index].seatId)) {
        errors.push(`chains.${role}[${index}].seatId: unknown seat`);
      }
    }
    chains[role] = steps;
  }
  return chains;
}

function parseV2Policy(
  value: JsonObject,
  errors: string[],
): PolicySection | undefined {
  if (!Object.hasOwn(value, 'policy')) {
    return undefined;
  }
  const section = value.policy;
  if (!isJsonObject(section)) {
    errors.push('policy: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, POLICY_KEYS, 'policy', errors);
  let forbiddenRoutes: PolicySection['forbiddenRoutes'];
  if (Object.hasOwn(section, 'forbiddenRoutes')) {
    const routes = section.forbiddenRoutes;
    if (!Array.isArray(routes)) {
      errors.push('policy.forbiddenRoutes: must be an array');
    } else {
      const list: { tool: string; modelPattern: string }[] = [];
      for (let index = 0; index < routes.length; index += 1) {
        const routePath = `policy.forbiddenRoutes[${index}]`;
        const route = routes[index];
        if (!isJsonObject(route)) {
          errors.push(`${routePath}: must be an object`);
          continue;
        }
        collectUnknownKeys(route, FORBIDDEN_ROUTE_KEYS, routePath, errors);
        const tool = readRequiredString(
          route,
          'tool',
          `${routePath}.tool`,
          errors,
        );
        const modelPattern = readRequiredString(
          route,
          'modelPattern',
          `${routePath}.modelPattern`,
          errors,
        );
        if (tool === undefined || modelPattern === undefined) {
          continue;
        }
        list.push({ tool, modelPattern });
      }
      forbiddenRoutes = list;
    }
  }
  let perLaneCostCeiling: number | undefined;
  if (Object.hasOwn(section, 'perLaneCostCeiling')) {
    const ceiling = section.perLaneCostCeiling;
    if (
      typeof ceiling !== 'number' ||
      !Number.isFinite(ceiling) ||
      ceiling < 0
    ) {
      errors.push('policy.perLaneCostCeiling: must be a non-negative number');
    } else {
      perLaneCostCeiling = ceiling;
    }
  }
  let useFreeSeats: boolean | undefined;
  if (Object.hasOwn(section, 'useFreeSeats')) {
    const value = section.useFreeSeats;
    if (typeof value !== 'boolean') {
      errors.push('policy.useFreeSeats: must be a boolean');
    } else {
      useFreeSeats = value;
    }
  }
  const liveTail = parseLiveTailPolicy(section, errors);
  const autoMerge = parseAutoMergePolicy(section, errors);
  return {
    ...(forbiddenRoutes !== undefined ? { forbiddenRoutes } : {}),
    ...(perLaneCostCeiling !== undefined ? { perLaneCostCeiling } : {}),
    ...(useFreeSeats !== undefined ? { useFreeSeats } : {}),
    ...(liveTail !== undefined ? { liveTail } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}),
  };
}

function parseLiveTailPolicy(
  section: JsonObject,
  errors: string[],
): LiveTailPolicy | undefined {
  if (!Object.hasOwn(section, 'liveTail')) {
    return undefined;
  }
  const value = section.liveTail;
  if (!isJsonObject(value)) {
    errors.push('policy.liveTail: must be an object');
    return undefined;
  }
  collectUnknownKeys(value, LIVE_TAIL_KEYS, 'policy.liveTail', errors);
  if (!Object.hasOwn(value, 'content')) {
    errors.push('policy.liveTail.content: required');
    return undefined;
  }
  const content = value.content;
  if (content !== 'summaries' && content !== 'full') {
    errors.push('policy.liveTail.content: must be one of summaries, full');
    return undefined;
  }
  return { content };
}

function readAutoMergeBoolean(
  record: JsonObject,
  field: string,
  errors: string[],
): boolean {
  if (!Object.hasOwn(record, field)) {
    errors.push(`policy.autoMerge.${field}: required`);
    return false;
  }
  const value = record[field];
  if (typeof value !== 'boolean') {
    errors.push(`policy.autoMerge.${field}: must be a boolean`);
    return false;
  }
  return value;
}

function parseAutoMergePolicy(
  section: JsonObject,
  errors: string[],
): AutoMergePolicy | undefined {
  if (!Object.hasOwn(section, 'autoMerge')) {
    return undefined;
  }
  const value = section.autoMerge;
  if (!isJsonObject(value)) {
    errors.push('policy.autoMerge: must be an object');
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, AUTO_MERGE_KEYS, 'policy.autoMerge', errors);
  const enabled = readAutoMergeBoolean(value, 'enabled', errors);
  const allowHighRisk = readAutoMergeBoolean(value, 'allowHighRisk', errors);
  let onBlocked: AutoMergePolicy['onBlocked'] = 'ask-owner';
  if (!Object.hasOwn(value, 'onBlocked')) {
    errors.push('policy.autoMerge.onBlocked: required');
  } else {
    const candidate = value.onBlocked;
    if (candidate !== 'ask-owner' && candidate !== 'hold') {
      errors.push('policy.autoMerge.onBlocked: must be one of ask-owner, hold');
    } else {
      onBlocked = candidate;
    }
  }
  if (errors.length !== before) {
    return undefined;
  }
  return { enabled, allowHighRisk, onBlocked };
}

function parseV2Shelf(
  value: JsonObject,
  errors: string[],
): ShelfSectionV2 | undefined {
  if (!Object.hasOwn(value, 'shelf')) {
    return undefined;
  }
  const section = value.shelf;
  if (!isJsonObject(section)) {
    errors.push('shelf: must be an object');
    return undefined;
  }
  if (!Object.hasOwn(section, 'provider')) {
    collectUnknownKeys(section, GIT_SHELF_KEYS, 'shelf', errors);
    errors.push('shelf.provider: required');
    return undefined;
  }
  const provider = section.provider;
  if (provider === 'local') {
    collectUnknownKeys(section, ['provider'], 'shelf', errors);
    return { provider: 'local' };
  }
  if (provider === 'git') {
    collectUnknownKeys(section, GIT_SHELF_KEYS, 'shelf', errors);
    const repoDir = readRequiredAbsolutePath(
      section,
      'repoDir',
      'shelf.repoDir',
      errors,
    );
    const branch = readRequiredString(
      section,
      'branch',
      'shelf.branch',
      errors,
    );
    const pathPrefix = readRequiredString(
      section,
      'pathPrefix',
      'shelf.pathPrefix',
      errors,
    );
    if (
      repoDir === undefined ||
      branch === undefined ||
      pathPrefix === undefined
    ) {
      return undefined;
    }
    return { provider: 'git', repoDir, branch, pathPrefix };
  }
  collectUnknownKeys(section, GIT_SHELF_KEYS, 'shelf', errors);
  errors.push('shelf.provider: must be a known provider');
  return undefined;
}

function parseV2Forge(
  value: JsonObject,
  errors: string[],
): ForgeSectionV2 | undefined {
  // A v2 file always declares a forge mode (D6); only the v1 file and the
  // env-only setup may run without one.
  if (!Object.hasOwn(value, 'forge')) {
    errors.push('forge: required');
    return undefined;
  }
  const section = value.forge;
  if (!isJsonObject(section)) {
    errors.push('forge: must be an object');
    return undefined;
  }
  if (!Object.hasOwn(section, 'mode')) {
    collectUnknownKeys(section, GITHUB_FORGE_KEYS, 'forge', errors);
    errors.push('forge.mode: required');
    return undefined;
  }
  const mode = section.mode;
  if (mode === 'none') {
    collectUnknownKeys(section, ['mode'], 'forge', errors);
    return { mode: 'none' };
  }
  if (mode === 'github') {
    collectUnknownKeys(section, GITHUB_FORGE_KEYS, 'forge', errors);
    const owner = readRequiredString(section, 'owner', 'forge.owner', errors);
    const repo = readRequiredString(section, 'repo', 'forge.repo', errors);
    if (owner === undefined || repo === undefined) {
      return undefined;
    }
    return { mode: 'github', owner, repo };
  }
  collectUnknownKeys(section, GITHUB_FORGE_KEYS, 'forge', errors);
  errors.push('forge.mode: must be a known forge mode');
  return undefined;
}

function readOptionalFraction(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    errors.push(`${fieldPath}: must be a number between 0 and 1`);
    return undefined;
  }
  return value;
}

function readOptionalPositiveNumber(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${fieldPath}: must be a number greater than 0`);
    return undefined;
  }
  return value;
}

function readRequiredFraction(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  return readOptionalFraction(record, key, fieldPath, errors);
}

function readRequiredPositiveNumber(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    errors.push(`${fieldPath}: required`);
    return undefined;
  }
  return readOptionalPositiveNumber(record, key, fieldPath, errors);
}

/**
 * Parse the optional per-consumer settings map of a decisions block (K3, plan
 * section 2). Unknown consumer names and unknown keys inside an entry are
 * refused; `minConfidence` must be a finite number in [0,1]; a
 * `monthlyBudgetUsd` must be finite and greater than 0; the `claim-triage`
 * acknowledgement must be literally true whenever the entry is present.
 * Messages name the field, never the value.
 */
function parseDecisionConsumers(
  section: JsonObject,
  errors: string[],
): DecisionConsumers | undefined {
  if (!Object.hasOwn(section, 'consumers')) {
    return undefined;
  }
  const consumersValue = section.consumers;
  if (!isJsonObject(consumersValue)) {
    errors.push('decisions.consumers: must be an object');
    return undefined;
  }
  collectUnknownKeys(
    consumersValue,
    DECISION_CONSUMERS_KEYS,
    'decisions.consumers',
    errors,
  );
  const consumers: Mutable<DecisionConsumers> = {};
  if (Object.hasOwn(consumersValue, 'knowledge-ranking')) {
    const entry = consumersValue['knowledge-ranking'];
    const entryPath = 'decisions.consumers.knowledge-ranking';
    if (!isJsonObject(entry)) {
      errors.push(`${entryPath}: must be an object`);
    } else {
      collectUnknownKeys(
        entry,
        KNOWLEDGE_RANKING_CONSUMER_KEYS,
        entryPath,
        errors,
      );
      const minConfidence = readOptionalFraction(
        entry,
        'minConfidence',
        `${entryPath}.minConfidence`,
        errors,
      );
      const monthlyBudgetUsd = readOptionalPositiveNumber(
        entry,
        'monthlyBudgetUsd',
        `${entryPath}.monthlyBudgetUsd`,
        errors,
      );
      consumers['knowledge-ranking'] = {
        ...(minConfidence !== undefined ? { minConfidence } : {}),
        ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
      };
    }
  }
  if (Object.hasOwn(consumersValue, 'claim-triage')) {
    const entry = consumersValue['claim-triage'];
    const entryPath = 'decisions.consumers.claim-triage';
    if (!isJsonObject(entry)) {
      errors.push(`${entryPath}: must be an object`);
    } else {
      collectUnknownKeys(entry, CLAIM_TRIAGE_CONSUMER_KEYS, entryPath, errors);
      const minConfidence = readOptionalFraction(
        entry,
        'minConfidence',
        `${entryPath}.minConfidence`,
        errors,
      );
      const monthlyBudgetUsd = readOptionalPositiveNumber(
        entry,
        'monthlyBudgetUsd',
        `${entryPath}.monthlyBudgetUsd`,
        errors,
      );
      let acknowledged = false;
      if (!Object.hasOwn(entry, 'acknowledgeCandidateClaimsLeaveHost')) {
        errors.push(
          `${entryPath}.acknowledgeCandidateClaimsLeaveHost: required`,
        );
      } else if (entry.acknowledgeCandidateClaimsLeaveHost !== true) {
        errors.push(
          `${entryPath}.acknowledgeCandidateClaimsLeaveHost: must be true`,
        );
      } else {
        acknowledged = true;
      }
      if (acknowledged) {
        consumers['claim-triage'] = {
          ...(minConfidence !== undefined ? { minConfidence } : {}),
          ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
          acknowledgeCandidateClaimsLeaveHost: true,
        };
      }
    }
  }
  return consumers;
}

/**
 * A consumer `monthlyBudgetUsd` must not sit above the block's own
 * `monthlyBudgetUsd` (K3). Answer-file blocks carry no block budget, so the
 * check only runs when the block declares a valid one. The message names both
 * fields and never a value.
 */
function enforceConsumerSubBudgets(
  consumers: DecisionConsumers | undefined,
  blockMonthlyBudgetUsd: number | undefined,
  errors: string[],
): void {
  if (consumers === undefined || blockMonthlyBudgetUsd === undefined) {
    return;
  }
  for (const name of DECISION_CONSUMERS_KEYS) {
    const budget = consumers[name]?.monthlyBudgetUsd;
    if (budget !== undefined && budget > blockMonthlyBudgetUsd) {
      errors.push(
        `decisions.consumers.${name}.monthlyBudgetUsd: must not exceed decisions.monthlyBudgetUsd`,
      );
    }
  }
}

function parseV2Decisions(
  value: JsonObject,
  errors: string[],
): DecisionsSectionV2 | undefined {
  if (!Object.hasOwn(value, 'decisions')) {
    return undefined;
  }
  const section = value.decisions;
  if (!isJsonObject(section)) {
    errors.push('decisions: must be an object');
    return undefined;
  }
  if (!Object.hasOwn(section, 'provider')) {
    collectUnknownKeys(section, JEV_DECISIONS_KEYS, 'decisions', errors);
    errors.push('decisions.provider: required');
    return undefined;
  }
  const provider = section.provider;
  if (provider === 'none') {
    collectUnknownKeys(section, NO_DECISIONS_KEYS, 'decisions', errors);
    return { provider: 'none' };
  }
  if (provider === 'jev') {
    collectUnknownKeys(section, JEV_DECISIONS_KEYS, 'decisions', errors);
    const model = readRequiredString(
      section,
      'model',
      'decisions.model',
      errors,
    );
    const keyFile = readRequiredAbsolutePath(
      section,
      'keyFile',
      'decisions.keyFile',
      errors,
    );
    const minConfidence = readRequiredFraction(
      section,
      'minConfidence',
      'decisions.minConfidence',
      errors,
    );
    const monthlyBudgetUsd = readRequiredPositiveNumber(
      section,
      'monthlyBudgetUsd',
      'decisions.monthlyBudgetUsd',
      errors,
    );
    const assumedCostPerCallUsd = readRequiredPositiveNumber(
      section,
      'assumedCostPerCallUsd',
      'decisions.assumedCostPerCallUsd',
      errors,
    );
    let acknowledgedProse = false;
    if (!Object.hasOwn(section, 'acknowledgeProseLeavesHost')) {
      errors.push('decisions.acknowledgeProseLeavesHost: required');
    } else if (section.acknowledgeProseLeavesHost !== true) {
      errors.push('decisions.acknowledgeProseLeavesHost: must be true');
    } else {
      acknowledgedProse = true;
    }
    const disabledProjects = readOptionalStringArray(
      section,
      'disabledProjects',
      'decisions.disabledProjects',
      errors,
    );
    const consumers = parseDecisionConsumers(section, errors);
    // A consumer sub-budget must not exceed the block total; an invalid block
    // budget is refused on its own, so the comparison only runs on a valid one.
    enforceConsumerSubBudgets(consumers, monthlyBudgetUsd, errors);
    if (
      model === undefined ||
      keyFile === undefined ||
      minConfidence === undefined ||
      monthlyBudgetUsd === undefined ||
      assumedCostPerCallUsd === undefined ||
      !acknowledgedProse
    ) {
      return undefined;
    }
    return {
      provider: 'jev',
      model,
      keyFile,
      minConfidence,
      monthlyBudgetUsd,
      assumedCostPerCallUsd,
      acknowledgeProseLeavesHost: true,
      ...(disabledProjects !== undefined ? { disabledProjects } : {}),
      ...(consumers !== undefined ? { consumers } : {}),
    };
  }
  if (provider === 'answer-file') {
    collectUnknownKeys(
      section,
      ANSWER_FILE_DECISIONS_KEYS,
      'decisions',
      errors,
    );
    const answerFile = readRequiredAbsolutePath(
      section,
      'answerFile',
      'decisions.answerFile',
      errors,
    );
    // An answer-file block declares no block budget, so any finite positive
    // consumer sub-budget is accepted (K3).
    const consumers = parseDecisionConsumers(section, errors);
    if (answerFile === undefined) {
      return undefined;
    }
    return {
      provider: 'answer-file',
      answerFile,
      ...(consumers !== undefined ? { consumers } : {}),
    };
  }
  collectUnknownKeys(section, JEV_DECISIONS_KEYS, 'decisions', errors);
  errors.push('decisions.provider: must be a known provider');
  return undefined;
}

function parseV2Verification(
  value: JsonObject,
  errors: string[],
): VerificationProceduresSection | undefined {
  if (!Object.hasOwn(value, 'verification')) {
    return undefined;
  }
  const section = value.verification;
  if (!isJsonObject(section)) {
    errors.push('verification: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, V2_VERIFICATION_KEYS, 'verification', errors);
  if (!Object.hasOwn(section, 'procedures')) {
    errors.push('verification.procedures: required');
    return undefined;
  }
  const rawProcedures = section.procedures;
  if (!isJsonObject(rawProcedures)) {
    errors.push('verification.procedures: must be an object');
    return undefined;
  }
  return { procedures: parseProcedures(rawProcedures, errors) };
}

/**
 * Validate an already-decoded `installation/fleet.json` value, version 1 or 2.
 *
 * Every problem is collected as `"<json path>: <problem>"`; a field's value is
 * never echoed in an error. Unknown keys anywhere are rejected. A v1 file
 * carries only v1 sections, a v2 file only v2 sections, and the v2 rules
 * (exactly one orchestrator host on the local transport, exactly one
 * lane-runner host, unique derived dial ports, and a required forge section,
 * D6) hold.
 */
export function parseInstallation(value: unknown): ParseResult {
  if (!isJsonObject(value)) {
    return { ok: false, errors: ['installation: must be an object'] };
  }
  const version = value.schemaVersion;
  if (version === 2) {
    return parseInstallationV2(value);
  }
  return parseInstallationV1(value);
}

function parseInstallationV1(value: JsonObject): ParseResult {
  const errors: string[] = [];
  collectUnknownKeys(value, V1_ROOT_KEYS, 'installation', errors);

  if (!Object.hasOwn(value, 'schemaVersion')) {
    errors.push('schemaVersion: required');
  } else {
    const version = value.schemaVersion;
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version !== 1
    ) {
      errors.push('schemaVersion: must be 1 or 2');
    }
  }

  const runner = parseRunnerSection(value, errors);
  const worktree = parseWorktreeSection(value, errors);
  const verification = parseVerificationSection(value, errors);
  const forge = parseForgeSection(value, errors);
  const reviewer = parseReviewerSection(value, errors);
  const waves = parseWavesSection(value, errors);
  const shelf = parseShelfSection(value, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const installation: Mutable<FleetInstallation> = { schemaVersion: 1 };
  if (runner !== undefined) {
    installation.runner = runner;
  }
  if (worktree !== undefined) {
    installation.worktree = worktree;
  }
  if (verification !== undefined) {
    installation.verification = verification;
  }
  if (forge !== undefined) {
    installation.forge = forge;
  }
  if (reviewer !== undefined) {
    installation.reviewer = reviewer;
  }
  if (waves !== undefined) {
    installation.waves = waves;
  }
  if (shelf !== undefined) {
    installation.shelf = shelf;
  }
  return { ok: true, installation };
}

function parseInstallationV2(value: JsonObject): ParseResult {
  const errors: string[] = [];
  collectUnknownKeys(value, V2_ROOT_KEYS, 'installation', errors);

  const hosts = parseV2Hosts(value, errors);
  const tools = parseV2Tools(value, errors);
  const seats = parseV2Seats(value, errors);
  const knownSeatIds = new Set<string>((seats ?? []).map((seat) => seat.id));
  const chains = parseV2Chains(value, knownSeatIds, errors);
  const policy = parseV2Policy(value, errors);
  const shelf = parseV2Shelf(value, errors);
  const forge = parseV2Forge(value, errors);
  const verification = parseV2Verification(value, errors);
  const waves = parseWavesSection(value, errors);
  const decisions = parseV2Decisions(value, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (forge === undefined) {
    // Unreachable once errors is empty: parseV2Forge refuses a v2 file
    // without a forge section. The guard keeps the required type honest.
    return { ok: false, errors: [...errors, 'forge: required'] };
  }
  const installation: Mutable<FleetInstallationV2> = {
    schemaVersion: 2,
    hosts: hosts ?? {},
    forge,
  };
  if (tools !== undefined) {
    installation.tools = tools;
  }
  if (seats !== undefined) {
    installation.seats = seats;
  }
  if (chains !== undefined) {
    installation.chains = chains;
  }
  if (policy !== undefined) {
    installation.policy = policy;
  }
  if (shelf !== undefined) {
    installation.shelf = shelf;
  }
  if (verification !== undefined) {
    installation.verification = verification;
  }
  if (waves !== undefined) {
    installation.waves = waves;
  }
  if (decisions !== undefined) {
    installation.decisions = decisions;
  }
  return { ok: true, installation };
}
