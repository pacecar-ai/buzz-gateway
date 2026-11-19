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
