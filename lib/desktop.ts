import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";
import { z } from "zod";
import type { Agent } from "./config.ts";
import { readConnectProfile } from "./connect-profile.ts";
import { credentialProfileProof, CredentialRefusedError, fromConnect, requestAssertion, signingKey } from "./credentials.ts";
import { ApprovalBusy, desktopGrantPath, issueDesktopGrant, publishedOwnershipPath, readDesktopGrant, readDesktopOwnership,
  saveDesktopOwnership, type DesktopGrant } from "./desktop-grants.ts";
import { enrollAgent, exchangeLogin, loginUrl, ownerProof } from "./enrollment.ts";
import { errorName, log } from "./log.ts";
import { verifyOwner } from "./owner-proof.ts";
import { healthPath, hexId, readJson, registrationId, stableId } from "./protocol.ts";
import type { State } from "./state.ts";

export const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
type Invitation = { owner: string; community: string; members: { id: string; pubkey: string; binding: string }[]; expiresAt: number };
type Attempt = { member: string; handoff: string; verifier: string; expiresAt: number; hasReceipt?: boolean };
type Receipt = {
  attemptPath: string;
  signInExpiresAt: number;
  expiresAt: number;
  agents: { name: string; picture?: string; grantPath?: string }[];
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const handle = () => randomBytes(32).toString("base64url");
const binding = (agent: Agent) => digest(JSON.stringify([agent.namespace, agent.credentialConnector, agent.federatedIdentityAdapter, agent.desktop]));
const pathFor = (kind: string, key: string) => "desktop/" + kind + "/" + digest(key) + ".json";
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

async function readReceipt(token: string, state: State) {
  const receipt = (await state.read<Receipt>(pathFor("receipts", token)))?.value;
  if (!receipt || receipt.expiresAt <= Date.now()) return reply({ error: "Open Buzz to check this approval." }, 410);
  const attempt = await state.read<{ finished?: boolean }>(receipt.attemptPath);
  const ended = attempt?.value.finished || receipt.signInExpiresAt <= Date.now();
  const agents = await Promise.all(receipt.agents.map(async ({ name, picture, grantPath }) => {
    // A sealed grant is written only after the issuer confirms this exact agent and owner.
    const granted = !grantPath || Boolean((await state.read<{ sealed?: unknown }>(grantPath))?.value.sealed);
    return { name, picture, status: granted ? "approved" : ended ? "attention" : "pending" };
  }));
  return reply({ agents });
}

export async function createHandoff(agents: Agent[], state: State, expiresAt: number) {
  const first = agents[0];
  if (!first?.desktop || agents.some(agent => agent.desktop?.ownerPubkey !== first.desktop?.ownerPubkey
    || agent.relayUrl !== first.relayUrl)) throw new Error("An invitation covers one owner and community");
  const token = handle();
  const invite: Invitation = { owner: first.desktop.ownerPubkey, community: new URL(first.relayUrl).origin,
    members: agents.map(agent => ({ id: agent.id, pubkey: agent.pubkey, binding: binding(agent) })), expiresAt };
  if (!await state.create(pathFor("invitations", token), invite, Math.max(1, Math.ceil((expiresAt - Date.now()) / 86_400_000)))) {
    throw new Error("Could not create the invitation");
  }
  return token;
}

function localCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) >= 1024
      && /^\/buzz\/[A-Za-z0-9_-]{32}$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
const base = z.object({ owner: hexId, community: z.string().max(512) });
const selected = z.object({ id: registrationId, pubkey: hexId, proof: ownerProof });
const browserReturn = { callback: z.string().max(256).refine(localCallback), receipt: opaque.optional() };
const member = base.extend(selected.shape);
const multiple = base.extend({ members: z.array(selected).min(1).max(8).refine(rows =>
  new Set(rows.map(row => row.id)).size === rows.length) });
const input = z.discriminatedUnion("step", [
  base.extend({ step: z.literal("list") }),
  multiple.extend({ step: z.literal("teams") }),
  multiple.extend({ step: z.literal("batch-approve") }),
  multiple.extend({ step: z.literal("batch-start"), ...browserReturn }),
  multiple.extend({ step: z.literal("batch-finish"), attempt: opaque, code: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/) }),
  member.extend({ step: z.literal("approve") }),
  member.extend({ step: z.literal("start"), ...browserReturn }),
  member.extend({ step: z.literal("finish"), attempt: opaque, code: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/) }),
]);

const providers = { profile: readConnectProfile, credential: fromConnect, exchange: exchangeLogin, enroll: enrollAgent,
  async usable(agent: Agent, key: Uint8Array, grant: DesktopGrant) {
    try {
      await requestAssertion(agent, agent.federatedIdentityAdapter!, grant, template => finalizeEvent(template, key));
      return true;
    } catch (error) {
      if (error instanceof CredentialRefusedError) return false;
      throw error;
    }
  },
};

export async function handleDesktop(request: Request, agents: Map<string, Agent>, state: State, services = providers,
  operatorDigest = process.env.BUZZ_GATEWAY_DESKTOP_OPERATOR_SHA256) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
  try {
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return reply({ error: "Open your Vercel invitation." }, 403);
    const raw = await readJson(request).catch(() => null);
    if (z.object({ step: z.literal("receipt") }).safeParse(raw).success) return await readReceipt(token, state);
    const issuance = z.object({ step: z.literal("invite"), id: registrationId, all: z.boolean().default(false) }).safeParse(raw);
    if (issuance.success) {
      if (!hexId.safeParse(operatorDigest).success || !timingSafeEqual(Buffer.from(digest(token), "hex"),
        Buffer.from(operatorDigest!, "hex"))) return reply({ error: "An operator is required to issue invitations." }, 403);
      const first = agents.get(issuance.data.id);
      if (!first?.desktop) return reply({ error: "Configure this agent for desktop setup first." }, 409);
      const members = issuance.data.all ? [...agents.values()].filter(agent => agent.desktop?.ownerPubkey === first.desktop!.ownerPubkey
        && agent.relayUrl === first.relayUrl) : [first];
      const expiresAt = Date.now() + 7 * 86_400_000;
      const invitation = await createHandoff(members, state, expiresAt);
      log("info", "buzz_desktop_invitation_issued", { registrationId: first.id, registrations: members.length });
      return reply({ path: "/connect/#" + invitation, expiresAt });
    }
    const invite = (await state.read<Invitation>(pathFor("invitations", token)))?.value;
    if (!invite || invite.expiresAt <= Date.now()) return reply({ error: "This invitation expired. Open a fresh Vercel invitation." }, 410);
    const parsed = input.safeParse(raw);
    if (!parsed.success) return reply({ error: "Buzz could not read this setup request." }, 400);
    const body = parsed.data;
    if (body.owner !== invite.owner || body.community !== invite.community) {
      return reply({ error: "Switch to the Buzz account and community that received this invitation." }, 403);
    }
    const members = invite.members.flatMap(member => {
      const agent = agents.get(member.id);
      return agent?.desktop?.ownerPubkey === invite.owner && new URL(agent.relayUrl).origin === invite.community
        && member.binding === binding(agent) && agent.pubkey === member.pubkey ? [agent] : [];
    });
    if (body.step === "list") {
      const heart = (await state.read<{ at: number; online?: string[] }>(healthPath))?.value;
      const rows = await Promise.all(members.map(async agent => {
        const connector = agent.credentialConnector!;
        const identity = { id: agent.id, pubkey: agent.pubkey,
          manageUrl: "https://vercel.com/" + agent.eveProject.teamSlug + "/" + agent.desktop!.projectSlug + "/connect/" + connector };
        let profile: { name: string; picture?: string } = { name: agent.id };
        try {
          profile = await services.profile(connector);
          const credential = await services.credential(connector);
          const key = signingKey(credential.signingKey, agent.pubkey);
          const grant = credential.federated ?? await readDesktopGrant(agent, key, state);
          if (grant && grant.ownerPubkey !== invite.owner) throw new Error("Connector owner changed");
          const online = Boolean(heart && Date.now() - heart.at < 180_000 && heart.online?.includes(agent.id));
          const unavailable = Boolean(grant && !online && !await services.usable(agent, key, grant));
          let teams: "needs-approval" | "syncing" | "ready" | undefined;
          if (grant && !unavailable) {
            const proof = credentialProfileProof(agent, invite.owner, credential) ?? await readDesktopOwnership(agent, key, state);
            const published = proof && await state.read<{ proofDigest: string }>(publishedOwnershipPath(agent));
            teams = !proof ? "needs-approval" : published?.value.proofDigest === stableId(...proof) ? "ready" : "syncing";
          }
          return { ...identity, ...profile, approved: Boolean(grant) && !unavailable, online, unavailable, teams };
        } catch (error) {
          log("warn", "buzz_desktop_connector_unavailable", { registrationId: agent.id, error: errorName(error) });
          return { ...identity, ...profile, approved: false, online: false, unavailable: true, retry: true };
        }
      }));
      return reply({ agents: rows, expiresAt: invite.expiresAt });
    }
    const requested = "members" in body ? body.members : [body];
    const approvedKeys = [];
    for (const row of requested) {
      const agent = members.find(agent => agent.id === row.id && agent.pubkey === row.pubkey);
      if (!agent || !verifyOwner(agent.pubkey, invite.owner, row.proof)) {
        return reply({ error: "Buzz needs approval from the owner of each selected agent." }, 403);
      }
      approvedKeys.push({ agent, proof: row.proof });
    }
    const adapter = approvedKeys[0].agent.federatedIdentityAdapter!;
    if (approvedKeys.some(row => row.agent.federatedIdentityAdapter !== adapter)) {
      return reply({ error: "Connect agents with different identity providers separately." }, 400);
    }
    const jobs = await Promise.all(approvedKeys.map(async row => {
      const credential = await services.credential(row.agent.credentialConnector!);
      const key = signingKey(credential.signingKey, row.agent.pubkey);
      const grant = credential.federated ?? await readDesktopGrant(row.agent, key, state);
      if (grant && grant.ownerPubkey !== invite.owner) throw new Error("Connector owner changed");
      const usable = !grant || await services.usable(row.agent, key, grant);
      return { ...row, key, approved: Boolean(grant), usable };
    }));
    if (jobs.some(job => !job.usable)) return reply({ error: "Buzz declined an existing grant. Ask the gateway owner to renew that connector." }, 409);
    const pending = jobs.filter(job => !job.approved);
    if (body.step === "teams" && pending.length) return reply({ error: "Connect these agents to Buzz before enabling teams." }, 409);
    await Promise.all(jobs.filter(job => job.approved).map(job => saveDesktopOwnership(job.agent, job.key, state, job.proof)));
    if (body.step === "teams" || !pending.length) return reply({ approved: true });
    if (body.step === "approve" || body.step === "batch-approve") return reply({ approved: false });
    const selection = digest(JSON.stringify(jobs.map(job => binding(job.agent)).sort()));
    if (body.step === "start" || body.step === "batch-start") {
      const attempt = handle();
      const session: Attempt = { member: selection, handoff: digest(token), verifier: handle(),
        expiresAt: Math.min(invite.expiresAt, Date.now() + 5 * 60_000) };
      const attemptPath = pathFor("attempts", attempt);
      if (body.receipt) {
        if (token === body.receipt) return reply({ error: "Restart sign-in in Buzz." }, 400);
        const rows = await Promise.all(jobs.map(async ({ agent, approved }) => {
          const profile = await services.profile(agent.credentialConnector!).catch(() => ({ name: agent.id }));
          return { ...profile, ...(approved ? {} : { grantPath: desktopGrantPath(agent) }) };
        }));
        const receipt: Receipt = { attemptPath, agents: rows, signInExpiresAt: session.expiresAt,
          expiresAt: Math.min(invite.expiresAt, Date.now() + 10 * 60_000) };
        if (!await state.create(pathFor("receipts", body.receipt), receipt, 1)) return reply({ error: "Restart sign-in in Buzz." }, 409);
        session.hasReceipt = true;
      }
      if (!await state.create(attemptPath, session, 1)) throw new Error("Could not start sign-in");
      return reply({ attempt, url: loginUrl(adapter, body.callback, session.verifier) });
    }
    const path = pathFor("attempts", body.attempt);
    const attempt = await state.read<Attempt>(path);
    if (!attempt || attempt.value.expiresAt <= Date.now() || attempt.value.member !== selection
      || attempt.value.handoff !== digest(token) || !await state.replace(path, { used: true }, attempt.etag, 1)) {
      return reply({ error: "This sign-in expired. Try again in Buzz." }, 409);
    }
    // The human session exists for this request only. Each opted-in agent gets its own grant.
    let results;
    try {
      const session = await services.exchange(adapter, body.code, attempt.value.verifier);
      results = await Promise.allSettled(pending.map(async job => {
        await issueDesktopGrant(job.agent, job.key, state, () =>
          services.enroll(adapter, session, Buffer.from(job.key).toString("hex"), job.proof));
        await saveDesktopOwnership(job.agent, job.key, state, job.proof);
        log("info", "buzz_desktop_authorized", { registrationId: job.agent.id });
      }));
    } finally {
      if (attempt.value.hasReceipt) await state.write(path, { used: true, finished: true }, 1)
        .catch(error => log("warn", "buzz_desktop_receipt_update_failed", { error: errorName(error) }));
    }
    const failed = pending.filter((_, index) => results[index].status === "rejected").map(job => job.agent.id);
    if (failed.length) {
      for (const result of results) if (result.status === "rejected") {
        log("warn", "buzz_desktop_grant_failed", { error: errorName(result.reason) });
      }
      return reply({ error: "Approval is still pending for " + failed.join(", ") + ". Retry those agents in Buzz.", pending: failed }, 409);
    }
    return reply({ approved: true });
  } catch (error) {
    log("warn", "buzz_desktop_setup_failed", { error: errorName(error) });
    if (error instanceof ApprovalBusy) return reply({ error: "An approval is already in progress. Try again in a moment." }, 409);
    return reply({ error: "Buzz could not complete this request. Try again from the Vercel plugin." }, 503);
  }
}
