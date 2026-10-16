// Nitro startup plugin: configure the Fleet API runtime from the shared
// `FLEET_STATE_DIR` and `FLEET_API_TOKEN_FILE` environment variables and the
// installation file. When `FLEET_STATE_DIR` is set, a valid
// `FLEET_API_TOKEN_FILE` and a valid installation are both required; without
// either the runtime is NOT configured and every route stays 501, so an
// unconfigured deployment never exposes live dispatch or forge behaviour.
import { loadInstallation } from "@fleet/installation";

import { configureFleetApiRuntime } from "../wiring/runtime";
import { readApiTokenFromFile, setActiveApiToken } from "../wiring/token";

function refuse(): false {
  setActiveApiToken(null);
  configureFleetApiRuntime(null);
  return false;
}

export function bootstrapFleetApiFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const stateDir = env.FLEET_STATE_DIR?.trim();
  if (!stateDir) {
    return refuse();
  }

  const tokenFile = env.FLEET_API_TOKEN_FILE?.trim();
  if (!tokenFile) {
    return refuse();
  }
  const token = readApiTokenFromFile(tokenFile);
  if (!token) {
    return refuse();
  }

  const loadResult = loadInstallation({ env: env as Record<string, string | undefined> });
  if (loadResult.status === "invalid") {
    return refuse();
  }

  const ownerPublicKey = env.FLEET_OWNER_PUBLIC_KEY?.trim() || undefined;
  setActiveApiToken(token);
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
