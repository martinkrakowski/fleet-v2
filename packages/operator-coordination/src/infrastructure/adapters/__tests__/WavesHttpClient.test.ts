import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WavesHttpClient,
  type WavesRequestFn,
} from '../WavesHttpClient.adapter.js';

describe('WavesHttpClient', () => {
  let tempDir: string;
  let tokenFilePath: string;
  const validToken = 'waves-test-token_xyz-9876';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fleet-waves-test-'));
    tokenFilePath = join(tempDir, 'valid.token');
    await writeFile(tokenFilePath, `${validToken}\n`, 'utf8');
    await chmod(tokenFilePath, 0o600);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('executes GET request with exact URL, headers, and Bearer token isolation', async () => {
      let calledUrl: URL | undefined;
      let calledInit: Parameters<WavesRequestFn>[1] | undefined;

      const mockRequest: WavesRequestFn = async (url, init) => {
        calledUrl = url;
        calledInit = init;
        return {
          status: 200,
          body: JSON.stringify({ ok: true }),
        };
      };

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.midnight.lan:8443',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      const response = await client.get('/api/v1/attention');

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });

      expect(calledUrl).toBeDefined();
      expect(calledUrl?.href).toBe('https://waves.midnight.lan:8443/api/v1/attention');

      expect(calledInit).toBeDefined();
      expect(calledInit?.method).toBe('GET');
      expect(calledInit?.timeoutMs).toBe(15000);
      expect(calledInit?.headers['authorization']).toBe(`Bearer ${validToken}`);
      expect(calledInit?.headers['accept']).toBe('application/json');
      expect(calledInit?.headers['content-type']).toBeUndefined();

      // Token isolation:
      expect(calledUrl!.href.includes(validToken)).toBe(false);
      for (const [headerName, headerVal] of Object.entries(calledInit!.headers)) {
        if (headerName !== 'authorization') {
          expect(headerVal.includes(validToken)).toBe(false);
        }
      }
    });

    it('executes PUT request with Content-Type and serialized body', async () => {
      let calledInit: Parameters<WavesRequestFn>[1] | undefined;

      const mockRequest: WavesRequestFn = async (_url, init) => {
        calledInit = init;
        return {
          status: 201,
          body: JSON.stringify({ id: 'obs-1' }),
        };
      };

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      const payload = { observationId: 'obs-1', value: 42 };
      const response = await client.put('/api/v1/observations/obs-1', payload);

      expect(response.status).toBe(201);
      expect(calledInit?.method).toBe('PUT');
      expect(calledInit?.headers['content-type']).toBe('application/json');
      expect(calledInit?.headers['authorization']).toBe(`Bearer ${validToken}`);
      expect(calledInit?.body).toBe(JSON.stringify(payload));
    });

    it('reads ca from caFile and passes ca to request', async () => {
      const caFilePath = join(tempDir, 'waves-ca.pem');
      const caContent = '-----BEGIN CERTIFICATE-----\nFAKECA...\n-----END CERTIFICATE-----';
      await writeFile(caFilePath, caContent, 'utf8');

      let receivedCa: string | undefined;
      const mockRequest: WavesRequestFn = async (_url, init) => {
        receivedCa = init.ca;
        return { status: 200, body: '{}' };
      };

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: tokenFilePath,
        caFile: caFilePath,
        timeoutMs: 8000,
        request: mockRequest,
      });

      await client.get('/api/v1/projects');
      expect(receivedCa).toBe(caContent);
    });
  });

  describe('token file security checks', () => {
    it('fails when token file is missing, error contains path and not token', async () => {
      const missingPath = join(tempDir, 'absent.token');
      const mockRequest = vi.fn<WavesRequestFn>();

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: missingPath,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow(missingPath);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when token file is a symlink via O_NOFOLLOW without reading target secret', async () => {
      const targetSecretPath = join(tempDir, 'target-secret.token');
      const targetSecret = 'sensitive-target-token-never-read';
      await writeFile(targetSecretPath, `${targetSecret}\n`, 'utf8');
      await chmod(targetSecretPath, 0o600);

      const symlinkPath = join(tempDir, 'symlink.token');
      await symlink(targetSecretPath, symlinkPath);
      const mockRequest = vi.fn<WavesRequestFn>();

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: symlinkPath,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow(
        'must be a regular file, not a symlink',
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when token file has mode 0644, error contains path and mode', async () => {
      const mode644Path = join(tempDir, 'mode644.token');
      const secret = 'secret-mode-644-token';
      await writeFile(mode644Path, `${secret}\n`, 'utf8');
      await chmod(mode644Path, 0o644);
      const mockRequest = vi.fn<WavesRequestFn>();

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: mode644Path,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow(
        'group and other permissions must be 0',
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when token file is empty', async () => {
      const emptyPath = join(tempDir, 'empty.token');
      await writeFile(emptyPath, '   \n  \n', 'utf8');
      await chmod(emptyPath, 0o600);
      const mockRequest = vi.fn<WavesRequestFn>();

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: emptyPath,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow('is empty');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('fails when token file contains invalid characters, without printing token', async () => {
      const badCharsPath = join(tempDir, 'badchars.token');
      const badToken = 'my secret token with spaces!';
      await writeFile(badCharsPath, `${badToken}\n`, 'utf8');
      await chmod(badCharsPath, 0o600);
      const mockRequest = vi.fn<WavesRequestFn>();

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: badCharsPath,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow('contains invalid characters');
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('baseUrl validation and credential redaction', () => {
    it('refuses http baseUrl and never calls request', async () => {
      const mockRequest = vi.fn<WavesRequestFn>();
      const client = new WavesHttpClient({
        baseUrl: 'http://insecure-waves.local',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow(
        'Waves baseUrl must use https: http://insecure-waves.local',
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('never echoes userinfo from baseUrl in failure reason, using parsed origin instead', async () => {
      const mockRequest = vi.fn<WavesRequestFn>();
      const client = new WavesHttpClient({
        baseUrl: 'http://admin:secret-password@insecure-waves.example.com:8443/subpath',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      try {
        await client.get('/api/v1/attention');
        expect.unreachable('should have thrown');
      } catch (error) {
        const msg = (error as Error).message;
        expect(msg).toBe('Waves baseUrl must use https: http://insecure-waves.example.com:8443');
        expect(msg).not.toContain('admin');
        expect(msg).not.toContain('secret-password');
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('never echoes raw baseUrl when baseUrl is invalid URL with userinfo', async () => {
      const mockRequest = vi.fn<WavesRequestFn>();
      const client = new WavesHttpClient({
        baseUrl: 'http://[invalid-host-with-credentials:pass',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      try {
        await client.get('/api/v1/attention');
        expect.unreachable('should have thrown');
      } catch (error) {
        const msg = (error as Error).message;
        expect(msg).toBe('Invalid Waves baseUrl');
        expect(msg).not.toContain('pass');
      }
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('defensive token scrubbing and error handling', () => {
    it('scrubs token from server response body echoing the bearer token', async () => {
      const mockRequest: WavesRequestFn = async () => ({
        status: 401,
        body: `Token error: reject bearer "${validToken}" - unauthorized`,
      });

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      const response = await client.get('/api/v1/attention');
      expect(response.status).toBe(401);
      expect(response.body).not.toContain(validToken);
      expect(response.body).toContain('[REDACTED]');
    });

    it('handles request throwing ETIMEDOUT and reports scrubbed error code', async () => {
      const mockRequest: WavesRequestFn = async () => {
        const err = Object.assign(new Error(`Timed out for token ${validToken}`), {
          code: 'ETIMEDOUT',
        });
        throw err;
      };

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      await expect(client.get('/api/v1/attention')).rejects.toThrow(
        'Waves request failed: ETIMEDOUT',
      );
    });

    it('scrubs token before truncating when token straddles character 200 in thrown error', async () => {
      const prefix = 'X'.repeat(192);
      const straddlingError = `${prefix}${validToken}-more-details-about-the-error`;

      const mockRequest: WavesRequestFn = async () => {
        throw new Error(straddlingError);
      };

      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: tokenFilePath,
        request: mockRequest,
      });

      try {
        await client.get('/api/v1/attention');
        expect.unreachable('should have thrown');
      } catch (error) {
        const msg = (error as Error).message;
        const first8 = validToken.slice(0, 8);
        expect(msg).not.toContain(first8);
        expect(msg).not.toContain(validToken);
        expect(msg).toContain('[REDACTED]');
      }
    });
  });
});
