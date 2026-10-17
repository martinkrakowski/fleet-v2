import { rmSync, writeFileSync } from "node:fs";
/**
 * The write step against a real temp directory: the compare-and-swap hash
 * check, the loader's refusal at the moment of writing, and the atomic
 * temp-and-rename write with mode 600. The diff is checked on both a simple
 * explicit pair of line lists and on the candidate a draft would produce.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isFleetInstallationV2,
  parseInstallation,
  writeInstallationV2,
} from "@fleet/installation";

import type { HostDraft, HostDraftCandidate } from "../draft.js";
import { applyHostDraft } from "../draft.js";
import {
  diffInstallation,
  diffInstallationText,
  readHashOf,
  renderInstallationDiff,
  serialiseInstallationCandidate,
} from "../write.js";
import {
  readInstallationFile,
  sha256Of,
  writeInstallation,
} from "../write-node.js";

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
  name: "twilight",
  host: {
    transport: "ssh",
    sshAlias: "twilight.lan",
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
  return mkdtemp(join(tmpdir(), "onboarding-write-"));
}

async function remove(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("readInstallationFile", () => {
  it("reports an absent file as absent, so a first write can hash it", async () => {
    const dir = await tempDir();
    try {
      const read = await readInstallationFile(join(dir, "fleet.json"));
      expect(read.status).toBe("absent");
      expect(readHashOf(read)).toBe("absent");
    } finally {
      await remove(dir);
    }
  });

  it("hashes the exact bytes on disk and decodes the value", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await writeFile(file, `${JSON.stringify(baseFile, null, 2)}\n`);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      if (read.status !== "read") {
        return;
      }
      const bytes = await readFile(file);
      expect(read.hash).toBe(sha256Of(bytes));
      expect(read.text).toBe(bytes.toString("utf8"));
      expect(read.value).toEqual(baseFile);
    } finally {
      await remove(dir);
    }
  });

  it("reports a file it cannot read as unreadable, never as absent", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      // A directory is a path that exists but is not a readable file.
      await mkdir(file);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("unreadable");
      if (read.status === "unreadable") {
        expect(read.reason).toBeTruthy();
      }
    } finally {
      await remove(dir);
    }
  });
});

describe("diff", () => {
  it("diffs two line lists as a multiset and renders removed then added", () => {
    expect(diffInstallationText("a\nb\nc\n", "a\nc\nd\n")).toEqual({
      removed: ["b"],
      added: ["d"],
    });
    expect(diffInstallationText("a\nb\nb\n", "a\n")).toEqual({
      removed: ["b", "b"],
      added: [],
    });
    expect(diffInstallationText("a\n", "a\nb\n")).toEqual({
      removed: [],
      added: ["b"],
    });
    expect(renderInstallationDiff({ removed: ["b"], added: ["d"] })).toBe(
      "- b\n+ d",
    );
  });

  it("diffs the current installation value against the candidate write", () => {
    const diff = diffInstallation(baseFile, candidateFile());
    expect(diff.added.some((line) => line.includes("twilight"))).toBe(true);
    expect(diff.added.some((line) => line.includes("twilight.lan"))).toBe(true);
    // The current orchestrator host is untouched, so nothing of it is removed.
    expect(diff.removed.some((line) => line.includes("here"))).toBe(false);
  });

  it("serialises an accepted candidate with the v2 writer and a refused one as plain JSON", () => {
    const candidate = candidateFile();
    const parsed = parseInstallation(candidate);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !isFleetInstallationV2(parsed.installation)) {
      return;
    }
    expect(serialiseInstallationCandidate(candidate)).toBe(
      writeInstallationV2(parsed.installation),
    );

    const refused: HostDraftCandidate = { schemaVersion: 2, hosts: {} };
    expect(serialiseInstallationCandidate(refused)).toBe(
      `${JSON.stringify(refused, null, 2)}\n`,
    );
  });
});

describe("writeInstallation", () => {
  it("writes atomically with mode 600, returns the new hash and leaves no temp file", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    const candidate = candidateFile();
    try {
      const result = await writeInstallation({
        file,
        candidate,
        expectedHash: "absent",
      });
      expect(result.status).toBe("written");
      if (result.status !== "written") {
        return;
      }
      const bytes = await readFile(file);
      expect(result.hash).toBe(sha256Of(bytes));
      expect(bytes.toString("utf8")).toBe(
        serialiseInstallationCandidate(candidate),
      );
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(["fleet.json"]);
    } finally {
      await remove(dir);
    }
  });

  it("refuses a file that changed since the caller read its hash", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      const original = `${JSON.stringify(baseFile, null, 2)}\n`;
      await writeFile(file, original);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      const expectedHash = readHashOf(read);

      const tampered = `${JSON.stringify(
        {
          ...baseFile,
          hosts: { ...baseFile.hosts, extra: baseFile.hosts["here"] },
        },
        null,
        2,
      )}\n`;
      await writeFile(file, tampered);

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
      expect(result.currentHash).toBe(sha256Of(tampered));
      // The refused write left the file exactly as it was.
      expect(await readFile(file, "utf8")).toBe(tampered);
    } finally {
      await remove(dir);
    }
  });

  it("refuses a candidate the loader rejects, with the loader errors unchanged", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      const candidate: HostDraftCandidate = { schemaVersion: 2, hosts: {} };
      const result = await writeInstallation({
        file,
        candidate,
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("invalid");
      const parsed = parseInstallation(candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(result.errors).toEqual(parsed.errors);
      }
      expect(await readInstallationFile(file).then((read) => read.status)).toBe(
        "absent",
      );
    } finally {
      await remove(dir);
    }
  });

  it("refuses a candidate an operator built directly with an unsafe alias, writing nothing", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      // Not produced by draftHost: the candidate carries the unsafe alias,
      // so only the write's own loader call can catch it.
      const unsafe: HostDraftCandidate = {
        schemaVersion: 2,
        hosts: {
          here: {
            transport: "ssh",
            sshAlias: "-oProxyCommand=x",
            worktreeRoot: "/srv/fleet-v2/worktrees",
            roles: ["verifier"],
          },
        },
        forge: { mode: "none" },
      };
      const result = await writeInstallation({
        file,
        candidate: unsafe,
        expectedHash: "absent",
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("invalid");
      expect(result.errors.some((error) => error.includes("sshAlias"))).toBe(
        true,
      );
      // Nothing was written: no file, no temp residue.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await remove(dir);
    }
  });

  it('refuses a second writer with reason "locked" while the lock is held, leaving the file unchanged', async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    const original = `${JSON.stringify(baseFile, null, 2)}\n`;
    try {
      await writeFile(file, original);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      const expectedHash = readHashOf(read);

      // Simulate another writer holding the lock for the same file.
      await writeFile(`${file}.lock`, "");

      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") {
        return;
      }
      expect(result.reason).toBe("locked");
      // The refused write read nothing and touched nothing.
      expect(await readFile(file, "utf8")).toBe(original);
      expect(await readdir(dir)).toEqual(["fleet.json", "fleet.json.lock"]);
    } finally {
      await remove(dir);
    }
  });

  it.each([
    [
      "a live writer",
      () => `${process.pid} 2026-10-17T00:00:00.000Z`,
      "another write is in progress",
    ],
    [
      "a writer that is no longer running",
      () => "2147483646 2026-10-17T00:00:00.000Z",
      "stale lock held by pid 2147483646",
    ],
  ])(
    "names the lock holder for %s and the path to remove, changing nothing",
    async (_label, owner, expected) => {
      const dir = await tempDir();
      const file = join(dir, "fleet.json");
      const original = `${JSON.stringify(baseFile, null, 2)}\n`;
      try {
        await writeFile(file, original);
        const read = await readInstallationFile(file);
        const expectedHash = readHashOf(read);
        await writeFile(`${file}.lock`, `${owner()}\n`);

        const result = await writeInstallation({
          file,
          candidate: candidateFile(),
          expectedHash,
        });
        expect(result.status).toBe("refused");
        if (result.status !== "refused") {
          return;
        }
        expect(result.reason).toBe("locked");
        expect(result.currentHash).toBe("unknown");
        expect(result.errors[0]).toContain(expected);
        expect(result.errors[0]).toContain(`remove ${file}.lock`);
        expect(await readFile(file, "utf8")).toBe(original);
      } finally {
        await remove(dir);
      }
    },
  );

  it("never removes a lock another writer took after ours was removed by hand", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await writeFile(file, `${JSON.stringify(baseFile, null, 2)}\n`);
      const read = await readInstallationFile(file);
      // While our write is in flight (the candidate is re-validated), our lock
      // is removed by hand and another writer takes the path.
      const candidate = candidateFile();
      const planted = `${process.pid} other-writer\n`;
      const swapping = new Proxy(candidate as object, {
        get(target, key, receiver) {
          if (key === "hosts") {
            rmSync(`${file}.lock`, { force: true });
            writeFileSync(`${file}.lock`, planted);
          }
          return Reflect.get(target, key, receiver);
        },
      });
      await writeInstallation({
        file,
        candidate: swapping as typeof candidate,
        expectedHash: readHashOf(read),
      });
      expect(await readFile(`${file}.lock`, "utf8")).toBe(planted);
    } finally {
      await remove(dir);
    }
  });

  it("leaves no lock file behind after a successful write", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    try {
      await writeFile(file, `${JSON.stringify(baseFile, null, 2)}\n`);
      const read = await readInstallationFile(file);
      const result = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash: readHashOf(read),
      });
      expect(result.status).toBe("written");
      expect(await readdir(dir)).toEqual(["fleet.json"]);
    } finally {
      await remove(dir);
    }
  });

  it("releases the lock after a write, so the next writer with the same expected hash gets the stale refusal", async () => {
    const dir = await tempDir();
    const file = join(dir, "fleet.json");
    const original = `${JSON.stringify(baseFile, null, 2)}\n`;
    try {
      await writeFile(file, original);
      const read = await readInstallationFile(file);
      expect(read.status).toBe("read");
      const expectedHash = readHashOf(read);

      const first = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(first.status).toBe("written");
      if (first.status !== "written") {
        return;
      }
      // The lock file is gone after the write finished.
      expect(await readdir(dir)).toEqual(["fleet.json"]);

      // A second sequential writer still holds the caller's stale hash.
      const second = await writeInstallation({
        file,
        candidate: candidateFile(),
        expectedHash,
      });
      expect(second.status).toBe("refused");
      if (second.status !== "refused") {
        return;
      }
      expect(second.reason).toBe("changed");
      expect(second.currentHash).toBe(first.hash);
    } finally {
      await remove(dir);
    }
  });
});
