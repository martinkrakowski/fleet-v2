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

  it('close resolves a pending wait with false and is idempotent', async () => {
    const stream = openStream(() => undefined);
    const reader = await openChangeWakeReader({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: fetchFromStream(stream) });
    expect(reader).not.toBeNull();
    const wait = reader!.waitForSignal(new AbortController().signal);
    reader!.close();
    reader!.close();
    await expect(wait).resolves.toBe(false);
  });
});
