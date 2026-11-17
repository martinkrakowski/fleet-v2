import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
