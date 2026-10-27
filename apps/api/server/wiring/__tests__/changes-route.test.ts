// E3b-1: GET /v1/changes streams JSON lines over a loopback server with a
// temp state dir, authenticating through the shared security middleware.
import './nitro-globals.js';

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, createRouter, toNodeListener } from 'h3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import securityMiddleware from '../../middleware/security';
import changesGet from '../../routes/v1/changes.get';
import { configureFleetApiRuntime, getChangeFeed } from '../runtime';
import { setActiveApiToken } from '../token';
import {
  CHANGE_STREAM_MAX_OPEN,
  openChangeStreamCount,
  setChangeStreamMaxOpenForTests,
} from '../changes/change-stream';

const TOKEN = 'a'.repeat(32);

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-changes-route-'));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = '';
let apiServer: Server;

beforeAll(async () => {
  const app = createApp();
  app.use(securityMiddleware);
  const router = createRouter();
  router.get('/v1/changes', changesGet);
  app.use(router.handler);
  apiServer = createServer(toNodeListener(app));
  await new Promise<void>((resolve) =>
    apiServer.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = apiServer.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  apiBaseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  apiServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    apiServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

afterEach(async () => {
  configureFleetApiRuntime(null);
  setActiveApiToken(null);
  await Promise.all(
    [...createdDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  createdDirs.clear();
});

const decoder = new TextDecoder();

async function readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>, want: number, buffer = '', got: string[] = [],
): Promise<string[]> {
  if (got.length >= want) return got;
  const { value, done } = await reader.read();
  if (done) return got;
  const parts = (buffer + decoder.decode(value, { stream: true })).split('\n');
  const rest = parts.pop() ?? '';
  return readLines(reader, want, rest, [...got, ...parts.filter((p) => p.length > 0)]);
}

describe('GET /v1/changes', () => {
  it('answers 501 NOT_IMPLEMENTED when unconfigured', async () => {
    const response = await fetch(`${apiBaseUrl}/v1/changes`);
    expect(response.status).toBe(501);
    const body = (await response.json()) as {
      operationId: unknown;
      code: string;
      result: unknown;
    };
    expect(typeof body.operationId).toBe('string');
    expect(body.code).toBe('NOT_IMPLEMENTED');
    expect(body.result).toBeNull();
  });

  it('refuses a missing bearer token with 401', async () => {
    const stateDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    const response = await fetch(`${apiBaseUrl}/v1/changes`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(TOKEN);
  });

  it('refuses a wrong bearer token with 401', async () => {
    const stateDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    const response = await fetch(`${apiBaseUrl}/v1/changes`, {
      headers: { authorization: `Bearer ${'b'.repeat(32)}` },
    });
    expect(response.status).toBe(401);
  });

  it('starts with a resync for a foreign cursor', async () => {
    const stateDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    const controller = new AbortController();
    try {
      const response = await fetch(`${apiBaseUrl}/v1/changes?after=s_other:0`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')?.startsWith('application/x-ndjson')).toBe(true);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const reader = response.body!.getReader();
      const first = await readLines(reader, 1).catch(() => undefined);
      const line = JSON.parse(first![0]!) as Record<string, unknown>;
      expect(line.kind).toBe('resync');
      expect(line.stream).toBe(getChangeFeed()!.streamId);
    } finally {
      controller.abort();
    }
  });

  it('delivers a new signal after a current cursor', async () => {
    const stateDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    const feed = getChangeFeed()!;
    const head = feed.headSeq;
    const controller = new AbortController();
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/changes?after=${feed.streamId}:${head}`,
        {
          headers: { authorization: `Bearer ${TOKEN}` },
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      feed.emit({ kind: 'attempt', id: 'att-1', stateFile: null, before: null, written: null });
      const got = await readLines(reader, 1).catch(() => undefined);
      const line = JSON.parse(got![0]!) as Record<string, unknown>;
      expect(line.kind).toBe('attempt');
      expect(line.id).toBe('att-1');
      expect(line.seq).toBe(head + 1);
    } finally {
      controller.abort();
    }
  });

  it('a closed connection stops its stream', async () => {
    const stateDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    const before = openChangeStreamCount();
    const controller = new AbortController();
    try {
      const response = await fetch(`${apiBaseUrl}/v1/changes`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const first = await readLines(reader, 1).catch(() => undefined);
      expect(JSON.parse(first![0]!) as Record<string, unknown>).toMatchObject({
        kind: 'resync',
      });
      expect(openChangeStreamCount()).toBe(before + 1);
      controller.abort();
      await vi.waitFor(() => expect(openChangeStreamCount()).toBe(before));
    } finally {
      controller.abort();
    }
  });

  it('reconfiguring the runtime ends an open stream', async () => {
    const stateDir = await makeTempDir();
    const otherDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    const controller = new AbortController();
    let done = false;
    try {
      const response = await fetch(`${apiBaseUrl}/v1/changes`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      void readLines(reader, 100)
        .then(() => {
          done = true;
        })
        .catch(() => undefined);
      await vi.waitFor(() => expect(openChangeStreamCount()).toBeGreaterThan(0));
      configureFleetApiRuntime({ stateDir: otherDir });
      await vi.waitFor(() => expect(done).toBe(true));
    } finally {
      controller.abort();
    }
  });

  it('refuses a third stream over the cap with 503', async () => {
    const stateDir = await makeTempDir();
    setActiveApiToken(TOKEN);
    configureFleetApiRuntime({ stateDir });
    setChangeStreamMaxOpenForTests(2);
    const before = openChangeStreamCount();
    const streamOne = new AbortController();
    const streamTwo = new AbortController();
    const overCap = new AbortController();
    const retried = new AbortController();
    try {
      const [one, two] = await Promise.all([
        fetch(`${apiBaseUrl}/v1/changes`, {
          headers: { authorization: `Bearer ${TOKEN}` },
          signal: streamOne.signal,
        }),
        fetch(`${apiBaseUrl}/v1/changes`, {
          headers: { authorization: `Bearer ${TOKEN}` },
          signal: streamTwo.signal,
        }),
      ]);
      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
      await vi.waitFor(() => expect(openChangeStreamCount()).toBe(before + 2));
      const refused = await fetch(`${apiBaseUrl}/v1/changes`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: overCap.signal,
      });
      expect(refused.status).toBe(503);
      const bodyText = await refused.text();
      const body = JSON.parse(bodyText) as {
        operationId: unknown;
        code: string;
        result: unknown;
      };
      expect(typeof body.operationId).toBe('string');
      expect(body.code).toBe('TOO_MANY_STREAMS');
      expect(body.result).toBeNull();
      expect(bodyText).not.toContain(stateDir);
      expect(bodyText).not.toContain(TOKEN);
      expect(bodyText).not.toContain('/v1/changes');
      expect(openChangeStreamCount()).toBe(before + 2);
      streamOne.abort();
      await vi.waitFor(() => expect(openChangeStreamCount()).toBe(before + 1));
      const again = await fetch(`${apiBaseUrl}/v1/changes`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: retried.signal,
      });
      expect(again.status).toBe(200);
      await vi.waitFor(() => expect(openChangeStreamCount()).toBe(before + 2));
    } finally {
      streamOne.abort();
      streamTwo.abort();
      overCap.abort();
      retried.abort();
      setChangeStreamMaxOpenForTests(CHANGE_STREAM_MAX_OPEN);
    }
  });
});
