/**
 * Tests for `num` and `optNum` in `payload.ts`: they must accept only a finite
 * number or a non-blank numeric string, and refuse every other value with the
 * fallback (`num`) or `undefined` (`optNum`) — never inventing `0` or `1`.
 * Each check is O(1) for non-strings and O(n) in string length for strings.
 */

import { describe, expect, it } from 'vitest';

import { runCli } from '../index.js';
import { num, optNum, type Payload } from './payload.js';

function collectIo(): {
  out: string[];
  err: string[];
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  };
}

const ACCEPTED: Array<[string, unknown, number]> = [
  ['zero number', 0, 0],
  ['zero string', '0', 0],
  ['negative number', -3, -3],
  ['fractional number', 1.5, 1.5],
  ['integer string', '5', 5],
  ['padded integer string', ' 7 ', 7],
  ['fractional string', '1.5', 1.5],
];

const REJECTED: Array<[string, unknown]> = [
  ['boolean true', true],
  ['boolean false', false],
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace-only string', '   '],
  ['empty array', []],
  ['one-element array', [1]],
  ['empty object', {}],
  ['object with valueOf', { valueOf: () => 5 }],
  ['non-numeric string', 'abc'],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['NaN', NaN],
  ['Infinity string', 'Infinity'],
  ['-Infinity string', '-Infinity'],
  ['NaN string', 'NaN'],
];

const POLLUTING_KEYS = ['__proto__', 'constructor', 'prototype'];

describe('num accepts only finite numbers and numeric strings', () => {
  it.each(ACCEPTED)('returns the exact value for %s', (_name, value, expected) => {
    expect(num({ revision: value }, 'revision', 42)).toBe(expected);
    expect(num({ revision: value }, 'revision', -99)).toBe(expected);
  });

  it.each(REJECTED)('returns the fallback for %s', (_name, value) => {
    expect(num({ revision: value }, 'revision', 42)).toBe(42);
    expect(num({ revision: value }, 'revision', -99)).toBe(-99);
  });

  it('returns the fallback when the key is missing', () => {
    expect(num({}, 'revision', 42)).toBe(42);
    expect(num({}, 'revision', -99)).toBe(-99);
  });

  it.each(['null', 'undefined', 'an array', 'a primitive'])(
    'returns the fallback when the payload is %s',
    (name) => {
      const payload =
        name === 'null'
          ? null
          : name === 'undefined'
            ? undefined
            : name === 'an array'
              ? [7]
              : 'a string';
      expect(num(payload as unknown as Payload, 'revision', 42)).toBe(42);
      expect(num(payload as unknown as Payload, 'revision', -99)).toBe(-99);
    },
  );

  it.each(POLLUTING_KEYS)('returns the fallback for the prototype-polluting key %s', (key) => {
    expect(num({ [key]: 7 } as Payload, key, 42)).toBe(42);
    expect(num({ [key]: 7 } as Payload, key, -99)).toBe(-99);
  });

  it('returns the fallback for a sparse array hole, a huge array-like, and a throwing valueOf/toString getter without iterating or converting', () => {
    const hole: unknown[] = new Array(3);
    delete hole[1];
    expect(num({ revision: hole }, 'revision', 42)).toBe(42);
    expect(num({ revision: { length: 1_000_000_000 } }, 'revision', 42)).toBe(42);
    const hostile = {};
    Object.defineProperty(hostile, 'valueOf', {
      get() {
        throw new Error('boom');
      },
    });
    Object.defineProperty(hostile, 'toString', {
      get() {
        throw new Error('boom');
      },
    });
    expect(num({ revision: hostile }, 'revision', 42)).toBe(42);
    expect(num({ revision: hostile }, 'revision', -99)).toBe(-99);
  });
});

describe('optNum accepts only finite numbers and numeric strings', () => {
  it.each(ACCEPTED)('returns the exact value for %s', (_name, value, expected) => {
    expect(optNum({ revision: value }, 'revision')).toBe(expected);
  });

  it.each(REJECTED)('returns undefined for %s', (_name, value) => {
    expect(optNum({ revision: value }, 'revision')).toBeUndefined();
  });

  it('returns undefined when the key is missing', () => {
    expect(optNum({}, 'revision')).toBeUndefined();
  });

  it.each(['null', 'undefined', 'an array', 'a primitive'])(
    'returns undefined when the payload is %s',
    (name) => {
      const payload =
        name === 'null'
          ? null
          : name === 'undefined'
            ? undefined
            : name === 'an array'
              ? [7]
              : 'a string';
      expect(optNum(payload as unknown as Payload, 'revision')).toBeUndefined();
    },
  );

  it.each(POLLUTING_KEYS)('returns undefined for the prototype-polluting key %s', (key) => {
    expect(optNum({ [key]: 7 } as Payload, key)).toBeUndefined();
  });

  it('returns undefined for a sparse array hole, a huge array-like, and a throwing valueOf/toString getter without iterating or converting', () => {
    const hole: unknown[] = new Array(3);
    delete hole[1];
    expect(optNum({ revision: hole }, 'revision')).toBeUndefined();
    expect(optNum({ revision: { length: 1_000_000_000 } }, 'revision')).toBeUndefined();
    const hostile = {};
    Object.defineProperty(hostile, 'valueOf', {
      get() {
        throw new Error('boom');
      },
    });
    Object.defineProperty(hostile, 'toString', {
      get() {
        throw new Error('boom');
      },
    });
    expect(optNum({ revision: hostile }, 'revision')).toBeUndefined();
  });
});

describe('num and optNum never run a throwing getter on payload[key]', () => {
  it('returns the fallback / undefined without invoking the getter', () => {
    const payload: Payload = {};
    Object.defineProperty(payload, 'revision', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => num(payload, 'revision', 42)).not.toThrow();
    expect(num(payload, 'revision', 42)).toBe(42);
    expect(num(payload, 'revision', -99)).toBe(-99);
    expect(() => optNum(payload, 'revision')).not.toThrow();
    expect(optNum(payload, 'revision')).toBeUndefined();
  });
});

describe('num and optNum refuse a throwing or revoked Proxy with the typed result', () => {
  it('returns the fallback / undefined for a revoked Proxy payload', () => {
    const handle = Proxy.revocable({ revision: 7 }, {});
    handle.revoke();
    const proxy = handle.proxy as unknown as Payload;
    expect(num(proxy, 'revision', 42)).toBe(42);
    expect(num(proxy, 'revision', -99)).toBe(-99);
    expect(optNum(proxy, 'revision')).toBeUndefined();
  });

  it('returns the fallback / undefined when the payload Proxy throws from its getOwnPropertyDescriptor trap', () => {
    const payload = new Proxy(
      { revision: 7 },
      {
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    ) as Payload;
    expect(num(payload, 'revision', 42)).toBe(42);
    expect(num(payload, 'revision', -99)).toBe(-99);
    expect(optNum(payload, 'revision')).toBeUndefined();
  });

  it('returns the fallback / undefined when the descriptor itself is a Proxy whose traps throw', () => {
    const payload = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          return new Proxy(
            { value: 7 },
            {
              has() {
                throw new Error('boom');
              },
            },
          );
        },
      },
    ) as Payload;
    expect(num(payload, 'revision', 42)).toBe(42);
    expect(num(payload, 'revision', -99)).toBe(-99);
    expect(optNum(payload, 'revision')).toBeUndefined();
  });
});

describe('questions answer refuses a bare --revision at the CLI boundary', () => {
  it('exits 2, writes the usage message to stderr, nothing to stdout, and calls the use case zero times', async () => {
    const calls: unknown[] = [];
    const stubRuntime = {
      coordination: {
        answerOwnerQuestion: {
          answerOwnerQuestion: (request: unknown) => {
            calls.push(request);
            return Promise.resolve({ outcome: 'ok' });
          },
        },
      },
    } as unknown as Parameters<typeof runCli>[2];
    const { out, err, io } = collectIo();
    const code = await runCli(
      ['questions', 'answer', 'q-1', '--accept', '--revision'],
      io,
      stubRuntime,
    );
    expect(code).toBe(2);
    expect(err.join('')).toContain("requires '--revision <n>'");
    expect(out.join('')).toBe('');
    expect(calls).toHaveLength(0);
  });
});
