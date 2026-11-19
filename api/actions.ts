import { acceptAction } from "../lib/actions.ts";
import { loadAgents } from "../lib/config.ts";
import { errorName, log } from "../lib/log.ts";
import { GatewayQueue } from "../lib/queue.ts";
import { BlobState } from "../lib/state.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await acceptAction(request, loadAgents(), new BlobState(), new GatewayQueue());
    } catch (error) {
      log("error", "gateway_configuration_error", { error: errorName(error) });
      return new Response(null, { status: 503 });
    }
  },
};
