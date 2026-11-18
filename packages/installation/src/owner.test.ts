import { describe, expect, it } from 'vitest';

import { parseInstallation } from './parse.js';
import { parseOwnerPublicKey, readOwnerSection } from './owner.js';

/** Canonical base64 of exactly 32 bytes (e.g. 32 zero bytes). */
const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

describe('parseOwnerPublicKey', () => {
  it('accepts a canonical base64 encoding of exactly 32 bytes', () => {
    const result = parseOwnerPublicKey(VALID_KEY);
    expect(result).toEqual({ ok: true, value: VALID_KEY });
  });

  it('refuses a non-string value', () => {
    expect(parseOwnerPublicKey(42)).toEqual({
      ok: false,
      code: 'owner-key-invalid-type',
    });
    expect(parseOwnerPublicKey(null)).toEqual({
      ok: false,
      code: 'owner-key-invalid-type',
    });
  });

  it('refuses a private-key-shaped string before the length cap', () => {
    expect(parseOwnerPublicKey(`-----BEGIN PRIVATE KEY-----${'x'.repeat(200)}`)).toEqual({
      ok: false,
      code: 'owner-key-secret-shape',
    });
  });

  it('refuses a credential-shaped string (ghp_) before the length cap', () => {
    expect(parseOwnerPublicKey(`ghp_${'x'.repeat(200)}`)).toEqual({
      ok: false,
      code: 'owner-key-secret-shape',
    });
  });

  it('refuses an over-long string', () => {
    expect(parseOwnerPublicKey('A'.repeat(129))).toEqual({
      ok: false,
      code: 'owner-key-too-long',
    });
  });

  it('refuses a value that is not canonical base64 of 32 bytes', () => {
    expect(parseOwnerPublicKey('too-short')).toEqual({
      ok: false,
      code: 'owner-key-invalid-format',
    });
    expect(parseOwnerPublicKey(Buffer.alloc(31, 1).toString('base64'))).toEqual({
      ok: false,
      code: 'owner-key-invalid-format',
    });
    expect(parseOwnerPublicKey(`${VALID_KEY}====`)).toEqual({
      ok: false,
      code: 'owner-key-invalid-format',
    });
  });

  it('never echoes the offending value in the refusal', () => {
    const result = parseOwnerPublicKey('ghp_secretvalue');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result)).not.toContain('secretvalue');
    }
  });
});

describe('readOwnerSection', () => {
  it('accepts a section with a valid publicKey', () => {
    const result = readOwnerSection({ publicKey: VALID_KEY });
    expect(result).toEqual({ ok: true, value: { publicKey: VALID_KEY } });
  });

  it('refuses a non-record section', () => {
    expect(readOwnerSection('nope')).toEqual({ ok: false, code: 'owner-section-invalid' });
    expect(readOwnerSection(null)).toEqual({ ok: false, code: 'owner-section-invalid' });
    expect(readOwnerSection(['x'])).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses a prototype-polluting own key', () => {
    const section = JSON.parse('{"__proto__": {}, "publicKey": null}');
    expect(readOwnerSection(section)).toEqual({
      ok: false,
      code: 'owner-section-prototype-pollution',
    });
  });

  it('refuses an unknown key without reading it', () => {
    const section = { publicKey: VALID_KEY, unexpected: 'value' };
    const result = readOwnerSection(section);
    expect(result).toEqual({ ok: false, code: 'owner-section-unknown-key' });
  });

  it('refuses a missing publicKey', () => {
    expect(readOwnerSection({})).toEqual({ ok: false, code: 'owner-key-required' });
  });

  it('refuses an accessor publicKey without running the getter', () => {
    let getterRan = false;
    const section = {
      get publicKey(): string {
        getterRan = true;
        return VALID_KEY;
      },
    };
    const result = readOwnerSection(section);
    expect(result).toEqual({ ok: false, code: 'owner-key-accessor' });
    expect(getterRan).toBe(false);
  });

  it('passes through the publicKey refusal code', () => {
    expect(readOwnerSection({ publicKey: 42 })).toEqual({
      ok: false,
      code: 'owner-key-invalid-type',
    });
  });
});

describe('parseInstallation owner section', () => {
  const V2_BASE = {
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
  };

  it('accepts a v2 file with a valid owner section', () => {
    const result = parseInstallation({ ...V2_BASE, owner: { publicKey: VALID_KEY } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.owner).toEqual({ publicKey: VALID_KEY });
    }
  });

  it('accepts a v1 file with a valid owner section', () => {
    const result = parseInstallation({
      schemaVersion: 1,
      owner: { publicKey: VALID_KEY },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.owner).toEqual({ publicKey: VALID_KEY });
    }
  });

  it('leaves owner absent when the file does not carry it', () => {
    const result = parseInstallation({ ...V2_BASE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.owner).toBeUndefined();
    }
  });

  it('refuses an invalid owner.publicKey with an error naming the section', () => {
    const result = parseInstallation({
      ...V2_BASE,
      owner: { publicKey: 'short' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('owner.publicKey: owner-key-invalid-format');
    }
  });

  it('refuses an unknown key inside owner with a secret-shaped value never echoed', () => {
    const result = parseInstallation({
      ...V2_BASE,
      owner: { publicKey: VALID_KEY, OWNER_TOKEN: 'ghp_secret' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('owner: owner-section-unknown-key');
      expect(JSON.stringify(result.errors)).not.toContain('ghp_secret');
    }
  });

  it('refuses a file whose waves.ownerPublicKey disagrees with owner.publicKey', () => {
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    const result = parseInstallation({
      ...V2_BASE,
      owner: { publicKey: VALID_KEY },
      waves: { baseUrl: 'https://waves.internal', tokenFile: '/srv/fleet/token', ownerPublicKey: otherKey },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        'waves.ownerPublicKey: must equal owner.publicKey when both are present',
      );
    }
  });

  it('accepts a file whose waves.ownerPublicKey agrees with owner.publicKey', () => {
    const result = parseInstallation({
      ...V2_BASE,
      owner: { publicKey: VALID_KEY },
      waves: { baseUrl: 'https://waves.internal', tokenFile: '/srv/fleet/token', ownerPublicKey: VALID_KEY },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation.owner).toEqual({ publicKey: VALID_KEY });
    }
  });
});
