import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LaneDeclarationRecord } from "../../../domain/lane-activity-records.js";
import { DeclarationRepositoryAdapter } from "../DeclarationRepositoryAdapter.adapter.js";

const LANE = {
  kind: "plan",
  projectId: "example-project",
  planId: "plan-1",
  laneId: "lane-1",
} as const;

function record(declaredAtIso: string): LaneDeclarationRecord {
  return {
    version: 1,
    lane: LANE,
    step: "gate",
    seatRole: "builder",
    model: "example-model",
    declaredAtIso,
    lapsesAtIso: "2026-10-27T11:30:00.000Z",
  };
}

describe("DeclarationRepositoryAdapter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fleet-lane-declarations-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("round-trips appends through the real file and a fresh adapter", async () => {
    const writer = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    const first = await writer.append(record("2026-10-27T10:00:00.000Z"));
    expect(first.outcome).toBe("saved");
    const second = await writer.append(record("2026-10-27T10:05:00.000Z"));
    expect(second).toEqual({ outcome: "saved", revision: 2 });

    const reader = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    const listed = await reader.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]!.declaredAtIso).toBe("2026-10-27T10:00:00.000Z");
    expect(listed[1]!.declaredAtIso).toBe("2026-10-27T10:05:00.000Z");
  });

  it("never deletes a lapsed declaration: both stay listed after a new append", async () => {
    const adapter = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    await adapter.append(record("2026-10-27T10:00:00.000Z"));
    await adapter.append(record("2026-10-27T12:00:00.000Z"));
    expect(await adapter.list()).toHaveLength(2);
  });

  it("an unparsable file quarantines, reads as empty and refuses writes", async () => {
    const target = path.join(tempDir, "lane-declarations.json");
    await fs.writeFile(target, "not json at all", "utf8");

    const adapter = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    expect(await adapter.list()).toEqual([]);
    const attempted = await adapter.append(record("2026-10-27T10:00:00.000Z"));
    expect(attempted.outcome).toBe("refused");
    expect(await adapter.list()).toEqual([]);

    const quarantine = await fs.readdir(path.join(tempDir, "quarantine"));
    expect(
      quarantine.some((name) => name.startsWith("lane-declarations.json.")),
    ).toBe(true);
  });

  it("an invalid record in the file is refused the same way", async () => {
    const target = path.join(tempDir, "lane-declarations.json");
    await fs.writeFile(
      target,
      JSON.stringify([{ version: 1, lane: LANE }]),
      "utf8",
    );
    const adapter = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    expect(await adapter.list()).toEqual([]);
    expect(
      (await adapter.append(record("2026-10-27T10:00:00.000Z"))).outcome,
    ).toBe("refused");
  });

  it("a read that quarantines blocks later writes on the same adapter instance", async () => {
    const target = path.join(tempDir, "lane-declarations.json");
    await fs.writeFile(target, "not json at all", "utf8");

    const adapter = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    expect(await adapter.list()).toEqual([]);

    const result = await adapter.append(record("2026-10-27T10:00:00.000Z"));
    expect(result).toEqual({
      outcome: "refused",
      reason:
        "the declaration store is quarantined; no write until it is repaired",
    });
    expect(await fs.readFile(target, "utf8")).toBe("not json at all");

    await fs.rm(target);
    const afterRemoval = await adapter.append(
      record("2026-10-27T10:00:00.000Z"),
    );
    expect(afterRemoval).toEqual({
      outcome: "refused",
      reason:
        "the declaration store is quarantined; no write until it is repaired",
    });
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("a genuine interleaved write between read and write is refused by the CAS, leaving the file intact", async () => {
    const target = path.join(tempDir, "lane-declarations.json");
    const first = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    await first.append(record("2026-10-27T10:00:00.000Z"));
    const rogue = JSON.stringify([record("2026-10-27T09:00:00.000Z")], null, 2);

    // A writer that bypasses the lock replaces the file exactly between the
    // adapter's list read and its compare-and-swap re-read.
    const raced = new DeclarationRepositoryAdapter({
      stateDir: tempDir,
      onLockMidWrite: async () => {
        await fs.writeFile(target, rogue, "utf8");
      },
    });
    const result = await raced.append(record("2026-10-27T10:05:00.000Z"));
    expect(result).toEqual({
      outcome: "refused",
      reason:
        "the declaration store changed during the write; no write was made",
    });
    expect(await fs.readFile(target, "utf8")).toEqual(rogue);
    const reader = new DeclarationRepositoryAdapter({ stateDir: tempDir });
    const listed = await reader.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.declaredAtIso).toBe("2026-10-27T09:00:00.000Z");
  });

  it("the in-memory variant keeps its own list", async () => {
    const adapter = new DeclarationRepositoryAdapter();
    await adapter.append(record("2026-10-27T10:00:00.000Z"));
    expect(await adapter.list()).toHaveLength(1);
    expect(await new DeclarationRepositoryAdapter().list()).toHaveLength(0);
  });
});
