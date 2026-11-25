import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allowListedChildEnv } from '../spawn-run.js';

/**
 * Every `process.env` key this suite touches. Each key is snapshotted with
 * `Object.hasOwn` before the suite runs and restored (or deleted) in
 * `afterEach`, so host values are never read, logged or asserted on, and
 * never leak between tests.
 */
const TOUCHED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'path',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'OPENROUTER_API_KEY',
  'HTTPS_PROXY',
  'NODE_OPTIONS',
  'LD_PRELOAD',
] as const;

const LOCAL_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

const SSH_KEYS = [...LOCAL_KEYS, 'SSH_AUTH_SOCK'] as const;

const SYNTHETIC_VALUES: Record<string, string> = {
  PATH: '/synthetic/bin',
  HOME: '/synthetic/home',
  USER: 'synthetic-user',
  LOGNAME: 'synthetic-user',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TMPDIR: '/synthetic/tmp',
  SSH_AUTH_SOCK: '/synthetic/agent.sock',
};

interface EnvSnapshot {
  present: boolean;
  value: string | undefined;
}

const snapshots = new Map<string, EnvSnapshot>();

beforeEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    snapshots.set(key, {
      present: Object.hasOwn(process.env, key),
      value: process.env[key],
    });
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    const snapshot = snapshots.get(key);
    if (snapshot?.present) {
      process.env[key] = snapshot.value;
    } else {
      delete process.env[key];
    }
  }
  snapshots.clear();
});

describe('allowListedChildEnv', () => {
  it('copies only local allow-listed keys and excludes SSH_AUTH_SOCK for local transport', () => {
    for (const key of SSH_KEYS) {
      process.env[key] = SYNTHETIC_VALUES[key];
    }

    const result = allowListedChildEnv('local');

    expect(result).toStrictEqual(Object.fromEntries(LOCAL_KEYS.map((k) => [k, SYNTHETIC_VALUES[k]])));
    expect(Object.hasOwn(result, 'SSH_AUTH_SOCK')).toBe(false);
  });

  it('includes SSH_AUTH_SOCK alongside local allow-listed keys for ssh transport', () => {
    for (const key of SSH_KEYS) {
      process.env[key] = SYNTHETIC_VALUES[key];
    }

    const result = allowListedChildEnv('ssh');

    expect(result).toStrictEqual(Object.fromEntries(SSH_KEYS.map((k) => [k, SYNTHETIC_VALUES[k]])));
  });

  it('omits unset allow-listed variables instead of setting undefined', () => {
    process.env.PATH = SYNTHETIC_VALUES.PATH;
    process.env.HOME = SYNTHETIC_VALUES.HOME;
    process.env.USER = SYNTHETIC_VALUES.USER;
    // LANG, LC_ALL, TMPDIR, SSH_AUTH_SOCK stay deleted by beforeEach.

    const local = allowListedChildEnv('local');
    expect(Object.hasOwn(local, 'LANG')).toBe(false);
    expect(Object.hasOwn(local, 'LC_ALL')).toBe(false);
    expect(Object.hasOwn(local, 'TMPDIR')).toBe(false);
    expect(local).toStrictEqual({
      PATH: SYNTHETIC_VALUES.PATH,
      HOME: SYNTHETIC_VALUES.HOME,
      USER: SYNTHETIC_VALUES.USER,
    });

    const ssh = allowListedChildEnv('ssh');
    expect(Object.hasOwn(ssh, 'SSH_AUTH_SOCK')).toBe(false);
    expect(ssh).toStrictEqual({
      PATH: SYNTHETIC_VALUES.PATH,
      HOME: SYNTHETIC_VALUES.HOME,
      USER: SYNTHETIC_VALUES.USER,
    });
  });

  it('keeps allow-listed variables set to empty string', () => {
    // An empty string is an explicitly set value, distinct from `undefined`:
    // the variable exists and must be forwarded as ''.
    process.env.LANG = '';

    const result = allowListedChildEnv('local');

    expect(Object.hasOwn(result, 'LANG')).toBe(true);
    expect(result.LANG).toBe('');
  });

  it('excludes credential-shaped variables for both local and ssh transports', () => {
    // Built at runtime so no credential-shaped literal ever appears here.
    const secret = 'k' + 'x'.repeat(12);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENROUTER_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'LD_PRELOAD'] as const) {
      process.env[key] = secret;
    }

    for (const transport of ['local', 'ssh'] as const) {
      const result = allowListedChildEnv(transport);
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENROUTER_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'LD_PRELOAD'] as const) {
        expect(Object.hasOwn(result, key), `${transport} must not copy ${key}`).toBe(false);
      }
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('returns a fresh plain object on each call', () => {
    process.env.HOME = SYNTHETIC_VALUES.HOME;

    const first = allowListedChildEnv('local');
    const second = allowListedChildEnv('local');

    first.HOME = 'mutated';
    expect(second.HOME).toBe(SYNTHETIC_VALUES.HOME);
    // A plain Object prototype means allow-listed iteration never copies
    // exotic shapes (getters, Proxies, array-likes) from `process.env`.
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(second)).toBe(Object.prototype);
  });

  // Windows has case-insensitive environment variables, so the lowercase
  // `path` guard only applies off win32.
  it.skipIf(process.platform === 'win32')(
    'ignores lowercase path on non-win32 platforms',
    () => {
    // Uppercase PATH present with a lowercase `path` also set: only the
    // exact uppercase key is copied.
    process.env.path = '/lowercase-only';
    process.env.PATH = SYNTHETIC_VALUES.PATH;
    const withBoth = allowListedChildEnv('local');
    expect(withBoth.PATH).toBe(SYNTHETIC_VALUES.PATH);
    expect(Object.hasOwn(withBoth, 'path')).toBe(false);

    // Uppercase PATH deleted: nothing is copied for it, and the lowercase
    // `path` is still ignored.
    delete process.env.PATH;
    const withoutPath = allowListedChildEnv('local');
    expect(Object.hasOwn(withoutPath, 'PATH')).toBe(false);
    expect(Object.hasOwn(withoutPath, 'path')).toBe(false);
    },
  );
});
