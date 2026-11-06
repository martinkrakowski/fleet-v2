// ForgeReadAdapter.listOpenPullRequestsByBase: one read-only paginated gh api
// call per base; number, head and base only; a partial, unreadable, late or
// oversized answer is unavailable and never an empty list.

import { describe, expect, it } from 'vitest';

import type { GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import {
  ForgeReadAdapter,
  OPEN_PULL_REQUESTS_JQ,
  parseOpenPullRequests,
  type ForgeReadAdapterOptions,
} from '../ForgeReadAdapter.adapter.js';

const HEAD_A = '3dd5d90509461e3d2154b52da28671aeffa84130';
const HEAD_B = '8e136fe0e0cc916b9d3485eaafe653e3143d9d63';
const BASE = 'chain/example';

function line(number: number, sha: string, base = BASE): string {
  return JSON.stringify({ number, head: { sha }, base: { ref: base } });
}

function ok(stdout: string): GhInvocationResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function makeAdapter(options: Partial<ForgeReadAdapterOptions> = {}): ForgeReadAdapter {
  return new ForgeReadAdapter({ owner: 'fleet', repo: 'fleet-v2', runGh: async () => ok(''), ...options });
}

const never = () => new Promise<GhInvocationResult>(() => undefined);

describe('listOpenPullRequestsByBase', () => {
  it('lists number, head and base only', async () => {
    const calls: (readonly string[])[] = [];
    const adapter = makeAdapter({
      runGh: async (args) => {
        calls.push(args);
        return ok(`${line(12, HEAD_A)}\n${line(13, HEAD_B)}\n`);
      },
    });
    const result = await adapter.listOpenPullRequestsByBase({ base: BASE });
    expect(result).toEqual({
      outcome: 'listed',
      pullRequests: [
        { number: 12, headSha: HEAD_A, baseRef: BASE },
        { number: 13, headSha: HEAD_B, baseRef: BASE },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it('carries no title, body, author, label or path even when the forge sent them', () => {
    const noisy = JSON.stringify({
      number: 5, title: 'secret title', body: 'secret body', user: { login: 'someone' }, labels: [{ name: 'x' }],
      head: { sha: HEAD_A, ref: 'branch/with/path' }, base: { ref: BASE, repo: { full_name: 'a/b' } },
    });
    const result = parseOpenPullRequests(noisy, BASE);
    expect(result).toEqual({ outcome: 'listed', pullRequests: [{ number: 5, headSha: HEAD_A, baseRef: BASE }] });
    expect(JSON.stringify(result)).not.toMatch(/secret|someone|branch\/with/);
  });

  it('asks gh for a read-only paginated list of open pulls by base, 100 per page, reduced by jq', async () => {
    let seen: readonly string[] = [];
    const adapter = makeAdapter({
      runGh: async (args) => {
        seen = args;
        return ok('');
      },
    });
    await adapter.listOpenPullRequestsByBase({ base: BASE });
    expect(seen[0]).toBe('api');
    expect(seen).toContain('--paginate');
    expect(seen).toContain('repos/fleet/fleet-v2/pulls?state=open&base=chain%2Fexample&per_page=100');
    expect(seen[seen.indexOf('--jq') + 1]).toBe(OPEN_PULL_REQUESTS_JQ);
    for (const arg of seen) {
      expect(arg).not.toMatch(/^(-X|--method|--input|-f|-F|--field|--raw-field)$/);
    }
  });

  it('follows pagination to the last page: lines from every page are listed', async () => {
    const pages = [line(1, HEAD_A), line(2, HEAD_B), line(3, HEAD_A)].join('\n');
    const result = await makeAdapter({ runGh: async () => ok(pages) }).listOpenPullRequestsByBase({ base: BASE });
    expect(result.outcome === 'listed' && result.pullRequests.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('lists an empty answer of a successful call as no open pull request', async () => {
    const result = await makeAdapter({ runGh: async () => ok('') }).listOpenPullRequestsByBase({ base: 'main' });
    expect(result).toEqual({ outcome: 'listed', pullRequests: [] });
  });

  it('a partial page is unavailable and never a shorter list', async () => {
    const partial = `${line(1, HEAD_A)}\n{"number":2,"head":{"sha":"${HEAD_B}"},"base":{"re`;
    const result = await makeAdapter({ runGh: async () => ok(partial) }).listOpenPullRequestsByBase({ base: BASE });
    expect(result.outcome).toBe('unavailable');
  });

  it('an unreadable page is unavailable and never an empty list', async () => {
    const bad = [
      'not json',
      '[]',
      '"x"',
      'null',
      line(0, HEAD_A),
      JSON.stringify({ number: 1.5, head: { sha: HEAD_A }, base: { ref: BASE } }),
      JSON.stringify({ number: '1', head: { sha: HEAD_A }, base: { ref: BASE } }),
      JSON.stringify({ number: 1, head: { sha: 'abc' }, base: { ref: BASE } }),
      JSON.stringify({ number: 1, head: { sha: HEAD_A.toUpperCase() }, base: { ref: BASE } }),
      JSON.stringify({ number: 1, head: null, base: { ref: BASE } }),
      JSON.stringify({ number: 1, head: { sha: HEAD_A } }),
      line(1, HEAD_A, 'main'),
      line(1, HEAD_A, 'chain/other'),
    ];
    for (const stdout of bad) {
      const result = await makeAdapter({ runGh: async () => ok(`${line(9, HEAD_B)}\n${stdout}\n`) }).listOpenPullRequestsByBase({ base: BASE });
      expect(result.outcome).toBe('unavailable');
    }
  });

  it('a non-zero exit is unavailable with a reason that names the exit code only', async () => {
    // Assembled at run time so no token-shaped literal sits in the file.
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const adapter = makeAdapter({
      runGh: async () => ({ exitCode: 4, stdout: line(1, HEAD_A), stderr: `token ${token} denied` }),
    });
    const result = await adapter.listOpenPullRequestsByBase({ base: BASE });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'gh api pulls failed (exit 4)' });
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('a timeout is unavailable and never an empty list', async () => {
    const result = await makeAdapter({ runGh: never, timeoutMs: 15 }).listOpenPullRequestsByBase({ base: BASE });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'gh pr view timed out' });
  });

  it('caps the read by the per-call timeout and passes it to gh', async () => {
    const seen: (number | undefined)[] = [];
    const adapter = makeAdapter({
      runGh: async (_args, timeoutMs) => {
        seen.push(timeoutMs);
        return ok('');
      },
      timeoutMs: 30_000,
    });
    await adapter.listOpenPullRequestsByBase({ base: BASE, timeoutMs: 2_500 });
    expect(seen).toEqual([2_500]);
  });

  it('a throwing gh is unavailable', async () => {
    const adapter = makeAdapter({
      runGh: async () => {
        throw new Error('spawn failed at /home/someone/bin/gh');
      },
    });
    const result = await adapter.listOpenPullRequestsByBase({ base: BASE });
    expect(result.outcome).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('/home/someone');
  });

  it('refuses a malformed base with invalid-request and runs no command', async () => {
    let calls = 0;
    const adapter = makeAdapter({
      runGh: async () => {
        calls += 1;
        return ok('');
      },
    });
    for (const base of ['', 'develop', 'chain/', 'chain/Bad', 'chain/a/b', 'main ', '../main', 'chain/a b', 42, null, undefined]) {
      const result = await adapter.listOpenPullRequestsByBase({ base: base as never });
      expect(result).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    }
    expect(calls).toBe(0);
  });

  it('refuses an oversized forge payload and never parses it', async () => {
    const big = `${line(1, HEAD_A)}\n${' '.repeat(1_048_577)}`;
    const result = await makeAdapter({ runGh: async () => ok(big) }).listOpenPullRequestsByBase({ base: BASE });
    expect(result).toEqual({ outcome: 'unavailable', reason: 'gh api pulls output too large' });
  });

  it('is unavailable when no transport or repository is configured', async () => {
    expect(await new ForgeReadAdapter().listOpenPullRequestsByBase({ base: BASE })).toMatchObject({ outcome: 'unavailable' });
    const noRepo = new ForgeReadAdapter({ runGh: async () => ok('') });
    expect(await noRepo.listOpenPullRequestsByBase({ base: BASE })).toMatchObject({ outcome: 'unavailable' });
    expect(
      await noRepo.listOpenPullRequestsByBase({ base: BASE, repository: { owner: 'fleet', repo: 'fleet-v2' } }),
    ).toEqual({ outcome: 'listed', pullRequests: [] });
  });
});
