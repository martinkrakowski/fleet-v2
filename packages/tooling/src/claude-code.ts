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
