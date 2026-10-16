#!/usr/bin/env node
// stdio MCP server entry point. stdout belongs to the protocol; this is the
// only file allowed to write to stderr (one line on a fatal error).
import { startServer } from "./server.js";

startServer().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- application boundary: one fatal-error line; the message may carry caller paths
  console.error(
    `fleet-v2-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
