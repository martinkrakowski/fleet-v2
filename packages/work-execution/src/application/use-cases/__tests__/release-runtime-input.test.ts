/**
 * CO14b robustness bar, part of the lane:
 *  1. the release never throws on runtime input — every malformed or hostile
 *     input returns the lane's typed refusal, never an exception;
 *  5. release output carries ids and codes only — no secret-shaped text and no
 *     path in any result, refusal or message;
 *  7. release inputs and outputs are size-bounded — an oversized root, sha or
 *     grant record is refused before any work, and stored records stay inside
 *     their bound.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../ports/out/CommandExecutorPort.out-port.js';
import { ActionAuthorizationAdapter, type ActionAuthorizationGrantEntry } from '../../../infrastructure/adapters/ActionAuthorizationAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ReleaseStoreAdapter } from '../../../infrastructure/adapters/ReleaseStoreAdapter.adapter.js';
import { ManageReleaseUseCase } from '../ManageReleaseUseCase.use-case.js';

const A = 'a'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';
// A synthetic, non-credential canary that still carries a secret shape at
// runtime (so the use case refuses it) while the source file itself holds no
// credential-shaped literal — composed, never a real token.
const SECRET_SHAPED = `gh${'p_'}${'a'.repeat(32)}`;

class RecordingExecutor implements CommandExecutorPort {
  async run(_argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

describe('release runtime input', () => {
  let tempDir: string;
  let root: string;
  let leaseStateDir: string;
  let store: ReleaseStoreAdapter;
  let grants: Map<string, ActionAuthorizationGrantEntry>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-runtime-input-test-'));
    root = path.join(tempDir, 'releases');
    leaseStateDir = path.join(tempDir, 'lease-state');
    store = new ReleaseStoreAdapter();
    grants = new Map<string, ActionAuthorizationGrantEntry>();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function useCase() {
    return new ManageReleaseUseCase({
      store,
      lease: new ConductorDriverLeaseAdapter({ stateDir: leaseStateDir }),
      authorization: new ActionAuthorizationAdapter({ grants }),
      executor: new RecordingExecutor(),
      nowIso: () => NOW,
      env: () => ({ PATH: '/usr/bin' }),
    });
  }

  it('release never throws on runtime input', async () => {
    const uc = useCase();
    const hostile = new Proxy(
      { action: 'install', root, sha: A, source: '/src', keep: 3, apply: true, projectId: PROJECT },
      {
        get() {
          throw new Error('prohibited proxy trap execution');
        },
      },
    );
    const sparse = [];
    sparse.length = 3;
    sparse[0] = 1;
    sparse[2] = 3;
    const inputs: unknown[] = [
      null,
      42,
      'release',
      [],
      {},
      { action: 'install' },
      { action: 'install', root: 5, sha: A, source: '/src', keep: 3, apply: true, projectId: PROJECT },
      { action: 'install', root, sha: A, source: '/src', keep: 3, apply: true, projectId: PROJECT, extra: 1 },
      { action: 'upgrade', root, sha: A, source: '/src', keep: 3, apply: true, projectId: PROJECT },
      { action: 'swap', root, source: '/src', keep: 3, apply: true, projectId: PROJECT },
      sparse,
      hostile,
    ];
    for (const input of inputs) {
      const result = await uc.manageRelease(input as never);
      expect(result.outcome).toBe('refused');
      expect(typeof (result as { reason: string }).reason).toBe('string');
    }
  });

  it('release output carries ids and codes only', async () => {
    const uc = useCase();
    // A secret-shaped root is invalid input; the refusal must never echo the
    // secret or any path.
    const secretRoot = `/${SECRET_SHAPED}/release-root`;
    const result = await uc.manageRelease({
      action: 'install',
      root: secretRoot,
      sha: A,
      source: `/src/${SECRET_SHAPED}`,
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });
    const text = JSON.stringify(result);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(text).not.toContain(SECRET_SHAPED);
    expect(text).not.toContain('/release-root');
    expect(text).not.toContain('/src/');
    // A refused grant path also carries codes only (grant ids, never paths).
    const hostileGrant = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('prohibited proxy trap execution');
      },
    });
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', hostileGrant as ActionAuthorizationGrantEntry]]) });
    const refused = await adapter.resolveActionAuthorization({
      actionId: `release-install-${A}`,
      projectId: PROJECT,
      workOrderId: 'w',
      attemptId: 'a',
      actionKind: 'release-install',
      expectedHeadSha: A,
      policyRevision: 'p',
      root,
    });
    expect(refused.outcome).toBe('blocked');
    expect(JSON.stringify(refused)).not.toContain(SECRET_SHAPED);
  });

  it('release inputs and outputs are size-bounded', async () => {
    const uc = useCase();
    const oversizedRoot = `/${'x'.repeat(5000)}`;
    const oversized = await uc.manageRelease({
      action: 'install',
      root: oversizedRoot,
      sha: A,
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });
    expect(oversized).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    const badSha = await uc.manageRelease({
      action: 'install',
      root,
      sha: 'g'.repeat(40),
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });
    expect(badSha).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    // An oversized grant record is refused across the adapter boundary.
    const oversizedGrant: ActionAuthorizationGrantEntry = {
      expectedHeadSha: A,
      kind: 'release-install',
      root: oversizedRoot,
      consumedByActionId: null,
    };
    const adapter = new ActionAuthorizationAdapter({ grants: new Map([['grant-1', oversizedGrant]]) });
    const blocked = await adapter.resolveActionAuthorization({
      actionId: `release-install-${A}`,
      projectId: PROJECT,
      workOrderId: 'w',
      attemptId: 'a',
      actionKind: 'release-install',
      expectedHeadSha: A,
      policyRevision: 'p',
      root,
    });
    expect(blocked.outcome).toBe('blocked');

    // A successful install stores a marker inside its bound and prints a plan
    // and result that stay small. (A valid grant lets the release apply.)
    grants.set('grant-1', { expectedHeadSha: A, kind: 'release-install', root, consumedByActionId: null });
    const prepared = await store.prepare({ root, sha: A });
    if (prepared.outcome !== 'prepared') {
      throw new Error('prepare refused');
    }
    const entry = path.join(prepared.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    expect(await store.markVerified({ root, sha: A, buildId: prepared.buildId, builtAtIso: NOW })).toEqual({ outcome: 'ok' });
    const applied = await uc.manageRelease({
      action: 'install',
      root,
      sha: A,
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });
    expect(applied.outcome).toBe('applied');
    const marker = await fs.readFile(path.join(root, A, '.fleet-release-verified'), 'utf8');
    expect(marker.length).toBeLessThan(4096);
    expect(JSON.stringify(applied).length).toBeLessThan(4096);
  });
});
