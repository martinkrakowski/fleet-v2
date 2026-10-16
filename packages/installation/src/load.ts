import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { FleetInstallation, FleetInstallationModel, RunnerSection } from './types.js';
import { deriveInstallationModel } from './model.js';
import { parseInstallation } from './parse.js';

export interface LoadOptions {
  file?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Policy rule hook (lane O5). The loader calls it with the derived model
   * after mapping; every returned string is a load error. Shape validation
   * happens in the parser regardless.
   */
  validatePolicy?: (installation: FleetInstallationModel) => string[];
}

export type LoadResult =
  | {
      status: 'absent';
      installation: FleetInstallation;
      model: FleetInstallationModel;
      warnings: string[];
    }
  | {
      status: 'loaded';
      file: string;
      installation: FleetInstallation;
      model: FleetInstallationModel;
      warnings: string[];
    }
  | { status: 'invalid'; file: string; errors: string[] };

type EnvRecord = Record<string, string | undefined>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function readErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

/**
 * Read an environment value, treating an empty or whitespace-only string as
 * unset. The returned value is trimmed.
 */
function readEnvironmentValue(env: EnvRecord, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function resolveInstallationFile(file: string | undefined, env: EnvRecord, cwd: string): string {
  if (file !== undefined) {
    return resolve(cwd, file);
  }
  const fromEnvironment = readEnvironmentValue(env, 'FLEET_INSTALLATION_FILE');
  if (fromEnvironment !== undefined) {
    return resolve(cwd, fromEnvironment);
  }
  return join(cwd, 'installation', 'fleet.json');
}

const REMOTE_PORT_PATTERN = /^\d+$/;

function parseRemotePort(value: string): number | undefined {
  if (!REMOTE_PORT_PATTERN.test(value)) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

interface OverrideOutcome {
  installation: FleetInstallation;
  errors: string[];
}

/**
 * Apply environment overrides after parsing. Only variables that are non-empty
 * after trim override a file value. A `runner` or `worktree` section created by
 * an override may be partial: fields the environment does not name stay absent.
 * The overrides configure the v1 sections, so they apply to v1 files and to an
 * absent file; a v2 file configures its hosts in the file itself.
 */
function applyEnvironmentOverrides(
  installation: FleetInstallation,
  env: EnvRecord,
): OverrideOutcome {
  const errors: string[] = [];

  const runner: Mutable<RunnerSection> =
    installation.runner !== undefined ? { ...installation.runner } : {};
  let runnerTouched = false;

  const agent = readEnvironmentValue(env, 'FLEET_RUNNER_AGENT');
  if (agent !== undefined) {
    runner.agent = agent;
    runnerTouched = true;
  }
  const model = readEnvironmentValue(env, 'FLEET_RUNNER_MODEL');
  if (model !== undefined) {
    runner.model = model;
    runnerTouched = true;
  }
  const variant = readEnvironmentValue(env, 'FLEET_RUNNER_VARIANT');
  if (variant !== undefined) {
    runner.variant = variant;
    runnerTouched = true;
  }
  const host = readEnvironmentValue(env, 'OCM_HOST');
  if (host !== undefined) {
    runner.host = host;
    runnerTouched = true;
  }
  const ocmRunBin = readEnvironmentValue(env, 'FLEET_OCM_RUN_BIN');
  if (ocmRunBin !== undefined) {
    runner.ocmRunBin = ocmRunBin;
    runnerTouched = true;
  }
  const remotePort = readEnvironmentValue(env, 'OCM_REMOTE_PORT');
  if (remotePort !== undefined) {
    runnerTouched = true;
    const port = parseRemotePort(remotePort);
    if (port === undefined) {
      errors.push('runner.remotePort: must be an integer 1..65535');
    } else {
      runner.remotePort = port;
    }
  }

  const worktreeDraft: { sshHost?: string } =
    installation.worktree !== undefined ? { ...installation.worktree } : {};
  const sshHost = readEnvironmentValue(env, 'FLEET_WORKTREE_SSH_HOST');
  if (sshHost !== undefined) {
    worktreeDraft.sshHost = sshHost;
  }

  const merged: Mutable<FleetInstallation> = { ...installation };
  if (installation.runner !== undefined || runnerTouched) {
    merged.runner = runner;
  }
  if (worktreeDraft.sshHost !== undefined) {
    merged.worktree = { sshHost: worktreeDraft.sshHost };
  }
  return { installation: merged, errors };
}

/**
 * Load `installation/fleet.json`, version 1 or 2.
 *
 * A missing file is `absent` with the minimal installation; an unreadable file
 * or invalid JSON is `invalid` with error text that never includes the file
 * content. Environment overrides apply after parsing a v1 file or an absent
 * file, whatever its status. The result carries the parsed file as
 * `installation` and the derived v2 model with its runner capability sources
 * (D4) as `model`; `warnings` lists accepted-and-ignored v1 fields (D1). When
 * a `validatePolicy` hook is provided the loader calls it with the model and
 * treats every returned string as a load error.
 */
export function loadInstallation(options: LoadOptions = {}): LoadResult {
  const cwd = options.cwd ?? process.cwd();
  const env: EnvRecord = options.env ?? process.env;
  const file = resolveInstallationFile(options.file, env, cwd);

  let installation: FleetInstallation;
  let source: 'absent' | 'loaded';
  try {
    const raw = readFileSync(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'invalid', file, errors: [`${file}: invalid JSON`] };
    }
    const result = parseInstallation(parsed);
    if (!result.ok) {
      return { status: 'invalid', file, errors: result.errors };
    }
    installation = result.installation;
    source = 'loaded';
  } catch (error) {
    if (readErrorCode(error) === 'ENOENT') {
      installation = { schemaVersion: 1 };
      source = 'absent';
    } else {
      return { status: 'invalid', file, errors: [`${file}: unreadable`] };
    }
  }

  const errors: string[] = [];
  if (installation.schemaVersion === 1) {
    const merged = applyEnvironmentOverrides(installation, env);
    errors.push(...merged.errors);
    installation = merged.installation;
  }
  const { model, warnings } = deriveInstallationModel(installation);
  if (options.validatePolicy !== undefined) {
    errors.push(...options.validatePolicy(model));
  }
  if (errors.length > 0) {
    return { status: 'invalid', file, errors };
  }
  if (source === 'loaded') {
    return { status: 'loaded', file, installation, model, warnings };
  }
  return { status: 'absent', installation, model, warnings };
}
