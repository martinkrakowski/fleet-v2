import { isAbsolute } from 'node:path';

import type {
  ChainStep,
  ChainTrigger,
  ChainsSection,
  CostClass,
  FallbackSeat,
  FleetInstallation,
  FleetInstallationV2,
  ForgeSection,
  ForgeSectionV2,
  HostRole,
  HostSection,
  HostRunnerSection,
  PolicySection,
  ReviewerSection,
  RunnerCapabilityDeclaration,
  RunnerSection,
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
const PROCEDURE_KEYS: readonly string[] = ['command', 'args'];
const FORGE_KEYS: readonly string[] = ['owner', 'repo'];
const SEAT_KEYS: readonly string[] = ['agent', 'model', 'variant'];
const WAVES_KEYS: readonly string[] = ['baseUrl', 'tokenFile', 'caFile', 'ownerPublicKey'];
const SHELF_KEYS: readonly string[] = ['baseUrl', 'keyFile'];
const HOST_KEYS: readonly string[] = ['transport', 'sshAlias', 'worktreeRoot', 'tmpDir', 'roles', 'runner'];
const HOST_RUNNER_KEYS: readonly string[] = ['kind', 'port', 'authFile', 'capabilities', 'maxLanes'];
const CAPABILITY_KEYS: readonly string[] = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'filesystemScope',
];
const V2_SEAT_KEYS: readonly string[] = ['id', 'tool', 'model', 'variant', 'agent', 'roles', 'costClass'];
const CHAIN_KEYS: readonly (keyof ChainsSection)[] = ['implementer', 'reviewer', 'high-risk-reviewer'];
const CHAIN_STEP_KEYS: readonly string[] = ['seatId', 'triggers'];
const POLICY_KEYS: readonly string[] = ['forbiddenRoutes', 'perLaneCostCeiling'];
const FORBIDDEN_ROUTE_KEYS: readonly string[] = ['tool', 'modelPattern'];
const GIT_SHELF_KEYS: readonly string[] = ['provider', 'repoDir', 'branch', 'pathPrefix'];
const GITHUB_FORGE_KEYS: readonly string[] = ['mode', 'owner', 'repo'];

const HOST_ROLES: readonly HostRole[] = ['orchestrator', 'lane-runner', 'verifier'];
const SEAT_ROLES: readonly SeatRole[] = ['implementer', 'reviewer', 'high-risk-reviewer'];
const COST_CLASSES: readonly CostClass[] = ['free', 'plan-quota', 'paid'];
const CHAIN_TRIGGERS: readonly ChainTrigger[] = ['429', '402', 'timeout', 'quota', 'no-commit'];

const PROCEDURE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FORBIDDEN_PROCEDURE_NAMES: ReadonlySet<string> = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'hasownproperty',
]);
const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_HOST_NAMES: ReadonlySet<string> = new Set([
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
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
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
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
  const procedures: Record<string, VerificationProcedure> = Object.create(null);
  for (const name of Object.keys(record)) {
    if (!PROCEDURE_NAME_PATTERN.test(name) || FORBIDDEN_PROCEDURE_NAMES.has(name.toLowerCase())) {
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

// ---------------------------------------------------------------------------
// Schema v2 sections
// ---------------------------------------------------------------------------

function isValidHostName(name: string): boolean {
  return (
    name.length <= 128 &&
    HOST_NAME_PATTERN.test(name) &&
    !name.includes('..') &&
    !FORBIDDEN_HOST_NAMES.has(name.toLowerCase())
  );
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

function parseHostRunner(
  runner: JsonObject,
  runnerPath: string,
  errors: string[],
): HostRunnerSection | undefined {
  collectUnknownKeys(runner, HOST_RUNNER_KEYS, runnerPath, errors);
  const kind = readRequiredEnum(
    runner,
    'kind',
    `${runnerPath}.kind`,
    ['opencode'],
    'must be a known runner kind',
    errors,
  );
  const port = readRequiredPort(runner, 'port', `${runnerPath}.port`, errors);
  const authFile = readOptionalAbsolutePath(runner, 'authFile', `${runnerPath}.authFile`, errors);
  const capabilities = parseRunnerCapabilities(runner, runnerPath, errors);
  const maxLanes = readOptionalPositiveInteger(runner, 'maxLanes', `${runnerPath}.maxLanes`, errors);
  if (kind === undefined || port === undefined) {
    return undefined;
  }
  return {
    kind,
    port,
    ...(authFile !== undefined ? { authFile } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(maxLanes !== undefined ? { maxLanes } : {}),
  };
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
    if (typeof role !== 'string' || !(allowed as readonly string[]).includes(role)) {
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

function parseHost(entry: JsonObject, hostPath: string, errors: string[]): HostSection | undefined {
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
      errors.push(`${hostPath}.sshAlias: must be absent when transport is "local"`);
    } else {
      sshAlias = readOptionalString(entry, 'sshAlias', `${hostPath}.sshAlias`, errors);
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
  const tmpDir = readOptionalAbsolutePath(entry, 'tmpDir', `${hostPath}.tmpDir`, errors);
  const roles = parseRoles(entry, hostPath, HOST_ROLES, 'must be a known host role', errors);
  let runner: HostRunnerSection | undefined;
  if (Object.hasOwn(entry, 'runner')) {
    const runnerValue = entry.runner;
    if (!isJsonObject(runnerValue)) {
      errors.push(`${hostPath}.runner: must be an object`);
    } else {
      runner = parseHostRunner(runnerValue, `${hostPath}.runner`, errors);
    }
  }
  if (transport === undefined || worktreeRoot === undefined || roles === undefined) {
    return undefined;
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

function parseV2Hosts(value: JsonObject, errors: string[]): Readonly<Record<string, HostSection>> | undefined {
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
  for (const host of Object.values(hosts)) {
    if (host.roles.includes('orchestrator')) {
      orchestrators += 1;
    }
    if (host.roles.includes('lane-runner')) {
      laneRunners += 1;
    }
  }
  if (orchestrators !== 1) {
    errors.push('hosts: exactly one host must hold the orchestrator role');
  }
  if (laneRunners < 1) {
    errors.push('hosts: at least one host must hold the lane-runner role');
  }
  return hosts;
}

function parseV2Tools(value: JsonObject, errors: string[]): string[] | undefined {
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

function parseV2Seats(value: JsonObject, errors: string[]): SeatSection[] | undefined {
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
    const model = readRequiredString(entry, 'model', `${seatPath}.model`, errors);
    const variant = readOptionalString(entry, 'variant', `${seatPath}.variant`, errors);
    const agent = readOptionalString(entry, 'agent', `${seatPath}.agent`, errors);
    const roles = parseRoles(entry, seatPath, SEAT_ROLES, 'must be a known seat role', errors);
    const costClass = readRequiredEnum(
      entry,
      'costClass',
      `${seatPath}.costClass`,
      COST_CLASSES,
      'must be a known cost class',
      errors,
    );
    if (id !== undefined) {
      if (seenIds.has(id)) {
        repeated = true;
      } else {
        seenIds.add(id);
      }
    }
    if (id === undefined || tool === undefined || model === undefined || roles === undefined || costClass === undefined) {
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
    const seatId = readRequiredString(step, 'seatId', `${stepPath}.seatId`, errors);
    let triggers: ChainTrigger[] | undefined;
    if (Object.hasOwn(step, 'triggers')) {
      const triggerValue = step.triggers;
      if (!Array.isArray(triggerValue)) {
        errors.push(`${stepPath}.triggers: must be an array`);
      } else {
        const list: ChainTrigger[] = [];
        for (let triggerIndex = 0; triggerIndex < triggerValue.length; triggerIndex += 1) {
          const trigger = triggerValue[triggerIndex];
          const known =
            typeof trigger === 'string'
              ? CHAIN_TRIGGERS.find((candidate) => candidate === trigger)
              : undefined;
          if (known === undefined) {
            errors.push(`${stepPath}.triggers[${triggerIndex}]: must be a known trigger`);
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

function parseV2Policy(value: JsonObject, errors: string[]): PolicySection | undefined {
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
        const tool = readRequiredString(route, 'tool', `${routePath}.tool`, errors);
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
    if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0) {
      errors.push('policy.perLaneCostCeiling: must be a non-negative number');
    } else {
      perLaneCostCeiling = ceiling;
    }
  }
  return {
    ...(forbiddenRoutes !== undefined ? { forbiddenRoutes } : {}),
    ...(perLaneCostCeiling !== undefined ? { perLaneCostCeiling } : {}),
  };
}

function parseV2Shelf(value: JsonObject, errors: string[]): ShelfSectionV2 | undefined {
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
    const repoDir = readRequiredAbsolutePath(section, 'repoDir', 'shelf.repoDir', errors);
    const branch = readRequiredString(section, 'branch', 'shelf.branch', errors);
    const pathPrefix = readRequiredString(section, 'pathPrefix', 'shelf.pathPrefix', errors);
    if (repoDir === undefined || branch === undefined || pathPrefix === undefined) {
      return undefined;
    }
    return { provider: 'git', repoDir, branch, pathPrefix };
  }
  collectUnknownKeys(section, GIT_SHELF_KEYS, 'shelf', errors);
  errors.push('shelf.provider: must be a known provider');
  return undefined;
}

function parseV2Forge(value: JsonObject, errors: string[]): ForgeSectionV2 | undefined {
  if (!Object.hasOwn(value, 'forge')) {
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
 * carries only v1 sections, a v2 file only v2 sections, and the v2 host rules
 * (exactly one orchestrator, at least one lane-runner) hold.
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
    if (typeof version !== 'number' || !Number.isInteger(version) || version !== 1) {
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

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const installation: Mutable<FleetInstallationV2> = {
    schemaVersion: 2,
    hosts: hosts ?? {},
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
  if (forge !== undefined) {
    installation.forge = forge;
  }
  if (verification !== undefined) {
    installation.verification = verification;
  }
  if (waves !== undefined) {
    installation.waves = waves;
  }
  return { ok: true, installation };
}
