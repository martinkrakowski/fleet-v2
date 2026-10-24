import { afterEach, describe, expect, it, vi } from "vitest";

import { configureFleetApiRuntime } from "../server/wiring/runtime.js";
import runtimePlugin from "../server/plugins/runtime.js";

// The plugin default export, as Nitro runs it at startup: the listen-host guard
// must fire before the runtime bootstrap, so deleting it fails this file.
describe("runtime plugin listen-host guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    configureFleetApiRuntime(null);
  });

  function stubListenEnv(host: string): void {
    vi.stubEnv("NITRO_HOST", "");
    vi.stubEnv("HOST", host);
    vi.stubEnv("FLEET_API_ALLOW_REMOTE", "");
    vi.stubEnv("FLEET_STATE_DIR", "");
  }

  it("exits 1 with one stderr line on a non-loopback host", () => {
    stubListenEnv("0.0.0.0");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => (runtimePlugin as unknown as () => void)()).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("fleet-api: refusing to start:");
  });

  it("starts without exiting on a loopback host", () => {
    stubListenEnv("127.0.0.1");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);

    expect(() => (runtimePlugin as unknown as () => void)()).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
