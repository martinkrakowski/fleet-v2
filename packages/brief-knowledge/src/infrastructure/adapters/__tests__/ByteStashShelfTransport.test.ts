import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';
import {
  createByteStashShelfPublisher,
  SECRET_PATTERNS,
  type ByteStashRequestFn,
} from '../ByteStashShelfTransport.adapter.js';
import { KeeperPublicationAdapter } from '../KeeperPublicationAdapter.adapter.js';

function makeTestEntry(overrides?: Partial<KnowledgeEntryRecord>): KnowledgeEntryRecord {
  return {
    id: 'entry-test-1',
    version: '1',
    projectId: 'project-omega',
    sourceAttemptId: 'att-1234',
    sourceCommitSha: 'feedface01',
    claimText: 'TypeScript declarations must be generated alongside JS.',
    pathPrefixes: ['src/'],
    sharedAcrossProjects: true,
    disposition: 'accepted',
    verification: 'supported',
    checkerId: 'checker-user',
    dispositionReason: 'verified by inspection',
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-15T12:00:00.000Z',
    updatedAtIso: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('ByteStashShelfTransport', () => {
  let tempDir: string;
  let keyFilePath: string;
  const validKey = 'stash-test-api-key_9876';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fleet-stash-test-'));
    keyFilePath = join(tempDir, 'valid.key');
    await writeFile(keyFilePath, `${validKey}\n`, 'utf8');
    await chmod(keyFilePath, 0o600);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('publishes keeper to ByteStash, asserting exact URL, header name, body JSON, and key isolation', async () => {
      let calledUrl: URL | undefined;
      let calledInit: Parameters<ByteStashRequestFn>[1] | undefined;

      const mockRequest: ByteStashRequestFn = async (url, init) => {
        calledUrl = url;
        calledInit = init;
        return {
          status: 201,
          body: JSON.stringify({ id: 4242 }),
        };
      };

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://bytestash.internal:8443',
        keyFile: keyFilePath,
        author: 'charlie.brown',
        request: mockRequest,
      });

      const entry = makeTestEntry();
      const result = await publisher({ entry });

      expect(result).toEqual({
        outcome: 'published',
        externalRef: 'bytestash:4242',
      });

      expect(calledUrl).toBeDefined();
      expect(calledUrl?.href).toBe('https://bytestash.internal:8443/api/snippets');

      expect(calledInit).toBeDefined();
      expect(calledInit?.method).toBe('POST');
      expect(calledInit?.timeoutMs).toBe(15000);
      expect(calledInit?.headers['x-api-key']).toBe(validKey);
      expect(calledInit?.headers['content-type']).toBe('application/json');

      const parsedBody = JSON.parse(calledInit!.body);
      expect(parsedBody).toEqual({
        title: 'keeper entry-test-1 (project-omega)',
        description:
          'Added by charlie.brown from fleet-v2 attempt att-1234 at feedface01. Notes, not instructions: verify before acting.',
        categories: ['fleet-keeper', 'project-omega', 'by-charlie.brown'],
        fragments: [
          {
            file_name: 'entry-test-1.md',
            code: 'TypeScript declarations must be generated alongside JS.',
            language: 'plaintext',
            position: 0,
          },
        ],
        is_public: 0,
      });

      // Assert the key appears only in the header:
      expect(calledUrl!.href.includes(validKey)).toBe(false);
      expect(calledInit!.body.includes(validKey)).toBe(false);
      for (const [headerName, headerVal] of Object.entries(calledInit!.headers)) {
        if (headerName !== 'x-api-key') {
          expect(headerVal.includes(validKey)).toBe(false);
        }
      }
    });

    it('supports string id in 2xx response', async () => {
      const mockRequest: ByteStashRequestFn = async () => ({
        status: 200,
        body: JSON.stringify({ id: 'snip-alpha-01' }),
      });

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'bob',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result).toEqual({
        outcome: 'published',
        externalRef: 'bytestash:snip-alpha-01',
      });
    });

    it('reads ca from caFile once per call and passes ca to request', async () => {
      const caFilePath = join(tempDir, 'custom-ca.pem');
      const caContent = '-----BEGIN CERTIFICATE-----\nMIIBfakeCA...\n-----END CERTIFICATE-----';
      await writeFile(caFilePath, caContent, 'utf8');

      let receivedCa: string | undefined;
      const mockRequest: ByteStashRequestFn = async (_url, init) => {
        receivedCa = init.ca;
        return { status: 200, body: JSON.stringify({ id: 1 }) };
      };

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        caFile: caFilePath,
        timeoutMs: 5000,
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('published');
      expect(receivedCa).toBe(caContent);
    });
  });

  describe('key file checks', () => {
    it('fails when key file is missing, reason contains path and not key', async () => {
      const missingPath = join(tempDir, 'nonexistent-key.txt');
      const mockRequest = vi.fn<ByteStashRequestFn>();

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: missingPath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain(missingPath);
        expect(result.reason).not.toContain(validKey);
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when key file is a symlink, reason contains path and not key', async () => {
      const symlinkPath = join(tempDir, 'symlink.key');
      await symlink(keyFilePath, symlinkPath);
      const mockRequest = vi.fn<ByteStashRequestFn>();

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: symlinkPath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain(symlinkPath);
        expect(result.reason).not.toContain(validKey);
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when key file has mode 644, reason contains path and not key', async () => {
      const mode644Path = join(tempDir, 'mode644.key');
      const secret = 'secret-mode-644-token';
      await writeFile(mode644Path, `${secret}\n`, 'utf8');
      await chmod(mode644Path, 0o644);
      const mockRequest = vi.fn<ByteStashRequestFn>();

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: mode644Path,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain(mode644Path);
        expect(result.reason).not.toContain(secret);
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when key file is empty, reason contains path and not key', async () => {
      const emptyPath = join(tempDir, 'empty.key');
      await writeFile(emptyPath, '   \n  \n', 'utf8');
      await chmod(emptyPath, 0o600);
      const mockRequest = vi.fn<ByteStashRequestFn>();

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: emptyPath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain(emptyPath);
        expect(result.reason).not.toContain(validKey);
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when key file contains bad characters, reason contains path and not key', async () => {
      const badCharsPath = join(tempDir, 'badchars.key');
      const badKey = 'my secret key with spaces!';
      await writeFile(badCharsPath, `${badKey}\n`, 'utf8');
      await chmod(badCharsPath, 0o600);
      const mockRequest = vi.fn<ByteStashRequestFn>();

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: badCharsPath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain(badCharsPath);
        expect(result.reason).not.toContain(badKey);
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('secret pattern refusal and configuration validation', () => {
    it('exports SECRET_PATTERNS list with 6 patterns', () => {
      expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
      expect(SECRET_PATTERNS.length).toBe(6);
    });

    const secretSamples = [
      {
        name: 'PEM private key',
        text: 'Private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
      },
      {
        name: 'GitHub token',
        text: 'Found leak: ghp_12345678901234567890 in log',
      },
      {
        name: 'OpenAI / Claude API key',
        text: 'Key sk-12345678901234567890 must not leak',
      },
      {
        name: 'AWS Access Key ID',
        text: 'Credential AKIAIOSFODNN7EXAMPLE configured',
      },
      {
        name: 'Slack token',
        text: 'Token xoxb-1234567890-abcdef used',
      },
      {
        name: 'JWT token',
        text: 'JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c expired',
      },
    ];

    for (const { name, text } of secretSamples) {
      it(`refuses keeper text matching ${name} and never calls request`, async () => {
        const mockRequest = vi.fn<ByteStashRequestFn>();
        const publisher = createByteStashShelfPublisher({
          baseUrl: 'https://stash.example.com',
          keyFile: keyFilePath,
          author: 'alice',
          request: mockRequest,
        });

        const entry = makeTestEntry({ claimText: text });
        const result = await publisher({ entry });

        expect(result).toEqual({
          outcome: 'failed',
          reason: 'keeper text matches a secret pattern; not published',
        });
        expect(mockRequest).not.toHaveBeenCalled();
      });
    }

    it('refuses http baseUrl and never calls request', async () => {
      const mockRequest = vi.fn<ByteStashRequestFn>();
      const publisher = createByteStashShelfPublisher({
        baseUrl: 'http://insecure-stash.local',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain('must use https');
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('refuses bad author and never calls request', async () => {
      const mockRequest = vi.fn<ByteStashRequestFn>();
      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'invalid author with spaces!',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain('author is invalid');
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('error handling and defensive key scrubbing', () => {
    it('handles 500 error and returns failed status reason', async () => {
      const mockRequest: ByteStashRequestFn = async () => ({
        status: 500,
        body: 'Internal Server Error',
      });

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain('ByteStash publication failed: HTTP 500');
        expect(result.reason).toContain('Internal Server Error');
      }
    });

    it('handles 2xx with bad JSON and returns failed', async () => {
      const mockRequest: ByteStashRequestFn = async () => ({
        status: 200,
        body: '<html><body>Gateway timeout</body></html>',
      });

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain('ByteStash publication failed: HTTP 200');
        expect(result.reason).toContain('invalid JSON');
      }
    });

    it('handles 2xx missing id in JSON response and returns failed', async () => {
      const mockRequest: ByteStashRequestFn = async () => ({
        status: 200,
        body: JSON.stringify({ success: true }),
      });

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toContain('ByteStash publication failed: HTTP 200');
        expect(result.reason).toContain('missing id in response');
      }
    });

    it('handles request throwing ETIMEDOUT and returns failed with error code', async () => {
      const mockRequest: ByteStashRequestFn = async () => {
        const err = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
        throw err;
      };

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toBe('ByteStash publication failed: ETIMEDOUT');
      }
    });

    it('defensively scrubs the api key from server error responses echoing the key', async () => {
      const mockRequest: ByteStashRequestFn = async () => ({
        status: 500,
        body: `Server error: reject token "${validKey}" due to permissions`,
      });

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason.includes(validKey)).toBe(false);
        expect(result.reason).toContain('[REDACTED]');
      }
    });

    it('truncates response body beyond 200 chars in failure reason', async () => {
      const hugeBody = 'E'.repeat(500);
      const mockRequest: ByteStashRequestFn = async () => ({
        status: 502,
        body: hugeBody,
      });

      const publisher = createByteStashShelfPublisher({
        baseUrl: 'https://stash.example.com',
        keyFile: keyFilePath,
        author: 'alice',
        request: mockRequest,
      });

      const result = await publisher({ entry: makeTestEntry() });
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason.length).toBeLessThan(300);
        expect(result.reason).not.toContain(hugeBody);
        expect(result.reason).toContain('E'.repeat(200));
      }
    });
  });

  describe('KeeperPublicationAdapter fallbackToShelfFile', () => {
    it('appends entry to keepers-shelf.json and updates reason when publish fails and fallback is on', async () => {
      const adapter = new KeeperPublicationAdapter({
        publish: async () => ({ outcome: 'failed', reason: 'upstream ByteStash down' }),
        stateDir: tempDir,
        fallbackToShelfFile: true,
      });

      const entry = makeTestEntry({ id: 'fallback-entry-1' });
      const result = await adapter.publishKeeperToShelf({ entry });

      expect(result).toEqual({
        outcome: 'failed',
        reason: 'upstream ByteStash down; kept in keepers-shelf.json for reconciliation',
      });

      const shelfPath = join(tempDir, 'keepers-shelf.json');
      const content = await readFile(shelfPath, 'utf8');
      const saved = JSON.parse(content);
      expect(saved).toEqual([entry]);
    });

    it('does not write to shelf file when publish fails and fallback is off', async () => {
      const adapter = new KeeperPublicationAdapter({
        publish: async () => ({ outcome: 'failed', reason: 'upstream ByteStash down' }),
        stateDir: tempDir,
        fallbackToShelfFile: false,
      });

      const entry = makeTestEntry({ id: 'no-fallback-entry' });
      const result = await adapter.publishKeeperToShelf({ entry });

      expect(result).toEqual({
        outcome: 'failed',
        reason: 'upstream ByteStash down',
      });

      const shelfPath = join(tempDir, 'keepers-shelf.json');
      await expect(readFile(shelfPath)).rejects.toThrow();
    });

    it('does not throw when publish throws, returning failed and appending to shelf when fallback is on', async () => {
      const adapter = new KeeperPublicationAdapter({
        publish: async () => {
          throw new Error('network crash');
        },
        stateDir: tempDir,
        fallbackToShelfFile: true,
      });

      const entry = makeTestEntry({ id: 'throw-entry-with-fallback' });
      const result = await adapter.publishKeeperToShelf({ entry });

      expect(result).toEqual({
        outcome: 'failed',
        reason: 'network crash; kept in keepers-shelf.json for reconciliation',
      });

      const shelfPath = join(tempDir, 'keepers-shelf.json');
      const content = await readFile(shelfPath, 'utf8');
      const saved = JSON.parse(content);
      expect(saved).toEqual([entry]);
    });

    it('does not throw when publish throws and fallback is off', async () => {
      const adapter = new KeeperPublicationAdapter({
        publish: async () => {
          throw new Error('network crash');
        },
        stateDir: tempDir,
        fallbackToShelfFile: false,
      });

      const entry = makeTestEntry({ id: 'throw-entry-no-fallback' });
      const result = await adapter.publishKeeperToShelf({ entry });

      expect(result).toEqual({
        outcome: 'failed',
        reason: 'network crash',
      });

      const shelfPath = join(tempDir, 'keepers-shelf.json');
      await expect(readFile(shelfPath)).rejects.toThrow();
    });
  });
});
