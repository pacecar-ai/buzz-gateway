import type { Event } from "nostr-tools/pure";
import { z } from "zod";
import type { BuzzSocket } from "./buzz-socket.ts";
import { channelId } from "./config.ts";
import { hexId } from "./protocol.ts";

const memberKind = 39002;
const metadataKind = 39000;
const roomLimit = 500;

type BuzzRoom = { direct: boolean; visibility?: "public" | "private"; members: ReadonlySet<string>; rosterAt: number };
export type BuzzRooms = ReadonlyMap<string, BuzzRoom>;

export async function relaySigningKey(relayUrl: string): Promise<string> {
  const endpoint = new URL(relayUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  const response = await fetch(endpoint, {
    headers: { accept: "application/nostr+json" },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Buzz relay discovery failed");
  return z.object({ self: hexId }).parse(await response.json()).self;
}

export async function readRooms(socket: BuzzSocket, relayKey: string, roomId?: string): Promise<BuzzRooms> {
  const agentKey = socket.agent.pubkey;
  const members = new Map<string, Pick<BuzzRoom, "members" | "rosterAt">>();
  // Buzz returns signed group records filtered by the authenticated agent's memberships.
  const memberEvents = await socket.query({ kinds: [memberKind], authors: [relayKey], "#p": [agentKey],
    ...(roomId ? { "#d": [roomId], limit: 1 } : { limit: roomLimit }) });
  for (const [id, event] of latestGroups(memberEvents, memberKind, relayKey)) {
    if (roomId && id !== roomId) continue;
    const keys = new Set(event.tags.filter(tag => tag[0] === "p" && hexId.safeParse(tag[1]).success).map(tag => tag[1]));
    if (keys.has(agentKey)) members.set(id, { members: keys, rosterAt: event.created_at });
  }

  const rooms = new Map<string, BuzzRoom>();
  const ids = [...members.keys()];
  // Bound the number of tag values in one REQ. An installation can span many private rooms.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const events = await socket.query({ kinds: [metadataKind], authors: [relayKey], "#d": batch, limit: batch.length });
    for (const [id, event] of latestGroups(events, metadataKind, relayKey)) {
      const roomMembers = batch.includes(id) ? members.get(id) : undefined;
      const type = event.tags.find(tag => tag[0] === "t")?.[1];
      const isPrivate = event.tags.some(tag => tag[0] === "private");
      const isPublic = event.tags.some(tag => tag[0] === "public");
      if (!roomMembers || isPublic === isPrivate || event.tags.some(tag => tag[0] === "archived")) continue;
      if ((type === "stream" && (isPrivate || socket.agent.includePublicChannels)) || (type === "dm" && isPrivate)) {
        rooms.set(id, { direct: type === "dm", visibility: isPrivate ? "private" : "public", ...roomMembers });
      }
    }
  }
  return rooms;
}

export function sameRooms(current: BuzzRooms, next: BuzzRooms): boolean {
  if (current.size !== next.size) return false;
  for (const [id, before] of current) {
    const after = next.get(id);
    if (!after || before.direct !== after.direct || before.visibility !== after.visibility || before.members.size !== after.members.size) return false;
    for (const key of before.members) if (!after.members.has(key)) return false;
  }
  return true;
}

function latestGroups(events: Event[], kind: number, relayKey: string): Map<string, Event> {
  const groups = new Map<string, Event>();
  for (const event of events) {
    if (event.kind !== kind || event.pubkey !== relayKey) continue;
    const tags = event.tags.filter(tag => tag[0] === "d");
    if (tags.length !== 1 || !channelId.safeParse(tags[0][1]).success) continue;
    const id = tags[0][1];
    const previous = groups.get(id);
    if (!previous || event.created_at > previous.created_at
      || (event.created_at === previous.created_at && event.id < previous.id)) groups.set(id, event);
  }
  return groups;
}
