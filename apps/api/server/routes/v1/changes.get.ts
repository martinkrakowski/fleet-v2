// GET /v1/changes: chunked JSON-lines change signals (plan §3.1). Bearer and
// Origin checks are the security middleware's; the read scope arrives with T3a.
import { defineEventHandler, getQuery, setResponseStatus } from "h3";
import {
  ChangeStream,
  changeStreamMaxOpen,
  openChangeStreamCount,
} from "../../wiring/changes/change-stream";
import { getChangeFeed, isFleetApiRuntimeConfigured } from "../../wiring/runtime";
import {
  envelope,
  newOperationId,
  NOT_IMPLEMENTED_CODE,
  NOT_IMPLEMENTED_STATUS,
  TOO_MANY_STREAMS_CODE,
  TOO_MANY_STREAMS_STATUS,
} from "../../wiring/work/errors";

export default defineEventHandler(
  (event): Promise<void> | ReturnType<typeof envelope> | undefined => {
    const feed = isFleetApiRuntimeConfigured() ? getChangeFeed() : null;
    if (feed === null) {
      setResponseStatus(event, NOT_IMPLEMENTED_STATUS);
      return envelope(newOperationId(), NOT_IMPLEMENTED_CODE);
    }
    if (openChangeStreamCount() >= changeStreamMaxOpen()) {
      setResponseStatus(event, TOO_MANY_STREAMS_STATUS);
      return envelope(newOperationId(), TOO_MANY_STREAMS_CODE);
    }
    const res = event.node.res;
    if (res.destroyed || event.node.req.destroyed) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    const rawAfter = getQuery(event).after;
    const after = typeof rawAfter === "string" ? rawAfter : null;
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
  },
);
