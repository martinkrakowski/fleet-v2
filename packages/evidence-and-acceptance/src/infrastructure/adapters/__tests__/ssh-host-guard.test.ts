// Direct unit tests for the pure predicate `isSpawnableSshHost`.
// The predicate performs no I/O and spawns nothing: its whole behaviour is
// three O(1)/O(n) checks on one string (length check, `startsWith('-')`,
// linear `/\s/` scan). These tests call it directly — no process is ever
// spawned here.

import { describe, it, expect } from 'vitest';

import { isSpawnableSshHost } from '../SshExecutor.adapter.js';

describe('isSpawnableSshHost', () => {
  it('returns true for ordinary host strings of any sane length', () => {
    // Asserts every accepted shape: bare host, user@host, single character.
    // Cost bound: O(1) length check + O(1) startsWith + O(n) linear /\s/
    // scan, so even the 5000-character case is microseconds — well inside
    // Vitest's default timeout; the repeat merely proves there is no
    // artificial length ceiling.
    expect(isSpawnableSshHost('build-host')).toBe(true);
    expect(isSpawnableSshHost('user@build-host')).toBe(true);
    expect(isSpawnableSshHost('a')).toBe(true);
    expect(isSpawnableSshHost('a'.repeat(5000))).toBe(true);
  });

  it('returns false for an empty host string', () => {
    // Asserts the `host.length > 0` guard alone refuses ''.
    expect(isSpawnableSshHost('')).toBe(false);
  });

  it('returns false for hosts starting with a dash', () => {
    // Asserts `!host.startsWith('-')` refuses every leading-dash shape,
    // including one that would inject ssh options and one that would look
    // like a jump-host flag.
    expect(isSpawnableSshHost('-')).toBe(false);
    expect(isSpawnableSshHost('--')).toBe(false);
    expect(isSpawnableSshHost('-oProxyCommand=x')).toBe(false);
    expect(isSpawnableSshHost('-J jump')).toBe(false);
  });

  it('returns false when host contains whitespace at start, middle, or end', () => {
    // Asserts the `/\s/` scan refuses whitespace wherever it appears, for
    // every whitespace class the regex matches. Cost bound: one linear scan
    // per call, O(n) — no other bound needed.
    const spaces = [' ', '\t', '\n', '\r', ' ', ' '];
    for (const ws of spaces) {
      expect(isSpawnableSshHost(`${ws}host`)).toBe(false);
      expect(isSpawnableSshHost(`ho${ws}st`)).toBe(false);
      expect(isSpawnableSshHost(`host${ws}`)).toBe(false);
    }
  });

  it('returns false for a numeric value lacking a length property', () => {
    // Hostile-input rule: a wrong primitive is refused with a typed result
    // (`false`), never a throw. A number has no `length`, so
    // `undefined > 0` is false and the predicate short-circuits before the
    // regex runs. Cost bound: none beyond the length check.
    expect(isSpawnableSshHost(5 as unknown as string)).toBe(false);
  });

  it('returns true for user@-x because a leading dash after user@ is not refused today', () => {
    // Pins observed current behaviour: `startsWith('-')` checks only index
    // 0, so a dash after `user@` is not caught. This documents today's
    // acceptance, not an endorsement.
    expect(isSpawnableSshHost('user@-x')).toBe(true);
  });

  it('returns true for shell metacharacters without whitespace', () => {
    // Pins observed current behaviour: the predicate only refuses dashes
    // and whitespace. Because argv is handed to the remote command as a
    // quoted argv array — never to a shell — metacharacters that are
    // dangerous only under shell parsing are accepted today, so the
    // predicate's `true` is an accurate statement of what will spawn.
    expect(isSpawnableSshHost('a;b')).toBe(true);
    expect(isSpawnableSshHost('a$(x)')).toBe(true);
    expect(isSpawnableSshHost('a|b')).toBe(true);
  });
});
