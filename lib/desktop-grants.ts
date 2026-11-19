import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent } from "./config.ts";
import { hexId, stableId } from "./protocol.ts";
import type { State } from "./state.ts";

const grantSchema = z.object({ grant: z.string().min(1).max(1024), issuer: z.url(), ownerPubkey: hexId });
export type DesktopGrant = z.infer<typeof grantSchema>;
type Record = { sealed: { nonce: string; ciphertext: string; tag: string } } | { claim: string; until: number };

export class WaitingForOwner extends Error {}
export class ApprovalBusy extends Error {}

function binding(agent: Agent) {
  return stableId("buzz-desktop-grant-v1", agent.pubkey, agent.desktop!.ownerPubkey, agent.relayUrl,
    agent.federatedIdentityAdapter!, agent.credentialConnector!);
}
export function desktopGrantPath(agent: Agent) { return "desktop/grants/" + binding(agent) + ".json"; }
function encryptionKey(agent: Agent, secret: Uint8Array) {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(binding(agent), "hex"), "Buzz agent grant v1", 32));
}

export async function readDesktopGrant(agent: Agent, key: Uint8Array, state: State): Promise<DesktopGrant | undefined> {
  const record = (await state.read<Record>(desktopGrantPath(agent)))?.value;
  if (!record || !("sealed" in record)) return;
  const { nonce, ciphertext, tag } = record.sealed;
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(agent, key), Buffer.from(nonce, "base64url"));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  const clear = Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64url")), cipher.final()]);
  const issued = grantSchema.parse(JSON.parse(clear.toString("utf8")));
  if (issued.ownerPubkey !== agent.desktop!.ownerPubkey) throw new Error("Grant owner mismatch");
  return issued;
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
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(agent, key), nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(grant), "utf8"), cipher.final()]);
    const sealed = { nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url") };
    if (!await state.replace(path, { sealed }, held.etag)) throw new ApprovalBusy();
  } catch (error) {
    await state.replace(path, { ...claim, until: 0 }, held.etag).catch(() => false);
    throw error;
  }
}
