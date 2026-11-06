import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_OUTWARD_TOOL_DENY_RULES,
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

  it('refuses diagnostic text that merely mentions a high version', () => {
    expect(
      claudeCodeSupportsPermissionHookBlock('error: cannot read config 99.0.0 missing', '2.1.0'),
    ).toBe(false);
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
    expect(preToolUse[0].hooks[0].command).toBeTruthy();
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
