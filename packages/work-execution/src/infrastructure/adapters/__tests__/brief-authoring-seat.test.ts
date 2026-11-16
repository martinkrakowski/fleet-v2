// Lane CO17: BriefAuthoringAdapter seat session tests (fake executor, real temp directories).
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { BriefAuthorSessionRequest } from '../../../application/ports/out/BriefAuthoringPort.out-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import {
  type AcquireLockResult,
  BriefAuthoringAdapter,
  CROSS_HOST_FACTOR,
  GUARD_STALE_AFTER_MS,
  type LockFsOps,
  acquireLock,
  createLockPayload,
  isLockStale,
  parseLockPayload,
  releaseLock,
} from '../BriefAuthoringAdapter.adapter.js';

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

/**
 * A lock payload with NO pid. `createLockPayload(ts, undefined, host)` cannot
 * produce one: an explicitly `undefined` pid selects its `process.pid`
 * default, which would make the fixture a live same-host lock instead.
 */
function noPidPayload(ts: number, host: string | undefined): string {
  return JSON.stringify({
    ...(host !== undefined ? { host } : {}),
    ts,
    token: 'no-pid-lock-token',
  });
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

  it('a secret-shaped seat answer is refused and never persisted in the briefs directory', async () => {
    const s = await setup();
    // The shape is split across template expressions so this test file itself
    // never carries a credential-shaped literal.
    const secret = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    s.executor.seat = {
      exitCode: 0,
      signal: null,
      stdout: `===NOTES===\nnote ${secret}\n===DISPATCH===\nbody\n`,
      stderr: '',
    };
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    expect(s.executor.seatCalls).toHaveLength(1);
    // The raw answer was never written: the briefs directory holds only the
    // prompt, and no file on disk carries the secret-shaped text.
    const entries = await fs.readdir(s.briefsDir);
    expect(entries).toEqual([`${STEM}.prompt.md`]);
    for (const entry of entries) {
      expect(await fs.readFile(path.join(s.briefsDir, entry), 'utf8')).not.toContain(secret);
    }
    // Nothing was recorded, so a repeat runs the seat again instead of
    // replaying the refused answer.
    expect(await adapterFor(s.executor).authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    expect(s.executor.seatCalls).toHaveLength(2);
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

  it('recovers a stale lock when its age exceeds the threshold and its owner is not alive', async () => {
    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      const stalePayload = createLockPayload(Date.now() - 2_000_000, 999_999_999, os.hostname());
      await fs.writeFile(lockPath, stalePayload, 'utf8');
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
      const remoteStalePayload = createLockPayload(Date.now() - 2_000_000, process.pid, 'other-host.internal');
      await fs.writeFile(lockPath, remoteStalePayload, 'utf8');
      const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, timeoutMs: 100 });
      expect(result).toEqual({
        outcome: 'answered', rawAnswer: s.executor.seat.stdout,
        sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
      });
      expect(s.executor.seatCalls).toHaveLength(1);
      expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.prompt.md`]);
    }
  });

  it('two reclaimers racing a stale lock: the racer arriving mid-takeover is refused and exactly one returns owned', async () => {
    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      const now = Date.now();
      const staleAfterMs = 1_000;
      const stalePayload = createLockPayload(now - 2_000_000, 999_999_999, os.hostname());
      await fs.writeFile(lockPath, stalePayload, 'utf8');

      const realOps: LockFsOps = {
        writeFileSync: fsSync.writeFileSync.bind(fsSync),
        readFileSync: fsSync.readFileSync.bind(fsSync),
        renameSync: fsSync.renameSync.bind(fsSync),
        unlinkSync: fsSync.unlinkSync.bind(fsSync),
      };
      let winnerResult: AcquireLockResult | undefined;
      const loserFs: LockFsOps = {
        ...realOps,
        unlinkSync(filePath: string): void {
          // The winner's whole acquire runs inside the loser's takeover delete.
          if (winnerResult === undefined && filePath === lockPath) {
            winnerResult = acquireLock(lockPath, staleAfterMs, { now, fsOps: realOps, guardAttempts: 2, guardRetryMs: 0 });
          }
          fsSync.unlinkSync(filePath);
        },
      };

      const loserResult = acquireLock(lockPath, staleAfterMs, { now, fsOps: loserFs });
      expect(winnerResult).toBeDefined();
      // The first taker holds the takeover guard while it moves the stale lock aside, so
      // the racer arriving at that moment cannot touch the lock: exactly one owns it.
      expect([loserResult.owned, winnerResult?.owned].filter(Boolean)).toHaveLength(1);
      expect(loserResult.owned).toBe(true);
      expect(winnerResult?.owned).toBe(false);
      if (loserResult.owned) {
        expect(parseLockPayload(await fs.readFile(lockPath, 'utf8'))?.token).toBe(loserResult.token);
      }
      expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.lock`]);
    }
    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      const stalePayload = createLockPayload(Date.now() - 2_000_000, 999_999_999, os.hostname());
      await fs.writeFile(lockPath, stalePayload, 'utf8');

      let activeSeats = 0;
      let maxConcurrentSeats = 0;
      const slowExecutor: CommandExecutorPort = {
        async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
          s.executor.calls.push({ argv, options });
          if (argv.includes('rev-parse')) {
            return { exitCode: 0, signal: null, stdout: `${COMMIT}\n`, stderr: '' };
          }
          activeSeats += 1;
          maxConcurrentSeats = Math.max(maxConcurrentSeats, activeSeats);
          await new Promise((resolve) => setTimeout(resolve, 60));
          activeSeats -= 1;
          return s.executor.seat;
        },
      };

      const results = await Promise.all([
        adapterFor(slowExecutor).authorBriefSession(s.request),
        adapterFor(slowExecutor).authorBriefSession(s.request),
      ]);
      expect(maxConcurrentSeats).toBe(1);
      expect(s.executor.seatCalls).toHaveLength(1);
      const answered = results.filter((r) => r.outcome === 'answered');
      expect(answered).toHaveLength(2);
      expect(answered.map((r) => r.cached).sort()).toEqual([false, true]);
    }
  });

  it('a same-host lock whose pid is alive is never stale even past staleAfterMs', async () => {
    const now = Date.now();
    const staleAfterMs = 1_000;
    const oldTime = now - staleAfterMs * CROSS_HOST_FACTOR * 10;
    const livePayload = createLockPayload(oldTime, process.pid, os.hostname());
    expect(parseLockPayload(livePayload)).toEqual({
      pid: process.pid,
      host: os.hostname(),
      ts: oldTime,
      token: expect.any(String),
    });
    expect(isLockStale(livePayload, staleAfterMs, now, os.hostname())).toBe(false);

    // EPERM from process.kill(pid, 0) means the process exists and is treated as alive.
    const killSpy = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      const epermPayload = createLockPayload(oldTime, 999_999_999, os.hostname());
      expect(isLockStale(epermPayload, staleAfterMs, now, os.hostname())).toBe(false);
    } finally {
      killSpy.mockRestore();
    }

    const freshDeadPayload = createLockPayload(now, 999_999_999, os.hostname());
    const agedDeadPayload = createLockPayload(now - staleAfterMs, 999_999_999, os.hostname());
    expect(isLockStale(freshDeadPayload, staleAfterMs, now, os.hostname())).toBe(false);
    expect(isLockStale(agedDeadPayload, staleAfterMs, now, os.hostname())).toBe(true);

    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
    const liveHeldPayload = createLockPayload(Date.now() - 2_000_000, process.pid, os.hostname());
    await fs.writeFile(lockPath, liveHeldPayload, 'utf8');
    expect(acquireLock(lockPath, staleAfterMs)).toEqual({ owned: false });

    const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, timeoutMs: 60 });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    expect(s.executor.seatCalls).toHaveLength(0);
    expect(await fs.readFile(lockPath, 'utf8')).toBe(liveHeldPayload);
  });

  it('a lock with no pid (or cross-host) is only reclaimed past the long threshold', async () => {
    const now = Date.now();
    const staleAfterMs = 1_000;
    const longThresholdMs = staleAfterMs * CROSS_HOST_FACTOR;

    // A missing pid on the SAME host must NOT be treated as dead at the short threshold.
    const sameHostNoPidShort = noPidPayload(now - staleAfterMs, os.hostname());
    const sameHostNoPidBeforeLong = noPidPayload(now - (longThresholdMs - 1), os.hostname());
    const sameHostNoPidAtLong = noPidPayload(now - longThresholdMs, os.hostname());
    expect(isLockStale(sameHostNoPidShort, staleAfterMs, now, os.hostname())).toBe(false);
    expect(isLockStale(sameHostNoPidBeforeLong, staleAfterMs, now, os.hostname())).toBe(false);
    expect(isLockStale(sameHostNoPidAtLong, staleAfterMs, now, os.hostname())).toBe(true);

    // Missing pid and missing host: also requires the long threshold.
    const noPidNoHostShort = noPidPayload(now - staleAfterMs, undefined);
    const noPidNoHostAtLong = noPidPayload(now - longThresholdMs, undefined);
    expect(isLockStale(noPidNoHostShort, staleAfterMs, now, os.hostname())).toBe(false);
    expect(isLockStale(noPidNoHostAtLong, staleAfterMs, now, os.hostname())).toBe(true);

    // Cross-host lock: also requires the long threshold.
    const remoteShort = createLockPayload(now - staleAfterMs, 999_999_999, 'other-host.internal');
    const remoteAtLong = createLockPayload(now - longThresholdMs, 999_999_999, 'other-host.internal');
    expect(isLockStale(remoteShort, staleAfterMs, now, os.hostname())).toBe(false);
    expect(isLockStale(remoteAtLong, staleAfterMs, now, os.hostname())).toBe(true);

    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      await fs.writeFile(lockPath, sameHostNoPidShort, 'utf8');
      expect(acquireLock(lockPath, staleAfterMs, { now })).toEqual({ owned: false });
      expect(await fs.readFile(lockPath, 'utf8')).toBe(sameHostNoPidShort);

      await fs.writeFile(lockPath, sameHostNoPidAtLong, 'utf8');
      const reclaimed = acquireLock(lockPath, staleAfterMs, { now });
      expect(reclaimed.owned).toBe(true);
    }
    {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      const longNoPidPayload = noPidPayload(Date.now() - 2_000_000, os.hostname());
      await fs.writeFile(lockPath, longNoPidPayload, 'utf8');
      const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, timeoutMs: 100 });
      expect(result).toEqual({
        outcome: 'answered', rawAnswer: s.executor.seat.stdout,
        sessionKey: SESSION_KEY, answerPath: path.join(s.briefsDir, `${STEM}.answer.md`), cached: false,
      });
      expect(s.executor.seatCalls).toHaveLength(1);
    }
  });
  describe('every lock operation runs under the guard', () => {
    const STALE_AFTER_MS = 1_000;
    const DEAD_PID = 999_999_999;
    const FAST = { guardAttempts: 2, guardRetryMs: 0 } as const;
    type Op = 'write' | 'read' | 'unlink';
    const real = (): LockFsOps => ({
      writeFileSync: fsSync.writeFileSync.bind(fsSync),
      readFileSync: fsSync.readFileSync.bind(fsSync),
      renameSync: fsSync.renameSync.bind(fsSync),
      unlinkSync: fsSync.unlinkSync.bind(fsSync),
    });

    /**
     * Wraps the real fs; `hook(slot)` runs before (even slot) and after (odd slot)
     * each call. When `diesAt` is reached the process is dead: that call and every
     * later one has no effect and throws, so no catch/finally can clean up.
     */
    function hooked(hook: (slot: number, op: Op, target: string) => void, diesAt = -1): LockFsOps {
      const base = real();
      let index = -1;
      let dead = false;
      const wrap = <A extends unknown[], R>(op: Op, fn: (...args: A) => R) => (...args: A): R => {
        index += 1;
        if (dead || index * 2 === diesAt) {
          dead = true;
          throw new Error('process is dead');
        }
        hook(index * 2, op, String(args[0]));
        const result = fn(...args);
        if (index * 2 + 1 === diesAt) {
          dead = true;
        }
        hook(index * 2 + 1, op, String(args[0]));
        return result;
      };
      return {
        writeFileSync: wrap('write', base.writeFileSync),
        readFileSync: wrap('read', base.readFileSync),
        renameSync: base.renameSync,
        unlinkSync: wrap('unlink', base.unlinkSync),
      };
    }

    async function fixture(ownerPayload: (now: number) => string): Promise<{ lockPath: string; dir: string; now: number }> {
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const lockPath = path.join(s.briefsDir, `${STEM}.lock`);
      const now = Date.now();
      await fs.writeFile(lockPath, ownerPayload(now), 'utf8');
      return { lockPath, dir: s.briefsDir, now };
    }
    /** An aged lock held by another host: stale only by age, so its owner may still be alive and release it. */
    const crossHostOwner = (now: number) =>
      createLockPayload(now - STALE_AFTER_MS * CROSS_HOST_FACTOR - 1, 4242, 'other-host.internal', 'synthetic-owner-token');
    const deadOwner = (now: number) => createLockPayload(now - 2_000_000, DEAD_PID, os.hostname(), 'synthetic-dead-token');

    const countOps = (lockPath: string, now: number): number => {
      let slots = 0;
      acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-probe', fsOps: hooked(() => { slots += 1; }), ...FAST });
      return slots; // two hook calls per fs call
    };
    const ownersOf = (results: readonly (AcquireLockResult | undefined)[]) =>
      results.filter((r): r is Extract<AcquireLockResult, { owned: true }> => r?.owned === true);

    it('the owner releases between the taker compare and delete while C and D create: never two owners', async () => {
      const probe = await fixture(crossHostOwner);
      const slots = countOps(probe.lockPath, probe.now);
      expect(slots).toBeGreaterThan(4);
      for (let pr = 0; pr < slots; pr += 1) {
        for (let pc = 0; pc < slots; pc += 1) {
          for (let pd = pc; pd < slots; pd += 1) {
            const { lockPath, dir, now } = await fixture(crossHostOwner);
            const extra: AcquireLockResult[] = [];
            let released: boolean | undefined;
            const done = new Set<string>();
            const once = (name: string, run: () => void): void => {
              if (!done.has(name)) { done.add(name); run(); }
            };
            const taker = hooked((slot) => {
              if (slot === pr) once('R', () => { released = releaseLock(lockPath, 'synthetic-owner-token', { now, ...FAST }); });
              if (slot === pc) once('C', () => { extra.push(acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-C', ...FAST })); });
              if (slot === pd) once('D', () => { extra.push(acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-D', ...FAST })); });
            });
            const t = acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-T', fsOps: taker, ...FAST });
            const label = `R at ${pr}, C at ${pc}, D at ${pd}`;
            const who = ownersOf([t, ...extra]);
            expect(who.length, label).toBeLessThanOrEqual(1);
            const onDisk = parseLockPayload(await fs.readFile(lockPath, 'utf8').catch(() => ''))?.token;
            if (who.length === 1) {
              expect(onDisk, label).toBe(who[0]!.token);
            }
            // The releaser never deletes a lock that is not its own.
            if (released === false) {
              expect(onDisk === undefined || onDisk !== 'synthetic-owner-token' || who.length === 0, label).toBe(true);
            }
            expect((await fs.readdir(dir)).filter((n) => n !== `${STEM}.lock`), label).toEqual([]);
          }
        }
      }
    });

    it('N first-time acquirers on an absent lock: exactly one owns it, wherever the first is suspended', async () => {
      const probe = await fixture(deadOwner);
      await fs.rm(probe.lockPath);
      const slots = countOps(probe.lockPath, probe.now);
      await fs.rm(probe.lockPath);
      for (let p = 0; p < slots; p += 1) {
        const { lockPath, dir, now } = await fixture(deadOwner);
        await fs.rm(lockPath);
        const others: AcquireLockResult[] = [];
        let fired = false;
        const first = acquireLock(lockPath, STALE_AFTER_MS, {
          now, token: 'synthetic-first', ...FAST,
          fsOps: hooked((slot) => {
            if (slot === p && !fired) {
              fired = true;
              for (const name of ['2', '3', '4']) {
                others.push(acquireLock(lockPath, STALE_AFTER_MS, { now, token: `synthetic-${name}`, ...FAST }));
              }
            }
          }),
        });
        const who = ownersOf([first, ...others]);
        expect(who, `suspended at ${p}`).toHaveLength(1);
        expect(parseLockPayload(await fs.readFile(lockPath, 'utf8'))?.token, `suspended at ${p}`).toBe(who[0]!.token);
        expect((await fs.readdir(dir)).filter((n) => n !== `${STEM}.lock`), `suspended at ${p}`).toEqual([]);
      }
    });

    it('two takers on one stale lock: exactly one wins; release deletes only the owner\'s own lock', async () => {
      const { lockPath, now } = await fixture(deadOwner);
      const first = acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-1' });
      const second = acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-2' });
      expect([first.owned, second.owned]).toEqual([true, false]);
      expect(releaseLock(lockPath, 'synthetic-2', { now })).toBe(false);
      expect(parseLockPayload(await fs.readFile(lockPath, 'utf8'))?.token).toBe('synthetic-1');
      expect(releaseLock(lockPath, 'synthetic-1', { now })).toBe(true);
      expect(await fs.readdir(path.dirname(lockPath))).toEqual([]);
    });

    it('process death at every step: a fresh caller acquires correctly and no artefact outlives the age bound', async () => {
      const probe = await fixture(deadOwner);
      const slots = countOps(probe.lockPath, probe.now);
      for (const start of ['stale', 'absent'] as const) {
        for (let p = 0; p < slots; p += 1) {
          const { lockPath, dir, now } = await fixture(deadOwner);
          if (start === 'absent') await fs.rm(lockPath);
          try {
            acquireLock(lockPath, STALE_AFTER_MS, {
              now, pid: DEAD_PID, token: 'synthetic-crashed', fsOps: hooked(() => {}, p), ...FAST,
            });
          } catch {
            // the process is gone
          }
          // After the age bound a fresh caller (new adapter state, live pid) resolves whatever was left.
          const later = now + GUARD_STALE_AFTER_MS * CROSS_HOST_FACTOR + 1;
          const results: AcquireLockResult[] = [];
          for (let poll = 0; poll < 3 && ownersOf(results).length === 0; poll += 1) {
            results.push(acquireLock(lockPath, STALE_AFTER_MS, { now: later, token: `synthetic-next-${poll}`, ...FAST }));
          }
          const label = `${start}, death at ${p}`;
          const who = ownersOf(results);
          expect(who, label).toHaveLength(1);
          expect(parseLockPayload(await fs.readFile(lockPath, 'utf8'))?.token, label).toBe(who[0]!.token);
          expect((await fs.readdir(dir)).filter((n) => n !== `${STEM}.lock`), label).toEqual([]);
        }
      }
    });

    it('a guard held by a live holder is never broken, however old; a dead holder\'s aged guard is', async () => {
      const { lockPath, dir, now } = await fixture(deadOwner);
      const guardPath = `${lockPath}.guard`;
      const liveGuard = createLockPayload(now - 1_000_000_000, process.pid, os.hostname(), 'synthetic-live-guard');
      await fs.writeFile(guardPath, liveGuard, 'utf8');
      expect(acquireLock(lockPath, STALE_AFTER_MS, { now, token: 'synthetic-blocked', ...FAST })).toEqual({ owned: false });
      expect(await fs.readFile(guardPath, 'utf8')).toBe(liveGuard);
      expect(parseLockPayload(await fs.readFile(lockPath, 'utf8'))?.token).toBe('synthetic-dead-token');
      expect(releaseLock(lockPath, 'synthetic-dead-token', { now, ...FAST })).toBe(false);

      // The same state with a dead holder, through a fresh adapter: acquired, nothing left but the session files.
      const s = await setup();
      await fs.mkdir(s.briefsDir, { recursive: true });
      const staleGuard = createLockPayload(Date.now() - 2 * GUARD_STALE_AFTER_MS, DEAD_PID, os.hostname(), 'synthetic-dead-guard');
      await fs.writeFile(path.join(s.briefsDir, `${STEM}.lock.guard`), staleGuard, 'utf8');
      const result = await adapterFor(s.executor).authorBriefSession(s.request);
      expect(result.outcome).toBe('answered');
      expect((await fs.readdir(s.briefsDir)).sort()).toEqual([`${STEM}.answer.md`, `${STEM}.prompt.md`]);
      expect(dir).toBeDefined();
    });
  });
});
