// TUI command boundary tests — P9.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { isValidElement } from 'react';
import type { ReactElement } from 'react';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import type { CliIo } from '../index.js';
import { tuiCommand, type TuiRendered } from './command.js';

const NOW = '2026-11-03T10:04:00.000Z';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text) => {
      outLines.push(text);
    },
    stderr: (text) => {
      errLines.push(text);
    },
  };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-tui-command-test-'));
}

function makeRuntime(): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir: tempStateDir() });
}

function fakeRender(): { fn: (tree: ReactElement) => TuiRendered; calls: ReactElement[] } {
  const calls: ReactElement[] = [];
  const fn = (tree: ReactElement): TuiRendered => {
    calls.push(tree);
    return {
      waitUntilExit: async () => undefined,
      rerender: () => {},
      unmount: () => {},
    };
  };
  return { fn, calls };
}

describe('tuiCommand', () => {
  it('--help prints the help text and exits 0', async () => {
    const io = captureIo();
    const code = await tuiCommand(['--help'], io, makeRuntime());
    expect(code).toBe(0);
    expect(io.outLines.join('')).toContain('Usage: fleet-v2 tui');
  });

  it('an unknown option is a usage error', async () => {
    const io = captureIo();
    const code = await tuiCommand(['--nope'], io, makeRuntime());
    expect(code).toBe(2);
    expect(io.errLines.join('')).toContain('unknown tui option: --nope');
  });

  it('refuses without an interactive terminal', async () => {
    const io = captureIo();
    const code = await tuiCommand([], io, makeRuntime(), { interactive: false });
    expect(code).toBe(1);
    expect(io.errLines.join('')).toContain('interactive terminal');
  });

  it('renders once via the injected render and exits 0', async () => {
    const io = captureIo();
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const { fn, calls } = fakeRender();
    const code = await tuiCommand([], io, runtime, {
      interactive: true,
      render: fn,
      nowIso: () => NOW,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(isValidElement(calls[0])).toBe(true);
  });
});
