import { describe, expect, it } from 'vitest';

import { guardCommand } from './guard.js';
import type { CliIo } from '../index.js';

function createMockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe('guard command', () => {
  it('answers the deny envelope for an outward action, however composed', async () => {
    const { io, stdout } = createMockIo();
    const code = await guardCommand(['outward-tool'], io, {
      readStdin: async () => '{"tool_name":"Bash","tool_input":{"command":"cd /repo && git push"}}',
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const envelope = JSON.parse(stdout[0].trim()) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(envelope.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('Bash(git push:*)'),
    });
  });

  it('writes nothing for a command the guard has no opinion on', async () => {
    const { io, stdout } = createMockIo();
    const code = await guardCommand(['outward-tool'], io, {
      readStdin: async () => '{"tool_name":"Bash","tool_input":{"command":"git status"}}',
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
  });

  it('fails closed on stdin that is not JSON', async () => {
    const { io, stdout } = createMockIo();
    const code = await guardCommand(['outward-tool'], io, { readStdin: async () => '' });
    expect(code).toBe(0);
    expect(stdout[0]).toContain('permissionDecision":"deny"');
  });

  it('is a usage error on an unknown subcommand', async () => {
    const { io, stderr } = createMockIo();
    const code = await guardCommand(['nope'], io, { readStdin: async () => '' });
    expect(code).toBe(2);
    expect(stderr[0]).toContain('Unknown guard subcommand');
  });

  it('prints help without reading stdin', async () => {
    const { io, stdout } = createMockIo();
    const code = await guardCommand(['--help'], io, {
      readStdin: async () => {
        throw new Error('stdin must not be read for --help');
      },
    });
    expect(code).toBe(0);
    expect(stdout[0]).toContain('Usage: fleet-v2 guard outward-tool');
  });
});
