/**
 * The e2e fixture's fake opencode server port. A runner forward dials the
 * server port plus one, so both ports must be free. An OS-assigned port
 * (listen on 0) comes from the kernel's ephemeral range, which outgoing
 * connections also take their source ports from: under load the port above it
 * can be held by an outgoing ssh or git connection, and the forward's bind
 * fails ("Address already in use") with nothing listening. Ports below the
 * ephemeral range (Linux 32768+, macOS 49152+) are never handed out as source
 * ports, so the fixture picks the pair there and checks both are free.
 */
import { createServer } from 'node:net';

export const PORT_PAIR_MIN = 20000;
/** Exclusive upper bound for the server port: the dial port stays below 32768. */
export const PORT_PAIR_MAX = 32767;
const ATTEMPTS = 64;

/** Whether a loopback TCP listener can bind the port right now. */
export function loopbackPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * A server port P in [PORT_PAIR_MIN, PORT_PAIR_MAX) such that P and P+1 are
 * both free on the loopback interface. Throws after ATTEMPTS candidates.
 */
export async function pickDialablePortPair(
  isFree: (port: number) => Promise<boolean> = loopbackPortIsFree,
  random: () => number = Math.random,
): Promise<number> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = PORT_PAIR_MIN + Math.floor(random() * (PORT_PAIR_MAX - PORT_PAIR_MIN));
    if ((await isFree(port)) && (await isFree(port + 1))) {
      return port;
    }
  }
  throw new Error(`no free port pair below ${PORT_PAIR_MAX + 1} after ${ATTEMPTS} attempts`);
}
