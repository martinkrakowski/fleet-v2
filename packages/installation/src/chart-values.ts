/**
 * Pure validator for self-host deployment chart values (Plan FC-16.1).
 *
 * Untrusted input is read exactly once through `snapshotPlainData` from
 * `@fleet/shared`, which deep-copies plain JSON-like data into frozen objects
 * while refusing accessors, Proxies, cycles and bound overflows without
 * running a single trap or getter. Every further check walks only the frozen
 * snapshot, so the walk is `O(maxNodes)` time with `O(1)` set lookups.
 *
 * No-echo rule: no rejected value, key name, or snapshot path is ever
 * stringified, logged, or interpolated; every refusal carries `path: null`.
 */

import type {
  IsProxy,
  PlainDataLimits,
  PlainDataRefusalReason,
} from '@fleet/shared';
import { snapshotPlainData } from '@fleet/shared';

/** Domain-sized bounds: the full chart values have ~25 nodes and the schema
 * is at most 4 levels deep (root -> resources -> requests -> cpu). */
export const CHART_VALUES_LIMITS: Readonly<PlainDataLimits> = Object.freeze({
  maxDepth: 8,
  maxKeys: 32,
  maxArrayLength: 64,
  maxNodes: 128,
  maxStringLength: 4096,
});

/** Truly immutable view over a Set: `Object.freeze(new Set(...))` is NOT
 * enough, because freezing the Set object does not freeze its internal
 * slots, so `.add('extra')` would still mutate the exported allow-list and
 * make the validator accept an undocumented key. This view exposes only the
 * read operations of `ReadonlySet`, with no `add`/`delete`/`clear` at all. */
function frozenKeySet(keys: readonly string[]): ReadonlySet<string> {
  const inner = new Set(keys);
  const view: ReadonlySet<string> = {
    get size(): number {
      return inner.size;
    },
    has: (key: string) => inner.has(key),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    forEach: (callback, thisArg) =>
      inner.forEach((value, value2) => callback(value, value2, view), thisArg),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
  };
  return Object.freeze(view);
}

const ROOT_KEYS: ReadonlySet<string> = frozenKeySet([
  'replicaCount',
  'image',
  'service',
  'api',
  'web',
  'persistence',
  'serviceAccount',
  'resources',
  'stateDir',
]);

const IMAGE_KEYS: ReadonlySet<string> = frozenKeySet(['repository', 'tag', 'pullPolicy']);
const SERVICE_KEYS: ReadonlySet<string> = frozenKeySet(['type', 'port']);
const API_KEYS: ReadonlySet<string> = frozenKeySet(['host', 'port', 'allowRemote']);
const WEB_KEYS: ReadonlySet<string> = frozenKeySet(['apiUrl']);
const PERSISTENCE_KEYS: ReadonlySet<string> = frozenKeySet(['enabled', 'size', 'storageClass']);
const SERVICE_ACCOUNT_KEYS: ReadonlySet<string> = frozenKeySet(['create', 'name']);
const RESOURCES_KEYS: ReadonlySet<string> = frozenKeySet(['requests', 'limits']);
const RESOURCE_KEYS: ReadonlySet<string> = frozenKeySet(['cpu', 'memory']);

/** Documented allow-list per object level, keyed by dotted schema path
 * (`root` for the top-level object). Kept in exact parity with
 * `chart/values.schema.json` by a test that reads the schema. */
export const CHART_VALUES_ALLOWED_KEYS: Readonly<
  Record<string, ReadonlySet<string>>
> = Object.freeze({
  root: ROOT_KEYS,
  image: IMAGE_KEYS,
  service: SERVICE_KEYS,
  api: API_KEYS,
  web: WEB_KEYS,
  persistence: PERSISTENCE_KEYS,
  serviceAccount: SERVICE_ACCOUNT_KEYS,
  resources: RESOURCES_KEYS,
  'resources.requests': RESOURCE_KEYS,
  'resources.limits': RESOURCE_KEYS,
});

/** Hosted-only package and capability names; never valid in chart values. */
const HOSTED_KEYS: ReadonlySet<string> = frozenKeySet([
  'hosted',
  'cloud',
  'saas',
  'enterprise',
  'billing',
  'multiOrg',
  'multiTenant',
  'licenseKey',
  'licenceKey',
]);

const HOSTED_PREFIXES: readonly string[] = ['@fleet/hosted', 'fleet-hosted'];

const POLLUTING_KEYS: ReadonlySet<string> = frozenKeySet([
  '__proto__',
  'constructor',
  'prototype',
]);

export type ChartValuesRefusalReason =
  | PlainDataRefusalReason
  | 'not-object'
  | 'prototype-polluting-key'
  | 'hosted-key'
  | 'unknown-key'
  | 'invalid-type'
  | 'invalid-value';

export interface ChartValues {
  readonly replicaCount?: number;
  readonly image?: {
    readonly repository?: string;
    readonly tag?: string;
    readonly pullPolicy?: string;
  };
  readonly service?: {
    readonly type?: string;
    readonly port?: number;
  };
  readonly api?: {
    readonly host?: string;
    readonly port?: number;
    readonly allowRemote?: boolean;
  };
  readonly web?: {
    readonly apiUrl?: string;
  };
  readonly persistence?: {
    readonly enabled?: boolean;
    readonly size?: string;
    readonly storageClass?: string;
  };
  readonly serviceAccount?: {
    readonly create?: boolean;
    readonly name?: string;
  };
  readonly resources?: {
    readonly requests?: {
      readonly cpu?: string;
      readonly memory?: string;
    };
    readonly limits?: {
      readonly cpu?: string;
      readonly memory?: string;
    };
  };
  readonly stateDir?: string;
}

export type ChartValuesValidationResult =
  | { readonly ok: true; readonly values: ChartValues }
  | {
      readonly ok: false;
      readonly reason: ChartValuesRefusalReason;
      readonly path: null;
    };

type FieldFailure = { readonly ok: false; readonly reason: ChartValuesRefusalReason };

type StringResult =
  | { readonly ok: true; readonly value: string }
  | FieldFailure;

type NumberResult =
  | { readonly ok: true; readonly value: number }
  | FieldFailure;

type BooleanResult =
  | { readonly ok: true; readonly value: boolean }
  | FieldFailure;

type LevelResult =
  | { readonly ok: true; readonly clean: Record<string, unknown> }
  | { readonly ok: false; readonly reason: ChartValuesRefusalReason };

const PULL_POLICY_VALUES: readonly string[] = ['Always', 'IfNotPresent', 'Never'];
const SERVICE_TYPE_VALUES: readonly string[] = ['ClusterIP', 'NodePort', 'LoadBalancer'];

function isHostedKey(key: string): boolean {
  if (HOSTED_KEYS.has(key)) {
    return true;
  }
  return HOSTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function keyRefusal(
  object: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): ChartValuesRefusalReason | null {
  for (const key of Object.keys(object)) {
    if (POLLUTING_KEYS.has(key)) {
      return 'prototype-polluting-key';
    }
    if (isHostedKey(key)) {
      return 'hosted-key';
    }
    if (!allowed.has(key)) {
      return 'unknown-key';
    }
  }
  return null;
}

function level(value: unknown, allowed: ReadonlySet<string>): LevelResult {
  if (!isRecord(value)) {
    return { ok: false, reason: 'invalid-type' };
  }
  const refusal = keyRefusal(value, allowed);
  if (refusal !== null) {
    return { ok: false, reason: refusal };
  }
  return { ok: true, clean: value };
}

function nonEmptyString(value: unknown): StringResult {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'invalid-type' };
  }
  if (value.length === 0) {
    return { ok: false, reason: 'invalid-value' };
  }
  return { ok: true, value };
}

function anyString(value: unknown): StringResult {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'invalid-type' };
  }
  return { ok: true, value };
}

function boolean(value: unknown): BooleanResult {
  if (typeof value !== 'boolean') {
    return { ok: false, reason: 'invalid-type' };
  }
  return { ok: true, value };
}

function enumValue(value: unknown, allowed: readonly string[]): StringResult {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'invalid-type' };
  }
  if (!allowed.includes(value)) {
    return { ok: false, reason: 'invalid-value' };
  }
  return { ok: true, value };
}

function boundedInteger(value: unknown, min: number, max: number): NumberResult {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, reason: 'invalid-type' };
  }
  if (value < min || value > max) {
    return { ok: false, reason: 'invalid-value' };
  }
  return { ok: true, value };
}

function imageValues(clean: Record<string, unknown>): LevelResult {
  const out: {
    repository?: string;
    tag?: string;
    pullPolicy?: string;
  } = Object.create(null);
  if (hasOwn(clean, 'repository')) {
    const field = nonEmptyString(clean.repository);
    if (!field.ok) {
      return field;
    }
    out.repository = field.value;
  }
  if (hasOwn(clean, 'tag')) {
    const field = nonEmptyString(clean.tag);
    if (!field.ok) {
      return field;
    }
    out.tag = field.value;
  }
  if (hasOwn(clean, 'pullPolicy')) {
    const field = enumValue(clean.pullPolicy, PULL_POLICY_VALUES);
    if (!field.ok) {
      return field;
    }
    out.pullPolicy = field.value;
  }
  return { ok: true, clean: Object.freeze(out) };
}

function serviceValues(clean: Record<string, unknown>): LevelResult {
  const out: { type?: string; port?: number } = Object.create(null);
  if (hasOwn(clean, 'type')) {
    const field = enumValue(clean.type, SERVICE_TYPE_VALUES);
    if (!field.ok) {
      return field;
    }
    out.type = field.value;
  }
  if (hasOwn(clean, 'port')) {
    const field = boundedInteger(clean.port, 1, 65535);
    if (!field.ok) {
      return field;
    }
    out.port = field.value;
  }
  return { ok: true, clean: Object.freeze(out) };
}

function apiValues(clean: Record<string, unknown>): LevelResult {
  const out: { host?: string; port?: number; allowRemote?: boolean } = Object.create(null);
  if (hasOwn(clean, 'host')) {
    const field = nonEmptyString(clean.host);
    if (!field.ok) {
      return field;
    }
    out.host = field.value;
  }
  if (hasOwn(clean, 'port')) {
    const field = boundedInteger(clean.port, 1, 65535);
    if (!field.ok) {
      return field;
    }
    out.port = field.value;
  }
  if (hasOwn(clean, 'allowRemote')) {
    const field = boolean(clean.allowRemote);
    if (!field.ok) {
      return field;
    }
    out.allowRemote = field.value;
  }
  return { ok: true, clean: Object.freeze(out) };
}

function persistenceValues(clean: Record<string, unknown>): LevelResult {
  const out: { enabled?: boolean; size?: string; storageClass?: string } = Object.create(null);
  if (hasOwn(clean, 'enabled')) {
    const field = boolean(clean.enabled);
    if (!field.ok) {
      return field;
    }
    out.enabled = field.value;
  }
  if (hasOwn(clean, 'size')) {
    const field = nonEmptyString(clean.size);
    if (!field.ok) {
      return field;
    }
    out.size = field.value;
  }
  if (hasOwn(clean, 'storageClass')) {
    const field = anyString(clean.storageClass);
    if (!field.ok) {
      return field;
    }
    out.storageClass = field.value;
  }
  return { ok: true, clean: Object.freeze(out) };
}

function serviceAccountValues(clean: Record<string, unknown>): LevelResult {
  const out: { create?: boolean; name?: string } = Object.create(null);
  if (hasOwn(clean, 'create')) {
    const field = boolean(clean.create);
    if (!field.ok) {
      return field;
    }
    out.create = field.value;
  }
  if (hasOwn(clean, 'name')) {
    const field = anyString(clean.name);
    if (!field.ok) {
      return field;
    }
    out.name = field.value;
  }
  return { ok: true, clean: Object.freeze(out) };
}

function resourceAmounts(value: unknown): LevelResult {
  const node = level(value, RESOURCE_KEYS);
  if (!node.ok) {
    return node;
  }
  const out: { cpu?: string; memory?: string } = Object.create(null);
  if (hasOwn(node.clean, 'cpu')) {
    const field = anyString(node.clean.cpu);
    if (!field.ok) {
      return field;
    }
    out.cpu = field.value;
  }
  if (hasOwn(node.clean, 'memory')) {
    const field = anyString(node.clean.memory);
    if (!field.ok) {
      return field;
    }
    out.memory = field.value;
  }
  return { ok: true, clean: Object.freeze(out) };
}

function resourcesValues(clean: Record<string, unknown>): LevelResult {
  const out: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  } = Object.create(null);
  if (hasOwn(clean, 'requests')) {
    const node = resourceAmounts(clean.requests);
    if (!node.ok) {
      return node;
    }
    out.requests = node.clean;
  }
  if (hasOwn(clean, 'limits')) {
    const node = resourceAmounts(clean.limits);
    if (!node.ok) {
      return node;
    }
    out.limits = node.clean;
  }
  return { ok: true, clean: Object.freeze(out) };
}

export function validateChartValues(
  input: unknown,
  isProxy: IsProxy,
  limits?: Partial<PlainDataLimits>,
): ChartValuesValidationResult {
  // The one and only read of untrusted input.
  const snapshot = snapshotPlainData(input, isProxy, limits ?? CHART_VALUES_LIMITS);
  if (!snapshot.ok) {
    // Never forward `snapshot.path`: it may contain input key names.
    return { ok: false, reason: snapshot.reason, path: null };
  }
  const root: unknown = snapshot.value;
  if (!isRecord(root)) {
    return { ok: false, reason: 'not-object', path: null };
  }
  const rootRefusal = keyRefusal(root, ROOT_KEYS);
  if (rootRefusal !== null) {
    return { ok: false, reason: rootRefusal, path: null };
  }

  const values: Record<string, unknown> = Object.create(null);

  if (hasOwn(root, 'replicaCount')) {
    const field = boundedInteger(root.replicaCount, 0, 100);
    if (!field.ok) {
      return { ok: false, reason: field.reason, path: null };
    }
    values.replicaCount = field.value;
  }

  if (hasOwn(root, 'image')) {
    const node = level(root.image, IMAGE_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const image = imageValues(node.clean);
    if (!image.ok) {
      return { ok: false, reason: image.reason, path: null };
    }
    values.image = image.clean;
  }

  if (hasOwn(root, 'service')) {
    const node = level(root.service, SERVICE_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const service = serviceValues(node.clean);
    if (!service.ok) {
      return { ok: false, reason: service.reason, path: null };
    }
    values.service = service.clean;
  }

  if (hasOwn(root, 'api')) {
    const node = level(root.api, API_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const api = apiValues(node.clean);
    if (!api.ok) {
      return { ok: false, reason: api.reason, path: null };
    }
    values.api = api.clean;
  }

  if (hasOwn(root, 'web')) {
    const node = level(root.web, WEB_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const web: { apiUrl?: string } = Object.create(null);
    if (hasOwn(node.clean, 'apiUrl')) {
      const field = nonEmptyString(node.clean.apiUrl);
      if (!field.ok) {
        return { ok: false, reason: field.reason, path: null };
      }
      web.apiUrl = field.value;
    }
    values.web = Object.freeze(web);
  }

  if (hasOwn(root, 'persistence')) {
    const node = level(root.persistence, PERSISTENCE_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const persistence = persistenceValues(node.clean);
    if (!persistence.ok) {
      return { ok: false, reason: persistence.reason, path: null };
    }
    values.persistence = persistence.clean;
  }

  if (hasOwn(root, 'serviceAccount')) {
    const node = level(root.serviceAccount, SERVICE_ACCOUNT_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const serviceAccount = serviceAccountValues(node.clean);
    if (!serviceAccount.ok) {
      return { ok: false, reason: serviceAccount.reason, path: null };
    }
    values.serviceAccount = serviceAccount.clean;
  }

  if (hasOwn(root, 'resources')) {
    const node = level(root.resources, RESOURCES_KEYS);
    if (!node.ok) {
      return { ok: false, reason: node.reason, path: null };
    }
    const resources = resourcesValues(node.clean);
    if (!resources.ok) {
      return { ok: false, reason: resources.reason, path: null };
    }
    values.resources = resources.clean;
  }

  if (hasOwn(root, 'stateDir')) {
    const field = nonEmptyString(root.stateDir);
    if (!field.ok) {
      return { ok: false, reason: field.reason, path: null };
    }
    values.stateDir = field.value;
  }

  return { ok: true, values: Object.freeze(values) as ChartValues };
}
