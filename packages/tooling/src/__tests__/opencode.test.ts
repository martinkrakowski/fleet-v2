import { describe, expect, it } from 'vitest';

import { OPENCODE_TOOL } from '../opencode.js';

const AUTH_PROVIDERS_FIXTURE = [
  'Providers:',
  '  z-ai                    signed in',
  '  openrouter              signed in',
  '  github                  signed out',
  '',
].join('\n');

const MODEL_LIST_FIXTURE = [
  '{',
  '  "data": {',
  '    "current": "nvidia/z-ai/glm-5.3",',
  '    "models": {',
  '      "nvidia/z-ai/glm-5.3": { "providerID": "nvidia", "variants": ["none"] },',
  '      "nvidia/z-ai/glm-5.3-flash": { "providerID": "nvidia", "variants": ["none"] },',
  '      "openrouter/z-ai/glm-5.3-flash": { "providerID": "openrouter" },',
  '      "xai/grok-4.7": { "providerID": "xai", "variants": ["plan"] }',
  '    }',
  '  }',
  '}',
].join('\n');

describe('OPENCODE_TOOL', () => {
  it('detects through `opencode --version`', () => {
    expect(OPENCODE_TOOL.detect.argv).toEqual(['opencode', '--version']);
  });

  describe('signIn.interpret (provider table)', () => {
    it('signed in when at least one recorded provider row says so', () => {
      expect(OPENCODE_TOOL.signIn.interpret(AUTH_PROVIDERS_FIXTURE, 0)).toBe('signed-in');
    });

    it('signed out when the table parses and no provider is signed in', () => {
      const recordedFixture = ['Providers:', '  github                  signed out', ''].join('\n');
      expect(OPENCODE_TOOL.signIn.interpret(recordedFixture, 0)).toBe('signed-out');
    });

    it('a failing listing exit code is unknown even with table text', () => {
      expect(OPENCODE_TOOL.signIn.interpret(AUTH_PROVIDERS_FIXTURE, 1)).toBe('unknown');
    });

    it('malformed output is unknown, never a guess', () => {
      expect(OPENCODE_TOOL.signIn.interpret('Providers:', 0)).toBe('unknown');
      expect(OPENCODE_TOOL.signIn.interpret('opencode: unknown command', 1)).toBe('unknown');
      expect(OPENCODE_TOOL.signIn.interpret('', 0)).toBe('unknown');
    });
  });

  describe('models.parse (GET /api/model JSON)', () => {
    it('declares the /api/model HTTP path and no argv', () => {
      expect(OPENCODE_TOOL.models.argv).toBeUndefined();
      expect(OPENCODE_TOOL.models.http).toEqual({ path: '/api/model' });
    });

    it('parses a recorded answer with ids and variants', () => {
      expect(OPENCODE_TOOL.models.parse(MODEL_LIST_FIXTURE)).toEqual([
        { id: 'nvidia/z-ai/glm-5.3', variants: ['none'] },
        { id: 'nvidia/z-ai/glm-5.3-flash', variants: ['none'] },
        { id: 'openrouter/z-ai/glm-5.3-flash' },
        { id: 'xai/grok-4.7', variants: ['plan'] },
      ]);
    });

    it('malformed JSON is unknown', () => {
      expect(OPENCODE_TOOL.models.parse('{')).toBe('unknown');
      expect(OPENCODE_TOOL.models.parse('')).toBe('unknown');
    });

    it('an unexpected shape is unknown', () => {
      expect(OPENCODE_TOOL.models.parse('{"data":{"models":[]}}')).toBe('unknown');
      expect(OPENCODE_TOOL.models.parse('{"models":{"z-ai/glm-5.3":{}}}')).toBe('unknown');
      expect(OPENCODE_TOOL.models.parse('"ok"')).toBe('unknown');
    });

    it('a malformed entry is unknown', () => {
      expect(OPENCODE_TOOL.models.parse('{"data":{"models":{"z-ai/glm-5.3":"nvidia"}}}')).toBe(
        'unknown',
      );
      expect(OPENCODE_TOOL.models.parse('{"data":{"models":{"":{"variants":[]}}}}')).toBe('unknown');
    });

    it('a malformed variants list is unknown', () => {
      expect(OPENCODE_TOOL.models.parse('{"data":{"models":{"z-ai/glm-5.3":{"variants":"none"}}}}')).toBe(
        'unknown',
      );
      expect(
        OPENCODE_TOOL.models.parse('{"data":{"models":{"z-ai/glm-5.3":{"variants":["none",""]}}}}'),
      ).toBe('unknown');
    });

    it('an empty models record is unknown, never an empty list', () => {
      expect(OPENCODE_TOOL.models.parse('{"data":{"models":{}}}')).toBe('unknown');
    });
  });

  it('records capabilities, invocation template and cost source as data', () => {
    expect(OPENCODE_TOOL.id).toBe('opencode');
    expect(OPENCODE_TOOL.displayName).toBe('OpenCode');
    expect(OPENCODE_TOOL.capabilities).toEqual({
      canRunCommands: true,
      readOnlyMode: false,
      needsAllowRules: false,
      headless: true,
    });
    expect(OPENCODE_TOOL.invocation.argvTemplate).toEqual([
      'opencode',
      'run',
      '-m',
      '{model}#{variant}',
      '{prompt}',
    ]);
    expect(OPENCODE_TOOL.costSource).toBe('mixed');
  });
});
