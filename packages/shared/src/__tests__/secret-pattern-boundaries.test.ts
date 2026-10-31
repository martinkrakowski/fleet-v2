// Tests for lane CL-18: the LANE_DIFF_SECRET_PATTERNS length boundaries. Each
// pattern is looked up by name and probed exactly at its minimum length; a
// regex edit that loosened or tightened a minimum would fail here. Every fake
// value is assembled at runtime from harmless fragments (as in
// secret-patterns.test.ts) so this file itself matches no pattern; the lane
// diff check scans this very file.
import { describe, expect, it } from 'vitest';
import { LANE_DIFF_SECRET_PATTERNS } from '../secret-patterns.js';

/** Look up a named lane-diff pattern, asserting it exists. */
function patternByName(name: string): RegExp {
  const entry = LANE_DIFF_SECRET_PATTERNS.find((pattern) => pattern.name === name);
  expect(entry, `missing pattern ${name}`).toBeDefined();
  return entry!.regex;
}

describe('LANE_DIFF_SECRET_PATTERNS length boundaries (CL-18)', () => {
  it('aws-access-key: AKIA plus exactly 16 upper-case alphanumerics', () => {
    const regex = patternByName('aws-access-key');
    const matches = ['AK', 'IA', 'A'.repeat(16)].join('');
    const tooShort = ['AK', 'IA', 'A'.repeat(15)].join('');
    expect(regex.test(matches)).toBe(true);
    expect(regex.test(tooShort)).toBe(false);
  });

  it('github-token: ghp_ plus at least 20 alphanumerics', () => {
    const regex = patternByName('github-token');
    const matches = ['gh', 'p_', 'a'.repeat(20)].join('');
    const tooShort = ['gh', 'p_', 'a'.repeat(19)].join('');
    expect(regex.test(matches)).toBe(true);
    expect(regex.test(tooShort)).toBe(false);
  });

  it('slack-token: xoxb- plus at least 10 allowed characters', () => {
    const regex = patternByName('slack-token');
    const matches = ['xo', 'xb-', 'a'.repeat(10)].join('');
    const tooShort = ['xo', 'xb-', 'a'.repeat(9)].join('');
    expect(regex.test(matches)).toBe(true);
    expect(regex.test(tooShort)).toBe(false);
  });

  it('password-assignment: password = "...": 6 chars match, 5 do not, single quotes match too', () => {
    const regex = patternByName('password-assignment');
    const doubleQuoted = ['password', ' = "', 'a'.repeat(6), '"'].join('');
    const doubleTooShort = ['password', ' = "', 'a'.repeat(5), '"'].join('');
    const singleQuoted = ['password', " = '", 'a'.repeat(6), "'"].join('');
    expect(regex.test(doubleQuoted)).toBe(true);
    expect(regex.test(doubleTooShort)).toBe(false);
    expect(regex.test(singleQuoted)).toBe(true);
  });

  it('basic-auth-url: https://user:...@host: 6 chars match, 5 do not', () => {
    const regex = patternByName('basic-auth-url');
    const matches = ['https://user:', 'a'.repeat(6), '@host'].join('');
    const tooShort = ['https://user:', 'a'.repeat(5), '@host'].join('');
    expect(regex.test(matches)).toBe(true);
    expect(regex.test(tooShort)).toBe(false);
  });

  it('private-key-block: a private key header matches, a public key header does not', () => {
    const regex = patternByName('private-key-block');
    const privateKey = ['BEGIN ', 'RSA', ' PRIVATE KEY'].join('');
    const publicKey = ['BEGIN ', 'PUBLIC KEY'].join('');
    expect(regex.test(privateKey)).toBe(true);
    expect(regex.test(publicKey)).toBe(false);
  });

  it('token-assignment: token: \'...\': 16 allowed chars match, 15 do not', () => {
    const regex = patternByName('token-assignment');
    const matches = ['token', ": '", 'a'.repeat(16), "'"].join('');
    const tooShort = ['token', ": '", 'a'.repeat(15), "'"].join('');
    expect(regex.test(matches)).toBe(true);
    expect(regex.test(tooShort)).toBe(false);
  });
});
