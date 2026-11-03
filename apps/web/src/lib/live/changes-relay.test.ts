import { describe, expect, it } from "vitest";

import {
  createChangeRelay,
  parseChangeSignal,
  toServerSentEvent,
} from "./changes-relay";

const TOKEN = "test-token-value-not-a-real-bearer";
const SIGNAL_LINE =
  '{"stream":"s_1","seq":12,"kind":"attempt","id":"att_1","at":"2026-11-03T00:00:00Z"}';

function signalBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(
  status: number,
  body: ReadableStream<Uint8Array> | null,
  calls: FetchCall[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (body === null) {
      return new Response(null, { status });
    }
    return new Response(body, { status });
  }) as typeof fetch;
}

async function readFrames(
  body: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const text = await new Response(body).text();
  return text.split("\n\n").filter((frame) => frame.length > 0);
}

describe("parseChangeSignal", () => {
  it("drops the upstream stream id and at timestamp", () => {
    expect(parseChangeSignal(SIGNAL_LINE)).toEqual({
      seq: 12,
      kind: "attempt",
      id: "att_1",
    });
  });

  it("returns null for the keep-alive blank line, garbage, and lines without a numeric seq", () => {
    expect(parseChangeSignal("")).toBeNull();
    expect(parseChangeSignal("not json")).toBeNull();
    expect(parseChangeSignal('{"seq":"12","kind":"attempt"}')).toBeNull();
    expect(parseChangeSignal('{"kind":"attempt"}')).toBeNull();
  });
});

describe("toServerSentEvent", () => {
  it("writes one event: change frame carrying only {seq, kind, id}", () => {
    const frame = toServerSentEvent({ seq: 12, kind: "attempt", id: "att_1" });
    expect(frame).toBe(
      'event: change\ndata: {"seq":12,"kind":"attempt","id":"att_1"}\n\n',
    );
    expect(frame).not.toContain('"stream"');
    expect(frame).not.toContain('"at"');
    expect(frame).not.toContain(TOKEN);
  });
});

describe("createChangeRelay", () => {
  it("streams one SSE frame per upstream signal line with the bearer header", async () => {
    const calls: FetchCall[] = [];
    const relay = await createChangeRelay({
      url: "http://127.0.0.1:3001",
      token: TOKEN,
      fetchImpl: fakeFetch(200, signalBody([SIGNAL_LINE, SIGNAL_LINE]), calls),
    });
    expect(relay.status).toBe("streaming");
    if (relay.status !== "streaming") {
      throw new Error("relay did not stream");
    }
    const frames = await readFrames(relay.body);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('data: {"seq":12,"kind":"attempt","id":"att_1"}');
    expect(frames[1]).toContain('data: {"seq":12,"kind":"attempt","id":"att_1"}');
    expect(calls[0]?.url.endsWith("/v1/changes")).toBe(true);
    expect((calls[0]?.init?.headers as Record<string, string>)?.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("answers unavailable with the status named for a non-200 answer", async () => {
    const calls: FetchCall[] = [];
    const relay = await createChangeRelay({
      url: "http://127.0.0.1:3001",
      token: TOKEN,
      fetchImpl: fakeFetch(501, null, calls),
    });
    expect(relay.status).toBe("unavailable");
    if (relay.status !== "unavailable") {
      throw new Error("relay unexpectedly streamed");
    }
    expect(relay.reason).toContain("501");
    expect("body" in relay).toBe(false);
  });

  it("answers unavailable with a host-free reason when the fetch throws", async () => {
    const relay = await createChangeRelay({
      url: "http://127.0.0.1:3001",
      token: TOKEN,
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as typeof fetch,
    });
    expect(relay.status).toBe("unavailable");
    if (relay.status !== "unavailable") {
      throw new Error("relay unexpectedly streamed");
    }
    expect(relay.reason).not.toContain("127.0.0.1");
    expect(relay.reason).not.toContain("3001");
    expect(relay.reason).not.toContain("http");
  });

  it("aborts the upstream fetch when the relay body is cancelled", async () => {
    const calls: FetchCall[] = [];
    const relay = await createChangeRelay({
      url: "http://127.0.0.1:3001",
      token: TOKEN,
      fetchImpl: fakeFetch(200, signalBody([SIGNAL_LINE]), calls),
    });
    if (relay.status !== "streaming") {
      throw new Error("relay did not stream");
    }
    const signal = calls[0]?.init?.signal;
    expect(signal?.aborted).toBe(false);
    await relay.body.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it("never relays the bearer token in a frame", async () => {
    const relay = await createChangeRelay({
      url: "http://127.0.0.1:3001",
      token: TOKEN,
      fetchImpl: fakeFetch(200, signalBody([SIGNAL_LINE]), []),
    });
    if (relay.status !== "streaming") {
      throw new Error("relay did not stream");
    }
    for (const frame of await readFrames(relay.body)) {
      expect(frame).not.toContain(TOKEN);
    }
  });
});
