// Tests for the root `vitest.global-tmp.ts` run-scoped temp root helper.
//
// The module lives outside `packages/tooling/src`, and this package's
// tsconfig sets `rootDir: "src"`, so a static import of the relative path
// would fail with TS6059. The module is therefore loaded through a dynamic
// import with a variable specifier and its shape asserted via a declared
// interface (no `any`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Variable specifier (never a static import) so TS6059 cannot fire under the
// package's `rootDir: "src"`; resolved against this file's URL so the root
// module is found regardless of the vitest working directory.
const globalTmpModulePath = '../../../../vitest.global-tmp.ts';

interface GlobalTmpModule {
  removeRunTmpDir: (dir: string, parentDir: string) => void;
  globalSetup?: () => () => void;
  default?: () => () => void;
}
const globalTmpModuleUrl = pathToFileURL(
  join(import.meta.dirname, globalTmpModulePath),
).href;

const loadGlobalTmpModule = (): Promise<GlobalTmpModule> =>
  import(/* @vite-ignore */ globalTmpModuleUrl) as Promise<GlobalTmpModule>;

let globalTmp: GlobalTmpModule | undefined;

const getModule = async (): Promise<GlobalTmpModule> => {
  globalTmp ??= await loadGlobalTmpModule();
  return globalTmp;
};

const prevTmpdirValue = process.env.TMPDIR;
const hadPrevTmpdir = Object.prototype.hasOwnProperty.call(process.env, 'TMPDIR');

afterEach(() => {
  if (hadPrevTmpdir) {
    process.env.TMPDIR = prevTmpdirValue;
  } else {
    delete process.env.TMPDIR;
  }
});

const globalSetupFn = (mod: GlobalTmpModule): (() => () => void) => {
  const fn = mod.globalSetup ?? mod.default;
  if (typeof fn !== 'function') {
    throw new Error('vitest.global-tmp module exposes no globalSetup function');
  }
  return fn;
};

describe('vitest.global-tmp globalSetup', () => {
  it('creates a fleet-vitest- directory under the incoming tmpdir', async () => {
    const mod = await getModule();
    const parent = mkdtempSync(join(tmpdir(), 'global-tmp-test-'));
    process.env.TMPDIR = parent;
    try {
      const teardown = globalSetupFn(mod)();
      const runDir = process.env.TMPDIR as string;
      expect(runDir.startsWith(join(parent, 'fleet-vitest-'))).toBe(true);
      teardown();
      expect(() => rmSync(runDir, { force: true })).not.toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('sets TMPDIR so os.tmpdir() returns the run directory while active', async () => {
    const mod = await getModule();
    const before = tmpdir();
    const teardown = globalSetupFn(mod)();
    try {
      expect(tmpdir()).toBe(process.env.TMPDIR);
      expect(process.env.TMPDIR).not.toBe(before);
    } finally {
      teardown();
    }
    expect(tmpdir()).toBe(before);
  });

  it('teardown removes the run directory including nested files', async () => {
    const mod = await getModule();
    const teardown = globalSetupFn(mod)();
    const runDir = process.env.TMPDIR as string;
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(runDir, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(runDir, 'nested', 'deeper', 'file.txt'), 'x');
    teardown();
    const { existsSync } = await import('node:fs');
    expect(existsSync(runDir)).toBe(false);
  });

  it('teardown restores a previously set TMPDIR', async () => {
    const mod = await getModule();
    const custom = mkdtempSync(join(tmpdir(), 'global-tmp-custom-'));
    process.env.TMPDIR = custom;
    const teardown = globalSetupFn(mod)();
    expect(process.env.TMPDIR).not.toBe(custom);
    teardown();
    expect(process.env.TMPDIR).toBe(custom);
    rmSync(custom, { recursive: true, force: true });
  });

  it('teardown deletes TMPDIR when it was unset before setup', async () => {
    const mod = await getModule();
    delete process.env.TMPDIR;
    const teardown = globalSetupFn(mod)();
    teardown();
    expect(Object.prototype.hasOwnProperty.call(process.env, 'TMPDIR')).toBe(false);
  });

  it('teardown does not throw when the run directory was already removed', async () => {
    const mod = await getModule();
    const teardown = globalSetupFn(mod)();
    const runDir = process.env.TMPDIR as string;
    rmSync(runDir, { recursive: true, force: true });
    expect(() => teardown()).not.toThrow();
  });
});

describe('removeRunTmpDir', () => {
  it('removes a directory contained in the parent', async () => {
    const mod = await getModule();
    const parent = mkdtempSync(join(tmpdir(), 'global-tmp-test-'));
    const child = mkdtempSync(join(parent, 'child-'));
    mod.removeRunTmpDir(child, parent);
    const { existsSync } = await import('node:fs');
    expect(existsSync(child)).toBe(false);
    expect(existsSync(parent)).toBe(true);
    rmSync(parent, { recursive: true, force: true });
  });

  it('refuses to remove a path outside the created parent directory', async () => {
    const mod = await getModule();
    const parent = mkdtempSync(join(tmpdir(), 'global-tmp-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'global-tmp-outside-'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => mod.removeRunTmpDir(outside, parent)).not.toThrow();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = String(stderrSpy.mock.calls[0]?.[0]);
      expect(line).toContain(outside);
      const { existsSync } = await import('node:fs');
      expect(existsSync(outside)).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      rmSync(outside, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses to remove the parent directory itself', async () => {
    const mod = await getModule();
    const parent = mkdtempSync(join(tmpdir(), 'global-tmp-test-'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mod.removeRunTmpDir(parent, parent);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const { existsSync } = await import('node:fs');
      expect(existsSync(parent)).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('swallows removal errors and writes one stderr line naming the directory', async () => {
    const mod = await getModule();
    const parent = mkdtempSync(join(tmpdir(), 'global-tmp-test-'));
    // A path whose removal fails: a directory where a child component is a
    // non-empty file path masquerading as a directory — instead, use a
    // non-existent nested path under a read-only substitute. Simplest
    // reliable failure: rmSync on a path inside a removed parent still
    // succeeds with force:true, so force an error by targeting a path whose
    // parent is a file, not a directory.
    const blocker = join(parent, 'file');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(blocker, 'x');
    const target = join(blocker, 'child');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => mod.removeRunTmpDir(target, parent)).not.toThrow();
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const line = String(stderrSpy.mock.calls[0]?.[0]);
      expect(line).toContain(target);
    } finally {
      stderrSpy.mockRestore();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
