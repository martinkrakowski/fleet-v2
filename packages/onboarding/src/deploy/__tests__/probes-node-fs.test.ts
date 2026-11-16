import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rename as renameReal } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNodeDeployFsProbes } from '../probes-node-fs.js';

type TreeSpec = { [name: string]: string | TreeSpec };

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function newDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'deploy-fs-'));
  return dir;
}

function makeTree(root: string, spec: TreeSpec): void {
  for (const [name, value] of Object.entries(spec)) {
    const entry = join(root, name);
    if (typeof value === 'string') {
      writeFileSync(entry, value);
    } else {
      mkdirSync(entry);
      makeTree(entry, value);
    }
  }
}

const LINK = 'link';
const FIRST = 'builds/one';
const SECOND = 'builds/two';

describe('node deploy filesystem probes', () => {
  describe('digestTree', () => {
    it('digestTree gives the same digest for the same tree twice', async () => {
      const root = newDir();
      makeTree(root, { a: 'x', sub: { b: 'yy' } });
      const { digestTree } = createNodeDeployFsProbes();
      const first = await digestTree(root);
      const second = await digestTree(root);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toBe(first);
    });

    it('digestTree gives the same digest for two separate directories with identical content', async () => {
      const spec: TreeSpec = { a: 'x', sub: { b: 'yy', empty: {} } };
      const one = newDir();
      const oneRoot = join(one, 'one');
      mkdirSync(oneRoot);
      makeTree(oneRoot, spec);
      const two = join(one, 'two');
      mkdirSync(two);
      makeTree(two, spec);
      const { digestTree } = createNodeDeployFsProbes();
      expect(await digestTree(two)).toBe(await digestTree(oneRoot));
    });

    it('digestTree changes when one byte of one file changes', async () => {
      const root = newDir();
      makeTree(root, { a: 'x' });
      const { digestTree } = createNodeDeployFsProbes();
      const before = await digestTree(root);
      writeFileSync(join(root, 'a'), 'y');
      expect(await digestTree(root)).not.toBe(before);
    });

    it('digestTree changes when a file is renamed', async () => {
      const root = newDir();
      makeTree(root, { a: 'x' });
      const { digestTree } = createNodeDeployFsProbes();
      const before = await digestTree(root);
      rmSync(join(root, 'a'));
      makeTree(root, { b: 'x' });
      expect(await digestTree(root)).not.toBe(before);
    });

    it('digestTree changes when bytes move from one file to the next', async () => {
      const root = newDir();
      makeTree(root, { a: 'xy', b: '' });
      const { digestTree } = createNodeDeployFsProbes();
      const before = await digestTree(root);
      rmSync(join(root, 'a'));
      rmSync(join(root, 'b'));
      makeTree(root, { a: 'x', b: 'y' });
      expect(await digestTree(root)).not.toBe(before);
    });

    it('digestTree counts an empty directory', async () => {
      const root = newDir();
      makeTree(root, { a: 'x' });
      const { digestTree } = createNodeDeployFsProbes();
      const before = await digestTree(root);
      mkdirSync(join(root, 'e'));
      expect(await digestTree(root)).not.toBe(before);
    });

    it('digestTree hashes an inner symlink by its text and never follows it', async () => {
      const root = newDir();
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'one');
      const tree = join(root, 'tree');
      mkdirSync(tree);
      symlinkSync(outside, join(tree, 'ln'));
      const { digestTree } = createNodeDeployFsProbes();
      const first = await digestTree(tree);
      writeFileSync(outside, 'completely different bytes');
      expect(await digestTree(tree)).toBe(first);
      rmSync(join(tree, 'ln'));
      symlinkSync(join(root, 'other.txt'), join(tree, 'ln'));
      expect(await digestTree(tree)).not.toBe(first);
    });

    it('digestTree through a root symlink equals the digest of the directory itself', async () => {
      const root = newDir();
      const tree = join(root, 'tree');
      mkdirSync(tree);
      makeTree(tree, { a: 'x', sub: { b: 'yy' } });
      symlinkSync(tree, join(root, 'via'));
      const { digestTree } = createNodeDeployFsProbes();
      expect(await digestTree(join(root, 'via'))).toBe(await digestTree(tree));
    });

    it('digestTree digests a single regular file', async () => {
      const root = newDir();
      writeFileSync(join(root, 'one.bin'), 'same bytes');
      writeFileSync(join(root, 'two.bin'), 'same bytes');
      writeFileSync(join(root, 'three.bin'), 'other bytes');
      const { digestTree } = createNodeDeployFsProbes();
      expect(await digestTree(join(root, 'two.bin'))).toBe(await digestTree(join(root, 'one.bin')));
      expect(await digestTree(join(root, 'three.bin'))).not.toBe(await digestTree(join(root, 'one.bin')));
    });

    it('digestTree rejects a missing path', async () => {
      const root = newDir();
      const { digestTree } = createNodeDeployFsProbes();
      await expect(digestTree(join(root, 'missing'))).rejects.toThrow();
    });

    it('digestTree rejects a dangling root symlink', async () => {
      const root = newDir();
      symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));
      const { digestTree } = createNodeDeployFsProbes();
      await expect(digestTree(join(root, 'dangling'))).rejects.toThrow();
    });

    it('digestTree rejects a tree that contains a socket', async () => {
      const net = await import('node:net');
      const root = newDir();
      const server = net.createServer();
      try {
        await new Promise<void>((resolveListen) => {
          server.once('listening', () => resolveListen());
          server.listen(join(root, 's'));
        });
        const { digestTree } = createNodeDeployFsProbes();
        await expect(digestTree(root)).rejects.toThrow();
      } finally {
        server.close();
      }
    });
  });

  describe('currentTarget', () => {
    it('currentTarget returns undefined when the link is absent', async () => {
      const root = newDir();
      const { currentTarget } = createNodeDeployFsProbes();
      expect(await currentTarget(join(root, 'absent'))).toBeUndefined();
    });

    it('currentTarget returns a relative link text unchanged', async () => {
      const root = newDir();
      symlinkSync('builds/one', join(root, 'link'));
      const { currentTarget } = createNodeDeployFsProbes();
      expect(await currentTarget(join(root, 'link'))).toBe('builds/one');
    });

    it('currentTarget rejects when the path is a regular file', async () => {
      const root = newDir();
      writeFileSync(join(root, 'file'), 'x');
      const { currentTarget } = createNodeDeployFsProbes();
      await expect(currentTarget(join(root, 'file'))).rejects.toThrow();
    });

    it('currentTarget rejects when the path is a directory', async () => {
      const root = newDir();
      mkdirSync(join(root, 'd'));
      const { currentTarget } = createNodeDeployFsProbes();
      await expect(currentTarget(join(root, 'd'))).rejects.toThrow();
    });
  });

  describe('repoint', () => {
    it('repoint creates the link when none exists and stores the target unchanged', async () => {
      const root = newDir();
      const link = join(root, LINK);
      const { repoint } = createNodeDeployFsProbes();
      await repoint(link, FIRST);
      expect(readlinkSync(link)).toBe(FIRST);
    });

    it('repoint replaces an existing link and leaves no temporary entry', async () => {
      const root = newDir();
      const link = join(root, LINK);
      mkdirSync(join(root, 'builds'));
      symlinkSync(FIRST, link);
      const { repoint } = createNodeDeployFsProbes();
      await repoint(link, SECOND);
      expect(readlinkSync(link)).toBe(SECOND);
      expect(readdirSync(root)).toEqual(['builds', 'link']);
    });

    it('repoint keeps the old link in place until the rename', async () => {
      const root = newDir();
      const link = join(root, LINK);
      symlinkSync(FIRST, link);
      const rename = vi.fn(async (from: string, to: string) => {
        expect(readlinkSync(link)).toBe(FIRST);
        expect(readlinkSync(from)).toBe(SECOND);
        expect(to).toBe(link);
        await renameReal(from, to);
      });
      const { repoint } = createNodeDeployFsProbes({ rename });
      await repoint(link, SECOND);
      expect(rename).toHaveBeenCalledTimes(1);
    });

    it('repoint removes the temporary link and keeps the old target when the rename fails', async () => {
      const root = newDir();
      const link = join(root, LINK);
      symlinkSync(FIRST, link);
      const error = new Error('rename refused');
      const rename = vi.fn(() => Promise.reject(error));
      const { repoint } = createNodeDeployFsProbes({ rename });
      await expect(repoint(link, SECOND)).rejects.toBe(error);
      expect(readlinkSync(link)).toBe(FIRST);
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false);
    });

    it('repoint rejects when the parent directory is missing', async () => {
      const root = newDir();
      const { repoint } = createNodeDeployFsProbes();
      await expect(repoint(join(root, 'missing', 'link'), SECOND)).rejects.toThrow();
    });

    it('repoint refuses to replace a regular file and leaves its bytes', async () => {
      const root = newDir();
      const link = join(root, LINK);
      writeFileSync(link, 'keep me');
      const rename = vi.fn(renameReal);
      const { repoint } = createNodeDeployFsProbes({ rename });
      await expect(repoint(link, SECOND)).rejects.toThrow();
      expect(rename).not.toHaveBeenCalled();
      expect(readFileSync(link, 'utf8')).toBe('keep me');
    });

    it('repoint refuses to replace a directory', async () => {
      const root = newDir();
      const link = join(root, LINK);
      mkdirSync(link);
      const rename = vi.fn(renameReal);
      const { repoint } = createNodeDeployFsProbes({ rename });
      await expect(repoint(link, SECOND)).rejects.toThrow();
      expect(rename).not.toHaveBeenCalled();
      expect(readdirSync(link)).toEqual([]);
    });

    it('repoint rejects a relative link, a link with a trailing slash and an empty target without touching the filesystem', async () => {
      const root = newDir();
      const link = join(root, LINK);
      const rename = vi.fn(renameReal);
      const { repoint } = createNodeDeployFsProbes({ rename });
      await expect(repoint('relative/link', SECOND)).rejects.toThrow();
      await expect(repoint(`${link}/`, SECOND)).rejects.toThrow();
      await expect(repoint(link, '')).rejects.toThrow();
      expect(rename).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    });
  });
});
