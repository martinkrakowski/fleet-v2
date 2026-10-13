import { describe, expect, it } from "vitest";

import {
  NOT_IMPLEMENTED_CODE,
  NOT_IMPLEMENTED_STATUS,
  mapWorkError,
} from "./errors";

describe("mapWorkError", () => {
  it("returns 501 and NOT_IMPLEMENTED for a not-implemented error", () => {
    const error = new Error("Not implemented: RegisterWorkOrderUseCase");

    const mapping = mapWorkError(error);

    expect(mapping).not.toBeNull();
    expect(mapping?.status).toBe(NOT_IMPLEMENTED_STATUS);
    expect(mapping?.status).toBe(501);
    expect(mapping?.code).toBe(NOT_IMPLEMENTED_CODE);
    expect(mapping?.code).toBe("NOT_IMPLEMENTED");
  });

  it("does not return 501 for a different error", () => {
    const mapping = mapWorkError(new Error("Something else went wrong"));

    expect(mapping).toBeNull();
  });
});
