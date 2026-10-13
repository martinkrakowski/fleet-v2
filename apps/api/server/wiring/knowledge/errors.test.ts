import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("h3", () => ({
  getRequestHeader: vi.fn(),
  setResponseStatus: vi.fn(),
}));

import { getRequestHeader, setResponseStatus, type H3Event } from "h3";
import { isNotImplementedError, knowledgeResponse, mapUseCaseFailure } from "./errors.js";

describe("isNotImplementedError", () => {
  it("returns true only for an Error whose message starts with 'Not implemented'", () => {
    expect(isNotImplementedError(new Error("Not implemented: ProposeBriefContextUseCase"))).toBe(
      true,
    );
    expect(isNotImplementedError(new Error("Not quite implemented"))).toBe(false);
    expect(isNotImplementedError("Not implemented: not an Error")).toBe(false);
    expect(isNotImplementedError(undefined)).toBe(false);
  });
});

describe("mapUseCaseFailure", () => {
  it("returns 501 and NOT_IMPLEMENTED for an Error whose message starts with 'Not implemented'", () => {
    const failure = mapUseCaseFailure(
      new Error("Not implemented: ProposeBriefContextUseCase"),
      "op-1",
    );
    expect(failure.status).toBe(501);
    expect(failure.body).toEqual({ operationId: "op-1", code: "NOT_IMPLEMENTED", result: null });
  });

  it("does not return 501 or NOT_IMPLEMENTED for any other Error", () => {
    const failure = mapUseCaseFailure(new Error("Unexpected failure"), "op-2");
    expect(failure.status).not.toBe(501);
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({ operationId: "op-2", code: "INTERNAL_ERROR", result: null });
  });

  it("does not return 501 when 'not implemented' appears but does not start the message", () => {
    const failure = mapUseCaseFailure(new Error("This is not implemented either"), "op-3");
    expect(failure.status).not.toBe(501);
    expect(failure.body.code).not.toBe("NOT_IMPLEMENTED");
  });
});

describe("knowledgeResponse", () => {
  beforeEach(() => {
    vi.mocked(getRequestHeader).mockReset();
    vi.mocked(setResponseStatus).mockReset();
  });

  it("uses the Idempotency-Key header as the operation id when present", async () => {
    vi.mocked(getRequestHeader).mockReturnValue("client-key-1");
    const useCase = {
      execute: () => Promise.reject(new Error("Not implemented: ProposeBriefContextUseCase")),
    };
    const envelope = await knowledgeResponse({} as H3Event, useCase, undefined);
    expect(envelope).toEqual({
      operationId: "client-key-1",
      code: "NOT_IMPLEMENTED",
      result: null,
    });
    expect(setResponseStatus).toHaveBeenCalledWith(expect.anything(), 501);
  });

  it("mints one id per request when the header is absent", async () => {
    const useCase = () => ({ execute: () => Promise.reject(new Error("Unexpected failure")) });
    const first = await knowledgeResponse({} as H3Event, useCase(), undefined);
    const second = await knowledgeResponse({} as H3Event, useCase(), undefined);
    expect(first.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(second.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.code).toBe("INTERNAL_ERROR");
    expect(setResponseStatus).toHaveBeenCalledWith(expect.anything(), 500);
  });

  it("returns the same envelope shape on the success path", async () => {
    const useCase = { execute: () => Promise.resolve({ chosen: 1 }) };
    const envelope = await knowledgeResponse({} as H3Event, useCase, undefined);
    expect(envelope.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(envelope.code).toBe("OK");
    expect(envelope.result).toEqual({ chosen: 1 });
  });
});
