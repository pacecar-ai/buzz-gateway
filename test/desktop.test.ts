import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { publishAgentProfile } from "../lib/agent-profile.ts";
import { loadAgents, type Agent } from "../lib/config.ts";
import { createHandoff, handleDesktop } from "../lib/desktop.ts";
import { desktopGrantPath, issueDesktopGrant, publishedOwnershipPath, readDesktopGrant, readDesktopOwnership,
  saveDesktopOwnership } from "../lib/desktop-grants.ts";
import { credentialProfileProof, type Signer } from "../lib/credentials.ts";
import { enrollAgent } from "../lib/enrollment.ts";
import { ownerProofFor, type OwnerProof } from "../lib/owner-proof.ts";
import type { State, Versioned } from "../lib/state.ts";

class FixtureState implements State {
  records = new Map<string, Versioned<unknown>>();
  async read<T>(path: string) { return (this.records.get(path) as Versioned<T>) ?? null; }
  async write<T>(path: string, value: T) { this.records.set(path, { value, etag: randomBytes(8).toString("hex") }); }
  async create<T>(path: string, value: T) {
    if (this.records.has(path)) return false;
    await this.write(path, value); return true;
  }
  async replace<T>(path: string, value: T, etag: string) {
    if (this.records.get(path)?.etag !== etag) return false;
    await this.write(path, value); return true;
  }
}

const ownerKey = generateSecretKey(), owner = getPublicKey(ownerKey);
const community = "wss://relay.example.org", adapter = "https://identity.example.org/adapter";
function fixture(ids: string[]) {
  const keys = new Map(ids.map(id => [id, generateSecretKey()]));
  const agents = loadAgents({ BUZZ_GATEWAY_AGENTS: JSON.stringify(ids.map(id => ({
    id, relayUrl: community, pubkey: getPublicKey(keys.get(id)!), credentialConnector: "scl_" + id,
    federatedIdentityAdapter: adapter, profileFromConnector: true, desktop: { ownerPubkey: owner, projectSlug: id },
    eveUrl: "https://" + id + ".example.org", eveProject: { teamSlug: "fixture", teamId: "team_test", projectId: "prj_" + id },
  }))) });
  const state = new FixtureState();
  let exchanges = 0;
  const issued: string[] = [];
  const services = {
    async profile(id: string) { return { name: id.slice(4), picture: "https://example.org/portrait.png" }; },
    async credential(id: string) { return { signingKey: Buffer.from(keys.get(id.slice(4))!).toString("hex") }; },
    async exchange(_adapter: string, _code: string, _verifier: string) { exchanges++; return "human-session-fixture"; },
    async enroll(_adapter: string, session: string, secret: string, proof: ["auth", string, string, string]) {
      assert.equal(session, "human-session-fixture");
      const key = getPublicKey(Buffer.from(secret, "hex"));
      issued.push(key);
      return { grant: "grant-for-" + key, issuer: adapter, ownerPubkey: proof[1] };
    },
    async usable() { return true; },
  };
  const operator = randomBytes(32).toString("base64url");
  const opHash = createHash("sha256").update(operator).digest("hex");
  const post = (token: string, values: object) => handleDesktop(new Request("https://gateway.example.org/api/desktop", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ owner, community, ...values }),
  }), agents, state, services, opHash);
  function proof(agent: Agent) {
    const message = createHash("sha256").update("nostr:agent-auth:" + agent.pubkey + ":").digest();
    return { id: agent.id, pubkey: agent.pubkey, proof: ["auth", owner, "", Buffer.from(schnorr.sign(message, ownerKey)).toString("hex")] };
  }
  return { keys, agents, post, proof, state, operator, issued, services, exchanges: () => exchanges };
}

const callback = "http://127.0.0.1:49152/buzz/" + "d".repeat(32);
test("one unavailable Vercel connector does not block approval for its neighbors", async () => {
  const f = fixture(["first", "second"]);
  const ref = await createHandoff([...f.agents.values()], f.state, Date.now() + 60_000);
  const credential = f.services.credential;
  f.services.credential = async id => {
    if (id === "scl_first") throw new Error("fixture credential unavailable");
    return credential(id);
  };
  const list = await f.post(ref, { step: "list" });
  assert.equal(list.status, 200);
  const [first, second] = (await list.json()).agents;
  assert.equal(first.name, "first");
  assert.equal(first.picture, "https://example.org/portrait.png");
  assert.equal(first.unavailable, true);
  assert.equal(first.retry, true);
  assert.equal(second.unavailable, false);
  assert.equal((await f.post(ref, { step: "approve", ...f.proof(f.agents.get("second")!) })).status, 200);
});

test("one desktop sign-in approves separately signed connectors and preserves completed grants on retry", async () => {
  const f = fixture(["one", "two", "three"]);
  const issue = await (await f.post(f.operator, { step: "invite", id: "one", all: true })).json();
  const ref = issue.path.split("#")[1];
  const listed = await (await f.post(ref, { step: "list" })).json();
  assert.equal(listed.agents.length, 3);
  assert.equal(listed.agents[0].approved, false);
  assert.equal((await f.post(ref, { step: "invite", id: "one", all: true })).status, 403);
  assert.equal((await f.post(ref, { step: "list", owner: getPublicKey(generateSecretKey()) })).status, 403);
  assert.equal((await f.post(ref, { step: "list", community: "wss://other.example.org" })).status, 403);
  const selected = [...f.agents.values()].slice(0, 2).map(f.proof);
  const begin = (rows = selected, url = callback) => f.post(ref, { step: "batch-start", members: rows, callback: url });
  assert.equal((await begin(selected, "https://gateway.example.org/callback")).status, 400);
  assert.equal((await begin([selected[0], { ...selected[1], proof: selected[0].proof }])).status, 403);
  const started = await (await begin()).json();
  assert.equal(new URL(started.url).searchParams.get("return_to"), callback);
  const finish = (members: typeof selected) => f.post(ref, { step: "batch-finish", members, attempt: started.attempt, code: "browser-code" });
  assert.equal((await finish([...selected, f.proof(f.agents.get("three")!)])).status, 409);
  assert.deepEqual(await (await finish(selected)).json(), { approved: true });
  assert.deepEqual(await (await finish(selected)).json(), { approved: true });
  assert.equal(f.exchanges(), 1);
  assert.equal(new Set(f.issued).size, 2);
  const one = f.agents.get("one")!;
  assert.equal((await readDesktopGrant(one, f.keys.get("one")!, f.state))?.grant, "grant-for-" + one.pubkey);
  assert.deepEqual(await readDesktopOwnership(one, f.keys.get("one")!, f.state), selected[0].proof);
  const stored = JSON.stringify([...f.state.records.values()]);
  assert(!stored.includes("human-session-fixture") && !stored.includes("grant-for-") && !stored.includes(selected[0].proof[3]));
  assert(!JSON.stringify(listed).includes("signingKey") && !stored.includes(ref));
  await assert.rejects(readDesktopGrant(one, f.keys.get("two")!, f.state));
  assert.equal(await f.state.read(desktopGrantPath(f.agents.get("three")!)), null);
  f.services.usable = async () => false;
  assert.equal((await (await f.post(ref, { step: "list" })).json()).agents[0].unavailable, true);
  assert.equal((await f.post(ref, { step: "approve", ...selected[0] })).status, 409);
});

test("existing Blob and Connect agents enable teams without replacing their grants or opening sign-in", async () => {
  const f = fixture(["one", "two", "three"]);
  const [one, two, three] = [...f.agents.values()];
  const ref = await createHandoff([one, two, three], f.state, Date.now() + 60_000);
  const grant = { ownerPubkey: owner, issuer: adapter, grant: "fixture-existing-grant" };
  await issueDesktopGrant(one, f.keys.get("one")!, f.state, async () => grant);
  const original = await f.state.read(desktopGrantPath(one));
  const credential = f.services.credential;
  f.services.credential = async id => ({ ...await credential(id), ...(id === "scl_two" && { federated: grant }) });
  const members = [one, two].map(f.proof);
  const listed = async () => (await (await f.post(ref, { step: "list" })).json()).agents;
  assert.deepEqual((await listed()).map((row: { teams?: string }) => row.teams), ["needs-approval", "needs-approval", undefined]);
  assert.equal((await f.post(ref, { step: "teams", members: [...members, f.proof(three)] })).status, 409);
  assert.equal((await f.post(ref, { step: "teams", members: [{ ...members[0], proof: members[1].proof }] })).status, 403);
  assert.equal(await readDesktopOwnership(one, f.keys.get("one")!, f.state), undefined);
  const repair = () => f.post(ref, { step: "teams", members });
  const attempts = await Promise.all([repair(), repair()]);
  assert(attempts.every(result => result.status === 200));
  assert.deepEqual((await listed()).map((row: { teams?: string }) => row.teams), ["syncing", "syncing", undefined]);
  assert.equal(f.exchanges(), 0);
  assert.equal(f.issued.length, 0);
  assert.deepEqual(await f.state.read(desktopGrantPath(one)), original);
  assert.equal(await f.state.read(desktopGrantPath(two)), null);
  assert.deepEqual(await readDesktopOwnership(two, f.keys.get("two")!, f.state), members[1].proof);
  assert(!JSON.stringify([...f.state.records.values()]).includes(members[0].proof[3]));
  await assert.rejects(readDesktopOwnership(one, f.keys.get("two")!, f.state));
});

test("standalone enrollment retains only a verified profile proof in the agent's Connect credential", async t => {
  const f = fixture(["one", "two"]);
  const [one, two] = [...f.agents.values()];
  const secret = Buffer.from(f.keys.get("one")!).toString("hex");
  t.mock.method(globalThis, "fetch", async () => Response.json({
    access_token: "fixture-standalone-grant", issued_token_type: "urn:nostr:params:oauth:token-type:nip-fi-agent-grant",
    token_type: "N_A", nostr_owner_pubkey: owner, nip_fi_issuer: adapter,
  }));
  const proof = f.proof(one).proof as OwnerProof;
  const federated = await enrollAgent(adapter, "fixture-session", secret, proof);
  assert.deepEqual(credentialProfileProof(one, owner, { signingKey: secret, federated }), proof);
  const invalid = await enrollAgent(adapter, "fixture-session", secret, f.proof(two).proof as OwnerProof);
  assert.equal(invalid.ownerAttestation, undefined);
});

test("recovers only a signed, owner-bound public attestation that permits the new profile, and preserves it on edits", async () => {
  const f = fixture(["one", "other"]);
  const [agent, other] = [...f.agents.values()];
  const key = f.keys.get("one")!;
  const sign: Signer["sign"] = template => finalizeEvent(template, key);
  const now = Math.floor(Date.now() / 1000);
  const proof = f.proof(agent).proof as OwnerProof;
  function conditional(conditions: string): OwnerProof {
    const message = createHash("sha256").update(`nostr:agent-auth:${agent.pubkey}:${conditions}`).digest();
    return ["auth", owner, conditions, Buffer.from(schnorr.sign(message, ownerKey)).toString("hex")];
  }
  const profileEvent = (tags: string[][], kind = 0) => sign({ kind, tags, created_at: now - 10, content: "{}" });
  const ownership: NonNullable<Signer["profileOwnership"]> = { owner,
    save: p => saveDesktopOwnership(agent, key, f.state, p) };
  const old = profileEvent([]);
  const invalid = [
    profileEvent([f.proof(other).proof]),
    profileEvent([conditional("kind=10100")], 10100),
    profileEvent([conditional("created_at<" + now)]),
    profileEvent([proof, proof]),
    { ...profileEvent([proof]), sig: "0".repeat(128) },
  ];
  const notes = [profileEvent([proof], 1)];
  const published: Event[] = [];
  let head = old, showOldHead = true;
  const socket = {
    agent, signer: { sign, profileOwnership: ownership },
    async publish(event: Event) {
      assert(verifyEvent(event));
      if (event.kind === 0) head = event;
      published.push(event);
    },
    async query(filter: { kinds?: number[]; limit: number }) {
      if (filter.kinds?.length === 1) return showOldHead ? [old] : [head];
      return filter.kinds?.includes(1) ? notes : invalid;
    },
  };
  const profile = { name: "Test agent" };
  await assert.rejects(publishAgentProfile(socket, f.state, profile), /has not confirmed/);
  assert.equal(await f.state.read(publishedOwnershipPath(agent)), null);
  assert.deepEqual(await readDesktopOwnership(agent, key, f.state), proof);
  showOldHead = false;
  const first = await publishAgentProfile(socket, f.state, profile);
  assert(first.attested);
  assert.deepEqual(await publishAgentProfile(socket, f.state, profile, first), first);
  const count = published.length;
  await publishAgentProfile(socket, f.state, { ...profile, name: "Renamed", picture: "https://example.org/new.png" }, first);
  assert.equal(published.length, count + 2);
  assert(published.every(event => event.kind === 0 ? !!ownerProofFor(agent.pubkey, owner, event.tags[0], 0, event.created_at)
    : event.kind === 10100 && event.tags.length === 0));
  const record = await f.state.read<{ eventId: string }>(publishedOwnershipPath(agent));
  assert.equal(record?.value.eventId, head.id);
  assert(!JSON.stringify(record).includes(proof[3]));

  const grant = { ownerPubkey: owner, issuer: adapter, grant: "fixture-existing" };
  await issueDesktopGrant(agent, key, f.state, async () => grant);
  const ref = await createHandoff([agent], f.state, Date.now() + 60_000);
  const [row] = (await (await f.post(ref, { step: "list" })).json()).agents;
  assert.equal(row.teams, "ready");
});

test("invitation, owner, identity, lease and expiry bind a desktop sign-in", async () => {
  const f = fixture(["one", "two"]);
  const one = f.agents.get("one")!, two = f.agents.get("two")!;
  const ref = await createHandoff([one], f.state, Date.now() + 60_000);
  assert.equal((await (await f.post(ref, { step: "list" })).json()).agents.length, 1);
  assert.equal((await f.post(ref, { step: "approve", ...f.proof(two) })).status, 403);
  const expired = await createHandoff([one], f.state, Date.now() - 10);
  assert.equal((await f.post(expired, { step: "list" })).status, 410);
  const row = f.proof(one);
  const start = await (await f.post(ref, { step: "start", callback, ...row })).json();
  const other = await createHandoff([one], f.state, Date.now() + 60_000);
  assert.equal((await f.post(other, { step: "finish", ...row, attempt: start.attempt, code: "code" })).status, 409);
  const finish = () => f.post(ref, { step: "finish", ...row, attempt: start.attempt, code: "code" });
  const concurrent = await Promise.all([finish(), finish()]);
  assert(concurrent.some(r => r.status === 200));
  assert.equal(f.issued.length, 1);
  assert.equal(f.exchanges(), 1);
  f.agents.set("one", { ...one, pubkey: two.pubkey });
  assert.equal((await (await f.post(ref, { step: "list" })).json()).agents.length, 0);
});

test("the desktop helper binds a real loopback port and delivers only its one-time callback", async () => {
  const page = "https://gateway.example.org/connect/return/";
  const source = await readFile("buzz-plugin/callback.cjs", "utf8");
  const proc = spawn(process.execPath, ["-e", source, "--", page], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  try {
    const [kind, address, receipt] = JSON.parse((await lines.next()).value!);
    assert.equal(kind, "ready");
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\/buzz\/[A-Za-z0-9_-]{32}$/);
    assert.equal((await fetch(new URL("/unrelated?code=local-test", address))).status, 404);
    const returned = await fetch(address + "?code=local-fixture", { redirect: "manual" });
    assert.equal(returned.status, 303);
    assert.match(receipt, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(returned.headers.get("location"), page + "#" + receipt);
    assert.equal(returned.headers.get("referrer-policy"), "no-referrer");
    assert.equal(returned.headers.get("cache-control"), "no-store");
    assert.equal(await returned.text(), "");
    assert.deepEqual(JSON.parse((await lines.next()).value!), ["code", "local-fixture"]);
  } finally { proc.kill(); }
});

test("a refused batch member can retry without replacing the other agent’s grant", async () => {
  const f = fixture(["first", "second"]);
  const agents = [...f.agents.values()];
  const selected = agents.map(f.proof);
  const ref = await createHandoff(agents, f.state, Date.now() + 60_000);
  const issue = f.services.enroll;
  f.services.enroll = async (...args) => {
    if (getPublicKey(Buffer.from(args[2], "hex")) === agents[1].pubkey) throw new Error("test refusal");
    return issue(...args);
  };
  async function complete() {
    const receipt = randomBytes(32).toString("base64url");
    const start = await (await f.post(ref, { step: "batch-start", callback, receipt, members: selected })).json();
    assert.equal((await f.post(receipt, { step: "list" })).status, 410);
    assert.equal((await f.post(ref, { step: "receipt" })).status, 410);
    const progress = await (await f.post(receipt, { step: "receipt" })).json();
    assert.equal(progress.agents[1].status, "pending");
    const response = await f.post(ref, { step: "batch-finish", attempt: start.attempt, code: "new-code", members: selected });
    const result = await (await f.post(receipt, { step: "receipt" })).json();
    assert.deepEqual(Object.keys(result.agents[0]).sort(), ["name", "picture", "status"]);
    assert.equal(result.agents[0].name, "first");
    assert.equal(result.agents[0].status, "approved");
    assert.equal(result.agents[1].status, response.status === 200 ? "approved" : "attention");
    return response;
  }
  const partial = await complete();
  assert.equal(partial.status, 409);
  assert.deepEqual((await partial.json()).pending, ["second"]);
  f.services.enroll = issue;
  assert.equal((await complete()).status, 200);
  assert.deepEqual(f.issued, agents.map(agent => agent.pubkey));
});
