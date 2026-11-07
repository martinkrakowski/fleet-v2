// T2c: the tool-permission hook and verdict routes over a loopback server,
// authenticating through the shared security middleware. The hook answers the
// Claude Code PermissionRequest envelope; the verdict route records the first
// verdict. No response ever carries updatedInput, the tool name or the tool
// input, and the actor is always the presenting token's id.
import "./nitro-globals.js";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createRouter,
  toNodeListener,
  type EventHandler,
} from "h3";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import securityMiddleware from "../../middleware/security.js";
import { setActiveApiToken } from "../token.js";
import { configureFleetApiRuntime } from "../runtime.js";
import { configurePresentedTokenResolver } from "../presented-token.js";
import {
  configureOperatorComposition,
  createConfiguredOperatorComposition,
  getOperatorComposition,
} from "../operator/composition.js";

const VALID_TOKEN = "a".repeat(32);
const FUTURE_ISO = "2099-01-01T00:00:00.000Z";

describe("tool-permission routes", () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;

  let hookPostHandler: EventHandler;
  let verdictPostHandler: EventHandler;

  beforeAll(async () => {
    hookPostHandler = (
      await import("../../routes/v1/threads/[id]/permissions/index.post.js")
    ).default;
    verdictPostHandler = (
      await import("../../routes/v1/threads/[id]/permissions/[requestId]/verdict.post.js")
    ).default;
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "fleet-api-permissions-"));
    setActiveApiToken(VALID_TOKEN);
    configureFleetApiRuntime({ stateDir: tempDir });
    configurePresentedTokenResolver(() => ({
      tokenId: "test-token",
      scopes: ["hook", "verdict"],
    }));

    const app = createApp();
    app.use(securityMiddleware);
    const router = createRouter();
    router.post("/v1/threads/:id/permissions", hookPostHandler);
    router.post("/v1/threads/:id/permissions/:requestId/verdict", verdictPostHandler);
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
    configurePresentedTokenResolver(null);
    setActiveApiToken(null);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${VALID_TOKEN}` };
  }

  function hookRequest(threadId: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/threads/${threadId}/permissions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function waitForPending(): Promise<{ requestId: string }> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const pending = getOperatorComposition().permissionRequestRepository.listPending();
      if (pending.length > 0) {
        return { requestId: pending[0].requestId };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no pending permission request appeared");
  }

  it("the hook route answers with the allow envelope", async () => {
    const hookPromise = hookRequest("t1", {
      tool_name: "bash",
      tool_input: { cwd: "/repo" },
    });
    const { requestId } = await waitForPending();

    const verdictRes = await fetch(
      `${baseUrl}/v1/threads/t1/permissions/${requestId}/verdict`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    expect(verdictRes.status).toBe(200);

    const hookRes = await hookPromise;
    expect(hookRes.status).toBe(200);
    expect(await hookRes.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("the hook route answers with the deny envelope and a message when no verdict arrives before the deadline", async () => {
    configureOperatorComposition(
      createConfiguredOperatorComposition({ permissionDeadlineMs: 50 }),
    );
    const res = await hookRequest("t1", { tool_name: "bash", tool_input: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "no verdict in 50 ms" },
      },
    });
  });

  it("the hook route answers with the deny envelope when the owner denies", async () => {
    const hookPromise = hookRequest("t1", {
      tool_name: "bash",
      tool_input: {},
    });
    const { requestId } = await waitForPending();

    const verdictRes = await fetch(
      `${baseUrl}/v1/threads/t1/permissions/${requestId}/verdict`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    expect(verdictRes.status).toBe(200);

    const hookRes = await hookPromise;
    expect(hookRes.status).toBe(200);
    expect(await hookRes.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "the owner denied this tool call" },
      },
    });
  });

  it("the hook route refuses a malformed body with 400 and never echoes the tool input", async () => {
    const marker = "TOOL_INPUT_MARKER";

    const arrayRes = await fetch(`${baseUrl}/v1/threads/t1/permissions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify([{ tool_name: "bash", tool_input: marker }]),
    });
    expect(arrayRes.status).toBe(400);
    const arrayText = await arrayRes.text();
    expect(arrayText).not.toContain(marker);
    expect(arrayText).not.toContain("bash");

    const nullRes = await fetch(`${baseUrl}/v1/threads/t1/permissions`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: "null",
    });
    expect(nullRes.status).toBe(400);
    expect(await nullRes.text()).not.toContain(marker);
  });

  it("the hook route refuses a token without the hook scope with 403", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "verdict-token",
      scopes: ["verdict"],
    }));
    const res = await hookRequest("t1", { tool_name: "bash", tool_input: {} });
    expect(res.status).toBe(403);
  });

  it("the verdict route records the first verdict, returns the same verdict for the same decision and 409 with the first verdict for a different decision", async () => {
    getOperatorComposition().permissionRequestRepository.record({
      requestId: "req-route-1",
      threadId: "t1",
      toolName: "bash",
      toolInput: {},
      requestedAtIso: new Date().toISOString(),
      deadlineAtIso: FUTURE_ISO,
      state: "pending",
    });

    const postVerdict = (decision: string) =>
      fetch(`${baseUrl}/v1/threads/t1/permissions/req-route-1/verdict`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });

    const firstRes = await postVerdict("allow");
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json();
    expect(first.code).toBe("OK");
    expect(first.result).toMatchObject({
      requestId: "req-route-1",
      decision: "allow",
      actorId: "test-token",
    });
    expect(typeof first.result.decidedAtIso).toBe("string");

    const sameRes = await postVerdict("allow");
    expect(sameRes.status).toBe(200);
    expect((await sameRes.json()).result).toEqual(first.result);

    const conflictRes = await postVerdict("deny");
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).result).toEqual(first.result);
  });

  it("the verdict route answers 404 for an unknown request id", async () => {
    const res = await fetch(
      `${baseUrl}/v1/threads/t1/permissions/req-nope/verdict`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.result).toBeNull();
  });

  it("the verdict route refuses a token without the verdict scope with 403", async () => {
    configurePresentedTokenResolver(() => ({
      tokenId: "hook-token",
      scopes: ["hook"],
    }));
    const res = await fetch(
      `${baseUrl}/v1/threads/t1/permissions/req-route-1/verdict`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("no response ever carries updatedInput, the tool name or the tool input", async () => {
    configureOperatorComposition(
      createConfiguredOperatorComposition({ permissionDeadlineMs: 50 }),
    );
    const marker = "TOOL_INPUT_MARKER";

    const hookRes = await hookRequest("t1", {
      tool_name: "bash",
      tool_input: { marker },
    });
    const hookText = await hookRes.text();
    expect(hookText).not.toContain("updatedInput");
    expect(hookText).not.toContain("bash");
    expect(hookText).not.toContain(marker);

    const verdictRes = await fetch(
      `${baseUrl}/v1/threads/t1/permissions/req-x/verdict`,
      {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      },
    );
    const verdictText = await verdictRes.text();
    expect(verdictText).not.toContain("updatedInput");
    expect(verdictText).not.toContain("bash");
    expect(verdictText).not.toContain(marker);
  });
});
