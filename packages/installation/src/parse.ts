import { isAbsolute } from 'node:path';

import type {
  FallbackSeat,
  FleetInstallation,
  ForgeSection,
  ReviewerSection,
  RunnerSection,
  ShelfSection,
  VerificationProcedure,
  VerificationSection,
  WavesSection,
  WorktreeSection,
} from './types.js';

export type ParseResult =
  | { ok: true; installation: FleetInstallation }
  | { ok: false; errors: string[] };

type JsonObject = { readonly [key: string]: unknown };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const ROOT_KEYS: readonly string[] = [
  'schemaVersion',
  'runner',
  'worktree',
  'verification',
  'forge',
  'reviewer',
  'waves',
  'shelf',
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
const PROCEDURE_KEYS: readonly string[] = ['command', 'args'];
const FORGE_KEYS: readonly string[] = ['owner', 'repo'];
const SEAT_KEYS: readonly string[] = ['agent', 'model', 'variant'];
const WAVES_KEYS: readonly string[] = ['baseUrl', 'tokenFile', 'caFile', 'ownerPublicKey'];
const SHELF_KEYS: readonly string[] = ['baseUrl', 'keyFile'];

const PROCEDURE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function collectUnknownKeys(
  record: JsonObject,
  allowedKeys: readonly string[],
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      errors.push(prefix === '' ? `${key}: unknown key` : `${prefix}.${key}: unknown key`);
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    errors.push(`${fieldPath}: must be an integer 1..65535`);
    return undefined;
  }
  return value;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
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

function isBase64Of32Bytes(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').length === 32;
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
  if (typeof value !== 'string' || !isBase64Of32Bytes(value.trim())) {
    errors.push(`${fieldPath}: must be base64 of exactly 32 bytes`);
    return undefined;
  }
  return value.trim();
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
  const agent = readRequiredString(entry, 'agent', `${entryPath}.agent`, errors);
  const model = readRequiredString(entry, 'model', `${entryPath}.model`, errors);
  const variant = readOptionalString(entry, 'variant', `${entryPath}.variant`, errors);
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

function parseRunnerSection(value: JsonObject, errors: string[]): RunnerSection | undefined {
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
  const variant = readOptionalString(section, 'variant', 'runner.variant', errors);
  const remotePort = readOptionalPort(section, 'remotePort', 'runner.remotePort', errors);
  const host = readOptionalString(section, 'host', 'runner.host', errors);
  const ocmRunBin = readOptionalString(section, 'ocmRunBin', 'runner.ocmRunBin', errors);
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

function parseWorktreeSection(value: JsonObject, errors: string[]): WorktreeSection | undefined {
  if (!Object.hasOwn(value, 'worktree')) {
    return undefined;
  }
  const section = value.worktree;
  if (!isJsonObject(section)) {
    errors.push('worktree: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, WORKTREE_KEYS, 'worktree', errors);
  const sshHost = readRequiredString(section, 'sshHost', 'worktree.sshHost', errors);
  if (sshHost === undefined) {
    return undefined;
  }
  return { sshHost };
}

function parseProcedures(
  record: JsonObject,
  errors: string[],
): Readonly<Record<string, VerificationProcedure>> {
  const procedures: Record<string, VerificationProcedure> = {};
  for (const name of Object.keys(record)) {
    const procedurePath = `verification.procedures.${name}`;
    if (!PROCEDURE_NAME_PATTERN.test(name)) {
      errors.push(`${procedurePath}: procedure name must match ^[a-z0-9][a-z0-9-]*$`);
      continue;
    }
    const entry = record[name];
    if (!isJsonObject(entry)) {
      errors.push(`${procedurePath}: must be an object`);
      continue;
    }
    collectUnknownKeys(entry, PROCEDURE_KEYS, procedurePath, errors);
    const command = readRequiredString(entry, 'command', `${procedurePath}.command`, errors);
    const args = readOptionalStringArray(entry, 'args', `${procedurePath}.args`, errors);
    if (command === undefined) {
      continue;
    }
    procedures[name] = {
      command,
      ...(args !== undefined ? { args } : {}),
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
  const sshHost = readOptionalString(section, 'sshHost', 'verification.sshHost', errors);
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

function parseForgeSection(value: JsonObject, errors: string[]): ForgeSection | undefined {
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

function parseReviewerSection(value: JsonObject, errors: string[]): ReviewerSection | undefined {
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

function parseWavesSection(value: JsonObject, errors: string[]): WavesSection | undefined {
  if (!Object.hasOwn(value, 'waves')) {
    return undefined;
  }
  const section = value.waves;
  if (!isJsonObject(section)) {
    errors.push('waves: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, WAVES_KEYS, 'waves', errors);
  const baseUrl = readRequiredHttpsUrl(section, 'baseUrl', 'waves.baseUrl', errors);
  const tokenFile = readRequiredAbsolutePath(section, 'tokenFile', 'waves.tokenFile', errors);
  const caFile = readOptionalAbsolutePath(section, 'caFile', 'waves.caFile', errors);
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

function parseShelfSection(value: JsonObject, errors: string[]): ShelfSection | undefined {
  if (!Object.hasOwn(value, 'shelf')) {
    return undefined;
  }
  const section = value.shelf;
  if (!isJsonObject(section)) {
    errors.push('shelf: must be an object');
    return undefined;
  }
  collectUnknownKeys(section, SHELF_KEYS, 'shelf', errors);
  const baseUrl = readRequiredHttpsUrl(section, 'baseUrl', 'shelf.baseUrl', errors);
  const keyFile = readRequiredAbsolutePath(section, 'keyFile', 'shelf.keyFile', errors);
  if (baseUrl === undefined || keyFile === undefined) {
    return undefined;
  }
  return { baseUrl, keyFile };
}

/**
 * Validate an already-decoded `installation/fleet.json` value.
 *
 * Every problem is collected as `"<json path>: <problem>"`; a field's value is
 * never echoed in an error. Unknown keys anywhere are rejected.
 */
export function parseInstallation(value: unknown): ParseResult {
  if (!isJsonObject(value)) {
    return { ok: false, errors: ['installation: must be an object'] };
  }
  const errors: string[] = [];
  collectUnknownKeys(value, ROOT_KEYS, '', errors);

  if (!Object.hasOwn(value, 'schemaVersion')) {
    errors.push('schemaVersion: required');
  } else {
    const version = value.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version !== 1) {
      errors.push('schemaVersion: must be 1');
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
