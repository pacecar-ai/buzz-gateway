import { errorName, log } from "../lib/log.ts";
import { healthPath } from "../lib/protocol.ts";
import { BlobState } from "../lib/state.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    const headers = { "cache-control": "no-store" };
    try {
      const heartbeat = await new BlobState().read<{ at: number; configured: number; connected: number; waiting?: number }>(healthPath);
      const value = heartbeat?.value;
      const ready = Boolean(value && Date.now() - value.at < 180_000);
      const relay = !ready ? "unknown" : !value?.configured ? "unconfigured"
        : value.connected === value.configured ? "connected"
        : value.connected + (value.waiting ?? 0) === value.configured ? "awaiting-approval" : "degraded";
      return Response.json({ service: "buzz-gateway", ready, relay }, { status: ready ? 200 : 503, headers });
    } catch (error) {
      log("warn", "health_storage_unavailable", { error: errorName(error) });
      return Response.json({ service: "buzz-gateway", ready: false, relay: "unknown" }, { status: 503, headers });
    }
  },
};
