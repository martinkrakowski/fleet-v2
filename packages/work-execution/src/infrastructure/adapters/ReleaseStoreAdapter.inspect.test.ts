import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReleaseStoreAdapter } from './ReleaseStoreAdapter.adapter.js';

const sha = (digit: string): string => digit.repeat(40);
const A = sha('a');
const AT = '2026-11-01T09:00:00.000Z';
/** Mirrors `RELEASE_INSPECT_MAX_FILE_BYTES` in the adapter. */
const MAX_FILE_BYTES = 1_048_576;

const MIXED_FILES = [
  { present: true, quarantined: false },
  { present: false, quarantined: false },
  { present: true, quarantined: true },
] as const;

describe('ReleaseStoreAdapter.inspectReleaseFiles', () => {
  let tempDir: string;
  let root: string;
  let adapter: ReleaseStoreAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-inspect-'));
    root = path.join(tempDir, 'releases');
    adapter = new ReleaseStoreAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function verifiedWith(
    files: Readonly<Record<string, string | Buffer>>,
  ): Promise<{ sha: string; buildDir: string }> {
    const prepared = await adapter.prepare({ root, sha: A });
    if (prepared.outcome !== 'prepared') {
      throw new Error('prepare refused');
    }
    const entry = path.join(prepared.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(prepared.buildDir, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    expect(await adapter.markVerified({ root, sha: A, buildId: prepared.buildId, builtAtIso: AT })).toEqual({
      outcome: 'ok',
    });
    return { sha: A, buildDir: path.join(root, A) };
  }

  async function mixedRelease(): Promise<{
    input: { readonly root: string; readonly sha: string; readonly paths: readonly string[] };
    result: Awaited<ReturnType<ReleaseStoreAdapter['inspectReleaseFiles']>>;
  }> {
    const { sha: id } = await verifiedWith({
      'plain.test.ts': 'assert.equal(1, 1)\n',
      'wrapped.test.ts': 'it("x", quarantined(() => undefined))\n',
    });
    const input = { root, sha: id, paths: ['plain.test.ts', 'missing.test.ts', 'wrapped.test.ts'] };
    return { input, result: await adapter.inspectReleaseFiles(input) };
  }

  it('reports a present plain test file as present and not quarantined', async () => {
    const { sha: id } = await verifiedWith({ 'plain.test.ts': 'assert.equal(1, 1)\n' });
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: false }],
    });
  });

  it('reports a file containing quarantined( as quarantined', async () => {
    const { sha: id } = await verifiedWith({ 'wrapped.test.ts': 'it("x", quarantined(\n  () => undefined,\n));\n' });
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['wrapped.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: true }],
    });
  });

  it('reports an aliased import of quarantined as quarantined', async () => {
    const { sha: id } = await verifiedWith({
      'alias.test.ts': 'import { quarantined as q } from "./quarantine.js";\n',
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['alias.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: true }],
    });
  });

  it('reports a missing path as not present', async () => {
    const { sha: id } = await verifiedWith({});
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['missing.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: false, quarantined: false }],
    });
  });

  it('reports a path under a missing directory as not present', async () => {
    const { sha: id } = await verifiedWith({});
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['missing/dir/file.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: false, quarantined: false }],
    });
  });

  it('reports a symlink at the path as present and unjudgeable', async () => {
    const { sha: id, buildDir } = await verifiedWith({ 'real.test.ts': 'quarantined(\n' });
    await fs.symlink('real.test.ts', path.join(buildDir, 'link.test.ts'));
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['link.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: null }],
    });
  });

  it('reports a file reached through an in-build directory symlink pointing outside the build as unjudgeable', async () => {
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.test.ts'), 'quarantined(');
    const { sha: id, buildDir } = await verifiedWith({});
    await fs.symlink(outside, path.join(buildDir, 'escape'));
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['escape/secret.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: null }],
    });
  });

  it('reports a directory at the path as present and unjudgeable', async () => {
    const { sha: id, buildDir } = await verifiedWith({});
    await fs.mkdir(path.join(buildDir, 'suite'));
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['suite'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: null }],
    });
  });

  it('reports a file over the byte cap as unjudgeable even when it contains quarantined', async () => {
    const marker = 'quarantined';
    const bytes = Buffer.alloc(MAX_FILE_BYTES + marker.length, 'x');
    bytes.write(marker, MAX_FILE_BYTES);
    const { sha: id } = await verifiedWith({ 'big.test.ts': bytes });
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['big.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: null }],
    });
  });

  it('does not report an outside file as clean when its directory is swapped for a symlink between the check and the open', async () => {
    const clean = 'assert.equal(1, 1)\n';
    expect(clean.includes('quarantined')).toBe(false);
    const outside = path.join(tempDir, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'file.test.ts'), clean);
    const { sha: id, buildDir } = await verifiedWith({ 'dir/file.test.ts': 'quarantined(\n' });
    const parent = path.join(buildDir, 'dir');
    const realpath = fs.realpath.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, 'realpath').mockImplementation(async (candidate: Parameters<typeof fs.realpath>[0]) => {
      const resolved = await realpath(candidate);
      if (!swapped && typeof candidate === 'string' && path.resolve(candidate) === path.resolve(parent)) {
        swapped = true;
        await fs.rm(parent, { recursive: true, force: true });
        await fs.symlink(outside, parent);
      }
      return resolved;
    });
    try {
      // The open follows the swapped parent. The outside file has no marker, so
      // accepting those bytes would report quarantined: false. The re-check must
      // refuse it (null). The in-build file contains the marker, so a missed swap
      // would report true instead of null.
      expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['dir/file.test.ts'] })).toEqual({
        outcome: 'read',
        files: [{ present: true, quarantined: null }],
      });
      expect(swapped).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports unjudgeable when the opened handle inode differs from the re-resolved path', async () => {
    const clean = 'assert.equal(1, 1)\n';
    expect(clean.includes('quarantined')).toBe(false);
    const { sha: id, buildDir } = await verifiedWith({ 'plain.test.ts': clean });
    const target = path.join(buildDir, 'plain.test.ts');
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) !== path.resolve(target)) {
        return handle;
      }
      return shiftedIno(handle);
    });
    try {
      // Path stays inside the build and the bytes are clean. Dropping the
      // dev/ino comparison would report quarantined: false.
      expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['plain.test.ts'] })).toEqual({
        outcome: 'read',
        files: [{ present: true, quarantined: null }],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports quarantined when the marker appears after the first short read', async () => {
    const firstChunk = 'x'.repeat(8);
    const marker = 'quarantined';
    expect(firstChunk.includes(marker)).toBe(false);
    const body = `${firstChunk}${marker}\n`;
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_FILE_BYTES);
    const { sha: id, buildDir } = await verifiedWith({ 'late.test.ts': body });
    const target = path.join(buildDir, 'late.test.ts');
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (path.resolve(String(args[0])) !== path.resolve(target)) {
        return handle;
      }
      return shortReads(handle, firstChunk.length);
    });
    try {
      // Each read returns at most the first chunk, which has no marker. One
      // read would report quarantined: false; the loop must keep going.
      expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['late.test.ts'] })).toEqual({
        outcome: 'read',
        files: [{ present: true, quarantined: true }],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports three mixed paths in request order, which a constant verdict cannot', async () => {
    const { result } = await mixedRelease();
    expect(result).toEqual({ outcome: 'read', files: MIXED_FILES });
    if (result.outcome === 'read') {
      expect(new Set(result.files.map((file) => JSON.stringify(file))).size).toBe(3);
    }
  });

  it('does not echo the input, which an identity function would', async () => {
    const { input, result } = await mixedRelease();
    expect(result).toEqual({ outcome: 'read', files: MIXED_FILES });
    expect(result).not.toEqual(input);
    expect(result).not.toEqual(input.paths);
  });

  it('reports not-found for an unverified build with no marker', async () => {
    await fs.mkdir(path.join(root, A), { recursive: true });
    await fs.writeFile(path.join(root, A, 'plain.test.ts'), 'ok\n');
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'not-found',
    });
  });

  it('reports not-found when the build path is a symlink', async () => {
    const realBuild = path.join(tempDir, 'real-build');
    await fs.mkdir(realBuild);
    await fs.writeFile(path.join(realBuild, 'a.test.ts'), 'ok\n');
    await fs.writeFile(
      path.join(realBuild, '.fleet-release-verified'),
      JSON.stringify({ version: 1, sha: A, builtAtIso: AT }),
    );
    await fs.mkdir(root);
    await fs.symlink(realBuild, path.join(root, A));
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['a.test.ts'] })).toEqual({ outcome: 'not-found' });
  });

  it('reports not-found when the sha has no build', async () => {
    await fs.mkdir(root);
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['a.test.ts'] })).toEqual({ outcome: 'not-found' });
  });

  it('reports unreadable for a corrupt marker', async () => {
    await fs.mkdir(path.join(root, A), { recursive: true });
    await fs.writeFile(path.join(root, A, '.fleet-release-verified'), '{not json');
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['a.test.ts'] })).toEqual({ outcome: 'unreadable' });
  });

  it('reports unreadable when the marker names a different sha', async () => {
    await fs.mkdir(path.join(root, A), { recursive: true });
    await fs.writeFile(
      path.join(root, A, '.fleet-release-verified'),
      JSON.stringify({ version: 1, sha: sha('b'), builtAtIso: AT }),
    );
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['a.test.ts'] })).toEqual({ outcome: 'unreadable' });
  });

  it('reports unreadable when the build directory is replaced between the marker read and the file reads', async () => {
    await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const buildDir = path.join(root, A);
    let swapped = false;
    hookRealpath(async (target) => {
      if (!swapped && target === buildDir) {
        swapped = true;
        // A concurrent install replaces the whole verified tree, marker
        // included, after the marker was accepted and before the files.
        // Rename (as a real install does) keeps the old inode alive, so the
        // new directory cannot reuse its identity.
        await fs.rename(buildDir, buildDir + '.replaced-old');
        await fs.mkdir(buildDir);
        await fs.writeFile(
          path.join(buildDir, '.fleet-release-verified'),
          JSON.stringify({ version: 1, sha: A, builtAtIso: AT }),
        );
        await fs.writeFile(path.join(buildDir, 'plain.test.ts'), 'quarantined(\n');
      }
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'unreadable',
    });
    expect(swapped).toBe(true);
  });

  it('reports unreadable when the build directory identity differs between the two lstats around the first marker read', async () => {
    await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const buildDir = path.join(root, A);
    let swapped = false;
    hookRealpath(async (target) => {
      if (!swapped && target === buildDir) {
        swapped = true;
        // A concurrent install replaces the whole tree, marker included,
        // after the first lstat pinned it and before the marker read. The
        // replacement carries its own valid marker for the same sha, so only
        // the sandwiched identity check can refuse it. Rename (as a real
        // install does) keeps the old inode alive, so the new directory cannot
        // reuse its identity.
        await fs.rename(buildDir, buildDir + '.replaced-old');
        await fs.mkdir(buildDir);
        await fs.writeFile(
          path.join(buildDir, '.fleet-release-verified'),
          JSON.stringify({ version: 1, sha: A, builtAtIso: AT }),
        );
        await fs.writeFile(path.join(buildDir, 'plain.test.ts'), 'quarantined(\n');
      }
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'unreadable',
    });
    expect(swapped).toBe(true);
  });

  it('reports unreadable when the marker builtAtIso is changed to another valid value during inspection', async () => {
    await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const markerFile = path.join(root, A, '.fleet-release-verified');
    let changed = false;
    hookRealpath(async (target) => {
      if (!changed && target === path.join(root, A, 'plain.test.ts')) {
        changed = true;
        // Same sha, still a valid ISO value: the final re-read is accepted as
        // a marker, so only the equality with the marker accepted at the
        // start can refuse the call.
        await fs.writeFile(
          markerFile,
          JSON.stringify({ version: 1, sha: A, builtAtIso: '2026-11-02T09:00:00.000Z' }),
        );
      }
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'unreadable',
    });
    expect(changed).toBe(true);
  });

  it('reports unreadable when the marker is changed during the read', async () => {
    await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const marker = path.join(root, A, '.fleet-release-verified');
    let changed = false;
    hookRealpath(async (target) => {
      if (!changed && target === path.join(root, A)) {
        changed = true;
        await fs.writeFile(marker, JSON.stringify({ version: 1, sha: sha('b'), builtAtIso: AT }));
      }
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'unreadable',
    });
    expect(changed).toBe(true);
  });

  it('reports unjudgeable when a second realpath differs from the first for the opened file', async () => {
    const { sha: id } = await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const target = path.join(root, A, 'plain.test.ts');
    let resolutions = 0;
    hookRealpath((resolved) => {
      if (resolved === target) {
        resolutions += 1;
        if (resolutions === 2) {
          return path.join(root, A, 'plain.other.test.ts');
        }
      }
      return undefined;
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: ['plain.test.ts'] })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: null }],
    });
    expect(resolutions).toBeGreaterThanOrEqual(2);
  });

  it('reads a proxied paths length exactly once and never iterates past the first length', async () => {
    const { sha: id } = await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const paths = ['plain.test.ts'];
    let lengthReads = 0;
    const proxied = new Proxy(paths, {
      get(target, key, receiver) {
        if (key === 'length') {
          lengthReads += 1;
          if (lengthReads > 1) {
            return 99;
          }
        }
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') {
          lengthReads += 1;
          if (lengthReads > 1) {
            return { value: 99, writable: true, enumerable: true, configurable: true };
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(await adapter.inspectReleaseFiles({ root, sha: id, paths: proxied })).toEqual({
      outcome: 'read',
      files: [{ present: true, quarantined: false }],
    });
    expect(lengthReads).toBe(1);
  });

  const malformed: ReadonlyArray<readonly [string, (dir: string) => unknown]> = [
    ['a relative root', () => ({ root: 'releases', sha: A, paths: ['a.test.ts'] })],
    ['a 39-hex sha', (dir) => ({ root: dir, sha: 'a'.repeat(39), paths: ['a.test.ts'] })],
    ['a path with ..', (dir) => ({ root: dir, sha: A, paths: ['dir/../secret.ts'] })],
    ['a leading slash', (dir) => ({ root: dir, sha: A, paths: ['/secret.ts'] })],
    ['a backslash', (dir) => ({ root: dir, sha: A, paths: ['dir\\file.ts'] })],
    [
      '17 paths',
      (dir) => ({
        root: dir,
        sha: A,
        paths: Array.from({ length: 17 }, (_unused, index) => `f${index}.ts`),
      }),
    ],
    ['an empty paths list', (dir) => ({ root: dir, sha: A, paths: [] as readonly string[] })],
    ['a path longer than 256 characters', (dir) => ({ root: dir, sha: A, paths: ['a'.repeat(257)] })],
  ];

  it.each(malformed)('reports unreadable for %s', async (_label, build) => {
    expect(await adapter.inspectReleaseFiles(build(root))).toEqual({ outcome: 'unreadable' });
  });

  it('refuses null', async () => {
    expect(await adapter.inspectReleaseFiles(null)).toEqual({ outcome: 'unreadable' });
  });

  it('refuses undefined', async () => {
    expect(await adapter.inspectReleaseFiles(undefined)).toEqual({ outcome: 'unreadable' });
  });

  it('refuses a number where root must be a string', async () => {
    expect(await adapter.inspectReleaseFiles({ root: 1, sha: A, paths: ['a.test.ts'] })).toEqual({
      outcome: 'unreadable',
    });
  });

  it('refuses a string where paths must be a list', async () => {
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: 'a.test.ts' })).toEqual({ outcome: 'unreadable' });
  });

  it('refuses a non-iterable object where paths must be a list', async () => {
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: { file: 'a.test.ts' } })).toEqual({
      outcome: 'unreadable',
    });
  });

  it('refuses a sparse array hole', async () => {
    const paths = new Array(1);
    expect(Object.getOwnPropertyDescriptor(paths, '0')).toBeUndefined();
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths })).toEqual({ outcome: 'unreadable' });
  });

  it('refuses an array-like object where a list is due', async () => {
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths: { length: 1, 0: 'a.test.ts' } })).toEqual({
      outcome: 'unreadable',
    });
  });

  it('refuses an enormous sparse array of length 2**32 - 1 before traversal', async () => {
    const paths = ['a.test.ts'];
    paths.length = 2 ** 32 - 1;
    expect(Object.getOwnPropertyDescriptor(paths, 'length')?.value).toBe(2 ** 32 - 1);
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths })).toEqual({ outcome: 'unreadable' });
  });

  it('refuses a getter on root without calling it', async () => {
    let calls = 0;
    const input = { sha: A, paths: ['a.test.ts'] };
    Object.defineProperty(input, 'root', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return root;
      },
    });
    expect(await adapter.inspectReleaseFiles(input)).toEqual({ outcome: 'unreadable' });
    expect(calls).toBe(0);
  });

  it('refuses a getter on a paths item without calling it', async () => {
    let calls = 0;
    const paths = ['a.test.ts'];
    Object.defineProperty(paths, '0', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'a.test.ts';
      },
    });
    expect(typeof Object.getOwnPropertyDescriptor(paths, '0')?.get).toBe('function');
    expect(await adapter.inspectReleaseFiles({ root, sha: A, paths })).toEqual({ outcome: 'unreadable' });
    expect(calls).toBe(0);
  });

  it('yields the plain result for a Proxy over valid input and runs no get trap', async () => {
    const { sha: id } = await verifiedWith({ 'plain.test.ts': 'ok\n' });
    const input = { root, sha: id, paths: ['plain.test.ts'] };
    const plain = await adapter.inspectReleaseFiles(input);
    let gets = 0;
    const proxied = new Proxy(input, {
      get(target, key, receiver) {
        gets += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const viaProxy = await adapter.inspectReleaseFiles(proxied);
    expect(gets).toBe(0);
    expect(viaProxy).toEqual(plain);
    expect(viaProxy).toEqual({ outcome: 'read', files: [{ present: true, quarantined: false }] });
  });

  it('reports unreadable when a Proxy ownKeys trap throws', async () => {
    const input = { root, sha: A, paths: ['a.test.ts'] };
    const proxied = new Proxy(input, {
      ownKeys() {
        throw new Error('ownKeys refused');
      },
    });
    expect(await adapter.inspectReleaseFiles(proxied)).toEqual({ outcome: 'unreadable' });
  });

  it('refuses a JSON.parse input with an own __proto__ key', async () => {
    const parsed = jsonWithOwnKey('__proto__');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(await adapter.inspectReleaseFiles(parsed)).toEqual({ outcome: 'unreadable' });
  });

  it('refuses a JSON.parse input with an own constructor key', async () => {
    const parsed = jsonWithOwnKey('constructor');
    expect(Object.hasOwn(parsed, 'constructor')).toBe(true);
    expect(await adapter.inspectReleaseFiles(parsed)).toEqual({ outcome: 'unreadable' });
  });

  it('refuses a JSON.parse input with an own prototype key', async () => {
    const parsed = jsonWithOwnKey('prototype');
    expect(Object.hasOwn(parsed, 'prototype')).toBe(true);
    expect(await adapter.inspectReleaseFiles(parsed)).toEqual({ outcome: 'unreadable' });
  });

  it('returns no root, sha or path text', async () => {
    const relative = 'pkg/zzFeatureName.test.ts';
    const { sha: id } = await verifiedWith({ [relative]: 'ok\n' });
    const result = await adapter.inspectReleaseFiles({ root, sha: id, paths: [relative] });
    expect(result).toEqual({ outcome: 'read', files: [{ present: true, quarantined: false }] });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(root);
    expect(encoded).not.toContain(id);
    expect(encoded).not.toContain(relative);
    expect(encoded).not.toContain('zzFeatureName');
  });

  it('leaves the build directory listing and every file byte unchanged', async () => {
    const { sha: id, buildDir } = await verifiedWith({
      'plain.test.ts': 'assert.equal(1, 1)\n',
      'wrapped.test.ts': 'quarantined(\n',
    });
    const before = await snapshotBuild(buildDir);
    expect(
      await adapter.inspectReleaseFiles({
        root,
        sha: id,
        paths: ['plain.test.ts', 'missing.test.ts', 'wrapped.test.ts'],
      }),
    ).toEqual({ outcome: 'read', files: MIXED_FILES });
    expect(await snapshotBuild(buildDir)).toEqual(before);
  });

  function jsonWithOwnKey(key: string): object {
    const parsed: unknown = JSON.parse(
      `{"root":${JSON.stringify(root)},"sha":"${A}","paths":["a.test.ts"],${JSON.stringify(key)}:1}`,
    );
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('json did not parse to an object');
    }
    return parsed;
  }
});

type Opened = Awaited<ReturnType<typeof fs.open>>;

/**
 * A test hook around `fs.realpath`: the hook runs after each real resolution
 * and may return a replacement result (a swap, a changed tree, a diverging
 * second resolution). Restored by `afterEach` via `restoreAllMocks`.
 */
function hookRealpath(hook: (target: string, result: string) => string | void | Promise<string | void>): void {
  const original = fs.realpath.bind(fs) as unknown as (target: string) => Promise<string>;
  const wrapped = (async (target: string) => {
    const result = await original(target);
    const override = await hook(target, result);
    return typeof override === 'string' ? override : result;
  }) as unknown as typeof fs.realpath;
  vi.spyOn(fs, 'realpath').mockImplementation(wrapped);
}

/** The opened descriptor's inode is not the inode of the path on disk. */
function shiftedIno(handle: Opened): Opened {
  return new Proxy(handle, {
    get(opened, key) {
      if (key === 'stat') {
        return async () => {
          const stat = await handle.stat();
          return new Proxy(stat, {
            get(node, property, receiver) {
              if (property === 'ino') {
                return node.ino + 1;
              }
              const value: unknown = Reflect.get(node, property, receiver);
              return typeof value === 'function' ? (value as (...methodArgs: unknown[]) => unknown).bind(node) : value;
            },
          });
        };
      }
      return bindMember(opened, key);
    },
  }) as Opened;
}

/** Each `read` returns at most `maxBytes`, including a short last chunk. */
function shortReads(handle: Opened, maxBytes: number): Opened {
  return new Proxy(handle, {
    get(opened, key) {
      if (key === 'read') {
        return (buffer: Buffer, offset?: number, length?: number, position?: number | null) => {
          const start = typeof offset === 'number' ? offset : 0;
          const want = typeof length === 'number' ? Math.min(length, maxBytes) : maxBytes;
          const at = typeof position === 'number' ? position : 0;
          return handle.read(buffer, start, want, at);
        };
      }
      return bindMember(opened, key);
    },
  }) as Opened;
}

function bindMember(opened: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(opened, key);
  return typeof value === 'function' ? (value as (...methodArgs: unknown[]) => unknown).bind(opened) : value;
}

interface BuildSnapshot {
  readonly listing: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly links: Readonly<Record<string, string>>;
}

async function snapshotBuild(dir: string): Promise<BuildSnapshot> {
  const listing: string[] = [];
  const files: Record<string, string> = {};
  const links: Record<string, string> = {};
  await walkBuild(dir, '', listing, files, links);
  listing.sort();
  return { listing, files, links };
}

async function walkBuild(
  dir: string,
  prefix: string,
  listing: string[],
  files: Record<string, string>,
  links: Record<string, string>,
): Promise<void> {
  const names = (await fs.readdir(dir)).sort();
  for (const name of names) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    listing.push(relative);
    const full = path.join(dir, name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      links[relative] = await fs.readlink(full);
      continue;
    }
    if (stat.isDirectory()) {
      await walkBuild(full, relative, listing, files, links);
      continue;
    }
    if (stat.isFile()) {
      files[relative] = (await fs.readFile(full)).toString('base64');
    }
  }
}
