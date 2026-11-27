import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter, RuleTester } from 'eslint';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin, {
  loadForbiddenNames,
  noWorkingName,
  readForbiddenNameOptions,
} from './no-working-name.js';

const FAKE = 'zzforbiddenzz';
const ENV_KEY = 'FLEET_WEB_FORBIDDEN_NAMES';
const originalEnv = process.env[ENV_KEY];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnv;
  }
});

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'no-working-name-'));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('no-working-name rule with the fake forbidden word in the environment', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = FAKE;
  });

  ruleTester.run('no-working-name', noWorkingName, {
    valid: [
      { name: 'accepts neutral string literal', code: 'const label = "connect source";' },
      { name: 'accepts neutral JSX text', code: 'const el = <div>pick repositories</div>;' },
      { name: 'accepts neutral comment', code: '// review procedures' },
    ],
    invalid: [
      {
        name: 'reports forbidden word in string literal',
        code: `const label = "${FAKE}";`,
        errors: [{ messageId: 'forbiddenWorkingName' }],
      },
      {
        name: 'reports forbidden word in template literal',
        code: `const label = \`prefix ${FAKE} suffix\`;`,
        errors: [{ messageId: 'forbiddenWorkingName' }],
      },
      {
        name: 'reports forbidden word in JSX text',
        code: `const el = <div>${FAKE}</div>;`,
        errors: [{ messageId: 'forbiddenWorkingName' }],
      },
      {
        name: 'reports forbidden word in comment',
        code: `// ${FAKE}`,
        errors: [{ messageId: 'forbiddenWorkingName' }],
      },
    ],
  });
});

describe('forbidden-name loading', () => {
  it('reads forbidden names from injected file path when env is unset', () => {
    delete process.env[ENV_KEY];
    withTempDir((dir) => {
      const filePath = join(dir, 'names');
      writeFileSync(filePath, `${FAKE}\n`);
      expect(loadForbiddenNames({ filePath })).toEqual([FAKE]);
    });
  });

  it('reads forbidden names from the env option, comma separated, trimmed and lower-cased', () => {
    expect(loadForbiddenNames({ env: ` ${FAKE.toUpperCase()} , other ` })).toEqual([FAKE, 'other']);
  });

  it('prefers env over the file when both are present', () => {
    process.env[ENV_KEY] = FAKE;
    withTempDir((dir) => {
      const filePath = join(dir, 'names');
      writeFileSync(filePath, 'fromfile\n');
      expect(loadForbiddenNames({ filePath })).toEqual([FAKE]);
    });
  });

  it('no-op when neither env nor file is present', () => {
    delete process.env[ENV_KEY];
    withTempDir((dir) => {
      const missing = join(dir, 'missing');
      expect(loadForbiddenNames({ filePath: missing })).toEqual([]);
      const linter = new Linter();
      const code = `const label = "${FAKE}";`;
      // explicit missing file path, env left to the (deleted) environment variable
      expect(linter.verify(code, {
        plugins: { local: plugin },
        rules: { 'local/no-working-name': ['error', { filePath: missing }] },
      })).toEqual([]);
      // explicit empty env and explicit missing file path
      expect(linter.verify(code, {
        plugins: { local: plugin },
        rules: { 'local/no-working-name': ['error', { env: '', filePath: missing }] },
      })).toEqual([]);
    });
  });

  it('returns empty list when forbidden-names file is unreadable or a directory', () => {
    delete process.env[ENV_KEY];
    withTempDir((dir) => {
      expect(loadForbiddenNames({ filePath: dir })).toEqual([]);
      expect(loadForbiddenNames({ filePath: join(dir, 'missing', 'names') })).toEqual([]);
    });
  });

  it('ignores empty entries and treats all-blank config as no-op', () => {
    expect(loadForbiddenNames({ env: ' , ,,  ' })).toEqual([]);
    expect(loadForbiddenNames({ env: `,,${FAKE},  ,` })).toEqual([FAKE]);
    delete process.env[ENV_KEY];
    withTempDir((dir) => {
      const blank = join(dir, 'blank');
      writeFileSync(blank, '\n   \n\t\n');
      expect(loadForbiddenNames({ filePath: blank })).toEqual([]);
      const mixed = join(dir, 'mixed');
      writeFileSync(mixed, `\n  ${FAKE}  \n\nother\n`);
      expect(loadForbiddenNames({ filePath: mixed })).toEqual([FAKE, 'other']);
    });
  });
});

describe('option validation refuses hostile input', () => {
  it('refuses null options', () => {
    expect(readForbiddenNameOptions(null)).toEqual({ ok: false, reason: 'not-plain' });
    expect(loadForbiddenNames(null)).toEqual([]);
  });

  it('refuses wrong primitive options', () => {
    for (const value of [42, 'str', true]) {
      expect(readForbiddenNameOptions(value)).toEqual({ ok: false, reason: 'not-plain' });
      expect(loadForbiddenNames(value)).toEqual([]);
    }
    for (const value of [123n, Symbol('x'), () => {}]) {
      expect(readForbiddenNameOptions(value)).toEqual({ ok: false, reason: 'unsupported-type' });
      expect(loadForbiddenNames(value)).toEqual([]);
    }
  });

  it('refuses array options', () => {
    process.env[ENV_KEY] = FAKE;
    expect(readForbiddenNameOptions([])).toEqual({ ok: false, reason: 'not-plain' });
    expect(loadForbiddenNames([])).toEqual([]);
  });

  it('refuses array-like options', () => {
    process.env[ENV_KEY] = FAKE;
    const arrayLike = { 0: 'a', length: 1 };
    expect(readForbiddenNameOptions(arrayLike)).toEqual({ ok: false, reason: 'unknown-key' });
    expect(loadForbiddenNames(arrayLike)).toEqual([]);
  });

  it('refuses Proxy and revoked Proxy options without triggering traps', () => {
    process.env[ENV_KEY] = FAKE;
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error('trap ran');
    };
    const live = new Proxy({}, {
      get: trap,
      has: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const hostile of [live, revoked]) {
      expect(readForbiddenNameOptions(hostile)).toEqual({ ok: false, reason: 'proxy' });
      expect(loadForbiddenNames(hostile)).toEqual([]);
    }
    expect(trapCalls).toBe(0);
  });

  it('refuses own accessor getter on options without invoking getter', () => {
    process.env[ENV_KEY] = FAKE;
    let getterCalls = 0;
    const options = Object.defineProperty({}, 'env', {
      get() {
        getterCalls += 1;
        throw new Error('getter ran');
      },
      enumerable: true,
    });
    expect(readForbiddenNameOptions(options)).toEqual({ ok: false, reason: 'accessor' });
    expect(loadForbiddenNames(options)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it('refuses inherited getter on options without invoking getter', () => {
    process.env[ENV_KEY] = FAKE;
    let getterCalls = 0;
    const options = Object.create({
      get env() {
        getterCalls += 1;
        throw new Error('inherited getter ran');
      },
    });
    expect(readForbiddenNameOptions(options)).toEqual({ ok: false, reason: 'not-plain' });
    expect(loadForbiddenNames(options)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it('refuses Symbol.iterator override on options', () => {
    process.env[ENV_KEY] = FAKE;
    let iteratorCalls = 0;
    const options = {
      [Symbol.iterator]() {
        iteratorCalls += 1;
        throw new Error('iterator ran');
      },
    };
    expect(readForbiddenNameOptions(options)).toEqual({ ok: false, reason: 'symbol-key' });
    expect(loadForbiddenNames(options)).toEqual([]);
    expect(iteratorCalls).toBe(0);
  });

  it('refuses reserved own keys (__proto__, constructor, prototype) on options', () => {
    process.env[ENV_KEY] = FAKE;
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const options = Object.defineProperty({}, key, {
        value: 'x',
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(readForbiddenNameOptions(options)).toEqual({ ok: false, reason: 'reserved-key' });
      expect(loadForbiddenNames(options)).toEqual([]);
    }
  });

  it('refuses extra unknown keys on options', () => {
    const options = { env: FAKE, extra: 'x' };
    expect(readForbiddenNameOptions(options)).toEqual({ ok: false, reason: 'unknown-key' });
    expect(loadForbiddenNames(options)).toEqual([]);
  });

  it('refuses non-string env or filePath values on options', () => {
    process.env[ENV_KEY] = FAKE;
    for (const options of [{ env: 123 }, { filePath: 123 }]) {
      expect(readForbiddenNameOptions(options)).toEqual({ ok: false, reason: 'invalid-option-type' });
      expect(loadForbiddenNames(options)).toEqual([]);
    }
  });

  it('accepts undefined and valid string options', () => {
    expect(readForbiddenNameOptions(undefined)).toEqual({ ok: true, value: {} });
    expect(readForbiddenNameOptions({ env: FAKE, filePath: 'p' })).toEqual({
      ok: true,
      value: { env: FAKE, filePath: 'p' },
    });
  });

  const malformedOutcomes: Array<[string, unknown]> = [
    ['null', null],
    ['ok not boolean', { ok: 'yes' }],
    ['ok true without value', { ok: true }],
    ['reason not string', { ok: false, reason: 123 }],
  ];

  it('refuses malformed snapshot outcome object', () => {
    for (const [, outcome] of malformedOutcomes) {
      const badSnapshot = () => outcome;
      expect(readForbiddenNameOptions({}, badSnapshot)).toEqual({
        ok: false,
        reason: 'invalid-outcome',
      });
    }
    const throwing = () => {
      throw new Error('snapshot threw');
    };
    expect(readForbiddenNameOptions({}, throwing)).toEqual({ ok: false, reason: 'invalid-outcome' });
    expect(readForbiddenNameOptions({}, 'nope' as never)).toEqual({
      ok: false,
      reason: 'invalid-outcome',
    });
  });

  it('treats a malformed snapshot outcome as no forbidden names', () => {
    process.env[ENV_KEY] = FAKE;
    for (const [, outcome] of malformedOutcomes) {
      const badSnapshot = () => outcome;
      expect(loadForbiddenNames({}, badSnapshot)).toEqual([]);
    }
  });

  it('refuses an outcome with a throwing ok getter without invoking it or throwing', () => {
    process.env[ENV_KEY] = FAKE;
    let getterCalls = 0;
    const outcome = {
      get ok(): boolean {
        getterCalls += 1;
        throw new Error('ok getter ran');
      },
      value: { env: FAKE },
    };
    const snapshot = () => outcome;
    expect(() => readForbiddenNameOptions({}, snapshot)).not.toThrow();
    expect(readForbiddenNameOptions({}, snapshot)).toEqual({ ok: false, reason: 'invalid-outcome' });
    expect(() => loadForbiddenNames({}, snapshot)).not.toThrow();
    expect(loadForbiddenNames({}, snapshot)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it('refuses an outcome with a throwing value getter without invoking it or throwing', () => {
    process.env[ENV_KEY] = FAKE;
    let getterCalls = 0;
    const outcome = {
      ok: true,
      get value(): unknown {
        getterCalls += 1;
        throw new Error('value getter ran');
      },
    };
    const snapshot = () => outcome;
    expect(() => readForbiddenNameOptions({}, snapshot)).not.toThrow();
    expect(readForbiddenNameOptions({}, snapshot)).toEqual({ ok: false, reason: 'invalid-outcome' });
    expect(() => loadForbiddenNames({}, snapshot)).not.toThrow();
    expect(loadForbiddenNames({}, snapshot)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it('refuses a Proxy outcome whose traps throw without throwing', () => {
    process.env[ENV_KEY] = FAKE;
    const trap = () => {
      throw new Error('trap ran');
    };
    const outcome = new Proxy({}, {
      get: trap,
      has: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    const snapshot = () => outcome;
    expect(() => readForbiddenNameOptions({}, snapshot)).not.toThrow();
    expect(readForbiddenNameOptions({}, snapshot)).toEqual({ ok: false, reason: 'invalid-outcome' });
    expect(loadForbiddenNames({}, snapshot)).toEqual([]);
  });

  it('parses 5000 distinct names from env and from a file and returns them all in order', () => {
    delete process.env[ENV_KEY];
    const expected = Array.from({ length: 5000 }, (_, index) => `name${index}`);
    const withDuplicates = [...expected, ...expected.slice(0, 100)];
    expect(loadForbiddenNames({ env: withDuplicates.join(',') })).toEqual(expected);
    withTempDir((dir) => {
      const filePath = join(dir, 'names');
      writeFileSync(filePath, `${withDuplicates.join('\n')}\n`);
      expect(loadForbiddenNames({ filePath })).toEqual(expected);
    });
  });

  it('passes a well-formed injected snapshot outcome through to the loader', () => {
    delete process.env[ENV_KEY];
    const seen: unknown[] = [];
    const snapshot = (value: unknown, isProxy: unknown) => {
      seen.push(value, typeof isProxy);
      return { ok: true, value: { env: FAKE } };
    };
    expect(loadForbiddenNames({}, snapshot)).toEqual([FAKE]);
    expect(seen).toEqual([{}, 'function']);
  });
});

interface ScanResult {
  readonly matches: string[];
  readonly skipped: string[];
}

function scanSourceTree(root: string, names: readonly string[], skipTests: boolean): ScanResult {
  const result: ScanResult = { matches: [], skipped: [] };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const rel = relative(root, path).split('\\').join('/');
      if (skipTests && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx'))) {
        result.skipped.push(rel);
        continue;
      }
      const text = readFileSync(path, 'utf8').toLowerCase();
      if (names.some((name) => text.includes(name))) {
        result.matches.push(rel);
      }
    }
  };
  walk(root);
  return result;
}

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));

describe('apps/web/src source scan', () => {
  it('no non-test file under apps/web/src contains any configured forbidden name', () => {
    const names = loadForbiddenNames();
    const result = scanSourceTree(SRC_ROOT, names, true);
    expect(result.matches).toEqual([]);
  });

  it('detects a configured forbidden name in a non-test file and skips test files', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'nested', 'copy.ts'), `export const x = "${FAKE}";\n`);
      writeFileSync(join(dir, 'a.test.ts'), `// ${FAKE}\n`);
      writeFileSync(join(dir, 'b.test.tsx'), `// ${FAKE}\n`);
      writeFileSync(join(dir, 'clean.ts'), 'export const y = 1;\n');
      const result = scanSourceTree(dir, [FAKE], true);
      expect(result.matches).toEqual(['nested/copy.ts']);
      expect(result.skipped.sort()).toEqual(['a.test.ts', 'b.test.tsx']);
    });
  });

  it('skips *.test.ts and *.test.tsx files under apps/web/src when FLEET_WEB_FORBIDDEN_NAMES is set', () => {
    process.env[ENV_KEY] = FAKE;
    const names = loadForbiddenNames();
    expect(names).toEqual([FAKE]);
    const skippingTests = scanSourceTree(SRC_ROOT, names, true);
    expect(skippingTests.matches).toEqual([]);
    expect(skippingTests.skipped).toContain('lib/flow-copy.test.ts');
    expect(skippingTests.skipped.every((file) => /\.test\.tsx?$/.test(file))).toBe(true);
    // without the skip the same tree does match, so the skip is what keeps the result empty
    const notSkipping = scanSourceTree(SRC_ROOT, names, false);
    expect(notSkipping.matches).toContain('lib/flow-copy.test.ts');
  });
});
