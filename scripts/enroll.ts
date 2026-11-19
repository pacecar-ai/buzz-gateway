import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { z } from "zod";
import { nostrAuthorization } from "../lib/credentials.ts";
import { hexId, registrationId } from "../lib/protocol.ts";

const grantType = "urn:nostr:params:oauth:token-type:nip-fi-agent-grant";
const sessionSchema = z.object({ session_token: z.string().min(1).max(2048), expires_at: z.iso.datetime({ offset: true }) });
const proofSchema = z.tuple([z.literal("auth"), hexId, z.string().max(2048), z.string().regex(/^[a-f0-9]{128}$/)]);
const grantSchema = z.object({
  access_token: z.string().regex(/^\S+$/).max(1024),
  issued_token_type: z.literal(grantType),
  token_type: z.literal("N_A"),
  nostr_owner_pubkey: hexId,
  nip_fi_issuer: z.url(),
});
const [baseUrl, ...ids] = process.argv.slice(2);
const adapter = z.url().safeParse(baseUrl);
if (!adapter.success || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length
  || ids.some(id => !registrationId.safeParse(id).success)) {
  console.error("Usage: node scripts/enroll.ts https://issuer.example/adapter agent-id [agent-id ...]");
  process.exit(1);
}
const base = new URL(adapter.data);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
  console.error("Use the HTTPS base URL of your Buzz identity adapter.");
  process.exit(1);
}

const agents = ids.map(id => {
  const key = generateSecretKey();
  return { id, key, pubkey: getPublicKey(key), complete: false };
});
const folder = await mkdtemp(join(tmpdir(), "buzz-gateway-enrollment-"));
const secret = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(secret).digest("base64url");
const path = `/install/${randomBytes(24).toString("base64url")}`;
let origin: string;
let session: z.infer<typeof sessionSchema> | undefined;
let busy = false;
const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
  void handle(request, response).catch(() => {
    page(response, 400, '<p>Enrollment could not finish. Verify the proof and sign-in, then <a href="'.concat(path, '">try again</a>.</p>'));
  });
});
await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not open the local enrollment page");
origin = `http://127.0.0.1:${address.port}`;
console.log(`Open ${origin}${path} in your browser to authorize the Buzz agents.`);
console.log(`Connect input files will be written to ${folder}.`);
const expiry = setTimeout(() => server.close(), 30 * 60 * 1000);
server.once("close", () => clearTimeout(expiry));

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin);
  if (request.headers.host !== new URL(origin).host || url.origin !== origin) {
    page(response, 404, "<p>Unknown installation page.</p>");
    return;
  }
  if (request.method === "GET" && url.pathname === `${path}/return`) {
    const code = z.string().min(1).max(2048).parse(url.searchParams.get("code"));
    const next = sessionSchema.parse(await send("login/exchange", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, handoff_secret: secret }),
    }));
    const info = z.object({ expires_at: z.iso.datetime({ offset: true }) }).parse(await send("session", {
      headers: { authorization: `Bearer ${next.session_token}` },
    }));
    if (Date.parse(info.expires_at) !== Date.parse(next.expires_at) || Date.parse(next.expires_at) <= Date.now()) throw new Error();
    session = next;
    response.writeHead(303, { location: path, "referrer-policy": "no-referrer", "cache-control": "no-store" }).end();
    return;
  }
  if (url.pathname !== path) {
    page(response, 404, "<p>Unknown installation page.</p>");
    return;
  }
  if (request.method === "GET") {
    const login = new URL(endpoint("login/start"));
    login.search = new URLSearchParams({
      return_to: `${origin}${path}/return`, handoff_challenge: challenge, handoff_challenge_method: "S256",
    }).toString();
    const fields = agents.map(agent => `<p><strong>${agent.id}</strong> <code>${agent.pubkey}</code></p>
      ${agent.complete ? "<p>Grant issued.</p>" : `<label>Ownership proof for ${agent.id} <input name="${agent.id}" type="password" autocomplete="off" required></label>`}`).join("");
    const body = session
      ? `<p>In Buzz Desktop, open Settings → Buzz → Security → Authorize external identity. Authorize each public key and paste its proof below.</p><form method="post">${fields}<p><button>Create agent grants</button></p></form>`
      : `<p>Sign in with the account linked to your Buzz identity.</p><p><a href="${login.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Sign in</a></p>`;
    page(response, 200, body);
    return;
  }
  if (request.method !== "POST" || request.headers.origin !== origin || !session || busy) {
    page(response, 403, "<p>Sign in on this browser before creating the agent grants.</p>");
    return;
  }
  busy = true;
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 65_536) throw new Error();
    }
    const form = new URLSearchParams(body);
    const pending = agents.filter(agent => !agent.complete).map(agent => ({
      agent, proof: proofSchema.parse(JSON.parse(form.get(agent.id) ?? "null")),
    }));
    for (const { agent, proof } of pending) {
      const target = "nip-fi/agent-grant";
      const grantBody = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: session.session_token,
        subject_token_type: "urn:nostr:params:oauth:token-type:nip-fa-session",
        requested_token_type: grantType,
        agent_pubkey: agent.pubkey,
        owner_attestation: JSON.stringify(proof),
      }).toString();
      const grant = grantSchema.parse(await send(target, { method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded",
        "nostr-authorization": nostrAuthorization(endpoint(target), grantBody, template => finalizeEvent(template, agent.key)),
      }, body: grantBody }));
      if (grant.nostr_owner_pubkey !== proof[1] || grant.nostr_owner_pubkey === agent.pubkey) throw new Error();
      const credential = {
        signingKey: Buffer.from(agent.key).toString("hex"),
        federated: { grant: grant.access_token, issuer: grant.nip_fi_issuer, ownerPubkey: grant.nostr_owner_pubkey },
      };
      await writeFile(join(folder, `${agent.id}.json`), JSON.stringify({
        values: [{ key: "apiKey", value: JSON.stringify(credential) }],
      }), { mode: 0o600, flag: "wx" });
      agent.complete = true;
      console.log(`Grant issued for ${agent.id} (${agent.pubkey}).`);
    }
    page(response, 200, "<p>Agent grants created. Return to the terminal to link them to the gateway.</p>");
    server.close();
  } finally {
    busy = false;
  }
}

function endpoint(name: string): string {
  return `${base.href.replace(/\/$/, "")}/v1/${name}`;
}

async function send(name: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(endpoint(name), { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    console.error(`Buzz identity request failed with HTTP ${response.status}.`);
    throw new Error("Buzz identity request failed");
  }
  return response.json();
}

function page(response: ServerResponse, status: number, content: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Install Buzz agents</title><main><h1>Install Buzz agents</h1>${content}</main></html>`);
}
