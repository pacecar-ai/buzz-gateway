import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { SignJWT } from "jose";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { WebSocketServer } from "ws";
import { handleEnrollment } from "../api/enroll.ts";
import { acceptAction } from "../lib/actions.ts";
import { loadAgents } from "../lib/config.ts";
import { CredentialRefusedError, loadSigner } from "../lib/credentials.ts";
import {
  actionId, actionKeyHeader, deliveryPath, deliverySchema, eveDeliveryPath, eveResultPath, healthPath,
  inboxTopic, outboxTopic, stableId, type ActionJob, type Delivery,
} from "../lib/protocol.ts";
import { GatewayQueue, type InboxJob } from "../lib/queue.ts";
import { BlobState, type State, type Versioned } from "../lib/state.ts";
import { GatewayWorker } from "../lib/worker.ts";

class MemoryState implements State {
  readonly entries = new Map<string, Versioned<unknown>>();
  #version = 0;

  async read<T>(path: string): Promise<Versioned<T> | null> {
    return structuredClone(this.entries.get(path) as Versioned<T> | undefined) ?? null;
  }

  async create<T>(path: string, value: T): Promise<boolean> {
    if (this.entries.has(path)) return false;
    await this.write(path, value);
    return true;
  }

  async replace<T>(path: string, value: T, etag: string): Promise<boolean> {
    if (this.entries.get(path)?.etag !== etag) return false;
    await this.write(path, value);
    return true;
  }

  async write<T>(path: string, value: T): Promise<void> {
    this.entries.set(path, { value: structuredClone(value), etag: String(++this.#version) });
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

test("routes an invited private Buzz room and publishes a signed threaded reply", { timeout: 15_000 }, async t => {
  const relayKey = generateSecretKey();
  const relaySigningKey = getPublicKey(relayKey);
  const server = createServer((request, response) => {
    assert.equal(request.headers.accept, "application/nostr+json");
    response.setHeader("content-type", "application/nostr+json");
    response.end(JSON.stringify({ self: relaySigningKey }));
  });
  const relay = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => server.once("listening", resolve).once("error", reject));
  const address = server.address();
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
  const outsider = finalizeEvent({
    kind: 9, created_at, content: "outsider", tags: [["h", "test-room"], ["p", pubkey]],
  }, generateSecretKey());
  const privateRoom = [["d", "test-room"], ["t", "stream"]];
  const publicRoom = [["d", "public-room"], ["t", "stream"]];
  const roomMembers = [["p", pubkey], ["p", getPublicKey(author)]];
  const group = (kind: number, tags: string[][], key = relayKey) => finalizeEvent({ kind, created_at, tags, content: "" }, key);
  const challenge = "fixture-challenge";
  const reply = Promise.withResolvers<Event>();
  const profile = { name: "Fixture", description: "Test agent", picture: "https://example.com/portrait.png" };
  const publishedProfiles: Event[] = [];
  const key = "fixture-callback-key";
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const relayUrl = `ws://127.0.0.1:${address.port}/`;
  relay.on("connection", socket => {
    socket.send(JSON.stringify(["AUTH", challenge]));
    socket.on("message", data => {
      try {
        const [type, eventOrSubscription, filter] = JSON.parse(String(data));
        if (type === "AUTH") {
          const event: Event = eventOrSubscription;
          assert.equal(event.kind, 22242);
          assert.equal(event.pubkey, pubkey);
          assert(verifyEvent(event));
          assert.deepEqual(event.tags, [["relay", relayUrl], ["challenge", challenge]]);
          socket.send(JSON.stringify(["OK", event.id, true, ""]));
        }
        if (type === "REQ") {
          let events: Event[];
          switch (filter.kinds[0]) {
            case 39002:
              assert.deepEqual(filter["#p"], [pubkey]);
              assert.deepEqual(filter.authors, [relaySigningKey]);
              events = [
                group(39002, [...privateRoom, ...roomMembers]),
                group(39002, [...publicRoom, ...roomMembers]),
                group(39002, [["d", "outside-room"], ...roomMembers], author),
              ];
              break;
            case 39000:
              assert.deepEqual(filter["#d"], ["test-room", "public-room"]);
              events = [group(39000, [...privateRoom, ["private"]]), group(39000, [...publicRoom, ["public"]])];
              break;
            default:
              assert.deepEqual(filter["#h"], ["test-room"]);
              events = [unauthorizedRoom, outsider, question, question];
          }
          for (const event of events) {
            socket.send(JSON.stringify(["EVENT", eventOrSubscription, event]));
          }
          socket.send(JSON.stringify(["EOSE", eventOrSubscription]));
        }
        if (type === "EVENT") {
          const event: Event = eventOrSubscription;
          // An already-stored publish after a lost ACK must also settle the outbox action.
          socket.send(JSON.stringify(["OK", event.id, event.kind !== 9, event.kind === 9 ? "duplicate: stored" : ""]));
          if (event.kind === 9) reply.resolve(event);
          if (event.kind === 0 || event.kind === 10100) publishedProfiles.push(event);
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
    roomAccess: "membership",
    profile,
    actionKeyDigest: digest(key),
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
    const keyDigest = digest("legacy-gateway-key");
    const request = (actionKey: string) => new Request("https://gateway.example.com/api/actions", {
      method: "POST",
      headers: { authorization: "Bearer fixture-credential", "content-type": "application/json", [actionKeyHeader]: actionKey },
      body: JSON.stringify({ ...delivery, kind: "reply", text: "fixture private reply" }),
    });
    assert.equal((await acceptAction(request(key), agents, state, queue, async () => false, keyDigest)).status, 403);
    assert.equal((await acceptAction(request("legacy-gateway-key"), agents, state, queue, async () => true, keyDigest)).status, 403);
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
    assert.deepEqual(publishedProfiles.map(event => event.kind), [0, 10100]);
    for (const event of publishedProfiles) {
      assert(verifyEvent(event));
      assert.equal(event.pubkey, pubkey);
      assert.deepEqual(JSON.parse(event.content), {
        name: profile.name, display_name: profile.name, about: profile.description, picture: profile.picture,
      });
    }
    assert.deepEqual(event.tags, [["h", "test-room"], ["e", question.id, "", "reply"], ["p", question.pubkey]]);
    for (let i = 0; i < 30 && !logs.mock.calls.some(call => call.arguments[0].includes("buzz_action_published")); i += 1) {
      await pause(20);
    }
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].eventId, question.id);
    assert.equal(admissions[0].text, question.content);
    assert.equal(admissions[0].community, new URL(relayUrl).origin);
    assert.equal(admissions[0].roomId, "test-room");
    assert(reconciled);
    assert(await state.read(healthPath));
    assert.equal(await state.read(deliveryPath({ ...admissions[0], eventId: unauthorizedRoom.id })), null);
    assert.equal(await state.read(deliveryPath({ ...admissions[0], eventId: outsider.id })), null);
    const entries = logs.mock.calls.map(call => call.arguments[0]);
    assert(entries.some(line => line.includes("buzz_action_published") && line.includes(question.id)));
    assert(entries.every(line => !/fixture private|fixture-credential|fixture-callback-key/.test(line)));
  } finally {
    stop.abort();
    for (const socket of relay.clients) socket.terminate();
    await running;
    await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    delete process.env[keyEnv];
  }
});

test("resolves a scoped Buzz grant from Connect and requests a relay-bound assertion", async t => {
  const signingKey = generateSecretKey();
  const pubkey = getPublicKey(signingKey);
  const ownerPubkey = getPublicKey(generateSecretKey());
  const adapter = "https://identity.example.com/api";
  const relay = "wss://buzz.example.com";
  const issuer = "https://issuer.example.com";
  const connector = "buzz.example.com/test-agent";
  const grant = "fixture-agent-grant";
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 120;
  const attestation = (audience: string) => new SignJWT({ nostr_pubkey: pubkey, nostr_owner_pubkey: ownerPubkey })
    .setProtectedHeader({ typ: "nip-fi-agent+jwt", alg: "HS256" }).setIssuer(issuer)
    .setAudience(audience).setIssuedAt(now).setExpirationTime(expires).sign(new Uint8Array(32));
  let audience = "https://buzz.example.com";
  const oidc = await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now).setExpirationTime(expires).sign(new Uint8Array(32));
  const previous = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = oidc;
  t.after(() => {
    if (previous === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = previous;
  });
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(init.method, "POST");
    const headers = new Headers(init.headers);
    if (input === `https://api.vercel.com/v1/connect/token/${encodeURIComponent(connector)}`) {
      assert.equal(headers.get("authorization"), `Bearer ${oidc}`);
      assert.deepEqual(JSON.parse(String(init.body)), { subject: { type: "app" } });
      return Response.json({ token: JSON.stringify({
        signingKey: Buffer.from(signingKey).toString("hex"),
        federated: { grant, issuer, ownerPubkey },
      }) });
    }
    assert.equal(input, `${adapter}/v1/nip-fi/agent-assertion`);
    assert.equal(headers.get("authorization"), `Bearer ${grant}`);
    assert.equal(init.redirect, "manual");
    const event: Event = JSON.parse(Buffer.from(headers.get("nostr-authorization")!.slice(6), "base64").toString());
    assert(verifyEvent(event));
    assert.equal(event.kind, 27235);
    assert.equal(event.pubkey, pubkey);
    assert.deepEqual(event.tags.slice(0, 3), [
      ["u", input], ["method", "POST"], ["payload", createHash("sha256").update(String(init.body)).digest("hex")],
    ]);
    assert.equal(event.tags[3][0], "nonce");
    assert.match(event.tags[3][1], /^[a-f0-9]{32}$/);
    assert.deepEqual(JSON.parse(String(init.body)), { nostr_pubkey: pubkey, relay_url: relay });
    return Response.json({ assertion: await attestation(audience), nostr_pubkey: pubkey, expires_at: expires });
  });
  const agents = loadAgents({ BUZZ_GATEWAY_AGENTS: JSON.stringify([{
    id: "test-agent", relayUrl: relay, pubkey, credentialConnector: connector, federatedIdentityAdapter: adapter,
    roomAccess: "membership", eveUrl: "https://eve.example.com",
    eveProject: { teamSlug: "example", teamId: "team_example", projectId: "prj_agent" },
  }]) });
  const agent = agents.get("test-agent")!;
  const signer = await loadSigner(agent);
  assert.equal(signer.assertion?.expiresAt, expires * 1000);
  audience = "https://another-community.example.com";
  await assert.rejects(loadSigner(agent), CredentialRefusedError);
});

test("authorizes one hosted Buzz installation and keeps credentials with the operator", async t => {
  const origin = "https://gateway.example.com";
  const adapter = "https://identity.example.com/api";
  const ownerPubkey = getPublicKey(generateSecretKey());
  const invite = "a".repeat(43), operator = "b".repeat(43);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const config = JSON.stringify({
    origin, adapter, ownerPubkey, operatorDigest: hash(operator), expiresAt: Date.now() + 60_000,
    agents: [{ id: "fixture", name: "Fixture agent", inviteDigest: hash(invite) }],
  });
  const state = new MemoryState();
  const post = (step: string, token = invite, fields = {}, requestOrigin = origin) =>
    handleEnrollment(new Request(`${origin}/api/enroll`, {
      method: "POST",
      headers: { origin: requestOrigin, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "fixture", step, ...fields }),
    }), config, state);
  const view = await (await post("view")).json();
  assert.equal(view.name, "Fixture agent");
  assert.match(view.pubkey, /^[a-f0-9]{64}$/);
  assert.equal((await post("start", invite, {}, "https://other.example")).status, 403);
  assert.equal((await post("collect")).status, 403);
  const start = new URL((await (await post("start")).json()).url);
  const redirect = start.searchParams.get("return_to");
  assert(redirect?.startsWith("http://127.0.0.1:"));
  assert.equal(start.searchParams.get("handoff_challenge_method"), "S256");
  const proof = ["auth", ownerPubkey, "", "a".repeat(128)];
  assert.equal((await post("complete", invite, { proof, redirect: "https://other.example/?code=fixture" })).status, 400);

  const expires_at = new Date(Date.now() + 60_000).toISOString();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    switch (url) {
      case `${adapter}/v1/login/exchange`: {
        const { code, handoff_secret } = JSON.parse(String(init.body));
        assert.equal(code, "fixture");
        assert.equal(createHash("sha256").update(handoff_secret).digest("base64url"), start.searchParams.get("handoff_challenge"));
        return Response.json({ session_token: "fixture-session", expires_at });
      }
      case `${adapter}/v1/session`:
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-session");
        return Response.json({ expires_at });
      case `${adapter}/v1/nip-fi/agent-grant`: {
        const form = new URLSearchParams(String(init.body));
        assert.equal(form.get("agent_pubkey"), view.pubkey);
        assert.equal(form.get("owner_attestation"), JSON.stringify(proof));
        assert.equal(form.get("subject_token"), "fixture-session");
        return Response.json({
          access_token: "fixture-issued-grant", issued_token_type: "urn:nostr:params:oauth:token-type:nip-fi-agent-grant",
          token_type: "N_A", nostr_owner_pubkey: ownerPubkey, nip_fi_issuer: "https://issuer.example.com",
        });
      }
      default: throw new Error("Unexpected request");
    }
  });
  const done = await post("complete", invite, { proof, redirect: `${redirect}?code=fixture` });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { ...view, authorized: true });
  const result = await (await post("collect", operator)).json();
  assert.equal(result.pubkey, view.pubkey);
  assert.equal(result.credential.federated.grant, "fixture-issued-grant");
  assert.match(result.credential.actionKey, /^[0-9a-f]{64}$/);
  assert.equal((await post("clear", operator)).status, 200);
  assert.deepEqual(await (await post("collect", operator)).json(), { status: "collected" });
});

test("reads the current Vercel connector profile after validating the Buzz invite", async t => {
  const origin = "https://gateway.example.com";
  const connectorId = "scl_BuzzFixture";
  const invite = "a".repeat(43);
  const state = new MemoryState();
  const config = JSON.stringify({
    origin, adapter: "https://identity.example.com", ownerPubkey: "1".repeat(64),
    operatorDigest: "2".repeat(64), expiresAt: Date.now() + 60_000,
    agents: [{ id: "fixture", connectorId, inviteDigest: createHash("sha256").update(invite).digest("hex") }],
  });
  const oidc = await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
    .setIssuedAt().setExpirationTime("2m").sign(new Uint8Array(32));
  const previous = process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_OIDC_TOKEN = oidc;
  t.after(() => {
    if (previous === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = previous;
  });
  let profile = { name: "Fixture · Buzz", icon: "3".repeat(40) };
  const requestProfile = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, `https://api.vercel.com/v1/connect/connectors/${connectorId}`);
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${oidc}`);
    return Response.json(profile);
  });
  const view = (token: string) => handleEnrollment(new Request(`${origin}/api/enroll`, {
    method: "POST",
    headers: { origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "fixture", step: "view" }),
  }), config, state);
  assert.equal((await view("b".repeat(43))).status, 403);
  assert.equal(requestProfile.mock.callCount(), 0);
  const original = await (await view(invite)).json();
  assert.equal(original.name, "Fixture");
  assert.equal(original.picture, `https://vercel.com/api/www/avatar/${profile.icon}`);
  profile = { name: "New fixture name", icon: "4".repeat(40) };
  const updated = await (await view(invite)).json();
  assert.deepEqual(updated, { ...original, name: profile.name, picture: `https://vercel.com/api/www/avatar/${profile.icon}` });
});

test("Blob and Queues read a newly rotated daemon OIDC token", async t => {
  const directory = await mkdtemp(join(tmpdir(), "buzz-oidc-fixture-"));
  const tokenPath = join(directory, "token");
  const requests: string[] = [];
  const blob = createServer((request, response) => {
    requests.push(request.headers.authorization ?? "");
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => blob.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = blob.address();
  assert(address && typeof address !== "string");
  const env = {
    VERCEL_OIDC_TOKEN_FILE: tokenPath,
    BLOB_STORE_ID: "store_fixture",
    BUZZ_GATEWAY_REGION: "iad1",
    VERCEL_BLOB_API_URL: `http://127.0.0.1:${address.port}`,
  };
  const previous = Object.entries(env).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve, reject) => blob.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  });

  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ messageId: "fixture" });
  });
  const storage = new BlobState();
  const queue = new GatewayQueue();
  const action = {
    version: 1, registrationId: "fixture", namespace: "1".repeat(64), eventId: "2".repeat(64), kind: "typing",
  } as const;
  const tokens = await Promise.all(["first", "second"].map(revision => new SignJWT({ revision })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new Uint8Array(32))));
  for (const token of tokens) {
    await writeFile(tokenPath, token + "\n");
    await storage.write(healthPath, { at: Date.now() });
    await queue.sendAction({ action, queuedAt: Date.now() });
  }
  assert.deepEqual(requests, tokens.flatMap(token => [`Bearer ${token}`, `Bearer ${token}`]));
});
