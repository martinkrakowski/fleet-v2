import type { SignInStatus } from './types.js';

const SIGNED_IN_LINE = /signed in as\s+\S+/i;
const SIGNED_OUT_LINE = /not signed in|signed out|no credentials|not authenticated/i;

/**
 * Interprets the `auth status` style output shared by the account-based
 * tools (Claude Code, Grok, agy): one line naming the signed-in account,
 * or an explicit signed-out line.
 *
 * A signed-in claim additionally requires exit code 0, because it is the
 * answer that unlocks seats; anything the parser does not recognise —
 * including contradictory or empty output — stays `'unknown'` and never
 * becomes a guess.
 */
export function interpretAccountSignIn(stdout: string, exitCode: number): SignInStatus {
  const text = stdout.trim();
  if (text === '') {
    return 'unknown';
  }
  const signedIn = SIGNED_IN_LINE.test(text);
  const signedOut = SIGNED_OUT_LINE.test(text);
  if (signedIn && !signedOut) {
    return exitCode === 0 ? 'signed-in' : 'unknown';
  }
  if (signedOut && !signedIn) {
    return 'signed-out';
  }
  return 'unknown';
}
