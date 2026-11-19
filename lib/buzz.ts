import { z } from "zod";
import { decode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import type { Agent } from "./config.ts";
import { deliverySchema, stableId, type Action, type Delivery } from "./protocol.ts";
import type { Target } from "./state.ts";

const keyHex = /^[a-f0-9]{64}$/;
const evt = z.object({
  id: z.string().regex(keyHex), pubkey: z.string().regex(keyHex), sig: z.string().regex(/^[a-f0-9]{128}$/),
  kind: z.number().int(), created_at: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string())).max(600), content: z.string().max(64000),
});
const attestation = z.tuple([z.literal("auth"), z.string().regex(keyHex), z.string().max(2048), z.string().regex(/^[a-f0-9]{128}$/)]);

export function loadSigner(agent: Agent) {
  let secret: Uint8Array;
  try {
    const raw = process.env[agent.signingKeyEnv]?.trim();
    if (!raw) throw new Error();
    if (keyHex.test(raw)) secret = Buffer.from(raw, "hex");
    else {
      const decoded = decode(raw as `nsec1${string}`);
      if (decoded.type !== "nsec") throw new Error();
      secret = decoded.data;
    }
    if (getPublicKey(secret) !== agent.pubkey) throw new Error();
  } catch {
    throw new Error("The registration signing key is missing, invalid, or does not match its public key");
  }
  let ownerTag: string[] | undefined;
  if (agent.ownerAttestationEnv) {
    try {
      ownerTag = attestation.parse(JSON.parse(process.env[agent.ownerAttestationEnv] ?? "null"));
    } catch {
      throw new Error("The registration owner attestation is missing or invalid");
    }
  }
  return {
    sign: (template: EventTemplate) => finalizeEvent(template, secret),
    ownerTag,
  };
}

export function verifiedEvent(input: unknown): Event | undefined {
  const parsed = evt.safeParse(input);
  if (!parsed.success) return;
  const event = parsed.data;
  if (verifyEvent(event)) return event;
}

export function inboundMessage(agent: Agent, event: Event): {
  delivery: Delivery; target: Target; addressed: boolean;
} | undefined {
  if (event.kind !== 9 || event.pubkey === agent.pubkey || event.created_at > Math.floor(Date.now() / 1000) + 90) return;
  const rooms = event.tags.filter(tag => tag[0] === "h");
  if (rooms.length !== 1 || !rooms[0][1]) return;
  const channelId = rooms[0][1];
  const dm = agent.directMessages.find(room => room.channelId === channelId);
  if (dm ? !dm.authors.includes(event.pubkey) : !agent.channels.includes(channelId)) return;
  const ancestry = event.tags.filter(tag => tag[0] === "e" && (tag[3] === "root" || tag[3] === "reply"));
  const root = ancestry.find(tag => tag[3] === "root")?.[1] ?? ancestry.find(tag => tag[3] === "reply")?.[1];
  if (root !== undefined && !keyHex.test(root)) return;
  const rootId = root ?? (dm ? null : event.id);
  // Trim the message while leaving user content and platform context as separate fields.
  const text = event.content.trim();
  const parsed = deliverySchema.safeParse({
    version: 1, registrationId: agent.id, namespace: agent.namespace, eventId: event.id,
    conversationId: stableId(agent.namespace, channelId, dm ? "direct" : rootId ?? event.id),
    author: event.pubkey, direct: Boolean(dm), text,
  });
  if (!parsed.success) return;
  return {
    delivery: parsed.data,
    target: { channelId, rootId, author: event.pubkey, sourceEventId: event.id },
    addressed: Boolean(dm) || event.tags.some(tag => tag[0] === "p" && tag[1] === agent.pubkey),
  };
}

export function actionEvent(action: Action, target: Target, queuedAt: number): EventTemplate {
  const created_at = Math.floor(queuedAt / 1000);
  const tags = [["h", target.channelId]];
  if (action.kind === "reaction") {
    return {
      kind: 7, created_at, content: action.emoji,
      tags: [["e", target.sourceEventId], ["p", target.author], ["k", "9"]],
    };
  }
  if (target.rootId) tags.push(["e", target.rootId, "", "reply"]);
  if (action.kind === "typing") return { kind: 20002, created_at, tags, content: "" };
  tags.push(["p", target.author]);
  return { kind: 9, created_at, tags, content: action.text };
}
