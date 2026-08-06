import net from "node:net";

import type { PortProbe } from "../types";
import { hostForUrl } from "./engine-endpoint";
import { canConnect } from "./ports";

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
        detail: reply.startsWith("+PONG")
          ? undefined
          : `unexpected reply ${reply.trim()}`,
      });
    });
    socket.once("error", (caught) =>
      finish({ reachable: false, detail: caught.message }),
    );
    socket.once("timeout", () =>
      finish({ reachable: false, detail: "timed out" }),
    );
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
        detail: banner.startsWith("220")
          ? undefined
          : `unexpected banner ${banner}`,
      });
    });
    socket.once("error", (caught) =>
      finish({ reachable: false, detail: caught.message }),
    );
    socket.once("timeout", () =>
      finish({ reachable: false, detail: "timed out" }),
    );
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

export async function probePort(
  probe: PortProbe | undefined,
  port: number,
  host = "127.0.0.1",
): Promise<ProbeResult> {
  const selected = probe ?? { kind: "tcp" };
  switch (selected.kind) {
    case "none":
      return { reachable: true, detail: "probe disabled" };
    case "redis":
      return probeRedis(port, host);
    case "smtp":
      return probeSmtp(port, host);
    case "http":
      return probeHttp(
        `http://${hostForUrl(host)}:${port}${selected.path?.startsWith("/") ? selected.path : selected.path ? `/${selected.path}` : ""}`,
      );
    case "postgres":
    case "tcp": {
      const reachable = await canConnect(port, host, 3_000);
      return {
        reachable,
        detail: reachable ? undefined : "no TCP connection",
      };
    }
  }
}

export async function waitForPortProbe(
  probe: PortProbe | undefined,
  port: number,
  {
    timeoutMs = 60_000,
    intervalMs = 500,
    host = "127.0.0.1",
  }: { timeoutMs?: number; intervalMs?: number; host?: string } = {},
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = { reachable: false, detail: "not probed" };

  while (Date.now() < deadline) {
    last = await probePort(probe, port, host);
    if (last.reachable) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return last;
}
