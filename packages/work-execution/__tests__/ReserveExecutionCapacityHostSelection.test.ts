/**
 * H9a2: the host is chosen inside the locked reserve. When `candidateHosts`
 * are given, the use case picks among them inside the journal's locked
 * read-modify-write: kind-filtered, per-host held counts, most free slots
 * (ties by name), `no-capacity` when nothing is free, a refusal on a tool
 * mismatch, and the worktree path allocated from the attempt digest.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AttemptRecord,
  CapacityReservationRecord,
} from "../src/domain/execution-records.js";
import type { AttemptRepositoryPort } from "../src/application/ports/out/AttemptRepositoryPort.out-port.js";
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
  ReserveCapacityAtomicallyResult,
} from "../src/application/ports/out/ExecutionJournalPort.out-port.js";
import { ReserveExecutionCapacityUseCase } from "../src/application/use-cases/ReserveExecutionCapacityUseCase.use-case.js";
import { simpleDeterministicHexDigest } from "../src/application/use-cases/PrepareBriefPackageUseCase.use-case.js";
import type { ReserveExecutionCapacityCandidateHost } from "../src/application/ports/in/ReserveExecutionCapacityPort.in-port.js";
import { ExecutionJournalAdapter } from "../src/infrastructure/adapters/ExecutionJournalAdapter.adapter.js";

// ---------------------------------------------------------------------------
// Fakes (mirroring ReserveExecutionCapacityUseCase.test.ts)
// ---------------------------------------------------------------------------

class InMemoryJournal implements ExecutionJournalPort {
  readonly reservations = new Map<string, CapacityReservationRecord>();

  async appendJournalEntry(): Promise<void> {}
  async listJournalEntriesForAttempt(): Promise<readonly []> {
    return [];
  }

  async saveCapacityReservation(
    reservation: CapacityReservationRecord,
  ): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }

  async listActiveReservations(): Promise<
    readonly CapacityReservationRecord[]
  > {
    return [...this.reservations.values()].filter((r) => r.held);
  }

  async releaseCapacityReservation(
    attemptId: string,
    releasedAtIso: string,
  ): Promise<boolean> {
    for (const [id, r] of this.reservations) {
      if (r.attemptId === attemptId && r.held) {
        this.reservations.set(id, { ...r, held: false, releasedAtIso });
        return true;
      }
    }
    return false;
  }

  /** Mirrors the adapter's locked arbitration: selection, duplicate, busy, budget, lowest slot. */
  async reserveCapacityAtomically(
    request: ReserveCapacityAtomicallyRequest,
  ): Promise<ReserveCapacityAtomicallyResult> {
    const held = [...this.reservations.values()].filter((r) => r.held);
    const chosen = request.selectRecord
      ? await request.selectRecord(held)
      : {
          outcome: "selected" as const,
          record: request.record!,
          maxSlots: request.maxSlots!,
        };
    if (chosen.outcome !== "selected") {
      return chosen;
    }
    const duplicate = held.find((r) => r.attemptId === request.attemptId);
    if (duplicate !== undefined) {
      return {
        outcome: "duplicate-attempt",
        attemptId: request.attemptId,
        existingReservationId: duplicate.id,
      };
    }
    if (request.checkBusyWorktree) {
      const verdict = await request.checkBusyWorktree(held);
      if (verdict.outcome === "busy-worktree") {
        return {
          outcome: "busy-worktree",
          blockingAttemptId: verdict.blockingAttemptId,
        };
      }
    }
    const heldOnHost = held.filter((r) => r.hostId === chosen.record.hostId);
    if (heldOnHost.length >= chosen.maxSlots) {
      return {
        outcome: "no-free-slot",
        heldCount: heldOnHost.length,
        maxSlots: chosen.maxSlots,
      };
    }
    const usedSlots = new Set(heldOnHost.map((r) => r.slotIndex));
    let slotIndex = 0;
    while (usedSlots.has(slotIndex)) {
      slotIndex += 1;
    }
    const reservation: CapacityReservationRecord = {
      ...chosen.record,
      slotIndex,
    };
    this.reservations.set(reservation.id, reservation);
    return { outcome: "reserved", reservation };
  }
}

class InMemoryAttemptRepo implements AttemptRepositoryPort {
  private attempts = new Map<string, AttemptRecord>();

  async findAttemptById(id: string): Promise<AttemptRecord | null> {
    return this.attempts.get(id) ?? null;
  }
  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.attempts.set(record.id, record);
  }
  async listAttemptsByWorkOrder(): Promise<readonly AttemptRecord[]> {
    return [];
  }
  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()];
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function candidate(
  overrides: Partial<ReserveExecutionCapacityCandidateHost> & { name: string },
): ReserveExecutionCapacityCandidateHost {
  return {
    kind: "opencode",
    transport: "local",
    sshAlias: null,
    port: 4166,
    maxLanes: 1,
    worktreeRoot: "/srv/fleet/worktrees",
    ...overrides,
  };
}

function makeUseCase(
  journal?: ExecutionJournalPort,
): ReserveExecutionCapacityUseCase {
  return new ReserveExecutionCapacityUseCase({
    journal: journal ?? new InMemoryJournal(),
    attemptRepo: new InMemoryAttemptRepo(),
  });
}

function reserveRequest(
  overrides: {
    reservationId?: string;
    attemptId?: string;
    seatTool?: "opencode" | "agy";
    candidates?: ReserveExecutionCapacityCandidateHost[];
  } = {},
) {
  return {
    reservationId: overrides.reservationId ?? "res-h9a2",
    attemptId: overrides.attemptId ?? "att-h9a2",
    workOrderId: "wo-h9a2",
    seatTool: overrides.seatTool ?? ("opencode" as const),
    candidateHosts: overrides.candidates,
  } as Parameters<
    ReserveExecutionCapacityUseCase["reserveExecutionCapacity"]
  >[0];
}

function heldReservation(
  hostName: string,
  attemptId: string,
): CapacityReservationRecord {
  return {
    id: `res-${attemptId}`,
    attemptId,
    hostId: hostName,
    slotIndex: 0,
    held: true,
    seatTool: "opencode",
    hostName,
    hostKind: "opencode",
    transport: "local",
    sshAlias: null,
    port: 4166,
    worktreePath: null,
    reservedAtIso: "2026-10-16T00:00:00.000Z",
    releasedAtIso: null,
  };
}

function digestOf(attemptId: string): string {
  return simpleDeterministicHexDigest(attemptId).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Host selection inside the locked reserve (H9a2)
// ---------------------------------------------------------------------------

describe("ReserveExecutionCapacityUseCase candidate hosts (H9a2)", () => {
  it("skips a full host and picks the one with free slots", async () => {
    const journal = new InMemoryJournal();
    journal.reservations.set(
      "res-full",
      heldReservation("busy", "att-elsewhere"),
    );
    const useCase = makeUseCase(journal);
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        candidates: [
          candidate({ name: "busy" }),
          candidate({ name: "free", worktreeRoot: "/srv/other" }),
        ],
      }),
    );
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved")
      throw new Error("expected a reservation");
    expect(result.reservation.hostName).toBe("free");
    expect(result.reservation.worktreePath).toBe(
      `/srv/other/${digestOf("att-h9a2")}`,
    );
  });

  it("breaks a tie by host name", async () => {
    const useCase = makeUseCase();
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        candidates: [candidate({ name: "zeta" }), candidate({ name: "alpha" })],
      }),
    );
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved")
      throw new Error("expected a reservation");
    expect(result.reservation.hostName).toBe("alpha");
  });

  it("prefers the host with more free slots over an earlier name", async () => {
    const journal = new InMemoryJournal();
    journal.reservations.set("res-a", heldReservation("alpha", "att-1"));
    const useCase = makeUseCase(journal);
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        candidates: [
          candidate({ name: "alpha", maxLanes: 3 }),
          candidate({ name: "beta", maxLanes: 1 }),
        ],
      }),
    );
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved")
      throw new Error("expected a reservation");
    expect(result.reservation.hostName).toBe("alpha");
  });

  it("reports no-capacity when every candidate host is full", async () => {
    const journal = new InMemoryJournal();
    journal.reservations.set("res-a", heldReservation("alpha", "att-1"));
    journal.reservations.set("res-b", heldReservation("beta", "att-2"));
    const useCase = makeUseCase(journal);
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        candidates: [candidate({ name: "alpha" }), candidate({ name: "beta" })],
      }),
    );
    expect(result).toEqual({ outcome: "no-capacity" });
  });

  it("refuses a tool mismatch with a named reason and never falls back to another kind", async () => {
    const useCase = makeUseCase();
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        seatTool: "agy",
        candidates: [candidate({ name: "only-opencode" })],
      }),
    );
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("expected a refusal");
    expect(result.reason).toContain(
      "no candidate host declares runner kind 'agy'",
    );
  });

  it("allocates the worktree path as the digest under the chosen host root; no caller text appears in it", async () => {
    const useCase = makeUseCase();
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        attemptId: "att-digest",
        candidates: [candidate({ name: "solo", worktreeRoot: "/srv/root/" })],
      }),
    );
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved")
      throw new Error("expected a reservation");
    expect(result.reservation.worktreePath).toBe(
      `/srv/root/${digestOf("att-digest")}`,
    );
    // Neither the attempt id text nor the reservation id reaches the path.
    expect(result.reservation.worktreePath).not.toContain("att-digest");
    expect(result.reservation.worktreePath).not.toContain("res-h9a2");
  });

  it("records the chosen host fields on the reservation", async () => {
    const useCase = makeUseCase();
    const result = await useCase.reserveExecutionCapacity(
      reserveRequest({
        candidates: [
          candidate({
            name: "lanehost",
            transport: "ssh",
            sshAlias: "m",
            port: 4166,
            maxLanes: 2,
          }),
        ],
      }),
    );
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved")
      throw new Error("expected a reservation");
    expect(result.reservation.hostName).toBe("lanehost");
    expect(result.reservation.hostKind).toBe("opencode");
    expect(result.reservation.transport).toBe("ssh");
    expect(result.reservation.sshAlias).toBe("m");
    expect(result.reservation.port).toBe(4166);
    expect(result.reservation.hostId).toBe("lanehost");
  });

  it("never takes the same last slot twice: two concurrent reserves on the file journal", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "fleet-h9a2-race-"),
    );
    try {
      const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
      const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });
      const useCaseA = new ReserveExecutionCapacityUseCase({
        journal: adapterA,
        attemptRepo: new InMemoryAttemptRepo(),
      });
      const useCaseB = new ReserveExecutionCapacityUseCase({
        journal: adapterB,
        attemptRepo: new InMemoryAttemptRepo(),
      });
      const candidates = [candidate({ name: "solo", maxLanes: 1 })];
      const [a, b] = await Promise.all([
        useCaseA.reserveExecutionCapacity(
          reserveRequest({
            reservationId: "res-race-a",
            attemptId: "att-race-a",
            candidates,
          }),
        ),
        useCaseB.reserveExecutionCapacity(
          reserveRequest({
            reservationId: "res-race-b",
            attemptId: "att-race-b",
            candidates,
          }),
        ),
      ]);
      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["no-capacity", "reserved"]);
      const persisted = JSON.parse(
        await fs.readFile(path.join(tempDir, "reservations.json"), "utf8"),
      ) as CapacityReservationRecord[];
      const heldOnHost = persisted.filter(
        (reservation) => reservation.held && reservation.hostName === "solo",
      );
      expect(heldOnHost).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("keeps the legacy hostId/maxSlots/worktreePath path when candidateHosts is absent", async () => {
    const useCase = makeUseCase();
    const result = await useCase.reserveExecutionCapacity({
      reservationId: "res-legacy",
      attemptId: "att-legacy",
      workOrderId: "wo-legacy",
      hostId: "legacy-host",
      worktreePath: "/legacy/path",
      maxSlots: 2,
      seatTool: "opencode",
    });
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved")
      throw new Error("expected a reservation");
    expect(result.reservation.hostId).toBe("legacy-host");
    expect(result.reservation.hostName).toBeNull();
    expect(result.reservation.worktreePath).toBe("/legacy/path");
  });

  // H9a fix (review): the id fields are required on the candidates path too;
  // the check must not be wrapped in the legacy-path branch.
  it("refuses candidates with an empty attempt id and an empty reservation id", async () => {
    const useCase = makeUseCase();
    const emptyAttemptId = await useCase.reserveExecutionCapacity(
      reserveRequest({
        reservationId: "res-x",
        attemptId: "   ",
        candidates: [candidate({ name: "alpha" })],
      }),
    );
    expect(emptyAttemptId).toEqual({
      outcome: "refused",
      reason: "Missing required reservation fields: attemptId",
    });
    const emptyReservationId = await useCase.reserveExecutionCapacity(
      reserveRequest({
        reservationId: "",
        attemptId: "att-x",
        candidates: [candidate({ name: "alpha" })],
      }),
    );
    expect(emptyReservationId).toEqual({
      outcome: "refused",
      reason: "Missing required reservation fields: reservationId",
    });
  });
});

// ---------------------------------------------------------------------------
// v2 dispatch never defaults the seat tool (H9a2)
// ---------------------------------------------------------------------------

describe("DispatchAttemptUseCase installationSchemaVersion (H9a2)", () => {
  it("refuses a manifest whose model assignment carries no seat tool for a v2 installation, and keeps the legacy default otherwise", async () => {
    const { DispatchAttemptUseCase } =
      await import("../src/application/use-cases/DispatchAttemptUseCase.use-case.js");
    const prose = "# Brief prose";
    const manifest = JSON.stringify({
      modelAssignment: { model: "m", agent: null, variant: null },
    });
    const workspace = {
      async inspectWorktree(request: {
        worktreePath: string;
        baseCommit: string;
      }) {
        return {
          worktreePath: request.worktreePath,
          checkedOutCommit: request.baseCommit,
          matchesBaseCommit: true,
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
        };
      },
      async readWorktreeFile(_worktreePath: string, relativePath: string) {
        return relativePath === ".lane/brief-manifest.json" ? manifest : prose;
      },
    };
    const runner = {
      describeCapabilities: () => ({
        filesystemScope: "scoped-worktree",
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        authoritativeCompletion: true,
        artifactPersistence: true,
      }),
      describeRunner: () => ({
        kind: "opencode" as const,
        remotePort: 4166,
        host: null,
        hostName: null,
        agent: null,
        model: "m",
        variant: null,
      }),
      startCalls: [] as unknown[],
      async startSession(request: unknown) {
        this.startCalls.push(request);
        return { outcome: "started" as const, sessionId: "ses-1" };
      },
    };
    const journal = {
      entries: [] as unknown[],
      async appendJournalEntry(entry: unknown) {
        this.entries.push(entry);
      },
      async listJournalEntriesForAttempt() {
        return [];
      },
      async listActiveReservations() {
        return [
          {
            id: "res-1",
            attemptId: "att-v2-dispatch",
            hostId: "h",
            slotIndex: 0,
            held: true,
            seatTool: "opencode" as const,
            reservedAtIso: "",
            releasedAtIso: null,
          },
        ];
      },
      async releaseCapacityReservation() {
        return true;
      },
      async saveCapacityReservation() {},
      async reserveCapacityAtomically() {
        throw new Error("reserveCapacityAtomically must not be called");
      },
    };
    const buildUseCase = () =>
      new DispatchAttemptUseCase({
        workOrderRepo: {
          async findWorkOrderById() {
            return {
              id: "wo-1",
              state: "implementing",
            };
          },
        } as never,
        attemptRepo: {
          async findAttemptById() {
            return null;
          },
          async saveAttempt() {},
        } as never,
        journal: journal as never,
        workspace: workspace as never,
        runner: runner as never,
        runnerSelector: {
          selectRunner(request: { seatTool: string }) {
            return {
              ok: true as const,
              kind: request.seatTool as "opencode",
              hostName: null,
              remotePort: null,
            };
          },
        },
      });
    const baseRequest = {
      attemptId: "att-v2-dispatch",
      workOrderId: "wo-1",
      worktreePath: "/lanes/att-v2-dispatch",
      briefPackagePath: ".lane/brief.md",
      briefDigest: simpleDeterministicHexDigest(prose + "\n" + manifest),
      baseCommit: "abc123",
      stepLimit: 40,
      timeLimitSeconds: 3600,
      nowIso: "2026-10-16T00:00:00.000Z",
    };

    // A v2 installation never defaults: the manifest without a seat tool refuses.
    const v2 = await buildUseCase().dispatchAttempt({
      ...baseRequest,
      installationSchemaVersion: 2,
    });
    expect(v2.outcome).toBe("refused");
    if (v2.outcome !== "refused") throw new Error("expected a refusal");
    expect(v2.reason).toContain("declares no seat tool");
    expect(runner.startCalls).toEqual([]);
    expect(journal.entries).toEqual([]);

    // A v1 installation keeps the legacy opencode default.
    const v1 = await buildUseCase().dispatchAttempt({
      ...baseRequest,
      installationSchemaVersion: 1,
    });
    expect(v1.outcome).toBe("started");

    // An absent installation keeps the legacy default too.
    const absent = await buildUseCase().dispatchAttempt(baseRequest);
    expect(absent.outcome).toBe("started");
  });
});
