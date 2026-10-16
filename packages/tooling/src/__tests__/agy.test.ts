import { describe, expect, it } from 'vitest';

import { AGY_TOOL, agyCapabilitiesFor } from '../agy.js';
import type { AgyMode } from '../types.js';

const MODES: readonly AgyMode[] = ['edit-only', 'full'];

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

  it('records identity and cost source as data', () => {
    expect(AGY_TOOL.id).toBe('agy');
    expect(AGY_TOOL.displayName).toBe('agy');
    expect(AGY_TOOL.costSource).toBe('mixed');
  });

  it('defaults its single invocation to the edit-only template', () => {
    expect(AGY_TOOL.invocation).toBe(AGY_TOOL.invocationByMode?.['edit-only']);
    expect(AGY_TOOL.invocationByMode?.['edit-only']).toBeDefined();
    expect(AGY_TOOL.invocationByMode?.full).toBeDefined();
  });

  it('pins the edit-only argv template exactly, with no other flag ever present', () => {
    expect(AGY_TOOL.invocationByMode?.['edit-only'].argvTemplate).toEqual([
      'agy',
      '--print',
      '{prompt}',
      '--model',
      '{model}',
      '--output-format',
      'json',
      '--mode',
      'accept-edits',
    ]);
  });

  it('pins the full argv template exactly, with no other flag ever present', () => {
    expect(AGY_TOOL.invocationByMode?.full.argvTemplate).toEqual([
      'agy',
      '--print',
      '{prompt}',
      '--model',
      '{model}',
      '--output-format',
      'json',
      '--mode',
      'auto',
      '--dangerously-skip-permissions',
    ]);
  });

  it('uses only verified agy flags in both templates', () => {
    // Verified against `agy --help` (2026-10-16): there is no `agy run`
    // subcommand, no `--variant` flag, and the remaining flags below are
    // real but never passed by fleet.
    for (const mode of MODES) {
      const template = AGY_TOOL.invocationByMode?.[mode].argvTemplate ?? [];
      expect(template[0]).toBe('agy');
      expect(template.filter((argument) => argument.startsWith('--'))).toEqual([
        '--print',
        '--model',
        '--output-format',
        '--mode',
        ...(mode === 'full' ? (['--dangerously-skip-permissions'] as const) : []),
      ]);
      expect(template).not.toContain('run');
      expect(template).not.toContain('{variant}');
      expect(template).not.toContain('--variant');
      expect(template).not.toContain('--effort');
      expect(template).not.toContain('--print-timeout');
      expect(template).not.toContain('--sandbox');
      expect(template).not.toContain('--agent');
    }
  });

  describe('agyCapabilitiesFor', () => {
    it('an edit-only seat cannot run commands', () => {
      expect(agyCapabilitiesFor('edit-only')).toEqual({
        canRunCommands: false,
        readOnlyMode: false,
        needsAllowRules: true,
        headless: true,
      });
    });

    it('a full seat can run commands', () => {
      expect(agyCapabilitiesFor('full')).toEqual({
        canRunCommands: true,
        readOnlyMode: false,
        needsAllowRules: true,
        headless: true,
      });
    });

    it('both modes are headless and need allow rules', () => {
      for (const mode of MODES) {
        expect(agyCapabilitiesFor(mode).headless).toBe(true);
        expect(agyCapabilitiesFor(mode).needsAllowRules).toBe(true);
      }
    });

    it('carries both sets, keyed by mode, on the descriptor', () => {
      expect(AGY_TOOL.capabilitiesByMode).toEqual({
        'edit-only': agyCapabilitiesFor('edit-only'),
        full: agyCapabilitiesFor('full'),
      });
    });

    it("defaults the descriptor's capabilities to the conservative edit-only set", () => {
      expect(AGY_TOOL.capabilities).toEqual(agyCapabilitiesFor('edit-only'));
      expect(AGY_TOOL.capabilities.canRunCommands).toBe(false);
    });
  });
});
