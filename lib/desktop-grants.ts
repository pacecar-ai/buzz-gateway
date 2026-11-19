import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent } from "./config.ts";
import { ownerProofFor, type OwnerProof } from "./owner-proof.ts";
import { hexId, stableId } from "./protocol.ts";
import type { State } from "./state.ts";

const grantSchema = z.object({ grant: z.string().min(1).max(1024), issuer: z.url(), ownerPubkey: hexId });
export type DesktopGrant = z.infer<typeof grantSchema>;
type Sealed = { sealed: { nonce: string; ciphertext: string; tag: string } };
type Record = Sealed | { claim: string; until: number };

export class WaitingForOwner extends Error {}
export class ApprovalBusy extends Error {}

function binding(agent: Agent) {
  return stableId("buzz-desktop-grant-v1", agent.pubkey, agent.desktop!.ownerPubkey, agent.relayUrl,
    agent.federatedIdentityAdapter!, agent.credentialConnector!);
}
export function desktopGrantPath(agent: Agent) { return "desktop/grants/" + binding(agent) + ".json"; }
function ownershipPath(agent: Agent) { return "desktop/ownership/" + binding(agent) + ".json"; }
export function publishedOwnershipPath(agent: Agent) { return "desktop/profiles/" + binding(agent) + ".json"; }
function encryptionKey(agent: Agent, secret: Uint8Array, purpose: "grant" | "ownership") {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(binding(agent), "hex"), "Buzz agent " + purpose + " v1", 32));
}

function open(record: Sealed, key: Buffer): unknown {
  const { nonce, ciphertext, tag } = record.sealed;
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  const clear = Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64url")), cipher.final()]);
  return JSON.parse(clear.toString("utf8"));
}

function seal(value: unknown, key: Buffer): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { sealed: { nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url") } };
}

export async function readDesktopGrant(agent: Agent, key: Uint8Array, state: State): Promise<DesktopGrant | undefined> {
  const record = (await state.read<Record>(desktopGrantPath(agent)))?.value;
  if (!record || !("sealed" in record)) return;
  const issued = grantSchema.parse(open(record, encryptionKey(agent, key, "grant")));
  if (issued.ownerPubkey !== agent.desktop!.ownerPubkey) throw new Error("Grant owner mismatch");
  return issued;
}

export async function readDesktopOwnership(agent: Agent, key: Uint8Array, state: State): Promise<OwnerProof | undefined> {
  const record = await state.read<Sealed>(ownershipPath(agent));
  if (!record) return;
  return ownerProofFor(agent.pubkey, agent.desktop!.ownerPubkey, open(record.value, encryptionKey(agent, key, "ownership")),
    0, Math.floor(Date.now() / 1000));
}

// The proof also belongs to installations whose existing grant lives in Connect. Keep it separately
// so repairing a profile never replaces a grant and never changes where the grant is resolved.
export async function saveDesktopOwnership(agent: Agent, key: Uint8Array, state: State, proof: OwnerProof): Promise<OwnerProof> {
  const now = Math.floor(Date.now() / 1000);
  const owner = agent.desktop!.ownerPubkey;
  if (!ownerProofFor(agent.pubkey, owner, proof, 0, now)) throw new Error("Invalid agent profile ownership proof");
  const path = ownershipPath(agent);
  const secret = encryptionKey(agent, key, "ownership");
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await state.read<Sealed>(path);
    const existing = current && ownerProofFor(agent.pubkey, owner, open(current.value, secret), 0, now);
    if (existing && (existing[2] === "" || existing[2] === proof[2])) return existing;
    const next = seal(proof, secret);
    if (current ? await state.replace(path, next, current.etag) : await state.create(path, next)) return proof;
  }
  throw new ApprovalBusy();
}

// A second exchange would invalidate the first grant. Elect one writer before contacting the issuer.
export async function issueDesktopGrant(agent: Agent, key: Uint8Array, state: State, issue: () => Promise<DesktopGrant>) {
  const path = desktopGrantPath(agent);
  const current = await state.read<Record>(path);
  if (current && "sealed" in current.value) {
    await readDesktopGrant(agent, key, state);
    return;
  }
  if (current && "until" in current.value && current.value.until > Date.now()) throw new ApprovalBusy();
  const claim = { claim: randomUUID(), until: Date.now() + 90_000 };
  const won = current ? await state.replace(path, claim, current.etag) : await state.create(path, claim);
  if (!won) throw new ApprovalBusy();
  const held = await state.read<typeof claim>(path);
  if (held?.value.claim !== claim.claim) throw new ApprovalBusy();
  try {
    const grant = grantSchema.parse(await issue());
    if (grant.ownerPubkey !== agent.desktop!.ownerPubkey) throw new Error("Grant owner mismatch");
    if (!await state.replace(path, seal(grant, encryptionKey(agent, key, "grant")), held.etag)) throw new ApprovalBusy();
  } catch (error) {
    await state.replace(path, { ...claim, until: 0 }, held.etag).catch(() => false);
    throw error;
  }
}
