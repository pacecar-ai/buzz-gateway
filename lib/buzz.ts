import { z } from "zod";
import { verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import type { Agent } from "./config.ts";
import type { BuzzRooms } from "./memberships.ts";
import { deliverySchema, stableId, type Action, type ActionJob, type Delivery } from "./protocol.ts";
import type { Target } from "./state.ts";

const keyHex = /^[a-f0-9]{64}$/;
const evt = z.object({
  id: z.string().regex(keyHex), pubkey: z.string().regex(keyHex), sig: z.string().regex(/^[a-f0-9]{128}$/),
  kind: z.number().int(), created_at: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string())).max(600), content: z.string().max(64000),
});

export function verifiedEvent(input: unknown): Event | undefined {
  const parsed = evt.safeParse(input);
  if (!parsed.success) return;
  const event = parsed.data;
  if (verifyEvent(event)) return event;
}

export function roomDirectness(agent: Agent, channelId: string, author: string, membership?: BuzzRooms): boolean | undefined {
  if (agent.roomAccess === "membership") {
    const room = membership?.get(channelId);
    return room?.members.has(author) ? room.direct : undefined;
  }
  const dm = agent.directMessages.find(room => room.channelId === channelId);
  if (dm?.authors.includes(author)) return true;
  if (agent.channels.includes(channelId)) return false;
}

export function inboundMessage(agent: Agent, event: Event, membership?: BuzzRooms): {
  delivery: Delivery; target: Target; addressed: boolean;
} | undefined {
  if (event.kind !== 9 || event.pubkey === agent.pubkey || event.created_at > Math.floor(Date.now() / 1000) + 90) return;
  const rooms = event.tags.filter(tag => tag[0] === "h");
  if (rooms.length !== 1 || !rooms[0][1]) return;
  const channelId = rooms[0][1];
  const direct = roomDirectness(agent, channelId, event.pubkey, membership);
  if (direct === undefined) return;
  const ancestry = event.tags.filter(tag => tag[0] === "e" && (tag[3] === "root" || tag[3] === "reply"));
  const root = ancestry.find(tag => tag[3] === "root")?.[1] ?? ancestry.find(tag => tag[3] === "reply")?.[1];
  if (root !== undefined && !keyHex.test(root)) return;
  const rootId = root ?? (direct ? null : event.id);
  // Trim the message while leaving user content and platform context as separate fields.
  const text = event.content.trim();
  const mentioned = event.tags.some(tag => tag[0] === "p" && tag[1] === agent.pubkey);
  const parsed = deliverySchema.safeParse({
    version: 1, registrationId: agent.id, namespace: agent.namespace, eventId: event.id,
    conversationId: stableId(agent.namespace, channelId, direct ? "direct" : rootId ?? event.id),
    author: event.pubkey, direct, mentioned, visibility: membership?.get(channelId)?.visibility, text,
  });
  if (!parsed.success) return;
  return {
    delivery: parsed.data,
    target: { channelId, rootId, author: event.pubkey, sourceEventId: event.id },
    addressed: direct || mentioned,
  };
}

export function actionEvent(action: Exclude<Action, { kind: "status" }>, target: Target, queuedAt: number, reactionAsset?: ActionJob["reactionAsset"]): EventTemplate {
  const created_at = Math.floor(queuedAt / 1000);
  const tags = [["h", target.channelId]];
  if (action.kind === "reaction") {
    if (reactionAsset && action.emoji === ":" + reactionAsset.name + ":") tags.push(["emoji", reactionAsset.name, reactionAsset.url]);
    return {
      kind: 7, created_at, content: action.emoji,
      tags: [...tags, ["e", target.sourceEventId], ["p", target.author], ["k", "9"]],
    };
  }
  if (action.kind === "typing") {
    if (target.rootId) tags.push(["e", target.rootId, "", "reply"]);
    return { kind: 20002, created_at, tags, content: "" };
  }
  if (target.rootId && target.sourceEventId !== target.rootId) tags.push(["e", target.rootId, "", "root"]);
  tags.push(["e", target.sourceEventId, "", "reply"], ["p", target.author], ["buzz:request", target.sourceEventId]);
  return { kind: 9, created_at, tags, content: action.text };
}
