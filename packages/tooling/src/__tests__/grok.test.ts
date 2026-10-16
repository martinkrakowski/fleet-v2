import { describe, expect, it } from 'vitest';

import { GROK_TOOL } from '../grok.js';

const MODELS_FIXTURE = [
  'Available models:',
  '  grok-4.7              (default)',
  '  grok-4.7-fast',
  '  grok-code-fast-4.7',
  '',
].join('\n');

describe('GROK_TOOL', () => {
  it('detects through `grok --version`', () => {
    expect(GROK_TOOL.detect.argv).toEqual(['grok', '--version']);
  });

  describe('signIn.interpret', () => {
    it('reads a recorded signed-in status line', () => {
      const recordedFixture = ['Signed in as dev@example.com', ''].join('\n');
      expect(GROK_TOOL.signIn.interpret(recordedFixture, 0)).toBe('signed-in');
    });

    it('reads a recorded signed-out line naming the login command', () => {
      const recordedFixture = ['Not signed in. Run `grok auth login` first.', ''].join('\n');
      expect(GROK_TOOL.signIn.interpret(recordedFixture, 1)).toBe('signed-out');
    });

    it('malformed output is unknown, never a guess', () => {
      expect(GROK_TOOL.signIn.interpret('grok: server unreachable', 1)).toBe('unknown');
      expect(GROK_TOOL.signIn.interpret('', 0)).toBe('unknown');
    });
  });

  describe('models.parse (Available models: list)', () => {
    it('declares the `grok models` argv', () => {
      expect(GROK_TOOL.models.argv).toEqual(['grok', 'models']);
      expect(GROK_TOOL.models.http).toBeUndefined();
    });

    it('parses a recorded list and drops the default annotation', () => {
      expect(GROK_TOOL.models.parse(MODELS_FIXTURE)).toEqual([
        { id: 'grok-4.7' },
        { id: 'grok-4.7-fast' },
        { id: 'grok-code-fast-4.7' },
      ]);
    });

    it('output without the Available models: header is unknown', () => {
      expect(GROK_TOOL.models.parse('  grok-4.7\n')).toBe('unknown');
    });

    it('a header with no model after it is unknown, never an empty list', () => {
      expect(GROK_TOOL.models.parse('Available models:\n')).toBe('unknown');
    });

    it('a row without a readable id is unknown', () => {
      expect(GROK_TOOL.models.parse('Available models:\n  (default)\n')).toBe('unknown');
    });

    it('a row with trailing junk after the id is unknown: the regex anchors the whole line', () => {
      expect(GROK_TOOL.models.parse('Available models:\n  grok-4.7 junk here\n')).toBe('unknown');
      expect(GROK_TOOL.models.parse('Available models:\n  grok-4.7 (default) extra\n')).toBe(
        'unknown',
      );
    });

    it('a parenthesised annotation after the id is still accepted', () => {
      expect(GROK_TOOL.models.parse('Available models:\n  grok-4.7 (default)\n')).toEqual([
        { id: 'grok-4.7' },
      ]);
    });

    it('malformed output is unknown', () => {
      expect(GROK_TOOL.models.parse('')).toBe('unknown');
      expect(GROK_TOOL.models.parse('grok: no models\n')).toBe('unknown');
    });
  });

  it('records capabilities, invocation template and cost source as data', () => {
    expect(GROK_TOOL.id).toBe('grok');
    expect(GROK_TOOL.displayName).toBe('Grok CLI');
    expect(GROK_TOOL.capabilities).toEqual({
      canRunCommands: false,
      readOnlyMode: true,
      needsAllowRules: false,
      headless: true,
    });
    expect(GROK_TOOL.invocation?.argvTemplate).toEqual([
      'grok',
      '-m',
      '{model}',
      '--permission-mode',
      'plan',
      '{prompt}',
    ]);
    expect(GROK_TOOL.costSource).toBe('pay-per-token');
  });
});
