/**
 * KF-11: the conductor calls artifact-port methods on the port, never copied
 * off it. The real AttemptArtifactAdapter reads `this` (its executor), so an
 * unbound call threw inside the method, the throw was caught, and every
 * conducted dispatch parked `dispatch-inputs-unreadable` while the brief was
 * readable. These fakes are classes whose methods need `this`, as the adapter's
 * do; plain-function fakes could not catch the defect.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import { manifestVerdictOf } from '../advance-lane-run/facts.js';
import { readVerifiedFrozenManifest } from '../advance-lane-run/frozen-manifest.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';

type ArtifactPort = AdvanceLaneRunDependencies['artifactPort'];

const PROSE = '# brief\n';

class ThisBoundArtifactPort {
  readonly #manifest = JSON.stringify({ stepLimit: 60, timeLimitSeconds: 2700, expectedArtifacts: [] });
  readonly reads: string[] = [];

  async readBriefManifest(worktreePath: string, manifestPath?: string): Promise<string | null> {
    // Reading a private field throws when `this` is not the instance.
    this.reads.push(`${worktreePath}|${manifestPath ?? ''}`);
    return this.#manifest;
  }

  async readBriefFile(worktreePath: string, filePath?: string): Promise<string | null> {
    this.reads.push(`${worktreePath}|${filePath ?? ''}`);
    return PROSE;
  }

  async verifyArtifactManifest(): Promise<{ readonly outcome: 'sealed' }> {
    this.reads.push('verify');
    return { outcome: 'sealed' };
  }
}

const attempt = {
  id: 'attempt-example',
  worktreePath: '/example/worktree',
  briefPackagePath: '/example/worktree/.lane/brief.md',
  briefDigest: simpleDeterministicHexDigest(PROSE + '\n' + JSON.stringify({ stepLimit: 60, timeLimitSeconds: 2700, expectedArtifacts: [] })),
  runner: {
    kind: 'opencode',
    remotePort: 4166,
    host: 'lane-alias-example',
    hostName: 'lane-host-example',
    agent: null,
    model: null,
    variant: null,
  },
  artifacts: { manifestPath: '.lane/artifact-manifest.json', manifestSha256: 'a'.repeat(64) },
} as unknown as AttemptRecord;

describe('advance-lane-run artifact-port calls keep the port as `this` (KF-11)', () => {
  it('readVerifiedFrozenManifest reads the manifest through a this-bound port', async () => {
    const port = new ThisBoundArtifactPort();
    const manifest = await readVerifiedFrozenManifest(attempt, port as unknown as ArtifactPort);
    expect(manifest).toEqual({ stepLimit: 60, timeLimitSeconds: 2700, expectedArtifacts: [] });
    expect(port.reads).toEqual([
      '/example/worktree|/example/worktree/.lane/brief.md',
      '/example/worktree|/example/worktree/.lane/brief-manifest.json',
    ]);
  });

  it('manifestVerdictOf returns the port verdict through a this-bound port', async () => {
    const port = new ThisBoundArtifactPort();
    await expect(manifestVerdictOf(attempt, port as unknown as ArtifactPort)).resolves.toBe('sealed');
    expect(port.reads).toEqual(['verify']);
  });
});
