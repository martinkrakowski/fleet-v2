// GET /v1/changes: chunked JSON-lines change signals (plan §3.1). Bearer and
// Origin checks are the security middleware's; the read scope arrives with T3a.
import { defineEventHandler, getQuery, setResponseStatus } from "h3";
import { ChangeStream } from "../../wiring/changes/change-stream";
import { getChangeFeed, isFleetApiRuntimeConfigured } from "../../wiring/runtime";
import {
  envelope,
  newOperationId,
  NOT_IMPLEMENTED_CODE,
  NOT_IMPLEMENTED_STATUS,
} from "../../wiring/work/errors";

export default defineEventHandler((event): Promise<void> | ReturnType<typeof envelope> => {
  const feed = isFleetApiRuntimeConfigured() ? getChangeFeed() : null;
  if (feed === null) {
    setResponseStatus(event, NOT_IMPLEMENTED_STATUS);
    return envelope(newOperationId(), NOT_IMPLEMENTED_CODE);
  }
  const rawAfter = getQuery(event).after;
  const after = typeof rawAfter === "string" ? rawAfter : null;
  const res = event.node.res;
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.flushHeaders();
  const stream = new ChangeStream({
    feed,
    after,
    sink: {
      write: (chunk) => res.write(chunk),
      end: () => {
        res.end();
      },
    },
    isLive: () => getChangeFeed() === feed,
  });
  res.on("drain", () => stream.drain());
  return new Promise<void>((resolve) => {
    res.once("close", () => {
      stream.close();
      resolve();
    });
    stream.start();
  });
});
