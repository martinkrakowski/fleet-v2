// Nitro startup plugin: configure the Fleet API runtime from the shared
// `FLEET_STATE_DIR` environment variable at server startup. When the variable
// is unset or blank the plugin is a no-op and every use case keeps refusing
// with `Not implemented` (HTTP 501), so an unconfigured deployment never
// exposes live dispatch or forge behaviour.
import { configureFleetApiRuntime } from "../wiring/runtime";

export function bootstrapFleetApiFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const stateDir = env.FLEET_STATE_DIR?.trim();
  const ownerPublicKey = env.FLEET_OWNER_PUBLIC_KEY?.trim() || undefined;
  if (stateDir) {
    configureFleetApiRuntime({ stateDir, ownerPublicKey });
    return true;
  }
  return false;
}

export default defineNitroPlugin(() => {
  bootstrapFleetApiFromEnv(process.env);
});
