// Lane CO17: BriefAuthoringAdapter seat session tests (fake executor, real temp directories).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { BriefAuthorSessionRequest } from '../../../application/ports/out/BriefAuthoringPort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { BriefAuthoringAdapter } from '../BriefAuthoringAdapter.adapter.js';

const COMMIT = 'c'.repeat(40);
const SESSION_KEY = `brief-author/wo-1/lane-1@${COMMIT.slice(0, 12)}`;
const STEM = `brief-author__wo-1__lane-1@${COMMIT.slice(0, 12)}`;
const SEAT_COMMAND = ['seat-bin', '--model', '{model}', '--prompt', '{promptFile}'] as const;

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface Call {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

class FakeExecutor implements CommandExecutorPort {
  public readonly calls: Call[] = [];
  public head = COMMIT;
  public seat: CommandRunResult = { exitCode: 0, signal: null, stdout: '===NOTES===\nn\n===DISPATCH===\nbody\n', stderr: '' };

  public async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ argv, options });
    if (argv.includes('rev-parse')) {
      return { exitCode: 0, signal: null, stdout: `${this.head}\n`, stderr: '' };
    }
    return this.seat;
  }

  public get seatCalls(): Call[] {
    return this.calls.filter((call) => !call.argv.includes('rev-parse'));
  }
}

interface Setup {
  readonly root: string;
  readonly checkout: string;
  readonly briefsDir: string;
  readonly executor: FakeExecutor;
  readonly request: BriefAuthorSessionRequest;
}

async function setup(): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-brief-seat-'));
  roots.push(root);
  const checkout = path.join(root, 'checkout');
  const briefsDir = path.join(root, 'briefs');
  await fs.mkdir(checkout);
  return {
    root, checkout, briefsDir,
    executor: new FakeExecutor(),
    request: {
      sessionKey: SESSION_KEY, workOrderId: 'wo-1', laneId: 'lane-1', baseCommit: COMMIT,
      checkoutPath: checkout, briefsDir, prompt: 'FACT PACK PROMPT', model: 'author-model',
    },
  };
}

function adapterFor(executor: CommandExecutorPort, options: { seatCommand?: readonly string[]; maxAnswerBytes?: number } = {}) {
  return new BriefAuthoringAdapter({ seatCommand: SEAT_COMMAND, executor, ...options });
}

describe('BriefAuthoringAdapter seat session', () => {
  it('runs one seat session per brief in the pinned checkout and records the raw answer', async () => {
    const s = await setup();
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'answered', answer: s.executor.seat.stdout });
    expect(s.executor.seatCalls).toHaveLength(1);
    const call = s.executor.seatCalls[0];
    expect(call?.argv).toEqual(['seat-bin', '--model', 'author-model', '--prompt', path.join(s.briefsDir, `${STEM}.prompt.md`)]);
    expect(call?.options?.cwd).toBe(s.checkout);
    expect(call?.options?.timeoutMs).toBe(900_000);
    expect(call?.options?.maxBufferBytes).toBeGreaterThanOrEqual(262_144);
    expect(await fs.readFile(path.join(s.briefsDir, `${STEM}.answer.md`), 'utf8')).toBe(s.executor.seat.stdout);
    expect(await fs.readFile(path.join(s.briefsDir, `${STEM}.prompt.md`), 'utf8')).toBe('FACT PACK PROMPT');
    const intent = JSON.parse(await fs.readFile(path.join(s.briefsDir, `${STEM}.intent.json`), 'utf8')) as Record<string, unknown>;
    expect(intent.sessionKey).toBe(SESSION_KEY);
    expect(typeof intent.startedAt).toBe('string');
  });

  it('a repeat with the same session key returns the recorded answer and runs no second session', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    const first = await adapter.authorBriefSession(s.request);
    const callsAfterFirst = s.executor.calls.length;
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'a different answer', stderr: '' };
    const second = await adapter.authorBriefSession(s.request);
    expect(second).toEqual(first);
    expect(s.executor.calls).toHaveLength(callsAfterFirst);
  });

  it('a session interrupted before its answer is recoverable on the next call', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    await fs.writeFile(path.join(s.briefsDir, `${STEM}.intent.json`), '{"sessionKey":"x","startedAt":"t"}\n', 'utf8');
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'answered', answer: s.executor.seat.stdout });
    expect(s.executor.seatCalls).toHaveLength(1);
  });

  it('an unreadable recorded answer is unknown, never an empty brief', async () => {
    const s = await setup();
    await fs.mkdir(path.join(s.briefsDir, `${STEM}.answer.md`), { recursive: true });
    const adapter = adapterFor(s.executor);
    await expect(adapter.authorBriefSession(s.request)).rejects.toThrow('recorded brief answer is unreadable');
    expect(s.executor.calls).toHaveLength(0);
    await fs.rm(path.join(s.briefsDir, `${STEM}.answer.md`), { recursive: true });
    await fs.writeFile(path.join(s.briefsDir, `${STEM}.answer.md`), '  \n', 'utf8');
    await expect(adapter.authorBriefSession(s.request)).rejects.toThrow('recorded brief answer is unreadable');
    expect(s.executor.calls).toHaveLength(0);
  });

  it('refuses when the checkout is missing', async () => {
    const s = await setup();
    const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, checkoutPath: path.join(s.root, 'absent') });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'checkout-unavailable' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('refuses when the checkout is not at the pinned commit', async () => {
    const s = await setup();
    s.executor.head = 'd'.repeat(40);
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'checkout-not-pinned' });
    expect(s.executor.seatCalls).toHaveLength(0);
    await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
  });

  it('a timed-out session is refused and leaves no answer behind', async () => {
    const s = await setup();
    s.executor.seat = { exitCode: null, signal: 'SIGTERM', stdout: 'partial', stderr: '', error: 'command exceeded its 900000ms timeout and its process tree was killed' };
    const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, timeoutMs: 99_999_999 });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-timeout' });
    expect(s.executor.seatCalls[0]?.options?.timeoutMs).toBe(3_600_000);
    await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
    await fs.stat(path.join(s.briefsDir, `${STEM}.intent.json`));
    s.executor.seat = { exitCode: 1, signal: null, stdout: '', stderr: '' };
    expect(await adapterFor(s.executor).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
  });

  it('an empty seat answer is refused, never an empty brief', async () => {
    const s = await setup();
    s.executor.seat = { exitCode: 0, signal: null, stdout: ' \n\t', stderr: '' };
    expect(await adapterFor(s.executor).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-empty' });
    await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
  });

  it('an oversized answer is refused, never truncated silently', async () => {
    const s = await setup();
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'x'.repeat(101), stderr: '' };
    const result = await adapterFor(s.executor, { maxAnswerBytes: 100 }).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-output-too-large' });
    await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
  });

  it('the pinned-commit check runs git with no network, no hooks and no lazy fetch', async () => {
    const s = await setup();
    await adapterFor(s.executor).authorBriefSession(s.request);
    const git = s.executor.calls.find((call) => call.argv.includes('rev-parse'));
    expect(git?.argv.slice(0, 6)).toEqual([
      'env', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=none', 'GIT_TERMINAL_PROMPT=0',
      'GIT_NO_REPLACE_OBJECTS=1', expect.stringMatching(/^GIT_GRAFT_FILE=\/nonexistent\//),
    ]);
    expect(git?.argv).toEqual(expect.arrayContaining([
      'git', '--no-replace-objects', 'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'protocol.allow=never',
    ]));
    expect(git?.argv.slice(-4)).toEqual(['-C', s.checkout, 'rev-parse', 'HEAD']);
    expect(git?.argv.slice(-3)).toEqual([s.checkout, 'rev-parse', 'HEAD']);
    expect(git?.options?.timeoutMs).toBeGreaterThan(0);
  });

  it('writes only inside the briefs directory', async () => {
    const s = await setup();
    await adapterFor(s.executor).authorBriefSession(s.request);
    expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.intent.json`, `${STEM}.prompt.md`]);
    expect((await fs.readdir(s.root)).sort()).toEqual(['briefs', 'checkout']);
    expect(await fs.readdir(s.checkout)).toEqual([]);
  });

  it('a session command with an unknown placeholder is refused', async () => {
    const s = await setup();
    for (const command of [
      ['seat-bin', '{promptFile}', '{secret}'],
      ['seat-bin', '--model', '{model}'],
      ['seat-bin', '{promptFile}', '{promptFile}'],
      ['seat-bin', '{variant}', '{promptFile}'],
    ]) {
      const result = await adapterFor(s.executor, { seatCommand: command }).authorBriefSession(s.request);
      expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    }
    expect(s.executor.calls).toHaveLength(0);
    const unconfigured = await new BriefAuthoringAdapter({ executor: s.executor }).authorBriefSession(s.request);
    expect(unconfigured).toEqual({ outcome: 'unavailable', reason: 'seat-command-not-configured' });
  });
});
