import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_MAX_PROJECT_ALIASES,
  TELEMETRY_PROJECT_ID_MAX_LENGTH,
  readTelemetryPolicyBlock,
} from '../telemetry-policy.js';

/** Runtime-built 64-hex-character salt: 16 distinct characters, never a literal. */
const validSalt64 = '0123456789abcdef'.repeat(4);
/** Runtime-built 256-hex-character salt with the same 16 distinct characters. */
const validSalt256 = '0123456789abcdef'.repeat(16);
/** A secret-shaped string assembled at runtime (openai-style key shape), never a literal. */
const secretShapedName = 'sk-' + 'a'.repeat(20);

const OBJECT_ERROR = 'policy.telemetry: must be an object';

/** A Proxy whose every trap throws, so any read attempt fails loudly. */
function throwingProxy(): unknown {
  const trap = (): never => {
    throw new Error('trap must not be reached');
  };
  return new Proxy(
    {},
    {
      get: trap,
      has: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      set: trap,
      deleteProperty: trap,
      defineProperty: trap,
    },
  );
}

describe('readTelemetryPolicyBlock', () => {
  it('refuses non-object and non-plain-record inputs with policy.telemetry: must be an object', () => {
    // Cost bound: isPlainRecord is O(1) — a typeof check, an Array.isArray check
    // and one getPrototypeOf call; no scan of the value is needed.
    const inputs: unknown[] = [
      null,
      undefined,
      [],
      'x',
      5,
      true,
      Object.create({ enabled: false }),
      throwingProxy(),
    ];
    for (const input of inputs) {
      expect(readTelemetryPolicyBlock(input)).toEqual({ ok: false, errors: [OBJECT_ERROR] });
    }
  });

  it('refuses non-boolean sendCost and includeDryRun and accepts boolean values', () => {
    // Cost bound: each field check is O(1) — one Object.hasOwn, one descriptor
    // read and one typeof comparison.
    for (const [field, badValue] of [
      ['sendCost', 'yes'],
      ['sendCost', 1],
      ['includeDryRun', 'true'],
      ['includeDryRun', null],
    ] as const) {
      expect(readTelemetryPolicyBlock({ enabled: false, [field]: badValue })).toEqual({
        ok: false,
        errors: [`policy.telemetry.${field}: must be a boolean`],
      });
    }
    expect(readTelemetryPolicyBlock({ enabled: false, sendCost: true, includeDryRun: false })).toEqual({
      ok: true,
      policy: { enabled: false, sendCost: true, includeDryRun: false },
    });
  });

  it('never invokes an accessor-valued sendCost getter and refuses it', () => {
    let calls = 0;
    const block: Record<string, unknown> = { enabled: false };
    Object.defineProperty(block, 'sendCost', {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    const result = readTelemetryPolicyBlock(block);
    // Cost bound: readOwnDataProperty reads the descriptor without running the
    // getter — O(1), no invocation.
    expect(result).toEqual({
      ok: false,
      errors: ['policy.telemetry.sendCost: must be a boolean'],
    });
    expect(calls).toBe(0);
  });

  it('refuses an empty object with policy.telemetry.enabled: required', () => {
    expect(readTelemetryPolicyBlock({})).toEqual({
      ok: false,
      errors: ['policy.telemetry.enabled: required'],
    });
  });

  it('refuses non-boolean enabled with policy.telemetry.enabled: must be a boolean', () => {
    expect(readTelemetryPolicyBlock({ enabled: 'yes' })).toEqual({
      ok: false,
      errors: ['policy.telemetry.enabled: must be a boolean'],
    });
  });

  it('never invokes an accessor-valued enabled getter and refuses it', () => {
    let calls = 0;
    const block: Record<string, unknown> = {};
    Object.defineProperty(block, 'enabled', {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    const result = readTelemetryPolicyBlock(block);
    // Cost bound: readOwnDataProperty uses Object.getOwnPropertyDescriptor, which
    // returns the descriptor without running the getter — O(1), no invocation.
    expect(result).toEqual({
      ok: false,
      errors: ['policy.telemetry.enabled: must be a boolean'],
    });
    expect(calls).toBe(0);
  });

  it('refuses unknown keys with policy.telemetry: unknown key', () => {
    // Cost bound: the key check is O(k) over the block's own enumerable keys.
    expect(readTelemetryPolicyBlock({ enabled: false, extraKey: true })).toEqual({
      ok: false,
      errors: ['policy.telemetry: unknown key'],
    });
  });

  it('accepts disabled without salt, requires salt when enabled, and preserves valid salt', () => {
    expect(readTelemetryPolicyBlock({ enabled: false })).toEqual({
      ok: true,
      policy: { enabled: false },
    });
    expect(readTelemetryPolicyBlock({ enabled: true })).toEqual({
      ok: false,
      errors: ['policy.telemetry.salt: required when enabled'],
    });
    expect(readTelemetryPolicyBlock({ enabled: true, salt: validSalt64 })).toEqual({
      ok: true,
      policy: { enabled: true, salt: validSalt64 },
    });
  });

  it('refuses salts outside 64-to-256 even-length lowercase hex', () => {
    // Cost bound: one anchored regex test plus one length parity check, O(n) in
    // the salt length, and nothing runs before the shape is proven.
    const badSalts: unknown[] = [
      '0123456789abcdef'.repeat(3) + '01234567', // 63 hex chars
      '0123456789abcdef'.repeat(16) + '0', // 257 hex chars
      '0123456789ABCDEF'.repeat(4), // uppercase hex
      '0123456789abcdef' + '0', // 65 hex chars, odd length
      123, // not a string
      null,
    ];
    for (const salt of badSalts) {
      expect(
        readTelemetryPolicyBlock({ enabled: false, salt }),
      ).toEqual({
        ok: false,
        errors: [
          'policy.telemetry.salt: must be 64 to 256 lowercase hex characters (32 to 128 random bytes)',
        ],
      });
    }
  });

  it('refuses low-diversity placeholder salts and accepts valid 64 and 256 character salts', () => {
    // Cost bound: the distinct-character check is O(n) over the salt with a
    // Set bounded by 16 possible hex digits, so memory stays constant.
    expect(readTelemetryPolicyBlock({ enabled: false, salt: '0'.repeat(64) })).toEqual({
      ok: false,
      errors: ['policy.telemetry.salt: looks like a placeholder; generate at least 32 random bytes'],
    });
    expect(readTelemetryPolicyBlock({ enabled: false, salt: '01'.repeat(32) })).toEqual({
      ok: false,
      errors: ['policy.telemetry.salt: looks like a placeholder; generate at least 32 random bytes'],
    });
    expect(readTelemetryPolicyBlock({ enabled: false, salt: validSalt64 })).toEqual({
      ok: true,
      policy: { enabled: false, salt: validSalt64 },
    });
    expect(readTelemetryPolicyBlock({ enabled: false, salt: validSalt256 })).toEqual({
      ok: true,
      policy: { enabled: false, salt: validSalt256 },
    });
  });

  it('accepts collector and phoenix routes and refuses other values', () => {
    for (const route of ['collector', 'phoenix'] as const) {
      expect(readTelemetryPolicyBlock({ enabled: false, route })).toEqual({
        ok: true,
        policy: { enabled: false, route },
      });
    }
    for (const route of ['other', '', 123]) {
      expect(readTelemetryPolicyBlock({ enabled: false, route })).toEqual({
        ok: false,
        errors: ['policy.telemetry.route: must be one of collector, phoenix'],
      });
    }
  });

  it('accepts sampleRatio in [0, 1] and refuses out-of-range, non-finite, or non-number values', () => {
    for (const sampleRatio of [0, 0.5, 1]) {
      expect(readTelemetryPolicyBlock({ enabled: false, sampleRatio })).toEqual({
        ok: true,
        policy: { enabled: false, sampleRatio },
      });
    }
    for (const sampleRatio of [-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
      expect(readTelemetryPolicyBlock({ enabled: false, sampleRatio })).toEqual({
        ok: false,
        errors: ['policy.telemetry.sampleRatio: must be a number from 0 to 1'],
      });
    }
  });

  it('accepts valid projectName and refuses uppercase, digit-leading, over-length, and secret-shaped names', () => {
    expect(readTelemetryPolicyBlock({ enabled: false, projectName: 'fleet-lanes' })).toEqual({
      ok: true,
      policy: { enabled: false, projectName: 'fleet-lanes' },
    });
    for (const projectName of ['Fleet', '1abc', 'a'.repeat(33), secretShapedName]) {
      expect(readTelemetryPolicyBlock({ enabled: false, projectName })).toEqual({
        ok: false,
        errors: [
          'policy.telemetry.projectName: must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
        ],
      });
    }
  });

  it('refuses non-object projectAliases', () => {
    // Cost bound: reuses isPlainRecord, O(1) as above.
    for (const projectAliases of [null, [], 'x', 5]) {
      expect(readTelemetryPolicyBlock({ enabled: false, projectAliases })).toEqual({
        ok: false,
        errors: ['policy.telemetry.projectAliases: must be an object'],
      });
    }
  });

  it('accepts a valid projectAliases map and freezes it', () => {
    const result = readTelemetryPolicyBlock({
      enabled: false,
      projectAliases: { 'org/repo': 'repo-a' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.projectAliases).toEqual({ 'org/repo': 'repo-a' });
      expect(Object.isFrozen(result.policy.projectAliases)).toBe(true);
    }
  });

  it('refuses projectAliases exceeding 64 entries including a 10000-key object without throwing', () => {
    // Cost bound (declared residual): Object.keys(aliases) materializes all keys
    // before the > 64 count check and the validation loop walks every key, so a
    // 10,000-key map costs O(n) work and one sparse object; the refusal still
    // happens without throwing, but no earlier short-circuit exists.
    const tooMany: Record<string, string> = {};
    for (let index = 0; index < TELEMETRY_MAX_PROJECT_ALIASES + 1; index += 1) {
      tooMany[`org/repo-${index}`] = `alias-${index}`;
    }
    const huge: Record<string, string> = {};
    for (let index = 0; index < 10_000; index += 1) {
      huge[`org/repo-${index}`] = `alias-${index}`;
    }
    const expected = {
      ok: false,
      errors: ['policy.telemetry.projectAliases: at most 64 entries'],
    } as const;
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: tooMany })).toEqual(expected);
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: huge })).toEqual(expected);
  });

  it('refuses duplicate alias values in projectAliases', () => {
    expect(
      readTelemetryPolicyBlock({
        enabled: false,
        projectAliases: { 'org/one': 'same-alias', 'org/two': 'same-alias' },
      }),
    ).toEqual({
      ok: false,
      errors: ['policy.telemetry.projectAliases: two projects share an alias'],
    });
  });

  it('refuses invalid projectAliases values including a getter-valued alias', () => {
    // Cost bound: each entry costs one isAlias check — a regex test and one
    // containsSecretShape scan of the alias, O(n) in the value length.
    const secretShapedAlias = 'sk-' + 'b'.repeat(20);
    const badValues: unknown[] = ['Bad', '1abc', 123, null, secretShapedAlias, 'a'.repeat(33)];
    for (const alias of badValues) {
      const result = readTelemetryPolicyBlock({
        enabled: false,
        projectAliases: { 'org/repo': alias },
      });
      expect(result).toEqual({
        ok: false,
        errors: [
          'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
        ],
      });
      expect(JSON.stringify(result)).not.toContain(String(alias));
    }
  });

  it('never invokes a getter-valued alias and refuses it', () => {
    let calls = 0;
    const aliases: Record<string, unknown> = {};
    Object.defineProperty(aliases, 'org/repo', {
      enumerable: true,
      get() {
        calls += 1;
        return 'alias-one';
      },
    });
    const result = readTelemetryPolicyBlock({ enabled: false, projectAliases: aliases });
    // Cost bound: readOwnDataProperty returns the descriptor's value field,
    // which is undefined for an accessor — O(1), the getter never runs.
    expect(result).toEqual({
      ok: false,
      errors: [
        'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
      ],
    });
    expect(calls).toBe(0);
  });

  it('refuses undefined, sparse-array, array-like, and enormous-length projectAliases containers', () => {
    // undefined: not an object, refused by isPlainRecord — O(1).
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: undefined })).toEqual({
      ok: false,
      errors: ['policy.telemetry.projectAliases: must be an object'],
    });
    // Sparse array with a hole: Array.isArray rejects it before any index is
    // read, so the hole is never inspected — O(1).
    const sparse: string[] = new Array(3);
    sparse[1] = 'alias-one';
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: sparse })).toEqual({
      ok: false,
      errors: ['policy.telemetry.projectAliases: must be an object'],
    });
    // Array-like plain object: refused on the non-string values it carries; the
    // cost is O(k) in the two own keys, independent of the length value.
    const arrayLike: Record<string, unknown> = { 0: 'alias-zero', length: 1 };
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: arrayLike })).toEqual({
      ok: false,
      errors: [
        'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
      ],
    });
    // Enormous length value: still just two own keys, so the walk stays O(2)
    // and the non-string length is refused as an alias value — no throw.
    const enormous: Record<string, unknown> = { 0: 'alias-zero', length: Number.MAX_SAFE_INTEGER };
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: enormous })).toEqual({
      ok: false,
      errors: [
        'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
      ],
    });
  });

  it('refuses a throwing-trap Proxy as projectAliases without leaking the trap error', () => {
    // Cost bound: isPlainRecord's getPrototypeOf call hits the throwing trap,
    // which the outer catch converts to the fixed object error — O(1).
    expect(readTelemetryPolicyBlock({ enabled: false, projectAliases: throwingProxy() })).toEqual({
      ok: false,
      errors: [OBJECT_ERROR],
    });
  });

  it('refuses a Proxy presenting accessor descriptors without invoking the getters', () => {
    let calls = 0;
    const target: Record<string, unknown> = {};
    const accessorProxy = new Proxy(target, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => ['org/repo'],
      getOwnPropertyDescriptor(_target, key) {
        if (key === 'org/repo') {
          return { enumerable: true, configurable: true, get() { calls += 1; return 'alias-one'; } };
        }
        return undefined;
      },
    });
    const result = readTelemetryPolicyBlock({ enabled: false, projectAliases: accessorProxy });
    // Cost bound: the descriptor read is O(1); accessor descriptors carry no
    // value field, so the alias reads as undefined and the getter never runs.
    expect(result).toEqual({
      ok: false,
      errors: [
        'policy.telemetry.projectAliases: every alias must match ^[a-z][a-z0-9-]{0,31}$ and hold no secret-shaped value',
      ],
    });
    expect(calls).toBe(0);
  });

  it('refuses prototype-polluting and over-length project ids in projectAliases', () => {
    // `own __proto__` is unreachable through object literal syntax, so build it
    // with JSON.parse, which creates it as a real own data property.
    const withOwnProto: Record<string, string> = JSON.parse(
      '{"__proto__":"alias-one","org/ok":"alias-two"}',
    );
    const overLengthId = 'a'.repeat(TELEMETRY_PROJECT_ID_MAX_LENGTH + 1);
    const expected = {
      ok: false,
      errors: [
        'policy.telemetry.projectAliases: every project id must be a non-empty id of at most 128 characters with no secret-shaped value',
      ],
    } as const;
    for (const aliases of [
      withOwnProto,
      { constructor: 'alias-one', 'org/ok': 'alias-two' },
      { prototype: 'alias-one', 'org/ok': 'alias-two' },
      { [overLengthId]: 'alias-one', 'org/ok': 'alias-two' },
    ]) {
      const result = readTelemetryPolicyBlock({ enabled: false, projectAliases: aliases });
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(overLengthId);
    }
  });

  it('collects all field errors without stopping early and echoes no input value', () => {
    const marker = 'marker-value-' + 'z'.repeat(24);
    const result = readTelemetryPolicyBlock({
      enabled: 'not-a-boolean',
      route: 'nope',
      sampleRatio: 7,
      marker,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'policy.telemetry: unknown key',
        'policy.telemetry.enabled: must be a boolean',
        'policy.telemetry.route: must be one of collector, phoenix',
        'policy.telemetry.sampleRatio: must be a number from 0 to 1',
      ]);
      expect(result.errors).toHaveLength(4);
    }
    // No echoed value anywhere in the serialized result, including the marker.
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain('not-a-boolean');
    expect(JSON.stringify(result)).not.toContain('nope');
  });
});
