import type { Event } from "nostr-tools/pure";
import { verifiedEvent } from "./buzz.ts";
import type { BuzzSocket } from "./buzz-socket.ts";
import { publishedOwnershipPath } from "./desktop-grants.ts";
import { ownerProofFor, type OwnerProof } from "./owner-proof.ts";
import { stableId } from "./protocol.ts";
import type { State } from "./state.ts";

type ProfileSocket = Pick<BuzzSocket, "agent" | "signer" | "query" | "publish">;
type Profile = { name: string; description?: string; picture?: string };
export type PublishedProfile = { fingerprint: string; attested: boolean };

function reusableProfileProof(event: Event, pubkey: string, owner: string, now: number): OwnerProof | undefined {
  if (event.pubkey !== pubkey || !verifiedEvent(event)) return;
  const proofs = event.tags.filter(tag => tag[0] === "auth");
  if (proofs.length !== 1 || !ownerProofFor(pubkey, owner, proofs[0], event.kind, event.created_at)) return;
  return ownerProofFor(pubkey, owner, proofs[0], 0, now);
}

export async function publishAgentProfile(socket: ProfileSocket, state: State, profile: Profile,
  previous?: PublishedProfile): Promise<PublishedProfile> {
  const { agent, signer } = socket;
  const ownership = signer.profileOwnership;
  const now = Math.floor(Date.now() / 1000);
  let proof = ownership && ownerProofFor(agent.pubkey, ownership.owner, ownership.proof, 0, now);
  if (agent.desktop && ownership && !proof && !previous) {
    // An older connector can already have an owner-attested public profile. Read it before replacing it.
    const filters = [{ kinds: [0, 10100], limit: 2 }, { kinds: [1, 10002], limit: 16 }];
    for (const filter of filters) {
      const query = { ...filter, authors: [agent.pubkey], consistency: "strong" };
      // Some communities only offer profile discovery. Earlier public notes are an additional source.
      const events = filter.kinds.includes(0) ? await socket.query(query) : await socket.query(query).catch(() => []);
      for (const event of events) {
        if (!filter.kinds.includes(event.kind)) continue;
        const existing = reusableProfileProof(event, agent.pubkey, ownership.owner, now);
        if (existing) {
          proof = ownership.save ? await ownership.save(existing) : existing;
          ownership.proof = proof;
          break;
        }
      }
      if (proof) break;
    }
  }
  const content = JSON.stringify({ name: profile.name, display_name: profile.name, about: profile.description, picture: profile.picture });
  const fingerprint = stableId(content, ...(proof ?? []));
  if (previous?.fingerprint === fingerprint) return previous;
  await socket.publish(signer.sign({ kind: 0, tags: proof ? [proof] : [], content, created_at: now }));
  await socket.publish(signer.sign({ kind: 10100, tags: [], content, created_at: now }));
  if (agent.desktop && proof) {
    const filter = { kinds: [0], authors: [agent.pubkey], limit: 1, consistency: "strong" };
    const [head, ...extra] = await socket.query(filter);
    if (!head || extra.length || head.kind !== 0 || head.content !== content
      || !reusableProfileProof(head, agent.pubkey, agent.desktop.ownerPubkey, now)) {
      throw new Error("Buzz has not confirmed the owner-attested profile");
    }
    await state.write(publishedOwnershipPath(agent), { proofDigest: stableId(...proof), eventId: head.id });
  }
  return { fingerprint, attested: Boolean(proof) };
}
