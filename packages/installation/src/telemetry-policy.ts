import { containsSecretShape } from '@fleet/shared';
import { isPlainRecord, readOwnDataProperty } from './policy-read.js';

import type { ResolvedTelemetryPolicy, TelemetryPolicy, TelemetryRoute } from './types.js';

/** Plan §3.2's project alias validator (also `projectName`). */
export const TELEMETRY_PROJECT_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const TELEMETRY_SALT_PATTERN = /^[0-9a-f]{64,256}$/;
export const TELEMETRY_SALT_MIN_DISTINCT = 8;
export const TELEMETRY_MAX_PROJECT_ALIASES = 64;
export const TELEMETRY_PROJECT_ID_MAX_LENGTH = 128;
export const TELEMETRY_ROUTES: readonly TelemetryRoute[] = Object.freeze(['collector', 'phoenix']);
export const TELEMETRY_POLICY_KEYS: readonly string[] = Object.freeze([
  'enabled', 'projectName', 'route', 'sampleRatio', 'sendCost', 'includeDryRun', 'projectAliases', 'salt',
]);
const FORBIDDEN_PROJECT_IDS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

function isAlias(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TELEMETRY_PROJECT_ALIAS_PATTERN.test(value) &&
    !containsSecretShape(value)
  );
}

function isRatio(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isProjectId(key: string): boolean {
  if (key.trim() === '' || key.length > TELEMETRY_PROJECT_ID_MAX_LENGTH) {
    return false;
  }
  if (FORBIDDEN_PROJECT_IDS.includes(key)) {
    return false;
  }
  if (containsSecretShape(key)) {
    return false;
  }
  return true;
}

function saltError(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !TELEMETRY_SALT_PATTERN.test(value) ||
    value.length % 2 !== 0
  ) {
    return 'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)';
  }
  if (new Set(value).size < TELEMETRY_SALT_MIN_DISTINCT) {
    return 'policy.telemetry.salt: looks like a placeholder; generate at least 32 random bytes';
  }
  return null;
}

export type TelemetryPolicyRead =
  | { readonly ok: true; readonly policy: TelemetryPolicy }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validate a `policy.telemetry` value. Never throws; errors are fixed strings that echo no value. */
export function readTelemetryPolicyBlock(value: unknown): TelemetryPolicyRead {
  try {
    if (!isPlainRecord(value)) {
      return { ok: false, errors: ['policy.telemetry: must be an object'] };
    }
    const record = value;
    const errors: string[] = [];

    for (const key of Object.keys(record)) {
      if (!TELEMETRY_POLICY_KEYS.includes(key)) {
        errors.push('policy.telemetry: unknown key');
      }
    }

    let enabled: boolean | undefined;
    if (!Object.hasOwn(record, 'enabled')) {
      errors.push('policy.telemetry.enabled: required');
    } else {
      const enabledValue = readOwnDataProperty(record, 'enabled');
      if (typeof enabledValue !== 'boolean') {
        errors.push('policy.telemetry.enabled: must be a boolean');
      } else {
        enabled = enabledValue;
      }
    }

    let projectName: string | undefined;
    if (Object.hasOwn(record, 'projectName')) {
      const value = readOwnDataProperty(record, 'projectName');
      if (!isAlias(value)) {
        errors.push(
          'policy.telemetry.projectName: must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
        );
      } else {
        projectName = value;
      }
    }

    let route: TelemetryRoute | undefined;
    if (Object.hasOwn(record, 'route')) {
      const routeValue = readOwnDataProperty(record, 'route');
      if (routeValue === 'collector' || routeValue === 'phoenix') {
        route = routeValue;
      } else {
        errors.push('policy.telemetry.route: must be one of collector, phoenix');
      }
    }

    let sampleRatio: number | undefined;
    if (Object.hasOwn(record, 'sampleRatio')) {
      const sampleRatioValue = readOwnDataProperty(record, 'sampleRatio');
      if (!isRatio(sampleRatioValue)) {
        errors.push('policy.telemetry.sampleRatio: must be a number from 0 to 1');
      } else {
        sampleRatio = sampleRatioValue;
      }
    }

    let sendCost: boolean | undefined;
    if (Object.hasOwn(record, 'sendCost')) {
      const sendCostValue = readOwnDataProperty(record, 'sendCost');
      if (typeof sendCostValue !== 'boolean') {
        errors.push('policy.telemetry.sendCost: must be a boolean');
      } else {
        sendCost = sendCostValue;
      }
    }

    let includeDryRun: boolean | undefined;
    if (Object.hasOwn(record, 'includeDryRun')) {
      const includeDryRunValue = readOwnDataProperty(record, 'includeDryRun');
      if (typeof includeDryRunValue !== 'boolean') {
        errors.push('policy.telemetry.includeDryRun: must be a boolean');
      } else {
        includeDryRun = includeDryRunValue;
      }
    }

    let projectAliases: Readonly<Record<string, string>> | undefined;
    if (Object.hasOwn(record, 'projectAliases')) {
      const aliasesValue = readOwnDataProperty(record, 'projectAliases');
      if (!isPlainRecord(aliasesValue)) {
        errors.push('policy.telemetry.projectAliases: must be an object');
      } else {
        const aliases = aliasesValue;
        if (Object.keys(aliases).length > TELEMETRY_MAX_PROJECT_ALIASES) {
          errors.push('policy.telemetry.projectAliases: at most 64 entries');
        }
        let badProjectId = false;
        let badAlias = false;
        let sharedAlias = false;
        const seenAliases = new Set<string>();
        for (const key of Object.keys(aliases)) {
          if (!isProjectId(key)) {
            badProjectId = true;
          }
          const alias = readOwnDataProperty(aliases, key);
          if (isAlias(alias)) {
            if (seenAliases.has(alias)) {
              sharedAlias = true;
            }
            seenAliases.add(alias);
          } else {
            badAlias = true;
          }
        }
        if (badProjectId) {
          errors.push(
            'policy.telemetry.projectAliases: every project id must be a non-empty id of at most 128 characters with no secret-shaped value',
          );
        }
        if (badAlias) {
          errors.push(
            'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
          );
        }
        if (sharedAlias) {
          errors.push('policy.telemetry.projectAliases: two projects share an alias');
        }
        if (!badProjectId && !badAlias && !sharedAlias) {
          const frozen: Record<string, string> = {};
          for (const key of Object.keys(aliases)) {
            frozen[key] = readOwnDataProperty(aliases, key) as string;
          }
          projectAliases = Object.freeze(frozen);
        }
      }
    }

    let salt: string | undefined;
    if (Object.hasOwn(record, 'salt')) {
      const saltValue = readOwnDataProperty(record, 'salt');
      const err = saltError(saltValue);
      if (err !== null) {
        errors.push(err);
      } else {
        salt = saltValue as string;
      }
    } else if (enabled === true) {
      errors.push('policy.telemetry.salt: required when enabled');
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    const policy: TelemetryPolicy = {
      enabled: enabled as boolean,
      ...(projectName !== undefined ? { projectName } : {}),
      ...(route !== undefined ? { route } : {}),
      ...(sampleRatio !== undefined ? { sampleRatio } : {}),
      ...(sendCost !== undefined ? { sendCost } : {}),
      ...(includeDryRun !== undefined ? { includeDryRun } : {}),
      ...(projectAliases !== undefined ? { projectAliases } : {}),
      ...(salt !== undefined ? { salt } : {}),
    };
    return { ok: true, policy };
  } catch {
    return { ok: false, errors: ['policy.telemetry: must be an object'] };
  }
}

/** Telemetry for an installation without `policy.telemetry`: off, no salt (plan §3.9, D12). Deeply frozen. */
export const DEFAULT_TELEMETRY_POLICY: ResolvedTelemetryPolicy = Object.freeze({
  enabled: false,
  projectName: 'fleet-lanes',
  route: 'collector',
  sampleRatio: 1,
  sendCost: true,
  includeDryRun: true,
  projectAliases: Object.freeze({}),
  salt: null,
});

/**
 * The effective telemetry policy: the block's values with every absent field defaulted, only when
 * `readTelemetryPolicyBlock` accepts it; absent or malformed anywhere is the whole default (off).
 * Always a fresh, deeply frozen object with the keys in TELEMETRY_POLICY_KEYS order.
 */
export function resolveTelemetryPolicy(policy: unknown): ResolvedTelemetryPolicy {
  const record = isPlainRecord(policy) ? policy : {};
  const block = readTelemetryPolicyBlock(readOwnDataProperty(record, 'telemetry'));
  if (!block.ok) {
    return Object.freeze({ ...DEFAULT_TELEMETRY_POLICY, projectAliases: Object.freeze({}) });
  }
  const read = block.policy;
  return Object.freeze({
    enabled: read.enabled,
    projectName: read.projectName ?? 'fleet-lanes',
    route: read.route ?? 'collector',
    sampleRatio: read.sampleRatio ?? 1,
    sendCost: read.sendCost ?? true,
    includeDryRun: read.includeDryRun ?? true,
    projectAliases: Object.freeze({ ...(read.projectAliases ?? {}) }),
    salt: read.salt ?? null,
  });
}
