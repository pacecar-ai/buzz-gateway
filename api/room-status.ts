import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BuzzSocket } from "../lib/buzz-socket.ts";
import { inboundMessage } from "../lib/buzz.ts";
import { channelId, loadAgents } from "../lib/config.ts";
import { loadSigner } from "../lib/credentials.ts";
import { readRooms, relaySigningKey } from "../lib/memberships.ts";
import { errorName, log } from "../lib/log.ts";
import { deliveryPath, hexId, readJson, registrationId } from "../lib/protocol.ts";
import { BlobState, type DeliveryRecord } from "../lib/state.ts";

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const input = z.object({ id: registrationId });

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") return reply({ error: "Use POST." }, 405);
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const expected = process.env.BUZZ_GATEWAY_DESKTOP_OPERATOR_SHA256;
    if (!token || !hexId.safeParse(expected).success
      || !timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(expected!, "hex"))) {
      return reply({ error: "An operator is required." }, 403);
    }
    const parsed = input.safeParse(await readJson(request).catch(() => null));
    if (!parsed.success) return reply({ error: "Choose a registered agent." }, 400);
    const agent = loadAgents().get(parsed.data.id);
    if (!agent?.desktop || agent.roomAccess !== "membership") return reply({ error: "Unknown hosted agent." }, 404);
    const state = new BlobState();
    let socket: BuzzSocket | undefined;
    try {
      socket = new BuzzSocket(agent, await loadSigner(agent, state));
      await socket.start();
      const relay = await relaySigningKey(agent.relayUrl);
      // All lookups use the registered agent's relay session. Return routing facts only.
      const since = Math.floor(Date.now() / 1000) - 3600;
      const [indexed, directed, eligible] = await Promise.all([
        socket.query({ kinds: [39002], authors: [relay], "#p": [agent.pubkey], limit: 100 }),
        socket.query({ kinds: [9], authors: [agent.desktop.ownerPubkey], "#p": [agent.pubkey], since, limit: 32 }),
        readRooms(socket, relay),
      ]);
      const ids = new Set<string>();
      for (const event of indexed) {
        const id = event.tags.find(t => t[0] === "d")?.[1];
        if (event.pubkey === relay && channelId.safeParse(id).success && event.tags.some(t => t[0] === "p" && t[1] === agent.pubkey)) ids.add(id!);
      }
      for (const event of directed) {
        const id = event.tags.find(t => t[0] === "h")?.[1];
        if (event.pubkey === agent.desktop.ownerPubkey && channelId.safeParse(id).success
          && event.tags.some(t => t[0] === "p" && t[1] === agent.pubkey)) ids.add(id!);
      }
      const rooms = [...ids].slice(0, 100);
      if (!rooms.length) return reply({ rooms: [], messages: [] });
      const [metadata, rosters, recent] = await Promise.all([
        socket.query({ kinds: [39000], authors: [relay], "#d": rooms, limit: rooms.length }),
        socket.query({ kinds: [39002], authors: [relay], "#d": rooms, limit: rooms.length }),
        socket.query({ kinds: [9], authors: [agent.desktop.ownerPubkey], "#h": rooms, since, limit: 32 }),
      ]);
      const summary = rooms.map(id => {
        const group = metadata.find(e => e.pubkey === relay && e.tags.some(t => t[0] === "d" && t[1] === id));
        const roster = rosters.find(e => e.pubkey === relay && e.tags.some(t => t[0] === "d" && t[1] === id));
        return { id, type: group?.tags.find(t => t[0] === "t")?.[1], flags: group?.tags.map(t => t[0]).filter(k => ["public", "private", "hidden", "archived", "closed", "open"].includes(k)),
          agentMember: Boolean(roster?.tags.some(t => t[0] === "p" && t[1] === agent.pubkey)),
          ownerMember: Boolean(roster?.tags.some(t => t[0] === "p" && t[1] === agent.desktop!.ownerPubkey)),
          subscribed: eligible.has(id), rosterAt: roster?.created_at };
      });
      const ownerMessages = recent.filter(e => e.pubkey === agent.desktop!.ownerPubkey && e.kind === 9);
      const replies = ownerMessages.length ? await socket.query({ kinds: [9], authors: [agent.pubkey],
        "#e": ownerMessages.map(e => e.id), since, limit: 64 }) : [];
      const messages = await Promise.all(ownerMessages.map(async event => {
        const roomId = event.tags.find(t => t[0] === "h")?.[1];
        if (!rooms.includes(roomId!)) return;
        const record = await state.read<DeliveryRecord>(deliveryPath({ namespace: agent.namespace, eventId: event.id }));
        return { id: event.id, roomId, at: event.created_at, mentioned: event.tags.some(t => t[0] === "p" && t[1] === agent.pubkey),
          routable: Boolean(inboundMessage(agent, event, eligible)), queued: Boolean(record), admitted: Boolean(record?.value.receipt), completed: Boolean(record?.value.completed),
          delivered: replies.some(reply => reply.pubkey === agent.pubkey && reply.kind === 9 &&
            reply.tags.some(tag => tag[0] === "h" && tag[1] === roomId) && reply.tags.some(tag => tag[0] === "e" && tag[1] === event.id)) };
      }));
      return reply({ rooms: summary, messages: messages.filter(Boolean) });
    } catch (error) {
      log("warn", "buzz_room_status_failed", { registrationId: agent.id, error: errorName(error) });
      return reply({ error: "Could not check Buzz room delivery." }, 503);
    } finally {
      socket?.close();
    }
  },
};
