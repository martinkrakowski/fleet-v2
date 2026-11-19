/**
 * KEY1b — hostile-input suite for the owner-key domain boundary. Every test
 * asserts the specific typed code (never merely that nothing threw); a
 * getter's call counter must stay 0, and a Proxy over valid input must yield
 * exactly the plain-data result with no `get` trap run.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_KEY_PATH_LENGTH,
  MAX_PATH_SEGMENTS,
  checkOwnerKeyPathSafety,
  formatOwnerInstallationEdit,
} from './owner-key.js';

/** Canonical base64 of exactly 32 bytes. */
const VALID_KEY = Buffer.alloc(32, 9).toString('base64');

function safeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetPath: '/keys/owner-key.pem',
    ancestorGitMarkers: [],
    ...overrides,
  };
}

describe('checkOwnerKeyPathSafety hostile input', () => {
  it('null', () => {
    expect(checkOwnerKeyPathSafety(null)).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('undefined', () => {
    expect(checkOwnerKeyPathSafety(undefined)).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('a wrong primitive (a number where a record is due)', () => {
    expect(checkOwnerKeyPathSafety(7)).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('an array where a record is due', () => {
    expect(checkOwnerKeyPathSafety([])).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('a non-plain object (class instance) where a record is due', () => {
    class Shape {
      targetPath = '/keys/k.pem';
    }
    expect(checkOwnerKeyPathSafety(new Shape())).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('a non-iterable object where a list is due (ancestorGitMarkers)', () => {
    expect(checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: {} }))).toEqual({
      ok: false,
      code: 'invalid-input',
    });
  });

  it('an array hole (a sparse marker array)', () => {
    const sparse: string[] = new Array(3);
    sparse[0] = '/repo/.git';
    sparse[2] = '/repo/.git';
    expect(checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: sparse }))).toEqual({
      ok: false,
      code: 'hostile-input',
    });
  });

  it('an array-like object where a list is due', () => {
    expect(
      checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: { length: 1, 0: '/repo/.git' } })),
    ).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('an enormous length (sparse array of length 2**32 - 1, refused before traversal)', () => {
    const enormous: string[] = new Array(2 ** 32 - 1);
    const start = process.hrtime.bigint();
    const result = checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: enormous }));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(result).toEqual({ ok: false, code: 'too-many-segments' });
    // Refused before any traversal: far under any traversal time.
    expect(elapsedMs).toBeLessThan(100);
  });

  it('an over-long marker array beyond MAX_PATH_SEGMENTS', () => {
    const markers = Array.from({ length: MAX_PATH_SEGMENTS + 1 }, () => '/repo/.git');
    expect(checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: markers }))).toEqual({
      ok: false,
      code: 'too-many-segments',
    });
  });

  it('a getter on the root (the getter must never run)', () => {
    let calls = 0;
    const input = {
      get targetPath(): string {
        calls += 1;
        return '/keys/k.pem';
      },
      ancestorGitMarkers: [],
    };
    expect(checkOwnerKeyPathSafety(input)).toEqual({ ok: false, code: 'hostile-input' });
    expect(calls).toBe(0);
  });

  it('a getter on a marker item (the getter must never run)', () => {
    let calls = 0;
    const markers: string[] = [];
    Object.defineProperty(markers, 0, {
      enumerable: true,
      get() {
        calls += 1;
        return '/repo/.git';
      },
    });
    expect(checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: markers }))).toEqual({
      ok: false,
      code: 'hostile-input',
    });
    expect(calls).toBe(0);
  });

  it('a Proxy over a valid input yields the plain-data result with no get trap run', () => {
    let getTraps = 0;
    const plain = safeInput();
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(checkOwnerKeyPathSafety(proxy)).toEqual(checkOwnerKeyPathSafety(plain));
    expect(getTraps).toBe(0);
  });

  it('a Proxy over a valid marker array yields the plain-data result with no get trap run', () => {
    let getTraps = 0;
    const plainMarkers = ['/repo/.git'];
    const proxyMarkers = new Proxy(plainMarkers, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: proxyMarkers }));
    expect(result).toEqual(
      checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: plainMarkers })),
    );
    // `length` and the elements come from their own data descriptors only:
    // no `get` trap ever runs, not even for `length`.
    expect(getTraps).toBe(0);
  });

  it('a prototype-polluting own key (__proto__ via JSON.parse)', () => {
    const parsed = JSON.parse(
      '{"__proto__":{"x":1},"targetPath":"/keys/k.pem","ancestorGitMarkers":[]}',
    ) as Record<string, unknown>;
    // `JSON.parse` makes `__proto__` an own data property; still refused.
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(checkOwnerKeyPathSafety(parsed)).toEqual({ ok: false, code: 'hostile-input' });
  });

  it('a prototype-polluting own key (constructor)', () => {
    const parsed = JSON.parse(
      '{"constructor":{"x":1},"targetPath":"/keys/k.pem","ancestorGitMarkers":[]}',
    ) as Record<string, unknown>;
    expect(checkOwnerKeyPathSafety(parsed)).toEqual({ ok: false, code: 'hostile-input' });
  });

  it('an over-long target path beyond MAX_KEY_PATH_LENGTH', () => {
    expect(
      checkOwnerKeyPathSafety(safeInput({ targetPath: `/keys/${'x'.repeat(MAX_KEY_PATH_LENGTH)}` })),
    ).toEqual({ ok: false, code: 'path-too-long' });
  });

  it('a NUL byte in the target path', () => {
    expect(checkOwnerKeyPathSafety(safeInput({ targetPath: '/keys/\0k.pem' }))).toEqual({
      ok: false,
      code: 'invalid-input',
    });
  });

  it('a missing targetPath', () => {
    expect(checkOwnerKeyPathSafety({ ancestorGitMarkers: [] })).toEqual({
      ok: false,
      code: 'invalid-input',
    });
  });

  it('an unknown key on the record', () => {
    expect(checkOwnerKeyPathSafety(safeInput({ extra: 1 }))).toEqual({
      ok: false,
      code: 'invalid-input',
    });
  });
});

describe('checkOwnerKeyPathSafety verdicts', () => {
  it('accepts a plain path outside every exclusion', () => {
    expect(checkOwnerKeyPathSafety(safeInput())).toEqual({ ok: true, targetPath: '/keys/owner-key.pem' });
  });

  it('refuses a targetPath exactly equal to the state dir', () => {
    expect(
      checkOwnerKeyPathSafety(safeInput({ targetPath: '/state', stateDir: '/state' })),
    ).toEqual({ ok: false, code: 'unsafe-path-state-dir' });
  });

  it('refuses a targetPath inside the state dir', () => {
    expect(
      checkOwnerKeyPathSafety(
        safeInput({ targetPath: '/state/journals/x.json', stateDir: '/state' }),
      ),
    ).toEqual({ ok: false, code: 'unsafe-path-state-dir' });
  });

  it('refuses a targetPath inside the state dir through a normalized parent', () => {
    expect(
      checkOwnerKeyPathSafety(
        safeInput({ targetPath: '/state/./journals/../x.json', stateDir: '/state' }),
      ),
    ).toEqual({ ok: false, code: 'unsafe-path-state-dir' });
  });

  it('refuses a target inside a git marker path', () => {
    expect(
      checkOwnerKeyPathSafety(
        safeInput({ targetPath: '/repo/.git/config', ancestorGitMarkers: ['/repo/.git'] }),
      ),
    ).toEqual({ ok: false, code: 'unsafe-path-git-repo' });
  });

  it('refuses a target equal to a git marker path', () => {
    expect(
      checkOwnerKeyPathSafety(
        safeInput({ targetPath: '/repo/.git', ancestorGitMarkers: ['/repo/.git'] }),
      ),
    ).toEqual({ ok: false, code: 'unsafe-path-git-repo' });
  });

  it('refuses a target whose own path carries a .git segment', () => {
    expect(
      checkOwnerKeyPathSafety(safeInput({ targetPath: '/repo/.git/hooks/x' })),
    ).toEqual({ ok: false, code: 'unsafe-path-git-repo' });
  });

  it('a non-git marker ancestor does not refuse', () => {
    expect(
      checkOwnerKeyPathSafety(safeInput({ ancestorGitMarkers: ['/repo/not-git'] })),
    ).toEqual({ ok: true, targetPath: '/keys/owner-key.pem' });
  });
});

describe('formatOwnerInstallationEdit hostile input', () => {
  it('null', () => {
    expect(formatOwnerInstallationEdit(null)).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('undefined', () => {
    expect(formatOwnerInstallationEdit(undefined)).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('a wrong primitive (a number where a string is due)', () => {
    expect(formatOwnerInstallationEdit(44)).toEqual({ ok: false, code: 'invalid-input' });
  });

  it('a wrong length (not 44 characters)', () => {
    expect(formatOwnerInstallationEdit(VALID_KEY.slice(0, 43))).toEqual({
      ok: false,
      code: 'invalid-public-key',
    });
  });

  it('a URL-safe base64 alphabet', () => {
    const urlSafe = `${VALID_KEY.slice(0, 42)}-_`;
    // The canonical alphabet refuses `-` and `_` even at the same length.
    expect(urlSafe).toHaveLength(44);
    expect(formatOwnerInstallationEdit(urlSafe)).toEqual({
      ok: false,
      code: 'invalid-public-key',
    });
  });

  it('embedded whitespace', () => {
    const spaced = `${VALID_KEY.slice(0, 21)} ${VALID_KEY.slice(22)}`;
    expect(formatOwnerInstallationEdit(spaced)).toEqual({
      ok: false,
      code: 'invalid-public-key',
    });
  });

  it('non-canonical padding (two = characters)', () => {
    const padded = `${'A'.repeat(42)}==`;
    expect(formatOwnerInstallationEdit(padded)).toEqual({
      ok: false,
      code: 'invalid-public-key',
    });
  });

  it('accepts a canonical key and prints the exact installation edit', () => {
    const result = formatOwnerInstallationEdit(VALID_KEY);
    expect(result).toEqual({
      ok: true,
      publicKey: VALID_KEY,
      installationEdit: `{ "owner": { "publicKey": "${VALID_KEY}" } }`,
    });
  });
});

describe('counter-tests', () => {
  it('a constant-verdict function would fail: different inputs give different verdicts', () => {
    const inside = checkOwnerKeyPathSafety(
      safeInput({ targetPath: '/state/x', stateDir: '/state' }),
    );
    const outside = checkOwnerKeyPathSafety(
      safeInput({ targetPath: '/keys/x', stateDir: '/state' }),
    );
    expect(inside).not.toEqual(outside);
    expect(outside).toEqual({ ok: true, targetPath: '/keys/x' });
  });

  it('an identity echo of the input would fail: results are typed verdicts, not the input', () => {
    const input = safeInput();
    const result = checkOwnerKeyPathSafety(input);
    expect(result).not.toBe(input);
    expect(result).toHaveProperty('ok', true);
    const editInput = VALID_KEY;
    const edit = formatOwnerInstallationEdit(editInput);
    expect(edit).not.toBe(editInput);
    expect(edit).toHaveProperty('ok', true);
    // A URL-safe twin is refused, never echoed back as accepted.
    expect(formatOwnerInstallationEdit(`${VALID_KEY.slice(0, 42)}-_`)).toHaveProperty(
      'ok',
      false,
    );
  });
});
