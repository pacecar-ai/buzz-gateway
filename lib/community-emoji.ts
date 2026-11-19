import type { Event } from "nostr-tools/pure";
import { BuzzSocket } from "./buzz-socket.ts";
import type { Agent } from "./config.ts";
import { loadSigner } from "./credentials.ts";
import type { State } from "./state.ts";

const directory = "buzz:custom-emoji";
export const shortcode = /^:([a-z0-9_-]{1,64}):$/;
type SetEvent = Pick<Event, "kind" | "id" | "pubkey" | "tags" | "created_at">;
/** Match Buzz's latest set per signer, then its most recent definition for each name. */
export function communityEmojiUrl(sets: readonly SetEvent[], name: string): string | undefined {
  const latest = new Map<string, SetEvent>();
  for (const event of sets) {
    if (event.kind !== 30030 || !event.tags.some(t => t[0] === "d" && t[1] === directory)) continue;
    const old = latest.get(event.pubkey);
    if (!old || event.created_at > old.created_at || (event.created_at === old.created_at && event.id < old.id)) latest.set(event.pubkey, event);
  }
  let selected: { time: number; url: string } | undefined;
  for (const event of latest.values()) {
    const value = event.tags.find(t => t[0] === "emoji" && t[1] === name)?.[2];
    if (!value || value.length > 2048 || !URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) continue;
    if (!selected || event.created_at > selected.time || (event.created_at === selected.time && value < selected.url)) {
      selected = { time: event.created_at, url: value };
    }
  }
  return selected?.url;
}

export async function readCommunityEmoji(agent: Agent, state: State, name: string) {
  const socket = new BuzzSocket(agent, await loadSigner(agent, state));
  try {
    await socket.start();
    const sets = await socket.query({ kinds: [30030], "#d": [directory], limit: 500 });
    return communityEmojiUrl(sets, name);
  } finally {
    socket.close();
  }
}
