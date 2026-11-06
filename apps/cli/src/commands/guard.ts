/**
 * The `guard` command group: the PreToolUse outward-tool guard the operator's
 * Claude Code settings run (packages/tooling/
 * claude-code-permission-hook.settings.example.json). Claude Code hands the
 * guard one hook JSON document on stdin; the guard answers the deny decision
 * on stdout for an outward action and stays silent otherwise. All I/O happens
 * here at the application boundary; the decision itself is the pure rule in
 * `@fleet/tooling`.
 */

import { claudeCodeOutwardToolDenyReason } from '@fleet/tooling';

import type { CliIo } from '../index.js';

export interface GuardCliOptions {
  /**
   * The hook-input reader; the process stream composes one when omitted.
   * Claude Code pipes one JSON document (or nothing) into the guard.
   */
  readonly readStdin?: () => Promise<string>;
}

export const GUARD_HELP = `Usage: fleet-v2 guard outward-tool

The PreToolUse outward-tool guard for the operator's Claude Code settings.
Claude Code hands the guard one hook JSON document on stdin. For a Bash
command that carries an outward action — however it is composed — the guard
answers the deny decision on stdout; otherwise it writes nothing and Claude
Code's own rules apply. The settings example runs it with onFailure: "block",
so a failed guard denies too.

Exit codes: 0 the guard answered (a deny or no opinion), 2 usage error.`;

/** Reads all of stdin as utf8; tests inject their own reader. */
function processReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Run one guard subcommand. `outward-tool` reads the hook input, asks the
 * pure rule for its decision and, when it refuses, prints the deny envelope
 * Claude Code's PreToolUse hooks answer with. Every non-zero exit is a usage
 * error: the decision itself never exits non-zero, because the recipe runs
 * the guard with `onFailure: "block"`.
 */
export async function guardCommand(
  argv: readonly string[],
  io: CliIo,
  options: GuardCliOptions = {},
): Promise<number> {
  const subcommand = argv[0] ?? '';
  if (argv.length === 0 || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    io.stdout(`${GUARD_HELP}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  if (subcommand !== 'outward-tool') {
    io.stderr(`Unknown guard subcommand: ${subcommand}\n${GUARD_HELP}\n`);
    return 2;
  }
  const stdinText = await (options.readStdin ?? processReadStdin)();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText) as unknown;
  } catch {
    // Unparsable input is itself the unreadable input the rule refuses;
    // the guard fails closed on it, never passes it.
    parsed = stdinText;
  }
  const reason = claudeCodeOutwardToolDenyReason(parsed);
  if (reason !== undefined) {
    io.stdout(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })}\n`,
    );
  }
  return 0;
}
