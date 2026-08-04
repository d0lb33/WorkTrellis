import readline from "node:readline";

import { info, warn } from "../util/log";
import type { Supervisor } from "./supervisor";

/**
 * Ctrl+C handling, which differs meaningfully by platform.
 *
 * Windows payloads run without a console in a Job Object, so the interrupt is
 * handled by WorkTrellis alone. Programmatic shutdown still stops owned child
 * trees first so foreground wrappers can observe application exit and perform
 * cleanup before force escalation terminates the Job.
 */
export function installSignalHandlers(
  supervisor: Supervisor,
  onShutdown?: () => Promise<void>,
): () => void {
  let interrupts = 0;
  let lastInterruptAt = 0;

  const handle = (signal: string) => {
    const now = Date.now();
    interrupts = now - lastInterruptAt < 2_000 ? interrupts + 1 : 1;
    lastInterruptAt = now;

    if (interrupts > 1) {
      warn("Forcing shutdown.");
      supervisor.killAllSync();
      process.exit(130);
    }

    info("");
    info(`Stopping (${signal}). Press Ctrl+C again to force.`);

    void (async () => {
      await supervisor.shutdown(0);
      await onShutdown?.();
    })();
  };

  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  const onSigbreak = () => handle("SIGBREAK");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  // Windows-only: Ctrl+Break.
  process.on("SIGBREAK", onSigbreak);

  // When stdin is a raw TTY, Node does not synthesize SIGINT on its own.
  let rl: readline.Interface | null = null;
  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("SIGINT", onSigint);
  }

  // If the process is torn down some other way, make a synchronous best effort
  // to take the children with it. Async work is not possible in an exit handler.
  const onExit = () => supervisor.killAllSync();
  process.on("exit", onExit);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGBREAK", onSigbreak);
    process.off("exit", onExit);
    rl?.close();
  };
}
