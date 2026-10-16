import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionReadAdapter } from '../AttentionReadAdapter.adapter.js';
import { WavesHttpClient, type WavesRequestFn } from '../WavesHttpClient.adapter.js';

describe('AttentionReadAdapter with WavesHttpClient', () => {
  let tempDir: string;
  let tokenFilePath: string;
  const validToken = 'waves-attention-secret-token_456';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fleet-attention-test-'));
    tokenFilePath = join(tempDir, 'valid.token');
    await writeFile(tokenFilePath, `${validToken}\n`, 'utf8');
    await chmod(tokenFilePath, 0o600);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createClient(requestFn: WavesRequestFn): WavesHttpClient {
    return new WavesHttpClient({
      baseUrl: 'https://waves.internal:8443',
      tokenFile: tokenFilePath,
      request: requestFn,
    });
  }

  describe('happy path and known absence', () => {
    it('fetches attention and projects, returning parsed summary for existing project', async () => {
      const calledPaths: string[] = [];

      const mockRequest: WavesRequestFn = async (url) => {
        calledPaths.push(url.pathname);
        if (url.pathname === '/api/v1/attention') {
          return {
            status: 200,
            body: JSON.stringify([
              {
                projectId: 'project-alpha',
                staleWorkOrderCount: 3,
                awaitingDecisionCount: 1,
                deliveryGapCount: 2,
                summaryText: '3 stale work orders, 1 awaiting decision',
                observedAtIso: '2026-10-15T10:00:00.000Z',
              },
            ]),
          };
        }
        if (url.pathname === '/api/v1/projects') {
          return {
            status: 200,
            body: JSON.stringify([
              { id: 'project-alpha', lastPush: '2026-10-15T09:59:00.000Z' },
              { id: 'project-beta', lastPush: '2026-10-15T09:30:00.000Z' },
            ]),
          };
        }
        return { status: 404, body: 'not found' };
      };

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });
      const summary = await adapter.fetchProjectAttention('project-alpha');

      expect(calledPaths).toContain('/api/v1/attention');
      expect(calledPaths).toContain('/api/v1/projects');
      expect(summary).toEqual({
        projectId: 'project-alpha',
        staleWorkOrderCount: 3,
        awaitingDecisionCount: 1,
        deliveryGapCount: 2,
        summaryText: '3 stale work orders, 1 awaiting decision',
        observedAtIso: '2026-10-15T10:00:00.000Z',
      });
    });

    it('returns null (known absence) when project is not in /api/v1/projects', async () => {
      const mockRequest: WavesRequestFn = async (url) => {
        if (url.pathname === '/api/v1/attention') {
          return { status: 200, body: JSON.stringify([]) };
        }
        if (url.pathname === '/api/v1/projects') {
          return {
            status: 200,
            body: JSON.stringify([{ id: 'other-project' }]),
          };
        }
        return { status: 404, body: 'not found' };
      };

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });
      const summary = await adapter.fetchProjectAttention('nonexistent-project');

      expect(summary).toBeNull();
    });

    it('returns 0-count summary when project is in projects list but has no attention items', async () => {
      const mockRequest: WavesRequestFn = async (url) => {
        if (url.pathname === '/api/v1/attention') {
          return { status: 200, body: JSON.stringify([]) };
        }
        if (url.pathname === '/api/v1/projects') {
          return {
            status: 200,
            body: JSON.stringify([{ id: 'healthy-project', lastPush: '2026-10-15T11:00:00.000Z' }]),
          };
        }
        return { status: 404, body: 'not found' };
      };

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });
      const summary = await adapter.fetchProjectAttention('healthy-project');

      expect(summary).toEqual({
        projectId: 'healthy-project',
        staleWorkOrderCount: 0,
        awaitingDecisionCount: 0,
        deliveryGapCount: 0,
        summaryText: 'no attention items for healthy-project',
        observedAtIso: '2026-10-15T11:00:00.000Z',
      });
    });
  });

  describe('fail-closed: errors throw and never return empty-as-truth', () => {
    it('throws on 401 from /api/v1/attention without leaking token', async () => {
      const mockRequest: WavesRequestFn = async (url) => {
        if (url.pathname === '/api/v1/attention') {
          return {
            status: 401,
            body: `Unauthorized for token ${validToken}`,
          };
        }
        return {
          status: 200,
          body: JSON.stringify([{ id: 'project-alpha' }]),
        };
      };

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });

      await expect(adapter.fetchProjectAttention('project-alpha')).rejects.toThrow(
        /HTTP 401/i,
      );

      try {
        await adapter.fetchProjectAttention('project-alpha');
      } catch (error) {
        const msg = (error as Error).message;
        expect(msg.includes(validToken)).toBe(false);
      }
    });

    it('throws on 401 from /api/v1/projects without leaking token', async () => {
      const mockRequest: WavesRequestFn = async (url) => {
        if (url.pathname === '/api/v1/attention') {
          return { status: 200, body: '[]' };
        }
        return {
          status: 401,
          body: 'Unauthorized',
        };
      };

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });
      await expect(adapter.fetchProjectAttention('project-alpha')).rejects.toThrow(
        /HTTP 401/i,
      );
    });

    it('throws on timeout, never returning an empty summary as truth', async () => {
      const mockRequest: WavesRequestFn = async (url) => {
        if (url.pathname === '/api/v1/attention') {
          const timeoutErr = Object.assign(new Error('Connection timed out'), {
            code: 'ETIMEDOUT',
          });
          throw timeoutErr;
        }
        return { status: 200, body: JSON.stringify([{ id: 'project-alpha' }]) };
      };

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });

      await expect(adapter.fetchProjectAttention('project-alpha')).rejects.toThrow(
        /ETIMEDOUT/,
      );

      try {
        await adapter.fetchProjectAttention('project-alpha');
      } catch (error) {
        const msg = (error as Error).message;
        expect(msg.includes(validToken)).toBe(false);
      }
    });

    it('throws on 500 error from Waves, never returning an empty summary as truth', async () => {
      const mockRequest: WavesRequestFn = async () => ({
        status: 500,
        body: 'Internal Server Error',
      });

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });
      await expect(adapter.fetchProjectAttention('project-alpha')).rejects.toThrow(
        /HTTP 500/,
      );
    });

    it('throws on invalid JSON response from Waves', async () => {
      const mockRequest: WavesRequestFn = async () => ({
        status: 200,
        body: '<html><body>Gateway error</body></html>',
      });

      const adapter = new AttentionReadAdapter({ client: createClient(mockRequest) });
      await expect(adapter.fetchProjectAttention('project-alpha')).rejects.toThrow(
        /invalid JSON/,
      );
    });
  });

  describe('legacy fallback paths', () => {
    it('uses injected read function when client is omitted', async () => {
      const mockRead = vi.fn().mockResolvedValue({
        projectId: 'proj-legacy',
        staleWorkOrderCount: 1,
        awaitingDecisionCount: 0,
        deliveryGapCount: 0,
        summaryText: 'legacy summary',
        observedAtIso: '2026-10-15T00:00:00.000Z',
      });

      const adapter = new AttentionReadAdapter({ read: mockRead });
      const result = await adapter.fetchProjectAttention('proj-legacy');

      expect(mockRead).toHaveBeenCalledWith('proj-legacy');
      expect(result?.projectId).toBe('proj-legacy');
    });

    it('uses stored summaries when neither client nor read is configured', async () => {
      const adapter = new AttentionReadAdapter({
        summaries: {
          'proj-store': {
            projectId: 'proj-store',
            staleWorkOrderCount: 0,
            awaitingDecisionCount: 2,
            deliveryGapCount: 1,
            summaryText: 'stored summary',
            observedAtIso: '2026-10-15T00:00:00.000Z',
          },
        },
      });

      const result = await adapter.fetchProjectAttention('proj-store');
      expect(result?.awaitingDecisionCount).toBe(2);

      const absent = await adapter.fetchProjectAttention('proj-missing');
      expect(absent).toBeNull();
    });
  });
});
