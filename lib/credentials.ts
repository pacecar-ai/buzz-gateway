import { createHash, randomBytes } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { decode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { z } from "zod";
import type { Agent } from "./config.ts";
import { readDesktopGrant, readDesktopOwnership, saveDesktopOwnership, WaitingForOwner } from "./desktop-grants.ts";
import { ownerProof, ownerProofFor, type OwnerProof } from "./owner-proof.ts";
import type { State } from "./state.ts";
import { hexId } from "./protocol.ts";

const federatedGrant = z.object({
  grant: z.string().regex(/^\S+$/).max(1024),
  issuer: z.url(),
  ownerPubkey: hexId,
  ownerAttestation: ownerProof.optional(),
});
const credentials = z.object({
  signingKey: z.string().trim().min(1).max(128),
  actionKey: z.string().optional(),
  ownerAttestation: ownerProof.optional(),
  federated: federatedGrant.optional(),
});
const issued = z.object({
  assertion: z.string().max(8192).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
  nostr_pubkey: hexId,
  expires_at: z.number().int(),
});

export type Signer = {
  sign(template: EventTemplate): Event;
  ownerTag?: string[];
  assertion?: { token: string; expiresAt: number };
  profileOwnership?: {
    owner: string;
    proof?: OwnerProof;
    read?: () => Promise<OwnerProof | undefined>;
    save?: (proof: OwnerProof) => Promise<OwnerProof>;
  };
};

export function credentialProfileProof(agent: Agent, owner: string, credential: z.infer<typeof credentials>): OwnerProof | undefined {
  const now = Math.floor(Date.now() / 1000);
  return ownerProofFor(agent.pubkey, owner, credential.ownerAttestation, 0, now)
    ?? ownerProofFor(agent.pubkey, owner, credential.federated?.ownerAttestation, 0, now);
}

export class CredentialRefusedError extends Error {
  constructor() {
    super("The Buzz identity issuer refused this installation");
    this.name = "CredentialRefusedError";
  }
}

export async function loadSigner(agent: Agent, state?: State): Promise<Signer> {
  const credential = agent.credentialConnector
    ? await fromConnect(agent.credentialConnector)
    : credentials.parse({
      signingKey: process.env[agent.signingKeyEnv ?? ""],
      ownerAttestation: agent.ownerAttestationEnv
        ? JSON.parse(process.env[agent.ownerAttestationEnv] ?? "null")
        : undefined,
    });
  const secret = signingKey(credential.signingKey, agent.pubkey);
  const sign = (template: EventTemplate) => finalizeEvent(template, secret);
  if (agent.federatedIdentityAdapter) {
    const grant = credential.federated ?? (agent.desktop && state ? await readDesktopGrant(agent, secret, state) : undefined);
    if (!grant && agent.desktop) throw new WaitingForOwner();
    if (!grant || (agent.desktop && grant.ownerPubkey !== agent.desktop.ownerPubkey)) throw new CredentialRefusedError();
    const assertion = await requestAssertion(agent, agent.federatedIdentityAdapter, grant, sign);
    const proof = credentialProfileProof(agent, grant.ownerPubkey, credential);
    const stored = agent.desktop && state ? {
      read: () => readDesktopOwnership(agent, secret, state),
      save: (proof: OwnerProof) => saveDesktopOwnership(agent, secret, state, proof),
    } : undefined;
    return { sign, assertion, profileOwnership: { owner: grant.ownerPubkey, proof: proof ?? await stored?.read(), ...stored } };
  }
  if (credential.federated) throw new CredentialRefusedError();
  const tag = credential.ownerAttestation;
  return { sign, ownerTag: tag, profileOwnership: tag && { owner: tag[1], proof: credentialProfileProof(agent, tag[1], credential) } };
}

export async function fromConnect(connector: string): Promise<z.infer<typeof credentials>> {
  const response = await fetch(`https://api.vercel.com/v1/connect/token/${encodeURIComponent(connector)}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${await getVercelOidcToken()}`,
    },
    body: JSON.stringify({ subject: { type: "app" } }),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Vercel Connect could not resolve the Buzz credential");
  const { token } = z.object({ token: z.string().max(8192) }).parse(await response.json());
  return credentials.parse(JSON.parse(token));
}

export function signingKey(raw: string, pubkey: string): Uint8Array {
  let secret: Uint8Array;
  if (hexId.safeParse(raw).success) secret = Buffer.from(raw, "hex");
  else {
    const decoded = decode(raw as `nsec1${string}`);
    if (decoded.type !== "nsec") throw new Error("Invalid Buzz signing key");
    secret = decoded.data;
  }
  if (getPublicKey(secret) !== pubkey) throw new Error("Buzz signing key does not match the registration");
  return secret;
}

export async function requestAssertion(
  agent: Agent,
  adapter: string,
  credential: z.infer<typeof federatedGrant>,
  sign: Signer["sign"],
): Promise<NonNullable<Signer["assertion"]>> {
  const endpoint = `${adapter.replace(/\/$/, "")}/v1/nip-fi/agent-assertion`;
  const relay = new URL(agent.relayUrl);
  const body = JSON.stringify({ nostr_pubkey: agent.pubkey, relay_url: relay.origin });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.grant}`,
      "nostr-authorization": nostrAuthorization(endpoint, body, sign),
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(8000),
    redirect: "manual",
  });
  if (response.status === 429 || response.status >= 500) throw new Error("Buzz assertion issuance is temporarily unavailable");
  if (!response.ok) throw new CredentialRefusedError();
  try {
    const result = issued.parse(await response.json());
    const claims = decodeJwt(result.assertion);
    const now = Math.floor(Date.now() / 1000);
    // The relay verifies the assertion signature. Check its bindings before sending it.
    if (decodeProtectedHeader(result.assertion).typ !== "nip-fi-agent+jwt"
      || result.nostr_pubkey !== agent.pubkey || claims.nostr_pubkey !== agent.pubkey
      || claims.nostr_owner_pubkey !== credential.ownerPubkey || claims.iss !== credential.issuer
      || claims.aud !== `https://${relay.host}` || claims.exp !== result.expires_at
      || typeof claims.iat !== "number" || claims.iat > now + 30 || claims.iat >= result.expires_at
      || result.expires_at <= now + 5) throw new CredentialRefusedError();
    return { token: result.assertion, expiresAt: result.expires_at * 1000 };
  } catch {
    throw new CredentialRefusedError();
  }
}

export function nostrAuthorization(endpoint: string, body: string, sign: Signer["sign"]): string {
  const proof = sign({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", endpoint], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")],
      ["nonce", randomBytes(16).toString("hex")],
    ],
    content: "",
  });
  return `Nostr ${Buffer.from(JSON.stringify(proof)).toString("base64")}`;
}
