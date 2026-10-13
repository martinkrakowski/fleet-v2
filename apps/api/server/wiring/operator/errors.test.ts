import { describe, expect, it } from "vitest";
import { errorEnvelope, newOperationId, successEnvelope } from "./errors.js";

describe("errorEnvelope", () => {
  const operationId = newOperationId();

  it("maps an Error whose message starts with 'Not implemented:' to 501 NOT_IMPLEMENTED", () => {
    const failure = errorEnvelope(operationId, new Error("Not implemented: RequestScopedDecisionUseCase"));
    expect(failure.statusCode).toBe(501);
    expect(failure.body).toEqual({ operationId, code: "NOT_IMPLEMENTED", result: null });
  });

  it("maps a generated error with a longer operation id to 501 NOT_IMPLEMENTED", () => {
    const failure = errorEnvelope(operationId, new Error("Not implemented: RegisterProjectProfileUseCase"));
    expect(failure.statusCode).toBe(501);
    expect(failure.body.code).toBe("NOT_IMPLEMENTED");
  });

  it("does not return 501 when the message merely contains the phrase", () => {
    const failure = errorEnvelope(operationId, new Error("Operation failed: Not implemented: downstream"));
    expect(failure.statusCode).toBe(500);
    expect(failure.body.code).toBe("INTERNAL_ERROR");
  });

  it("does not return 501 for an unrelated Error", () => {
    const failure = errorEnvelope(operationId, new Error("disk on fire"));
    expect(failure.statusCode).toBe(500);
    expect(failure.body).toEqual({ operationId, code: "INTERNAL_ERROR", result: null });
  });

  it("does not return 501 for a non-Error throw", () => {
    const failure = errorEnvelope(operationId, "Not implemented: RequestScopedDecisionUseCase");
    expect(failure.statusCode).toBe(500);
    expect(failure.body.code).toBe("INTERNAL_ERROR");
  });
});

describe("successEnvelope", () => {
  it("wraps a result with the OK code", () => {
    expect(successEnvelope("op", { ready: true })).toEqual({
      operationId: "op",
      code: "OK",
      result: { ready: true },
    });
  });
});
