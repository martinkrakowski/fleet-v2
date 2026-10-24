// Listen-host guard for the Nitro server. Nitro's node-server binds every
// network interface when neither `NITRO_HOST` nor `HOST` is set, so the API
// must refuse to start unless the listen host is loopback or the operator
// explicitly opts in to remote listening with `FLEET_API_ALLOW_REMOTE=1`.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Decide whether the API must refuse to start based on its configured listen
 * host. Returns `null` when startup is allowed, otherwise a one-line reason
 * that names the offending host (or "unset") and never any other env value.
 */
export function listenHostRefusal(
  env: Record<string, string | undefined>,
): string | null {
  const nitroHost = env.NITRO_HOST?.trim();
  const host =
    nitroHost !== undefined && nitroHost.length > 0
      ? nitroHost
      : env.HOST?.trim() || undefined;

  if (env.FLEET_API_ALLOW_REMOTE === "1") {
    return null;
  }

  if (host !== undefined && LOOPBACK_HOSTS.has(host.toLowerCase())) {
    return null;
  }

  const namedHost = host !== undefined ? `\`${host}\`` : "unset";
  return `listen host is ${namedHost}; set HOST=127.0.0.1 or FLEET_API_ALLOW_REMOTE=1`;
}
