// Nitro auto-imports h3 utilities into the global scope at build time;
// vitest does not, so install the shared shim before any route module evaluates.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp, createEvent, createRouter, toNodeListener, type EventHandler } from "h3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OwnerItem, OwnerItemRepositoryAdapter } from "@fleet/operator-coordination";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import { configurePresentedTokenResolver, type PresentedTokenResolver } from "../presented-token.js";

const VALID_TOKEN = "c".repeat(32);
const ACTOR = "owner-bob";
const RAW_BODY_SYMBOL = Symbol.for("h3RawBody");
const PARSED_BODY_SYMBOL = Symbol.for("h3ParsedBody");

/** Invented fixture body; never a realistic secret value. */
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
    configurePresentedTokenResolver(null);

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
    setActiveApiToken(null);
    configurePresentedTokenResolver(null);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}`, "content-type": "application/json" };
  }

  async function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/owner-items`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
  }

  async function postWithResolver(
    resolver: PresentedTokenResolver,
    body: unknown,
  ): Promise<Response> {
    configurePresentedTokenResolver(resolver);
    return post(body);
  }

  async function storedItems(): Promise<Array<Record<string, unknown>>> {
    // The same store the composition owns: the adapter persists to
    // `<stateDir>/owner-items.json` and every read reloads from disk.
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    const all = await adapter.list();
    return all.map((entry) => entry.item as unknown as Record<string, unknown>);
  }

  async function seedItem(id: string, body: Record<string, unknown>): Promise<void> {
    const opened = OwnerItem.open({ itemId: id, createdBy: "fixture-owner", ...body }, new Date(Date.now() - 60_000).toISOString());
    expect(opened.success).toBe(true);
    if (!opened.success) {
      return;
    }
    const adapter = new OwnerItemRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(opened.value.toRecord(), 0);
  }

  it("records a personal other item with the token-derived actor persisted", async () => {
    const res = await postWithResolver(() => ({ tokenId: "tok-owner", scopes: ["operate"], actor: ACTOR }), otherBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; result: { outcome: string; item: { kind: string; subject: string; createdBy: string; itemId: string } } };
    expect(body.code).toBe("OK");
    expect(body.result.outcome).toBe("recorded");
    expect(body.result.item.kind).toBe("other");
    expect(body.result.item.createdBy).toBe(ACTOR);
    const items = await storedItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.createdBy).toBe(ACTOR);
  });

  it("falls back to the token id when the token carries no actor", async () => {
    const res = await postWithResolver(() => ({ tokenId: "tok-owner", scopes: ["operate"] }), otherBody());
    expect(res.status).toBe(200);
    const items = await storedItems();
    expect(items[0]?.createdBy).toBe("tok-owner");
  });

  it("returns the existing item when the natural key is held by a same-kind, same-project item", async () => {
    const seededBody = otherBody({ refs: [{ kind: "question", id: "q-fixture-1" }] });
    const first = await post(seededBody);
    expect(first.status).toBe(200);
    const second = await post(seededBody);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { code: string; result: { outcome: string } };
    expect(body.result.outcome).toBe("exists");
    expect(await storedItems()).toHaveLength(1);
  });

  it("returns 422 REFUSED when another kind holds the natural key, with no input echoed", async () => {
    await seedItem("oi-decision-holder", {
      projectId: "fixture-project",
      kind: "decision",
      subject: null,
      refs: [{ kind: "question", id: "q-fixture-2" }],
      blocks: [],
    });
    const res = await post(otherBody({ refs: [{ kind: "question", id: "q-fixture-2" }] }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; result: { reason: string } };
    expect(body.code).toBe("REFUSED");
    expect(body.result.reason).not.toContain("fixture personal todo");
  });

  it("refuses every kind other than other and missing kind with 422", async () => {
    for (const kind of ["secret", "merge", "decision", "backup", null, 123, undefined]) {
      const body: Record<string, unknown> = otherBody();
      if (kind === undefined) {
        delete body.kind;
      } else {
        body.kind = kind;
      }
      const res = await post(body);
      expect(res.status).toBe(422);
      const parsed = (await res.json()) as { code: string; result: { reason: string } };
      expect(parsed.code).toBe("REFUSED");
      expect(parsed.result.reason).toBe("owner item creation from this route accepts only kind other");
    }
  });

  it("refuses secret-shaped subject with 422 and no echo", async () => {
    // An invented token-shaped value, never a real secret. Built by
    // concatenation like snapshot-routes.test.ts so the source line never
    // carries a complete credential shape; at runtime it is still refused.
    const hostile = "ghp_" + "i".repeat(30);
    const res = await post(otherBody({ subject: hostile }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; result: { reason: string } };
    expect(body.code).toBe("REFUSED");
    expect(JSON.stringify(body)).not.toContain(hostile);
  });

  it("refuses missing, blank, control-char, and over-120-char subjects with 422", async () => {
    const hostileSubjects: unknown[] = [
      undefined,
      "",
      "   ",
      "line one\nline two",
      "\u0007bell",
      "x".repeat(121),
      42,
    ];
    for (const subject of hostileSubjects) {
      const res = await post(otherBody({ subject }));
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
    }
  });

  it("refuses invalid, missing, and secret-shaped projectId with 422 and no echo", async () => {
    // Invented secret-shaped fixture, assembled so no literal credential is committed.
    const secretShaped = `${"gh"}p_${"a1B2".repeat(9)}`;
    const invalid: unknown[] = [
      undefined,
      "",
      "with space",
      "-leading-dash",
      "/path/like",
      42,
      secretShaped,
    ];
    for (const projectId of invalid) {
      const res = await post(otherBody({ projectId }));
      expect(res.status).toBe(422);
      const text = await res.text();
      expect((JSON.parse(text) as { code: string }).code).toBe("REFUSED");
      expect(text).not.toContain(secretShaped);
    }
    expect(await storedItems()).toHaveLength(0);
  });

  it("refuses non-array refs or blocks with 422", async () => {
    const nonArrays = [{}, "nope", null, 3];
    for (const value of nonArrays) {
      for (const field of ["refs", "blocks"] as const) {
        const res = await post(otherBody({ [field]: value }));
        expect(res.status).toBe(422);
        expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      }
    }
  });

  it("refuses unexpected body fields such as itemId, createdBy, or nowIso with 422", async () => {
    const spoofed = [
      { itemId: "oi-spoofed" },
      { createdBy: "spoofed-actor" },
      { createdAtIso: "2026-01-01T00:00:00Z" },
      { state: "closed" },
      { resolution: { kind: "done" } },
      { nowIso: "2026-01-01T00:00:00Z" },
      { actor: "spoofed-actor" },
    ];
    for (const extra of spoofed) {
      const res = await post(otherBody(extra));
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
      expect(await storedItems()).toHaveLength(0);
    }
  });

  it("returns 400 BAD_REQUEST for an array, null, empty-string, or invalid JSON body", async () => {
    for (const raw of ["[1,2,3]", "{invalid", "null", '""']) {
      const res = await fetch(`${baseUrl}/v1/owner-items`, {
        method: "POST",
        headers: authHeaders(),
        body: raw,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; result: null };
      expect(body.code).toBe("BAD_REQUEST");
      expect(body.result).toBeNull();
    }
  });

  it("returns 413 for body exceeding MAX_JSON_BODY_BYTES", async () => {
    const res = await fetch(`${baseUrl}/v1/owner-items`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ padding: "x".repeat(64 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("BAD_REQUEST");
  });

  it("returns 500 INTERNAL_ERROR when a throwing getter is present on the body without leaking details", async () => {
    configurePresentedTokenResolver(() => ({ tokenId: "tok-owner", scopes: ["operate"], actor: ACTOR }));
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "subject", {
      get() {
        throw new Error("hostile getter fired with fixture values");
      },
      enumerable: true,
    });
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/v1/owner-items",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
        "content-length": "2",
      },
      aborted: false,
    });
    (req as unknown as Record<symbol, unknown>)[RAW_BODY_SYMBOL] = Promise.resolve(Buffer.from("{}"));
    (req as unknown as Record<symbol, unknown>)[PARSED_BODY_SYMBOL] = hostile;
    const res = { statusCode: 200, setHeader: () => {}, getHeader: () => {} };
    const event = createEvent(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    const outcome = (await (createPostHandler as (e: unknown) => Promise<unknown>)(event)) as Record<string, unknown>;
    expect(res.statusCode).toBe(500);
    expect(outcome).toEqual({ code: "INTERNAL_ERROR", operationId: expect.any(String), result: null });
    expect(await storedItems()).toHaveLength(0);
  });

  it("returns 422 REFUSED on store failure, never silent success", async () => {
    // Make the store file path a directory: every read of the store fails, so
    // the use case refuses as 'store' rather than throwing or succeeding.
    const storeFile = join(tempDir, "owner-items.json");
    mkdirSync(storeFile);
    const res = await post(otherBody());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; result: { reason: string } };
    expect(body.code).toBe("REFUSED");
  });

  it("returns 422 REFUSED when the clock cannot be read, never silent success", async () => {
    const spy = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
      throw new RangeError("fixture clock failure");
    });
    let res: Response;
    try {
      res = await post(otherBody());
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("REFUSED");
    expect(await storedItems()).toHaveLength(0);
  });

  it("rejects a read-scoped token with 403 and allows an operate token", async () => {
    configurePresentedTokenResolver(() => ({ tokenId: "tok-read", scopes: ["read"] }));
    const denied = await post(otherBody());
    expect(denied.status).toBe(403);
    expect(await storedItems()).toHaveLength(0);

    const allowed = await postWithResolver(() => ({ tokenId: "tok-operate", scopes: ["operate"], actor: ACTOR }), otherBody());
    expect(allowed.status).toBe(200);
    expect(await storedItems()).toHaveLength(1);
  });

  it("answers 501 NOT_IMPLEMENTED when the runtime is unconfigured", async () => {
    configureFleetApiRuntime(null);
    const res = await post(otherBody());
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; result: null };
    expect(body.code).toBe("NOT_IMPLEMENTED");
    expect(body.result).toBeNull();
  });
});
