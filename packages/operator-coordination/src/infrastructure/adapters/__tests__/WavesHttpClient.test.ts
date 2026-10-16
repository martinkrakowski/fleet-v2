import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import {
  WavesHttpClient,
  defaultWavesRequest,
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

  describe('scrub replaces the token getter', () => {
    it('scrubs the loaded token from text and exposes no way to read it back', async () => {
      const client = new WavesHttpClient({
        baseUrl: 'https://waves.internal',
        tokenFile: tokenFilePath,
        request: async () => ({ status: 200, body: '{}' }),
      });

      // Before any request no token is loaded, so scrub changes nothing.
      const before = `failure mentioning ${validToken}`;
      expect(client.scrub(before)).toBe(before);

      await client.get('/api/v1/attention');

      const scrubbed = client.scrub(`failure mentioning ${validToken}`);
      expect(scrubbed).not.toContain(validToken);
      expect(scrubbed).toContain('[REDACTED]');
      expect(scrubbed).not.toContain(validToken.slice(0, 8));

      // The token cannot be read back out of the client.
      const clientAsRecord = client as unknown as Record<string, unknown>;
      expect(clientAsRecord.getLoadedToken).toBeUndefined();
      expect(typeof clientAsRecord.scrub).toBe('function');
    });
  });

  describe('defaultWavesRequest transport safety', () => {
    const MIB = 1024 * 1024;

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    function installFakeHttps(statusCode = 200): {
      req: EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      res: EventEmitter & { statusCode: number };
    } {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      });
      const res = Object.assign(new EventEmitter(), { statusCode });
      vi.spyOn(https, 'request').mockImplementation(
        ((...args: unknown[]) => {
          const callback = args[args.length - 1] as (response: unknown) => void;
          callback(res);
          return req;
        }) as unknown as typeof https.request,
      );
      return { req, res };
    }

    function request(timeoutMs = 15000): Promise<{ status: number; body: string }> {
      return defaultWavesRequest(new URL('https://waves.internal/api/v1/attention'), {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeoutMs,
      });
    }

    it('resolves a complete response from buffered chunks', async () => {
      const { req, res } = installFakeHttps(200);

      const promise = request();
      res.emit('data', Buffer.from('{"ok":'));
      res.emit('data', Buffer.from('true}'));
      res.emit('end');

      await expect(promise).resolves.toEqual({ status: 200, body: '{"ok":true}' });
      expect(req.destroy).not.toHaveBeenCalled();
    });

    it('rejects when the response stream errors mid-body', async () => {
      const { req, res } = installFakeHttps(200);

      const promise = request();
      res.emit('data', Buffer.from('{"partial":'));
      res.emit('error', new Error('socket hang up mid-body'));

      await expect(promise).rejects.toThrow('socket hang up mid-body');
      expect(req.destroy).toHaveBeenCalled();
    });

    it('rejects when the response is aborted before completion', async () => {
      const { req, res } = installFakeHttps(200);

      const promise = request();
      res.emit('data', Buffer.from('{"partial":'));
      res.emit('aborted');

      await expect(promise).rejects.toThrow('Waves response was aborted before completion');
      expect(req.destroy).toHaveBeenCalled();
    });

    it('rejects a response body larger than 1 MiB', async () => {
      const { req, res } = installFakeHttps(200);

      const promise = request();
      res.emit('data', Buffer.alloc(MIB));
      res.emit('data', Buffer.alloc(1));

      await expect(promise).rejects.toThrow('Waves response body exceeded 1048576 bytes');
      expect(req.destroy).toHaveBeenCalled();
    });

    it('accepts a response body of exactly 1 MiB', async () => {
      const { res } = installFakeHttps(200);

      const promise = request();
      res.emit('data', Buffer.alloc(MIB));
      res.emit('end');

      await expect(promise).resolves.toMatchObject({ status: 200 });
    });

    it('rejects when the request itself errors before a response', async () => {
      const { req } = installFakeHttps(200);

      const promise = request();
      const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      req.emit('error', error);

      await expect(promise).rejects.toThrow('connect ECONNREFUSED');
    });

    it('settles once even if the stream errors after end', async () => {
      const { res } = installFakeHttps(200);

      const promise = request();
      res.emit('data', Buffer.from('{"ok":true}'));
      res.emit('end');
      res.emit('error', new Error('late error after end'));

      await expect(promise).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    });

    it('cancels the request and rejects when the total deadline passes', async () => {
      const { req } = installFakeHttps(200);

      const promise = request(50);
      await expect(promise).rejects.toThrow('Request timed out after 50ms');
      expect(req.destroy).toHaveBeenCalled();
    });

    it('applies the 15000ms total deadline by default when timeoutMs is not positive', async () => {
      vi.useFakeTimers();
      installFakeHttps(200);

      const promise = request(0);
      const assertion = expect(promise).rejects.toThrow('Request timed out after 15000ms');
      await vi.advanceTimersByTimeAsync(15000);
      await assertion;
    });
  });
});
