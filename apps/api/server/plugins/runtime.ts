// Nitro startup plugin: configure the Fleet API runtime from the shared
// `FLEET_STATE_DIR` environment variable at server startup. When the variable
// is unset or blank the plugin is a no-op and every use case keeps refusing
// with `Not implemented` (HTTP 501), so an unconfigured deployment never
// exposes live dispatch or forge behaviour.
import { loadInstallation } from "@fleet/installation";

import { configureFleetApiRuntime } from "../wiring/runtime";

export function bootstrapFleetApiFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const stateDir = env.FLEET_STATE_DIR?.trim();
  if (!stateDir) {
    return false;
  }
  const loadResult = loadInstallation({ env: env as Record<string, string | undefined> });
  if (loadResult.status === "invalid") {
    return false;
  }
  const ownerPublicKey = env.FLEET_OWNER_PUBLIC_KEY?.trim() || undefined;
  configureFleetApiRuntime({
    stateDir,
    ownerPublicKey,
    installation: loadResult.installation,
  });
  return true;
}

const definePlugin =
  typeof defineNitroPlugin === "function"
    ? defineNitroPlugin
    : <T>(plugin: T) => plugin;

export default definePlugin(() => {
  bootstrapFleetApiFromEnv(process.env);
});
