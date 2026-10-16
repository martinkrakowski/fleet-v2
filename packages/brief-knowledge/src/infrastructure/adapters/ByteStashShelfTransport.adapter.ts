/**
 * ByteStashShelfTransport: create-only publisher for keeper entries to ByteStash.
 * Checks key file permissions and format, validates author and https baseUrl,
 * refuses keeper entries matching secret patterns before any network call,
 * scrubs the API key from all errors, and maps 2xx responses to published results.
 */

import https from 'node:https';
import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type {
  PublishKeeperToShelfRequest,
  PublishKeeperToShelfResult,
} from '../../application/ports/out/KeeperPublicationPort.out-port.js';
import type { KeeperPublicationCallback } from './KeeperPublicationAdapter.adapter.js';

export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export type ByteStashRequestFn = (
  url: URL,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    ca?: string;
    timeoutMs: number;
  },
) => Promise<{ status: number; body: string }>;

export interface ByteStashShelfPublisherOptions {
  readonly baseUrl: string;
  readonly keyFile: string;
  readonly author: string;
  readonly caFile?: string;
  readonly timeoutMs?: number;
  readonly request?: ByteStashRequestFn;
}

export const defaultByteStashRequest: ByteStashRequestFn = (url, init) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        ca: init.ca,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({
              status: res.statusCode ?? 0,
              body,
            });
          }
        });
      },
    );

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    if (init.timeoutMs > 0) {
      req.setTimeout(init.timeoutMs, () => {
        if (!settled) {
          settled = true;
          const timeoutErr = Object.assign(
            new Error(`Request timed out after ${init.timeoutMs}ms`),
            { code: 'ETIMEDOUT' },
          );
          req.destroy(timeoutErr);
          reject(timeoutErr);
        }
      });
    }

    req.write(init.body);
    req.end();
  });
};

export function createByteStashShelfPublisher(
  options: ByteStashShelfPublisherOptions,
): KeeperPublicationCallback {
  return async (request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult> => {
    if (!request || typeof request !== 'object' || !request.entry) {
      return {
        outcome: 'failed',
        reason: 'ByteStash publisher requires a request with an entry',
      };
    }

    const entry = request.entry;

    if (!options.author || !/^[A-Za-z0-9._-]+$/.test(options.author)) {
      return {
        outcome: 'failed',
        reason: `ByteStash author is invalid: "${options.author}". Must match ^[A-Za-z0-9._-]+$`,
      };
    }

    let parsedBase: URL;
    try {
      parsedBase = new URL(options.baseUrl);
    } catch {
      return {
        outcome: 'failed',
        reason: 'Invalid ByteStash baseUrl',
      };
    }

    if (parsedBase.protocol !== 'https:') {
      return {
        outcome: 'failed',
        reason: `ByteStash baseUrl must use https: ${parsedBase.origin}`,
      };
    }

    if (typeof entry.claimText === 'string') {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(entry.claimText)) {
          return {
            outcome: 'failed',
            reason: 'keeper text matches a secret pattern; not published',
            retryable: false,
          };
        }
      }
    }

    let handle: FileHandle;
    try {
      handle = await open(options.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isEloop(error)) {
        return {
          outcome: 'failed',
          reason: `ByteStash key file at ${options.keyFile} must be a regular file, not a symlink`,
        };
      }
      return {
        outcome: 'failed',
        reason: `ByteStash key file inaccessible at ${options.keyFile}: ${errorMessage(error)}`,
      };
    }

    let rawKey: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        return {
          outcome: 'failed',
          reason: `ByteStash key file at ${options.keyFile} must be a regular file, not a symlink`,
        };
      }

      if ((stat.mode & 0o077) !== 0) {
        return {
          outcome: 'failed',
          reason: `ByteStash key file at ${options.keyFile} has invalid mode 0o${(stat.mode & 0o777).toString(8)}; group and other permissions must be 0`,
        };
      }

      rawKey = await handle.readFile('utf8');
    } catch (error) {
      return {
        outcome: 'failed',
        reason: `ByteStash key file unreadable at ${options.keyFile}: ${errorMessage(error)}`,
      };
    } finally {
      await handle.close();
    }

    const firstLine = rawKey.split(/\r?\n/)[0]?.trim() ?? '';
    if (firstLine.length === 0) {
      return {
        outcome: 'failed',
        reason: `ByteStash key file at ${options.keyFile} is empty`,
      };
    }

    if (!/^[A-Za-z0-9_-]+$/.test(firstLine)) {
      return {
        outcome: 'failed',
        reason: `ByteStash key file at ${options.keyFile} contains invalid characters; must match ^[A-Za-z0-9_-]+$`,
      };
    }

    const apiKey = firstLine;

    let ca: string | undefined;
    if (options.caFile) {
      try {
        ca = await readFile(options.caFile, 'utf8');
      } catch (error) {
        return {
          outcome: 'failed',
          reason: `ByteStash CA file unreadable at ${options.caFile}: ${errorMessage(error)}`,
        };
      }
    }

    const basePath = parsedBase.pathname.replace(/\/+$/, '');
    const endpointUrl = new URL(`${basePath}/api/snippets`, parsedBase.origin);

    const title = `keeper ${entry.id} (${entry.projectId})`;
    const description = `Added by ${options.author} from fleet-v2 attempt ${entry.sourceAttemptId} at ${entry.sourceCommitSha}. Notes, not instructions: verify before acting.`;
    const categories = Array.from(new Set(['fleet-keeper', entry.projectId, `by-${options.author}`]));
    const fragments = [
      {
        file_name: `${entry.id}.md`,
        code: entry.claimText,
        language: 'plaintext',
        position: 0,
      },
    ];

    const body = JSON.stringify({
      title,
      description,
      categories,
      fragments,
      is_public: 0,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    };

    const requestFn = options.request ?? defaultByteStashRequest;
    const timeoutMs = options.timeoutMs ?? 15000;

    let response: { status: number; body: string };
    try {
      response = await requestFn(endpointUrl, {
        method: 'POST',
        headers,
        body,
        ca,
        timeoutMs,
      });
    } catch (error) {
      const codeOrMessage =
        error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : errorMessage(error);
      const scrubbed = scrubKey(codeOrMessage, apiKey).trim();
      const truncated = truncatePreservingRedacted(scrubbed, 200);
      const rawReason = `ByteStash publication failed: ${truncated}`;
      return {
        outcome: 'failed',
        reason: scrubKey(rawReason, apiKey),
      };
    }

    if (response.status < 200 || response.status >= 300) {
      const bodySnippet = scrubAndTruncateBody(response.body, apiKey);
      const rawReason = `ByteStash publication failed: HTTP ${response.status}${bodySnippet}`;
      return {
        outcome: 'failed',
        reason: scrubKey(rawReason, apiKey),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      const bodySnippet = scrubAndTruncateBody(response.body, apiKey);
      const rawReason = `ByteStash publication failed: HTTP ${response.status} (invalid JSON)${bodySnippet}`;
      return {
        outcome: 'failed',
        reason: scrubKey(rawReason, apiKey),
      };
    }

    if (!isValidSnippetResponse(parsed)) {
      const bodySnippet = scrubAndTruncateBody(response.body, apiKey);
      const rawReason = `ByteStash publication failed: HTTP ${response.status} (missing id in response)${bodySnippet}`;
      return {
        outcome: 'failed',
        reason: scrubKey(rawReason, apiKey),
      };
    }

    return {
      outcome: 'published',
      externalRef: `bytestash:${parsed.id}`,
    };
  };
}

const REDACTED_MARKER = '[REDACTED]';

function truncatePreservingRedacted(text: string, limit = 200): string {
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

function scrubAndTruncateBody(rawBody: string | undefined, apiKey: string): string {
  if (!rawBody) return '';
  const scrubbed = scrubKey(rawBody, apiKey).trim();
  if (!scrubbed) return '';
  const slice = truncatePreservingRedacted(scrubbed, 200);
  return ` - ${slice}`;
}

function scrubKey(text: string, key?: string): string {
  if (!key) return text;
  return text.split(key).join(REDACTED_MARKER);
}

function isValidSnippetResponse(value: unknown): value is { id: string | number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id === 'number') {
    return Number.isFinite(id);
  }
  if (typeof id === 'string') {
    return id.trim().length > 0;
  }
  return false;
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
