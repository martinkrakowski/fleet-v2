import { isAbsolute } from 'node:path';

import {
  LANE_DIFF_SECRET_PATTERNS,
  SECRET_PATTERNS,
  containsSecretShape,
  isValidHostName,
} from '@fleet/shared';

import { AGY_SECURITY_TEXT_VERSION } from './agy-security.js';

import type {
  AutoMergePolicy,
  BoardPolicySection,
  ChainStep,
  ChainTrigger,
  ChainsSection,
  ConductorPolicy,
  ConductorReaperDiskPolicy,
  ConductorReaperPolicy,
  ConductorReaperRepairs,
  ConductorReaperWorktreePolicy,
  CostClass,
  CoverageReaderName,
  CoverageUnitKind,
  DaemonSection,
  DecisionConsumers,
  DecisionsSectionV2,
  FallbackSeat,
  FleetInstallation,
  FleetInstallationV2,
  ForgeSection,
  ForgeSectionV2,
  GateSlotSection,
  HostRole,
  HostSection,
  HostRunnerSection,
  HostTransport,
  LiveTailPolicy,
  MergeDaemonSection,
  MergePolicySection,
  MergeRepositoryPolicy,
  MergeVetoPolicy,
  PolicySection,
  ProcedureCoverage,
  ReviewerSection,
  RunnerCapabilityDeclaration,
  RunnerSection,
  SeatHealth,
  SeatSection,
  SeatRole,
  SeatsPolicy,
  ShelfSection,
  ShelfSectionV2,
  VerificationProcedure,
  VerificationProceduresSection,
  VerificationSection,
  WavesSection,
  WorktreeSection,
} from './types.js';

import {
  BOARD_BOUNDS,
  CONDUCTOR_MINUTE_BOUNDS,
  CONDUCTOR_REAPER_DISK_BOUNDS,
  CONDUCTOR_REAPER_WORKTREE_BOUNDS,
  DEFAULT_MERGE_DAEMON_POLICY,
  MERGE_POLICY_BOUNDS,
  parseMergeRepositoryKey,
} from './policy.js';
import { readOwnDataProperty } from './policy-read.js';
import {
  AGY_ACKNOWLEDGEMENT_KEYS,
  AGY_HOST_RUNNER_KEYS,
  AGY_ONLY_RUNNER_KEYS,
  ANSWER_FILE_DECISIONS_KEYS,
  AUTO_MERGE_KEYS,
  BOARD_KEYS,
  CAPABILITY_KEYS,
  CHAIN_KEYS,
  CHAIN_STEP_KEYS,
  CLAIM_TRIAGE_CONSUMER_KEYS,
  CONDUCTOR_KEYS,
  CONDUCTOR_REAPER_DISK_KEYS,
  CONDUCTOR_REAPER_KEYS,
  CONDUCTOR_REAPER_REPAIR_KINDS,
  CONDUCTOR_REAPER_WORKTREE_KEYS,
  DAEMON_KEYS,
  DECISION_CONSUMERS_KEYS,
  FORBIDDEN_ROUTE_KEYS,
  FORGE_KEYS,
  GATE_SLOT_KEYS,
  GITHUB_FORGE_KEYS,
  GIT_SHELF_KEYS,
  HOST_KEYS,
  HOST_ROLES,
  JEV_DECISIONS_KEYS,
  KNOWLEDGE_RANKING_CONSUMER_KEYS,
  LIVE_TAIL_KEYS,
  LOCAL_SHELF_KEYS,
  MERGE_KEYS,
  MERGE_REPO_KEYS,
  MERGE_VETO_KEYS,
  NO_DECISIONS_KEYS,
  NO_FORGE_KEYS,
  POLICY_DAEMON_KEYS,
  POLICY_KEYS,
  PROCEDURE_COVERAGE_KEYS,
  PROCEDURE_KEYS,
  RUNNER_KEYS,
  SEAT_KEYS,
  SHELF_KEYS,
  V1_ROOT_KEYS,
  V2_ROOT_KEYS,
  V2_SEAT_KEYS,
  V2_VERIFICATION_KEYS,
  VERIFICATION_KEYS,
  WAVES_KEYS,
  WORKTREE_KEYS,
} from './keys.js';

export { POLICY_KEYS };
import { readTelemetryPolicyBlock } from './telemetry-policy.js';
import { readSeatsPolicyBlock } from './seats-policy.js';

export type ParseResult =
  | { ok: true; installation: FleetInstallation; warnings?: string[] }
  | { ok: false; errors: string[] };

type JsonObject = { readonly [key: string]: unknown };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const READER_UNIT_KINDS: Readonly<Record<CoverageReaderName, CoverageUnitKind>> = {
  'vitest-summary': 'tests',
  'hexagen-lint-json': 'files',
  'eslint-json': 'files',
};
// Credential shapes a daemon field never carries: the raw string is checked
// (the value is never echoed), so a prefix anywhere in it refuses the path.
const DAEMON_CREDENTIAL_PATTERN =
  /ghp_|github_pat_|sk-|AKIA|PRIVATE KEY|xox[barps]-/;
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
/** Container names share the procedure-name shape; see parseHostContainer. */
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CONTAINER_NAME_LENGTH = 64;
/** The tunnel offset is bounded so a dial port stays far below 65535. */
const MAX_TUNNEL_OFFSET = 1024;
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

/**
 * A daemon section path field: an absolute path that carries no whitespace or
 * unit/shell metacharacters and no credential shape. Reuses
 * `readRequiredAbsolutePath`; every message names only the field.
 */
function readRequiredDaemonPath(
  record: JsonObject,
  key: string,
  fieldPath: string,
  errors: string[],
): string | undefined {
  const raw = record[key];
  const value = readRequiredAbsolutePath(record, key, fieldPath, errors);
  if (value === undefined) {
    return undefined;
  }
  // The credential check comes first so a value carrying both a credential
  // shape and a refused character reports `refused`, never the milder shape
  // error, and the credential prefix is never echoed either way.
  if (typeof raw === 'string' && DAEMON_CREDENTIAL_PATTERN.test(raw)) {
    errors.push(`${fieldPath}: refused`);
    return undefined;
  }
  if (/\s/.test(value) || /["'`\\{}%*?]/.test(value)) {
    errors.push(
      `${fieldPath}: must be an absolute path with no spaces or quotes`,
    );
    return undefined;
  }
  return value;
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

/** Refused once a v2 `hosts` key carries secret-shaped text; never echoes the key. */
export const HOST_NAME_SECRET_REFUSAL =
  'hosts: host name must not contain secret-shaped text; rename it with fleet hosts rename';

export const HOST_NAME_TOO_LONG = 'hosts: a host name is too long';

export const MAX_HOST_NAME_ARGUMENT_LENGTH = 4096;

/**
 * The ONE host-name secret screen: the shared legacy six plus the canonical
 * lane-diff seventeen. `containsSecretShape` alone scans only the legacy six,
 * so the union lives here and every hosts surface (loader, draft, CLI) uses it.
 */
export function hostNameHasSecretShape(name: string): boolean {
  return (
    typeof name === 'string' &&
    (containsSecretShape(name) ||
      LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(name)))
  );
}

/**
 * Replace every span of `text` that matches a screened secret shape (the same
 * union `hostNameHasSecretShape` tests) with `replacement`.
 */
export function redactSecretShapes(text: string, replacement: string): string {
  let out = text;
  for (const regex of [
    ...SECRET_PATTERNS,
    ...LANE_DIFF_SECRET_PATTERNS.map((pattern) => pattern.regex),
  ]) {
    out = out.replace(new RegExp(regex.source, 'g'), replacement);
  }
  return out;
}

/**
 * A long run of alphanumeric characters is the shape of an opaque token even
 * without a known prefix, so a host key carrying one is withheld from every
 * error line too — the loader still accepts such a key, but the key text is
 * never echoed back (HN1 fix round 1, finding 1).
 */
const HOST_KEY_TOKEN_RUN = /[A-Za-z0-9]{20,}/;

/** The placeholder that stands in for a host key the screen withholds. */
export const HOST_KEY_WITHHELD = '<host key withheld>';

/**
 * The key text an error line may carry: the key itself only when it passes
 * the secret screen, otherwise the withheld placeholder. A key the loader
 * refused for secret-shaped text and a key carrying a long opaque token run
 * are both withheld; an ordinary host name is echoed unchanged.
 */
export function screenHostKey(key: string): string {
  return typeof key === 'string' &&
    (hostNameHasSecretShape(key) || HOST_KEY_TOKEN_RUN.test(key))
    ? HOST_KEY_WITHHELD
    : key;
}

/** The placeholder that stands in for an error line the screen withholds. */
export const ERROR_LINE_WITHHELD =
  '<error line withheld: it carried secret-shaped text>';

/**
 * The last screen before any CLI line reaches the operator: a line carrying
 * secret-shaped text is withheld whole, because removing the matched text
 * would mean quoting it. Host keys are screened at their source
 * (`screenHostKey`); this is the defence in depth behind that.
 */
export function screenErrorLine(line: string): string {
  return typeof line === 'string' && containsSecretShape(line)
    ? ERROR_LINE_WITHHELD
    : line;
}

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

/** The largest gate slot count `runner.gateSlot.slots` accepts. */
const MAX_GATE_SLOTS = 4096;

function parseGateSlot(
  runner: JsonObject,
  runnerPath: string,
  errors: string[],
): GateSlotSection | undefined {
  if (!Object.hasOwn(runner, 'gateSlot')) {
    return undefined;
  }
  const section = runner.gateSlot;
  const fieldPath = `${runnerPath}.gateSlot`;
  if (!isJsonObject(section)) {
    errors.push(`${fieldPath}: must be an object`);
    return undefined;
  }
  collectUnknownKeys(section, GATE_SLOT_KEYS, fieldPath, errors);
  const path = readRequiredAbsolutePath(section, 'path', `${fieldPath}.path`, errors);
  if (!Object.hasOwn(section, 'slots')) {
    errors.push(`${fieldPath}.slots: required`);
  }
  const slots = readOptionalPositiveInteger(section, 'slots', `${fieldPath}.slots`, errors);
  if (path === undefined || slots === undefined) {
    return undefined;
  }
  // gate-slot opens one lock file per slot on every poll: keep the count small and exact.
  if (!Number.isSafeInteger(slots) || slots > MAX_GATE_SLOTS) {
    errors.push(`${fieldPath}.slots: must be an integer from 1 to ${MAX_GATE_SLOTS}`);
    return undefined;
  }
  return { path, slots };
}

/**
 * Read one optional own property without ever running a getter. An accessor
 * property is reported as `accessor`, never treated as an absent field, so
 * the caller refuses it with a typed message instead of accepting the file.
 */
function readOptionalDataField(
  record: JsonObject,
  key: string,
):
  | { readonly kind: 'absent' }
  | { readonly kind: 'accessor' }
  | { readonly kind: 'value'; readonly value: unknown } {
  if (!Object.hasOwn(record, key)) {
    return { kind: 'absent' };
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || 'get' in descriptor || 'set' in descriptor) {
    return { kind: 'accessor' };
  }
  return descriptor.value === undefined
    ? { kind: 'absent' }
    : { kind: 'value', value: descriptor.value };
}

/**
 * The optional `hosts.<name>.runner.tunnelOffset` field: how far above
 * `runner.port` the bundled runner program dials the server. The frozen
 * `bin/ocm-run` dials `port + 1` and refuses a different `OCM_PORT`, so the
 * file may only declare the offset that program implements; absent means 1.
 */
function parseRunnerTunnelOffset(
  runner: JsonObject,
  runnerPath: string,
  errors: string[],
): number | undefined {
  const fieldPath = `${runnerPath}.tunnelOffset`;
  // Read without running a getter; an accessor is refused, not absent.
  const field = readOptionalDataField(runner, 'tunnelOffset');
  if (field.kind === 'absent') {
    return undefined;
  }
  if (field.kind === 'accessor') {
    errors.push(`${fieldPath}: must be a plain data property`);
    return undefined;
  }
  const value = field.value;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_TUNNEL_OFFSET
  ) {
    errors.push(`${fieldPath}: must be an integer from 0 to ${MAX_TUNNEL_OFFSET}`);
    return undefined;
  }
  if (value !== 1) {
    errors.push(
      `${fieldPath}: must be 1 while the bundled runner program dials the server at port + 1`,
    );
    return undefined;
  }
  return value;
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
    for (const agyOnlyKey of AGY_ONLY_RUNNER_KEYS) {
      if (Object.hasOwn(runner, agyOnlyKey)) {
        errors.push(`${runnerPath}: unknown key`);
      }
    }
  }
  const port = readRequiredPort(runner, 'port', `${runnerPath}.port`, errors);
  const tunnelOffset = parseRunnerTunnelOffset(
    runner,
    runnerPath,
    errors,
  );
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
  const gateSlot = parseGateSlot(runner, runnerPath, errors);
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
    ...(tunnelOffset !== undefined ? { tunnelOffset } : {}),
    ...(authFile !== undefined ? { authFile } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(maxLanes !== undefined ? { maxLanes } : {}),
    ...(gateSlot !== undefined ? { gateSlot } : {}),
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

/**
 * The optional `hosts.<name>.container` field: a lowercase container name the
 * host's runner runs in. A refused value never appears in the message.
 */
function parseHostContainer(
  entry: JsonObject,
  hostPath: string,
  errors: string[],
): string | undefined {
  const fieldPath = `${hostPath}.container`;
  // An accessor property is refused, never treated as an absent field.
  const field = readOptionalDataField(entry, 'container');
  if (field.kind === 'absent') {
    return undefined;
  }
  if (field.kind === 'accessor') {
    errors.push(`${fieldPath}: must be a plain data property`);
    return undefined;
  }
  const value = field.value;
  if (typeof value !== 'string' || !isNonEmptyString(value)) {
    errors.push(`${fieldPath}: must be a non-empty string`);
    return undefined;
  }
  if (value !== value.trim()) {
    errors.push(`${fieldPath}: must not have leading or trailing whitespace`);
    return undefined;
  }
  const name = value;
  if (name.length > MAX_CONTAINER_NAME_LENGTH) {
    errors.push(`${fieldPath}: must be at most 64 characters`);
    return undefined;
  }
  // The credential check comes first, so a value carrying both a secret
  // shape and a bad identifier shape reports the credential refusal and
  // never the shape refusal.
  if (containsSecretShape(name)) {
    errors.push(`${fieldPath}: must not contain secret-shaped text`);
    return undefined;
  }
  if (!CONTAINER_NAME_PATTERN.test(name)) {
    errors.push(
      `${fieldPath}: must be a lowercase container name matching ^[a-z0-9][a-z0-9-]*$`,
    );
    return undefined;
  }
  return name;
}

/**
 * The optional `hosts.<name>.roleAliases` map: one ssh alias per held role
 * that overrides the host's own alias for that role. Only an ssh host may
 * declare it, only held roles may appear as keys, and every value must pass
 * the loader's own safe-host rule. A refused value never appears in the
 * message.
 */
function parseHostRoleAliases(
  entry: JsonObject,
  hostPath: string,
  transport: HostTransport | undefined,
  roles: readonly HostRole[] | undefined,
  errors: string[],
): Partial<Record<HostRole, string>> | undefined {
  const fieldPath = `${hostPath}.roleAliases`;
  // An accessor property is refused, never treated as an absent field.
  const field = readOptionalDataField(entry, 'roleAliases');
  if (field.kind === 'absent') {
    return undefined;
  }
  if (field.kind === 'accessor') {
    errors.push(`${fieldPath}: must be a plain data property`);
    return undefined;
  }
  const value = field.value;
  if (!isJsonObject(value)) {
    errors.push(`${fieldPath}: must be an object`);
    return undefined;
  }
  if (transport === 'local') {
    // A local host has no alias to override.
    errors.push(`${fieldPath}: must be absent when transport is "local"`);
    return undefined;
  }
  if (roles === undefined) {
    // The roles field already carried its own refusal; do not add more.
    return undefined;
  }
  const aliases: Partial<Record<HostRole, string>> = {};
  for (const key of Object.keys(value)) {
    if (!HOST_ROLES.includes(key as HostRole)) {
      // The key is operator input and never appears in the message.
      errors.push(`${fieldPath}: every key must be a known host role`);
      continue;
    }
    if (!roles.includes(key as HostRole)) {
      errors.push(`${fieldPath}.${key}: the host does not hold that role`);
      continue;
    }
    // Read through the record's own data property so a getter never runs.
    const rawAlias = readOwnDataProperty(value, key);
    if (!isNonEmptyString(rawAlias)) {
      errors.push(`${fieldPath}.${key}: must be a non-empty string`);
      continue;
    }
    // Validated as supplied: a padded alias is refused, never trimmed.
    const alias = rawAlias;
    if (!isSafeSshHost(alias)) {
      // The value never appears in the message: an alias is operator input.
      errors.push(
        `${fieldPath}.${key}: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option`,
      );
      continue;
    }
    aliases[key as HostRole] = alias;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
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
  const container = parseHostContainer(entry, hostPath, errors);
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
  const roleAliases = parseHostRoleAliases(
    entry,
    hostPath,
    transport,
    roles,
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
    ...(container !== undefined ? { container } : {}),
    ...(roleAliases !== undefined ? { roleAliases } : {}),
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
    // Every error line carries the key only through the screen: a
    // secret-shaped key, or one carrying a long opaque token run, is never
    // echoed (HN1 fix round 1, finding 1).
    const keyText = screenHostKey(name);
    const hostPath = `hosts.${keyText}`;
    if (hostNameHasSecretShape(name)) {
      errors.push(HOST_NAME_SECRET_REFUSAL);
      continue;
    }
    if (!isValidHostName(name)) {
      errors.push('hosts: invalid host name');
      continue;
    }
    const entry = section[name];
    if (!isJsonObject(entry)) {
      errors.push(`${hostPath}: must be an object`);
      continue;
    }
    const host = parseHost(entry, hostPath, errors);
    if (host !== undefined) {
      hosts[name] = host;
    }
  }
  let orchestrators = 0;
  let laneRunners = 0;
  const dialPorts = new Map<number, string>();
  for (const [name, host] of Object.entries(hosts)) {
    // These hosts parsed, but a key carrying a long opaque token run is
    // still never echoed (HN1 fix round 1, finding 1).
    const hostPath = `hosts.${screenHostKey(name)}`;
    if (host.roles.includes('orchestrator')) {
      orchestrators += 1;
      // The runtime always forces a local orchestrator executor, so an
      // orchestrator host reached over ssh could never run it (plan section 1).
      if (host.transport !== 'local') {
        errors.push(
          `${hostPath}.transport: must be "local" when the host holds the orchestrator role`,
        );
      }
    }
    if (host.roles.includes('lane-runner')) {
      laneRunners += 1;
    }
    // Every host with a runner takes part in the dial-port rule, whatever the
    // runner kind: a local host dials its own `port`, an ssh host the
    // `port + tunnelOffset` forward (the offset the bundled runner program
    // implements; absent means 1). Two equal dial ports would race for one
    // server.
    if (host.runner !== undefined) {
      const offset = host.runner.tunnelOffset ?? 1;
      const dialPort =
        host.transport === 'local' ? host.runner.port : host.runner.port + offset;
      if (dialPort > 65535) {
        // An ssh host on 65535 would need forward port 65536, which cannot be bound.
        errors.push(
          `${hostPath}.runner.port: must leave room for the ssh forward port`,
        );
      } else if (dialPorts.has(dialPort)) {
        errors.push(
          `${hostPath}.runner.port: derived dial port must be unique across hosts`,
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
  warnings: string[],
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
  const conductor = parseConductorPolicy(section, errors);
  const board = parseBoardPolicy(section, errors);
  const telemetry = parsePolicyBlock(section, 'telemetry', readTelemetryPolicyBlock, errors);
  const seats: SeatsPolicy | undefined = parsePolicyBlock(section, 'seats', readSeatsPolicyBlock, errors);
  const merge = parseMergePolicy(section, errors);
  const daemon = parseMergeDaemonPolicy(section, errors, warnings);
  return {
    ...(forbiddenRoutes !== undefined ? { forbiddenRoutes } : {}),
    ...(perLaneCostCeiling !== undefined ? { perLaneCostCeiling } : {}),
    ...(useFreeSeats !== undefined ? { useFreeSeats } : {}),
    ...(liveTail !== undefined ? { liveTail } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}),
    ...(conductor !== undefined ? { conductor } : {}),
    ...(board !== undefined ? { board } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(seats !== undefined ? { seats } : {}),
    ...(merge !== undefined ? { merge } : {}),
    ...(daemon !== undefined ? { daemon } : {}),
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
  // The field readers return placeholders on error; the errors.length guard
  // below discards them, so a placeholder never reaches the returned policy.
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

function readConductorBoolean(
  record: JsonObject,
  field: string,
  path: string,
  errors: string[],
  required: boolean,
): boolean | undefined {
  if (!Object.hasOwn(record, field)) {
    if (required) {
      errors.push(`${path}.${field}: required`);
    }
    return undefined;
  }
  const value = record[field];
  if (typeof value !== 'boolean') {
    errors.push(`${path}.${field}: must be a boolean`);
    return undefined;
  }
  return value;
}

function readConductorMinutes(
  record: JsonObject,
  field: string,
  path: string,
  bounds: Readonly<{ min: number; max: number }>,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = record[field];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    errors.push(`${path}.${field}: must be an integer ${bounds.min}..${bounds.max}`);
    return undefined;
  }
  return value;
}

function parseConductorRepairs(
  reaper: JsonObject,
  errors: string[],
): ConductorReaperRepairs | undefined {
  if (!Object.hasOwn(reaper, 'repairs')) {
    return undefined;
  }
  const value = reaper.repairs;
  if (!isJsonObject(value)) {
    errors.push('policy.conductor.reaper.repairs: must be an object');
    return undefined;
  }
  collectUnknownKeys(
    value,
    CONDUCTOR_REAPER_REPAIR_KINDS,
    'policy.conductor.reaper.repairs',
    errors,
  );
  const repairs: Mutable<ConductorReaperRepairs> = {};
  for (const kind of CONDUCTOR_REAPER_REPAIR_KINDS) {
    if (!Object.hasOwn(value, kind)) {
      continue;
    }
    const flag = readOwnDataProperty(value, kind);
    if (typeof flag !== 'boolean') {
      errors.push(`policy.conductor.reaper.repairs.${kind}: must be a boolean`);
      continue;
    }
    repairs[kind] = flag;
  }
  return repairs;
}

function readConductorReaperNumber(
  record: JsonObject,
  field: string,
  path: string,
  bounds: Readonly<{ min: number; max: number }>,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = readOwnDataProperty(record as Record<string, unknown>, field);
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    errors.push(`${path}.${field}: must be an integer ${bounds.min}..${bounds.max}`);
    return undefined;
  }
  return value;
}

function parseConductorWorktrees(
  reaper: JsonObject,
  errors: string[],
): ConductorReaperWorktreePolicy | undefined {
  if (!Object.hasOwn(reaper, 'worktrees')) {
    return undefined;
  }
  const value = readOwnDataProperty(reaper as Record<string, unknown>, 'worktrees');
  if (!isJsonObject(value)) {
    errors.push('policy.conductor.reaper.worktrees: must be an object');
    return undefined;
  }
  collectUnknownKeys(
    value,
    CONDUCTOR_REAPER_WORKTREE_KEYS,
    'policy.conductor.reaper.worktrees',
    errors,
  );
  const retentionHours = readConductorReaperNumber(
    value,
    'retentionHours',
    'policy.conductor.reaper.worktrees',
    CONDUCTOR_REAPER_WORKTREE_BOUNDS.retentionHours,
    errors,
  );
  const maxRemovalsPerPass = readConductorReaperNumber(
    value,
    'maxRemovalsPerPass',
    'policy.conductor.reaper.worktrees',
    CONDUCTOR_REAPER_WORKTREE_BOUNDS.maxRemovalsPerPass,
    errors,
  );
  const passBudgetSeconds = readConductorReaperNumber(
    value,
    'passBudgetSeconds',
    'policy.conductor.reaper.worktrees',
    CONDUCTOR_REAPER_WORKTREE_BOUNDS.passBudgetSeconds,
    errors,
  );
  return {
    ...(retentionHours !== undefined ? { retentionHours } : {}),
    ...(maxRemovalsPerPass !== undefined ? { maxRemovalsPerPass } : {}),
    ...(passBudgetSeconds !== undefined ? { passBudgetSeconds } : {}),
  };
}

function parseConductorDisk(
  reaper: JsonObject,
  errors: string[],
): ConductorReaperDiskPolicy | undefined {
  if (!Object.hasOwn(reaper, 'disk')) {
    return undefined;
  }
  const value = readOwnDataProperty(reaper as Record<string, unknown>, 'disk');
  if (!isJsonObject(value)) {
    errors.push('policy.conductor.reaper.disk: must be an object');
    return undefined;
  }
  collectUnknownKeys(
    value,
    CONDUCTOR_REAPER_DISK_KEYS,
    'policy.conductor.reaper.disk',
    errors,
  );
  const minFreePercent = readConductorReaperNumber(
    value,
    'minFreePercent',
    'policy.conductor.reaper.disk',
    CONDUCTOR_REAPER_DISK_BOUNDS.minFreePercent,
    errors,
  );
  const clearFreePercent = readConductorReaperNumber(
    value,
    'clearFreePercent',
    'policy.conductor.reaper.disk',
    CONDUCTOR_REAPER_DISK_BOUNDS.clearFreePercent,
    errors,
  );
  if ((minFreePercent ?? 15) >= (clearFreePercent ?? 20)) {
    errors.push('policy.conductor.reaper.disk: minFreePercent must be less than clearFreePercent');
  }
  return {
    ...(minFreePercent !== undefined ? { minFreePercent } : {}),
    ...(clearFreePercent !== undefined ? { clearFreePercent } : {}),
  };
}

function parseConductorReaper(
  conductor: JsonObject,
  errors: string[],
): ConductorReaperPolicy | undefined {
  if (!Object.hasOwn(conductor, 'reaper')) {
    return undefined;
  }
  const value = conductor.reaper;
  if (!isJsonObject(value)) {
    errors.push('policy.conductor.reaper: must be an object');
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, CONDUCTOR_REAPER_KEYS, 'policy.conductor.reaper', errors);
  const enabled = readConductorBoolean(value, 'enabled', 'policy.conductor.reaper', errors, true);
  const intervalMinutes = readConductorMinutes(
    value,
    'intervalMinutes',
    'policy.conductor.reaper',
    CONDUCTOR_MINUTE_BOUNDS.intervalMinutes,
    errors,
  );
  const graceMinutes = readConductorMinutes(
    value,
    'graceMinutes',
    'policy.conductor.reaper',
    CONDUCTOR_MINUTE_BOUNDS.graceMinutes,
    errors,
  );
  const staleStopMinutes = readConductorMinutes(
    value,
    'staleStopMinutes',
    'policy.conductor.reaper',
    CONDUCTOR_MINUTE_BOUNDS.staleStopMinutes,
    errors,
  );
  const repairs = parseConductorRepairs(value, errors);
  const worktrees = parseConductorWorktrees(value, errors);
  const disk = parseConductorDisk(value, errors);
  if (errors.length !== before || enabled === undefined) {
    return undefined;
  }
  return {
    enabled,
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
    ...(graceMinutes !== undefined ? { graceMinutes } : {}),
    ...(staleStopMinutes !== undefined ? { staleStopMinutes } : {}),
    ...(repairs !== undefined ? { repairs } : {}),
    ...(worktrees !== undefined ? { worktrees } : {}),
    ...(disk !== undefined ? { disk } : {}),
  };
}

function parseConductorPolicy(
  section: JsonObject,
  errors: string[],
): ConductorPolicy | undefined {
  if (!Object.hasOwn(section, 'conductor')) {
    return undefined;
  }
  const value = section.conductor;
  if (!isJsonObject(value)) {
    errors.push('policy.conductor: must be an object');
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, CONDUCTOR_KEYS, 'policy.conductor', errors);
  const enabled = readConductorBoolean(value, 'enabled', 'policy.conductor', errors, true);
  const stopGraceMinutes = readConductorMinutes(
    value,
    'stopGraceMinutes',
    'policy.conductor',
    CONDUCTOR_MINUTE_BOUNDS.stopGraceMinutes,
    errors,
  );
  const reaper = parseConductorReaper(value, errors);
  if (errors.length !== before || enabled === undefined) {
    return undefined;
  }
  return {
    enabled,
    ...(stopGraceMinutes !== undefined ? { stopGraceMinutes } : {}),
    ...(reaper !== undefined ? { reaper } : {}),
  };
}

function readBoardMinutes(
  record: JsonObject,
  field: string,
  bounds: Readonly<{ min: number; max: number }>,
  errors: string[],
): number | undefined {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  const value = readOwnDataProperty(record as Record<string, unknown>, field);
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    errors.push(`policy.board.${field}: must be an integer ${bounds.min}..${bounds.max}`);
    return undefined;
  }
  return value;
}

function parseBoardPolicy(
  section: JsonObject,
  errors: string[],
): BoardPolicySection | undefined {
  if (!Object.hasOwn(section, 'board')) {
    return undefined;
  }
  const value = readOwnDataProperty(section as Record<string, unknown>, 'board');
  if (!isJsonObject(value)) {
    errors.push('policy.board: must be an object');
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, BOARD_KEYS, 'policy.board', errors);
  const forgeStaleMinutes = readBoardMinutes(
    value,
    'forgeStaleMinutes',
    BOARD_BOUNDS.forgeStaleMinutes,
    errors,
  );
  const declarationTtlMinutes = readBoardMinutes(
    value,
    'declarationTtlMinutes',
    BOARD_BOUNDS.declarationTtlMinutes,
    errors,
  );
  const doneWindowDays = readBoardMinutes(
    value,
    'doneWindowDays',
    BOARD_BOUNDS.doneWindowDays,
    errors,
  );
  const forgeSyncMinutes = readBoardMinutes(
    value,
    'forgeSyncMinutes',
    BOARD_BOUNDS.forgeSyncMinutes,
    errors,
  );
  if (errors.length !== before) {
    return undefined;
  }
  return {
    ...(forgeStaleMinutes !== undefined ? { forgeStaleMinutes } : {}),
    ...(declarationTtlMinutes !== undefined ? { declarationTtlMinutes } : {}),
    ...(doneWindowDays !== undefined ? { doneWindowDays } : {}),
    ...(forgeSyncMinutes !== undefined ? { forgeSyncMinutes } : {}),
  };
}

function mergeRepositoryPath(key: string, index: number): string {
  const readable = parseMergeRepositoryKey(key) !== undefined && !containsSecretShape(key);
  const label = readable ? JSON.stringify(key) : `#${index}`;
  return `policy.merge.repos[${label}]`;
}

function readMergeText(
  record: JsonObject,
  field: string,
  path: string,
  bounds: Readonly<{ min: number; max: number }>,
  errors: string[],
): string | undefined {
  const value = record[field];
  if (typeof value !== 'string') {
    errors.push(`${path}.${field}: must be a string`);
    return undefined;
  }
  if (containsSecretShape(value)) {
    errors.push(`${path}.${field}: must not contain secret-shaped text`);
    return undefined;
  }
  if (value.length < bounds.min || value.length > bounds.max || value.trim() === '') {
    errors.push(
      `${path}.${field}: must be a non-blank string of ${bounds.min} to ${bounds.max} characters`,
    );
    return undefined;
  }
  return value;
}

function readMergeBoolean(
  record: JsonObject,
  field: string,
  path: string,
  errors: string[],
): boolean | undefined {
  const value = record[field];
  if (typeof value !== 'boolean') {
    errors.push(`${path}.${field}: must be a boolean`);
    return undefined;
  }
  return value;
}

function readMergeInteger(
  record: JsonObject,
  field: string,
  path: string,
  bounds: Readonly<{ min: number; max: number }>,
  errors: string[],
): number | undefined {
  const value = record[field];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    errors.push(`${path}.${field}: must be an integer between ${bounds.min} and ${bounds.max}`);
    return undefined;
  }
  return value;
}

function readMergeRequiredContexts(
  record: JsonObject,
  path: string,
  errors: string[],
): readonly string[] | undefined {
  const value = record.requiredContexts;
  const bounds = MERGE_POLICY_BOUNDS.requiredContexts;
  const lengths = MERGE_POLICY_BOUNDS.requiredContextLength;
  const field = `${path}.requiredContexts`;
  if (!Array.isArray(value)) {
    errors.push(`${field}: must be an array`);
    return undefined;
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    errors.push(`${field}: must hold ${bounds.min} to ${bounds.max} entries`);
    return undefined;
  }
  const contexts: string[] = [];
  let valid = true;
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = readOwnDataProperty(
      value as unknown as Record<string, unknown>,
      String(index),
    );
    if (typeof entry !== 'string') {
      errors.push(`${field}[${index}]: must be a string`);
      valid = false;
    } else if (containsSecretShape(entry)) {
      errors.push(`${field}[${index}]: must not contain secret-shaped text`);
      valid = false;
    } else if (entry.length < lengths.min || entry.length > lengths.max || entry.trim() === '') {
      errors.push(
        `${field}[${index}]: must be a non-blank string of ${lengths.min} to ${lengths.max} characters`,
      );
      valid = false;
    } else if (contexts.includes(entry)) {
      errors.push(`${field}[${index}]: must be unique`);
      valid = false;
    } else {
      contexts.push(entry);
    }
  }
  return valid ? contexts : undefined;
}

function parseMergeVeto(
  record: JsonObject,
  path: string,
  errors: string[],
): MergeVetoPolicy | undefined {
  const value = record.veto;
  const field = `${path}.veto`;
  if (!isJsonObject(value)) {
    errors.push(`${field}: must be an object`);
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, MERGE_VETO_KEYS, field, errors);
  let mode: MergeVetoPolicy['mode'];
  if (Object.hasOwn(value, 'mode')) {
    const candidate = value.mode;
    if (candidate !== 'off' && candidate !== 'shadow' && candidate !== 'live') {
      errors.push(`${field}.mode: must be one of off, shadow, live`);
    } else {
      mode = candidate;
    }
  }
  let holdConfidence: number | undefined;
  if (Object.hasOwn(value, 'holdConfidence')) {
    const candidate = value.holdConfidence;
    const bounds = MERGE_POLICY_BOUNDS.holdConfidence;
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      candidate < bounds.min ||
      candidate > bounds.max
    ) {
      errors.push(`${field}.holdConfidence: must be a number between ${bounds.min} and ${bounds.max}`);
    } else {
      holdConfidence = candidate;
    }
  }
  if (errors.length !== before) {
    return undefined;
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(holdConfidence !== undefined ? { holdConfidence } : {}),
  };
}

type MergeRepositoryFields = {
  readonly [K in keyof Omit<Required<MergeRepositoryPolicy>, 'projectId'>]:
    | Required<MergeRepositoryPolicy>[K]
    | undefined;
};

function ifPresent<T>(entry: JsonObject, field: string, read: () => T): T | undefined {
  return Object.hasOwn(entry, field) ? read() : undefined;
}

function checkMergeRepositoryKey(key: string, path: string, errors: string[]): void {
  if (parseMergeRepositoryKey(key) === undefined) {
    errors.push(`${path}: key must be <owner>/<repo>`);
  } else if (containsSecretShape(key)) {
    errors.push(`${path}: key must not contain secret-shaped text`);
  }
}

function readMergeProjectId(entry: JsonObject, path: string, errors: string[]): string | undefined {
  if (!Object.hasOwn(entry, 'projectId')) {
    errors.push(`${path}.projectId: required`);
    return undefined;
  }
  return readMergeText(entry, 'projectId', path, MERGE_POLICY_BOUNDS.projectIdLength, errors);
}

function buildMergeRepositoryPolicy(
  projectId: string,
  fields: MergeRepositoryFields,
): MergeRepositoryPolicy {
  const { shadow, unattended, requiredContexts, updateBranch } = fields;
  const { macosProcedure, maxAttempts, checksGraceMinutes, veto } = fields;
  return {
    projectId,
    ...(shadow !== undefined ? { shadow } : {}),
    ...(unattended !== undefined ? { unattended } : {}),
    ...(requiredContexts !== undefined ? { requiredContexts } : {}),
    ...(updateBranch !== undefined ? { updateBranch } : {}),
    ...(macosProcedure !== undefined ? { macosProcedure } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(checksGraceMinutes !== undefined ? { checksGraceMinutes } : {}),
    ...(veto !== undefined ? { veto } : {}),
  };
}

function parseMergeRepository(
  key: string,
  index: number,
  entry: unknown,
  errors: string[],
): MergeRepositoryPolicy | undefined {
  const path = mergeRepositoryPath(key, index);
  const before = errors.length;
  checkMergeRepositoryKey(key, path, errors);
  if (!isJsonObject(entry)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  collectUnknownKeys(entry, MERGE_REPO_KEYS, path, errors);
  const projectId = readMergeProjectId(entry, path, errors);
  const fields: MergeRepositoryFields = {
    shadow: ifPresent(entry, 'shadow', () => readMergeBoolean(entry, 'shadow', path, errors)),
    unattended: ifPresent(entry, 'unattended', () =>
      readMergeBoolean(entry, 'unattended', path, errors),
    ),
    requiredContexts: ifPresent(entry, 'requiredContexts', () =>
      readMergeRequiredContexts(entry, path, errors),
    ),
    updateBranch: ifPresent(entry, 'updateBranch', () =>
      readMergeBoolean(entry, 'updateBranch', path, errors),
    ),
    macosProcedure: ifPresent(entry, 'macosProcedure', () =>
      readMergeText(entry, 'macosProcedure', path, MERGE_POLICY_BOUNDS.macosProcedureLength, errors),
    ),
    maxAttempts: ifPresent(entry, 'maxAttempts', () =>
      readMergeInteger(entry, 'maxAttempts', path, MERGE_POLICY_BOUNDS.maxAttempts, errors),
    ),
    checksGraceMinutes: ifPresent(entry, 'checksGraceMinutes', () =>
      readMergeInteger(
        entry,
        'checksGraceMinutes',
        path,
        MERGE_POLICY_BOUNDS.checksGraceMinutes,
        errors,
      ),
    ),
    veto: ifPresent(entry, 'veto', () => parseMergeVeto(entry, path, errors)),
  };
  if (errors.length !== before || projectId === undefined) {
    return undefined;
  }
  return buildMergeRepositoryPolicy(projectId, fields);
}

function readMergeRepos(
  written: unknown,
  errors: string[],
): Record<string, MergeRepositoryPolicy> | undefined {
  if (!isJsonObject(written)) {
    errors.push('policy.merge.repos: must be an object');
    return undefined;
  }
  if (Object.keys(written).length > MERGE_POLICY_BOUNDS.repositories.max) {
    errors.push(`policy.merge.repos: at most ${MERGE_POLICY_BOUNDS.repositories.max} entries`);
    return undefined;
  }
  const repos: Record<string, MergeRepositoryPolicy> = {};
  let index = 0;
  for (const key of Object.keys(written)) {
    const entry = parseMergeRepository(key, index, written[key], errors);
    if (entry !== undefined) {
      repos[key] = entry;
    }
    index += 1;
  }
  return repos;
}

function parseMergePolicy(
  section: JsonObject,
  errors: string[],
): MergePolicySection | undefined {
  if (!Object.hasOwn(section, 'merge')) {
    return undefined;
  }
  const value = section.merge;
  if (!isJsonObject(value)) {
    errors.push('policy.merge: must be an object');
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, MERGE_KEYS, 'policy.merge', errors);
  const repos = ifPresent(value, 'repos', () => readMergeRepos(value.repos, errors));
  if (errors.length !== before) {
    return undefined;
  }
  return repos !== undefined ? { repos } : {};
}

function parseMergeDaemonPolicy(
  section: JsonObject,
  errors: string[],
  warnings: string[],
): MergeDaemonSection | undefined {
  if (!Object.hasOwn(section, 'daemon')) {
    return undefined;
  }
  const value = section.daemon;
  if (!isJsonObject(value)) {
    errors.push('policy.daemon: must be an object');
    return undefined;
  }
  const before = errors.length;
  collectUnknownKeys(value, POLICY_DAEMON_KEYS, 'policy.daemon', errors);
  const read = (field: 'intervalSeconds' | 'budgetSeconds' | 'settleSeconds'): number | undefined =>
    Object.hasOwn(value, field)
      ? readMergeInteger(value, field, 'policy.daemon', MERGE_POLICY_BOUNDS[field], errors)
      : undefined;
  const intervalSeconds = read('intervalSeconds');
  const budgetSeconds = read('budgetSeconds');
  const settleSeconds = read('settleSeconds');
  // PT1a: like `chainRefresh`, a bad `stallAfterMinutes` is a warning, never an error: it gates
  // only the stall attention, so it must not stop the installation from loading or the merge
  // pass from running. The raw value is kept so a write round-trips the operator's own text;
  // the resolver reads the default (30). The warning names the key and a code, never the value.
  const stallAfterMinutes: unknown = Object.hasOwn(value, 'stallAfterMinutes')
    ? value.stallAfterMinutes
    : undefined;
  const stallBounds = MERGE_POLICY_BOUNDS.stallAfterMinutes;
  if (
    Object.hasOwn(value, 'stallAfterMinutes') &&
    !(
      typeof stallAfterMinutes === 'number' &&
      Number.isInteger(stallAfterMinutes) &&
      stallAfterMinutes >= stallBounds.min &&
      stallAfterMinutes <= stallBounds.max
    )
  ) {
    warnings.push('policy.daemon.stallAfterMinutes: stall-after-minutes-invalid');
  }
  // PT1b1: like `stallAfterMinutes`, a bad `autoResumeMax` is a warning, never an error: it gates
  // only the auto-resume budget. The raw value is kept so a write round-trips the operator's own
  // text; the resolver reads the default (2). The warning names the key and a code, never the value.
  const autoResumeMax: unknown = Object.hasOwn(value, 'autoResumeMax')
    ? value.autoResumeMax
    : undefined;
  const autoResumeBounds = MERGE_POLICY_BOUNDS.autoResumeMax;
  if (
    Object.hasOwn(value, 'autoResumeMax') &&
    !(
      typeof autoResumeMax === 'number' &&
      Number.isInteger(autoResumeMax) &&
      autoResumeMax >= autoResumeBounds.min &&
      autoResumeMax <= autoResumeBounds.max
    )
  ) {
    warnings.push('policy.daemon.autoResumeMax: auto-resume-max-invalid');
  }
  // CO8a: an unknown or `live` `chainRefresh` is a warning, never an error:
  // the file still parses and the raw value round-trips so the operator sees
  // and fixes their own text. The warning names the key and the reason code
  // only, never the value.
  if (Object.hasOwn(value, 'chainRefresh') && value.chainRefresh !== 'shadow') {
    warnings.push('policy.daemon.chainRefresh: chain-refresh-mode-invalid');
  }
  if (
    errors.length === before &&
    (budgetSeconds ?? DEFAULT_MERGE_DAEMON_POLICY.budgetSeconds) >=
      (intervalSeconds ?? DEFAULT_MERGE_DAEMON_POLICY.intervalSeconds)
  ) {
    errors.push('policy.daemon.budgetSeconds: must be less than intervalSeconds');
  }
  if (errors.length !== before) {
    return undefined;
  }
  return {
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
    ...(budgetSeconds !== undefined ? { budgetSeconds } : {}),
    ...(settleSeconds !== undefined ? { settleSeconds } : {}),
    ...(Object.hasOwn(value, 'stallAfterMinutes')
      ? { stallAfterMinutes: stallAfterMinutes as MergeDaemonSection['stallAfterMinutes'] }
      : {}),
    ...(Object.hasOwn(value, 'autoResumeMax')
      ? { autoResumeMax: autoResumeMax as MergeDaemonSection['autoResumeMax'] }
      : {}),
    ...(Object.hasOwn(value, 'chainRefresh')
      ? { chainRefresh: value.chainRefresh as MergeDaemonSection['chainRefresh'] }
      : {}),
  };
}

function parsePolicyBlock<T>(
  section: JsonObject,
  key: string,
  read: (value: unknown) => { readonly ok: true; readonly policy: T } | { readonly ok: false; readonly errors: readonly string[] },
  errors: string[],
): T | undefined {
  if (!Object.hasOwn(section, key)) {
    return undefined;
  }
  const result = read(section[key]);
  if (!result.ok) {
    errors.push(...result.errors);
    return undefined;
  }
  return result.policy;
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
    collectUnknownKeys(section, LOCAL_SHELF_KEYS, 'shelf', errors);
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
    collectUnknownKeys(section, NO_FORGE_KEYS, 'forge', errors);
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

/**
 * Parse the optional v2 `daemon` section: five required absolute paths with no
 * whitespace, shell/unit metacharacters or credential shapes (CO6). Unknown
 * keys are refused; messages name only the field, never a value.
 */
function parseV2Daemon(
  value: JsonObject,
  errors: string[],
): DaemonSection | undefined {
  if (!Object.hasOwn(value, 'daemon')) {
    return undefined;
  }
  const section = value.daemon;
  if (!isJsonObject(section)) {
    errors.push('daemon: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, DAEMON_KEYS, 'daemon', errors);
  const nodePath = readRequiredDaemonPath(
    section,
    'nodePath',
    'daemon.nodePath',
    errors,
  );
  const cliPath = readRequiredDaemonPath(
    section,
    'cliPath',
    'daemon.cliPath',
    errors,
  );
  const stateDir = readRequiredDaemonPath(
    section,
    'stateDir',
    'daemon.stateDir',
    errors,
  );
  const unitDir = readRequiredDaemonPath(
    section,
    'unitDir',
    'daemon.unitDir',
    errors,
  );
  const installationFile = readRequiredDaemonPath(
    section,
    'installationFile',
    'daemon.installationFile',
    errors,
  );
  if (
    nodePath === undefined ||
    cliPath === undefined ||
    stateDir === undefined ||
    unitDir === undefined ||
    installationFile === undefined
  ) {
    return undefined;
  }
  return { nodePath, cliPath, stateDir, unitDir, installationFile };
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
  try {
    if (!isJsonObject(value)) {
      return { ok: false, errors: ['installation: must be an object'] };
    }
    // Read the discriminator through the record's own data property so a
    // getter never runs.
    const version = readOwnDataProperty(value, 'schemaVersion');
    if (version === 2) {
      return parseInstallationV2(value);
    }
    return parseInstallationV1(value);
  } catch {
    return { ok: false, errors: ['installation: unreadable'] };
  }
}

function parseInstallationV1(value: JsonObject): ParseResult {
  const errors: string[] = [];
  collectUnknownKeys(value, V1_ROOT_KEYS, 'installation', errors);

  if (!Object.hasOwn(value, 'schemaVersion')) {
    errors.push('schemaVersion: required');
  } else {
    const version = readOwnDataProperty(value, 'schemaVersion');
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
  const warnings: string[] = [];
  collectUnknownKeys(value, V2_ROOT_KEYS, 'installation', errors);

  const hosts = parseV2Hosts(value, errors);
  const tools = parseV2Tools(value, errors);
  const seats = parseV2Seats(value, errors);
  const knownSeatIds = new Set<string>((seats ?? []).map((seat) => seat.id));
  const chains = parseV2Chains(value, knownSeatIds, errors);
  const policy = parseV2Policy(value, errors, warnings);
  const shelf = parseV2Shelf(value, errors);
  const forge = parseV2Forge(value, errors);
  const verification = parseV2Verification(value, errors);
  const waves = parseWavesSection(value, errors);
  const decisions = parseV2Decisions(value, errors);
  const daemon = parseV2Daemon(value, errors);

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
  if (daemon !== undefined) {
    installation.daemon = daemon;
  }
  return { ok: true, installation, ...(warnings.length > 0 ? { warnings } : {}) };
}
