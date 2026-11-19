import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { loadAgents, type Agent } from "../lib/config.ts";
import { createHandoff, handleDesktop } from "../lib/desktop.ts";
import { desktopGrantPath, readDesktopGrant } from "../lib/desktop-grants.ts";
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
  const stored = JSON.stringify([...f.state.records.values()]);
  assert(!stored.includes("human-session-fixture") && !stored.includes("grant-for-") && !stored.includes(selected[0].proof[3]));
  assert(!JSON.stringify(listed).includes("signingKey") && !stored.includes(ref));
  await assert.rejects(readDesktopGrant(one, f.keys.get("two")!, f.state));
  assert.equal(await f.state.read(desktopGrantPath(f.agents.get("three")!)), null);
  f.services.usable = async () => false;
  assert.equal((await (await f.post(ref, { step: "list" })).json()).agents[0].unavailable, true);
  assert.equal((await f.post(ref, { step: "approve", ...selected[0] })).status, 409);
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
