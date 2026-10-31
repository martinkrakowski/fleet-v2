import { describe, expect, it } from 'vitest';

import { interpretAccountSignIn } from '../sign-in.js';
import type { SignInStatus } from '../types.js';

describe('interpretAccountSignIn', () => {
  it.each<{ stdout: string; exitCode: number; expected: SignInStatus }>([
    // Empty output is unknown whatever the exit code.
    { stdout: '', exitCode: 0, expected: 'unknown' },
    { stdout: '   ', exitCode: 0, expected: 'unknown' },
    { stdout: '\n\n', exitCode: 0, expected: 'unknown' },
    // A signed-in line needs an account token and exit 0.
    { stdout: 'Signed in as dev@example.com', exitCode: 0, expected: 'signed-in' },
    { stdout: 'Signed in as dev@example.com', exitCode: 1, expected: 'unknown' },
    { stdout: 'Signed in as dev@example.com', exitCode: 2, expected: 'unknown' },
    { stdout: 'signed in as', exitCode: 0, expected: 'unknown' },
    // Every signed-out phrase is signed-out whatever the exit code.
    { stdout: 'Not signed in', exitCode: 0, expected: 'signed-out' },
    { stdout: 'Not signed in', exitCode: 1, expected: 'signed-out' },
    { stdout: 'signed out', exitCode: 0, expected: 'signed-out' },
    { stdout: 'signed out', exitCode: 1, expected: 'signed-out' },
    { stdout: 'No credentials found', exitCode: 0, expected: 'signed-out' },
    { stdout: 'No credentials found', exitCode: 1, expected: 'signed-out' },
    { stdout: 'not authenticated', exitCode: 0, expected: 'signed-out' },
    { stdout: 'not authenticated', exitCode: 1, expected: 'signed-out' },
    // Matching is case-insensitive.
    { stdout: 'SIGNED IN AS dev', exitCode: 0, expected: 'signed-in' },
    { stdout: 'NOT AUTHENTICATED', exitCode: 1, expected: 'signed-out' },
    // Contradictory output is unknown, never a guess.
    { stdout: 'signed in as dev\nsigned out', exitCode: 0, expected: 'unknown' },
    // Unrelated text is unknown.
    { stdout: 'hello', exitCode: 0, expected: 'unknown' },
  ])('maps %j with exit %i to %s', ({ stdout, exitCode, expected }) => {
    expect(interpretAccountSignIn(stdout, exitCode)).toBe(expected);
  });
});
