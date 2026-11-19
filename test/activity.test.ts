import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeEvent, generateSecretKey, verifyEvent, type Event, type EventTemplate } from "nostr-tools/pure";
import { publishActivity } from "../lib/activity.ts";
import { actionEvent } from "../lib/buzz.ts";
import { actionId, type Action } from "../lib/protocol.ts";
import type { State, Versioned } from "../lib/state.ts";

const target = { channelId: "room", rootId: "a".repeat(64), sourceEventId: "b".repeat(64), author: "c".repeat(64) };
const ref = { version: 1 as const, registrationId: "one", namespace: "d".repeat(64), eventId: target.sourceEventId };
function fixture() {
  const key = generateSecretKey();
  const rows = new Map<string, Versioned<unknown>>();
  let serial = 0;
  const write = (path: string, value: unknown) => rows.set(path, { etag: String(++serial), value });
  const state: State = {
    async read<T>(path: string) { return rows.get(path) as Versioned<T> ?? null; },
    async write(path, value) { write(path, value); },
    async create(path, value) { if (rows.has(path)) return false; write(path, value); return true; },
    async replace(path, value, etag) { if (rows.get(path)?.etag !== etag) return false; write(path, value); return true; },
  };
  const events: Event[] = [];
  let fail = false;
  const relay = { sign: (draft: EventTemplate) => finalizeEvent(draft, key), async publish(event: Event) {
    assert.ok(verifyEvent(event));
    events.push(event);
    if (fail) { fail = false; throw new Error("lost receipt"); }
  } };
  return { events, failOnce() { fail = true; }, update: (revision: number, text: string | null, busy = Boolean(text)) =>
    publishActivity(state, relay, { ...ref, kind: "status", revision, text, busy }, target, Date.now()) };
}
test("native reactions select the source message and signed room; nested replies preserve source and root", () => {
  const reaction = actionEvent({ ...ref, kind: "reaction", emoji: "👩🏽‍💻" }, target, Date.now());
  assert.equal(reaction.kind, 7);
  assert.deepEqual(reaction.tags, [["h", target.channelId], ["e", target.sourceEventId], ["p", target.author], ["k", "9"]]);
  const reply = actionEvent({ ...ref, kind: "reply", text: "hello" }, target, Date.now());
  assert.deepEqual(reply.tags.slice(1, 3), [["e", target.rootId, "", "root"], ["e", target.sourceEventId, "", "reply"]]);
  const status: Action = { ...ref, kind: "status", revision: 1, text: "Thinking…", busy: true };
  assert.notEqual(actionId(status), actionId({ ...status, revision: 2 }));
});
test("one status post is edited and cleared, preserving native IDs across retries and stale updates", async () => {
  const f = fixture();
  f.failOnce();
  await assert.rejects(() => f.update(4, "Thinking…"));
  assert.equal(await f.update(4, "Thinking…"), true);
  assert.equal(new Set(f.events.map(e => e.id)).size, 1);
  const root = f.events[0];
  await f.update(8, "Checking the release…");
  const edit = f.events.at(-1)!;
  assert.equal(edit.kind, 40003);
  assert.deepEqual(edit.tags, [["h", target.channelId], ["e", root.id]]);
  const count = f.events.length;
  await f.update(7, "Thinking…");
  assert.equal(f.events.length, count);
  assert.equal(await f.update(9, null), false);
  const clear = f.events.at(-1)!;
  assert.equal(clear.kind, 5);
  assert.deepEqual(clear.tags, edit.tags);
  await f.update(4, "Thinking…");
  assert.equal(f.events.at(-1)!.id, clear.id);
});
test("a completion arriving before the first progress update prevents stale activity", async () => {
  const f = fixture();
  await f.update(7, null);
  await f.update(5, "Thinking…");
  assert.deepEqual(f.events, []);
});

test("custom reactions use the latest surviving community definition and carry its native emoji tag", async () => {
  const { communityEmojiUrl } = await import("../lib/community-emoji.ts");
  const set = (pubkey: string, created_at: number, value?: string) => ({ kind: 30030, pubkey, id: String(created_at), created_at,
    tags: [["d", "buzz:custom-emoji"], ...(value ? [["emoji", "ship", value]] : [])] });
  const sets = [set("one", 4, "https://media.example/old"), set("one", 5),
    set("two", 1, "https://media.example/b"), set("three", 1, "https://media.example/a"), set("four", 9, "javascript:unsupported")];
  assert.equal(communityEmojiUrl(sets, "missing"), undefined);
  const url = communityEmojiUrl(sets, "ship");
  assert.equal(url, "https://media.example/a");
  const draft = actionEvent({ ...ref, kind: "reaction", emoji: ":ship:" }, target, Date.now(), { name: "ship", url });
  assert.ok(draft.tags.some(t => t.join(" ") === "emoji ship https://media.example/a"));
  assert.ok(draft.tags.some(t => t[0] === "e" && t[1] === target.sourceEventId));
});

test("the action API resolves custom art for an admitted receipt after project verification", async () => {
  const { acceptAction } = await import("../lib/actions.ts");
  const agent = { id: "one", namespace: ref.namespace, eveProject: {} } as never;
  const state = { read: async () => ({ value: { delivery: { registrationId: "one" } } }) } as unknown as State;
  const calls: string[] = [];
  const jobs: unknown[] = [];
  const run = (authorized: boolean, url?: string) => acceptAction(new Request("https://gateway.example/api/actions", {
    method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" },
    body: JSON.stringify({ ...ref, kind: "reaction", emoji: ":ship:", reactionAsset: { url: "https://untrusted.example/art" } }),
  }), new Map([["one", agent]]), state, { async sendAction(job) { jobs.push(job); } }, async () => authorized, undefined,
    async (_agent, _state, name) => { calls.push(name); return url; });
  assert.equal((await run(false)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await run(true)).status, 422);
  assert.equal(jobs.length, 0);
  assert.equal((await run(true, "https://media.example/ship")).status, 202);
  assert.deepEqual((jobs[0] as { reactionAsset: unknown }).reactionAsset, { name: "ship", url: "https://media.example/ship" });
});
