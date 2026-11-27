import { readFileSync } from 'node:fs';
import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  CHART_VALUES_ALLOWED_KEYS,
  validateChartValues,
} from './chart-values.js';
import type { ChartValuesValidationResult } from './chart-values.js';
import type { IsProxy } from '@fleet/shared';

interface SchemaNode {
  readonly type?: string;
  readonly properties?: Record<string, SchemaNode>;
}

interface ValuesSchema {
  readonly properties: Record<string, SchemaNode>;
}

const schema = JSON.parse(
  readFileSync(new URL('../chart/values.schema.json', import.meta.url), 'utf8'),
) as ValuesSchema;

const FULL_VALUES: Record<string, unknown> = {
  replicaCount: 2,
  image: { repository: 'ghcr.io/fleet/fleet', tag: '1.0.0', pullPolicy: 'IfNotPresent' },
  service: { type: 'ClusterIP', port: 8080 },
  api: { host: '127.0.0.1', port: 3000, allowRemote: false },
  web: { apiUrl: 'http://127.0.0.1:3000' },
  persistence: { enabled: true, size: '10Gi', storageClass: 'standard' },
  serviceAccount: { create: false, name: 'fleet' },
  resources: {
    requests: { cpu: '250m', memory: '512Mi' },
    limits: { cpu: '500m', memory: '1Gi' },
  },
  stateDir: '/var/lib/fleet',
};

/** A detector that throws only on a branded hostile value, so the limits
 * normalization (which never sees the brand) succeeds and the throw is
 * attributable to the value itself. */
const brandThrowingDetector: IsProxy = (value: unknown) => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, 'brand')) {
      throw new Error('boom');
    }
  }
  return types.isProxy(value);
};

function expectRefused(
  result: ChartValuesValidationResult,
  reason: string,
  source?: unknown,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
    expect(result.path).toBeNull();
    const echoed = JSON.stringify(result);
    if (source !== undefined) {
      expect(echoed).not.toContain(JSON.stringify(source).slice(1, -1));
    }
  }
}

function own(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  return Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

describe('validateChartValues', () => {
  it('accepts valid empty values without any licence key', () => {
    const result = validateChartValues({}, types.isProxy);
    expect(result).toEqual({ ok: true, values: {} });
    if (result.ok) {
      expect(Object.isFrozen(result.values)).toBe(true);
      expect(JSON.stringify(result.values)).not.toContain('licence');
      expect(JSON.stringify(result.values)).not.toContain('license');
    }
  });

  it('accepts valid full documented self-host values and returns frozen normalized data', () => {
    const result = validateChartValues(FULL_VALUES, types.isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual(FULL_VALUES);
      expect(Object.isFrozen(result.values)).toBe(true);
      expect(Object.isFrozen(result.values.image)).toBe(true);
      expect(Object.isFrozen(result.values.service)).toBe(true);
      expect(Object.isFrozen(result.values.api)).toBe(true);
      expect(Object.isFrozen(result.values.resources)).toBe(true);
      expect(Object.isFrozen(result.values.resources?.requests)).toBe(true);
      expect(Object.isFrozen(result.values.resources?.limits)).toBe(true);
      expect(result.values.replicaCount).toBe(2);
      expect(result.values.api?.port).toBe(3000);
    }
  });

  it('accepts boundary integers replicaCount 0..100 and port 1..65535', () => {
    expect(
      validateChartValues({ replicaCount: 0 }, types.isProxy).ok,
    ).toBe(true);
    expect(
      validateChartValues({ replicaCount: 100 }, types.isProxy).ok,
    ).toBe(true);
    expect(
      validateChartValues({ service: { port: 1 } }, types.isProxy).ok,
    ).toBe(true);
    expect(
      validateChartValues({ service: { port: 65535 } }, types.isProxy).ok,
    ).toBe(true);
  });

  it('allow-list equals values.schema.json key sets at root and every nested level', () => {
    const fromSchema = new Map<string, string[]>([
      ['root', Object.keys(schema.properties)],
    ]);
    const walk = (props: Record<string, SchemaNode>, prefix: string): void => {
      for (const [name, node] of Object.entries(props)) {
        if (node.type === 'object' && node.properties !== undefined) {
          const path = prefix === '' ? name : `${prefix}.${name}`;
          fromSchema.set(path, Object.keys(node.properties));
          walk(node.properties, path);
        }
      }
    };
    walk(schema.properties, '');

    const fromValidator = new Map<string, string[]>();
    for (const [path, keys] of Object.entries(CHART_VALUES_ALLOWED_KEYS)) {
      fromValidator.set(path, [...keys].sort());
    }
    const sortedSchema = new Map<string, string[]>();
    for (const [path, keys] of fromSchema) {
      sortedSchema.set(path, [...keys].sort());
    }
    expect([...fromValidator.keys()].sort()).toEqual([...sortedSchema.keys()].sort());
    for (const [path, keys] of sortedSchema) {
      expect(fromValidator.get(path)).toEqual(keys);
    }
    expect(sortedSchema.size).toBe(10);
  });

  it('exposes frozen allow-list sets so callers cannot mutate validation', () => {
    for (const keys of Object.values(CHART_VALUES_ALLOWED_KEYS)) {
      expect(Object.isFrozen(keys)).toBe(true);
      // The view exposes no mutator at all: `add` must be absent, so any
      // mutation attempt throws and the key set cannot grow.
      expect((keys as unknown as Record<string, unknown>).add).toBeUndefined();
      expect((keys as unknown as Record<string, unknown>).delete).toBeUndefined();
      expect((keys as unknown as Record<string, unknown>).clear).toBeUndefined();
      // Even if a caller somehow attempts an add, the validator must still
      // refuse the key afterwards.
      try {
        (keys as unknown as { add: (key: string) => unknown }).add('extra');
      } catch {
        // Throwing is expected: mutation is refused.
      }
      expect(keys.has('extra')).toBe(false);
      expectRefused(
        validateChartValues({ extra: 'sentinel-value' }, types.isProxy),
        'unknown-key',
      );
      expectRefused(
        validateChartValues({ image: { extra: 'sentinel-value' } }, types.isProxy),
        'unknown-key',
      );
    }
  });

  it('forEach callback never receives a Set with mutators', () => {
    for (const keys of Object.values(CHART_VALUES_ALLOWED_KEYS)) {
      let leaked: unknown;
      keys.forEach((_value, _value2, set) => {
        leaked = set;
      });
      // The third argument must not be the private mutable Set: it must
      // expose no add/delete/clear, so a callback cannot grow the
      // allow-list.
      expect(leaked).toBeDefined();
      const mutators = leaked as Record<string, unknown>;
      expect(mutators.add).toBeUndefined();
      expect(mutators.delete).toBeUndefined();
      expect(mutators.clear).toBeUndefined();
      // And the allow-list must still refuse an undocumented key.
      expect(keys.has('extra')).toBe(false);
    }
  });

  it('refuses unknown key at root and nested objects without echoing key', () => {
    const root = validateChartValues(
      { SENTINEL_SECRET_ROOT: 'sensitive' },
      types.isProxy,
    );
    expectRefused(root, 'unknown-key', 'SENTINEL_SECRET_ROOT');
    const nested = validateChartValues(
      { image: { NESTED_SECRET_KEY: 'sensitive' } },
      types.isProxy,
    );
    expectRefused(nested, 'unknown-key', 'NESTED_SECRET_KEY');
  });

  it('refuses array-like plain object as unknown-key', () => {
    expectRefused(
      validateChartValues({ 0: 'a', length: 1 }, types.isProxy),
      'unknown-key',
    );
  });

  it('refuses hosted-only and licence-key fields without echoing key', () => {
    const hostedKeys = [
      'hosted',
      'cloud',
      'saas',
      'enterprise',
      'billing',
      'multiOrg',
      'multiTenant',
      'licenseKey',
      'licenceKey',
      '@fleet/hosted',
      'fleet-hosted-cron',
    ];
    for (const key of hostedKeys) {
      expectRefused(
        validateChartValues({ [key]: 'SENSITIVE_HOSTED_VALUE' }, types.isProxy),
        'hosted-key',
        'SENSITIVE_HOSTED_VALUE',
      );
    }
    expectRefused(
      validateChartValues(
        { image: { licenseKey: 'SENSITIVE_LICENCE_VALUE' } },
        types.isProxy,
      ),
      'hosted-key',
      'SENSITIVE_LICENCE_VALUE',
    );
  });

  it('refuses null root without echoing', () => {
    expectRefused(validateChartValues(null, types.isProxy), 'not-object');
  });

  it('refuses undefined root', () => {
    expectRefused(validateChartValues(undefined, types.isProxy), 'unsupported-type');
  });

  it('refuses primitive root and wrong primitive field types', () => {
    expectRefused(validateChartValues(true, types.isProxy), 'not-object');
    expectRefused(validateChartValues(3, types.isProxy), 'not-object');
    expectRefused(validateChartValues('x', types.isProxy), 'not-object');
    expectRefused(validateChartValues(1n, types.isProxy), 'unsupported-type');
    expectRefused(validateChartValues(Symbol('s'), types.isProxy), 'unsupported-type');
    expectRefused(
      validateChartValues(() => 1, types.isProxy),
      'unsupported-type',
    );
    expectRefused(
      validateChartValues({ replicaCount: '5' }, types.isProxy),
      'invalid-type',
    );
    expectRefused(
      validateChartValues({ image: { pullPolicy: true } }, types.isProxy),
      'invalid-type',
    );
    expectRefused(
      validateChartValues({ service: { port: '80' } }, types.isProxy),
      'invalid-type',
    );
    expectRefused(
      validateChartValues({ api: { allowRemote: 'yes' } }, types.isProxy),
      'invalid-type',
    );
    expectRefused(
      validateChartValues({ stateDir: 5 }, types.isProxy),
      'invalid-type',
    );
    expectRefused(
      validateChartValues({ image: 'not-an-object' }, types.isProxy),
      'invalid-type',
    );
    expectRefused(
      validateChartValues({ resources: { requests: '4' } }, types.isProxy),
      'invalid-type',
    );
  });

  it('refuses non-plain object instances', () => {
    expectRefused(validateChartValues(new Date('2026-01-01'), types.isProxy), 'not-plain');
    expectRefused(validateChartValues(new Map([['a', 1]]), types.isProxy), 'not-plain');
    class Wrapped {}
    expectRefused(validateChartValues(new Wrapped(), types.isProxy), 'not-plain');
    expectRefused(
      validateChartValues(Object.assign([1, 2], { extra: true }), types.isProxy),
      'not-plain',
    );
  });

  it('refuses array root', () => {
    expectRefused(validateChartValues([], types.isProxy), 'not-object');
    expectRefused(validateChartValues([1], types.isProxy), 'not-object');
  });

  it('refuses sparse array with hole', () => {
    const sparse: unknown[] = [1, 2, 3];
    delete sparse[1];
    expectRefused(validateChartValues(sparse, types.isProxy), 'sparse-array');
  });

  it('refuses getter without invoking it', () => {
    let invoked = false;
    const withGetter = Object.defineProperty({}, 'replicaCount', {
      get() {
        invoked = true;
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    expectRefused(validateChartValues(withGetter, types.isProxy), 'accessor');
    expect(invoked).toBe(false);

    let nestedInvoked = false;
    const nestedGetter = {
      image: Object.defineProperty({}, 'tag', {
        get() {
          nestedInvoked = true;
          return 'x';
        },
        enumerable: true,
        configurable: true,
      }),
    };
    expectRefused(validateChartValues(nestedGetter, types.isProxy), 'accessor');
    expect(nestedInvoked).toBe(false);
  });

  it('refuses throwing getter without invoking it', () => {
    const throwing = Object.defineProperty({}, 'replicaCount', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    expectRefused(validateChartValues(throwing, types.isProxy), 'accessor');
  });

  it('refuses Proxy via injected isProxy detector without running traps', () => {
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps += 1;
          return 1;
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          return undefined;
        },
        ownKeys() {
          traps += 1;
          return [];
        },
      },
    );
    expectRefused(validateChartValues(hostile, types.isProxy), 'proxy');
    expect(traps).toBe(0);
  });

  it('refuses when isProxy detector throws', () => {
    expectRefused(
      validateChartValues({ brand: 'hostile' }, brandThrowingDetector),
      'detector-threw',
    );
  });

  it('refuses with invalid-limits when an always-throwing detector meets domain limits', () => {
    const alwaysThrows: IsProxy = () => {
      throw new Error('boom');
    };
    expectRefused(validateChartValues({}, alwaysThrows), 'invalid-limits');
  });

  it('refuses enormous array length and snapshot bound overflows', () => {
    expectRefused(
      validateChartValues(new Array(65).fill('x'), types.isProxy),
      'too-many-items',
    );
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 33; i += 1) {
      manyKeys[`pad${i}`] = i;
    }
    expectRefused(validateChartValues(manyKeys, types.isProxy), 'too-many-keys');
    const manyNodes: Record<string, unknown> = {};
    for (let i = 0; i < 32; i += 1) {
      manyNodes[`pad${i}`] = { a: 1, b: 2, c: 3, d: 4 };
    }
    expectRefused(validateChartValues(manyNodes, types.isProxy), 'too-many-nodes');
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 9; i += 1) {
      deep = { nested: deep };
    }
    expectRefused(validateChartValues(deep, types.isProxy), 'too-deep');
    expectRefused(
      validateChartValues({ stateDir: 'x'.repeat(4097) }, types.isProxy),
      'too-long',
    );
  });

  it('refuses prototype-polluting keys at root and nested levels', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expectRefused(
        validateChartValues(own({}, key, 'SENSITIVE_POLLUTION'), types.isProxy),
        'prototype-polluting-key',
        'SENSITIVE_POLLUTION',
      );
      expectRefused(
        validateChartValues(
          { image: own({}, key, 'SENSITIVE_POLLUTION') },
          types.isProxy,
        ),
        'prototype-polluting-key',
        'SENSITIVE_POLLUTION',
      );
    }
  });

  it('refuses out-of-range integers, invalid enums, and empty strings', () => {
    expectRefused(
      validateChartValues({ replicaCount: -1 }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ replicaCount: 101 }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ service: { port: 0 } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ service: { port: 65536 } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ api: { port: 70000 } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ image: { pullPolicy: 'Sometimes' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ service: { type: 'Mesh' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ image: { repository: '' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ image: { tag: '' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ api: { host: '' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ web: { apiUrl: '' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ persistence: { size: '' } }, types.isProxy),
      'invalid-value',
    );
    expectRefused(
      validateChartValues({ stateDir: '' }, types.isProxy),
      'invalid-value',
    );
  });

  it('refuses non-finite numbers and negative zero', () => {
    expectRefused(
      validateChartValues({ replicaCount: Number.NaN }, types.isProxy),
      'non-finite-number',
    );
    expectRefused(
      validateChartValues({ replicaCount: Number.POSITIVE_INFINITY }, types.isProxy),
      'non-finite-number',
    );
    expectRefused(
      validateChartValues({ replicaCount: -0 }, types.isProxy),
      'negative-zero',
    );
  });

  it('refuses cyclic objects and hostile descriptors', () => {
    const cyclic: Record<string, unknown> = { image: {} };
    cyclic.self = cyclic;
    expectRefused(validateChartValues(cyclic, types.isProxy), 'cycle');

    // With an inaccurate detector a revoked Proxy still must produce a typed
    // refusal ('hostile') rather than throwing out of the validator.
    const liar: IsProxy = () => false;
    const revoked = new Proxy({}, {
      ownKeys() {
        throw new Error('revoked');
      },
    });
    expectRefused(validateChartValues(revoked, liar), 'hostile');
  });

  it('refuses malformed limits argument', () => {
    expectRefused(
      validateChartValues({}, types.isProxy, { maxNodes: -1 }),
      'invalid-limits',
    );
    expectRefused(
      validateChartValues({}, types.isProxy, { maxDepth: Number.NaN }),
      'invalid-limits',
    );
    expectRefused(
      validateChartValues({}, types.isProxy, 'not-a-limits-object' as never),
      'invalid-limits',
    );
  });
});
