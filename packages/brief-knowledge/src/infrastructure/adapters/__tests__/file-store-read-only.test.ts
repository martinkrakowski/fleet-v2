// VC36 tests: direct unit tests for the read-only guards of
// `file-store.ts` — `assertStoreWritable`, `rejectUnreadableStateFile`,
// `ReadOnlyStateStoreError` and `StateFileUnreadableReadOnlyError`.
// Pure unit tests: the read-only paths touch no filesystem at all; the one
// quarantine test uses a real temp directory and removes it afterwards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertStoreWritable,
  rejectUnreadableStateFile,
  ReadOnlyStateStoreError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  type QuarantineFs,
} from "../file-store.js";

/** The temp directory created by the delegation test, removed in afterEach. */
let delegationDir: string | null = null;

afterEach(async () => {
  if (delegationDir !== null) {
    await rm(delegationDir, { recursive: true, force: true });
    delegationDir = null;
  }
});

/** A fake QuarantineFs whose every method fails the test if it is ever called. */
function throwingFakeFs(): QuarantineFs & {
  mkdir: ReturnType<typeof vi.fn>;
  chmod: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  readdir: ReturnType<typeof vi.fn>;
  rm: ReturnType<typeof vi.fn>;
  lstat: ReturnType<typeof vi.fn>;
} {
  const refuse = (): never => {
    throw new Error("read-only path must never touch QuarantineFs");
  };
  return {
    mkdir: vi.fn(refuse),
    chmod: vi.fn(refuse),
    readFile: vi.fn(refuse),
    writeFile: vi.fn(refuse),
    readdir: vi.fn(refuse),
    rm: vi.fn(refuse),
    lstat: vi.fn(refuse),
  };
}

/** Every QuarantineFs method the fake provides, to assert zero calls on each. */
const FAKE_METHODS = [
  "mkdir",
  "chmod",
  "readFile",
  "writeFile",
  "readdir",
  "rm",
  "lstat",
] as const;

describe("assertStoreWritable", () => {
  it("returns undefined when readOnly is false", () => {
    expect(assertStoreWritable(false, "x")).toBeUndefined();
  });

  it("throws ReadOnlyStateStoreError when readOnly is true", () => {
    let caught: unknown;
    try {
      assertStoreWritable(true, "knowledge");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReadOnlyStateStoreError);
    expect(caught).toBeInstanceOf(Error);
    const error = caught as ReadOnlyStateStoreError;
    expect(error.name).toBe("ReadOnlyStateStoreError");
    expect(error.storeName).toBe("knowledge");
    expect(error.message).toBe(
      "knowledge was opened read-only and refuses every write",
    );
  });

  it("pins current truthiness behaviour for non-boolean readOnly values", () => {
    // Cost bound: assertStoreWritable is O(1) — a single truthiness check,
    // no loops, no untrusted iteration or property reads. These values are
    // cast at the test boundary exactly as a caller could cast them; the
    // test pins today's `if (readOnly)` behaviour without changing any
    // production code.
    const truthy = [1, "true", {}] as unknown as boolean[];
    for (const value of truthy) {
      let caught: unknown;
      try {
        assertStoreWritable(value, "knowledge");
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReadOnlyStateStoreError);
    }
    const falsy = [0, "", null, undefined] as unknown as boolean[];
    for (const value of falsy) {
      expect(assertStoreWritable(value, "knowledge")).toBeUndefined();
    }
  });
});

describe("rejectUnreadableStateFile", () => {
  it("rejects with StateFileUnreadableReadOnlyError and never touches QuarantineFs when readOnly is true", async () => {
    // Cost bound: O(1). The read-only branch constructs one error and
    // returns; nothing iterates, hashes or reads untrusted properties, and
    // an omitted or throwing `lstat` is irrelevant because no method is
    // reachable at all.
    const fakeFs = throwingFakeFs();
    const filePath = path.join("state", "knowledge.json");
    const detail = "unexpected end of JSON input";
    await expect(
      rejectUnreadableStateFile(filePath, detail, Buffer.from("{}"), true, fakeFs),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(StateFileUnreadableReadOnlyError);
      const readOnlyError = error as StateFileUnreadableReadOnlyError;
      expect(readOnlyError.name).toBe("StateFileUnreadableReadOnlyError");
      expect(readOnlyError.filePath).toBe(filePath);
      expect(readOnlyError.detail).toBe(detail);
      expect(readOnlyError.message).toBe(
        `State file ${filePath} is unreadable (${detail}); this read-only read kept no copy and wrote nothing`,
      );
      return true;
    });
    for (const method of FAKE_METHODS) {
      expect(fakeFs[method]).toHaveBeenCalledTimes(0);
    }
  });

  it("pins current truthiness behaviour for non-boolean readOnly values against QuarantineFs", async () => {
    // Cost bound: the truthy branch is O(1) (one error, no fs); the falsy
    // branch delegates to quarantineUnreadable (O(bytes.length) hashing and
    // write), so falsy truthiness is pinned with the throwing fake that the
    // read-only tests use — proving the delegation branch was entered
    // without doing any I/O. Comment only; production code is untouched.
    const filePath = path.join("state", "pinned.json");
    const bytes = Buffer.from("[]");
    for (const value of [1, "true", {}] as unknown as boolean[]) {
      const fakeFs = throwingFakeFs();
      await expect(
        rejectUnreadableStateFile(filePath, "bad", bytes, value, fakeFs),
      ).rejects.toBeInstanceOf(StateFileUnreadableReadOnlyError);
      for (const method of FAKE_METHODS) {
        expect(fakeFs[method]).toHaveBeenCalledTimes(0);
      }
    }
    for (const value of [0, "", null, undefined] as unknown as boolean[]) {
      const fakeFs = throwingFakeFs();
      await expect(
        rejectUnreadableStateFile(filePath, "bad", bytes, value, fakeFs),
      ).rejects.toSatisfy((error: unknown) => {
        // Falsy readOnly delegates to quarantineUnreadable, which fails on
        // the throwing fake and wraps it as StateFileUnreadableError.
        expect(error).toBeInstanceOf(StateFileUnreadableError);
        expect(error).not.toBeInstanceOf(StateFileUnreadableReadOnlyError);
        return true;
      });
    }
  });

  it("delegates to quarantineUnreadable and keeps a quarantine copy when readOnly is false", async () => {
    // Cost bound: O(bytes.length) for the SHA-256 digest and the copy
    // write, plus bounded pruning of at most 5 kept copies. The original
    // file is never modified; only the quarantine copy is written.
    const dir = delegationDir = await mkdtemp(path.join(tmpdir(), "fleet-ro-"));
    const filePath = path.join(dir, "state.json");
    const bytes = Buffer.from("this is not valid JSON at all");
    await writeFile(filePath, bytes);
    const detail = "unexpected token in JSON";
    {
      let caught: unknown;
      try {
        await rejectUnreadableStateFile(filePath, detail, bytes, false);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StateFileUnreadableError);
      const error = caught as StateFileUnreadableError;
      expect(error.quarantinePath).not.toBeNull();
      const quarantinePath = error.quarantinePath as string;
      expect(quarantinePath.startsWith(path.join(dir, "quarantine"))).toBe(
        true,
      );
      expect(Buffer.from(await readFile(quarantinePath))).toEqual(bytes);
      // The original file remains in place untouched.
      expect(Buffer.from(await readFile(filePath))).toEqual(bytes);
    }
  });
});

describe("prototype chain preservation across Promise.reject and try/catch rethrow", () => {
  it("preserves prototype chain for both error classes across Promise.reject rethrow", async () => {
    const cases: readonly [Error, new (...args: never[]) => Error][] = [
      [new ReadOnlyStateStoreError("knowledge"), ReadOnlyStateStoreError],
      [
        new StateFileUnreadableReadOnlyError("state/x.json", "bad json"),
        StateFileUnreadableReadOnlyError,
      ],
    ];
    for (const [error, errorClass] of cases) {
      let rethrown: unknown;
      try {
        await Promise.reject(error);
      } catch (caught: unknown) {
        try {
          throw caught;
        } catch (again: unknown) {
          rethrown = again;
        }
      }
      expect(rethrown).toBeInstanceOf(Error);
      expect(rethrown).toBeInstanceOf(errorClass);
      expect(rethrown).toBe(error);
    }
  });
});
