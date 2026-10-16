import { describe, expect, it } from 'vitest';

import { AGY_TOOL } from '../agy.js';

const MODELS_TABLE_FIXTURE = [
  'ID                      PROVIDER    VARIANTS',
  'zai/glm-5.3             zai         none',
  'zai/glm-5.3-flash       zai         none, flash',
  'xai/grok-4.7            xai         plan',
  'openrouter/longcat-5.2  openrouter  -',
  '',
].join('\n');

describe('AGY_TOOL', () => {
  it('detects through `agy --version`', () => {
    expect(AGY_TOOL.detect.argv).toEqual(['agy', '--version']);
  });

  describe('signIn.interpret', () => {
    it("reads agy's recorded signed-in line", () => {
      const recordedFixture = ['signed in as dev@example.com (team plan)', ''].join('\n');
      expect(AGY_TOOL.signIn.interpret(recordedFixture, 0)).toBe('signed-in');
    });

    it("reads agy's recorded signed-out line", () => {
      const recordedFixture = ["agy: not signed in; run 'agy auth login'", ''].join('\n');
      expect(AGY_TOOL.signIn.interpret(recordedFixture, 1)).toBe('signed-out');
    });

    it('malformed output is unknown, never a guess', () => {
      expect(AGY_TOOL.signIn.interpret('agy: no configuration found', 1)).toBe('unknown');
      expect(AGY_TOOL.signIn.interpret('', 0)).toBe('unknown');
    });
  });

  describe('models.parse (models table)', () => {
    it('declares the `agy models` argv', () => {
      expect(AGY_TOOL.models.argv).toEqual(['agy', 'models']);
      expect(AGY_TOOL.models.http).toBeUndefined();
    });

    it('parses a recorded table: ids, variant lists, and the - no-variant cell', () => {
      expect(AGY_TOOL.models.parse(MODELS_TABLE_FIXTURE)).toEqual([
        { id: 'zai/glm-5.3', variants: ['none'] },
        { id: 'zai/glm-5.3-flash', variants: ['none', 'flash'] },
        { id: 'xai/grok-4.7', variants: ['plan'] },
        { id: 'openrouter/longcat-5.2' },
      ]);
    });

    it('a different header is unknown', () => {
      const recordedFixture = 'MODEL  PROVIDER  VARIANTS\nzai/glm-5.3  zai  none\n';
      expect(AGY_TOOL.models.parse(recordedFixture)).toBe('unknown');
    });

    it('a header with no row is unknown, never an empty list', () => {
      expect(AGY_TOOL.models.parse('ID  PROVIDER  VARIANTS\n')).toBe('unknown');
    });

    it('a row with a missing column is unknown', () => {
      expect(AGY_TOOL.models.parse('ID  PROVIDER  VARIANTS\nzai/glm-5.3\n')).toBe('unknown');
    });

    it('malformed output is unknown', () => {
      expect(AGY_TOOL.models.parse('')).toBe('unknown');
      expect(AGY_TOOL.models.parse('agy: no models configured\n')).toBe('unknown');
    });
  });

  it('records capabilities, invocation template and cost source as data', () => {
    expect(AGY_TOOL.id).toBe('agy');
    expect(AGY_TOOL.displayName).toBe('agy');
    expect(AGY_TOOL.capabilities).toEqual({
      canRunCommands: false,
      readOnlyMode: false,
      needsAllowRules: false,
      headless: true,
    });
    expect(AGY_TOOL.invocation.argvTemplate).toEqual([
      'agy',
      'run',
      '-m',
      '{model}',
      '--variant',
      '{variant}',
      '{prompt}',
    ]);
    expect(AGY_TOOL.costSource).toBe('mixed');
  });
});
