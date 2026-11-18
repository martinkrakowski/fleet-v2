import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveInstallationModel } from './model.js';
import { loadInstallation, type InstallationFileSeam } from './load.js';
import { parseInstallation } from './parse.js';
import { isCanonicalBase64Of32Bytes, parseOwnerPublicKey, readOwnerSection } from './owner.js';

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

  it('refuses an over-long string before the secret screen', () => {
    expect(parseOwnerPublicKey(`-----BEGIN PRIVATE KEY-----${'x'.repeat(200)}`)).toEqual({
      ok: false,
      code: 'owner-key-too-long',
    });
    expect(parseOwnerPublicKey(`ghp_${'x'.repeat(200)}`)).toEqual({
      ok: false,
      code: 'owner-key-too-long',
    });
  });

  it('refuses a private-key-shaped string within the length cap', () => {
    expect(parseOwnerPublicKey(`-----BEGIN PRIVATE KEY-----${'x'.repeat(30)}`)).toEqual({
      ok: false,
      code: 'owner-key-secret-shape',
    });
  });

  it('refuses a credential-shaped string (ghp_) within the length cap', () => {
    expect(parseOwnerPublicKey(`ghp_${'x'.repeat(30)}`)).toEqual({
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

  it('caps its own input length before any base64 decoding', () => {
    expect(isCanonicalBase64Of32Bytes(VALID_KEY.repeat(5))).toBe(false);
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

  it('refuses a sparse array without traversing it', () => {
    const sparse: string[] = [];
    sparse[2] = VALID_KEY;
    expect(readOwnerSection(sparse)).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses an array-like object', () => {
    expect(readOwnerSection({ length: 1, 0: VALID_KEY })).toEqual({
      ok: false,
      code: 'owner-section-invalid',
    });
  });

  it('refuses an enormous sparse array before any key enumeration', () => {
    const enormous: string[] = [];
    enormous.length = 2 ** 32 - 1;
    enormous[0] = VALID_KEY;
    expect(readOwnerSection(enormous)).toEqual({ ok: false, code: 'owner-section-invalid' });
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

  it('refuses a Proxy whose getPrototypeOf trap throws', () => {
    const target = { publicKey: VALID_KEY };
    const proxy = new Proxy(target, {
      getPrototypeOf(): never {
        throw new Error('boom');
      },
    });
    expect(readOwnerSection(proxy)).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses a Proxy whose ownKeys trap throws', () => {
    const target = { publicKey: VALID_KEY };
    const proxy = new Proxy(target, {
      ownKeys(): never {
        throw new Error('boom');
      },
    });
    expect(readOwnerSection(proxy)).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses a Proxy whose getOwnPropertyDescriptor trap throws', () => {
    const target = { publicKey: VALID_KEY };
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(): never {
        throw new Error('boom');
      },
    });
    expect(readOwnerSection(proxy)).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('reads a Proxy over a valid section through no get trap', () => {
    let getTraps = 0;
    const target = { publicKey: VALID_KEY };
    const proxy = new Proxy(target, {
      get(): never {
        getTraps += 1;
        throw new Error('get trap must never run');
      },
    });
    const result = readOwnerSection(proxy);
    expect(result).toEqual({ ok: true, value: { publicKey: VALID_KEY } });
    expect(getTraps).toBe(0);
  });

  it('never runs a getter on the section root through a Proxy', () => {
    let getterRuns = 0;
    const target = {
      get publicKey(): string {
        getterRuns += 1;
        return VALID_KEY;
      },
    };
    const proxy = new Proxy(target, {});
    expect(readOwnerSection(proxy)).toEqual({ ok: false, code: 'owner-key-accessor' });
    expect(getterRuns).toBe(0);
  });
});

describe('owner parser hostile input', () => {
  it('refuses undefined as owner-key-invalid-type / owner-section-invalid', () => {
    expect(parseOwnerPublicKey(undefined)).toEqual({
      ok: false,
      code: 'owner-key-invalid-type',
    });
    expect(readOwnerSection(undefined)).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses null as owner-key-invalid-type / owner-section-invalid', () => {
    expect(parseOwnerPublicKey(null)).toEqual({
      ok: false,
      code: 'owner-key-invalid-type',
    });
    expect(readOwnerSection(null)).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses an array as an invalid type / non-record section', () => {
    expect(parseOwnerPublicKey([VALID_KEY])).toEqual({
      ok: false,
      code: 'owner-key-invalid-type',
    });
    expect(readOwnerSection([VALID_KEY])).toEqual({ ok: false, code: 'owner-section-invalid' });
  });

  it('refuses an own constructor key as prototype pollution', () => {
    const section = JSON.parse('{"constructor": 1, "publicKey": null}');
    expect(readOwnerSection(section)).toEqual({
      ok: false,
      code: 'owner-section-prototype-pollution',
    });
  });

  it('refuses an own prototype key as prototype pollution', () => {
    const section = JSON.parse('{"prototype": 1, "publicKey": null}');
    expect(readOwnerSection(section)).toEqual({
      ok: false,
      code: 'owner-section-prototype-pollution',
    });
  });

  it('accepts a frozen valid section', () => {
    const section = Object.freeze({ publicKey: VALID_KEY });
    expect(readOwnerSection(section)).toEqual({ ok: true, value: { publicKey: VALID_KEY } });
  });

  it('is not a constant verdict on repeated calls', () => {
    const valid = { publicKey: VALID_KEY };
    expect(readOwnerSection(valid)).toEqual({ ok: true, value: { publicKey: VALID_KEY } });
    expect(readOwnerSection(valid)).toEqual({ ok: true, value: { publicKey: VALID_KEY } });
    expect(readOwnerSection({})).toEqual({ ok: false, code: 'owner-key-required' });
  });

  it('never returns the input object itself', () => {
    const input = { publicKey: VALID_KEY };
    const result = readOwnerSection(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBe(input);
    }
  });
});

describe('derived model owner copy', () => {
  it('does not change the model when the input owner is mutated after derivation', () => {
    const parsed = parseInstallation({ schemaVersion: 1, owner: { publicKey: VALID_KEY } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const installation = parsed.installation;
    const outcome = deriveInstallationModel(installation);
    expect(outcome.model.owner).toEqual({ publicKey: VALID_KEY });
    const mutated = Buffer.alloc(32, 9).toString('base64');
    (installation.owner as { publicKey: string }).publicKey = mutated;
    expect(outcome.model.owner).toEqual({ publicKey: VALID_KEY });
    expect(outcome.model.owner).not.toBe(installation.owner);
  });

  it('does not change the model when a parsed v2 installation owner is mutated after derivation', () => {
    const parsed = parseInstallation({
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
      owner: { publicKey: VALID_KEY },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const installation = parsed.installation;
    const outcome = deriveInstallationModel(installation);
    expect(outcome.model.owner).toEqual({ publicKey: VALID_KEY });
    const mutated = Buffer.alloc(32, 9).toString('base64');
    (installation.owner as { publicKey: string }).publicKey = mutated;
    expect(outcome.model.owner).toEqual({ publicKey: VALID_KEY });
    expect(outcome.model.owner).not.toBe(installation.owner);
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

describe('parseInstallation accessor owner section', () => {
  const V2_BASE = {
    schemaVersion: 2,
    forge: { mode: 'none' },
  };

  it('refuses an accessor on the root owner property as owner-key-accessor', () => {
    let getterRuns = 0;
    const doc: Record<string, unknown> = { ...V2_BASE };
    Object.defineProperty(doc, 'owner', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return { publicKey: VALID_KEY };
      },
    });
    const result = parseInstallation(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('owner.publicKey: owner-key-accessor');
    }
    expect(getterRuns).toBe(0);
  });
});

describe('loadInstallation owner trust check', () => {
  const OWNER_V1 = { schemaVersion: 1, owner: { publicKey: VALID_KEY } };
  const OWNER_JSON = JSON.stringify(OWNER_V1);
  const REMEDY = '~/.config/fleet-v2/fleet.json';

  let tempDir: string;

  function writeInstallation(name: string, content: string): string {
    const file = join(tempDir, name);
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  }

  function expectUntrusted(errors: readonly string[], reasonPart: string): void {
    const message = errors.find((error) => error.includes('owner-key-installation-untrusted'));
    expect(message, JSON.stringify(errors)).toBeDefined();
    if (message === undefined) {
      return;
    }
    expect(message).toContain(reasonPart);
    expect(message).toContain(REMEDY);
    expect(message).toContain('FLEET_INSTALLATION_FILE');
  }

  function gitCheckout(dir: string): void {
    mkdirSync(join(dir, '.git'), { recursive: true });
  }

  function readErrors(result: ReturnType<typeof loadInstallation>): readonly string[] {
    expect(result.status).toBe('invalid');
    return result.status === 'invalid' ? result.errors : [];
  }

  function load(file: string, seam?: InstallationFileSeam) {
    return loadInstallation({ file, cwd: tempDir, seam });
  }

  function freshDir(): void {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-owner-trust-'));
  }

  it('loads the pinned key from a trusted installation file', () => {
    freshDir();
    const file = writeInstallation('fleet.json', OWNER_JSON);
    const result = load(file);
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.owner).toEqual({ publicKey: VALID_KEY });
    }
  });

  it('refuses a symlinked installation file (O_NOFOLLOW)', () => {
    freshDir();
    const target = writeInstallation('real.json', OWNER_JSON);
    const link = join(tempDir, 'link.json');
    symlinkSync(target, link);
    expectUntrusted(readErrors(load(link)), 'symlink');
  });

  it('refuses a file the process uid does not own (injectable seam)', () => {
    freshDir();
    const file = writeInstallation('fleet.json', OWNER_JSON);
    expectUntrusted(readErrors(load(file, { getuid: () => 12345 })), 'process uid');
  });

  it('refuses a non-regular file (injectable fstat seam)', () => {
    freshDir();
    const file = writeInstallation('fleet.json', OWNER_JSON);
    const seam = {
      fstat: () => ({ uid: process.getuid?.() ?? -1, mode: 0o100644, isFile: () => false }),
    };
    expectUntrusted(readErrors(load(file, seam)), 'not-a-regular-file');
  });

  it('refuses a group- or other-writable file', () => {
    freshDir();
    const file = writeInstallation('fleet.json', OWNER_JSON);
    chmodSync(file, 0o662);
    expectUntrusted(readErrors(load(file)), 'write bit');
  });

  it('refuses when the path identity no longer matches the opened handle (injectable stat seam)', () => {
    freshDir();
    const file = writeInstallation('fleet.json', OWNER_JSON);
    // The real `fstat` of the opened handle reports the real dev/ino; a
    // `stat` seam reporting a different identity stands in for a path swapped
    // in after the O_NOFOLLOW open. It must be refused before the containment
    // checks run.
    const seam: InstallationFileSeam = { stat: () => ({ dev: -1, ino: -1 }) };
    expectUntrusted(readErrors(load(file, seam)), 'identity-changed');
  });

  it('runs the trust check before the owner section is parsed for its key', () => {
    freshDir();
    gitCheckout(tempDir);
    // An invalid key inside an untrusted file must be refused as untrusted,
    // not as an owner-key parse error: the owner section is never parsed.
    const file = writeInstallation(
      'fleet.json',
      JSON.stringify({ schemaVersion: 1, owner: { publicKey: 'ghp_notakey' } }),
    );
    const errors = readErrors(load(file));
    expectUntrusted(errors, 'git checkout or worktree');
    expect(errors.some((error) => error.includes('owner-key-secret-shape'))).toBe(false);
  });

  it('refuses a file inside a hosts.*.worktreeRoot', () => {
    freshDir();
    const file = writeInstallation(
      'fleet.json',
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
            transport: 'local',
            worktreeRoot: tempDir,
            roles: ['orchestrator', 'lane-runner'],
            runner: { kind: 'opencode', port: 46000 },
          },
        },
        owner: { publicKey: VALID_KEY },
      }),
    );
    expectUntrusted(readErrors(load(file)), 'worktreeRoot');
  });

  it('refuses a file inside a symlinked hosts.*.worktreeRoot', () => {
    freshDir();
    const realDir = join(tempDir, 'real');
    mkdirSync(realDir);
    const link = join(tempDir, 'link');
    symlinkSync(realDir, link);
    const file = join(realDir, 'fleet.json');
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
            transport: 'local',
            worktreeRoot: link,
            roles: ['orchestrator', 'lane-runner'],
            runner: { kind: 'opencode', port: 46000 },
          },
        },
        owner: { publicKey: VALID_KEY },
      }),
      { mode: 0o600 },
    );
    expectUntrusted(readErrors(load(file)), 'worktreeRoot');
  });

  it('skips a non-existent hosts.*.worktreeRoot', () => {
    freshDir();
    const file = writeInstallation(
      'fleet.json',
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
            transport: 'local',
            worktreeRoot: join(tempDir, 'does-not-exist'),
            roles: ['orchestrator', 'lane-runner'],
            runner: { kind: 'opencode', port: 46000 },
          },
        },
        owner: { publicKey: VALID_KEY },
      }),
    );
    expect(load(file).status).toBe('loaded');
  });

  it('refuses <repo>/installation/fleet.json inside a git worktree and names the remedy', () => {
    freshDir();
    gitCheckout(tempDir);
    mkdirSync(join(tempDir, 'installation'));
    const file = writeInstallation(join('installation', 'fleet.json'), OWNER_JSON);
    expectUntrusted(readErrors(load(file)), 'git checkout or worktree');
  });

  it('refuses an installation file whose parent is a git checkout (explicit file)', () => {
    freshDir();
    gitCheckout(tempDir);
    const file = writeInstallation('fleet.json', OWNER_JSON);
    expectUntrusted(readErrors(load(file)), 'git checkout or worktree');
  });

  it('applies no trust check when the file carries no owner section', () => {
    freshDir();
    gitCheckout(tempDir);
    const file = writeInstallation('fleet.json', JSON.stringify({ schemaVersion: 1 }));
    const result = load(file, { getuid: () => 12345 });
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.installation.owner).toBeUndefined();
    }
  });

  it('still loads an ownerless file as absent when no file exists', () => {
    freshDir();
    const result = load(join(tempDir, 'missing.json'));
    expect(result.status).toBe('absent');
  });

  function mkfifoAvailable(): boolean {
    try {
      execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  const HAS_MKFIFO = mkfifoAvailable();

  it('refuses a FIFO promptly, before any read', (ctx) => {
    if (!HAS_MKFIFO) {
      ctx.skip();
    }
    freshDir();
    const file = join(tempDir, 'fleet.json');
    execFileSync('mkfifo', [file]);
    const start = Date.now();
    expectUntrusted(readErrors(load(file)), 'not-a-regular-file');
    // A blocking open would hang far longer than this; a prompt refusal is
    // well under a second on any supported host.
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('refuses a directory', () => {
    freshDir();
    const file = join(tempDir, 'fleet.json');
    mkdirSync(file);
    expectUntrusted(readErrors(load(file)), 'not-a-regular-file');
  });

  it('refuses an oversized regular file', () => {
    freshDir();
    const file = join(tempDir, 'fleet.json');
    // Just over the 1 MiB cap: a valid JSON prefix followed by padding so a
    // naive uncapped read would still parse (and a capped read must refuse).
    const content = `{"schemaVersion":1}${' '.repeat(1024 * 1024 + 1)}`;
    writeFileSync(file, content, { mode: 0o600 });
    expectUntrusted(readErrors(load(file)), 'size cap');
  });

  it('refuses a symlink whose target is a directory before reading it', () => {
    freshDir();
    const dir = join(tempDir, 'target-dir');
    mkdirSync(dir);
    const link = join(tempDir, 'fleet.json');
    symlinkSync(dir, link);
    expectUntrusted(readErrors(load(link)), 'not-a-regular-file');
  });
});
