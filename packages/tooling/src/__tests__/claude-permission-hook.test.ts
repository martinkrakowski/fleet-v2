import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_OUTWARD_TOOL_DENY_RULES,
  claudeCodeOutwardToolDenyReason,
  claudeCodeSupportsPermissionHookBlock,
} from '../claude-code.js';

const exampleUrl = new URL(
  '../../claude-code-permission-hook.settings.example.json',
  import.meta.url,
);
const runbookUrl = new URL(
  '../../../../docs/runbooks/claude-code-permission-hook.md',
  import.meta.url,
);

const exampleText = readFileSync(exampleUrl, 'utf8');
const example = JSON.parse(exampleText) as {
  permissions: { deny: string[] };
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ onFailure?: string; command?: string }>;
    }>;
    PermissionRequest: Array<{
      matcher: string;
      hooks: Array<{
        onFailure?: string;
        headers?: Record<string, string>;
        allowedEnvVars?: string[];
      }>;
    }>;
  };
};

describe('claudeCodeSupportsPermissionHookBlock', () => {
  it('accepts a version above the minimum', () => {
    expect(claudeCodeSupportsPermissionHookBlock('2.14.0 (Claude Code)', '2.1.0')).toBe(true);
  });

  it('accepts the exact minimum', () => {
    expect(claudeCodeSupportsPermissionHookBlock('2.1.0', '2.1.0')).toBe(true);
  });

  it('refuses a version below the minimum', () => {
    expect(claudeCodeSupportsPermissionHookBlock('2.0.9 (Claude Code)', '2.1.0')).toBe(false);
  });

  it('refuses unreadable version output', () => {
    expect(claudeCodeSupportsPermissionHookBlock('claude: command not found', '2.1.0')).toBe(false);
  });

  it('refuses empty version output', () => {
    expect(claudeCodeSupportsPermissionHookBlock('', '2.1.0')).toBe(false);
  });

  it('refuses every version when the minimum is the UNVERIFIED pin', () => {
    expect(claudeCodeSupportsPermissionHookBlock('9.9.9', 'UNVERIFIED')).toBe(false);
  });

  it('refuses a version with no triple', () => {
    expect(claudeCodeSupportsPermissionHookBlock('v2.1', '2.1.0')).toBe(false);
  });
});

describe('claudeCodeOutwardToolDenyReason', () => {
  const bashInput = (command: string): unknown => ({
    session_id: 'test-session',
    tool_name: 'Bash',
    tool_input: { command },
  });

  it('denies a plain outward command', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('git push origin main'));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command chained after another command', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('cd /repo && git push origin main'));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command run in the background', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('build.sh & git push origin main'));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command inside command substitution', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('echo $(git push origin main)'));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command behind an environment assignment', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput("FOO='a b' git push origin main"));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command behind sudo and its flags', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('sudo -u root git push origin main'));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command behind a timeout wrapper', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('timeout 30 npm publish'));
    expect(reason).toContain('Bash(npm publish:*)');
  });

  it('denies an outward command inside a quoted shell script', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput("sh -c 'git push origin main'"));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies an outward command inside a shell script run through another program', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput("docker exec box sh -c 'git push origin main'"));
    expect(reason).toContain('Bash(git push:*)');
  });

  it('denies the fleet-v2 outward commands', () => {
    const reason = claudeCodeOutwardToolDenyReason(bashInput('fleet-v2 merge enqueue --runId r1'));
    expect(reason).toContain('Bash(fleet-v2 merge enqueue:*)');
  });

  it('stays out of the way when the command carries no outward action', () => {
    expect(claudeCodeOutwardToolDenyReason(bashInput('git status && yarn typecheck'))).toBeUndefined();
  });

  it('keeps a word boundary, so a longer word is not an outward command', () => {
    expect(claudeCodeOutwardToolDenyReason(bashInput('git pushup'))).toBeUndefined();
  });

  it('has no opinion on other tools', () => {
    expect(
      claudeCodeOutwardToolDenyReason({
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/x', command: 'git push origin main' },
      }),
    ).toBeUndefined();
  });

  it('fails closed on an unreadable hook input', () => {
    expect(claudeCodeOutwardToolDenyReason('not json')).toContain('could not be read');
    expect(claudeCodeOutwardToolDenyReason({})).toContain('could not be read');
    expect(claudeCodeOutwardToolDenyReason({ tool_name: 'Bash', tool_input: {} })).toContain(
      'could not be read',
    );
    expect(claudeCodeOutwardToolDenyReason({ tool_name: 'Bash', tool_input: 'git push' })).toContain(
      'could not be read',
    );
  });
});

describe('the settings example', () => {
  it('denies exactly the outward-tool deny rules, in the same order', () => {
    expect(example.permissions.deny).toEqual(CLAUDE_CODE_OUTWARD_TOOL_DENY_RULES);
  });

  it('guards Bash with a blocking command hook', () => {
    const preToolUse = example.hooks.PreToolUse;
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].matcher).toBe('Bash');
    expect(preToolUse[0].hooks).toHaveLength(1);
    expect(preToolUse[0].hooks[0].onFailure).toBe('block');
    expect(preToolUse[0].hooks[0].command).toContain('guard outward-tool');
  });

  it('routes edit approvals through a blocking PermissionRequest hook that excludes Bash', () => {
    const permissionRequest = example.hooks.PermissionRequest;
    expect(permissionRequest).toHaveLength(1);
    const { matcher } = permissionRequest[0];
    expect(typeof matcher).toBe('string');
    expect(matcher.length).toBeGreaterThan(0);
    expect(matcher).not.toContain('Bash');
    expect(permissionRequest[0].hooks).toHaveLength(1);
    expect(permissionRequest[0].hooks[0].onFailure).toBe('block');
    expect(permissionRequest[0].hooks[0].headers?.Authorization).toContain('FLEET_HOOK_TOKEN');
    expect(permissionRequest[0].hooks[0].allowedEnvVars).toContain('FLEET_HOOK_TOKEN');
  });

  it('carries no credential-shaped literal', () => {
    const values: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        values.push(node);
      } else if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === 'object') {
        Object.values(node).forEach(walk);
      }
    };
    walk(JSON.parse(exampleText));
    const shaped = values.filter((value) => /[A-Za-z0-9_-]{32,}/.test(value));
    expect(shaped).toEqual([]);
  });
});

describe('the runbook', () => {
  it('names the pinned minimum version', () => {
    const runbook = readFileSync(runbookUrl, 'utf8');
    expect(runbook).toContain('CLAUDE_CODE_PERMISSION_HOOK_MINIMUM_VERSION');
  });
});
