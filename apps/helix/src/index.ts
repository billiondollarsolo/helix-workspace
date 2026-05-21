import { createHelixServer } from "./server.js";
import { initTelemetry } from "./telemetry.js";

initTelemetry();

const server = await createHelixServer();
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

/**
 * P0-2: graceful shutdown.
 *
 * `server.close()` runs Fastify's `onClose` hooks, which drain in-flight
 * requests, stop every singleton worker (releasing its leader lease so a
 * surviving replica can take over), and close the event bus / DB pools.
 * Without an explicit signal handler the process is killed mid-flight on a
 * `kubectl rollout` / `docker stop`, losing in-flight work.
 *
 * The k8s deployment sets `terminationGracePeriodSeconds: 60` and a `preStop`
 * sleep; `SHUTDOWN_TIMEOUT_MS` (default 50s, comfortably inside the grace
 * period) bounds the drain so a stuck worker cannot block termination forever.
 */
const shutdownTimeoutMs = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "50000", 10);
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    server.log.warn({ signal }, "Shutdown already in progress; ignoring repeated signal");
    return;
  }
  shuttingDown = true;
  server.log.info({ signal }, "Received shutdown signal; draining Helix platform app");

  const forceExit = setTimeout(() => {
    server.log.error(
      { timeoutMs: shutdownTimeoutMs },
      "Graceful shutdown timed out; forcing exit",
    );
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref();

  try {
    await server.close();
    server.log.info("Helix platform app shut down cleanly");
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    server.log.error({ error }, "Error during graceful shutdown");
    clearTimeout(forceExit);
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  await server.listen({ host, port });
  server.log.info({ host, port }, "Helix platform app listening");
} catch (error) {
  server.log.error({ error }, "Failed to start Helix platform app");
  process.exitCode = 1;
}
