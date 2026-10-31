import "./nitro-globals.js";

import {
  createServer,
  request,
  ServerResponse,
  type IncomingMessage,
  type Server,
} from "node:http";
import { Readable } from "node:stream";
import {
  createApp,
  createEvent,
  createRouter,
  defineEventHandler,
  toNodeListener,
  type EventHandler,
} from "h3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { routeParam } from "../http-input";
import { configureFleetApiRuntime } from "../runtime";

import attemptIdGet from "../../routes/v1/attempts/[id].get";
import attemptAcceptancePost from "../../routes/v1/attempts/[id]/acceptance.post";
import attemptArtifactsPost from "../../routes/v1/attempts/[id]/artifacts.post";
import attemptCancelPreparedPost from "../../routes/v1/attempts/[id]/cancel-prepared.post";
import attemptFixPost from "../../routes/v1/attempts/[id]/fix.post";
import attemptJournalGet from "../../routes/v1/attempts/[id]/journal.get";
import attemptNotesPost from "../../routes/v1/attempts/[id]/notes.post";
import attemptReconcilePost from "../../routes/v1/attempts/[id]/reconcile.post";
import attemptStopPost from "../../routes/v1/attempts/[id]/stop.post";
import workOrderIdGet from "../../routes/v1/work-orders/[id].get";
import headAssessmentPost from "../../routes/v1/heads/[sha]/assessment.post";
import headEvidenceGet from "../../routes/v1/heads/[sha]/evidence.get";
import findingDispositionPost from "../../routes/v1/findings/[id]/disposition.post";
import reviewReceiptPost from "../../routes/v1/reviews/[id]/receipt.post";
import verificationReceiptPost from "../../routes/v1/verifications/[id]/receipt.post";

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

describe("routeParam", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const router = createRouter();
    router.get(
      "/echo/:id",
      defineEventHandler((event) => ({ id: routeParam(event, "id") })),
    );
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

  const decodedCases: ReadonlyArray<readonly [string, string]> = [
    ["/echo/team%2Falpha", "team/alpha"],
    ["/echo/a%20b", "a b"],
    ["/echo/100%25", "100%"],
    ["/echo/%2541", "%41"],
    ["/echo/%252F", "%2F"],
    ["/echo/caf%C3%A9", "café"],
    ["/echo/example-id_1.2", "example-id_1.2"],
  ];

  const rejectedPaths = [
    "/echo/%E0%A4%A",
    "/echo/bad%",
    "/echo/%00x",
    "/echo/a%0Ab",
    "/echo/%7F",
    "/echo/%2E%2E",
    "/echo/..",
    "/echo/.",
  ];

  it.each(decodedCases)("decodes %s to %s", async (path, expected) => {
    const { status, text } = await rawRequest(port, "GET", path);
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ id: expected });
  });

  it.each(rejectedPaths)("refuses %s with the fixed 400", async (path) => {
    const { status, text } = await rawRequest(port, "GET", path);
    expect(status).toBe(400);
    expect(JSON.parse(text)).toEqual(FIXED_INVALID_ROUTE_PARAM_BODY);
    expect(text).not.toContain("E0%A4");
    expect(text).not.toContain("bad");
    expect(text).not.toContain("%00");
  });

  it("throws the fixed 400 when the parameter is absent from context.params", () => {
    const req = Object.assign(new Readable(), {
      method: "GET",
      url: "/echo/id",
      headers: {},
    }) as IncomingMessage;
    const res = new ServerResponse(req);
    const event = createEvent(req, res);
    expect(() => routeParam(event, "id")).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("routeParam on the work and evidence routes", () => {
  let server: Server;
  let port: number;

  const routes: ReadonlyArray<readonly [string, string, EventHandler]> = [
    ["attempts/:id", "/v1/attempts/:id", attemptIdGet],
    ["attempts/:id/acceptance", "/v1/attempts/:id/acceptance", attemptAcceptancePost],
    ["attempts/:id/artifacts", "/v1/attempts/:id/artifacts", attemptArtifactsPost],
    ["attempts/:id/cancel-prepared", "/v1/attempts/:id/cancel-prepared", attemptCancelPreparedPost],
    ["attempts/:id/fix", "/v1/attempts/:id/fix", attemptFixPost],
    ["attempts/:id/journal", "/v1/attempts/:id/journal", attemptJournalGet],
    ["attempts/:id/notes", "/v1/attempts/:id/notes", attemptNotesPost],
    ["attempts/:id/reconcile", "/v1/attempts/:id/reconcile", attemptReconcilePost],
    ["attempts/:id/stop", "/v1/attempts/:id/stop", attemptStopPost],
    ["work-orders/:id", "/v1/work-orders/:id", workOrderIdGet],
    ["heads/:sha/assessment", "/v1/heads/:sha/assessment", headAssessmentPost],
    ["heads/:sha/evidence", "/v1/heads/:sha/evidence", headEvidenceGet],
    ["findings/:id/disposition", "/v1/findings/:id/disposition", findingDispositionPost],
    ["reviews/:id/receipt", "/v1/reviews/:id/receipt", reviewReceiptPost],
    ["verifications/:id/receipt", "/v1/verifications/:id/receipt", verificationReceiptPost],
  ];

  beforeAll(async () => {
    configureFleetApiRuntime(null);
    const router = createRouter();
    for (const [, path, handler] of routes) {
      router.add(path, handler, "post");
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

  function postJson(path: string): Promise<{ status: number; text: string }> {
    return rawRequest(port, "POST", path, { "content-type": "application/json" }, "{}");
  }

  it.each(routes)("refuses a malformed param on %s with the fixed 400", async (_name, path) => {
    const target = path.replace(":id", "%E0%A4%A").replace(":sha", "%E0%A4%A");
    const { status, text } = await postJson(target);
    expect(status).toBe(400);
    expect(JSON.parse(text)).toEqual(FIXED_INVALID_ROUTE_PARAM_BODY);
  });

  it.each(routes)("reaches the use case for an encoded valid id on %s", async (_name, path) => {
    const target = path.replace(":id", "example%2Fid").replace(":sha", "example%2Fid");
    const { status } = await postJson(target);
    expect(status).not.toBe(400);
  });
});
