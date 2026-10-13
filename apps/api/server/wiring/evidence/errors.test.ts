import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("h3", () => ({
  setResponseStatus: vi.fn(),
}));

import { setResponseStatus, type H3Event } from "h3";
import { evidenceResponse, isNotImplemented } from "./errors.js";

describe("isNotImplemented", () => {
  it("returns true when the message starts with 'Not implemented:'", () => {
    expect(isNotImplemented(new Error("Not implemented: RequestVerificationUseCase"))).toBe(
      true,
    );
  });

  it("returns false when the message does not start with 'Not implemented:'", () => {
    expect(isNotImplemented(new Error("Unexpected failure"))).toBe(false);
    expect(isNotImplemented(new Error("Not implemented"))).toBe(false);
    expect(isNotImplemented(new Error("Not implemented without colon"))).toBe(false);
  });
});

describe("evidenceResponse error mapper", () => {
  beforeEach(() => {
    vi.mocked(setResponseStatus).mockClear();
  });

  it("returns 501 and NOT_IMPLEMENTED only for an Error starting with 'Not implemented:'", async () => {
    const useCase = {
      execute: () => Promise.reject(new Error("Not implemented: RequestVerificationUseCase")),
    };
    const result = await evidenceResponse({} as H3Event, useCase, "TestOp");
    expect(result).toEqual({
      operationId: "TestOp",
      code: "NOT_IMPLEMENTED",
      result: null,
    });
    expect(setResponseStatus).toHaveBeenCalledWith(expect.any(Object), 501);
  });

  it("does not return 501/NOT_IMPLEMENTED for other errors", async () => {
    const useCase = {
      execute: () => Promise.reject(new Error("Unexpected failure")),
    };
    const result = await evidenceResponse({} as H3Event, useCase, "TestOp");
    expect(result).toEqual({
      operationId: "TestOp",
      code: "INTERNAL_ERROR",
      result: null,
    });
    expect(setResponseStatus).toHaveBeenCalledWith(expect.any(Object), 500);
  });
});
