/**
 * WavesHttpClient: small HTTPS client for communicating with Waves.
 * Validates https baseUrl (no redirects), reads token with strict file mode (0600)
 * and O_NOFOLLOW like ByteStash, sends Authorization: Bearer, and scrubs the token
 * from all reasons and response bodies. Supports optional caFile and timeoutMs,
 * with a pluggable request seam for testing.
 *
 * The default transport always settles: request errors, response stream errors
 * and aborts reject, a total deadline (default 15000ms) cancels the request, and
 * response bodies beyond 1 MiB are refused instead of buffered.
 */

import https from 'node:https';
import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type WavesRequestFn = (
  url: URL,
  init: {
    method: 'GET' | 'PUT' | 'POST';
    headers: Record<string, string>;
    body?: string;
    ca?: string;
    timeoutMs: number;
  },
) => Promise<{ status: number; body: string }>;

export interface WavesHttpClientOptions {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly caFile?: string;
  readonly timeoutMs?: number;
  readonly request?: WavesRequestFn;
}

export interface WavesHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** Total time a request may take from dispatch to a settled response. */
const WAVES_TOTAL_DEADLINE_MS = 15000;
/** Response bodies at or beyond this size are refused, never buffered. */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

export const defaultWavesRequest: WavesRequestFn = (url, init) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };

    const resolveOnce = (value: { status: number; body: string }): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      resolve(value);
    };

    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearDeadline();
      reject(error);
    };

    const req = https.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        ca: init.ca,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_RESPONSE_BODY_BYTES) {
            const error = Object.assign(
              new Error(`Waves response body exceeded ${MAX_RESPONSE_BODY_BYTES} bytes`),
              { code: 'ERR_BODY_TOO_LARGE' },
            );
            rejectOnce(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolveOnce({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        // A response stream that fails mid-body must reject, never hang.
        res.on('error', (error: Error) => {
          if (settled) return;
          rejectOnce(error);
          req.destroy(error);
        });
        // A response that is aborted before 'end' must reject, never hang.
        res.on('aborted', () => {
          if (settled) return;
          rejectOnce(
            Object.assign(new Error('Waves response was aborted before completion'), {
              code: 'ECONNRESET',
            }),
          );
          req.destroy();
        });
      },
    );

    req.on('error', (error) => {
      rejectOnce(error);
    });

    const deadlineMs = init.timeoutMs > 0 ? init.timeoutMs : WAVES_TOTAL_DEADLINE_MS;
    deadlineTimer = setTimeout(() => {
      const error = Object.assign(new Error(`Request timed out after ${deadlineMs}ms`), {
        code: 'ETIMEDOUT',
      });
      rejectOnce(error);
      req.destroy(error);
    }, deadlineMs);

    if (init.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
};

const REDACTED_MARKER = '[REDACTED]';

export function scrubToken(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join(REDACTED_MARKER);
}

export function truncatePreservingRedacted(text: string, limit = 200): string {
  if (text.length <= limit) {
    return text;
  }
  const start = Math.max(0, limit - REDACTED_MARKER.length + 1);
  for (let i = start; i < limit; i++) {
    if (text.startsWith(REDACTED_MARKER, i)) {
      return text.slice(0, i + REDACTED_MARKER.length);
    }
  }
  return text.slice(0, limit);
}

export function scrubAndTruncate(raw: string | undefined, token?: string): string {
  if (!raw) return '';
  const scrubbed = scrubToken(raw, token).trim();
  if (!scrubbed) return '';
  return truncatePreservingRedacted(scrubbed, 200);
}

function isEloop(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ELOOP'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WavesHttpClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly caFile?: string;
  private readonly timeoutMs: number;
  private readonly requestFn: WavesRequestFn;
  private lastToken?: string;

  constructor(options: WavesHttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.tokenFile = options.tokenFile;
    this.caFile = options.caFile;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.requestFn = options.request ?? defaultWavesRequest;
  }

  /**
   * Scrubs the currently loaded token out of `text`. The loaded token itself is
   * never readable through this client; this is the only token-related surface
   * callers get, so no failure reason or body snippet can carry it.
   */
  scrub(text: string): string {
    return scrubToken(text, this.lastToken);
  }

  async get(path: string): Promise<WavesHttpResponse> {
    return this.request(path, { method: 'GET' });
  }

  async put(path: string, body?: string | unknown): Promise<WavesHttpResponse> {
    const stringBody =
      typeof body === 'string'
        ? body
        : body !== undefined
          ? JSON.stringify(body)
          : undefined;
    return this.request(path, { method: 'PUT', body: stringBody });
  }

  async request(
    path: string,
    init: {
      method: 'GET' | 'PUT' | 'POST';
      body?: string;
    },
  ): Promise<WavesHttpResponse> {
    let parsedBase: URL;
    try {
      parsedBase = new URL(this.baseUrl);
    } catch {
      throw new Error('Invalid Waves baseUrl');
    }

    if (parsedBase.protocol !== 'https:') {
      throw new Error(`Waves baseUrl must use https: ${parsedBase.origin}`);
    }

    const token = await this.readToken();
    this.lastToken = token;

    let ca: string | undefined;
    if (this.caFile) {
      try {
        ca = await readFile(this.caFile, 'utf8');
      } catch (error) {
        throw new Error(
          scrubToken(
            `Waves CA file unreadable at ${this.caFile}: ${errorMessage(error)}`,
            token,
          ),
        );
      }
    }

    const basePath = parsedBase.pathname.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const endpointUrl = new URL(`${basePath}${cleanPath}`, parsedBase.origin);

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    try {
      const response = await this.requestFn(endpointUrl, {
        method: init.method,
        headers,
        body: init.body,
        ca,
        timeoutMs: this.timeoutMs,
      });

      return {
        status: response.status,
        body: scrubToken(response.body, token),
      };
    } catch (error) {
      const codeOrMessage =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : errorMessage(error);
      const scrubbed = scrubToken(codeOrMessage, token).trim();
      const truncated = truncatePreservingRedacted(scrubbed, 200);
      throw new Error(`Waves request failed: ${truncated}`);
    }
  }

  private async readToken(): Promise<string> {
    let handle: FileHandle;
    try {
      handle = await open(this.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isEloop(error)) {
        throw new Error(
          `Waves token file at ${this.tokenFile} must be a regular file, not a symlink`,
        );
      }
      throw new Error(
        `Waves token file inaccessible at ${this.tokenFile}: ${errorMessage(error)}`,
      );
    }

    let rawToken: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(
          `Waves token file at ${this.tokenFile} must be a regular file, not a symlink`,
        );
      }

      if ((stat.mode & 0o077) !== 0) {
        throw new Error(
          `Waves token file at ${this.tokenFile} has invalid mode 0o${(stat.mode & 0o777).toString(8)}; group and other permissions must be 0`,
        );
      }

      rawToken = await handle.readFile('utf8');
    } catch (error) {
      throw new Error(
        `Waves token file unreadable at ${this.tokenFile}: ${errorMessage(error)}`,
      );
    } finally {
      await handle.close();
    }

    const firstLine = rawToken.split(/\r?\n/)[0]?.trim() ?? '';
    if (firstLine.length === 0) {
      throw new Error(`Waves token file at ${this.tokenFile} is empty`);
    }

    if (!/^[A-Za-z0-9._-]+$/.test(firstLine)) {
      throw new Error(
        `Waves token file at ${this.tokenFile} contains invalid characters; must match ^[A-Za-z0-9._-]+$`,
      );
    }

    return firstLine;
  }
}
