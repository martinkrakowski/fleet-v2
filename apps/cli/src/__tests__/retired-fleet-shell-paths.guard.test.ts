import { afterEach, describe, expect, it } from "vitest";
import {
  lstat,
  readdir as defaultReaddir,
  readFile as defaultReadFile,
} from "node:fs/promises";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The fourtee fleet-repo shell paths whose "Retired outright?" cell in the
 * cutover plan (§1) is a plain `Yes`. These are the needles the guard scans
 * for. See `docs/planning/2026-11-03_cutover-plan.md`.
 */
export const RETIRED_FLEET_SHELL_PATHS = [
  "tools/fleet-v2-orchestrator/train/common.sh",
  "tools/fleet-v2-orchestrator/lane/auto-record.sh",
  "tools/fleet-v2-orchestrator/lane/conductor-locked.sh",
  "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
  "tools/fleet-v2-orchestrator/lane/drive-runs.sh",
  "tools/fleet-v2-orchestrator/lane/lane-rebase.sh",
  "tools/fleet-v2-orchestrator/lane/merge-main.sh",
  "tools/fleet-v2-orchestrator/lane/record-merged.sh",
  "tools/fleet-v2-orchestrator/lane/tr-brief.sh",
  "tools/fleet-v2-orchestrator/lane/tr-chain.sh",
  "tools/fleet-v2-orchestrator/lane/tr-cont.sh",
  "tools/fleet-v2-orchestrator/lane/tr-gemini.sh",
  "tools/fleet-v2-orchestrator/lane/tr-lane.sh",
  "tools/fleet-v2-orchestrator/lane/tr-review.sh",
] as const;

export type RetiredPathScanErrorCode =
  | "empty-or-invalid-list"
  | "invalid-roots"
  | "unreadable-tree"
  | "symlink-refused"
  | "unreadable-file"
  | "file-too-large"
  | "budget-exhausted"
  | "empty-tree";

export class RetiredPathScanError extends Error {
  readonly code: RetiredPathScanErrorCode;

  constructor(code: RetiredPathScanErrorCode) {
    super(`RetiredPathScanError: ${code}`);
    this.name = "RetiredPathScanError";
    this.code = code;
  }
}

interface ScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  readdir?: (p: string, o: { withFileTypes: true }) => Promise<Dirent[]>;
  readFile?: (p: string) => Promise<Buffer | Uint8Array>;
}

function validateNeedles(needlesIn: unknown): string[] {
  if (!Array.isArray(needlesIn)) {
    throw new RetiredPathScanError("empty-or-invalid-list");
  }
  if (needlesIn.length === 0 || needlesIn.length > 64) {
    throw new RetiredPathScanError("empty-or-invalid-list");
  }
  const out: string[] = [];
  for (let i = 0; i < needlesIn.length; i++) {
    let value: unknown;
    try {
      value = needlesIn[i];
    } catch {
      throw new RetiredPathScanError("empty-or-invalid-list");
    }
    if (typeof value !== "string") {
      throw new RetiredPathScanError("empty-or-invalid-list");
    }
    if (Buffer.byteLength(value, "utf8") > 256) {
      throw new RetiredPathScanError("empty-or-invalid-list");
    }
    out.push(value);
  }
  return out;
}

function validateRoots(rootsIn: unknown): string[] {
  if (!Array.isArray(rootsIn)) {
    throw new RetiredPathScanError("invalid-roots");
  }
  if (rootsIn.length === 0 || rootsIn.length > 8) {
    throw new RetiredPathScanError("invalid-roots");
  }
  const out: string[] = [];
  for (let i = 0; i < rootsIn.length; i++) {
    const value = rootsIn[i];
    if (typeof value !== "string") {
      throw new RetiredPathScanError("invalid-roots");
    }
    out.push(value);
  }
  return out;
}

export async function scanForRetiredFleetShellPaths(
  needlesIn: unknown,
  repoRoot: string,
  rootsIn: unknown,
  options?: ScanOptions,
): Promise<{ file: string; needle: string }[]> {
  const needles = validateNeedles(needlesIn);
  const roots = validateRoots(rootsIn);
  const maxFiles = options?.maxFiles ?? 4096;
  const maxFileBytes = options?.maxFileBytes ?? 1_048_576;
  const readdir = options?.readdir ?? defaultReaddir;
  const readFile = options?.readFile ?? defaultReadFile;

  // The repository root is pinned by its package.json name.
  let pkgRaw: Buffer | Uint8Array;
  try {
    pkgRaw = await defaultReadFile(path.join(repoRoot, "package.json"));
  } catch {
    throw new RetiredPathScanError("unreadable-tree");
  }
  if (!(pkgRaw instanceof Uint8Array)) {
    throw new RetiredPathScanError("unreadable-tree");
  }
  let pkgParsed: unknown;
  try {
    pkgParsed = JSON.parse(Buffer.from(pkgRaw).toString("utf8"));
  } catch {
    throw new RetiredPathScanError("unreadable-tree");
  }
  if (
    typeof pkgParsed !== "object" ||
    pkgParsed === null ||
    (pkgParsed as { name?: unknown }).name !== "fleet"
  ) {
    throw new RetiredPathScanError("unreadable-tree");
  }

  const needleBuffers = needles.map((n) => Buffer.from(n, "utf8"));
  const hits: { file: string; needle: string }[] = [];
  let totalFiles = 0;

  for (const root of roots) {
    const rootAbs = path.join(repoRoot, root);

    let st;
    try {
      st = await lstat(rootAbs);
    } catch {
      throw new RetiredPathScanError("unreadable-tree");
    }
    if (st.isSymbolicLink()) {
      throw new RetiredPathScanError("symlink-refused");
    }
    if (!st.isDirectory()) {
      throw new RetiredPathScanError("unreadable-tree");
    }

    let rootFiles = 0;

    const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dirAbs, { withFileTypes: true });
      } catch {
        throw new RetiredPathScanError("unreadable-tree");
      }
      entries.sort((a, b) =>
        Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")),
      );
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new RetiredPathScanError("symlink-refused");
        }
        if (entry.isDirectory()) {
          await walk(path.join(dirAbs, entry.name), `${relPrefix}/${entry.name}`);
        } else if (entry.isFile()) {
          totalFiles += 1;
          if (totalFiles > maxFiles) {
            throw new RetiredPathScanError("budget-exhausted");
          }
          rootFiles += 1;

          let data: Buffer | Uint8Array;
          try {
            data = await readFile(path.join(dirAbs, entry.name));
          } catch {
            throw new RetiredPathScanError("unreadable-file");
          }
          if (!(data instanceof Uint8Array)) {
            throw new RetiredPathScanError("unreadable-file");
          }
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.byteLength > maxFileBytes) {
            throw new RetiredPathScanError("file-too-large");
          }

          const relFile = `${relPrefix}/${entry.name}`;
          for (let i = 0; i < needleBuffers.length; i++) {
            if (buf.includes(needleBuffers[i])) {
              hits.push({ file: relFile, needle: needles[i] });
            }
          }
        }
      }
    };

    await walk(rootAbs, root);

    if (rootFiles === 0) {
      throw new RetiredPathScanError("empty-tree");
    }
  }

  return hits;
}

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-retired-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fleet", private: true }),
    "utf8",
  );
  tempDirs.push(dir);
  return dir;
}

function writeTree(dir: string, rel: string, content: string): void {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

async function expectScanError(
  promise: Promise<unknown>,
  code: RetiredPathScanErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "RetiredPathScanError",
    code,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("retired fleet-repo shell path guard", () => {
  it("declares the fourteen retired fleet-repo shell paths", () => {
    expect(RETIRED_FLEET_SHELL_PATHS).toEqual([
      "tools/fleet-v2-orchestrator/train/common.sh",
      "tools/fleet-v2-orchestrator/lane/auto-record.sh",
      "tools/fleet-v2-orchestrator/lane/conductor-locked.sh",
      "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
      "tools/fleet-v2-orchestrator/lane/drive-runs.sh",
      "tools/fleet-v2-orchestrator/lane/lane-rebase.sh",
      "tools/fleet-v2-orchestrator/lane/merge-main.sh",
      "tools/fleet-v2-orchestrator/lane/record-merged.sh",
      "tools/fleet-v2-orchestrator/lane/tr-brief.sh",
      "tools/fleet-v2-orchestrator/lane/tr-chain.sh",
      "tools/fleet-v2-orchestrator/lane/tr-cont.sh",
      "tools/fleet-v2-orchestrator/lane/tr-gemini.sh",
      "tools/fleet-v2-orchestrator/lane/tr-lane.sh",
      "tools/fleet-v2-orchestrator/lane/tr-review.sh",
    ]);
  });

  it("throws empty-or-invalid-list when the needle list is empty", async () => {
    const root = makeTempRepo();
    await expectScanError(
      scanForRetiredFleetShellPaths([], root, ["docs"]),
      "empty-or-invalid-list",
    );
  });

  it(
    "throws empty-or-invalid-list for null, undefined, a non-array, a hole, a non-string, and an oversized needle",
    async () => {
      const root = makeTempRepo();
      const holeyNeedles: unknown[] = ["ok"];
      holeyNeedles.length = 3;
      holeyNeedles[2] = "ok";
      const cases: unknown[] = [
        null,
        undefined,
        "tools/...",
        { length: 1000000000, 0: "x" },
        holeyNeedles,
        [1],
        "a".repeat(257),
      ];
      for (const c of cases) {
        await expectScanError(
          scanForRetiredFleetShellPaths(c, root, ["docs"]),
          "empty-or-invalid-list",
        );
      }
    },
  );

  it("throws empty-or-invalid-list when reading a needle throws", async () => {
    const root = makeTempRepo();
    const base = ["x"];
    const needles = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "0") {
          throw new Error("boom");
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await expectScanError(
      scanForRetiredFleetShellPaths(needles, root, ["docs"]),
      "empty-or-invalid-list",
    );
  });

  it("throws invalid-roots when the root list is empty or not a dense array of strings", async () => {
    const root = makeTempRepo();
    const holeyRoots: unknown[] = ["docs"];
    holeyRoots.length = 3;
    holeyRoots[2] = "scripts";
    const cases: unknown[] = [[], null, holeyRoots, 42];
    for (const c of cases) {
      await expectScanError(
        scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, c),
        "invalid-roots",
      );
    }
  });

  it("throws unreadable-tree when a root is missing or is a file", async () => {
    const root = makeTempRepo();
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, [
        "does-not-exist",
      ]),
      "unreadable-tree",
    );

    writeTree(root, "afile.txt", "x");
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, [
        "afile.txt",
      ]),
      "unreadable-tree",
    );

    mkdirSync(path.join(root, "docs"));
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, ["docs"], {
        readdir: async () => {
          throw new Error("EIO");
        },
      }),
      "unreadable-tree",
    );
  });

  it("throws symlink-refused for a symlink root and for a symlink entry", async () => {
    const root = makeTempRepo();
    mkdirSync(path.join(root, "real-target"));
    writeTree(
      root,
      "real-target/note.md",
      "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
    );
    symlinkSync(path.join(root, "real-target"), path.join(root, "link-root"));
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, [
        "link-root",
      ]),
      "symlink-refused",
    );

    const root2 = makeTempRepo();
    mkdirSync(path.join(root2, "docs"));
    writeFileSync(
      path.join(root2, "real-target.txt"),
      "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
      "utf8",
    );
    symlinkSync(
      path.join(root2, "real-target.txt"),
      path.join(root2, "docs", "link.txt"),
    );
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root2, [
        "docs",
      ]),
      "symlink-refused",
    );
  });

  it("throws unreadable-file when a file read throws", async () => {
    const root = makeTempRepo();
    writeTree(root, "docs/note.md", "anything");
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, ["docs"], {
        readFile: async () => {
          throw new Error("boom");
        },
      }),
      "unreadable-file",
    );
  });

  it("throws file-too-large and does not return a hit", async () => {
    const root = makeTempRepo();
    writeTree(
      root,
      "docs/note.md",
      "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
    );
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, ["docs"], {
        maxFileBytes: 10,
      }),
      "file-too-large",
    );
  });

  it("throws budget-exhausted before a later hit can count as a clean scan", async () => {
    const root = makeTempRepo();
    writeTree(root, "docs/a.txt", "clean");
    writeTree(
      root,
      "docs/b.txt",
      "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
    );
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, ["docs"], {
        maxFiles: 1,
      }),
      "budget-exhausted",
    );
  });

  it("throws empty-tree when a root contains no regular file", async () => {
    const root = makeTempRepo();
    mkdirSync(path.join(root, "empty-dir"));
    await expectScanError(
      scanForRetiredFleetShellPaths(RETIRED_FLEET_SHELL_PATHS, root, [
        "empty-dir",
      ]),
      "empty-tree",
    );
  });

  it("reports the file and the needle when a file contains a retired path", async () => {
    const root = makeTempRepo();
    writeTree(
      root,
      "docs/note.md",
      "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
    );
    const hits = await scanForRetiredFleetShellPaths(
      RETIRED_FLEET_SHELL_PATHS,
      root,
      ["docs"],
    );
    expect(hits).toEqual([
      {
        file: "docs/note.md",
        needle: "tools/fleet-v2-orchestrator/lane/deploy-train.sh",
      },
    ]);
  });

  it("does not report a file that only mentions the directory prefix and the short script name", async () => {
    const root = makeTempRepo();
    writeTree(
      root,
      "docs/note.md",
      "Paths are under tools/fleet-v2-orchestrator/.\nSee lane/deploy-train.sh.\n__proto__\n",
    );
    const hits = await scanForRetiredFleetShellPaths(
      RETIRED_FLEET_SHELL_PATHS,
      root,
      ["docs"],
    );
    expect(hits).toEqual([]);
  });

  it("returns a __proto__ needle as a hit without writing Object.prototype", async () => {
    const root = makeTempRepo();
    writeTree(root, "docs/note.md", "__proto__");
    const hits = await scanForRetiredFleetShellPaths(
      ["__proto__"],
      root,
      ["docs"],
    );
    expect(hits).toEqual([{ file: "docs/note.md", needle: "__proto__" }]);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
  });

  it("finds no retired fleet-repo shell path under docs, workflows, or scripts", async () => {
    const repoRoot = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
    );
    const hits = await scanForRetiredFleetShellPaths(
      RETIRED_FLEET_SHELL_PATHS,
      repoRoot,
      ["docs", ".github/workflows", "scripts"],
    );
    expect(hits).toEqual([]);
  });
});
