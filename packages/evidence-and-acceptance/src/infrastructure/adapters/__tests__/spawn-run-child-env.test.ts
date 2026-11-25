import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { allowListedChildEnv } from '../spawn-run.js';

/**
 * Every variable this suite may touch on `process.env`. The host's own
 * environment is snapshotted (presence only for assertions never made here)
 * and restored or deleted key by key, so the suite is hermetic and never
 * reads, logs or asserts on a real host value.
 */
const TOUCHED_ENV_KEYS: readonly string[] = [
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
];

const SAVED_ENV = new Map<string, string | undefined>();

const setEnv = (key: string, value: string): void => {
  process.env[key] = value;
};

const deleteEnv = (key: string): void => {
  delete process.env[key];
};

beforeEach(() => {
  SAVED_ENV.clear();
  for (const key of TOUCHED_ENV_KEYS) {
    SAVED_ENV.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
  }
});

afterEach(() => {
  for (const [key, saved] of SAVED_ENV) {
    if (saved === undefined) {
      deleteEnv(key);
    } else {
      setEnv(key, saved);
    }
  }
  SAVED_ENV.clear();
});

/**
 * Synthetic values: test fixtures only, never host data, and never a value
 * shaped like a real token. Prefix `t-` marks every fixture.
 */
const PATH_VALUE = 't-path';
const HOME_VALUE = 't-home';
const USER_VALUE = 't-user';
const LOGNAME_VALUE = 't-logname';
const LANG_VALUE = 't-lang';
const LC_ALL_VALUE = 't-lc-all';
const TMPDIR_VALUE = 't-tmpdir';
const SSH_AUTH_SOCK_VALUE = 't-agent-sock';
const PATH_LOWER_VALUE = 't-path-lowercase';

/** Full local set, keyed exactly as `CHILD_ENV_ALLOWLIST` lists them. */
const LOCAL_ALL: Record<string, string> = {
  PATH: PATH_VALUE,
  HOME: HOME_VALUE,
  USER: USER_VALUE,
  LOGNAME: LOGNAME_VALUE,
  LANG: LANG_VALUE,
  LC_ALL: LC_ALL_VALUE,
  TMPDIR: TMPDIR_VALUE,
};

const setAllEight = (): void => {
  setEnv('PATH', PATH_VALUE);
  setEnv('HOME', HOME_VALUE);
  setEnv('USER', USER_VALUE);
  setEnv('LOGNAME', LOGNAME_VALUE);
  setEnv('LANG', LANG_VALUE);
  setEnv('LC_ALL', LC_ALL_VALUE);
  setEnv('TMPDIR', TMPDIR_VALUE);
  setEnv('SSH_AUTH_SOCK', SSH_AUTH_SOCK_VALUE);
};

/**
 * A credential-shaped value built at runtime, never a literal. It is 13
 * characters, plausible enough that any leak of it into the result is
 * detectable by a JSON scan, and it is not itself a secret.
 */
const secret = 'k' + 'x'.repeat(12);

/** Credential-shaped and policy-sensitive keys a child must never see. */
const FORBIDDEN_KEYS: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'OPENROUTER_API_KEY',
  'HTTPS_PROXY',
  'NODE_OPTIONS',
  'LD_PRELOAD',
];

describe('allowListedChildEnv', () => {
  it('copies only local allow-listed keys and excludes SSH_AUTH_SOCK for local transport', () => {
    // Arrange: all seven local keys plus the ssh-only key are set.
    setAllEight();

    // Act.
    const env = allowListedChildEnv('local');

    // Assert: exactly the seven local keys with their exact values.
    expect(env).toStrictEqual(LOCAL_ALL);
    expect(Object.hasOwn(env, 'SSH_AUTH_SOCK')).toBe(false);
  });

  it('includes SSH_AUTH_SOCK alongside local allow-listed keys for ssh transport', () => {
    setAllEight();

    const env = allowListedChildEnv('ssh');

    expect(env).toStrictEqual({ ...LOCAL_ALL, SSH_AUTH_SOCK: SSH_AUTH_SOCK_VALUE });
  });

  it('omits unset allow-listed variables instead of setting undefined', () => {
    setAllEight();
    deleteEnv('LC_ALL');
    deleteEnv('TMPDIR');
    deleteEnv('SSH_AUTH_SOCK');

    const local = allowListedChildEnv('local');
    const ssh = allowListedChildEnv('ssh');

    // The deleted keys are omitted entirely, never present with undefined.
    expect(Object.hasOwn(local, 'LC_ALL')).toBe(false);
    expect(Object.hasOwn(local, 'TMPDIR')).toBe(false);
    expect(Object.hasOwn(ssh, 'LC_ALL')).toBe(false);
    expect(Object.hasOwn(ssh, 'TMPDIR')).toBe(false);
    expect(Object.hasOwn(ssh, 'SSH_AUTH_SOCK')).toBe(false);
    // The keys that are still set carry their exact values and nothing else.
    expect(local).toStrictEqual({
      PATH: PATH_VALUE,
      HOME: HOME_VALUE,
      USER: USER_VALUE,
      LOGNAME: LOGNAME_VALUE,
      LANG: LANG_VALUE,
    });
    expect(ssh).toStrictEqual({
      PATH: PATH_VALUE,
      HOME: HOME_VALUE,
      USER: USER_VALUE,
      LOGNAME: LOGNAME_VALUE,
      LANG: LANG_VALUE,
    });
  });

  it('keeps allow-listed variables set to empty string', () => {
    // Empty string is a set value, distinct from an unset (undefined) one:
    // the function must copy it, never treat it as absence.
    setAllEight();
    setEnv('LANG', '');

    const env = allowListedChildEnv('local');

    expect(Object.hasOwn(env, 'LANG')).toBe(true);
    expect(env.LANG).toBe('');
    expect(env).toStrictEqual({
      PATH: PATH_VALUE,
      HOME: HOME_VALUE,
      USER: USER_VALUE,
      LOGNAME: LOGNAME_VALUE,
      LANG: '',
      LC_ALL: LC_ALL_VALUE,
      TMPDIR: TMPDIR_VALUE,
    });
  });

  it('excludes credential-shaped variables for both local and ssh transports', () => {
    setAllEight();
    for (const key of FORBIDDEN_KEYS) {
      setEnv(key, secret);
    }

    // The result is not merely "missing the forbidden keys": it must still
    // carry every allow-listed key with its exact value, so a constant {}
    // (or any implementation that drops real values) fails this test too.
    const expectedSsh = { ...LOCAL_ALL, SSH_AUTH_SOCK: SSH_AUTH_SOCK_VALUE };

    for (const transport of ['local', 'ssh'] as const) {
      const env = allowListedChildEnv(transport);
      for (const key of FORBIDDEN_KEYS) {
        expect(Object.hasOwn(env, key)).toBe(false);
      }
      // No forbidden value leaked under any key, listed or not.
      expect(JSON.stringify(env)).not.toContain(secret);
      // The allow-listed keys survive with their exact synthetic values.
      expect(env).toStrictEqual(transport === 'ssh' ? expectedSsh : LOCAL_ALL);
    }
  });

  it('returns a fresh plain object on each call', () => {
    setAllEight();

    const first = allowListedChildEnv('local');
    const second = allowListedChildEnv('local');

    // A plain object, fresh on every call: mutating one result never
    // touches the next, so callers cannot poison later children's env.
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(second)).toBe(Object.prototype);
    first.HOME = 'mutated';
    expect(second.HOME).toBe(HOME_VALUE);
  });

  it('fails closed to the local allow-list for a transport value cast past the type', () => {
    setAllEight();
    for (const key of FORBIDDEN_KEYS) {
      setEnv(key, secret);
    }

    const env = allowListedChildEnv('SSH' as unknown as 'ssh');

    expect(env).toStrictEqual(LOCAL_ALL);
  });

  it.skipIf(process.platform === 'win32')(
    'ignores lowercase path on non-win32 platforms',
    () => {
      // The lowercase-`path` case only makes sense off Windows, where the
      // exact case decides; on win32 the test is skipped instead.
      // With both spellings set, only exact uppercase `PATH` is copied.
      setAllEight();
      setEnv('path', PATH_LOWER_VALUE);

      const both = allowListedChildEnv('local');

      expect(both.PATH).toBe(PATH_VALUE);
      expect(Object.hasOwn(both, 'path')).toBe(false);

      // With `PATH` deleted, the lowercase `path` value is still not used.
      deleteEnv('PATH');

      const without = allowListedChildEnv('local');

      expect(Object.hasOwn(without, 'PATH')).toBe(false);
      expect(Object.hasOwn(without, 'path')).toBe(false);
    },
  );
});
