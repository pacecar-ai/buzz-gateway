import { fromProject, matchesActionKey } from "./auth.ts";
import type { Agent } from "./config.ts";
import { errorName, log } from "./log.ts";
import { actionId, actionSchema, deliveryPath, readJson } from "./protocol.ts";
import type { Outbox } from "./queue.ts";
import type { DeliveryRecord, State } from "./state.ts";

export async function acceptAction(
  request: Request,
  agents: Map<string, Agent>,
  state: State,
  outbox: Outbox,
  authorize = fromProject,
  actionKeyDigest = process.env.BUZZ_GATEWAY_ACTION_KEY_SHA256,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  if (!request.headers.has("authorization")) return new Response(null, { status: 401 });
  let body: unknown;
  try { body = await readJson(request); } catch { return new Response(null, { status: 400 }); }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  const action = parsed.data;
  const agent = agents.get(action.registrationId);
  if (!agent || action.namespace !== agent.namespace || !matchesActionKey(request, actionKeyDigest)
      || !await authorize(request, agent.eveProject)) {
    log("debug", "action_unauthorized");
    return new Response(null, { status: 403 });
  }
  const id = actionId(action);
  try {
    const record = await state.read<DeliveryRecord>(deliveryPath(action));
    if (!record || record.value.delivery.registrationId !== agent.id) return new Response(null, { status: 404 });
    await outbox.sendAction({ action, queuedAt: Date.now() });
    log("info", "action_queued", { actionId: id, registrationId: agent.id, eventId: action.eventId, kind: action.kind });
    return Response.json({ accepted: true, actionId: id }, { status: 202 });
  } catch (error) {
    log("warn", "action_enqueue_failed", { actionId: id, registrationId: agent.id, error: errorName(error) });
    return new Response(null, { status: 503 });
  }
}
