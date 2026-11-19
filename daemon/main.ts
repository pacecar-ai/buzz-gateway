import { loadAgents } from "../lib/config.ts";
import { errorName, log } from "../lib/log.ts";
import { GatewayQueue } from "../lib/queue.ts";
import { BlobState } from "../lib/state.ts";
import { GatewayWorker } from "../lib/worker.ts";

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => controller.abort());

try {
  await new GatewayWorker(loadAgents(), new BlobState(), new GatewayQueue()).run(controller.signal);
} catch (error) {
  log("error", "gateway_daemon_failed", { error: errorName(error) });
  process.exitCode = 1;
}
