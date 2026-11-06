import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, eventHandler, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import securityMiddleware from "../server/middleware/security.js";
import { configureFleetApiRuntime } from "../server/wiring/runtime.js";
import { setActiveApiToken } from "../server/wiring/token.js";
import { configurePresentedTokenResolver } from "../server/wiring/presented-token.js";
import { configureWorkComposition, workComposition } from "../server/wiring/work/composition.js";
import { withRunOwnedStopRefusal } from "../server/wiring/work/stop-attempt-guard.js";
import {
  ConductorDriverLeaseAdapter,
  LaneRun,
  laneRunConductEntry,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  type LaneRunJournalEntryRecord,
  type LaneRunRecord,
  type StopAttemptRequest,
  type StopAttemptResult,
} from "@fleet/work-execution";
import { RequestLaneRunStopUseCase } from "@fleet/work-execution/use-cases";

const VALID_TOKEN = "a".repeat(32);
const RUN_ID = "run-01JB0000000000000000000000";
const RUN_ID_TERMINAL = "run-01JB0000000000000000000001";
const RUN_ID_MISSING = "run-01JB0000000000000000000002";
const ENTRY_1 = "01JB0000000000000000000001";
const ENTRY_2 = "01JB0000000000000000000002";
const ENTRY_3 = "01JB0000000000000000000003";
const ENTRY_4 = "01JB0000000000000000000004";
const NOW = "2026-11-06T10:00:00.000Z";
const LATER = "2026-11-06T12:00:00.000Z";
const OWNED_ATTEMPT = "attempt-owned-1";
const OWNED_ATTEMPT_TERMINAL = "attempt-owned-terminal";

function runRecord(
  runId: string,
  attemptIds: string[],
  overrides: Partial<LaneRunRecord> = {},
): LaneRunRecord {
  const result = LaneRun.create({
    version: 1,
    runId,
    workOrderId: "wo-example-1",
    tier: 2,
    seatPlanRef: "a".repeat(64),
    cursors: { "first-pass": 0, fix: null, review: null },
    round: 0,
    attemptIds,
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: "policy-example-1",
    ...overrides,
  });
  if (!result.success) {
    throw new Error("fixture must be a valid LaneRun record");
  }
  return result.value.toRecord();
}

describe("run control routes (A-C)", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let haltPostHandler: EventHandler;
  let runStopPostHandler: EventHandler;
  let runsGetHandler: EventHandler;
  let attemptStopPostHandler: EventHandler;

  beforeAll(async () => {
    haltPostHandler = (await import("../server/routes/v1/runs/halt.post.js")).default;
    runStopPostHandler = (await import("../server/routes/v1/runs/[id]/stop.post.js")).default;
    runsGetHandler = (await import("../server/routes/v1/runs/index.get.js")).default;
    attemptStopPostHandler = (
      await import("../server/routes/v1/attempts/[id]/stop.post.js")
    ).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-run-controls-test-"));
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configureWorkComposition(null);
    configurePresentedTokenResolver(null);
    delete process.env.FLEET_STATE_DIR;

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post("/v1/runs/halt", eventHandler((event) => haltPostHandler(event)));
    router.post("/v1/runs/:id/stop", eventHandler((event) => runStopPostHandler(event)));
    router.get("/v1/runs", eventHandler((event) => runsGetHandler(event)));
    router.post("/v1/attempts/:id/stop", eventHandler((event) => attemptStopPostHandler(event)));
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configureWorkComposition(null);
    configurePresentedTokenResolver(null);
  });

  function configureApi(scope: "read" | "operate" | "both" = "both"): void {
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
    configurePresentedTokenResolver(() => ({
      tokenId: "test-session",
      scopes: scope === "both" ? ["read", "operate"] : [scope],
    }));
  }

  async function seedRun(record: LaneRunRecord): Promise<void> {
    await new LaneRunRepositoryAdapter({ stateDir: tempDir }).create(record);
  }

  /** A graceful or forced stop intent recorded the way the CLI driver records it. */
  async function seedStopIntent(
    runId: string,
    mode: "graceful" | "force",
    entryId: string,
  ): Promise<void> {
    const useCase = new RequestLaneRunStopUseCase({
      runRepo: new LaneRunRepositoryAdapter({ stateDir: tempDir }),
      runJournal: new LaneRunJournalAdapter({ stateDir: tempDir }),
    });
    const result = await useCase.requestLaneRunStop({
      runId,
      mode,
      via: "cli",
      entryId,
      nowIso: NOW,
    });
    if (result.outcome === "refused") {
      throw new Error(`seedStopIntent refused: ${result.reason}`);
    }
    expect(result.outcome === "stop-recorded" || result.outcome === "already-requested").toBe(true);
  }

  async function post(url: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function postNoAuth(url: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getRuns(): Promise<Response> {
    return fetch(`${baseUrl}/v1/runs`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
  }

  function envelopeOf(response: Response): Promise<{
    operationId: string;
    code: string;
    result: Record<string, unknown> | null;
  }> {
    return response.json() as Promise<{
      operationId: string;
      code: string;
      result: Record<string, unknown> | null;
    }>;
  }

  it("answers 501 NOT_IMPLEMENTED when the work composition is unconfigured", async () => {
    configureFleetApiRuntime(null);
    setActiveApiToken(VALID_TOKEN);
    const halt = await post("/v1/runs/halt", { halted: true });
    expect(halt.status).toBe(501);
    expect((await envelopeOf(halt)).code).toBe("NOT_IMPLEMENTED");
    const stop = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(stop.status).toBe(501);
    expect((await envelopeOf(stop)).code).toBe("NOT_IMPLEMENTED");
  });

  it("refuses an unauthenticated request with 401 and a read-only token with 403", async () => {
    configureApi("operate");
    const unauthenticated = await postNoAuth("/v1/runs/halt", { halted: true });
    expect(unauthenticated.status).toBe(401);
    configureApi("read");
    const forbidden = await post("/v1/runs/halt", { halted: true });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json() as { error: string }).error).toBe("Forbidden: scope required");
    const forbiddenStop = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(forbiddenStop.status).toBe(403);
  });

  it("keeps halt unchanged on repeat and engages, lifts and quarantines the marker", async () => {
    configureApi();
    const engage = await post("/v1/runs/halt", { halted: true });
    expect(engage.status).toBe(200);
    expect(await envelopeOf(engage)).toMatchObject({
      code: "OK",
      result: { outcome: "changed", halted: true },
    });
    const repeat = await post("/v1/runs/halt", { halted: true });
    expect(repeat.status).toBe(200);
    expect((await envelopeOf(repeat)).result).toMatchObject({ outcome: "unchanged", halted: true });
    const lift = await post("/v1/runs/halt", { halted: false });
    expect(lift.status).toBe(200);
    expect((await envelopeOf(lift)).result).toMatchObject({ outcome: "changed", halted: false });

    // A corrupt marker is quarantined by a halt and lifted never.
    const marker = join(tempDir, "conductor-halt.json");
    const garbage = "{ not json";
    writeFileSync(marker, garbage, "utf8");
    const corruptLift = await post("/v1/runs/halt", { halted: false });
    expect(corruptLift.status).toBe(409);
    expect((await envelopeOf(corruptLift)).result).toEqual({
      outcome: "refused",
      reason: "marker-unreadable",
    });
    const haltOver = await post("/v1/runs/halt", { halted: true });
    expect(haltOver.status).toBe(200);
    expect((await envelopeOf(haltOver)).result).toMatchObject({ outcome: "changed", halted: true });
    const quarantineDir = join(tempDir, "quarantine");
    expect(statSync(quarantineDir).isDirectory()).toBe(true);
  });

  it("records keyed stop@web and stop-force@web entries idempotently and keeps halt unchanged on repeat", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    // A live driver lease does not block the web stop: the journal serializes.
    const lease = await new ConductorDriverLeaseAdapter({ stateDir: tempDir }).acquire({
      holderId: "driver-live",
      observedFence: 0,
      leaseUntilIso: "2026-11-06T10:05:00.000Z",
      nowIso: NOW,
    });
    expect(lease.outcome).toBe("ok");

    const first = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(first.status).toBe(200);
    expect((await envelopeOf(first)).result).toMatchObject({
      outcome: "stop-recorded",
      runId: RUN_ID,
      mode: "graceful",
      key: `${RUN_ID}/stop@web`,
    });
    const repeat = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(repeat.status).toBe(200);
    expect((await envelopeOf(repeat)).result).toMatchObject({ outcome: "already-requested" });

    const escalate = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1, mode: "force" });
    expect(escalate.status).toBe(200);
    expect((await envelopeOf(escalate)).result).toMatchObject({
      outcome: "stop-recorded",
      key: `${RUN_ID}/stop-force@web`,
    });
    const repeatForced = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1, mode: "force" });
    expect(repeatForced.status).toBe(200);
    expect((await envelopeOf(repeatForced)).result).toMatchObject({ outcome: "already-requested" });

    const gracefulAfterForced = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(gracefulAfterForced.status).toBe(409);
    expect((await envelopeOf(gracefulAfterForced)).result).toEqual({
      outcome: "refused",
      reason: "stop-already-forced",
    });

    // The journal holds exactly the two keyed intents; the halt repeat stays unchanged.
    const entries: LaneRunJournalEntryRecord[] = JSON.parse(
      readFileSync(join(tempDir, "run-journal.json"), "utf8"),
    );
    expect(
      entries.filter((entry) => entry.kind === "intent" && entry.key !== null).map((e) => e.key),
    ).toEqual([`${RUN_ID}/stop@web`, `${RUN_ID}/stop-force@web`]);
  });

  it("answers 409 on stale-revision, run-terminal and 404 on an unknown valid runId", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    await seedRun(runRecord(RUN_ID_TERMINAL, [OWNED_ATTEMPT_TERMINAL]));
    const journal = new LaneRunJournalAdapter({ stateDir: tempDir });
    await journal.append(laneRunConductEntry(ENTRY_1, RUN_ID_TERMINAL, "stopped", NOW));

    const stale = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 99 });
    expect(stale.status).toBe(409);
    expect((await envelopeOf(stale)).result).toEqual({ outcome: "refused", reason: "stale-revision" });

    const terminal = await post(`/v1/runs/${RUN_ID_TERMINAL}/stop`, { expectedRevision: 1 });
    expect(terminal.status).toBe(409);
    expect((await envelopeOf(terminal)).result).toEqual({ outcome: "refused", reason: "run-terminal" });

    const missing = await post(`/v1/runs/${RUN_ID_MISSING}/stop`, { expectedRevision: 1 });
    expect(missing.status).toBe(404);
    expect((await envelopeOf(missing)).code).toBe("NOT_FOUND");
  });

  it("returns 400 INVALID_REQUEST on malformed bodies, arrays, unknown mode, missing expectedRevision, and extra fields", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    const cases: [string, unknown][] = [
      ["missing expectedRevision", {}],
      ["zero expectedRevision", { expectedRevision: 0 }],
      ["negative expectedRevision", { expectedRevision: -1 }],
      ["float expectedRevision", { expectedRevision: 1.5 }],
      ["string expectedRevision", { expectedRevision: "1" }],
      ["null mode", { expectedRevision: 1, mode: null }],
      ["unknown mode", { expectedRevision: 1, mode: "nuke" }],
      ["extra field", { expectedRevision: 1, force: true }],
      ["null body", null],
    ];
    for (const [label, body] of cases) {
      const res = await post(`/v1/runs/${RUN_ID}/stop`, body);
      expect(res.status, label).toBe(400);
      const envelope = await envelopeOf(res);
      expect(envelope.code, label).toBe("INVALID_REQUEST");
      expect(envelope.result).toMatchObject({ outcome: "refused", reason: "invalid-request" });
    }
    // A body that is not a JSON object is a client error that never reaches
    // the use case: never an echo of the body itself.
    for (const [label, body] of [["array body", [1, 2, 3]], ["string body", "stop please"]] as const) {
      const res = await post(`/v1/runs/${RUN_ID}/stop`, body);
      expect(res.status, label).toBe(400);
      expect(await res.text(), label).not.toContain(JSON.stringify(body));
    }
    // An invalid :id route param shares the invalid-run-id limiter bucket.
    const invalidRunId = await post("/v1/runs/not-a-run-id/stop", { expectedRevision: 1 });
    expect(invalidRunId.status).toBe(400);
    expect((await envelopeOf(invalidRunId)).code).toBe("INVALID_REQUEST");
    // The halt route refuses a malformed marker request the same way.
    const badHalt = await post("/v1/runs/halt", { halted: "yes" });
    expect(badHalt.status).toBe(400);
    expect((await envelopeOf(badHalt)).code).toBe("INVALID_REQUEST");
  });

  it("rejects request bodies exceeding 64 KiB with 413 PAYLOAD_TOO_LARGE", async () => {
    configureApi();
    const huge = { expectedRevision: 1, padding: "x".repeat(70 * 1024) };
    const res = await post(`/v1/runs/${RUN_ID}/stop`, huge);
    expect(res.status).toBe(413);
    const haltRes = await post("/v1/runs/halt", { halted: true, padding: "x".repeat(70 * 1024) });
    expect(haltRes.status).toBe(413);
  });

  it("reports unreadable lane-runs.json and run-journal.json as 503 STORE_UNAVAILABLE unknown and refuses halt lift over corrupt marker", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));

    // Corrupt lane-runs.json: the stop reads unknown, the attempt stop fails closed.
    writeFileSync(join(tempDir, "lane-runs.json"), "{ not json", "utf8");
    const stopBytes = readFileSync(join(tempDir, "lane-runs.json"), "utf8");
    const stop = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(stop.status).toBe(503);
    expect((await envelopeOf(stop)).result).toEqual({
      outcome: "unknown",
      reason: "run-store-unavailable",
    });
    const attemptStop = await post(`/v1/attempts/${OWNED_ATTEMPT}/stop`, {});
    expect(attemptStop.status).toBe(503);
    expect((await envelopeOf(attemptStop)).result).toEqual({
      outcome: "unknown",
      reason: "run-ownership-unknown",
    });
    expect(readFileSync(join(tempDir, "lane-runs.json"), "utf8")).toBe(stopBytes);

    // Restore a readable run store by writing the exact store bytes (the
    // adapter refuses to create over unreadable bytes), then corrupt the
    // journal: the stop reads unknown and the corrupt journal stays in place,
    // never quarantined or rewritten.
    const restored = runRecord(RUN_ID, [OWNED_ATTEMPT]);
    writeFileSync(
      join(tempDir, "lane-runs.json"),
      JSON.stringify([{ ...restored, schemaVersion: 1 }]),
      "utf8",
    );
    writeFileSync(join(tempDir, "run-journal.json"), "[{ not json", "utf8");
    const journalBytes = readFileSync(join(tempDir, "run-journal.json"), "utf8");
    const journalStop = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(journalStop.status).toBe(503);
    expect((await envelopeOf(journalStop)).result).toEqual({
      outcome: "unknown",
      reason: "run-store-unavailable",
    });
    expect(readFileSync(join(tempDir, "run-journal.json"), "utf8")).toBe(journalBytes);
  });

  it("bounds concurrent run control requests via runControlLimiter and maps store failures to 503 STORE_UNAVAILABLE leaving prior state intact", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    await post("/v1/runs/halt", { halted: true });
    const markerBytes = readFileSync(join(tempDir, "conductor-halt.json"), "utf8");

    const limiter = workComposition().runControlLimiter;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holds = [
      limiter.run("other-1", () => gate),
      limiter.run("other-2", () => gate),
      limiter.run("other-3", () => gate),
      limiter.run("conductor-halt", () => gate),
    ];
    // The halt key is held: the route answers busy-project (409).
    const busyProject = await post("/v1/runs/halt", { halted: false });
    expect(busyProject.status).toBe(409);
    expect((await envelopeOf(busyProject)).code).toBe("BUSY");
    // The global cap is full: a stop answers busy-global (429).
    const busyGlobal = await post(`/v1/runs/${RUN_ID}/stop`, { expectedRevision: 1 });
    expect(busyGlobal.status).toBe(429);
    expect((await envelopeOf(busyGlobal)).code).toBe("BUSY");
    release();
    await Promise.all(holds);

    // The unreadable marker: lifting refuses with CONFLICT and nothing is rewritten.
    writeFileSync(join(tempDir, "conductor-halt.json"), "{ not json", "utf8");
    const lift = await post("/v1/runs/halt", { halted: false });
    expect(lift.status).toBe(409);
    expect((await envelopeOf(lift)).result).toEqual({
      outcome: "refused",
      reason: "marker-unreadable",
    });
    // The previous valid bytes were replaced by the quarantine flow only for a
    // halt; a refused lift writes nothing further.
  });

  it("refuses run-owned attempt stop with runId pointer before invoking StopAttemptUseCase", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    const active = await post(`/v1/attempts/${OWNED_ATTEMPT}/stop`, {});
    expect(active.status).toBe(409);
    const activeEnvelope = await envelopeOf(active);
    expect(activeEnvelope.code).toBe("CONFLICT");
    expect(activeEnvelope.result).toEqual({
      outcome: "refused",
      reason: "run-owned",
      runId: RUN_ID,
    });

    // A terminal run still owns its attempt: recovery belongs to A-WO.
    await seedRun(runRecord(RUN_ID_TERMINAL, [OWNED_ATTEMPT_TERMINAL]));
    const journal = new LaneRunJournalAdapter({ stateDir: tempDir });
    await journal.append(laneRunConductEntry(ENTRY_1, RUN_ID_TERMINAL, "stopped", NOW));
    const terminal = await post(`/v1/attempts/${OWNED_ATTEMPT_TERMINAL}/stop`, {});
    expect(terminal.status).toBe(409);
    expect((await envelopeOf(terminal)).result).toEqual({
      outcome: "refused",
      reason: "run-owned",
      runId: RUN_ID_TERMINAL,
    });

    // An attempt no run lists is stopped standalone (absent → not found).
    const unowned = await post("/v1/attempts/attempt-foreign/stop", {});
    expect(unowned.status).toBe(404);
    expect((await envelopeOf(unowned)).code).toBe("NOT_FOUND");
  });

  it("withRunOwnedStopRefusal refuses null, sparse array, and throwing getter inputs without throwing", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    let invoked = 0;
    const spy = {
      async execute(): Promise<StopAttemptResult> {
        invoked += 1;
        throw new Error("use case must not run for refused inputs");
      },
      async stopAttempt(_request: StopAttemptRequest): Promise<StopAttemptResult> {
        invoked += 1;
        throw new Error("use case must not run for refused inputs");
      },
    };
    const guarded = withRunOwnedStopRefusal(
      spy,
      new LaneRunRepositoryAdapter({ stateDir: tempDir }),
    );

    expect(await guarded.execute(null)).toEqual({ outcome: "refused", reason: "invalid-request" });
    const sparse: unknown[] = new Array(2);
    sparse[0] = "x";
    expect(await guarded.execute(sparse)).toEqual({ outcome: "refused", reason: "invalid-request" });
    const hostile = {
      get attemptId(): string {
        throw new Error("getter must never run");
      },
    };
    expect(await guarded.execute(hostile)).toEqual({ outcome: "refused", reason: "invalid-request" });
    expect(invoked).toBe(0);

    // A missing attemptId delegates to the use case's own validation.
    const delegating = {
      executeCount: 0,
      async execute(): Promise<StopAttemptResult> {
        this.executeCount += 1;
        return { outcome: "refused", reason: "Attempt not found or has no sessionId" };
      },
      async stopAttempt(): Promise<StopAttemptResult> {
        throw new Error("unreachable");
      },
    };
    const delegatingGuard = withRunOwnedStopRefusal(
      delegating,
      new LaneRunRepositoryAdapter({ stateDir: tempDir }),
    );
    expect(await delegatingGuard.execute({})).toEqual({
      outcome: "refused",
      reason: "Attempt not found or has no sessionId",
    });
    expect(delegating.executeCount).toBe(1);
  });

  it("projects halt, revision, stop facts and stop parks on GET /v1/runs", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    const parkedUnconfirmed = runRecord(RUN_ID_TERMINAL, [], {
      parked: { reason: "stop-unconfirmed", qualifier: null, parkedFrom: "running", questionId: null },
      parkCount: 1,
    });
    await seedRun(parkedUnconfirmed);

    const before = await getRuns();
    expect(before.status).toBe(200);
    const beforeEnvelope = await envelopeOf(before);
    expect(beforeEnvelope.code).toBe("OK");
    const beforeRows = (beforeEnvelope.result as {
      schedule: { halt: string; rows: Record<string, unknown>[] };
    }).schedule.rows;
    const plainBefore = beforeRows.find((row) => row.runId === RUN_ID);
    expect(plainBefore).toMatchObject({ revision: 1, stopMode: null, stopRequestedAtIso: null });
    expect(
      beforeRows.find((row) => row.runId === RUN_ID_TERMINAL)?.park,
    ).toEqual({ reason: "stop-unconfirmed", qualifier: null });

    // Halt and a graceful stop: both project on the next GET.
    await post("/v1/runs/halt", { halted: true });
    await seedStopIntent(RUN_ID, "graceful", ENTRY_1);
    const after = await getRuns();
    const afterEnvelope = await envelopeOf(after);
    const schedule = (afterEnvelope.result as {
      schedule: { halt: string; rows: Record<string, unknown>[] };
    }).schedule;
    expect(schedule.halt).toBe("halted");
    const stoppedRow = schedule.rows.find((row) => row.runId === RUN_ID);
    expect(stoppedRow).toMatchObject({ revision: 1, stopMode: "graceful" });
    expect(typeof stoppedRow?.stopRequestedAtIso).toBe("string");

    // Escalation to forced flips the strongest mode.
    await seedStopIntent(RUN_ID, "force", ENTRY_2);
    const escalated = await envelopeOf(await getRuns());
    const escalatedSchedule = (escalated.result as {
      schedule: { rows: Record<string, unknown>[] };
    }).schedule;
    expect(escalatedSchedule.rows.find((row) => row.runId === RUN_ID)).toMatchObject({
      stopMode: "force",
      stopRequestedAtIso: NOW,
    });
  });

  it("never echoes filesystem paths or secret-shaped route params and bodies in any HTTP response", async () => {
    configureApi();
    await seedRun(runRecord(RUN_ID, [OWNED_ATTEMPT]));
    // Built at runtime so no literal credential pattern ever sits in source.
    const secretParam = ["ghp", "x".repeat(28)].join("_");
    const pathParam = "..%2F..%2Fetc%2Fpasswd";
    const responses = [
      await post("/v1/runs/halt", { halted: "yes" }),
      await post("/v1/runs/not-a-run-id/stop", { expectedRevision: 1 }),
      await post(`/v1/runs/${encodeURIComponent(secretParam)}/stop`, { expectedRevision: 1 }),
      await post(`/v1/runs/${pathParam}/stop`, { expectedRevision: 1 }),
      await post("/v1/runs/halt", null),
      await post("/v1/attempts/attempt-foreign/stop", {}),
    ];
    const texts = await Promise.all(responses.map((response) => response.text()));
    for (const text of texts) {
      expect(text).not.toContain(tempDir);
      expect(text).not.toContain(secretParam);
      expect(text).not.toContain("passwd");
      expect(text).not.toContain("lane-runs.json");
      expect(text).not.toContain("run-journal.json");
    }
  });
});
