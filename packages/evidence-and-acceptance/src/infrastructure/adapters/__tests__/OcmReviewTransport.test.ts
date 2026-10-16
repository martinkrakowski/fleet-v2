import { describe, expect, it } from 'vitest';

import type { RunIndependentReviewRequest } from '../../../application/ports/out/IndependentReviewPort.out-port.js';
import { IndependentReviewAdapter } from '../IndependentReviewAdapter.adapter.js';
import {
  buildReviewPrompt,
  createOcmReviewTransport,
  type OcmReviewTransportSpawn,
} from '../OcmReviewTransport.adapter.js';

describe('OcmReviewTransport', () => {
  const baseRequest: RunIndependentReviewRequest = {
    attemptId: 'att-100',
    candidateHeadSha: 'sha-abcdef1234567890',
    implementerModel: 'anthropic/claude-3-5-sonnet',
    reviewerModel: 'openai/gpt-4o',
    diffSummary: 'Added verification checks',
  };

  it('model mismatch throws and does not spawn', async () => {
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: 'google/gemini-1.5-pro',
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    await expect(transport(baseRequest)).rejects.toThrow(
      /reviewer model mismatch: request specified "openai\/gpt-4o" but transport configured for "google\/gemini-1.5-pro"/,
    );
    expect(spawnCalled).toBe(false);
  });

  it('null dir throws and does not spawn', async () => {
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => null,
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    await expect(transport(baseRequest)).rejects.toThrow(
      /failed to resolve review directory for attempt att-100/,
    );
    expect(spawnCalled).toBe(false);
  });

  it('head mismatch before throws and does not spawn', async () => {
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => 'sha-different-before',
      spawn: fakeSpawn,
    });

    await expect(transport(baseRequest)).rejects.toThrow(
      /head mismatch before review: expected sha-abcdef1234567890, found sha-different-before/,
    );
    expect(spawnCalled).toBe(false);
  });

  it('exact argv and env (assert no key outside the list, and that a fake GH_TOKEN in process.env is absent)', async () => {
    const savedGhToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'secret-token-to-strip';

    try {
      let capturedFile = '';
      let capturedArgs: readonly string[] = [];
      let capturedEnv: Record<string, string> = {};

      const fakeSpawn: OcmReviewTransportSpawn = async (file, args, env) => {
        capturedFile = file;
        capturedArgs = args;
        capturedEnv = env;
        return {
          exitCode: 0,
          stdout: '{"type":"text","part":{"text":"VERDICT: PASS\\n"}}',
          stderr: '',
        };
      };

      const transport = createOcmReviewTransport({
        ocmRunBin: '/bundled/bin/ocm-run',
        remotePort: 4096,
        remoteHost: 'runner-host.internal',
        agent: 'reviewer',
        model: baseRequest.reviewerModel,
        variant: 'strict-mode',
        resolveReviewDir: async () => '/worktrees/review-dir',
        readHead: async () => baseRequest.candidateHeadSha,
        spawn: fakeSpawn,
      });

      await transport(baseRequest);

      expect(capturedFile).toBe('/bundled/bin/ocm-run');

      const expectedPrompt = buildReviewPrompt(baseRequest);
      expect(capturedArgs).toEqual([
        '--dir',
        '/worktrees/review-dir',
        '--agent',
        'reviewer',
        '-m',
        baseRequest.reviewerModel,
        '--variant',
        'strict-mode',
        '--format',
        'json',
        expectedPrompt,
      ]);

      expect(capturedEnv.OCM_REMOTE_PORT).toBe('4096');
      expect(capturedEnv.OCM_HOST).toBe('runner-host.internal');
      expect(capturedEnv.GH_TOKEN).toBeUndefined();

      const ALLOWED_ENV_KEYS = new Set([
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'SSH_AUTH_SOCK',
        'OCM_REMOTE_PORT',
        'OCM_HOST',
      ]);

      for (const key of Object.keys(capturedEnv)) {
        expect(ALLOWED_ENV_KEYS.has(key)).toBe(true);
      }
    } finally {
      if (savedGhToken !== undefined) {
        process.env.GH_TOKEN = savedGhToken;
      } else {
        delete process.env.GH_TOKEN;
      }
    }
  });

  it('exit 1 throws', async () => {
    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'daemon failed to start runner session',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    await expect(transport(baseRequest)).rejects.toThrow(
      /reviewer process failed with exit code 1: daemon failed to start runner session/,
    );
  });

  it('only read/grep tools + VERDICT: PASS → pass, readOnlyVerified true', async () => {
    const recordedFixture = [
      '{"type":"tool","part":{"tool":"read"}}',
      '{"type":"text","part":{"text":"Inspected implementation files.\\n"}}',
      '{"type":"tool","part":{"tool":"grep"}}',
      '{"type":"tool_use","part":{"tool":"glob"}}',
      '{"type":"tool_call","part":{"tool":"list"}}',
      '{"type":"text","part":{"text":"No regressions found.\\nVERDICT: PASS\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('pass');
    expect(result.readOnlyVerified).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.rawOutput).toContain('VERDICT: PASS');
  });

  it('one edit tool event → readOnlyVerified false', async () => {
    const recordedFixture = [
      '{"type":"tool","part":{"tool":"read"}}',
      '{"type":"tool","part":{"tool":"edit"}}',
      '{"type":"text","part":{"text":"VERDICT: PASS\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.readOnlyVerified).toBe(false);
    expect(result.result).toBe('pass');
  });

  it('head changed after → false', async () => {
    const recordedFixture = [
      '{"type":"tool","part":{"tool":"read"}}',
      '{"type":"text","part":{"text":"VERDICT: PASS\\n"}}',
    ].join('\n');

    let headReadCount = 0;
    const readHead = async () => {
      headReadCount++;
      return headReadCount === 1 ? baseRequest.candidateHeadSha : 'sha-mutated-after';
    };

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.readOnlyVerified).toBe(false);
    expect(result.result).toBe('pass');
  });

  it('no verdict → unknown', async () => {
    const recordedFixture = [
      '{"type":"tool","part":{"tool":"read"}}',
      '{"type":"text","part":{"text":"Review finished without concluding verdict line."}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('unknown');
    expect(result.readOnlyVerified).toBe(true);
  });

  it('two verdict lines → unknown', async () => {
    const recordedFixture = [
      '{"type":"text","part":{"text":"VERDICT: PASS\\nVERDICT: FAIL\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('unknown');
  });

  it('VERDICT: pass (lowercase) → unknown', async () => {
    const recordedFixture = [
      '{"type":"text","part":{"text":"VERDICT: pass\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('unknown');
  });

  it('empty stdout → unknown', async () => {
    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('unknown');
    expect(result.rawOutput).toBe('');
    expect(result.findings).toEqual([]);
  });

  it('PASS with a blocker finding → fail', async () => {
    const recordedFixture = [
      '{"type":"tool","part":{"tool":"read"}}',
      '{"type":"text","part":{"text":"FINDING: blocker src/security.ts:42 Hardcoded secret token in auth flow\\nVERDICT: PASS\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('fail');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('blocker');
  });

  it('finding parsing with and without line', async () => {
    const recordedFixture = [
      '{"type":"tool","part":{"tool":"read"}}',
      '{"type":"text","part":{"text":"FINDING: blocker src/core.ts:15 Null pointer on empty config\\n"}}',
      '{"type":"text","part":{"text":"FINDING: major src/network.ts Unhandled socket error\\n"}}',
      '{"type":"text","part":{"text":"FINDING: minor -:88 Unused global variable\\n"}}',
      '{"type":"text","part":{"text":"FINDING: nit - Typo in comment\\n"}}',
      '{"type":"text","part":{"text":"VERDICT: FAIL\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('fail');
    expect(result.findings).toEqual([
      {
        findingId: 'review-1',
        severity: 'blocker',
        filePath: 'src/core.ts',
        line: 15,
        summary: 'Null pointer on empty config',
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      },
      {
        findingId: 'review-2',
        severity: 'major',
        filePath: 'src/network.ts',
        line: null,
        summary: 'Unhandled socket error',
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      },
      {
        findingId: 'review-3',
        severity: 'minor',
        filePath: null,
        line: 88,
        summary: 'Unused global variable',
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      },
      {
        findingId: 'review-4',
        severity: 'nit',
        filePath: null,
        line: null,
        summary: 'Typo in comment',
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      },
    ]);
  });

  it('skips unparsable JSON lines gracefully', async () => {
    const recordedFixture = [
      '--- opencode debug header ---',
      '{"type":"tool","part":{"tool":"read"}}',
      'corrupted json line {',
      '{"type":"text","part":{"text":"VERDICT: PASS\\n"}}',
      'random trailing log message',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.result).toBe('pass');
    expect(result.readOnlyVerified).toBe(true);
  });

  it('caps rawOutput at the last 20000 characters', async () => {
    const prefix = 'x'.repeat(25000);
    const recordedFixture = [
      `{"type":"text","part":{"text":"${prefix}"}}`,
      '{"type":"text","part":{"text":"\\nVERDICT: PASS\\n"}}',
    ].join('\n');

    const fakeSpawn: OcmReviewTransportSpawn = async () => ({
      exitCode: 0,
      stdout: recordedFixture,
      stderr: '',
    });

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: baseRequest.reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const result = await transport(baseRequest);
    expect(result.rawOutput.length).toBe(20000);
    expect(result.rawOutput.endsWith('VERDICT: PASS\n')).toBe(true);
  });

  it('through IndependentReviewAdapter: same-family models → unavailable and spawn never called', async () => {
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const reviewerModel = 'openrouter/anthropic/claude-3-5-sonnet';
    const implementerModel = 'bedrock/anthropic/claude-3-5-sonnet';

    const transport = createOcmReviewTransport({
      ocmRunBin: '/test/ocm-run',
      remotePort: 4096,
      agent: 'reviewer',
      model: reviewerModel,
      resolveReviewDir: async () => '/tmp/review-dir',
      readHead: async () => baseRequest.candidateHeadSha,
      spawn: fakeSpawn,
    });

    const adapter = new IndependentReviewAdapter({ runReview: transport });

    const result = await adapter.runIndependentReview({
      attemptId: 'att-same-family',
      candidateHeadSha: baseRequest.candidateHeadSha,
      implementerModel,
      reviewerModel,
    });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.reason).toContain('share the same underlying model');
    }
    expect(spawnCalled).toBe(false);
  });
});
