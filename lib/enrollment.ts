import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { z } from "zod";
import { nostrAuthorization } from "./credentials.ts";
import { ownerProof, ownerProofFor } from "./owner-proof.ts";
import { hexId } from "./protocol.ts";

const grantType = "urn:nostr:params:oauth:token-type:nip-fi-agent-grant";
const expiry = z.iso.datetime({ offset: true });
const session = z.object({ session_token: z.string().min(1).max(2048), expires_at: expiry });
export { ownerProof };
const agentGrant = z.object({
  access_token: z.string().regex(/^\S+$/).max(1024),
  issued_token_type: z.literal(grantType),
  token_type: z.literal("N_A"),
  nostr_owner_pubkey: hexId,
  nip_fi_issuer: z.url(),
});

export class EnrollmentRefused extends Error {
  readonly status: number;
  readonly step: string;

  constructor(status: number, step: string) {
    super(`Buzz enrollment ${step} failed (${status})`);
    this.name = "EnrollmentRefused";
    this.status = status;
    this.step = step;
  }
}

export function loginUrl(adapter: string, callback: string, handoffSecret: string): string {
  const url = new URL(endpoint(adapter, "login/start"));
  url.search = new URLSearchParams({
    return_to: callback,
    handoff_challenge: createHash("sha256").update(handoffSecret).digest("base64url"),
    handoff_challenge_method: "S256",
  }).toString();
  return url.href;
}

export async function exchangeLogin(adapter: string, code: string, handoffSecret: string): Promise<string> {
  const issued = session.parse(await send(adapter, "login/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, handoff_secret: handoffSecret }),
  }));
  const checked = z.object({ expires_at: expiry }).parse(await send(adapter, "session", {
    headers: { authorization: `Bearer ${issued.session_token}` },
  }));
  if (Date.parse(issued.expires_at) !== Date.parse(checked.expires_at) || Date.parse(checked.expires_at) <= Date.now()) {
    throw new EnrollmentRefused(401, "session");
  }
  return issued.session_token;
}

export async function enrollAgent(adapter: string, userSession: string, signingKey: string, proof: z.infer<typeof ownerProof>) {
  const key = Buffer.from(hexId.parse(signingKey), "hex");
  const pubkey = getPublicKey(key);
  const route = "nip-fi/agent-grant";
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: userSession,
    subject_token_type: "urn:nostr:params:oauth:token-type:nip-fa-session",
    requested_token_type: grantType,
    agent_pubkey: pubkey,
    owner_attestation: JSON.stringify(proof),
  }).toString();
  const grant = agentGrant.parse(await send(adapter, route, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "nostr-authorization": nostrAuthorization(endpoint(adapter, route), body, template => finalizeEvent(template, key)),
    },
    body,
  }));
  if (grant.nostr_owner_pubkey !== proof[1] || grant.nostr_owner_pubkey === pubkey) throw new EnrollmentRefused(403, route);
  const profileProof = ownerProofFor(pubkey, grant.nostr_owner_pubkey, proof, 0, Math.floor(Date.now() / 1000));
  return { grant: grant.access_token, issuer: grant.nip_fi_issuer, ownerPubkey: grant.nostr_owner_pubkey,
    ...(profileProof && { ownerAttestation: profileProof }) };
}

function endpoint(adapter: string, name: string): string {
  return `${adapter.replace(/\/$/, "")}/v1/${name}`;
}

async function send(adapter: string, name: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(endpoint(adapter, name), { ...init, redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new EnrollmentRefused(response.status, name);
  return response.json();
}
