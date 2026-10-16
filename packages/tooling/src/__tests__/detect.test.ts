import { describe, expect, it } from 'vitest';

import { CLAUDE_CODE_TOOL } from '../claude-code.js';
import { BUILT_IN_TOOLS, isToolId } from '../descriptors.js';
import {
  detectTool,
  detectTools,
  type CommandRunResult,
  type CommandRunner,
} from '../detect.js';
import { AGY_TOOL } from '../agy.js';
import { GROK_TOOL } from '../grok.js';
import { OPENCODE_TOOL } from '../opencode.js';
import type { ToolDescriptor } from '../types.js';

/** A runner answering from recorded argv-joined results, logging every call. */
function fakeRunner(
  recorded: Readonly<Record<string, CommandRunResult>>,
): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = async (argv) => {
    const key = argv.join(' ');
    calls.push(key);
    const result = recorded[key];
    if (result === undefined) {
      return { exitCode: 127, stdout: '' };
    }
    return result;
  };
  return { run, calls };
}

const RECORDED_SWEEP: Readonly<Record<string, CommandRunResult>> = {
  'claude --version': { exitCode: 0, stdout: '2.14.0 (Claude Code)\n' },
  'claude auth status': { exitCode: 0, stdout: 'Signed in as dev@example.com\n' },
  'opencode --version': { exitCode: 0, stdout: 'opencode 2.5.1 (linux, x64)\n' },
  'opencode auth': {
    exitCode: 0,
    stdout: 'Providers:\n  z-ai                    signed in\n',
  },
  'grok --version': { exitCode: 0, stdout: 'grok 4.7.2\n' },
  'grok auth status': { exitCode: 0, stdout: 'Signed in as dev@example.com\n' },
  'grok models': {
    exitCode: 0,
    stdout: 'Available models:\n  grok-4.7              (default)\n  grok-4.7-fast\n',
  },
  'agy --version': { exitCode: 0, stdout: 'agy 0.9.4\n' },
  'agy auth status': {
    exitCode: 1,
    stdout: "agy: not signed in; run 'agy auth login'\n",
  },
  'agy models': {
    exitCode: 0,
    stdout: 'ID  PROVIDER  VARIANTS\nzai/glm-5.3  zai  none\n',
  },
};

const RECORDED_MODEL_LIST = [
  '{',
  '  "data": {',
  '    "current": "nvidia/z-ai/glm-5.3",',
  '    "models": {',
  '      "nvidia/z-ai/glm-5.3": { "providerID": "nvidia", "variants": ["none"] },',
  '      "xai/grok-4.7": { "providerID": "xai" }',
  '    }',
  '  }',
  '}',
].join('\n');

describe('detectTools', () => {
  it('applies every built-in descriptor in order through the runner', async () => {
    const { run, calls } = fakeRunner(RECORDED_SWEEP);
    const detections = await detectTools(run, {
      httpGet: async (path) =>
        path === '/api/model'
          ? { exitCode: 0, stdout: RECORDED_MODEL_LIST }
          : { exitCode: 404, stdout: '' },
    });

    expect(detections.map((detection) => detection.id)).toEqual([
      'claude-code',
      'opencode',
      'grok',
      'agy',
    ]);
    expect(detections.map((detection) => detection.installed)).toEqual([true, true, true, true]);
    expect(detections.map((detection) => detection.detectOutput)).toEqual([
      '2.14.0 (Claude Code)',
      'opencode 2.5.1 (linux, x64)',
      'grok 4.7.2',
      'agy 0.9.4',
    ]);
    expect(detections.map((detection) => detection.signIn)).toEqual([
      'signed-in',
      'signed-in',
      'signed-in',
      'signed-out',
    ]);
    expect(detections.map((detection) => detection.models)).toEqual([
      {
        source: 'fallback',
        models: [
          { id: 'claude-opus-4-5' },
          { id: 'claude-sonnet-4-5' },
          { id: 'claude-haiku-4-5' },
        ],
      },
      [
        { id: 'nvidia/z-ai/glm-5.3', variants: ['none'] },
        { id: 'xai/grok-4.7' },
      ],
      [{ id: 'grok-4.7' }, { id: 'grok-4.7-fast' }],
      [{ id: 'zai/glm-5.3', variants: ['none'] }],
    ]);
    expect(calls).toContain('claude --version');
    expect(calls).toContain('opencode auth');
    expect(calls).toContain('grok models');
    expect(calls).toContain('agy models');
  });

  it('never asks an undetected tool for its sign-in or models', async () => {
    const { run, calls } = fakeRunner({});
    const detections = await detectTools(run);

    expect(detections).toHaveLength(4);
    for (const detection of detections) {
      expect(detection.installed).toBe(false);
      expect(detection.detectOutput).toBe('');
      expect(detection.signIn).toBe('unknown');
      expect(detection.models).toBe('unknown');
    }
    expect(calls).toEqual([
      'claude --version',
      'opencode --version',
      'grok --version',
      'agy --version',
    ]);
  });
});

describe('detectTool', () => {
  it('fails closed as not installed when the runner throws on detect', async () => {
    const run: CommandRunner = async (argv) => {
      if (argv.join(' ') === 'claude --version') {
        throw new Error('spawn ENOENT');
      }
      return RECORDED_SWEEP['claude auth status'] ?? { exitCode: 0, stdout: '' };
    };
    const detection = await detectTool(CLAUDE_CODE_TOOL, run);
    expect(detection).toEqual({
      id: 'claude-code',
      installed: false,
      detectOutput: '',
      signIn: 'unknown',
      models: 'unknown',
    });
  });

  it('keeps the tool installed but reports unknown sign-in when the probe throws', async () => {
    const run: CommandRunner = async (argv) => {
      if (argv.join(' ') === 'claude auth status') {
        throw new Error('probe crashed');
      }
      return RECORDED_SWEEP['claude --version'] ?? { exitCode: 0, stdout: '' };
    };
    const detection = await detectTool(CLAUDE_CODE_TOOL, run);
    expect(detection.installed).toBe(true);
    expect(detection.signIn).toBe('unknown');
  });

  it('reports an HTTP model list as unknown without an injected HTTP prober', async () => {
    const { run } = fakeRunner({
      'opencode --version': RECORDED_SWEEP['opencode --version'],
      'opencode auth': RECORDED_SWEEP['opencode auth'],
    });
    const detection = await detectTool(OPENCODE_TOOL, run);
    expect(detection.installed).toBe(true);
    expect(detection.models).toBe('unknown');
  });

  it('reports an HTTP model list as unknown on a non-2xx answer or a throwing prober', async () => {
    const { run } = fakeRunner({
      'opencode --version': RECORDED_SWEEP['opencode --version'],
      'opencode auth': RECORDED_SWEEP['opencode auth'],
    });
    const failing = await detectTool(OPENCODE_TOOL, run, {
      httpGet: async () => ({ exitCode: 404, stdout: '' }),
    });
    expect(failing.models).toBe('unknown');

    const throwing = await detectTool(OPENCODE_TOOL, run, {
      httpGet: async () => {
        throw new Error('connection refused');
      },
    });
    expect(throwing.models).toBe('unknown');
  });

  it('parses an HTTP model list through the injected prober', async () => {
    const { run } = fakeRunner({
      'opencode --version': RECORDED_SWEEP['opencode --version'],
      'opencode auth': RECORDED_SWEEP['opencode auth'],
    });
    const detection = await detectTool(OPENCODE_TOOL, run, {
      httpGet: async (path) => {
        expect(path).toBe('/api/model');
        return { exitCode: 0, stdout: RECORDED_MODEL_LIST };
      },
    });
    expect(detection.models).toEqual([
      { id: 'nvidia/z-ai/glm-5.3', variants: ['none'] },
      { id: 'xai/grok-4.7' },
    ]);
  });

  it('reports models as unknown when the listing exits non-zero, whatever its stdout says', async () => {
    const run: CommandRunner = async (argv) => {
      if (argv.join(' ') === 'grok models') {
        return { exitCode: 1, stdout: 'Available models:\n  grok-4.7\n' };
      }
      return RECORDED_SWEEP['grok --version'] ?? { exitCode: 0, stdout: '' };
    };
    const detection = await detectTool(GROK_TOOL, run);
    expect(detection.installed).toBe(true);
    expect(detection.models).toBe('unknown');
  });

  it('never returns an empty model list as truth: it stays unknown', async () => {
    const emptyListTool: ToolDescriptor = {
      ...CLAUDE_CODE_TOOL,
      models: { parse: () => [] },
    };
    const run: CommandRunner = async (argv) => {
      if (argv.join(' ') === 'claude --version') {
        return RECORDED_SWEEP['claude --version'] ?? { exitCode: 0, stdout: '' };
      }
      return { exitCode: 0, stdout: '' };
    };
    const detection = await detectTool(emptyListTool, run);
    expect(detection.models).toBe('unknown');
  });

  it('still reports the pinned fallback list, marked as fallback, of an installed tool with no probe at all', async () => {
    const { run, calls } = fakeRunner({
      'claude --version': RECORDED_SWEEP['claude --version'],
      'claude auth status': RECORDED_SWEEP['claude auth status'],
    });
    const detection = await detectTool(CLAUDE_CODE_TOOL, run);
    // The marker travels through the sweep: the fallback list is never
    // presented as a probe result.
    expect(detection.models).toEqual({
      source: 'fallback',
      models: [
        { id: 'claude-opus-4-5' },
        { id: 'claude-sonnet-4-5' },
        { id: 'claude-haiku-4-5' },
      ],
    });
    expect(calls).not.toContain('claude models');
  });

  it('reports models as unknown when the argv listing probe throws', async () => {
    const run: CommandRunner = async (argv) => {
      if (argv.join(' ') === 'agy models') {
        throw new Error('probe crashed');
      }
      return RECORDED_SWEEP['agy --version'] ?? { exitCode: 0, stdout: '' };
    };
    const detection = await detectTool(AGY_TOOL, run);
    expect(detection.installed).toBe(true);
    expect(detection.models).toBe('unknown');
  });
});

describe('BUILT_IN_TOOLS', () => {
  it('covers exactly the four product tools, each with its own id', () => {
    expect(BUILT_IN_TOOLS.map((tool) => tool.id)).toEqual([
      'claude-code',
      'opencode',
      'grok',
      'agy',
    ]);
  });

  it('isToolId accepts the built-in ids and nothing else', () => {
    for (const id of ['claude-code', 'opencode', 'grok', 'agy']) {
      expect(isToolId(id)).toBe(true);
    }
    expect(isToolId('codex')).toBe(false);
    expect(isToolId('')).toBe(false);
    expect(isToolId(42)).toBe(false);
    expect(isToolId(undefined)).toBe(false);
  });
});
