/**
 * CO14c: a release root resolves only to the served root. The served root is
 * read lexically from the configured `daemon.cliPath` (`<root>/current/...`),
 * `--root` must exist and realpath to it, any realpath failure refuses with
 * `release-root-state-dir-unknown`, and a missing configured root is refused
 * with `release-root-missing` for EVERY command — it is never created by the
 * CLI; the operator creates it once. The check-then-use window is closed by
 * resolving once and using only the resolved path. The CLI-composition test
 * at the end runs the real registered command group.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadInstallation, type FleetInstallation } from '@fleet/installation';

import { runCli } from '../index.js';
import { createFleetCliRuntime } from '../composition.js';
import { releaseCommands, resolveVerifiedRoot, servedRootFacts } from '../release.js';

const SHA = 'a'.repeat(40);

let tempDir = mkdtempSync(path.join(tmpdir(), 'fleet-release-root-'));
const cleanups: string[] = [];
afterEach(() => {
  for (const directory of [tempDir, ...cleanups]) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanups.length = 0;
  tempDir = mkdtempSync(path.join(tmpdir(), 'fleet-release-root-'));
});

function freshDir(label: string): string {
  const directory = mkdtempSync(path.join(tempDir, label));
  cleanups.push(directory);
  return directory;
}

/** The served facts for a daemon whose entry point runs from `<root>/current/...`. */
function factsFor(root: string, stateDir: string): { readonly configuredRoot: string; readonly stateDir: string } | null {
  const installation = {
    schemaVersion: 2,
    daemon: {
      nodePath: '/usr/bin/node',
      cliPath: `${root}/current/apps/cli/dist/bin.js`,
      stateDir,
      unitDir: `${stateDir}/units`,
      installationFile: `${stateDir}/fleet.json`,
    },
  } as unknown as FleetInstallation;
  return servedRootFacts(installation);
}

const REFUSED_ROOT = { outcome: 'refused', reason: 'release-root-state-dir-unknown' };

/** Load a v2 installation file that must be valid; the tests fail loudly otherwise. */
function loadValidInstallation(file: string): FleetInstallation {
  const loaded = loadInstallation({ file });
  if (loaded.status !== 'loaded') {
    throw new Error(`expected a valid installation file: ${loaded.status}`);
  }
  return loaded.installation;
}

describe('servedRootFacts (lexical, CO14c rule 1)', () => {
  it('derives the configured root from daemon.cliPath without touching the filesystem', () => {
    const root = freshDir('served');
    const facts = factsFor(root, '/srv/state');
    expect(facts).toEqual({ configuredRoot: root, stateDir: '/srv/state' });
  });

  it('derives the innermost served root when the root path itself contains current', () => {
    const installation = (cliPath: string): FleetInstallation =>
      ({
        schemaVersion: 2,
        daemon: { nodePath: '/usr/bin/node', cliPath, stateDir: '/srv/state', unitDir: '/u', installationFile: '/f' },
      }) as unknown as FleetInstallation;
    expect(servedRootFacts(installation('/srv/current/fleet/current/apps/cli/dist/bin.js'))).toEqual({
      configuredRoot: '/srv/current/fleet',
      stateDir: '/srv/state',
    });
  });

  it('refuses an entry point with .. segments, no current segment, or no state directory', () => {
    const stateDir = '/srv/state';
    const installation = (cliPath: string): FleetInstallation =>
      ({
        schemaVersion: 2,
        daemon: { nodePath: '/usr/bin/node', cliPath, stateDir, unitDir: '/u', installationFile: '/f' },
      }) as unknown as FleetInstallation;
    expect(servedRootFacts(installation('/srv/../etc/current/bin.js'))).toBeNull();
    expect(servedRootFacts(installation('/srv/fleet/bin.js'))).toBeNull();
    expect(servedRootFacts(installation('/current/bin.js'))).toBeNull();
    expect(
      servedRootFacts({
        schemaVersion: 2,
        daemon: { nodePath: '/n', cliPath: '/srv/current/bin.js', stateDir: ' ', unitDir: '/u', installationFile: '/f' },
      } as unknown as FleetInstallation),
    ).toBeNull();
    expect(servedRootFacts(undefined)).toBeNull();
  });
});

describe('resolveVerifiedRoot (CO14c rules 2–5)', () => {
  it('refuses a symlink to an unrelated directory even when the entry point is absent there', async () => {
    const root = freshDir('configured');
    const unrelated = freshDir('unrelated');
    const link = path.join(freshDir('alias'), 'root');
    symlinkSync(unrelated, link);
    const facts = factsFor(root, freshDir('state'));
    expect(facts).not.toBeNull();
    expect(await resolveVerifiedRoot(link, facts!)).toEqual({
      outcome: 'refused',
    });
  });

  it('refuses a nonexistent root: a missing configured root is never created', async () => {
    const root = path.join(freshDir('base'), 'fleet');
    const facts = factsFor(root, freshDir('state'));
    expect(await resolveVerifiedRoot(root, facts!)).toEqual({ outcome: 'refused', reason: 'release-root-missing' });
    expect(existsSync(root)).toBe(false);
    // A symlink to the still-absent configured root is dangling: the
    // configured root is genuinely absent, so it refuses release-root-missing.
    const link = path.join(freshDir('alias'), 'root');
    symlinkSync(root, link);
    expect(await resolveVerifiedRoot(link, facts!)).toEqual({ outcome: 'refused', reason: 'release-root-missing' });
    expect(existsSync(root)).toBe(false);
  });

  it('an invalid configured root whose parent is a regular file (ENOTDIR) stays unknown', async () => {
    const base = freshDir('srv');
    writeFileSync(path.join(base, 'notadir'), 'a file, not a directory', 'utf8');
    const root = path.join(base, 'notadir', 'fleet');
    const facts = factsFor(root, freshDir('state'));
    expect(await resolveVerifiedRoot(root, facts!)).toEqual({ outcome: 'refused' });
    expect(existsSync(root)).toBe(false);
  });

  it('accepts a symlink to the configured root, with the entry point absent', async () => {
    const root = freshDir('configured');
    mkdirSync(root, { recursive: true });
    const link = path.join(freshDir('alias'), 'root');
    symlinkSync(root, link);
    const facts = factsFor(root, freshDir('state'));
    expect(await resolveVerifiedRoot(link, facts!)).toEqual({ outcome: 'verified', root: realpathSync(root) });
  });

  it('refuses a .. or prefix-sibling root and a root whose current is a symlink away from the served root', async () => {
    const root = freshDir('configured');
    mkdirSync(root, { recursive: true });
    const facts = factsFor(root, freshDir('state'));
    // The served root is derived from cliPath, so any other existing directory
    // — including a prefix sibling — fails the equality.
    const sibling = freshDir('configured-sibling');
    expect(await resolveVerifiedRoot(sibling, facts!)).toEqual({ outcome: 'refused' });
    // An entry point whose path cannot name a served root refuses outright.
    const badFacts = servedRootFacts({
      schemaVersion: 2,
      daemon: {
        nodePath: '/usr/bin/node',
        cliPath: `${root}/current/../other/bin.js`,
        stateDir: '/srv/state',
        unitDir: '/u',
        installationFile: '/f',
      },
    } as unknown as FleetInstallation);
    expect(badFacts).toBeNull();
  });

  it('refuses a root reached through a symlinked current: only the lexically served root is accepted', async () => {
    const root = freshDir('configured');
    mkdirSync(root, { recursive: true });
    const elsewhere = path.join(freshDir('elsewhere'), 'release');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, path.join(root, 'current'));
    const facts = factsFor(root, freshDir('state'));
    // The entry point runs through the symlinked current, but the served root
    // is lexical: `--root` naming the link's target is refused, `--root`
    // naming the configured root is accepted.
    expect(await resolveVerifiedRoot(elsewhere, facts!)).toEqual({ outcome: 'refused' });
    expect(await resolveVerifiedRoot(root, facts!)).toEqual({ outcome: 'verified', root: realpathSync(root) });
  });

  it('the check-then-use window: the verified root is the resolved path, and a later symlink swap cannot redirect it', async () => {
    const root = freshDir('configured');
    mkdirSync(root, { recursive: true });
    const alias = freshDir('alias');
    const link = path.join(alias, 'root');
    symlinkSync(root, link);
    const facts = factsFor(root, freshDir('state'));
    const verified = await resolveVerifiedRoot(link, facts!);
    expect(verified).toEqual({ outcome: 'verified', root: realpathSync(root) });
    // The swap, simulated: --root is repointed to an unrelated directory after
    // the check. The command uses only the resolved path, so a write through
    // it still lands inside the served root and the swapped-in link is never
    // followed again.
    const unrelated = freshDir('unrelated');
    rmSync(link);
    symlinkSync(unrelated, link);
    if (verified.outcome !== 'verified') {
      throw new Error('expected a verified root');
    }
    writeFileSync(path.join(verified.root, 'probe'), 'x', 'utf8');
    expect(existsSync(path.join(root, 'probe'))).toBe(true);
    expect(existsSync(path.join(unrelated, 'probe'))).toBe(false);
    // A fresh check against the swapped link refuses.
    expect(await resolveVerifiedRoot(link, facts!)).toEqual({ outcome: 'refused' });
  });
});

describe('release handlers (CO14c at the CLI boundary)', () => {
  it('refuse with release-root-state-dir-unknown when the installation names no served root', async () => {
    const handler = releaseCommands['install'];
    expect(
      await handler({ root: '/srv/fleet', sha: SHA, source: '/srv/src' }, { installation: undefined } as never),
    ).toEqual(REFUSED_ROOT);
  });
});

describe('release install through the real CLI composition (CO14c)', () => {
  /** A v2 installation naming a served root and its state directory. */
  function installationFileFor(root: string, stateDir: string, port: number): string {
    const installationFile = path.join(freshDir('config'), 'fleet.json');
    writeFileSync(
      installationFile,
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
            transport: 'local',
            worktreeRoot: path.join(stateDir, 'worktrees'),
            roles: ['orchestrator', 'lane-runner'],
            runner: { kind: 'opencode', port },
          },
        },
        daemon: {
          nodePath: '/usr/bin/node',
          cliPath: `${root}/current/apps/cli/dist/bin.js`,
          stateDir,
          unitDir: path.join(stateDir, 'units'),
          installationFile,
        },
      }),
      'utf8',
    );
    return installationFile;
  }

  it('install --apply with a missing configured root refuses release-root-missing and creates nothing', async () => {
    const root = path.join(freshDir('srv'), 'fleet');
    const stateDir = freshDir('runtime-state');
    const loaded = loadValidInstallation(installationFileFor(root, stateDir, 46001));
    const rt = createFleetCliRuntime({ stateDir, installation: loaded });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'install', '--root', root, '--sha', SHA, '--source', '/nonexistent-src', '--project', 'fleet-v2', '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    const refusal = JSON.parse(out.join(''));
    expect(refusal.outcome).toBe('refused');
    expect(refusal.reason).toBe('release-root-missing');
    expect(refusal.message).toContain(`mkdir -p ${root}`);
    // No directory is created anywhere on the path.
    expect(existsSync(root)).toBe(false);
  });

  it('a non-apply command with a missing configured root refuses release-root-missing too', async () => {
    const root = path.join(freshDir('srv'), 'fleet');
    const stateDir = freshDir('runtime-state');
    const loaded = loadValidInstallation(installationFileFor(root, stateDir, 46003));
    const rt = createFleetCliRuntime({ stateDir, installation: loaded });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'swap', '--root', root, '--sha', SHA, '--project', 'fleet-v2'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    const refusal = JSON.parse(out.join(''));
    expect(refusal.outcome).toBe('refused');
    expect(refusal.reason).toBe('release-root-missing');
    expect(refusal.message).toContain(`mkdir -p ${root}`);
    expect(existsSync(root)).toBe(false);
  });

  it('a swap on a symlink to an unrelated directory is refused before anything runs', async () => {
    const root = path.join(freshDir('srv'), 'fleet');
    mkdirSync(root, { recursive: true });
    const unrelated = freshDir('unrelated');
    const link = path.join(freshDir('alias'), 'root');
    symlinkSync(unrelated, link);
    const stateDir = freshDir('runtime-state');
    const loaded = loadValidInstallation(installationFileFor(root, stateDir, 46002));
    const rt = createFleetCliRuntime({ stateDir, installation: loaded });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'swap', '--root', link, '--sha', SHA, '--project', 'fleet-v2', '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual(REFUSED_ROOT);
    expect(out.join('')).not.toContain(link);
  });
});
