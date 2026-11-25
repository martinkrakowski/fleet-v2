import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allowListedChildEnv } from '../spawn-run.js';

/**
 * Direct unit tests for `allowListedChildEnv`, the barrier that keeps host
 * credentials out of spawned review and evidence child processes. Test
 * values are synthetic; no real `process.env` value is ever read or logged.
 */

/** Every `process.env` key this suite may touch, snapshotted and restored. */
const TOUCHED_KEYS = [
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

/** Pre-existing host values keyed by name, never printed or asserted on. */
const savedValues = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of TOUCHED_KEYS) {
    if (!savedValues.has(key)) {
      savedValues.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
    }
  }
});

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    const saved = savedValues.get(key);
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
  savedValues.clear();
});

describe('allowListedChildEnv', () => {
  it('copies only local allow-listed keys and excludes SSH_AUTH_SOCK for local transport', () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
    process.env.PATH = 'synthetic-path';
    process.env.HOME = 'synthetic-home';
    process.env.USER = 'synthetic-user';
    process.env.LOGNAME = 'synthetic-logname';
    process.env.LANG = 'synthetic-lang';
    process.env.LC_ALL = 'synthetic-lc-all';
    process.env.TMPDIR = 'synthetic-tmpdir';
    process.env.SSH_AUTH_SOCK = 'synthetic-agent-sock';

    const result = allowListedChildEnv('local');

    expect(result).toStrictEqual({
      PATH: 'synthetic-path',
      HOME: 'synthetic-home',
      USER: 'synthetic-user',
      LOGNAME: 'synthetic-logname',
      LANG: 'synthetic-lang',
      LC_ALL: 'synthetic-lc-all',
      TMPDIR: 'synthetic-tmpdir',
    });
    expect(Object.hasOwn(result, 'SSH_AUTH_SOCK')).toBe(false);
  });

  it('includes SSH_AUTH_SOCK alongside local allow-listed keys for ssh transport', () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
    process.env.PATH = 'synthetic-path';
    process.env.HOME = 'synthetic-home';
    process.env.USER = 'synthetic-user';
    process.env.LOGNAME = 'synthetic-logname';
    process.env.LANG = 'synthetic-lang';
    process.env.LC_ALL = 'synthetic-lc-all';
    process.env.TMPDIR = 'synthetic-tmpdir';
    process.env.SSH_AUTH_SOCK = 'synthetic-agent-sock';

    const result = allowListedChildEnv('ssh');

    expect(result).toStrictEqual({
      PATH: 'synthetic-path',
      HOME: 'synthetic-home',
      USER: 'synthetic-user',
      LOGNAME: 'synthetic-logname',
      LANG: 'synthetic-lang',
      LC_ALL: 'synthetic-lc-all',
      TMPDIR: 'synthetic-tmpdir',
      SSH_AUTH_SOCK: 'synthetic-agent-sock',
    });
  });

  it('omits unset allow-listed variables instead of setting undefined', () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
    process.env.PATH = 'synthetic-path';
    process.env.HOME = 'synthetic-home';
    process.env.USER = 'synthetic-user';
    process.env.LOGNAME = 'synthetic-logname';
    process.env.LANG = 'synthetic-lang';
    delete process.env.LC_ALL;
    delete process.env.TMPDIR;
    delete process.env.SSH_AUTH_SOCK;

    const local = allowListedChildEnv('local');

    expect(Object.hasOwn(local, 'LC_ALL')).toBe(false);
    expect(Object.hasOwn(local, 'TMPDIR')).toBe(false);
    expect(local).toStrictEqual({
      PATH: 'synthetic-path',
      HOME: 'synthetic-home',
      USER: 'synthetic-user',
      LOGNAME: 'synthetic-logname',
      LANG: 'synthetic-lang',
    });

    const ssh = allowListedChildEnv('ssh');

    expect(Object.hasOwn(ssh, 'LC_ALL')).toBe(false);
    expect(Object.hasOwn(ssh, 'TMPDIR')).toBe(false);
    expect(Object.hasOwn(ssh, 'SSH_AUTH_SOCK')).toBe(false);
    expect(ssh).toStrictEqual({
      PATH: 'synthetic-path',
      HOME: 'synthetic-home',
      USER: 'synthetic-user',
      LOGNAME: 'synthetic-logname',
      LANG: 'synthetic-lang',
    });
  });

  it('keeps allow-listed variables set to empty string', () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
    process.env.LANG = '';
    process.env.HOME = 'synthetic-home';

    const result = allowListedChildEnv('local');

    // An empty string is an explicitly set value, distinct from `undefined`:
    // the key must be present with value `''`, never omitted.
    expect(Object.hasOwn(result, 'LANG')).toBe(true);
    expect(result.LANG).toBe('');
    expect(result).toStrictEqual({ LANG: '', HOME: 'synthetic-home' });
  });

  it('excludes credential-shaped variables for both local and ssh transports', () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
    // Built at runtime so no credential-shaped literal ever appears here.
    const secret = 'k' + 'x'.repeat(12);
    process.env.GH_TOKEN = secret;
    process.env.GITHUB_TOKEN = secret;
    process.env.AWS_SECRET_ACCESS_KEY = secret;
    process.env.OPENROUTER_API_KEY = secret;
    process.env.HTTPS_PROXY = secret;
    process.env.NODE_OPTIONS = secret;
    process.env.LD_PRELOAD = secret;

    for (const transport of ['local', 'ssh'] as const) {
      const result = allowListedChildEnv(transport);
      for (const key of [
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'AWS_SECRET_ACCESS_KEY',
        'OPENROUTER_API_KEY',
        'HTTPS_PROXY',
        'NODE_OPTIONS',
        'LD_PRELOAD',
      ]) {
        expect(Object.hasOwn(result, key), `${transport}: ${key} present`).toBe(false);
      }
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('returns a fresh plain object on each call', () => {
    for (const key of TOUCHED_KEYS) {
      delete process.env[key];
    }
    process.env.HOME = 'synthetic-home';

    const first = allowListedChildEnv('local');
    const second = allowListedChildEnv('local');
    first.HOME = 'mutated';

    expect(second.HOME).toBe('synthetic-home');
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(second)).toBe(Object.prototype);
  });

  it.skipIf(process.platform === 'win32')(
    'ignores lowercase path on non-win32 platforms',
    () => {
      for (const key of TOUCHED_KEYS) {
        delete process.env[key];
      }
      process.env.path = 'synthetic-lowercase-path';
      process.env.PATH = 'synthetic-uppercase-path';

      const withBoth = allowListedChildEnv('local');

      expect(withBoth.PATH).toBe('synthetic-uppercase-path');
      expect(Object.hasOwn(withBoth, 'path')).toBe(false);

      delete process.env.PATH;

      const withoutUpper = allowListedChildEnv('local');

      expect(Object.hasOwn(withoutUpper, 'PATH')).toBe(false);
      expect(Object.hasOwn(withoutUpper, 'path')).toBe(false);
    },
  );
});
