/**
 * Direct unit tests for the node half of the write step
 * (`write-node.ts`), covering only the paths the pure-half tests in
 * `write.test.ts` do not reach: the hash primitive itself, malformed-file
 * and invalid-path reads, the remaining compare-and-swap refusal and
 * cleanup paths, the held-lock description, and hostile inputs.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { HostDraft, HostDraftCandidate } from "../draft.js";
import { applyHostDraft } from "../draft.js";
import { readHashOf } from "../write.js";
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

/** A getter that records it was read and throws, to prove it is never read. */
function throwingGetterOn(
  target: object,
  key: string | symbol,
): { hits: () => number } {
  let hits = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      hits += 1;
      throw new Error(`the ${String(key)} getter must never be invoked`);
    },
  });
  return { hits: () => hits };
}

describe("sha256Of", () => {
  // O(1): fixed-size known vectors.
  it("matches the known SHA-256 vectors for the empty string and abc", () => {
    expect(sha256Of("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Of("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  // O(1): a fixed small input, hashed as text and as bytes.
  it("hashes a string and the same bytes as a Uint8Array identically, in lowercase 64-hex", () => {
    const bytes = new TextEncoder().encode("fleet-v2 installation");
    const digest = sha256Of(bytes);
    expect(digest).toBe(sha256Of("fleet-v2 installation"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  // O(1): two fixed inputs and one length check.
  it("gives different inputs different digests, each exactly 64 characters", () => {
    const first = sha256Of("first");
    const second = sha256Of("second");
    expect(first).not.toBe(second);
    // An identity function over this input would return the input itself,
    // which is not 64 hex characters.
    expect(sha256Of("x".repeat(1000))).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe("first");
  });

  // O(1) per input: every hostile input is rejected by node's own type check
  // before any hashing, so no input is large. A getter on the input is never
  // the failure source: if it were invoked, its non-TypeError would surface.
  const holey = [1, 2, 3];
  delete holey[1]; // an array with a hole
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a wrong primitive", 42],
    ["a non-iterable object", {}],
    ["an array with a hole", holey],
    ["an object with a throwing getter", Object.defineProperty({}, "length", { get() { throw new Error("getter"); } })],
    ["a Proxy", new Proxy({}, {})],
    ["an array-like", { length: 3 }],
    ["an array-like with an enormous length", { length: 1e9 }],
    ["a prototype-polluting key", { ["__proto__"]: 1 }],
  ])("refuses %s with TypeError", (_label, input) => {
    expect(() => sha256Of(input as never)).toThrow(TypeError);
  });
});

describe("readInstallationFile", () => {
  // O(n) bounded: the fixture files are a few dozen bytes.
  it("returns status read with value undefined for non-JSON or empty files", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "fleet.json");
      await writeFile(file, "this is not json");
      const text = await readFile(file, "utf8");
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      if (read.status !== "read") {
        return;
      }
      expect(read.value).toBeUndefined();
      expect(read.text).toBe(text);
      expect(read.hash).toBe(sha256Of(await readFile(file)));

      await writeFile(file, "");
      const empty = await readInstallationFile(file);
      expect(empty.status).toBe("read");
      if (empty.status !== "read") {
        return;
      }
      expect(empty.value).toBeUndefined();
      expect(empty.text).toBe("");
      expect(empty.hash).toBe(sha256Of(await readFile(file)));
    } finally {
      await remove(dir);
    }
  });

  // O(n) bounded: a one-key fixture.
  it("reads JSON with a __proto__ key without polluting Object.prototype", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "fleet.json");
      await writeFile(file, '{"__proto__":{"polluted":true}}\n');
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      if (read.status !== "read") {
        return;
      }
      // The key stays an own property of the parsed value and never reaches
      // Object.prototype.
      expect(
        Object.getOwnPropertyDescriptor(read.value, "__proto__"),
      ).toBeTruthy();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(
        (Object.prototype as Record<string, unknown>).polluted,
      ).toBeUndefined();
    } finally {
      await remove(dir);
    }
  });

  // O(1) per input: node's own path type check rejects each hostile path
  // before any syscall. The throwing-getter case counts reads: node must
  // refuse the type without ever touching the property.
  it("returns unreadable with ERR_INVALID_ARG_TYPE for invalid path inputs", async () => {
    const dir = await tempDir();
    try {
      const hostile: Array<[string, unknown]> = [
        ["null", null],
        ["undefined", undefined],
        ["a wrong primitive", 123],
        ["a Proxy", new Proxy({}, {})],
        ["an array-like", { length: 3 }],
      ];
      for (const [label, path] of hostile) {
        const read = await readInstallationFile(path as string);
        expect(read.status, label).toBe("unreadable");
        if (read.status === "unreadable") {
          expect(read.reason, label).toBe("ERR_INVALID_ARG_TYPE");
        }
      }
      const getterTarget: Record<string, unknown> = {};
      const getter = throwingGetterOn(getterTarget, "toString");
      const read = await readInstallationFile(getterTarget as unknown as string);
      expect(read.status).toBe("unreadable");
      if (read.status === "unreadable") {
        expect(read.reason).toBe("ERR_INVALID_ARG_TYPE");
      }
      expect(getter.hits()).toBe(0);
    } finally {
      await remove(dir);
    }
  });
});

describe("writeInstallation refusals and cleanup", () => {
  // O(1): a small fixture file, one hash comparison.
  it("refuses with changed when expectedHash is absent but the file already exists, and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    const original = `${JSON.stringify(baseFile, null, 2)}\n`;
    try {
      await writeFile(file, original);
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("changed");
      expect(result.currentHash).toBe(sha256Of(original));
      expect(result.errors[0]).toContain("changed on disk");
      // The file was never touched and the lock was released.
      expect(await readFile(file, "utf8")).toBe(original);
      expect(await readdir(dir)).toEqual(["fleet.json"]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): a small fixture file that is then removed.
  it("refuses with changed and currentHash absent when the file disappeared, and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await writeFile(file, `${JSON.stringify(baseFile, null, 2)}\n`);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      const expectedHash = readHashOf(read);
      await rm(file);
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("changed");
      expect(result.currentHash).toBe("absent");
      expect(result.errors[0]).toContain("changed on disk");
      // Nothing was written and the lock was released.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): one directory as the target path.
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
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("unreadable");
      expect(result.currentHash).toBe("absent");
      expect(result.errors).toEqual([`${file}: unreadable`]);
      // The lock was released; only the directory itself remains.
      expect(await readdir(dir)).toEqual(["fleet.json"]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): one fixed candidate the loader accepts but narrows out as v1.
  it("refuses a valid v1 installation candidate with invalid and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      const v1 = {
        schemaVersion: 1,
        forge: { owner: "example-owner", repo: "example-repo" },
      } as unknown as HostDraftCandidate;
      const result = await writeInstallation({
        file,
        candidate: v1,
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("invalid");
      expect(result.errors).toEqual([
        "installation: the candidate is not a schema version 2 file",
      ]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): the lock path's parent directory does not exist, so the open
  // fails before any read or write is attempted.
  it("refuses with write-failed and unknown currentHash when the lock file cannot be created", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "missing", "fleet.json");
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("write-failed");
      expect(result.currentHash).toBe("unknown");
      expect(result.errors[0]).toContain("could not be locked");
      // The missing directory was never created.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): the Proxy trap fires once during the in-write re-validation of the
  // candidate, after the lock is taken and the hash check has passed, and
  // removes the whole directory so the temp creation fails.
  it("refuses with write-failed when writing or renaming the temp file fails and leaves no temp file", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    const original = `${JSON.stringify(baseFile, null, 2)}\n`;
    try {
      await writeFile(file, original);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      const expectedHash = readHashOf(read);
      const candidate = candidateFile();
      // While the write re-validates the candidate, the directory (target
      // file, lock and all) is removed, so the temp open fails with ENOENT.
      const vanishing = new Proxy(candidate as object, {
        get(target, key, receiver) {
          if (key === "hosts") {
            rmSync(dir, { recursive: true, force: true });
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const result = await writeInstallation({
        file,
        candidate: vanishing as typeof candidate,
        expectedHash,
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("write-failed");
      // The hash is the one the read took, before the directory vanished.
      expect(result.currentHash).toBe(expectedHash);
      expect(result.errors[0]).toContain("could not be written");
      // Nothing is left behind: no temp file, no lock, no target.
      expect(await readdir(dir).catch(() => ["<gone>"])).toEqual(["<gone>"]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): a pre-created lock file whose owner line is malformed, a live pid
  // without a since stamp, and a dead pid without one.
  it("describes malformed and pid-only held lock owners without modifying the target", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    const original = `${JSON.stringify(baseFile, null, 2)}\n`;
    try {
      await writeFile(file, original);
      const read = await readInstallationFile(file);
      const expectedHash = readHashOf(read);

      await writeFile(`${file}.lock`, "not-a-pid 2026-10-17T00:00:00.000Z\n");
      const unknown = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(unknown.status).toBe("refused");
      if (unknown.status !== "refused") {
        return;
      }
      expect(unknown.reason).toBe("locked");
      expect(unknown.currentHash).toBe("unknown");
      expect(unknown.errors[0]).toContain("held by an unknown writer");
      expect(unknown.errors[0]).not.toContain("since");
      expect(await readFile(file, "utf8")).toBe(original);

      // A pid-only line from a writer that is no longer running: named with
      // its pid and no "since", reported as stale.
      await writeFile(`${file}.lock`, "2147483646\n");
      const dead = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(dead.status).toBe("refused");
      if (dead.status !== "refused") {
        return;
      }
      expect(dead.errors[0]).toContain("pid 2147483646");
      expect(dead.errors[0]).not.toContain("since");
      expect(await readFile(file, "utf8")).toBe(original);

      // A pid-only line from a live writer: named with its pid and no
      // "since", reported as in progress rather than stale.
      await writeFile(`${file}.lock`, `${process.pid}\n`);
      const live = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(live.status).toBe("refused");
      if (live.status !== "refused") {
        return;
      }
      expect(live.errors[0]).toContain(`pid ${process.pid}`);
      expect(live.errors[0]).toContain("another write is in progress");
      expect(live.errors[0]).not.toContain("since");
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      await remove(dir);
    }
  });

  // O(1) per input: the loader re-validates each hostile candidate at the
  // moment of writing and the write refuses before touching the file. The
  // throwing-getter case counts reads: the loader must refuse the candidate
  // without ever touching the property.
  it("refuses hostile candidate inputs with invalid and releases the lock", async () => {
    const dir = await tempDir();
    try {
      const file = join(dir, "fleet.json");
      const polluting = Object.defineProperty({}, "__proto__", {
        enumerable: true,
        configurable: true,
        value: { polluted: true },
      });
      const holey = [undefined, undefined, undefined];
      delete holey[1]; // an array with a hole
      const cases: Array<[string, unknown]> = [
        ["null", null],
        ["undefined", undefined],
        ["a wrong primitive", 42],
        ["an array", []],
        ["an array with a hole", holey],
        ["an array-like", { length: 3 }],
        ["an array-like with an enormous length", { length: 1e9 }],
        ["a prototype-polluting key", polluting],
      ];
      for (const [label, candidate] of cases) {
        const result = await writeInstallation({
          file,
          candidate: candidate as HostDraftCandidate,
          expectedHash: "absent",
        });
        expect(result.status, label).toBe("refused");
        if (result.status !== "refused") {
          return;
        }
        expect(result.reason, label).toBe("invalid");
        // The lock was released and nothing was written.
        expect(await readdir(dir), label).toEqual([]);
      }
      expect(
        (Object.prototype as Record<string, unknown>).polluted,
      ).toBeUndefined();

      const file2 = join(dir, "getter.json");
      const getterCandidate: Record<string, unknown> = {};
      const getter = throwingGetterOn(getterCandidate, "hosts");
      const getterResult = await writeInstallation({
        file: file2,
        candidate: getterCandidate as HostDraftCandidate,
        expectedHash: "absent",
      });
      expect(getterResult.status).toBe("refused");
      if (getterResult.status !== "refused") {
        return;
      }
      expect(getterResult.reason).toBe("invalid");
      expect(getter.hits()).toBe(0);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): a lying Proxy around a valid candidate is refused by the loader
  // like any other invalid candidate (a Proxy that lies consistently in
  // every trap is an accepted residual).
  it("refuses a Proxy candidate with invalid and releases the lock", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      const candidate = candidateFile();
      // A Proxy that lies in every trap: the loader re-validates the
      // candidate at the moment of writing and refuses it, so nothing is
      // written. (A Proxy that lies about only one key is an accepted
      // residual: the loader normalises the value it does read.)
      const lying = new Proxy(candidate as object, {
        get() {
          return undefined;
        },
      });
      const result = await writeInstallation({
        file,
        candidate: lying as typeof candidate,
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("invalid");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await remove(dir);
    }
  });

  // O(1): the request itself is destructured before anything else, so a
  // missing request is a caller bug and surfaces as a TypeError.
  it("rejects null and undefined requests with TypeError", async () => {
    await expect(
      writeInstallation(null as never),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      writeInstallation(undefined as never),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
