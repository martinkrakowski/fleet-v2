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

interface VersionTriple {
  major: number;
  minor: number;
  patch: number;
}

function firstVersionTriple(text: string): VersionTriple | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
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
  if (observed.major !== minimum.major) {
    return observed.major > minimum.major;
  }
  if (observed.minor !== minimum.minor) {
    return observed.minor > minimum.minor;
  }
  return observed.patch >= minimum.patch;
}

/**
 * The outward-tool guard's decision for one Claude Code `PreToolUse` hook
 * input. It returns the deny reason when the Bash command carries one of the
 * outward actions, however it is composed — chained, backgrounded, wrapped in
 * an environment assignment or in `sudo`/`env`/`timeout`, or hidden inside a
 * shell's `-c` script or a command substitution — and `undefined` when the
 * guard has nothing to say, so Claude Code's own rules apply. An input that
 * cannot be read refuses: a guard that cannot see the command must not pass
 * it. The reason names the deny rule it matched, and carries no tool input.
 */
export function claudeCodeOutwardToolDenyReason(hookInput: unknown): string | undefined {
  const record = asPlainRecord(hookInput);
  if (record === undefined) {
    return 'the PreToolUse hook input could not be read';
  }
  if (typeof record['tool_name'] !== 'string') {
    return 'the PreToolUse hook input could not be read';
  }
  if (record['tool_name'] !== 'Bash') {
    // The PermissionRequest matcher and the deny rules cover the other
    // tools; the guard speaks only about Bash commands.
    return undefined;
  }
  const toolInput = asPlainRecord(record['tool_input']);
  if (toolInput === undefined || typeof toolInput['command'] !== 'string') {
    return 'the Bash tool input could not be read';
  }
  const command = toolInput['command'];
  for (const rule of outwardDenyRules()) {
    if (commandCarriesOutwardAction(command, rule.prefix)) {
      return `refused by the outward-tool guard: the command matches deny rule ${rule.rule}`;
    }
  }
  return undefined;
}

/** One deny rule split into its literal `Bash(...)` envelope and its command prefix. */
interface OutwardDenyRule {
  readonly rule: string;
  readonly prefix: string;
}

/** The deny rules parsed once; a rule that does not name a `Bash` prefix is skipped. */
function outwardDenyRules(): readonly OutwardDenyRule[] {
  const rules: OutwardDenyRule[] = [];
  for (const rule of CLAUDE_CODE_OUTWARD_TOOL_DENY_RULES) {
    const match = /^Bash\((.+):\*\)$/.exec(rule);
    if (match !== null) {
      rules.push({ rule, prefix: match[1] ?? '' });
    }
  }
  return rules;
}

/** Shell separators and command-substitution markers; each one starts a new candidate command. */
const SEGMENT_SEPARATOR = /&&|\|\||[;|&\n\r]|<\(|\$\(|`/g;

/** Commands that only wrap the command that follows them. */
const WRAPPER_WORDS: ReadonlySet<string> = new Set(['nohup', 'exec', 'command', 'time']);

/** Wrappers that take flags (some with a value) before the command itself. */
const SUDO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-u', '-g', '-C', '-D', '--user', '--group', '--close-from', '--directory',
]);
const ENV_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '--unset']);
const NICE_VALUE_FLAGS: ReadonlySet<string> = new Set(['-n', '--adjustment']);

/** How deep a quoted `-c` script may nest before the guard stops looking inside. */
const MAX_SCRIPT_DEPTH = 4;

/** Split one script into the commands its separators put in command position. */
function segmentsOf(script: string): readonly string[] {
  const segments: string[] = [];
  for (const part of script.replace(SEGMENT_SEPARATOR, '\n').split('\n')) {
    const trimmed = part.trim();
    if (trimmed !== '') {
      segments.push(trimmed);
    }
  }
  return segments;
}

/** A leading environment assignment: `NAME=value`, with a quoted value allowed. */
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*))\s+(.*)$/;

/** One first word plus the rest of the segment, or nothing when there is one word. */
const HEAD_AND_REST = /^(\S+)(?:\s+(.*))?$/;

/** A shell invocation whose `-c` script is quoted; the script is the second capture. */
const SHELL_SCRIPT =
  /[A-Za-z0-9_./-]*\/?(?:ba|z|da|k|fi)?sh\s+(?:-{1,2}[\w=-]+\s+)*-c\s+(["'])([\s\S]*?)\1/g;

function valueFlagsOf(word: string): ReadonlySet<string> {
  if (word === 'sudo') return SUDO_VALUE_FLAGS;
  if (word === 'env') return ENV_VALUE_FLAGS;
  return NICE_VALUE_FLAGS;
}

/** Skip the flags (and their values) of a wrapper, up to the command itself. */
function skipWrapperFlags(text: string, valueFlags: ReadonlySet<string>): string {
  let remainder = text;
  for (;;) {
    const head = HEAD_AND_REST.exec(remainder);
    if (head === null || head[2] === undefined) {
      return remainder;
    }
    const token = head[1] ?? '';
    if (token === '--') {
      remainder = head[2] ?? '';
      continue;
    }
    if (/^--?[A-Za-z][\w=-]*$/.test(token)) {
      remainder = head[2] ?? '';
      if (valueFlags.has(token)) {
        const value = HEAD_AND_REST.exec(remainder);
        if (value !== null && value[2] !== undefined) {
          remainder = value[2];
        }
      }
      continue;
    }
    return remainder;
  }
}

/**
 * The commands one segment can put in command position: the segment itself
 * with its leading environment assignments, wrappers and flags stripped, plus
 * every `-c` script a shell invocation inside it carries.
 */
function candidateCommandsOf(segment: string, depth: number): readonly string[] {
  let rest = segment;
  for (;;) {
    const script = SHELL_SCRIPT.exec(rest);
    if (script !== null) {
      SHELL_SCRIPT.lastIndex = 0;
      const inner: string[] = [];
      for (const innerSegment of segmentsOf(script[2] ?? '')) {
        inner.push(...candidateCommandsOf(innerSegment, depth + 1));
      }
      return inner;
    }
    const env = ENV_ASSIGNMENT.exec(rest);
    if (env !== null) {
      rest = env[2] ?? '';
      continue;
    }
    const head = HEAD_AND_REST.exec(rest);
    if (head === null || head[2] === undefined) {
      break;
    }
    const token = head[1] ?? '';
    const remainder = head[2] ?? '';
    if (token === 'sudo' || token === 'env' || token === 'nice') {
      rest = skipWrapperFlags(remainder, valueFlagsOf(token));
      continue;
    }
    if (token === 'timeout') {
      const duration = HEAD_AND_REST.exec(remainder);
      if (duration !== null && /^\d+[smhd]?$/.test(duration[1] ?? '')) {
        rest = duration[2] ?? '';
        continue;
      }
      break;
    }
    if (WRAPPER_WORDS.has(token)) {
      rest = remainder;
      continue;
    }
    break;
  }
  const candidates: string[] = [rest];
  // A shell invocation anywhere in the segment (docker exec, kubectl exec,
  // a bare `sh -c`) carries its script; look inside it too. A quoted text
  // that merely shows such a command is denied with it: the guard refuses.
  for (const match of rest.matchAll(SHELL_SCRIPT)) {
    for (const innerSegment of segmentsOf(match[2] ?? '')) {
      candidates.push(...candidateCommandsOf(innerSegment, depth + 1));
    }
  }
  return depth <= MAX_SCRIPT_DEPTH ? candidates : [];
}

/** True when `prefix` stands in command position in the candidate. */
function commandPositionMatch(candidate: string, prefix: string): boolean {
  const stripped = candidate.replace(/^["'(<]+/, '');
  if (!stripped.startsWith(prefix)) {
    return false;
  }
  const next = stripped.charAt(prefix.length);
  return next === '' || /[\s'")]/.test(next);
}

/** True when any command position in the Bash command carries the prefix. */
function commandCarriesOutwardAction(command: string, prefix: string): boolean {
  return segmentsOf(command).some((segment) =>
    candidateCommandsOf(segment, 0).some((candidate) => commandPositionMatch(candidate, prefix)),
  );
}

/** A plain object by prototype, never a class instance, array or proxy shape. */
function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
