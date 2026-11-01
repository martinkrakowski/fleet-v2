// LB1: the snapshot push and read routes (plan §5.3, §5.4) over a loopback
// server, authenticating through the shared security middleware and exercising
// the narrow snapshot-push scope and the runtime-wired projection store.
import './nitro-globals.js';

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, createRouter, toNodeListener } from 'h3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import securityMiddleware from '../../middleware/security';
import snapshotsGet from '../../routes/v1/snapshots/index.get';
import snapshotSectionPost from '../../routes/v1/snapshots/[section].post';
import { configureFleetApiRuntime } from '../runtime';
import { setActiveApiToken } from '../token';
import { configurePresentedTokenResolver } from '../presented-token';

const TOKEN = 'a'.repeat(32);

const createdDirs = new Set<string>();

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-snapshot-routes-'));
  createdDirs.add(directory);
  return directory;
}

let apiBaseUrl = '';
let apiServer: Server;

beforeAll(async () => {
  const app = createApp();
  app.use(securityMiddleware);
  const router = createRouter();
  router.get('/v1/snapshots', snapshotsGet);
  router.post('/v1/snapshots/:section', snapshotSectionPost);
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
  configurePresentedTokenResolver(null);
  setActiveApiToken(null);
  await Promise.all(
    [...createdDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  createdDirs.clear();
});

const POST_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
};

function configureConfigured(scope: string): void {
  setActiveApiToken(TOKEN);
  configurePresentedTokenResolver(() => ({ tokenId: 'test-token', scopes: [scope] }));
}

interface SnapshotSectionWire {
  state: string;
  tokens: string[];
  pushedAtIso: string | null;
}

async function getProjection(): Promise<Record<string, SnapshotSectionWire>> {
  const response = await fetch(`${apiBaseUrl}/v1/snapshots`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: Record<string, SnapshotSectionWire> };
  return body.result;
}

describe('POST /v1/snapshots/:section', () => {
  it('push-requires-narrow-scope', async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });
    setActiveApiToken(TOKEN);
    const body = {
      revision: 1,
      tokens: ['tool:bash'],
      pushedAtIso: '2026-11-01T10:00:00.000Z',
    };

    const defaultScope = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify(body),
    });
    expect(defaultScope.status).toBe(403);
    expect(((await defaultScope.json()) as { result: { reason: string } }).result.reason).toBe('scope-required');

    configurePresentedTokenResolver(() => ({ tokenId: 'dispatch-only', scopes: ['dispatch'] }));
    const dispatchOnly = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify(body),
    });
    expect(dispatchOnly.status).toBe(403);
    expect(((await dispatchOnly.json()) as { result: { reason: string } }).result.reason).toBe('scope-required');

    configureConfigured('snapshot-push');
    const applied = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify(body),
    });
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as { result: { section: string; revision: number } };
    expect(appliedBody.result).toEqual({ section: 'running', revision: 1 });
  });

  it('late-older-snapshot-refused', async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });
    configureConfigured('snapshot-push');
    const newer = {
      revision: 5,
      tokens: ['tool:bash', 'exit:0'],
      pushedAtIso: '2026-11-01T10:00:00.000Z',
    };
    const older = {
      revision: 3,
      tokens: ['stale'],
      pushedAtIso: '2026-11-01T09:00:00.000Z',
    };

    const first = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify(newer),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify(older),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { result: { reason: string } };
    expect(secondBody.result.reason).toBe('non-increasing-revision');

    const projection = await getProjection();
    expect(projection.running).toEqual({
      state: 'fresh',
      tokens: ['tool:bash', 'exit:0'],
      pushedAtIso: '2026-11-01T10:00:00.000Z',
    });
  });

  it('secret-shaped-push-refused', async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });
    configureConfigured('snapshot-push');
    const secret = 'ghp_' + 'i'.repeat(30);
    const response = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({
        revision: 1,
        tokens: [secret],
        pushedAtIso: '2026-11-01T10:00:00.000Z',
      }),
    });
    expect(response.status).toBe(422);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText) as { result: { reason: string } };
    expect(body.result.reason).toBe('secret-shaped');
    expect(bodyText).not.toContain(secret);
    const projection = await getProjection();
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(projection.running).toEqual({ state: 'never-pushed', tokens: [], pushedAtIso: null });
  });

  it('invalid-parse-refuses-extra-fields-without-echoing', async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });
    configureConfigured('snapshot-push');
    const pathValue = '/secret/path';
    const response = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({
        revision: 1,
        tokens: ['tool:bash'],
        pushedAtIso: '2026-11-01T10:00:00.000Z',
        path: pathValue,
      }),
    });
    expect(response.status).toBe(422);
    const bodyText = await response.text();
    expect(JSON.parse(bodyText)).toMatchObject({
      code: 'INVALID',
      result: { reason: 'extra-fields' },
    });
    expect(bodyText).not.toContain(pathValue);
  });

  it('unconfigured-post-changes-none', async () => {
    const response = await fetch(`${apiBaseUrl}/v1/snapshots/running`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: 1,
        tokens: ['tool:bash'],
        pushedAtIso: '2026-11-01T10:00:00.000Z',
      }),
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { code: string; result: unknown };
    expect(body.code).toBe('NOT_IMPLEMENTED');
    expect(body.result).toBeNull();
  });
});

describe('GET /v1/snapshots', () => {
  it('get-serves-projection-with-time', async () => {
    const stateDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir });
    configureConfigured('snapshot-push');
    await fetch(`${apiBaseUrl}/v1/snapshots/halt`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({
        revision: 1,
        tokens: ['marker:set'],
        pushedAtIso: '2026-11-01T10:00:00.000Z',
      }),
    });

    const projection = await getProjection();
    expect(Object.keys(projection).sort()).toEqual(['halt', 'parks', 'running', 'train']);
    expect(projection.halt).toEqual({
      state: 'fresh',
      tokens: ['marker:set'],
      pushedAtIso: '2026-11-01T10:00:00.000Z',
    });
    expect(projection.running).toEqual({ state: 'never-pushed', tokens: [], pushedAtIso: null });
    expect(projection.train).toEqual({ state: 'never-pushed', tokens: [], pushedAtIso: null });
    expect(projection.parks).toEqual({ state: 'never-pushed', tokens: [], pushedAtIso: null });
  });

  it('reconfiguring-clears-projection', async () => {
    const firstDir = await makeTempDir();
    const secondDir = await makeTempDir();
    configureFleetApiRuntime({ stateDir: firstDir });
    configureConfigured('snapshot-push');
    await fetch(`${apiBaseUrl}/v1/snapshots/train`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({
        revision: 1,
        tokens: ['tool:bash'],
        pushedAtIso: '2026-11-01T10:00:00.000Z',
      }),
    });
    configureFleetApiRuntime({ stateDir: secondDir });
    const projection = await getProjection();
    expect(projection.train).toEqual({ state: 'never-pushed', tokens: [], pushedAtIso: null });
  });

  it('unconfigured-get-serves-no-projection', async () => {
    const response = await fetch(`${apiBaseUrl}/v1/snapshots`);
    expect(response.status).toBe(501);
    const body = (await response.json()) as { code: string; result: unknown; operationId: unknown };
    expect(typeof body.operationId).toBe('string');
    expect(body.code).toBe('NOT_IMPLEMENTED');
    expect(body.result).toBeNull();
  });
});
