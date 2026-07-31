import net from "node:net";
import dgram from "node:dgram";

/**
 * Port probing by binding a socket. This replaces shelling out to
 * ss / lsof / netstat, which needed three code paths and still had no answer on
 * a plain Windows shell.
 */

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function canBindUdp(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.unref();
    socket.once("error", () => {
      socket.close();
      resolve(false);
    });
    socket.bind({ port, address: host, exclusive: true }, () => {
      socket.close(() => resolve(true));
    });
  });
}

/**
 * A port counts as available only when it binds on both the wildcard and
 * loopback addresses: Windows and Linux disagree about which of the two reports
 * a conflict when the other is already bound.
 */
export async function isPortAvailable(
  port: number,
  protocol: "tcp" | "udp" = "tcp",
): Promise<boolean> {
  for (const host of ["0.0.0.0", "127.0.0.1"]) {
    const available =
      protocol === "udp"
        ? await canBindUdp(port, host)
        : await canBind(port, host);
    if (!available) return false;
  }
  return true;
}

export async function isPortInUse(
  port: number,
  protocol: "tcp" | "udp" = "tcp",
): Promise<boolean> {
  return !(await isPortAvailable(port, protocol));
}

export interface FindPortOptions {
  /** Ports already claimed during this run; mutated as ports are taken. */
  reserved?: Set<number>;
  span?: number;
}

/**
 * Find a usable port at or above `preferred`. The preferred value is
 * deterministic per worktree, so a workspace keeps its address across restarts
 * and only drifts when something else genuinely holds the port.
 */
export async function findAvailablePort(
  preferred: number,
  options: FindPortOptions = {},
): Promise<number> {
  const reserved = options.reserved ?? new Set<number>();
  const span = options.span ?? 100;

  for (let port = preferred; port < preferred + span; port += 1) {
    if (reserved.has(port)) continue;
    if (await isPortAvailable(port)) {
      reserved.add(port);
      return port;
    }
  }

  throw new Error(
    `No available port in range ${preferred}-${preferred + span - 1}.`,
  );
}

/** Wait until something accepts TCP connections on `port`. */
export async function waitForPort(
  port: number,
  {
    host = "127.0.0.1",
    timeoutMs = 30_000,
    intervalMs = 250,
  }: { host?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canConnect(port, host, Math.min(intervalMs * 4, 2_000))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

/** Wait until nothing accepts TCP connections on `port`. */
export async function waitForPortClose(
  port: number,
  {
    host = "127.0.0.1",
    timeoutMs = 2_000,
    intervalMs = 100,
  }: { host?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await canConnect(port, host, Math.min(intervalMs * 4, 500)))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return !(await canConnect(port, host, 250));
}

export function canConnect(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 2_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(timeoutMs);

    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
