import { interpretAccountSignIn } from './sign-in.js';
import type { ToolModel, ToolDescriptor } from './types.js';

/**
 * Claude Code has no CLI model listing: a subscription serves a known set of
 * models, so the descriptor carries the product-shipped fixed list and its
 * `parse` ignores the (absent) probe output.
 */
const CLAUDE_CODE_MODELS: readonly ToolModel[] = [
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
    parse: () => CLAUDE_CODE_MODELS,
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
