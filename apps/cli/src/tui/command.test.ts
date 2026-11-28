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

  it('--help documents the interactive HTTP writes and no longer claims the shell never writes', async () => {
    const io = captureIo();
    await tuiCommand(['--help'], io, makeRuntime());
    const text = io.outLines.join('');
    expect(text).toContain('--thread-id <id>');
    expect(text).toContain('FLEET_API_URL');
    expect(text).toContain('explicit');
    expect(text).not.toContain('never over HTTP');
    expect(text).not.toContain('the shell never writes');
  });

  it('refuses missing --thread-id value with exit 2', async () => {
    for (const argv of [['--thread-id'], ['--thread-id='], ['--thread-id', ''], ['--thread-id', '--x']]) {
      const io = captureIo();
      const code = await tuiCommand(argv, io, makeRuntime(), { interactive: true });
      expect(code).toBe(2);
      expect(io.errLines.join('')).toContain('--thread-id needs a value');
    }
  });
});

interface Harness {
  readonly render: (tree: ReactElement) => TuiRendered;
  readonly latest: () => Record<string, unknown>;
  readonly finish: () => void;
}

function recordingRender(): Harness {
  let tree: ReactElement | null = null;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const render = (first: ReactElement): TuiRendered => {
    tree = first;
    return {
      waitUntilExit: () => done,
      rerender: (next) => {
        tree = next;
      },
      unmount: () => finish(),
    };
  };
  return { render, latest: () => (tree?.props ?? {}) as Record<string, unknown>, finish: () => finish() };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

type Props = {
  onAction: (action: string) => void;
  onRawInput?: (key: { input: string; return?: boolean; escape?: boolean }) => void;
  inputLines?: string[];
  rows: string[];
  capturing?: boolean;
};

function fetchScript(calls: Array<{ url: string; method: string; body: unknown }>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: init.body === undefined ? null : JSON.parse(String(init.body)) });
    const u = String(url);
    let body: unknown = { code: 'OK', result: {} };
    if (u.endsWith('/v1/questions?state=open')) {
      body = {
        code: 'OK',
        result: {
          questions: [
            {
              questionId: 'q-1', revision: 2, title: 'Pick one', body: 'Body', doorKind: 'two-way',
              options: [{ id: 'o-1', label: 'One', consequence: 'c' }],
              recommendation: { optionId: 'o-1', because: 'simplest' },
            },
          ],
        },
      };
    } else if (u.endsWith('/answers')) {
      body = { code: 'OK', result: { outcome: 'answered', replayed: false } };
    } else if (u.includes('/permissions?state=pending')) {
      body = { code: 'OK', result: { requests: [{ requestId: 'r-1', toolCode: 'edit', deadlineAt: '2026-11-03T11:00:00.000Z' }] } };
    } else if (u.endsWith('/verdict')) {
      body = { code: 'OK', result: { decision: 'allow' } };
    } else if (u.endsWith('/sessions/exchange')) {
      body = { token: 'minted-token', scopes: ['read', 'message', 'verdict'] };
    }
    return { status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('tuiCommand interactive screens', () => {
  it('shows not-configured message on questions screen when FLEET_API_URL is absent', async () => {
    const saved = process.env.FLEET_API_URL;
    delete process.env.FLEET_API_URL;
    try {
      const h = recordingRender();
      const run = tuiCommand([], captureIo(), makeRuntime(), { interactive: true, render: h.render, nowIso: () => NOW });
      await flush();
      (h.latest() as unknown as Props).onAction('next');
      await flush();
      expect((h.latest() as unknown as Props).rows.join('\n')).toContain('API not configured (set FLEET_API_URL)');
      expect((h.latest() as unknown as Props).onRawInput).toBeUndefined();
      h.finish();
      await run;
    } finally {
      if (saved !== undefined) {
        process.env.FLEET_API_URL = saved;
      }
    }
  });

  it('shows missing thread id when threadId is omitted', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const h = recordingRender();
    const run = tuiCommand([], captureIo(), makeRuntime(), {
      interactive: true, render: h.render, nowIso: () => NOW,
      apiUrl: 'http://api.test', token: 'tok', fetchImpl: fetchScript(calls),
    });
    await flush();
    (h.latest() as unknown as Props).onAction('next');
    await flush();
    (h.latest() as unknown as Props).onAction('next');
    await flush();
    expect((h.latest() as unknown as Props).rows.join('\n')).toContain('thread id not set');
    expect(calls.some((c) => c.url.includes('/permissions'))).toBe(false);
    h.finish();
    await run;
  });

  it('answers a question only after explicit confirmation', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const h = recordingRender();
    const run = tuiCommand([], captureIo(), makeRuntime(), {
      interactive: true, render: h.render, nowIso: () => NOW,
      apiUrl: 'http://api.test', token: 'tok', fetchImpl: fetchScript(calls),
    });
    await flush();
    (h.latest() as unknown as Props).onAction('next');
    await flush();
    const key = async (k: { input: string; return?: boolean; escape?: boolean }) => {
      (h.latest() as unknown as Props).onRawInput?.(k);
      await flush();
    };
    expect((h.latest() as unknown as Props).inputLines?.join('\n')).toContain('q-1');
    await key({ input: '', return: true });
    await key({ input: 'a' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((h.latest() as unknown as Props).capturing).toBe(true);
    await key({ input: 'n' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await key({ input: 'a' });
    await key({ input: 'y' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://api.test/v1/questions/q-1/answers');
    expect(posts[0].body).toEqual({ questionRevision: 2, shape: 'accept' });
    expect((h.latest() as unknown as Props).inputLines?.join('\n')).toContain('answer recorded');
    h.finish();
    await run;
  });

  it('gives a verdict for the active thread after confirmation, exchanging a session secret once in memory', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const h = recordingRender();
    const run = tuiCommand(['--thread-id', 'th-1'], captureIo(), makeRuntime(), {
      interactive: true, render: h.render, nowIso: () => NOW,
      apiUrl: 'http://api.test', sessionSecret: 'session-secret', threadId: 'ignored', fetchImpl: fetchScript(calls),
    });
    await flush();
    (h.latest() as unknown as Props).onAction('prev');
    await flush();
    const key = async (k: { input: string; return?: boolean }) => {
      (h.latest() as unknown as Props).onRawInput?.(k);
      await flush();
    };
    await key({ input: '', return: true });
    await key({ input: 'd' });
    await key({ input: 'y' });
    const verdict = calls.find((c) => c.url.endsWith('/verdict'));
    expect(verdict?.url).toBe('http://api.test/v1/threads/th-1/permissions/r-1/verdict');
    expect(verdict?.body).toEqual({ decision: 'deny' });
    expect(calls.filter((c) => c.url.endsWith('/sessions/exchange'))).toHaveLength(1);
    h.finish();
    await run;
  });

  it('sends a refused session secret only once, however often the screen reloads', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: String(init.method) });
      return { status: 403, text: async () => JSON.stringify({ error: 'Forbidden' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const h = recordingRender();
    const run = tuiCommand([], captureIo(), makeRuntime(), {
      interactive: true, render: h.render, nowIso: () => NOW,
      apiUrl: 'http://api.test', sessionSecret: 'session-secret', fetchImpl,
    });
    await flush();
    (h.latest() as unknown as Props).onAction('next');
    await flush();
    (h.latest() as unknown as Props).onAction('reload');
    await flush();
    (h.latest() as unknown as Props).onAction('reload');
    await flush();
    expect(calls.filter((c) => c.url.endsWith('/sessions/exchange'))).toHaveLength(1);
    expect((h.latest() as unknown as Props).rows.join('\n')).toContain('questions not read');
    h.finish();
    await run;
  });
});

