import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_TOOL } from '../claude-code.js';

describe('CLAUDE_CODE_TOOL', () => {
  it('detects through `claude --version`', () => {
    expect(CLAUDE_CODE_TOOL.detect.argv).toEqual(['claude', '--version']);
  });

  describe('signIn.interpret', () => {
    it('reads a recorded signed-in status line', () => {
      const recordedFixture = ['Signed in as dev@example.com', ''].join('\n');
      expect(CLAUDE_CODE_TOOL.signIn.interpret(recordedFixture, 0)).toBe('signed-in');
    });

    it('reads a recorded signed-out line with a failing exit code', () => {
      const recordedFixture = ['Not signed in. Run `claude /login` to sign in.', ''].join('\n');
      expect(CLAUDE_CODE_TOOL.signIn.interpret(recordedFixture, 1)).toBe('signed-out');
    });

    it('reads a signed-out line whatever the exit code is', () => {
      expect(CLAUDE_CODE_TOOL.signIn.interpret('No credentials found', 0)).toBe('signed-out');
    });

    it('malformed output is unknown, never a guess', () => {
      expect(CLAUDE_CODE_TOOL.signIn.interpret('claude: unexpected argument', 2)).toBe('unknown');
      expect(CLAUDE_CODE_TOOL.signIn.interpret('', 0)).toBe('unknown');
    });

    it('a signed-in line with a failing exit code is unknown', () => {
      expect(CLAUDE_CODE_TOOL.signIn.interpret('Signed in as dev@example.com', 1)).toBe('unknown');
    });

    it('contradictory output is unknown', () => {
      const recordedFixture = 'Signed in as dev@example.com\nnot signed in';
      expect(CLAUDE_CODE_TOOL.signIn.interpret(recordedFixture, 0)).toBe('unknown');
    });
  });

  describe('models', () => {
    it('declares no probe and serves the product-shipped fixed list', () => {
      expect(CLAUDE_CODE_TOOL.models.argv).toBeUndefined();
      expect(CLAUDE_CODE_TOOL.models.http).toBeUndefined();
      expect(CLAUDE_CODE_TOOL.models.parse('')).toEqual([
        { id: 'claude-opus-4-5' },
        { id: 'claude-sonnet-4-5' },
        { id: 'claude-haiku-4-5' },
      ]);
    });
  });

  it('records capabilities, invocation template and cost source as data', () => {
    expect(CLAUDE_CODE_TOOL.id).toBe('claude-code');
    expect(CLAUDE_CODE_TOOL.displayName).toBe('Claude Code');
    expect(CLAUDE_CODE_TOOL.capabilities).toEqual({
      canRunCommands: true,
      readOnlyMode: false,
      needsAllowRules: true,
      headless: true,
    });
    expect(CLAUDE_CODE_TOOL.invocation.argvTemplate).toEqual([
      'claude',
      '-p',
      '--model',
      '{model}',
      '{prompt}',
    ]);
    expect(CLAUDE_CODE_TOOL.costSource).toBe('plan-quota');
  });
});
