/**
 * The conductor's change-feed wake reader (K9): it opens the API's chunked
 * `GET /v1/changes` stream (E3b) with the `read` scope (T3a) and turns each
 * JSON-lines signal into a "something changed" wake-up that ends the driver's
 * between-passes sleep; a signal only says something changed and never carries
 * state. The reader never throws into the driver, and its bearer comes from
 * the operator-supplied `FLEET_CONDUCTOR_WAKE_TOKEN_FILE`, never the API's
 * shared bearer (D9).
 */

import { lstatSync, readFileSync } from 'node:fs';

export interface WakeSignal {
  readonly kind: string;
  readonly seq: number;
}

/**
 * Parse one JSON-lines wake line. Returns null for a keep-alive blank line, an
 * unparseable line, or a line without a numeric `seq` and a string `kind`; a
 * `resync` line parses like any other line.
 */
export function parseWakeSignal(line: string): WakeSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as { readonly seq?: unknown; readonly kind?: unknown };
  if (typeof record.seq !== 'number' || typeof record.kind !== 'string') {
    return null;
  }
  return { kind: record.kind, seq: record.seq };
}

export interface ChangeWakeReader {
  /**
   * Resolves `true` when a change signal is pending, `false` when the stream
   * ended, the fetch failed, or `abort` fired. Never throws and never rejects.
   */
  waitForSignal(abort: AbortSignal): Promise<boolean>;
  /** Aborts the fetch, cancels the stream and resolves pending waits with false; idempotent. */
  close(): void;
}

/**
 * Read the wake token from a file, with the same checks as
 * `readApiTokenFromFile` in apps/mcp/src/client.ts (copied, not imported —
 * apps/cli and apps/mcp are separate composition roots). The file must be an
 * absolute path to a regular file (not a symlink) with no group/other
 * permission bits; the token is the first line, trimmed, at least 32
 * characters long and composed only of `A-Z a-z 0-9 _ -`. Returns null on any
 * failure.
 */
export function readWakeToken(filePath: string): string | null {
  if (
    !filePath ||
    typeof filePath !== 'string' ||
    filePath.trim().length === 0 ||
    !filePath.startsWith('/')
  ) {
    return null;
  }
  try {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    // Must have no group/other mode bits: (mode & 0o077) === 0
    if ((stats.mode & 0o077) !== 0) {
      return null;
    }
    const content = readFileSync(filePath, 'utf8');
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? '';
    if (!/^[A-Za-z0-9_-]{32,}$/.test(firstLine)) {
      return null;
    }
    return firstLine;
  } catch {
    return null;
  }
}

/** Loopback hosts accepted for plain-HTTP wake URLs (which also need an explicit port). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Validate and normalize the wake feed base URL. It must parse as a URL with
 * no credentials, no path beyond `/`, no query and no fragment. Plain HTTP is
 * accepted only for a loopback host with an explicit port; HTTPS is accepted
 * for any host; every other scheme is refused. The trailing slash is stripped.
 */
export function normalizeWakeBaseUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return null;
  }
  if (url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.protocol === 'http:') {
    if (url.port === '' || !LOOPBACK_HOSTS.has(url.hostname)) {
      return null;
    }
  } else if (url.protocol !== 'https:') {
    return null;
  }
  return raw.replace(/\/$/, '');
}

export const WAKE_BASE_URL_ENV = 'FLEET_API_URL';
export const WAKE_TOKEN_FILE_ENV = 'FLEET_CONDUCTOR_WAKE_TOKEN_FILE';

/**
 * Resolve the wake reader's configuration from the process environment. It is
 * null unless both `FLEET_API_URL` and `FLEET_CONDUCTOR_WAKE_TOKEN_FILE` are
 * set, non-empty and valid. It never reads `FLEET_API_TOKEN_FILE`: the driver
 * process holds forge credentials, so it must never present the API's shared
 * bearer (D9).
 */
export function resolveWakeConfig(
  env: NodeJS.ProcessEnv,
): { readonly baseUrl: string; readonly token: string } | null {
  const rawBase = env[WAKE_BASE_URL_ENV];
  const rawTokenFile = env[WAKE_TOKEN_FILE_ENV];
  if (
    rawBase === undefined ||
    rawTokenFile === undefined ||
    rawBase.trim().length === 0 ||
    rawTokenFile.trim().length === 0
  ) {
    return null;
  }
  const baseUrl = normalizeWakeBaseUrl(rawBase);
  const token = readWakeToken(rawTokenFile);
  if (baseUrl === null || token === null) {
    return null;
  }
  return { baseUrl, token };
}

interface Waiter {
  readonly resolve: (value: boolean) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** The reader behind `openChangeWakeReader`; it never throws into the driver. */
class ChangeWakeReaderImpl implements ChangeWakeReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly fetchAbort: AbortController;
  private readonly waiters = new Set<Waiter>();
  private signal: WakeSignal | null = null;
  private state: 'open' | 'ended' | 'closed' = 'open';

  constructor(body: ReadableStream<Uint8Array>, fetchAbort: AbortController) {
    this.reader = body.getReader();
    this.fetchAbort = fetchAbort;
  }

  /** Starts the read loop (kept out of the constructor: no async work while constructing). */
  start(): void {
    void this.pump();
  }

  waitForSignal(abort: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (abort.aborted || this.state === 'closed') {
        resolve(false);
        return;
      }
      // One signal, one wake-up: a remembered signal is consumed here, even
      // when the stream has ended since it arrived.
      if (this.signal !== null) {
        this.signal = null;
        resolve(true);
        return;
      }
      if (this.state !== 'open') {
        resolve(false);
        return;
      }
      const removeWaiter = (): void => {
        for (const item of this.waiters) {
          if (item.resolve === resolve) {
            this.waiters.delete(item);
            return;
          }
        }
      };
      const waiter: Waiter = {
        resolve,
        signal: abort,
        onAbort: () => {
          removeWaiter();
          resolve(false);
        },
      };
      this.waiters.add(waiter);
      abort.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  close(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.fetchAbort.abort();
    // cancel() reports failure through its promise, never a synchronous throw
    void this.reader.cancel().catch(() => undefined);
    this.settleWaiters(false);
  }

  private settleWaiters(value: boolean): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(value);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return; // keep-alive
    }
    const parsed = parseWakeSignal(trimmed);
    if (parsed === null) {
      return;
    }
    this.handleSignal(parsed);
  }

  /** One accepted signal wakes every pending wait; with none pending it is remembered for the next wait. */
  private handleSignal(sig: WakeSignal): void {
    if (this.waiters.size > 0) {
      this.settleWaiters(true);
      return;
    }
    this.signal = sig;
  }

  private async pump(): Promise<void> {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) {
          break;
        }
        buffer += this.decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          this.handleLine(line);
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.length > 0) {
        this.handleLine(buffer);
      }
    } catch {
      // aborted or failed: the driver falls back to its back-off
    }
    if (this.state === 'open') {
      this.state = 'ended';
      this.settleWaiters(false);
    }
  }
}

/**
 * Open the change-feed reader. A rejected fetch, a non-200 status or a missing
 * body returns null so the driver keeps polling; otherwise it returns a reader
 * over the NDJSON stream. The request carries the `read`-scoped bearer from
 * the wake-token file — never the API's shared bearer (D9).
 */
export async function openChangeWakeReader(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * An external stop signal (the driver's); when it fires the fetch is
   * aborted, so a hung connection cannot keep the opener (and the run) alive
   * past an interrupt.
   */
  readonly signal?: AbortSignal;
}): Promise<ChangeWakeReader | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const fetchAbort = new AbortController();
  let onStopFetch: (() => void) | null = null;
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      return null;
    }
    onStopFetch = (): void => {
      fetchAbort.abort();
    };
    options.signal.addEventListener('abort', onStopFetch, { once: true });
  }
  let response: Response;
  try {
    response = await doFetch(`${options.baseUrl}/v1/changes`, {
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/x-ndjson',
        'cache-control': 'no-store',
      },
      signal: fetchAbort.signal,
    });
  } catch {
    return null;
  }
  if (response.status !== 200 || response.body === null) {
    return null;
  }
  try {
    const reader = new ChangeWakeReaderImpl(response.body, fetchAbort);
    reader.start();
    return reader;
  } catch {
    return null;
  }
}
