import "./nitro-globals.js";

import { createServer, request, type Server } from "node:http";
import { createApp, createRouter, toNodeListener, type EventHandler } from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureFleetApiRuntime } from "../runtime";

import consumePost from "../../routes/v1/authorizations/[id]/consume.post";
import knowledgeDispositionPost from "../../routes/v1/knowledge/[id]/disposition.post";
import knowledgePublishPost from "../../routes/v1/knowledge/[id]/publish.post";
import knowledgeReusePost from "../../routes/v1/knowledge/[id]/reuse.post";
import knowledgeSupersedePost from "../../routes/v1/knowledge/[id]/supersede.post";
import projectGet from "../../routes/v1/projects/[id].get";
import projectPatch from "../../routes/v1/projects/[id].patch";
import projectProbePost from "../../routes/v1/projects/[id]/probe.post";
import projectRetirePost from "../../routes/v1/projects/[id]/retire.post";
import questionGet from "../../routes/v1/questions/[id].get";
import questionAcknowledgementPost from "../../routes/v1/questions/[id]/acknowledgement.post";
import questionAnswersPost from "../../routes/v1/questions/[id]/answers.post";
import relayAcknowledgementPost from "../../routes/v1/relays/[id]/acknowledgement.post";
import orchestratorHeartbeatPost from "../../routes/v1/orchestrators/[id]/heartbeat.post";
import orchestratorRetirePost from "../../routes/v1/orchestrators/[id]/retire.post";

const FIXED_INVALID_ROUTE_PARAM_BODY = {
  statusCode: 400,
  statusMessage: "Invalid route parameter",
  stack: [],
};

/** One raw HTTP request over loopback: the exact path goes on the wire. */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("routeParam on the operator and knowledge routes", () => {
  let server: Server;
  let port: number;

  const routes: ReadonlyArray<readonly [string, string, string, EventHandler]> = [
    ["authorizations/:id/consume", "POST", "/v1/authorizations/:id/consume", consumePost],
    ["knowledge/:id/disposition", "POST", "/v1/knowledge/:id/disposition", knowledgeDispositionPost],
    ["knowledge/:id/publish", "POST", "/v1/knowledge/:id/publish", knowledgePublishPost],
    ["knowledge/:id/reuse", "POST", "/v1/knowledge/:id/reuse", knowledgeReusePost],
    ["knowledge/:id/supersede", "POST", "/v1/knowledge/:id/supersede", knowledgeSupersedePost],
    ["projects/:id", "GET", "/v1/projects/:id", projectGet],
    ["projects/:id", "PATCH", "/v1/projects/:id", projectPatch],
    ["projects/:id/probe", "POST", "/v1/projects/:id/probe", projectProbePost],
    ["projects/:id/retire", "POST", "/v1/projects/:id/retire", projectRetirePost],
    ["questions/:id", "GET", "/v1/questions/:id", questionGet],
    ["questions/:id/acknowledgement", "POST", "/v1/questions/:id/acknowledgement", questionAcknowledgementPost],
    ["questions/:id/answers", "POST", "/v1/questions/:id/answers", questionAnswersPost],
    ["relays/:id/acknowledgement", "POST", "/v1/relays/:id/acknowledgement", relayAcknowledgementPost],
    ["orchestrators/:id/heartbeat", "POST", "/v1/orchestrators/:id/heartbeat", orchestratorHeartbeatPost],
    ["orchestrators/:id/retire", "POST", "/v1/orchestrators/:id/retire", orchestratorRetirePost],
  ];

  beforeAll(async () => {
    configureFleetApiRuntime(null);
    const router = createRouter();
    for (const [, method, path, handler] of routes) {
      router.add(path, handler, method.toLowerCase() as "get" | "post" | "patch");
    }
    const app = createApp();
    app.use(router);
    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function call(method: string, path: string): Promise<{ status: number; text: string }> {
    if (method === "GET") {
      return rawRequest(port, "GET", path);
    }
    return rawRequest(port, method, path, { "content-type": "application/json" }, "{}");
  }

  it.each(routes)("refuses a malformed param on %s (%s) with the fixed 400", async (_name, method, path) => {
    const target = path.replace(":id", "%E0%A4%A");
    const { status, text } = await call(method, target);
    expect(status).toBe(400);
    expect(JSON.parse(text)).toEqual(FIXED_INVALID_ROUTE_PARAM_BODY);
  });

  it.each(routes)("reaches the route for an encoded valid id on %s (%s)", async (_name, method, path) => {
    const target = path.replace(":id", "example%2Fid");
    const { status } = await call(method, target);
    expect(status).not.toBe(400);
  });

  // Decoded exactly once: "%25E0%25A4%25A" becomes the plain string "%E0%A4%A". A second decode would
  // turn it into a malformed sequence and answer the fixed 400, so "not 400" proves a single decode.
  it.each(routes)("decodes a double-encoded param exactly once on %s (%s)", async (_name, method, path) => {
    const target = path.replace(":id", "%25E0%25A4%25A");
    const { status } = await call(method, target);
    expect(status).not.toBe(400);
  });
});
