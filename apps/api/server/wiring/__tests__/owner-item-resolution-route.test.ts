// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so install the shared shim before any route module evaluates.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OwnerItem, OwnerItemRepositoryAdapter } from "@fleet/operator-coordination";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import { configurePresentedTokenResolver } from "../presented-token.js";

const VALID_TOKEN = "b".repeat(32);
const SEED_ISO = new Date(Date.now() - 60_000).toISOString();
const ACTOR = "owner-alice";

/** Invented fixture bodies; never a realistic secret value. */
function itemBody(kind: "secret" | "backup" | "other" | "merge" | "decision"): Record<string, unknown> {
  if (kind === "other") {
    return {
      projectId: "fixture-project",
      kind,
      subject: "fixture personal todo",
      refs: [],
      blocks: [],
    };
  }
  if (kind === "merge") {
    return {
      projectId: "fixture-project",
      kind,
      subject: null,
      refs: [{ kind: "pr", repository: "fixture-org/fixture-repo", number: 7 }],
      blocks: [],
    };
  }
  if (kind === "decision") {
    return {
      projectId: "fixture-project",
      kind,
      subject: null,
      refs: [{ kind: "question", id: "q-fixture-1" }],
      blocks: [],
    };
  }
  return {
    projectId: "fixture-project",
    kind,
    subject: null,
    refs: [],
    blocks: [],
  };
}

describe("owner item resolution route", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let resolutionPostHandler: EventHandler;

  beforeAll(async () => {
    resolutionPostHandler = (
      await import("../../routes/v1/owner-items/[id]/resolution.post.js")
    ).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-owner-item-resolution-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
    configurePresentedTokenResolver(null);

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post("/v1/owner-items/:id/resolution", resolutionPostHandler);
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configurePresentedTokenResolver(null);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}`, "content-type": "application/json" };
  }

  async function seedItem(id: string, body: Record<string, unknown>): Promise<void> {
    // The same store the composition owns: the adapter persists to
    // `<stateDir>/owner-items.json` and every read reloads from disk.
    const opened = OwnerItem.open({ itemId: id, createdBy: "fixture-owner", ...body }, SEED_ISO);
    expect(opened.success).toBe(true);
    if (!opened.success) {
      return;
    }
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(opened.value.toRecord(), 0);
  }

  async function storedItem(id: string): Promise<{ state: string; resolution: Record<string, unknown> | null; withdrawal: Record<string, unknown> | null; revision: number } | null> {
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    const stored = await adapter.get(id);
    if (stored === null) {
      return null;
    }
    return {
      state: stored.item.state,
      revision: stored.revision,
      resolution: stored.item.resolution as Record<string, unknown> | null,
      withdrawal: stored.item.withdrawal as Record<string, unknown> | null,
    };
  }

  async function post(itemId: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/owner-items/${encodeURIComponent(itemId)}/resolution`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  }

  it("marks secret, backup and other items done with via web and the token-derived actor persisted", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "tok-owner",
      scopes: ["operate"],
      actor: ACTOR,
    }));
    for (const kind of ["secret", "backup", "other"] as const) {
      const id = `oi-${kind}-done`;
      await seedItem(id, itemBody(kind));
      const res = await post(id, { action: "done" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { code: string; result: { outcome: string } };
      expect(body.code).toBe("OK");
      expect(body.result.outcome).toBe("resolved");
      const stored = await storedItem(id);
      expect(stored?.state).toBe("closed");
      expect(stored?.resolution).toMatchObject({ kind: "done", via: "web", by: ACTOR });
    }
  });

  it("falls back to the token id when the token carries no actor", async () => {
    configurePresentedTokenResolver(() => ({ tokenId: "tok-owner", scopes: ["operate"] }));
    const id = "oi-secret-by-token-id";
    await seedItem(id, itemBody("secret"));
    const res = await post(id, { action: "done" });
    expect(res.status).toBe(200);
    const stored = await storedItem(id);
    expect(stored?.state).toBe("closed");
    expect(stored?.resolution).toMatchObject({ kind: "done", via: "web", by: "tok-owner" });
  });

  it("withdraws with each typed reason and persists the withdrawal", async () => {
    for (const reason of ["no-longer-needed", "duplicate", "superseded"] as const) {
      const id = `oi-secret-withdraw-${reason}`;
      await seedItem(id, itemBody("secret"));
      const res = await post(id, { action: "withdraw", reason });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { outcome: string } };
      expect(body.result.outcome).toBe("resolved");
      const stored = await storedItem(id);
      expect(stored?.state).toBe("withdrawn");
      expect(stored?.withdrawal).toMatchObject({ reason, by: "shared-bearer", atIso: expect.any(String) });
      expect(stored?.resolution).toBeNull();
    }
  });

  it("refuses an invalid withdraw reason with 422 and leaves the record open", async () => {
    const id = "oi-secret-bad-reason";
    await seedItem(id, itemBody("secret"));
    const res = await post(id, { action: "withdraw", reason: "made-up-reason" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; result: { reason: string } };
    expect(body.code).toBe("REFUSED");
    expect(body.result.reason).toContain("no-longer-needed");
    const stored = await storedItem(id);
    expect(stored?.state).toBe("open");
    expect(stored?.withdrawal).toBeNull();
  });

  it("refuses merge and decision items with 422 and leaves them unchanged", async () => {
    for (const kind of ["merge", "decision"] as const) {
      const id = `oi-${kind}-refused`;
      await seedItem(id, itemBody(kind));
      for (const action of [{ action: "done" }, { action: "withdraw", reason: "duplicate" }]) {
        const res = await post(id, action);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { code: string; result: { reason: string } };
        expect(body.code).toBe("REFUSED");
        const stored = await storedItem(id);
        expect(stored?.state).toBe("open");
        expect(stored?.withdrawal).toBeNull();
        expect(stored?.resolution).toBeNull();
      }
    }
  });

  it("answers an unknown item id with 404", async () => {
    const res = await post("oi-missing", { action: "done" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; result: null };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.result).toBeNull();
  });

  it("rejects a read-scoped token with 403 before the handler writes; an operate token passes", async () => {
    const id = "oi-secret-scoped";
    await seedItem(id, itemBody("secret"));
    configurePresentedTokenResolver(() => ({ tokenId: "tok-read", scopes: ["read"] }));
    const denied = await post(id, { action: "done" });
    expect(denied.status).toBe(403);
    const stored = await storedItem(id);
    expect(stored?.state).toBe("open");

    configurePresentedTokenResolver(() => ({ tokenId: "tok-operate", scopes: ["operate"] }));
    const allowed = await post(id, { action: "done" });
    expect(allowed.status).toBe(200);
    expect((await storedItem(id))?.state).toBe("closed");
  });

  it("refuses observe-pr, answer and plan-decision actions", async () => {
    const id = "oi-secret-actions";
    await seedItem(id, itemBody("secret"));
    const refused = [
      { action: "observe-pr" },
      { action: "answer" },
      { action: "plan-decision" },
    ];
    for (const body of refused) {
      const res = await post(id, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      expect((await storedItem(id))?.state).toBe("open");
    }
  });

  it("refuses body attempts to spoof itemId, via, by or actor and writes nothing", async () => {
    const id = "oi-secret-spoof";
    await seedItem(id, itemBody("secret"));
    const spoofed = [
      { action: "done", itemId: "oi-other" },
      { action: "done", via: "cli" },
      { action: "done", by: "spoofed-actor" },
      { action: "done", actor: "spoofed-actor" },
      { action: "done", sessionId: "web-session-1" },
    ];
    for (const body of spoofed) {
      const res = await post(id, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      const stored = await storedItem(id);
      expect(stored?.state).toBe("open");
      expect(stored?.resolution).toBeNull();
    }
  });

  it("answers 501 when the runtime is unconfigured", async () => {
    configureFleetApiRuntime(null);
    const res = await post("oi-secret-unconfigured", { action: "done" });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_IMPLEMENTED");
  });
});
