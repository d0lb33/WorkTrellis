import net from "node:net";

import type { ServiceKind } from "../types";
import { canConnect } from "./ports";

/**
 * Readiness probes that run from *here*, not inside the container.
 *
 * This distinction matters whenever the container engine is remote: compose can
 * report a container healthy while the port is not reachable from the machine
 * running the app, because the publish happened on the engine's host. Only a
 * probe from this process proves the app will be able to connect.
 */

export interface ProbeResult {
  reachable: boolean;
  detail?: string;
}

async function probeRedis(port: number, host: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(3_000);

    const finish = (result: ProbeResult) => {
      socket.destroy();
      resolve(result);
    };

    socket.once("connect", () => socket.write("PING\r\n"));
    socket.once("data", (chunk: Buffer) => {
      const reply = chunk.toString();
      finish({
        reachable: reply.startsWith("+PONG"),
        detail: reply.startsWith("+PONG") ? undefined : `unexpected reply ${reply.trim()}`,
      });
    });
    socket.once("error", (caught) => finish({ reachable: false, detail: caught.message }));
    socket.once("timeout", () => finish({ reachable: false, detail: "timed out" }));
  });
}

async function probeSmtp(port: number, host: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(3_000);

    const finish = (result: ProbeResult) => {
      socket.destroy();
      resolve(result);
    };

    socket.once("data", (chunk: Buffer) => {
      const banner = chunk.toString().trim();
      finish({
        reachable: banner.startsWith("220"),
        detail: banner.startsWith("220") ? undefined : `unexpected banner ${banner}`,
      });
    });
    socket.once("error", (caught) => finish({ reachable: false, detail: caught.message }));
    socket.once("timeout", () => finish({ reachable: false, detail: "timed out" }));
  });
}

async function probeHttp(url: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
    });
    return {
      reachable: response.ok,
      detail: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (caught) {
    return { reachable: false, detail: (caught as Error).message };
  }
}

export async function probeService(
  kind: ServiceKind,
  ports: Record<string, number>,
  host = "127.0.0.1",
): Promise<ProbeResult> {
  switch (kind) {
    case "postgres": {
      // A TCP connect is as far as we go without a driver: Postgres will not
      // speak without a startup packet, and connecting proves reachability.
      const reachable = await canConnect(ports.main!, host, 3_000);
      return { reachable, detail: reachable ? undefined : "no TCP connection" };
    }
    case "redis":
      return probeRedis(ports.main!, host);
    case "minio":
      return probeHttp(`http://${host}:${ports.api}/minio/health/live`);
    case "mailpit":
      return probeSmtp(ports.smtp!, host);
    default:
      return { reachable: false, detail: "unknown service kind" };
  }
}

/** Poll a service until it answers, or give up. */
export async function waitForService(
  kind: ServiceKind,
  ports: Record<string, number>,
  { timeoutMs = 60_000, intervalMs = 500, host = "127.0.0.1" } = {},
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = { reachable: false, detail: "not probed" };

  while (Date.now() < deadline) {
    last = await probeService(kind, ports, host);
    if (last.reachable) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return last;
}
