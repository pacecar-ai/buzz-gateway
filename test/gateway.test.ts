import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { WebSocketServer } from "ws";
import { acceptAction } from "../lib/actions.ts";
import { loadAgents } from "../lib/config.ts";
import {
  actionId, actionKeyHeader, deliveryPath, deliverySchema, eveDeliveryPath, eveResultPath, healthPath,
  inboxTopic, outboxTopic, stableId, type ActionJob, type Delivery,
} from "../lib/protocol.ts";
import type { InboxJob } from "../lib/queue.ts";
import type { State, Versioned } from "../lib/state.ts";
import { GatewayWorker } from "../lib/worker.ts";

class MemoryState implements State {
  readonly entries = new Map<string, Versioned<unknown>>();
  #version = 0;

  async read<T>(path: string): Promise<Versioned<T> | null> {
    return structuredClone(this.entries.get(path) as Versioned<T> | undefined) ?? null;
  }

  async create<T>(path: string, value: T): Promise<boolean> {
    if (this.entries.has(path)) return false;
    this.entries.set(path, { value: structuredClone(value), etag: String(++this.#version) });
    return true;
  }

  async replace<T>(path: string, value: T, etag: string): Promise<boolean> {
    if (this.entries.get(path)?.etag !== etag) return false;
    this.entries.set(path, { value: structuredClone(value), etag: String(++this.#version) });
    return true;
  }
}

class MemoryQueue {
  #inbox: InboxJob[] = [];
  #outbox: ActionJob[] = [];
  #sent = new Set<string>();

  async sendDelivery(delivery: Delivery): Promise<void> {
    const id = stableId(delivery.namespace, delivery.eventId);
    if (this.#sent.has(id)) return;
    this.#sent.add(id);
    this.#inbox.push({ kind: "message", delivery });
  }

  async sendReconciliation(delivery: Pick<Delivery, "registrationId" | "namespace" | "eventId">): Promise<void> {
    const { registrationId, namespace, eventId } = delivery;
    this.#inbox.push({ kind: "reconcile", registrationId, namespace, eventId });
  }

  async sendAction(job: ActionJob): Promise<void> {
    const id = actionId(job.action);
    if (this.#sent.has(id)) return;
    this.#sent.add(id);
    this.#outbox.push(job);
  }

  async poll(topic: typeof inboxTopic | typeof outboxTopic, handler: (job: unknown) => Promise<void>): Promise<boolean> {
    const job = topic === inboxTopic ? this.#inbox.shift() : this.#outbox.shift();
    if (!job) return false;
    await handler(job);
    return true;
  }
}

test("authenticates to Buzz, authorizes the eve action, and publishes a signed threaded reply", { timeout: 15_000 }, async t => {
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => relay.once("listening", resolve).once("error", reject));
  const address = relay.address();
  assert(address && typeof address !== "string");
  const botKey = generateSecretKey();
  const pubkey = getPublicKey(botKey);
  const author = generateSecretKey();
  const created_at = Math.floor(Date.now() / 1000);
  const question = finalizeEvent({
    kind: 9, created_at, content: "fixture private message", tags: [["h", "test-room"], ["p", pubkey]],
  }, author);
  const unauthorizedRoom = finalizeEvent({
    kind: 9, created_at, content: "other room", tags: [["h", "outside-room"], ["p", pubkey]],
  }, author);
  const challenge = "fixture-challenge";
  const reply = Promise.withResolvers<Event>();
  const relayUrl = `ws://127.0.0.1:${address.port}/`;
  relay.on("connection", socket => {
    socket.send(JSON.stringify(["AUTH", challenge]));
    socket.on("message", data => {
      try {
        const [type, eventOrSubscription] = JSON.parse(String(data));
        if (type === "AUTH") {
          const event: Event = eventOrSubscription;
          assert.equal(event.kind, 22242);
          assert.equal(event.pubkey, pubkey);
          assert(verifyEvent(event));
          assert.deepEqual(event.tags, [["relay", relayUrl], ["challenge", challenge]]);
          socket.send(JSON.stringify(["OK", event.id, true, ""]));
        }
        if (type === "REQ") {
          for (const event of [unauthorizedRoom, question, question]) {
            socket.send(JSON.stringify(["EVENT", eventOrSubscription, event]));
          }
          socket.send(JSON.stringify(["EOSE", eventOrSubscription]));
        }
        if (type === "EVENT") {
          const event: Event = eventOrSubscription;
          // An already-stored publish after a lost ACK must also settle the outbox action.
          socket.send(JSON.stringify(["OK", event.id, event.kind !== 9, event.kind === 9 ? "duplicate: stored" : ""]));
          if (event.kind === 9) reply.resolve(event);
        }
      } catch (error) {
        reply.reject(error);
      }
    });
  });
  t.mock.method(console, "log", () => {});
  const logs = console.log as typeof console.log & { mock: { calls: { arguments: [string] }[] } };
  const keyEnv = "BUZZ_FIXTURE_SIGNING_KEY";
  process.env[keyEnv] = Buffer.from(botKey).toString("hex");
  const agents = loadAgents({ BUZZ_GATEWAY_AGENTS: JSON.stringify([{
    id: "test-agent", pubkey, relayUrl, signingKeyEnv: keyEnv,
    eveUrl: "https://eve.example.com",
    eveProject: { teamSlug: "example", teamId: "team_example", projectId: "prj_agent" },
    channels: ["test-room"],
  }]) });
  const state = new MemoryState();
  const queue = new MemoryQueue();
  const admissions: Delivery[] = [];
  let reconciled = false;
  const worker = new GatewayWorker(agents, state, queue, async (_url, path, input) => {
    if (path === eveResultPath) {
      reconciled = true;
      return new Response(null, { status: 200 });
    }
    assert.equal(path, eveDeliveryPath);
    const delivery = deliverySchema.parse(input);
    admissions.push(delivery);
    const key = "fixture-callback-key";
    const keyDigest = createHash("sha256").update(key).digest("hex");
    const request = (actionKey: string) => new Request("https://gateway.example.com/api/actions", {
      method: "POST",
      headers: { authorization: "Bearer fixture-credential", "content-type": "application/json", [actionKeyHeader]: actionKey },
      body: JSON.stringify({ ...delivery, kind: "reply", text: "fixture private reply" }),
    });
    assert.equal((await acceptAction(request(key), agents, state, queue, async () => false, keyDigest)).status, 403);
    assert.equal((await acceptAction(request("invalid"), agents, state, queue, async () => true, keyDigest)).status, 403);
    assert.equal((await acceptAction(request(key), agents, state, queue, async () => true, keyDigest)).status, 202);
    assert.equal((await acceptAction(request(key), agents, state, queue, async () => true, keyDigest)).status, 202);
    return Response.json({ sessionId: "test-session", deliveryId: "test-delivery" }, { status: 202 });
  });
  const stop = new AbortController();
  const running = worker.run(stop.signal);
  try {
    const event = await Promise.race([
      reply.promise, pause(10_000, null, { ref: false }),
    ]);
    assert(event, "The gateway did not publish a reply");
    assert(verifyEvent(event));
    assert.equal(event.pubkey, pubkey);
    assert.equal(event.content, "fixture private reply");
    assert.deepEqual(event.tags, [["h", "test-room"], ["e", question.id, "", "reply"], ["p", question.pubkey]]);
    for (let i = 0; i < 30 && !logs.mock.calls.some(call => call.arguments[0].includes("buzz_action_published")); i += 1) {
      await pause(20);
    }
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].eventId, question.id);
    assert.equal(admissions[0].text, question.content);
    assert(reconciled);
    assert(await state.read(healthPath));
    assert.equal(await state.read(deliveryPath({ ...admissions[0], eventId: unauthorizedRoom.id })), null);
    const entries = logs.mock.calls.map(call => call.arguments[0]);
    assert(entries.some(line => line.includes("buzz_action_published") && line.includes(question.id)));
    assert(entries.every(line => !/fixture private|fixture-credential|fixture-callback-key/.test(line)));
  } finally {
    stop.abort();
    for (const socket of relay.clients) socket.terminate();
    await running;
    await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
    delete process.env[keyEnv];
  }
});
