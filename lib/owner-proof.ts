import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { z } from "zod";
import { hexId } from "./protocol.ts";

export const ownerProof = z.tuple([z.literal("auth"), hexId, z.string().max(2048), z.string().regex(/^[a-f0-9]{128}$/)]);
export type OwnerProof = z.infer<typeof ownerProof>;

// Buzz Desktop checks the owner, the agent key and each NIP-OA condition against the event.
export function ownerProofFor(pubkey: string, owner: string, candidate: unknown, kind: number, createdAt: number): OwnerProof | undefined {
  const parsed = ownerProof.safeParse(candidate);
  if (!parsed.success || owner === pubkey || parsed.data[1] !== owner) return;
  const proof = parsed.data;
  if (proof[2]) {
    for (const clause of proof[2].split("&")) {
      const match = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/.exec(clause);
      if (!match) return;
      const value = Number(match[2]);
      if (match[1] === "kind=") {
        if (value > 65535 || kind !== value) return;
      } else if (value > 4294967295 || (match[1] === "created_at<" ? createdAt >= value : createdAt <= value)) return;
    }
  }
  const message = createHash("sha256").update(`nostr:agent-auth:${pubkey}:${proof[2]}`).digest();
  try {
    if (schnorr.verify(Buffer.from(proof[3], "hex"), message, Buffer.from(owner, "hex"))) return proof;
  } catch { /* Out-of-range curve coordinates are invalid signatures. */ }
}

export function verifyOwner(pubkey: string, owner: string, proof: OwnerProof): boolean {
  return proof[2] === "" && Boolean(ownerProofFor(pubkey, owner, proof, 0, 0));
}
