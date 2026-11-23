// Conductor change-feed wake reader tests — K9.
/**
 * The reader module (`conductor-wake.ts`) is pure app-level code: every test
 * here runs against local files and a fake `fetchImpl`, never the network.
 */

import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  normalizeWakeBaseUrl,
  openChangeWakeReader,
  parseWakeSignal,
  readWakeToken,
  resolveWakeConfig,
} from '../conductor-wake.js';

const TOKEN = 'tok_' + 'a'.repeat(40);
const BASE_URL = 'http://127.0.0.1:3001';

describe('parseWakeSignal (K9)', () => {
  it('returns null for blank, whitespace-only and malformed lines', () => {
    expect(parseWakeSignal('')).toBeNull();
    expect(parseWakeSignal('   ')).toBeNull();
    expect(parseWakeSignal('not json')).toBeNull();
    expect(parseWakeSignal('{}')).toBeNull();
    expect(parseWakeSignal('{"seq":"1","kind":"attempt"}')).toBeNull();
  });

  it('parses a well-formed line and a resync line', () => {
    expect(
      parseWakeSignal('{"stream":"s_1","seq":7,"kind":"attempt","id":"a_1","at":"2026-11-05T10:00:00.000Z"}'),
    ).toEqual({ kind: 'attempt', seq: 7 });
    expect(
      parseWakeSignal('{"stream":"s_1","seq":8,"kind":"resync","id":null,"at":"2026-11-05T10:00:01.000Z"}'),
    ).toEqual({ kind: 'resync', seq: 8 });
  });

  it('returns null for JSON primitives, arrays and a missing or non-string kind', () => {
    expect(parseWakeSignal('null')).toBeNull();
    expect(parseWakeSignal('123')).toBeNull();
    expect(parseWakeSignal('true')).toBeNull();
    expect(parseWakeSignal('[]')).toBeNull();
    expect(parseWakeSignal('{"seq":1}')).toBeNull();
    expect(parseWakeSignal('{"seq":1,"kind":42}')).toBeNull();
  });

  it('parses a __proto__ JSON key without polluting Object.prototype', () => {
    expect(parseWakeSignal('{"__proto__":{"polluted":true},"seq":1,"kind":"attempt"}')).toEqual({
      kind: 'attempt',
      seq: 1,
    });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns null for hostile runtime inputs instead of throwing', () => {
    // Cost bound: the `typeof line !== 'string'` guard is O(1) and runs before
    // JSON.parse, so no coercion happens; the happy path stays O(n) in the
    // input length.
    expect(parseWakeSignal(null as unknown as string)).toBeNull();
    expect(parseWakeSignal(undefined as unknown as string)).toBeNull();
    expect(parseWakeSignal(123 as unknown as string)).toBeNull();
    expect(parseWakeSignal({} as unknown as string)).toBeNull();
  });

  it('returns null for a throwing-getter object and a lying Proxy without invoking any getter or trap', () => {
    // Cost bound: the `typeof line !== 'string'` guard is O(1) and runs before
    // JSON.parse, so no coercion (toString/valueOf/get traps) is ever reached.
    let getterCalls = 0;
    const evil = {
      get toString(): string {
        getterCalls += 1;
        throw new Error('boom');
      },
    };
    expect(parseWakeSignal(evil as unknown as string)).toBeNull();
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const lying = new Proxy(
      {},
      {
        get: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
        has: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
        getOwnPropertyDescriptor: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
      },
    );
    expect(parseWakeSignal(lying as unknown as string)).toBeNull();
    expect(trapCalls).toBe(0);
  });
});

describe('readWakeToken (K9)', () => {
  function writeToken(dir: string, content: string, mode: number): string {
    const path = join(dir, 'token');
    writeFileSync(path, content, { mode, encoding: 'utf8' });
    chmodSync(path, mode);
    return path;
  }

  it('returns null for a missing path and a relative path', () => {
    expect(readWakeToken('/definitely/not/a/file-xyz')).toBeNull();
    expect(readWakeToken('relative/token')).toBeNull();
  });

  it('returns null for a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const target = writeToken(dir, `${TOKEN}\n`, 0o600);
    const link = join(dir, 'link');
    symlinkSync(target, link);
    expect(readWakeToken(link)).toBeNull();
  });

  it('returns null for a file with group/other permission bits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const path = writeToken(dir, `${TOKEN}\n`, 0o644);
    expect(readWakeToken(path)).toBeNull();
  });

  it('returns null for a first line shorter than 32 characters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const path = writeToken(dir, 'short-token\n', 0o600);
    expect(readWakeToken(path)).toBeNull();
  });

  it('returns null for a first line with an illegal character', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const path = writeToken(dir, `${'a'.repeat(40)}.extra\n`, 0o600);
    expect(readWakeToken(path)).toBeNull();
  });

  it('returns the trimmed first line of a 0600 file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const path = writeToken(dir, `  ${TOKEN}  \nignored second line\n`, 0o600);
    expect(readWakeToken(path)).toBe(TOKEN);
  });

  it('returns null for a directory path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    expect(readWakeToken(dir)).toBeNull();
  });

  it('returns null for an empty and a whitespace-only path', () => {
    expect(readWakeToken('')).toBeNull();
    expect(readWakeToken('   ')).toBeNull();
  });

  it('returns null for an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const path = writeToken(dir, '', 0o600);
    expect(readWakeToken(path)).toBeNull();
  });

  it('reads the token from a \\r\\n first line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const path = writeToken(dir, `${TOKEN}\r\nsecond line\r\n`, 0o600);
    expect(readWakeToken(path)).toBe(TOKEN);
  });

  it('returns null for hostile runtime inputs without invoking any getter or trap', () => {
    // Cost bound: the `typeof raw !== 'string'` guard is O(1) and runs before
    // any fs call, so no coercion (toString/valueOf/get traps) is ever reached.
    expect(readWakeToken(null as unknown as string)).toBeNull();
    expect(readWakeToken(undefined as unknown as string)).toBeNull();
    expect(readWakeToken(123 as unknown as string)).toBeNull();

    let getterCalls = 0;
    const evil = {
      get toString(): string {
        getterCalls += 1;
        throw new Error('boom');
      },
    };
    expect(readWakeToken(evil as unknown as string)).toBeNull();
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const lying = new Proxy(
      {},
      {
        get: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
        has: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
        getOwnPropertyDescriptor: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
      },
    );
    expect(readWakeToken(lying as unknown as string)).toBeNull();
    expect(trapCalls).toBe(0);
  });
});

describe('normalizeWakeBaseUrl (K9)', () => {
  it('refuses malformed, credentialed, pathed and non-loopback HTTP URLs', () => {
    expect(normalizeWakeBaseUrl('not a url')).toBeNull();
    expect(normalizeWakeBaseUrl('ftp://127.0.0.1:3001')).toBeNull();
    expect(normalizeWakeBaseUrl('http://example.com:3001')).toBeNull();
    expect(normalizeWakeBaseUrl('http://user:pw@127.0.0.1:3001')).toBeNull();
    expect(normalizeWakeBaseUrl('http://127.0.0.1:3001/v1')).toBeNull();
    expect(normalizeWakeBaseUrl('http://127.0.0.1:3001?x=1')).toBeNull();
    expect(normalizeWakeBaseUrl('http://127.0.0.1:3001#frag')).toBeNull();
    expect(normalizeWakeBaseUrl('http://127.0.0.1')).toBeNull(); // no explicit port
  });

  it('accepts loopback HTTP with an explicit port and HTTPS for any host', () => {
    expect(normalizeWakeBaseUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(normalizeWakeBaseUrl('http://localhost:3001/')).toBe('http://localhost:3001');
    expect(normalizeWakeBaseUrl('https://api.example')).toBe('https://api.example');
    expect(normalizeWakeBaseUrl('http://[::1]:3001')).toBe('http://[::1]:3001');
    expect(normalizeWakeBaseUrl('http://[::1]:3001/')).toBe('http://[::1]:3001');
  });

  it('refuses undefined, empty, whitespace-only and username-only inputs', () => {
    expect(normalizeWakeBaseUrl(undefined)).toBeNull();
    expect(normalizeWakeBaseUrl('')).toBeNull();
    expect(normalizeWakeBaseUrl('   ')).toBeNull();
    expect(normalizeWakeBaseUrl('http://user@127.0.0.1:3001')).toBeNull();
  });

  it('returns null for hostile runtime inputs without invoking any getter or trap', () => {
    // Cost bound: the `typeof raw !== 'string'` guard is O(1) and runs before
    // URL parsing, so no coercion (toString/valueOf/get traps) is ever reached.
    expect(normalizeWakeBaseUrl(null as unknown as string)).toBeNull();
    expect(normalizeWakeBaseUrl(123 as unknown as string)).toBeNull();

    let getterCalls = 0;
    const evil = {
      get toString(): string {
        getterCalls += 1;
        throw new Error('boom');
      },
    };
    expect(normalizeWakeBaseUrl(evil as unknown as string)).toBeNull();
    expect(getterCalls).toBe(0);

    let trapCalls = 0;
    const lying = new Proxy(
      {},
      {
        get: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
        has: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
        getOwnPropertyDescriptor: () => {
          trapCalls += 1;
          throw new Error('boom');
        },
      },
    );
    expect(normalizeWakeBaseUrl(lying as unknown as string)).toBeNull();
    expect(trapCalls).toBe(0);
  });
});

describe('resolveWakeConfig (K9)', () => {
  const ENV_KEYS = ['FLEET_API_URL', 'FLEET_CONDUCTOR_WAKE_TOKEN_FILE', 'FLEET_API_TOKEN_FILE'] as const;

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = saved[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  function writeToken(dir: string, content: string): string {
    const path = join(dir, 'token');
    writeFileSync(path, content, { mode: 0o600, encoding: 'utf8' });
    chmodSync(path, 0o600);
    return path;
  }

  it('returns null when either variable is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const tokenFile = writeToken(dir, `${TOKEN}\n`);
    process.env.FLEET_API_URL = BASE_URL;
    expect(resolveWakeConfig(process.env)).toBeNull();
    process.env.FLEET_CONDUCTOR_WAKE_TOKEN_FILE = tokenFile;
    delete process.env.FLEET_API_URL;
    expect(resolveWakeConfig(process.env)).toBeNull();
  });

  it('returns null for a whitespace-only FLEET_API_URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const tokenFile = writeToken(dir, `${TOKEN}\n`);
    process.env.FLEET_API_URL = '   ';
    process.env.FLEET_CONDUCTOR_WAKE_TOKEN_FILE = tokenFile;
    expect(resolveWakeConfig(process.env)).toBeNull();
  });

  it('returns null for a whitespace-only FLEET_CONDUCTOR_WAKE_TOKEN_FILE', () => {
    process.env.FLEET_API_URL = BASE_URL;
    process.env.FLEET_CONDUCTOR_WAKE_TOKEN_FILE = '   ';
    expect(resolveWakeConfig(process.env)).toBeNull();
  });

  it('returns null for a refused URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const tokenFile = writeToken(dir, `${TOKEN}\n`);
    process.env.FLEET_API_URL = 'http://example.com:3001';
    process.env.FLEET_CONDUCTOR_WAKE_TOKEN_FILE = tokenFile;
    expect(resolveWakeConfig(process.env)).toBeNull();
  });

  it('returns null for an unreadable token file', () => {
    process.env.FLEET_API_URL = BASE_URL;
    process.env.FLEET_CONDUCTOR_WAKE_TOKEN_FILE = '/definitely/not/a/file-xyz';
    expect(resolveWakeConfig(process.env)).toBeNull();
  });

  it('returns { baseUrl, token } when both are good', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const tokenFile = writeToken(dir, `${TOKEN}\n`);
    process.env.FLEET_API_URL = BASE_URL;
    process.env.FLEET_CONDUCTOR_WAKE_TOKEN_FILE = tokenFile;
    expect(resolveWakeConfig(process.env)).toEqual({ baseUrl: BASE_URL, token: TOKEN });
  });

  it('never reads the shared FLEET_API_TOKEN_FILE (D9)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-wake-test-'));
    const sharedFile = writeToken(dir, `${TOKEN}\n`);
    process.env.FLEET_API_URL = BASE_URL;
    process.env.FLEET_API_TOKEN_FILE = sharedFile;
    // FLEET_CONDUCTOR_WAKE_TOKEN_FILE stays unset.
    expect(resolveWakeConfig(process.env)).toBeNull();
  });
});

describe('openChangeWakeReader (K9)', () => {
  function signalLine(seq: number, kind: string): string {
    return JSON.stringify({ stream: 's_1', seq, kind, id: 'a_1', at: '2026-11-05T10:00:00.000Z' });
  }

  function openStream(
    emit: (push: (line: string) => void, close: () => void) => void,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        emit(
          (text: string) => controller.enqueue(encoder.encode(text + '\n')),
          () => controller.close(),
        );
      },
    });
  }

  function fetchFromStream(stream: ReadableStream<Uint8Array>): typeof fetch {
    return (async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })) as typeof fetch;
  }

  it('returns null when the fetch rejects', async () => {
    const rejectingFetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: rejectingFetch });
    expect(reader).toBeNull();
  });

  it('returns null when the API answers 401', async () => {
    const unauthorizedFetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: unauthorizedFetch });
    expect(reader).toBeNull();
  });

  it('requests the change stream with the read bearer and the ndjson accept header', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(openStream(() => undefined), { status: 200 });
    }) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: capturingFetch });
    expect(reader).not.toBeNull();
    expect(capturedUrl).toBe(`${BASE_URL}/v1/changes`);
    expect(capturedInit?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/x-ndjson',
      'cache-control': 'no-store',
    });
    reader?.close();
  });

  it('resolves waitForSignal true when a signal line arrives', async () => {
    let push!: (text: string) => void;
    const stream = openStream((emit) => {
      push = emit;
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    const wait = reader!.waitForSignal(new AbortController().signal);
    push(signalLine(7, 'attempt'));
    await expect(wait).resolves.toBe(true);
    reader!.close();
  });

  it('a blank keep-alive line alone does not wake a wait', async () => {
    let push!: (text: string) => void;
    const stream = openStream((emit) => {
      push = emit;
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    let resolved = false;
    const wait = reader!.waitForSignal(new AbortController().signal).then((value) => {
      resolved = true;
      return value;
    });
    push('');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    push(signalLine(8, 'resync'));
    await expect(wait).resolves.toBe(true);
    reader!.close();
  });

  it('resolves false when the stream ends', async () => {
    const stream = openStream((_emit, close) => close());
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    await expect(reader!.waitForSignal(new AbortController().signal)).resolves.toBe(false);
    reader!.close();
  });

  it('a signal buffered before the stream ends still wakes the next wait once', async () => {
    const stream = openStream((emit, close) => {
      emit(signalLine(9, 'attempt'));
      close();
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abort = new AbortController().signal;
    await expect(reader!.waitForSignal(abort)).resolves.toBe(true);
    await expect(reader!.waitForSignal(abort)).resolves.toBe(false);
    reader!.close();
  });

  it('close resolves a pending wait with false and is idempotent', async () => {
    const stream = openStream(() => undefined);
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    const wait = reader!.waitForSignal(new AbortController().signal);
    reader!.close();
    reader!.close();
    await expect(wait).resolves.toBe(false);
  });

  it('returns null when options.signal is already aborted, without calling fetchImpl', async () => {
    let fetchCalls = 0;
    const spyFetch = (async () => {
      fetchCalls += 1;
      return new Response(openStream(() => undefined), { status: 200 });
    }) as typeof fetch;
    const external = new AbortController();
    external.abort();
    const reader = await openChangeWakeReader({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: spyFetch,
      signal: external.signal,
    });
    expect(reader).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it('aborts the fetch signal when options.signal fires mid-fetch, resolving null', async () => {
    let capturedInit: RequestInit | undefined;
    const pendingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      });
    }) as typeof fetch;
    const external = new AbortController();
    const opening = openChangeWakeReader({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: pendingFetch,
      signal: external.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    external.abort();
    await expect(opening).resolves.toBeNull();
    expect(capturedInit?.signal?.aborted).toBe(true);
  });

  it('returns null when fetchImpl throws synchronously', async () => {
    const throwingFetch = (() => {
      throw new Error('sync boom');
    }) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: throwingFetch });
    expect(reader).toBeNull();
  });

  it('returns null for a 200 response with a null body', async () => {
    const nullBodyFetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: nullBodyFetch });
    expect(reader).toBeNull();
  });

  it('returns null when response.body.getReader() throws (already-locked stream)', async () => {
    const lockedBody = {
      getReader(): ReadableStreamDefaultReader<Uint8Array> {
        throw new Error('stream is locked');
      },
    };
    const lockedFetch = (async () => ({ status: 200, body: lockedBody }) as unknown as Response) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: lockedFetch });
    expect(reader).toBeNull();
  });

  it('resolves waitForSignal false when the given AbortSignal is already aborted', async () => {
    const stream = openStream(() => undefined);
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    const abort = new AbortController();
    abort.abort();
    await expect(reader!.waitForSignal(abort.signal)).resolves.toBe(false);
    reader!.close();
  });

  it('resolves waitForSignal false when called after close', async () => {
    const stream = openStream(() => undefined);
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    reader!.close();
    await expect(reader!.waitForSignal(new AbortController().signal)).resolves.toBe(false);
  });

  it('a mid-wait abort resolves only that waiter while a concurrent waiter still wakes', async () => {
    let push!: (text: string) => void;
    const stream = openStream((emit) => {
      push = emit;
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    const abortA = new AbortController();
    const abortB = new AbortController();
    const waitA = reader!.waitForSignal(abortA.signal);
    const waitB = reader!.waitForSignal(abortB.signal);
    abortA.abort();
    await expect(waitA).resolves.toBe(false);
    push(signalLine(11, 'attempt'));
    await expect(waitB).resolves.toBe(true);
    reader!.close();
  });

  it('one signal wakes every concurrent waiter', async () => {
    let push!: (text: string) => void;
    const stream = openStream((emit) => {
      push = emit;
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    const waitA = reader!.waitForSignal(new AbortController().signal);
    const waitB = reader!.waitForSignal(new AbortController().signal);
    const waitC = reader!.waitForSignal(new AbortController().signal);
    push(signalLine(12, 'attempt'));
    await expect(waitA).resolves.toBe(true);
    await expect(waitB).resolves.toBe(true);
    await expect(waitC).resolves.toBe(true);
    reader!.close();
  });

  it('a signal arriving before the wait is consumed once while the stream stays open', async () => {
    let push!: (text: string) => void;
    const stream = openStream((emit) => {
      push = emit;
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    push(signalLine(13, 'attempt'));
    const abort = new AbortController().signal;
    await expect(reader!.waitForSignal(abort)).resolves.toBe(true);
    let secondResolved = false;
    const second = reader!.waitForSignal(abort).then((value) => {
      secondResolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondResolved).toBe(false);
    push(signalLine(14, 'attempt'));
    await expect(second).resolves.toBe(true);
    reader!.close();
  });

  it('a signal split across chunks is parsed, and a trailing buffer without \\n is flushed on close', async () => {
    const encoder = new TextEncoder();
    const chunkedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"stream":"s_1","seq":7,'));
        controller.enqueue(encoder.encode('"kind":"attempt","id":"a_1"}'));
        controller.enqueue(encoder.encode('\n'));
        controller.close();
      },
    });
    const reader = await openChangeWakeReader({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchFromStream(chunkedStream),
    });
    expect(reader).not.toBeNull();
    await expect(reader!.waitForSignal(new AbortController().signal)).resolves.toBe(true);
    reader!.close();

    const unterminatedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(signalLine(8, 'resync')));
        controller.close();
      },
    });
    const reader2 = await openChangeWakeReader({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchFromStream(unterminatedStream),
    });
    expect(reader2).not.toBeNull();
    await expect(reader2!.waitForSignal(new AbortController().signal)).resolves.toBe(true);
    reader2!.close();
  });

  it('a malformed JSON line in the stream does not wake a wait, but a later valid signal does', async () => {
    let push!: (text: string) => void;
    const stream = openStream((emit) => {
      push = emit;
    });
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    let resolved = false;
    const wait = reader!.waitForSignal(new AbortController().signal).then((value) => {
      resolved = true;
      return value;
    });
    push('not json');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    push(signalLine(15, 'attempt'));
    await expect(wait).resolves.toBe(true);
    reader!.close();
  });

  it('a reader.read() rejection ends the reader and settles pending waits with false', async () => {
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('read failed'));
      },
    });
    const reader = await openChangeWakeReader({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchFromStream(failingStream),
    });
    expect(reader).not.toBeNull();
    const wait = reader!.waitForSignal(new AbortController().signal);
    await expect(wait).resolves.toBe(false);
    await expect(reader!.waitForSignal(new AbortController().signal)).resolves.toBe(false);
    reader!.close();
  });

  it('close aborts the fetch signal and swallows a rejecting reader.cancel()', async () => {
    let capturedInit: RequestInit | undefined;
    const capturingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            return Promise.reject(new Error('cancel boom'));
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: capturingFetch });
    expect(reader).not.toBeNull();
    reader!.close();
    expect(capturedInit?.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
