import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFleetApiClient,
  normalizeBaseUrl,
  readApiTokenFromFile,
  type FetchLike,
} from "./client.js";

let dir: string;
const TOKEN = "tok".repeat(16) + "x"; // 49 chars, no whitespace

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-mcp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTokenFile(mode: number): string {
  const path = join(dir, "token");
  writeFileSync(path, `${TOKEN}\n`);
  chmodSync(path, mode);
  return path;
}

function client(options: {
  baseUrl?: string;
  tokenPath?: string;
  fetch?: FetchLike;
}) {
  return createFleetApiClient({
    baseUrl: options.baseUrl ?? "http://127.0.0.1:3001",
    readToken: () =>
      options.tokenPath === undefined
        ? null
        : readApiTokenFromFile(options.tokenPath),
    fetch: options.fetch,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OK_ENVELOPE = { operationId: "op-1", code: "OK", result: { value: 1 } };

describe("normalizeBaseUrl", () => {
  it("accepts loopback URLs with an explicit port", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:3001")).toBe(
      "http://127.0.0.1:3001",
    );
    expect(normalizeBaseUrl("http://localhost:8080/")).toBe(
      "http://localhost:8080",
    );
    expect(normalizeBaseUrl("http://[::1]:9")).toBe("http://[::1]:9");
  });

  it("refuses non-loopback hosts and missing ports", () => {
    expect(normalizeBaseUrl(undefined)).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("http://example.com:3001")).toBeNull();
    expect(normalizeBaseUrl("http://127.0.0.1")).toBeNull();
    expect(normalizeBaseUrl("https://127.0.0.1:3001")).toBeNull();
    expect(normalizeBaseUrl("http://0.0.0.0:3001")).toBeNull();
  });
});

describe("readApiTokenFromFile", () => {
  it("accepts a 0600 regular file and trims the first line", () => {
    expect(readApiTokenFromFile(writeTokenFile(0o600))).toBe(TOKEN);
  });

  it("refuses a file with group/other bits", () => {
    expect(readApiTokenFromFile(writeTokenFile(0o644))).toBeNull();
  });

  it("refuses a symlink", () => {
    const real = writeTokenFile(0o600);
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(readApiTokenFromFile(link)).toBeNull();
  });

  it("refuses a relative path and a missing file", () => {
    expect(readApiTokenFromFile("relative/token")).toBeNull();
    expect(readApiTokenFromFile(join(dir, "missing"))).toBeNull();
  });

  it("refuses a short token", () => {
    const path = join(dir, "short-token");
    writeFileSync(path, "abc\n");
    chmodSync(path, 0o600);
    expect(readApiTokenFromFile(path)).toBeNull();
  });
});

describe("createFleetApiClient", () => {
  it("answers not-configured when the base URL is missing", async () => {
    const api = client({ baseUrl: "" });
    expect(await api.get("/v1/coordination")).toEqual({
      ok: false,
      code: "not-configured",
      message: expect.any(String),
    });
  });

  it("answers not-configured when the token file is missing", async () => {
    const api = client({ tokenPath: undefined });
    expect(await api.get("/v1/coordination")).toEqual({
      ok: false,
      code: "not-configured",
      message: expect.any(String),
    });
  });

  it("sends Authorization and Accept, and never returns the token", async () => {
    let seenInit: RequestInit | undefined;
    const fetchLike: FetchLike = async (_url, init) => {
      seenInit = init;
      return jsonResponse(200, OK_ENVELOPE);
    };
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    const result = await api.get("/v1/coordination");
    expect(result).toEqual(OK_ENVELOPE);
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Accept).toBe("application/json");
    expect(headers.Origin).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("sends POST with Content-Type and a JSON body", async () => {
    let seenInit: RequestInit | undefined;
    let seenUrl: string | undefined;
    const fetchLike: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(200, OK_ENVELOPE);
    };
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    await api.post("/v1/knowledge/proposals", { note: "x" });
    expect(seenUrl).toBe("http://127.0.0.1:3001/v1/knowledge/proposals");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect((seenInit?.body as string)).toBe(JSON.stringify({ note: "x" }));
  });

  it("maps an error envelope without echoing the body", async () => {
    const fetchLike: FetchLike = async () =>
      jsonResponse(500, {
        operationId: "op-err",
        code: "INTERNAL_ERROR",
        result: null,
      });
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    const result = await api.get("/v1/coordination");
    expect(result).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      message: expect.any(String),
      operationId: "op-err",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a timeout as an error", async () => {
    const fetchLike: FetchLike = async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    expect(await api.get("/v1/coordination")).toMatchObject({
      ok: false,
      code: "timeout",
    });
  });

  it("refuses an oversize response body", async () => {
    const fetchLike: FetchLike = async () =>
      new Response("x".repeat(1024 * 1024 + 1), { status: 200 });
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    expect(await api.get("/v1/coordination")).toMatchObject({
      ok: false,
      code: "response-too-large",
    });
  });

  it("refuses an oversize declared content-length", async () => {
    const fetchLike: FetchLike = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(2 * 1024 * 1024) },
      });
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    expect(await api.get("/v1/coordination")).toMatchObject({
      ok: false,
      code: "response-too-large",
    });
  });

  it("reports transport failures without the URL or token", async () => {
    const fetchLike: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
    };
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    const result = await api.get("/v1/coordination");
    expect(result).toMatchObject({ ok: false, code: "transport-error" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  it("cancels an unbounded stream and reports response-too-large", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      // Keeps producing 1 KiB chunks forever; the client must cancel the
      // reader as soon as the accumulated total exceeds the cap.
      pull(controller) {
        controller.enqueue(new Uint8Array(1024).fill(120)); // "x"
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchLike: FetchLike = async () =>
      new Response(stream, { status: 200 });
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    expect(await api.get("/v1/coordination")).toMatchObject({
      ok: false,
      code: "response-too-large",
    });
    expect(cancelled).toBe(true);
  });

  it("refuses invalid paths without fetching", async () => {
    let calls = 0;
    const fetchLike: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, OK_ENVELOPE);
    };
    const api = client({ tokenPath: writeTokenFile(0o600), fetch: fetchLike });
    for (const path of [
      "@evil.com/v1",
      "//evil.com/v1/x",
      "/v1/../x",
      "/v1/x#y",
      "v1/x",
    ]) {
      expect(await api.get(path)).toMatchObject({
        ok: false,
        code: "invalid-path",
      });
      expect(await api.post(path, { a: 1 })).toMatchObject({
        ok: false,
        code: "invalid-path",
      });
    }
    expect(calls).toBe(0);
  });

  it("refuses base-URL bypass probes without fetching", async () => {
    let calls = 0;
    const fetchLike: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, OK_ENVELOPE);
    };
    for (const baseUrl of [
      "http://user@127.0.0.1:3001",
      "http://127.0.0.1:3001@evil.com",
      "http://localhost.evil.com:3001",
      "http://LOCALHOST:3001",
      "http://localhost.:3001",
      "http://[::ffff:127.0.0.1]:3001",
      "http://127.0.0.1:3001?x",
    ]) {
      const api = client({
        baseUrl,
        tokenPath: writeTokenFile(0o600),
        fetch: fetchLike,
      });
      expect(await api.get("/v1/coordination")).toMatchObject({
        ok: false,
        code: "not-configured",
      });
    }
    expect(calls).toBe(0);
  });
});
