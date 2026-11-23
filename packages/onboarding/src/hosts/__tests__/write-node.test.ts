/**
 * Direct unit tests for the node half of the write step
 * (`write-node.ts`), covering only the paths `write.test.ts` does not:
 * the `sha256Of` hashing contract, the malformed/invalid-path reads, the
 * refusal paths of the compare-and-swap write (changed both ways,
 * unreadable target, non-v2 candidate, lock that cannot be created, temp
 * write that fails), the held-lock descriptions, and hostile inputs to
 * every exported function.
 *
 * Cost bounds: every fixture here is a fixed-size object or a file of at
 * most a few hundred bytes, so each check is O(1) in fixtures or O(n)
 * over bounded input bytes; no check iterates unbounded data.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * A controlled test double on `rename`, so the temp-write path can be made
 * to fail without depending on directory permissions (which also block the
 * lock file). The double is off by default and only one test flips it on,
 * so every other test in this file uses the real `node:fs/promises`.
 */
const renameDouble = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameDouble.fail) {
        throw Object.assign(
          new Error("rename blocked by the test double"),
          { code: "EPERM" },
        );
      }
      return actual.rename(...args);
    },
  };
});

import { applyHostDraft } from "../draft.js";
import type { HostDraft, HostDraftCandidate } from "../draft.js";
import { readInstallationFile, sha256Of, writeInstallation } from "../write-node.js";

/** A valid v2 file: one local orchestrator that is also the lane runner. */
const baseFile = {
  schemaVersion: 2,
  hosts: {
    here: {
      transport: "local",
      worktreeRoot: "/home/dev/fleet-v2",
      roles: ["orchestrator", "lane-runner"],
      runner: { kind: "opencode", port: 46000 },
    },
  },
  forge: { mode: "none" },
};

/** A draft that adds a remote verifier, which the loader accepts. */
const verifierDraft: HostDraft = {
  name: "verifymac",
  host: {
    transport: "ssh",
    sshAlias: "verifymac.example",
    worktreeRoot: "/srv/fleet-v2/verify",
    roles: ["verifier"],
  },
};

function candidateFile(): HostDraftCandidate {
  const applied = applyHostDraft(baseFile, verifierDraft, "add");
  if (!applied.ok) {
    throw new Error(
      `the fixture draft itself must apply: ${applied.errors.join("; ")}`,
    );
  }
  return applied.candidate;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "onboarding-write-node-"));
}

async function remove(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** An array with a hole at index 1, built without sparse-array syntax. */
function holeyArrayOf(first: string, third: string): unknown[] {
  const holey: unknown[] = [first, third];
  delete holey[1];
  return holey;
}

/** An object whose every `get` lies with `undefined`, consistently. */
function lyingProxy(): object {
  return new Proxy(
    {},
    { get: () => undefined, has: () => false, ownKeys: () => [] },
  );
}

/** An object with one own property whose getter throws when read. */
function getterObject(key: string): object {
  const object: Record<string, unknown> = {};
  Object.defineProperty(object, key, {
    enumerable: true,
    configurable: true,
    get() {
      throw new TypeError(`the ${key} getter must never be read`);
    },
  });
  return object;
}

describe("sha256Of", () => {
  // O(1): fixed-size known vectors.
  it("hashes the empty string to the known SHA-256 vector", () => {
    expect(sha256Of("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes 'abc' to the known SHA-256 vector", () => {
    expect(sha256Of("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("gives a string and its UTF-8 bytes the same digest", () => {
    const bytes = new TextEncoder().encode("verifymac.example\n");
    expect(sha256Of(bytes)).toBe(sha256Of("verifymac.example\n"));
  });

  it("returns a lowercase 64-hex digest, so the format itself is checked", () => {
    const digest = sha256Of("fleet");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives distinct inputs distinct digests and never the input itself", () => {
    // Fails against a constant implementation (distinct inputs) and an
    // identity one (the digest is not the input and not a prefix of it).
    expect(sha256Of("a")).not.toBe(sha256Of("b"));
    const digest = sha256Of("a");
    expect(digest).not.toBe("a");
    expect(digest.startsWith("a")).toBe(false);
    expect(digest).toHaveLength(64);
  });

  // O(1): each hostile input is a fixed-size object.
  it("refuses non-string and non-Uint8Array hostile inputs with TypeError", () => {
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      {}, 
      holeyArrayOf("a", "b"), // an array with a hole
      getterObject("length"),
      lyingProxy(),
      { length: 3 }, // an array-like
      { length: 1e9 }, // an enormous length
      { ["__proto__"]: 1 }, // a prototype-polluting key
    ];
    for (const input of hostile) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => sha256Of(input as any)).toThrow(TypeError);
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("readInstallationFile", () => {
  // O(n) over bounded file bytes: a few dozen.
  it("returns status read with value undefined for non-JSON or empty files", async () => {
    const dir = await tempDir();
    try {
      const textFile = join(dir, "text.json");
      await writeFile(textFile, "this is not json\n");
      const textRead = await readInstallationFile(textFile);
      expect(textRead.status).toBe("read");
      if (textRead.status === "read") {
        expect(textRead.value).toBeUndefined();
        expect(textRead.text).toBe("this is not json\n");
        const bytes = await readFile(textFile);
        expect(textRead.hash).toBe(sha256Of(bytes));
      }
      const emptyFile = join(dir, "empty.json");
      await writeFile(emptyFile, "");
      const emptyRead = await readInstallationFile(emptyFile);
      expect(emptyRead.status).toBe("read");
      if (emptyRead.status === "read") {
        expect(emptyRead.value).toBeUndefined();
        expect(emptyRead.text).toBe("");
        expect(emptyRead.hash).toBe(sha256Of(new Uint8Array(0)));
        expect(emptyRead.hash).toBe(
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
      }
    } finally {
      await remove(dir);
    }
  });

  // O(n) over bounded file bytes.
  it("reads JSON with a __proto__ key without polluting Object.prototype", async () => {
    const dir = await tempDir();
    const file = join(dir, "proto.json");
    try {
      await writeFile(file, '{"__proto__": {"polluted": true}, "x": 1}\n');
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      if (read.status === "read") {
        expect((read.value as Record<string, unknown>).x).toBe(1);
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      }
    } finally {
      await remove(dir);
    }
  });

  // O(1): each hostile input is a fixed-size object and readFile fails
  // without reading any data.
  it("returns unreadable with ERR_INVALID_ARG_TYPE for invalid path inputs", async () => {
    const dir = await tempDir();
    try {
      const hostile: unknown[] = [null, undefined, 123, { length: 3 }];
      for (const input of hostile) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const read = await readInstallationFile(input as any);
        expect(read.status).toBe("unreadable");
        if (read.status === "unreadable") {
          expect(read.reason).toBe("ERR_INVALID_ARG_TYPE");
        }
      }
      // A getter as the only path source: node's own coercion may read it,
      // but the read must still be reported unreadable, never absent.
      let getterRead = false;
      const coerced: Record<string, unknown> = {};
      Object.defineProperty(coerced, "toString", {
        enumerable: false,
        get() {
          getterRead = true;
          throw new TypeError("the path getter must not resolve a file");
        },
      });
      const getterResult = await readInstallationFile(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        coerced as any,
      );
      expect(getterResult.status).toBe("unreadable");
      // A lying proxy is not a usable path: refused as unreadable, never
      // silently treated as an absent file.
      const proxy = new Proxy(
        {},
        {
          get(_target, key) {
            if (key === "toString") {
              throw new TypeError("the proxy path is not a path");
            }
            return undefined;
          },
        },
      );
      const proxyResult = await readInstallationFile(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proxy as any,
      );
      expect(proxyResult.status).toBe("unreadable");
      // The path getter stays unread: node refuses a non-string, non-Buffer,
      // non-URL path by type before any coercion, so the getter must never
      // have run (a getter that ran would resolve a path, which is what this
      // guard exists to refuse).
      expect(getterRead).toBe(false);
    } finally {
      await remove(dir);
    }
  });
});

describe("writeInstallation refusals", () => {
  // O(1) fixtures, one small file.
  it("refuses with changed when expectedHash is absent but the file already exists", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await writeFile(file, `${JSON.stringify(baseFile, null, 2)}\n`);
      const bytes = await readFile(file);
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(result).toEqual({
        status: "refused",
        file,
        currentHash: sha256Of(bytes),
        reason: "changed",
        errors: [
          `${file}: changed on disk since it was read (expected absent, found ${sha256Of(bytes)}); reload and confirm again`,
        ],
      });
      // The file is untouched and the lock is released.
      expect(await readFile(file)).toEqual(bytes);
      await expect(readdir(dir)).resolves.not.toContain("fleet.json.lock");
    } finally {
      await remove(dir);
    }
  });

  it("refuses with changed and currentHash absent when the file disappeared", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      });
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.currentHash).toBe("absent");
        expect(result.reason).toBe("changed");
        expect(result.errors[0]).toContain("changed on disk");
        expect(result.errors[0]).toContain("expected ba7816bf");
        expect(result.errors[0]).toContain("found absent");
      }
      // Nothing was written and the lock is released.
      await expect(stat2(file)).resolves.toBe(false);
      await expect(readdir(dir)).resolves.not.toContain("fleet.json.lock");
    } finally {
      await remove(dir);
    }
  });

  it("refuses with unreadable when the target path is a directory and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await mkdir(file);
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(result).toEqual({
        status: "refused",
        file,
        currentHash: "absent",
        reason: "unreadable",
        errors: [`${file}: unreadable`],
      });
      await expect(readdir(dir)).resolves.not.toContain("fleet.json.lock");
      await expect(stat2(file)).resolves.toBe(true); // still a directory
    } finally {
      await remove(dir);
    }
  });

  it("refuses a valid v1 installation candidate with invalid and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      const v1 = { schemaVersion: 1 };
      const result = await writeInstallation({
        file,
        // The pure loader accepts the shape but narrows it to v1, so the
        // node half must refuse it at the last point before writing.
        candidate: v1 as unknown as HostDraftCandidate,
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("invalid");
        expect(result.currentHash).toBe("absent");
        expect(result.errors).toEqual([
          "installation: the candidate is not a schema version 2 file",
        ]);
      }
      await expect(stat2(file)).resolves.toBe(false); // nothing written
      await expect(readdir(dir)).resolves.not.toContain("fleet.json.lock");
    } finally {
      await remove(dir);
    }
  });

  it("refuses with write-failed and unknown currentHash when the lock file cannot be created", async () => {
    const dir = await tempDir();
    try {
      // The parent directory does not exist, so even the lock cannot be.
      const file = join(dir, "missing", "fleet.json");
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.currentHash).toBe("unknown");
        expect(result.reason).toBe("write-failed");
        expect(result.errors[0]).toContain("could not be locked");
      }
    } finally {
      await remove(dir);
    }
  });

  it("refuses with write-failed when renaming the temp file fails and leaves no temp file", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    // O(1): one small write whose rename the test double refuses.
    renameDouble.fail = true;
    try {
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("write-failed");
        expect(result.currentHash).toBe("absent");
        expect(result.errors[0]).toContain("could not be written");
      }
      // The temp file was removed and the target was never created.
      const entries = await readdir(dir);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
      await expect(stat2(file)).resolves.toBe(false);
      await expect(readdir(dir)).resolves.not.toContain("fleet.json.lock");
    } finally {
      renameDouble.fail = false;
      await remove(dir);
    }
  });

  // O(1): the lock fixture is a one-line file.
  it("describes malformed and pid-only held lock owners without modifying the target", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await writeFile(`${file}.lock`, "not-a-pid 2026-01-01T00:00:00.000Z\n");
      const unknownWriter = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(unknownWriter.status).toBe("refused");
      if (unknownWriter.status === "refused") {
        expect(unknownWriter.reason).toBe("locked");
        expect(unknownWriter.currentHash).toBe("unknown");
        expect(unknownWriter.errors[0]).toContain("an unknown writer");
        expect(unknownWriter.errors[0]).toContain(`${file}.lock`);
      }
      // The held lock is never removed by the refused writer.
      await expect(readFile(`${file}.lock`, "utf8")).resolves.toBe(
        "not-a-pid 2026-01-01T00:00:00.000Z\n",
      );
      await expect(stat2(file)).resolves.toBe(false);

      // A pid-only owner line (no `since`) is described without a since.
      await rm(`${file}.lock`, { force: true });
      await writeFile(`${file}.lock`, "999999999\n");
      const pidOnly = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(pidOnly.status).toBe("refused");
      if (pidOnly.status === "refused") {
        expect(pidOnly.reason).toBe("locked");
        expect(pidOnly.errors[0]).toContain("pid 999999999");
        expect(pidOnly.errors[0]).not.toContain("since");
      }
      await expect(readFile(`${file}.lock`, "utf8")).resolves.toBe(
        "999999999\n",
      );
    } finally {
      await remove(dir);
    }
  });

  // O(1) per hostile input: the loader refuses each before any bytes move.
  it("refuses hostile candidate inputs with invalid and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      let getterRead = false;
      const withThrowingGetter: Record<string, unknown> = {};
      Object.defineProperty(withThrowingGetter, "schemaVersion", {
        enumerable: true,
        configurable: true,
        get() {
          getterRead = true;
          throw new TypeError("the candidate getter must never be read");
        },
      });
      const holey: unknown[] = [baseFile];
      delete (holey as unknown as Record<string, unknown>)["0"]; // an array hole
      const hostile: unknown[] = [
        null,
        undefined,
        42,
        {},
        holey,
        withThrowingGetter,
        lyingProxy(),
        { length: 3 }, // an array-like
        { length: 1e9 }, // an enormous length
        { ["__proto__"]: 1 }, // a prototype-polluting key
      ];
      for (const candidate of hostile) {
        const result = await writeInstallation({
          file,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          candidate: candidate as any,
          expectedHash: "absent",
        });
        expect(result.status).toBe("refused");
        if (result.status === "refused") {
          expect(result.reason).toBe("invalid");
        }
      }
      // The throwing getter was never read by the write path.
      expect(getterRead).toBe(false);
      // No prototype pollution and nothing written; every lock is released.
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      await expect(stat2(file)).resolves.toBe(false);
      await expect(readdir(dir)).resolves.not.toContain("fleet.json.lock");
      const entries = await readdir(dir);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await remove(dir);
    }
  });

  // O(1): the request itself is the fixture.
  it("rejects null and undefined requests with TypeError", async () => {
    const dir = await tempDir();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(writeInstallation(null as any)).rejects.toThrow(TypeError);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(writeInstallation(undefined as any)).rejects.toThrow(
        TypeError,
      );
    } finally {
      await remove(dir);
    }
  });
});

/** Whether a path exists (stat without throwing, for readability above). */
async function stat2(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
