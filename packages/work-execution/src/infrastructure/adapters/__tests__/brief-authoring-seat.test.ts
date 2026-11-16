// Lane CO17: BriefAuthoringAdapter seat session tests (fake executor, real temp directories).
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

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
const RETRY_KEY = `${SESSION_KEY}/retry`;
const RETRY_STEM = `${STEM}__retry`;
const RETRY_FIELDS = { sessionKey: RETRY_KEY, retry: true as const, prompt: 'RETRY PROMPT' };
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
  /** Runs at the start of every executor call (the checkout check and the seat alike). */
  public onCall: (() => Promise<void>) | undefined;
  public seat: CommandRunResult = { exitCode: 0, signal: null, stdout: '===NOTES===\nn\n===DISPATCH===\nbody\n', stderr: '' };

  public async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ argv, options });
    await this.onCall?.();
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

  it('a pre-existing symlink at the intent-file path is never followed', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const decoy = path.join(s.root, 'decoy-intent.json');
    // Live-looking intent planted outside the briefs directory. Following the
    // symlink would make the claim look live and refuse instead of running.
    const decoyContent = `${JSON.stringify({ sessionKey: SESSION_KEY, startedAt: new Date().toISOString() })}\n`;
    await fs.writeFile(decoy, decoyContent, 'utf8');
    await fs.symlink(decoy, path.join(s.briefsDir, `${STEM}.intent.json`));
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'answered', answer: s.executor.seat.stdout });
    expect(s.executor.seatCalls).toHaveLength(1);
    expect(await fs.readFile(decoy, 'utf8')).toBe(decoyContent);
    const intent = JSON.parse(await fs.readFile(path.join(s.briefsDir, `${STEM}.intent.json`), 'utf8')) as Record<string, unknown>;
    expect(intent.sessionKey).toBe(SESSION_KEY);
  });

  it('a symlinked briefsDir is refused and nothing is written through the link', async () => {
    const s = await setup();
    const realBriefs = path.join(s.root, 'real-briefs');
    await fs.mkdir(realBriefs);
    await fs.symlink(realBriefs, s.briefsDir);
    const result = await adapterFor(s.executor).authorBriefSession(s.request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(realBriefs)).toEqual([]);
  });

  it('a symlinked recorded answer is refused and its target is never read', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    const secret = path.join(s.root, 'secret.txt');
    await fs.writeFile(secret, 'outside content', 'utf8');
    await fs.symlink(secret, path.join(s.briefsDir, `${STEM}.answer.md`));
    await expect(adapterFor(s.executor).authorBriefSession(s.request)).rejects.toThrow('recorded brief answer is unreadable');
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
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    expect(s.executor.seatCalls).toHaveLength(0);
    expect(await fs.readFile(target, 'utf8')).toBe('untouched');
  });

  it('a briefsDir under a regular file (uninspectable component) is refused', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.root, 'notdir'), 'x', 'utf8');
    const request = { ...s.request, briefsDir: path.join(s.root, 'notdir', 'briefs') };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('a relative briefsDir is refused', async () => {
    const s = await setup();
    const result = await adapterFor(s.executor).authorBriefSession({ ...s.request, briefsDir: 'relative/briefs' });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
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
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
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
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(realParent)).toEqual([]);
  });

  it('a briefsDir with a dot-dot segment is refused', async () => {
    const s = await setup();
    const request = { ...s.request, briefsDir: `${s.root}/elsewhere/../briefs` };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(s.root)).toEqual(['checkout']);
  });

  it('a briefsDir that does not exist yet, under real directories, is created and used', async () => {
    const s = await setup();
    const request = { ...s.request, briefsDir: path.join(s.root, 'fresh', 'briefs') };
    const result = await adapterFor(s.executor).authorBriefSession(request);
    expect(result).toEqual({ outcome: 'answered', answer: s.executor.seat.stdout });
    expect(await fs.readFile(path.join(request.briefsDir, `${STEM}.answer.md`), 'utf8')).toBe(s.executor.seat.stdout);
  });

  it('concurrent retries on a stale intent run the seat exactly once', async () => {
    const s = await setup();
    await fs.mkdir(s.briefsDir, { recursive: true });
    await fs.writeFile(path.join(s.briefsDir, `${STEM}.intent.json`), '{"sessionKey":"x","startedAt":"t"}\n', 'utf8');
    const adapter = adapterFor(s.executor);
    const results = await Promise.all([
      adapter.authorBriefSession(s.request),
      adapter.authorBriefSession(s.request),
    ]);
    expect(results.filter((r) => r.outcome === 'answered')).toEqual([
      { outcome: 'answered', answer: s.executor.seat.stdout },
    ]);
    expect(results.filter((r) => r.outcome === 'unavailable')).toEqual([
      { outcome: 'unavailable', reason: 'session-failed' },
    ]);
    expect(s.executor.seatCalls).toHaveLength(1);
  });

  it('a retry runs its own seat session under the retry stem and leaves the first record untouched', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST', stderr: '' };
    await adapter.authorBriefSession(s.request);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND', stderr: '' };
    const retry = await adapter.authorBriefSession({
      ...s.request, sessionKey: RETRY_KEY, retry: true as const, prompt: 'RETRY PROMPT',
    });
    expect(retry).toEqual({ outcome: 'answered', answer: 'SECOND' });
    expect(s.executor.seatCalls).toHaveLength(2);
    expect(await fs.readFile(path.join(s.briefsDir, `${STEM}.answer.md`), 'utf8')).toBe('FIRST');
    expect(await fs.readFile(path.join(s.briefsDir, `${RETRY_STEM}.answer.md`), 'utf8')).toBe('SECOND');
    expect(await fs.readFile(path.join(s.briefsDir, `${RETRY_STEM}.prompt.md`), 'utf8')).toBe('RETRY PROMPT');
    const intent = JSON.parse(await fs.readFile(path.join(s.briefsDir, `${RETRY_STEM}.intent.json`), 'utf8')) as Record<string, unknown>;
    expect(intent.sessionKey).toBe(RETRY_KEY);
  });

  it('a repeat of the retry returns the recorded retry answer and runs no third session', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST', stderr: '' };
    await adapter.authorBriefSession(s.request);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND', stderr: '' };
    const retryRequest = { ...s.request, sessionKey: RETRY_KEY, retry: true as const, prompt: 'RETRY PROMPT' };
    await adapter.authorBriefSession(retryRequest);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'THIRD', stderr: '' };
    const again = await adapter.authorBriefSession(retryRequest);
    expect(again).toEqual({ outcome: 'answered', answer: 'SECOND' });
    expect(s.executor.seatCalls).toHaveLength(2);
  });

  it('a retry key without retry true, and retry true with the plain key, are refused', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    const wrongKey = await adapter.authorBriefSession({ ...s.request, sessionKey: RETRY_KEY });
    expect(wrongKey).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    const wrongFlag = await adapter.authorBriefSession({ ...s.request, retry: true });
    expect(wrongFlag).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(s.briefsDir).catch(() => [])).toEqual([]);
  });

  it('a retry with no recorded first answer is refused and runs nothing', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    const retryRequest = { ...s.request, sessionKey: RETRY_KEY, retry: true as const, prompt: 'RETRY PROMPT' };
    const refused = await adapter.authorBriefSession(retryRequest);
    expect(refused).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
    expect(await fs.readdir(s.briefsDir).catch(() => [])).toEqual([]);
    await fs.mkdir(s.briefsDir, { recursive: true });
    await fs.writeFile(path.join(s.briefsDir, `${RETRY_STEM}.answer.md`), 'OLD', 'utf8');
    const refusedAgain = await adapter.authorBriefSession(retryRequest);
    expect(refusedAgain).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('a first attempt that runs again deletes the recorded retry answer', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST', stderr: '' };
    await adapter.authorBriefSession(s.request);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND', stderr: '' };
    const retryRequest = { ...s.request, sessionKey: RETRY_KEY, retry: true as const, prompt: 'RETRY PROMPT' };
    await adapter.authorBriefSession(retryRequest);
    await fs.rm(path.join(s.briefsDir, `${STEM}.answer.md`));
    await fs.rm(path.join(s.briefsDir, `${STEM}.intent.json`));
    await fs.rm(path.join(s.briefsDir, `${RETRY_STEM}.intent.json`));
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST-AGAIN', stderr: '' };
    const rerun = await adapter.authorBriefSession(s.request);
    expect(rerun).toEqual({ outcome: 'answered', answer: 'FIRST-AGAIN' });
    await expect(fs.access(path.join(s.briefsDir, `${RETRY_STEM}.answer.md`))).rejects.toThrow();
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND-AGAIN', stderr: '' };
    const retryAgain = await adapter.authorBriefSession(retryRequest);
    expect(retryAgain).toEqual({ outcome: 'answered', answer: 'SECOND-AGAIN' });
    expect(s.executor.seatCalls).toHaveLength(4);
  });

  it('a replayed first answer leaves the recorded retry answer in place', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST', stderr: '' };
    await adapter.authorBriefSession(s.request);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND', stderr: '' };
    await adapter.authorBriefSession({
      ...s.request, sessionKey: RETRY_KEY, retry: true as const, prompt: 'RETRY PROMPT',
    });
    const replay = await adapter.authorBriefSession(s.request);
    expect(replay).toEqual({ outcome: 'answered', answer: 'FIRST' });
    expect(await fs.readFile(path.join(s.briefsDir, `${RETRY_STEM}.answer.md`), 'utf8')).toBe('SECOND');
    expect(s.executor.seatCalls).toHaveLength(2);
  });

  it('a retry value other than true is refused', async () => {
    const s = await setup();
    const result = await adapterFor(s.executor)
      .authorBriefSession({ ...s.request, retry: false as unknown as true });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
  });

  it('a retry key for a different brief is refused', async () => {
    const s = await setup();
    const adapter = adapterFor(s.executor);
    const otherBrief = await adapter.authorBriefSession({
      ...s.request, sessionKey: `brief-author/wo-2/lane-1@${COMMIT.slice(0, 12)}/retry`, retry: true as const,
    });
    expect(otherBrief).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    const doubledSuffix = await adapter.authorBriefSession({
      ...s.request, sessionKey: `${RETRY_KEY}/retry`, retry: true as const,
    });
    expect(doubledSuffix).toEqual({ outcome: 'unavailable', reason: 'session-command-invalid' });
    expect(s.executor.calls).toHaveLength(0);
  });
  async function recordFirstAndRetry(s: Setup): Promise<BriefAuthoringAdapter> {
    const adapter = adapterFor(s.executor);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST', stderr: '' };
    await adapter.authorBriefSession(s.request);
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND', stderr: '' };
    await adapter.authorBriefSession({ ...s.request, ...RETRY_FIELDS });
    return adapter;
  }

  /** Make the first attempt runnable again: its answer and both intents are gone, the retry answer stays. */
  async function reopenFirstAttempt(s: Setup): Promise<void> {
    await fs.rm(path.join(s.briefsDir, `${STEM}.answer.md`));
    await fs.rm(path.join(s.briefsDir, `${STEM}.intent.json`));
    await fs.rm(path.join(s.briefsDir, `${RETRY_STEM}.intent.json`));
  }

  async function exists(file: string): Promise<boolean> {
    return fs.access(file).then(() => true, () => false);
  }

  /** Fail the next write-open of any file ending in `suffix`: by rejecting, or by writing other bytes. */
  function breakWriteOf(suffix: string, mode: 'reject' | 'corrupt') {
    const original = fs.open.bind(fs);
    return vi.spyOn(fs, 'open').mockImplementation(async (file, flags, fileMode) => {
      const writing = typeof flags === 'number' && (flags & fsConstants.O_CREAT) !== 0;
      if (!writing || !String(file).endsWith(suffix)) {
        return original(file, flags, fileMode);
      }
      if (mode === 'reject') {
        throw new Error('injected write failure');
      }
      const handle = await original(file, flags, fileMode);
      handle.writeFile = async () => fs.writeFile(String(file), 'CORRUPT', 'utf8');
      return handle;
    });
  }

  it('a first attempt removes a stale retry answer before the checkout check and the seat, and a later retry runs the seat', async () => {
    const s = await setup();
    const adapter = await recordFirstAndRetry(s);
    await reopenFirstAttempt(s);
    const retryAnswer = path.join(s.briefsDir, `${RETRY_STEM}.answer.md`);
    expect(await exists(retryAnswer)).toBe(true);
    const presentAtCall: boolean[] = [];
    s.executor.onCall = async () => { presentAtCall.push(await exists(retryAnswer)); };
    const callsBefore = s.executor.calls.length;
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST-AGAIN', stderr: '' };
    expect(await adapter.authorBriefSession(s.request)).toEqual({ outcome: 'answered', answer: 'FIRST-AGAIN' });
    expect(s.executor.calls.length - callsBefore).toBe(2);
    expect(presentAtCall).toEqual([false, false]);
    s.executor.onCall = undefined;
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND-AGAIN', stderr: '' };
    expect(await adapter.authorBriefSession({ ...s.request, ...RETRY_FIELDS }))
      .toEqual({ outcome: 'answered', answer: 'SECOND-AGAIN' });
    expect(s.executor.seatCalls).toHaveLength(4);
  });

  it('a stale retry answer that cannot be removed refuses the first attempt and runs no seat', async () => {
    const s = await setup();
    const adapter = await recordFirstAndRetry(s);
    await reopenFirstAttempt(s);
    const retryAnswer = path.join(s.briefsDir, `${RETRY_STEM}.answer.md`);
    await fs.rm(retryAnswer);
    await fs.mkdir(retryAnswer);
    await fs.writeFile(path.join(retryAnswer, 'keep'), 'x', 'utf8');
    const callsBefore = s.executor.calls.length;
    s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST-AGAIN', stderr: '' };
    expect(await adapter.authorBriefSession(s.request)).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
    expect(s.executor.calls).toHaveLength(callsBefore);
    expect(await exists(path.join(s.briefsDir, `${STEM}.answer.md`))).toBe(false);
    expect(await exists(path.join(retryAnswer, 'keep'))).toBe(true);
  });

  it.each([['rejects', 'reject'], ['reads back other bytes', 'corrupt']] as const)(
    'a first answer write that %s is session-failed and records no answer',
    async (_name, mode) => {
      const s = await setup();
      const spy = breakWriteOf(`${STEM}.answer.md`, mode);
      try {
        const result = await adapterFor(s.executor).authorBriefSession(s.request);
        expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
      } finally {
        spy.mockRestore();
      }
      expect(s.executor.seatCalls).toHaveLength(1);
      expect(await exists(path.join(s.briefsDir, `${STEM}.answer.md`))).toBe(false);
    },
  );

  it.each([['rejects', 'reject'], ['reads back other bytes', 'corrupt']] as const)(
    'a retry answer write that %s is session-failed, records no retry answer and keeps the first answer',
    async (_name, mode) => {
      const s = await setup();
      const adapter = adapterFor(s.executor);
      s.executor.seat = { exitCode: 0, signal: null, stdout: 'FIRST', stderr: '' };
      await adapter.authorBriefSession(s.request);
      s.executor.seat = { exitCode: 0, signal: null, stdout: 'SECOND', stderr: '' };
      const spy = breakWriteOf(`${RETRY_STEM}.answer.md`, mode);
      try {
        const result = await adapter.authorBriefSession({ ...s.request, ...RETRY_FIELDS });
        expect(result).toEqual({ outcome: 'unavailable', reason: 'session-failed' });
      } finally {
        spy.mockRestore();
      }
      expect(s.executor.seatCalls).toHaveLength(2);
      expect(await exists(path.join(s.briefsDir, `${RETRY_STEM}.answer.md`))).toBe(false);
      expect(await fs.readFile(path.join(s.briefsDir, `${STEM}.answer.md`), 'utf8')).toBe('FIRST');
    },
  );
});
