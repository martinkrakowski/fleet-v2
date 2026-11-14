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
const SEAT_COMMAND = ['/usr/local/bin/seat-bin', '--model', '{model}', '--prompt', '{promptFile}'] as const;

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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-brief-seat-')));
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
    expect(result).toEqual({
      outcome: 'answered', rawAnswer: s.executor.seat.stdout,
      sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
    });
    expect(s.executor.seatCalls).toHaveLength(1);
    const call = s.executor.seatCalls[0];
    expect(call?.argv).toEqual(['/usr/local/bin/seat-bin', '--model', 'author-model', '--prompt', path.join(s.briefsDir, `${STEM}.prompt.md`)]);
    expect(call?.options?.cwd).toBe(s.checkout);
    expect(call?.options?.timeoutMs).toBe(900_000);
    expect(call?.options?.maxBufferBytes).toBeGreaterThanOrEqual(262_144);
    expect(await fs.readFile(path.join(s.briefsDir, `${STEM}.answer.md`), 'utf8')).toBe(s.executor.seat.stdout);
    expect(await fs.readFile(path.join(s.briefsDir, `${STEM}.prompt.md`), 'utf8')).toBe('FACT PACK PROMPT');
    expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.prompt.md`]);
  });

  it('a repeat with the same session key returns the recorded answer and runs no second session', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    const first = await adapter.authorBriefSession(s.request);
    const callsAfterFirst = s.executor.calls.length;
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'a different answer', stderr: '' };
    const second = await adapter.authorBriefSession(s.request);
    expect(second.outcome).toBe('answered');
    expect(second).toEqual({
      outcome: 'answered', rawAnswer: (first as { rawAnswer: string }).rawAnswer,
      sessionKey: SESSION_KEY, answerPath: (first as { answerPath: string }).answerPath, cached: true,
    });
    expect(s.executor.calls).toHaveLength(callsAfterFirst);
  });

  it('a session interrupted after its prompt but before its answer is recoverable on the next call', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    await fs.writeFile(path.join(s.briefsDir, `${STEM}.prompt.md`), 'earlier prompt', 'utf8');
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({
      outcome: 'answered', rawAnswer: s.executor.seat.stdout,
      sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
    });
    expect(s.executor.seatCalls).toHaveLength(1);
  });

  it('refuses null request, throwing getters, and control characters without throwing', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    expect(await adapter.authorBriefSession(null as never)).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(await adapter.authorBriefSession('x' as never)).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });

    const getter = { ...s.request } as unknown as Record<string, unknown>;
    Object.defineProperty(getter, 'model', {
      enumerable: true,
      get() { throw new Error('boom'); },
    });
    expect(await adapter.authorBriefSession(getter as unknown as BriefAuthorSessionRequest)).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);

    expect(await adapter.authorBriefSession({ ...s.request, model: 'bad\u0000model' })).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('refuses when the checkout is missing or unreadable', async () => {
    const s = await setup();
    const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, checkoutPath: path.join(s.root, 'absent') });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'checkout-unreadable' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('refuses when checkout HEAD does not match the pinned commit (checkout-not-pinned)', async () => {
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
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    expect(s.executor.seatCalls[0]?.options?.timeoutMs).toBe(3_600_000);
    await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
    s.executor.seat = { exitCode: 1, signal: null, stdout: '', stderr: '' };
    expect(await adapterFor(s.executor).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
  });

  it('refuses failed, empty, or oversized seat responses and oversized prompts', async () => {
    {
      const s = await setup();
      s.executor.seat = { exitCode: 1, signal: null, stdout: 'partial', stderr: '' };
      expect(await adapterFor(s.executor).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    }
    {
      // A timed-out run is refused even when it otherwise looks complete:
      // exit code 0, stdout present and no error field.
      const s = await setup();
      s.executor.seat = { exitCode: 0, signal: null, stdout: 'complete-looking', stderr: '', timedOut: true } as unknown as CommandRunResult;
      const result = await adapterFor(s.executor).authorBriefSession(s.request);
      expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
      await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
    }
    {
      const s = await setup();
      s.executor.seat = { exitCode: 0, signal: null, stdout: ' \n\t', stderr: '' };
      expect(await adapterFor(s.executor).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-empty' });
      await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
    }
    {
      const s = await setup();
      s.executor.seat = { exitCode: 0, signal: null, stdout: 'x'.repeat(101), stderr: '' };
      expect(await adapterFor(s.executor, { maxAnswerBytes: 100 }).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-oversized' });
    }
    {
      const s = await setup();
      const oversizedPrompt = 'p'.repeat(300_000);
      expect(await adapterFor(s.executor).authorBriefSession({ ...s.request, prompt: oversizedPrompt })).toEqual({ outcome: 'unavailable', reason: 'session-oversized' });
    }
  });

  it('refuses an own accessor variant or agent instead of treating it as absent', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    for (const field of ['variant', 'agent'] as const) {
      const request = { ...s.request } as unknown as Record<string, unknown>;
      Object.defineProperty(request, field, {
        enumerable: true,
        get() { throw new Error('boom'); },
      });
      expect(await adapter.authorBriefSession(request as unknown as BriefAuthorSessionRequest))
        .toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    }
    expect(s.executor.calls).toHaveLength(0);
  });

  it('a configured maxAnswerBytes above the session cap never raises the accepted answer limit', async () => {
    const s = await setup();
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'x'.repeat(256_001), stderr: '' };
    const adapter = adapterFor(s.executor, { maxAnswerBytes: 10_000_000 });
    expect(await adapter.authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-oversized' });
    await expect(fs.stat(path.join(s.briefsDir, `${STEM}.answer.md`))).rejects.toThrow();
  });

  it('refuses missing or invalid sessionCommand (session-command-missing, session-command-invalid)', async () => {
    const s = await setup();
    const unconfigured = await new BriefAuthoringAdapter({ executor: s.executor }).authorBriefSession(s.request);
    expect(unconfigured).toEqual({ outcome: 'unavailable', reason: 'session-command-missing' });

    for (const command of [
      ['/usr/local/bin/seat-bin', '{promptFile}', '{secret}'],
      ['/usr/local/bin/seat-bin', '--model', '{model}'],
      ['/usr/local/bin/seat-bin', '{promptFile}', '{promptFile}'],
      ['/usr/local/bin/seat-bin', '{variant}', '{promptFile}'],
      ['seat-bin', '--prompt', '{promptFile}'],
      ['/usr/local/bin/../seat-bin', '{promptFile}'],
      ['/usr/local/bin/seat-bin\u0000', '{promptFile}'],
      // A control character in a non-binary literal element is refused too.
      ['/usr/local/bin/seat-bin', '--mode\nstrict', '{promptFile}'],
      ['/usr/local/bin/seat-bin', '--log=/tmp/a\u001bb.log', '{promptFile}'],
    ]) {
      const result = await adapterFor(s.executor, { seatCommand: command }).authorBriefSession(s.request);
      expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    }
    expect(s.executor.calls).toHaveLength(0);
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
    expect(git?.argv.slice(-4)).toEqual([s.checkout, 'rev-parse', '--verify', 'HEAD']);
    expect(git?.argv.slice(-5)).toEqual(['-C', s.checkout, 'rev-parse', '--verify', 'HEAD']);
    expect(git?.options?.timeoutMs).toBeGreaterThan(0);
  });

  it('writes only inside the briefs directory', async () => {
    const s = await setup();
    await adapterFor(s.executor).authorBriefSession(s.request);
    expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.prompt.md`]);
    expect((await fs.readdir(s.root)).sort()).toEqual(['briefs', 'checkout']);
    expect(await fs.readdir(s.checkout)).toEqual([]);
  });

  it('a pre-existing symlink at the lock-file path is refused and its target is never touched', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const decoy = path.join(s.root, 'decoy.lock');
    await fs.writeFile(decoy, 'untouched', 'utf8');
    await fs.symlink(decoy, path.join(s.briefsDir, `${STEM}.lock`));
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readFile(decoy, 'utf8')).toBe('untouched');
  });

  it('refuses relative, dot-dot, or symlinked briefsDir (briefs-dir-invalid)', async () => {
    const s = await setup();

    const relative = await adapterFor(s.executor).authorBriefSession({ ...s.request, briefsDir: 'relative/briefs' });
    expect(relative).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });

    const dotDot = await adapterFor(s.executor).authorBriefSession({ ...s.request, briefsDir: `${s.root}/elsewhere/../briefs` });
    expect(dotDot).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });

    const realBriefs = path.join(s.root, 'real-briefs');
    await fs.mkdir(realBriefs);
    await fs.symlink(realBriefs, s.briefsDir);
    const symlinked = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(symlinked).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(realBriefs)).toEqual([]);
  });

  it('a briefsDir under a regular file (uninspectable component) is refused', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.root, 'notdir'), 'x', 'utf8');
    const request = { ...s.request, briefsDir: path.join(s.root, 'notdir', 'briefs') };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('a symlinked parent of an existing briefsDir is refused and nothing is written through it', async () => {
    const s = await setup();
    const realParent = path.join(s.root, 'real-parent');
    await fs.mkdir(path.join(realParent, 'briefs'), { recursive: true });
    const linkedParent = path.join(s.root, 'linked-parent');
    await fs.symlink(realParent, linkedParent);
    const request = { ...s.request, briefsDir: path.join(linkedParent, 'briefs') };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(path.join(realParent, 'briefs'))).toEqual([]);
  });

  it('a symlinked parent of a briefsDir that does not exist yet is refused and none is created', async () => {
    const s = await setup();
    const realParent = path.join(s.root, 'real-parent');
    await fs.mkdir(realParent);
    const linkedParent = path.join(s.root, 'linked-parent');
    await fs.symlink(realParent, linkedParent);
    const request = { ...s.request, briefsDir: path.join(linkedParent, 'deep', 'briefs') };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(realParent)).toEqual([]);
  });

  it('a symlinked recorded answer is refused and its target is never read', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const secret = path.join(s.root, 'secret.txt');
    await fs.writeFile(secret, 'outside content', 'utf8');
    await fs.symlink(secret, path.join(s.briefsDir, `${STEM}.answer.md`));
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readFile(secret, 'utf8')).toBe('outside content');
  });

  it('a symlinked prompt file is refused and its target is never written', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const target = path.join(s.root, 'target.txt');
    await fs.writeFile(target, 'untouched', 'utf8');
    await fs.symlink(target, path.join(s.briefsDir, `${STEM}.prompt.md`));
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'briefs-dir-invalid' });
    expect(s.executor.seatCalls).toHaveLength(0);
    expect(await fs.readFile(target, 'utf8')).toBe('untouched');
  });

  it('a briefsDir that does not exist yet, under real directories, is created and used', async () => {
    const s = await setup();
    const request = { ...s.request, briefsDir: path.join(s.root, 'fresh', 'briefs') };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({
      outcome: 'answered', rawAnswer: s.executor.seat.stdout,
      sessionKey: SESSION_KEY, answerPath: path.join(request.briefsDir, `${STEM}.answer.md`), cached: false,
    });
    expect(await fs.readFile(path.join(request.briefsDir, `${STEM}.answer.md`), 'utf8')).toBe(s.executor.seat.stdout);
  });

  it('concurrent retries run the seat exactly once and the waiter replays the recorded answer', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const adapter = adapterFor(s.executor);
    const results = await Promise.all([
      adapter.authorBriefSession(s.request),
      adapter.authorBriefSession(s.request),
    ]);
    expect(s.executor.seatCalls).toHaveLength(1);
    const answered = results.filter((r) => r.outcome === 'answered');
    expect(answered).toHaveLength(2);
    const uncached = answered.filter((r) => r.cached === false);
    const cached = answered.filter((r) => r.cached === true);
    expect(uncached).toEqual([
      {
        outcome: 'answered', rawAnswer: s.executor.seat.stdout,
        sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
      },
    ]);
    expect(cached).toEqual([
      {
        outcome: 'answered', rawAnswer: s.executor.seat.stdout,
        sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: true,
      },
    ]);
  });

  it('a present-but-unreadable recorded answer surfaces session-failed without rerunning the seat or overwriting the answer', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const answerPath = path.join(s.briefsDir, `${STEM}.answer.md`);
    const originalAnswer = '===NOTES===\noriginal\n===DISPATCH===\npreserved\n';
    await fs.writeFile(answerPath, originalAnswer, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(answerPath, 0o200);
    try {
      const result = await adapterFor(s.executor).authorBriefSession(s.request);
      expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
      expect(s.executor.calls).toHaveLength(0);
    } finally {
      await fs.chmod(answerPath, 0o600);
    }
    expect(await fs.readFile(answerPath, 'utf8')).toBe(originalAnswer);
  });

  it('recovers a stale lock from a dead owner or an expired lock and completes acquisition', async () => {
    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      await fs.writeFile(lockPath, `999999999-deadbeefdeadbeef-${Date.now()}`, 'utf8');
      const result = await adapterFor(s.executor).authorBriefSession(s.request);
      expect(result).toEqual({
        outcome: 'answered', rawAnswer: s.executor.seat.stdout,
        sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
      });
      expect(s.executor.seatCalls).toHaveLength(1);
      expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.prompt.md`]);
    }
    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      await fs.writeFile(lockPath, `${process.pid}-deadbeefdeadbeef-${Date.now() - 2_000_000}`, 'utf8');
      const result = await adapterFor(s.executor).authorBriefSession(s.request);
      expect(result).toEqual({
        outcome: 'answered', rawAnswer: s.executor.seat.stdout,
        sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
      });
      expect(s.executor.seatCalls).toHaveLength(1);
      expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.prompt.md`]);
    }
  });
});
