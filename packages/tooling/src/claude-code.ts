import { interpretAccountSignIn } from './sign-in.js';
import type { ToolModel, ToolDescriptor } from './types.js';

/**
 * Claude Code has no CLI model listing: fleet cannot ask the tool what it
 * serves. This pinned list is fallback data: the descriptor's `parse`
 * returns it marked `source: 'fallback'` — never as a bare list that could
 * pass for a probe result, and never as a claim that a subscription always
 * serves exactly these models.
 */
export const CLAUDE_CODE_FALLBACK_MODELS: readonly ToolModel[] = [
  { id: 'claude-opus-4-5' },
  { id: 'claude-sonnet-4-5' },
  { id: 'claude-haiku-4-5' },
];

/**
 * Claude Code (the `claude` CLI). Subscription seats are plan-quota. A
 * headless `-p` run needs permission allow rules in Claude Code's own
 * settings before it may run unattended, so `needsAllowRules` is true.
 */
export const CLAUDE_CODE_TOOL: ToolDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detect: { argv: ['claude', '--version'] },
  signIn: {
    argv: ['claude', 'auth', 'status'],
    interpret: interpretAccountSignIn,
  },
  models: {
    // No probe exists: the parse returns the pinned list marked as
    // fallback, never a bare list that could pass for a probe result.
    parse: () => ({ source: 'fallback', models: CLAUDE_CODE_FALLBACK_MODELS }),
  },
  capabilities: {
    canRunCommands: true,
    readOnlyMode: false,
    needsAllowRules: true,
    headless: true,
  },
  invocation: {
    argvTemplate: ['claude', '-p', '--model', '{model}', '{prompt}'],
  },
  costSource: 'plan-quota',
};

/**
 * The minimum Claude Code version that honours `onFailure: "block"` on a
 * hook. An older client ignores the field and fails open, so the recipe is
 * unsafe there. The value is the release whose changelog entry introduced
 * the field (2.1.295, Claude Code CHANGELOG.md); the runbook records the
 * provenance. `UNVERIFIED` would mean the changelog was not reachable when
 * the pin was written, and every comparison then refuses.
 */
export const CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION = '2.1.295';

/**
 * The outward actions the hook must refuse in every permission mode: forge,
 * merge, push and deploy. Each entry is a Claude Code `permissions.deny`
 * rule, and the same list is the `PreToolUse` guard's rule set. It is data,
 * so the settings example is checked against it.
 */
export const CLAUDE_CODE_OUTWARD_TOOL_DENY_RULES: readonly string[] = [
  'Bash(git push:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh release:*)',
  'Bash(gh workflow run:*)',
  'Bash(kubectl apply:*)',
  'Bash(kubectl delete:*)',
  'Bash(terraform apply:*)',
  'Bash(docker push:*)',
  'Bash(npm publish:*)',
  'Bash(cargo publish:*)',
  'Bash(fleet-v2 forge execute:*)',
  'Bash(fleet-v2 merge enqueue:*)',
];

type VersionTriple = readonly [number, number, number];

// Anchored: only output that begins with a version counts, so diagnostic text
// that merely mentions one (a failed probe) never passes the check.
function firstVersionTriple(text: string): VersionTriple | undefined {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?=\s|$)/.exec(text);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when the recorded `claude --version` output names a version at or
 * above the minimum. An unreadable version, an unreadable minimum or the
 * `UNVERIFIED` pin refuses: the answer is never a guess.
 */
export function claudeCodeSupportsPermissionHookBlock(
  versionOutput: string,
  minimumVersion: string = CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION,
): boolean {
  const observed = firstVersionTriple(versionOutput);
  const minimum = firstVersionTriple(minimumVersion);
  if (!observed || !minimum) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (observed[i] !== minimum[i]) {
      return observed[i]! > minimum[i]!;
    }
  }
  return true;
}
