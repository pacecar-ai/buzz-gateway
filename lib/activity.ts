import type { Event, EventTemplate } from "nostr-tools/pure";
import { receiptRetentionDays, type Action } from "./protocol.ts";
import type { State, Target } from "./state.ts";

type Status = Extract<Action, { kind: "status" }>;
type Card = { revision: number; root?: Event; change?: Event; delivered: boolean; busy: boolean };
type Relay = { sign(event: EventTemplate): Event; publish(event: Event): Promise<void> };

/** Replays the exact signed event after a lost relay receipt. The first event stays the edit target. */
export async function publishActivity(state: State, relay: Relay, status: Status, target: Target, queuedAt: number) {
  const path = status.namespace + "/activity/" + status.eventId + ".json";
  for (let attempt = 0; attempt < 6; attempt++) {
    let saved = await state.read<Card>(path);
    if (!saved || saved.value.revision < status.revision) {
      const old = saved?.value;
      const created_at = Math.max(Math.floor(queuedAt / 1000), (old?.change?.created_at ?? old?.root?.created_at ?? 0) + 1);
      const tags = [["h", target.channelId]];
      let root = old?.root;
      let change: Event | undefined;
      if (root) {
        tags.push(["e", root.id]);
        change = relay.sign({ kind: status.text === null ? 5 : 40003, tags, content: status.text ?? "", created_at });
      } else if (status.text) {
        if (target.rootId && target.rootId !== target.sourceEventId) tags.push(["e", target.rootId, "", "root"]);
        tags.push(["e", target.sourceEventId, "", "reply"], ["buzz:request", target.sourceEventId], ["audience", "agents"]);
        root = relay.sign({ kind: 9, tags, content: status.text, created_at });
      }
      const value: Card = { root, change, revision: status.revision, delivered: false, busy: Boolean(status.text && status.busy) };
      const stored = saved ? await state.replace(path, value, saved.etag, receiptRetentionDays)
        : await state.create(path, value, receiptRetentionDays);
      if (!stored) continue;
      saved = await state.read<Card>(path);
    }
    if (!saved) throw new Error("Buzz activity record unavailable");
    const card = saved.value;
    if (card.delivered || card.revision !== status.revision) return card.busy;
    // The initial post may have lost its acknowledgement. Republishing that same ID is idempotent.
    if (card.root && card.change?.kind !== 5) await relay.publish(card.root);
    if (card.change) await relay.publish(card.change);
    if (await state.replace(path, { ...card, delivered: true }, saved.etag, receiptRetentionDays)) return card.busy;
  }
  throw new Error("Concurrent Buzz activity update");
}
