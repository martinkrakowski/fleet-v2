// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so install the shared shim before any route module evaluates.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createRouter, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerItemRepositoryAdapter } from "@fleet/operator-coordination";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import { configurePresentedTokenResolver } from "../presented-token.js";
import { requiredScope } from "../route-scopes.js";

// The throwing-getter refusal is exercised through the real route path: the
// mock delegates to the shared reader unless this test flips the flag, in
// which case the parsed body carries a getter that throws when read. The
// spread inside `readObjectBody` then raises before any use case runs, and
// the route's catch maps it to 500 without leaking the message.
const httpInputState = { throwOnRead: false };

vi.mock("../http-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http-input")>();
  return {
    ...actual,
    readObjectBody: async (
      event: Parameters<typeof actual.readObjectBody>[0],
      options?: Parameters<typeof actual.readObjectBody>[1],
    ) => {
      const body = await actual.readObjectBody(event, options);
      if (httpInputState.throwOnRead) {
        return new Proxy(body, {
          get() {
            throw new Error("fixture getter failure, never echoed");
          },
        });
      }
      return body;
    },
  };
});

const VALID_TOKEN = "b".repeat(32);
const ACTOR = "owner-alice";
const FIXTURE_SECRET = `sk-${"a".repeat(24)}`;

function otherBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "fixture-project",
    kind: "other",
    subject: "fixture personal todo",
    refs: [],
    blocks: [],
    ...extra,
  };
}

describe("owner item create route", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  let createPostHandler: EventHandler;

  beforeAll(async () => {
    createPostHandler = (await import("../../routes/v1/owner-items/index.post.js")).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-owner-item-create-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
    configurePresentedTokenResolver(() => ({
      tokenId: "tok-owner",
      scopes: ["operate"],
      actor: ACTOR,
    }));

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post("/v1/owner-items", createPostHandler);
    app.use(router.handler);

    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    httpInputState.throwOnRead = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configurePresentedTokenResolver(null);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}`, "content-type": "application/json" };
  }

  async function post(body: unknown, rawBody?: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/owner-items`, {
      method: "POST",
      headers: authHeaders(),
      body: rawBody ?? JSON.stringify(body),
    });
  }

  async function listStored(): Promise<Array<Record<string, unknown>>> {
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    const listed = await adapter.list();
    return listed.map((stored) => stored.item as unknown as Record<string, unknown>);
  }

  it("maps POST /v1/owner-items to the operate scope", () => {
    expect(requiredScope("POST", "/v1/owner-items")).toBe("operate");
  });

  it("records a personal other item with the token-derived actor persisted", async () => {
    const res = await post(otherBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: string;
      result: { outcome: string; item: Record<string, unknown>; revision: number };
    };
    expect(body.code).toBe("OK");
    expect(body.result.outcome).toBe("recorded");
    expect(body.result.item).toMatchObject({
      kind: "other",
      subject: "fixture personal todo",
      state: "open",
      createdBy: ACTOR,
    });
    const stored = await listStored();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "other", createdBy: ACTOR, state: "open" });
  });

  it("defaults omitted refs and blocks to empty arrays", async () => {
    const res = await post({ projectId: "fixture-project", kind: "other", subject: "fixture personal todo" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { item: Record<string, unknown> } };
    expect(body.result.item.refs).toEqual([]);
    expect(body.result.item.blocks).toEqual([]);
  });

  it("returns an existing holder as a 200 success without a second record", async () => {
    const refs = [{ kind: "question", id: "q-fixture-1" }];
    const first = await post(otherBody({ refs }));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { result: { outcome: string } }).result.outcome).toBe("recorded");
    const second = await post(otherBody({ refs }));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { result: { outcome: string } }).result.outcome).toBe("exists");
    expect(await listStored()).toHaveLength(1);
  });

  it("returns 501 NOT_IMPLEMENTED when runtime is unconfigured", async () => {
    configureFleetApiRuntime(null);
    const res = await post(otherBody());
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; result: null };
    expect(body.code).toBe("NOT_IMPLEMENTED");
    expect(body.result).toBeNull();
  });

  it("refuses every kind other than other and missing kind with 422", async () => {
    for (const kind of ["secret", "merge", "decision", "backup", null, 123, undefined]) {
      const body = kind === undefined
        ? { projectId: "fixture-project", subject: "fixture personal todo" }
        : otherBody({ kind });
      const res = await post(body);
      expect(res.status).toBe(422);
      const parsed = (await res.json()) as { code: string; result: { reason: string } };
      expect(parsed.code).toBe("REFUSED");
      expect(parsed.result.reason).toBe("owner item creation from this route accepts only kind other");
      expect(parsed.result.reason).not.toContain(String(kind));
      expect(await listStored()).toHaveLength(0);
    }
  });

  it("refuses secret-shaped subject with 422 and no echo", async () => {
    const res = await post(otherBody({ subject: FIXTURE_SECRET }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; result: { reason: string } };
    expect(body.code).toBe("REFUSED");
    expect(body.result.reason).not.toContain(FIXTURE_SECRET);
    expect(await listStored()).toHaveLength(0);
  });

  it("refuses missing, blank, control-char, and over-120-char subjects with 422", async () => {
    const subjects: unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "two\nlines",
      `a\u0007b`,
      "x".repeat(121),
      123,
    ];
    for (const subject of subjects) {
      const res = await post(otherBody({ subject }));
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      expect(await listStored()).toHaveLength(0);
    }
  });

  it("refuses invalid or missing projectId with 422", async () => {
    const projectIds: unknown[] = [undefined, null, "", "bad id!", FIXTURE_SECRET, 123];
    for (const projectId of projectIds) {
      const res = await post(otherBody({ projectId }));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; result: { reason: string } };
      expect(body.code).toBe("REFUSED");
      if (typeof projectId === "string" && projectId.length > 0) {
        expect(body.result.reason).not.toContain(projectId);
      }
      expect(await listStored()).toHaveLength(0);
    }
  });

  it("refuses non-array refs or blocks with 422", async () => {
    const invalid: Array<Record<string, unknown>> = [
      otherBody({ refs: { kind: "pr" } }),
      otherBody({ refs: "pr" }),
      otherBody({ refs: null }),
      otherBody({ refs: 3 }),
      otherBody({ blocks: {} }),
      otherBody({ blocks: "lane" }),
      otherBody({ blocks: null }),
    ];
    for (const body of invalid) {
      const res = await post(body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      expect(await listStored()).toHaveLength(0);
    }
  });

  it("refuses unexpected body fields such as itemId, createdBy, or nowIso with 422", async () => {
    const spoofed = [
      otherBody({ itemId: "oi-spoofed" }),
      otherBody({ createdBy: "spoofed-actor" }),
      otherBody({ createdAtIso: "2026-01-01T00:00:00Z" }),
      otherBody({ state: "closed" }),
      otherBody({ resolution: { kind: "done" } }),
      otherBody({ actor: "spoofed-actor" }),
      otherBody({ nowIso: "2026-01-01T00:00:00Z" }),
    ];
    for (const body of spoofed) {
      const res = await post(body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      expect(await listStored()).toHaveLength(0);
    }
  });

  it("returns 400 BAD_REQUEST for array or invalid JSON body", async () => {
    const invalid: Array<string | undefined> = [
      JSON.stringify([otherBody()]),
      "{not json",
      JSON.stringify("a string"),
      JSON.stringify(7),
    ];
    for (const rawBody of invalid) {
      const res = await post(undefined, rawBody);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; result: null };
      expect(body.code).toBe("BAD_REQUEST");
      expect(body.result).toBeNull();
    }
  });

  it("returns 413 for body exceeding MAX_JSON_BODY_BYTES", async () => {
    const res = await post(undefined, JSON.stringify({ projectId: "fixture-project", kind: "other", subject: "x".repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; result: null };
    expect(body.code).toBe("BAD_REQUEST");
    expect(body.result).toBeNull();
  });

  it("returns 500 INTERNAL_ERROR when a throwing getter is present on the body without leaking details", async () => {
    httpInputState.throwOnRead = true;
    const res = await post(otherBody());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; result: null };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.result).toBeNull();
    expect(JSON.stringify(body)).not.toContain("fixture getter failure");
  });

  it("returns 422 REFUSED on key-held conflict and never records", async () => {
    const refs = [{ kind: "question", id: "q-fixture-held" }];
    const first = await post(otherBody({ refs }));
    expect(first.status).toBe(200);
    // Another project holding the same question key: the holder wins.
    const second = await post(otherBody({ refs, projectId: "another-project" }));
    expect(second.status).toBe(422);
    const body = (await second.json()) as { code: string; result: { reason: string } };
    expect(body.code).toBe("REFUSED");
    expect(await listStored()).toHaveLength(1);
  });

  it("rejects a read-scoped token with 403 and allows an operate token", async () => {
    configurePresentedTokenResolver(() => ({ tokenId: "tok-read", scopes: ["read"] }));
    const denied = await post(otherBody());
    expect(denied.status).toBe(403);
    expect(await listStored()).toHaveLength(0);

    configurePresentedTokenResolver(() => ({ tokenId: "tok-operate", scopes: ["operate"], actor: ACTOR }));
    const allowed = await post(otherBody());
    expect(allowed.status).toBe(200);
    expect(await listStored()).toHaveLength(1);
  });
});
