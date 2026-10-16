/**
 * ByteStashShelfTransport: create-only publisher for keeper entries to ByteStash.
 * Checks key file permissions and format, validates author and https baseUrl,
 * refuses keeper entries matching secret patterns before any network call,
 * scrubs the API key from all errors, and maps 2xx responses to published results.
 */

import https from 'node:https';
import { lstat, readFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
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
        reason: `Invalid ByteStash baseUrl: ${options.baseUrl}`,
      };
    }

    if (parsedBase.protocol !== 'https:') {
      return {
        outcome: 'failed',
        reason: `ByteStash baseUrl must use https: ${options.baseUrl}`,
      };
    }

    if (typeof entry.claimText === 'string') {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(entry.claimText)) {
          return {
            outcome: 'failed',
            reason: 'keeper text matches a secret pattern; not published',
          };
        }
      }
    }

    let stat: Stats;
    try {
      stat = await lstat(options.keyFile);
    } catch (error) {
      return {
        outcome: 'failed',
        reason: `ByteStash key file inaccessible at ${options.keyFile}: ${errorMessage(error)}`,
      };
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
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

    let rawKey: string;
    try {
      rawKey = await readFile(options.keyFile, 'utf8');
    } catch (error) {
      return {
        outcome: 'failed',
        reason: `ByteStash key file unreadable at ${options.keyFile}: ${errorMessage(error)}`,
      };
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
      const rawReason = `ByteStash publication failed: ${codeOrMessage}`;
      return {
        outcome: 'failed',
        reason: scrubKey(rawReason, apiKey),
      };
    }

    if (response.status < 200 || response.status >= 300) {
      const bodySnippet = truncateAndFormatBody(response.body);
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
      const bodySnippet = truncateAndFormatBody(response.body);
      const rawReason = `ByteStash publication failed: HTTP ${response.status} (invalid JSON)${bodySnippet}`;
      return {
        outcome: 'failed',
        reason: scrubKey(rawReason, apiKey),
      };
    }

    if (!isValidSnippetResponse(parsed)) {
      const bodySnippet = truncateAndFormatBody(response.body);
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

function truncateAndFormatBody(rawBody: string | undefined): string {
  if (!rawBody) return '';
  const trimmed = rawBody.trim();
  if (!trimmed) return '';
  const slice = trimmed.slice(0, 200);
  return ` - ${slice}`;
}

function scrubKey(text: string, key?: string): string {
  if (!key) return text;
  return text.split(key).join('[REDACTED]');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
