/**
 * OD7a1: the optional `daemon.shadow` block — valid with and without
 * `grantId`, unknown keys, a non-object block, refused `legacyStateDir` and
 * `grantId` values (relative, traversal, metacharacters, secret-shaped) and
 * the round-trip serialization key order.
 */

import { describe, expect, it } from 'vitest';

import { parseInstallation } from './parse.js';
import type { FleetInstallationV2 } from './types.js';
import {
  DAEMON_KEYS,
  DAEMON_SHADOW_KEYS,
} from './keys.js';
import { writeInstallationV2 } from './write.js';

const BASE = {
  schemaVersion: 2,
  forge: { mode: 'none' },
  hosts: {
    lane: {
      transport: 'local',
      worktreeRoot: '/srv/fleet/worktrees',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46000 },
    },
  },
  daemon: {
    nodePath: '/srv/fleet/node/bin/node',
    cliPath: '/srv/fleet/cli/fleet-v2.mjs',
    stateDir: '/srv/fleet/state',
    unitDir: '/srv/fleet/units',
    installationFile: '/srv/fleet/fleet.json',
  },
};

const SHADOW = { legacyStateDir: '/srv/fleet/legacy-state' };

function parseWithShadow(
  shadow: unknown,
): { ok: true; installation: FleetInstallationV2 } | { ok: false; errors: string[] } {
  const result = parseInstallation({
    ...BASE,
    daemon: { ...BASE.daemon, shadow },
  });
  if (result.ok && result.installation.schemaVersion === 2) {
    return { ok: true, installation: result.installation as FleetInstallationV2 };
  }
  return { ok: false, errors: result.ok ? [] : result.errors };
}

describe('daemon.shadow (OD7a1)', () => {
  it('accepts daemon.shadow without grantId', () => {
    const result = parseWithShadow(SHADOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.daemon?.shadow).toEqual(SHADOW);
    }
  });

  it('accepts daemon.shadow with a plain grantId', () => {
    const result = parseWithShadow({ ...SHADOW, grantId: 'shadow-grant-01' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.daemon?.shadow).toEqual({
        legacyStateDir: '/srv/fleet/legacy-state',
        grantId: 'shadow-grant-01',
      });
    }
  });

  it('accepts a grantId with surrounding whitespace trimmed', () => {
    const result = parseWithShadow({ ...SHADOW, grantId: '  grant-1  ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.daemon?.shadow?.grantId).toBe('grant-1');
    }
  });

  it('refuses unknown keys inside daemon.shadow', () => {
    const result = parseWithShadow({ ...SHADOW, token: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('daemon.shadow: unknown key');
    }
  });

  it('refuses a non-object daemon.shadow', () => {
    expect(parseWithShadow('shadow').ok).toBe(false);
    const result = parseWithShadow(7);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('daemon.shadow: must be an object');
    }
  });

  it('refuses a missing or relative legacyStateDir', () => {
    const absent = parseWithShadow({});
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.errors).toContain('daemon.shadow.legacyStateDir: required');
    }
    const relative = parseWithShadow({ legacyStateDir: 'legacy/state' });
    expect(relative.ok).toBe(false);
    if (!relative.ok) {
      expect(relative.errors.some((e) => e.startsWith('daemon.shadow.legacyStateDir'))).toBe(true);
    }
  });

  it('refuses a traversal legacyStateDir', () => {
    // A `..` segment can only enter through a relative path, which is already
    // refused as not absolute; an absolute-looking `/srv/../etc` stays
    // parseable here exactly like the other daemon paths (the loader keeps
    // them identical) and is never a parse refusal of its own.
    const result = parseWithShadow({ legacyStateDir: '../upstream/state' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        'daemon.shadow.legacyStateDir: must be an absolute path',
      );
    }
  });

  it('refuses a metacharacter legacyStateDir', () => {
    const result = parseWithShadow({ legacyStateDir: '/srv/fleet/state; rm -rf' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith('daemon.shadow.legacyStateDir')),
      ).toBe(true);
    }
  });

  it('refuses a secret-shaped legacyStateDir', () => {
    // Built at runtime so no secret literal ever lands in this file. The value
    // is an absolute path carrying none of the refused path characters, so
    // only the credential screen can refuse it.
    const legacyStateDir = ['/srv/fleet/', 'ghp', '_', 'A1b2C3'.repeat(4)].join('');
    expect(legacyStateDir).toMatch(/^\/srv\/fleet\/ghp_[A-Za-z0-9_-]{20,}$/);
    const result = parseWithShadow({ legacyStateDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('daemon.shadow.legacyStateDir: refused');
    }
  });

  it('refuses an empty, whitespace-only or whitespace-carrying grantId', () => {
    for (const grantId of ['', '   ', 'grant 1', 'grant\t1']) {
      const result = parseWithShadow({ ...SHADOW, grantId });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain(
          'daemon.shadow.grantId: must be a non-empty id',
        );
      }
    }
  });

  it('refuses unit metacharacters in grantId', () => {
    for (const grantId of ['grant$id', 'grant%1', 'grant"1', "grant'1", 'grant\\1']) {
      const result = parseWithShadow({ ...SHADOW, grantId });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain(
          'daemon.shadow.grantId: must be a non-empty id',
        );
      }
    }
  });

  it('refuses a secret-shaped grantId', () => {
    // A JWT is caught by the shared `containsSecretShape` screening, not by
    // the daemon credential prefix list.
    const result = parseWithShadow({
      ...SHADOW,
      grantId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('daemon.shadow.grantId: refused');
    }
    const githubToken = parseWithShadow({
      ...SHADOW,
      grantId: 'ghp_secretvalue01',
    });
    expect(githubToken.ok).toBe(false);
    if (!githubToken.ok) {
      expect(githubToken.errors).toContain('daemon.shadow.grantId: refused');
    }
  });

  it('refuses a non-string grantId', () => {
    const result = parseWithShadow({ ...SHADOW, grantId: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        'daemon.shadow.grantId: must be a non-empty id',
      );
    }
  });

  it('round-trips daemon.shadow through writeInstallationV2 in key order', () => {
    const result = parseWithShadow({ ...SHADOW, grantId: 'grant-9' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const text = writeInstallationV2(result.installation);
    const reparsed = parseInstallation(JSON.parse(text));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.installation.daemon?.shadow).toEqual({
        legacyStateDir: '/srv/fleet/legacy-state',
        grantId: 'grant-9',
      });
    }
    const daemonText = text.split('"daemon"')[1] ?? '';
    expect(daemonText.indexOf('shadow')).toBeGreaterThan(
      daemonText.indexOf('installationFile'),
    );
    expect(daemonText.indexOf('legacyStateDir')).toBeLessThan(
      daemonText.indexOf('grantId'),
    );
  });

  it('keeps the key lists in sync with the types', () => {
    expect([...DAEMON_KEYS]).toEqual([
      'nodePath',
      'cliPath',
      'stateDir',
      'unitDir',
      'installationFile',
      'shadow',
    ]);
    expect([...DAEMON_SHADOW_KEYS]).toEqual(['legacyStateDir', 'grantId']);
  });
});
