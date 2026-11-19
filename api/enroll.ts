import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { z } from "zod";
import { readConnectProfile } from "../lib/connect-profile.ts";
import { loadAgents, type Agent } from "../lib/config.ts";
import { fromConnect, signingKey as verifySigningKey } from "../lib/credentials.ts";
import { createHandoff, verifyOwner } from "../lib/desktop.ts";
import { issueDesktopGrant, readDesktopGrant } from "../lib/desktop-grants.ts";
import { enrollAgent, EnrollmentRefused, exchangeLogin, loginUrl, ownerProof } from "../lib/enrollment.ts";
import { enrollmentPage } from "../lib/enrollment-page.ts";
import { errorName, log } from "../lib/log.ts";
import { hexId, readJson, registrationId } from "../lib/protocol.ts";
import { BlobState, type State, type Versioned } from "../lib/state.ts";

const https = z.url({ protocol: /^https$/ }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
});
const baseEntry = z.object({ id: registrationId, inviteDigest: hexId });
const entry = z.union([
  baseEntry.extend({ connectorId: z.string().regex(/^scl_[a-zA-Z0-9]+$/) }),
  baseEntry.extend({ name: z.string().min(1).max(80), picture: https.optional() }),
]);
const planSchema = z.object({
  origin: https.refine(value => new URL(value).origin === value),
  adapter: https,
  ownerPubkey: hexId,
  operatorDigest: hexId,
  expiresAt: z.number().int(),
  agents: z.array(entry).min(1).max(32),
}).refine(plan => new Set(plan.agents.map(agent => agent.id)).size === plan.agents.length
  && new Set(plan.agents.map(agent => agent.inviteDigest)).size === plan.agents.length
  && plan.agents.every(agent => agent.inviteDigest !== plan.operatorDigest));
const inputSchema = z.object({
  id: registrationId,
  step: z.enum(["view", "start", "complete", "collect", "clear", "prepare", "handoff"]),
  redirect: z.string().max(4096).optional(),
  proof: ownerProof.optional(),
});
type Grant = Awaited<ReturnType<typeof enrollAgent>>;
type Draft = {
  pubkey: string;
  signingKey?: string;
  actionKey?: string;
  attempt?: { callback: string; verifier: string; expiresAt: number };
  lockedUntil?: number;
  grant?: Grant;
  collected?: true;
};

const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });

export default {
  fetch: (request: Request) => handleEnrollment(request, process.env.BUZZ_GATEWAY_ENROLLMENT, new BlobState()),
};

export async function handleEnrollment(request: Request, configuration: string | undefined, state: State): Promise<Response> {
  try {
    const plan = planSchema.safeParse(JSON.parse(configuration ?? "null"));
    if (!plan.success || plan.data.expiresAt <= Date.now() || new URL(request.url).origin !== plan.data.origin) {
      return reply({ error: "This setup link is closed." }, 404);
    }
    if (request.method === "GET") return enrollmentPage();
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST", ...noStore } });

    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return reply({ error: "Open the original setup link." }, 403);
    const input = inputSchema.safeParse(await readJson(request).catch(() => null));
    if (!input.success) return reply({ error: "Invalid setup request." }, 400);
    const { id, step, redirect, proof } = input.data;
    const agent = plan.data.agents.find(candidate => candidate.id === id);
    const actual = createHash("sha256").update(token).digest();
    const operator = step === "collect" || step === "clear" || step === "prepare"
      || (step === "handoff" && timingSafeEqual(actual, Buffer.from(plan.data.operatorDigest, "hex")));
    const expected = operator ? plan.data.operatorDigest : agent?.inviteDigest;
    if (!agent || !expected || !timingSafeEqual(actual, Buffer.from(expected, "hex"))
      || (!operator && request.headers.get("origin") !== plan.data.origin)) {
      return reply({ error: "Open the original setup link." }, 403);
    }

    const path = `enrollment/${agent.inviteDigest}.json`;
    const registered = loadAgents();
    const matches = (item: z.infer<typeof entry>): Agent | undefined => {
      const match = registered.get(item.id);
      return "connectorId" in item && match?.credentialConnector === item.connectorId
        && match.desktop?.ownerPubkey === plan.data.ownerPubkey
        && match.federatedIdentityAdapter?.replace(/\/$/, "") === plan.data.adapter.replace(/\/$/, "") ? match : undefined;
    };
    const desktop = matches(agent);
    if (step === "handoff") {
      if (!desktop) return reply({ error: "This connector has no Buzz Desktop setup." }, 409);
      const proposed = operator ? plan.data.agents.map(matches).filter((item): item is Agent =>
        !!item && item.relayUrl === desktop.relayUrl) : [desktop];
      const expiresAt = operator ? Date.now() + 24 * 60 * 60_000 : Math.min(plan.data.expiresAt, Date.now() + 15 * 60_000);
      const ref = await createHandoff(proposed, state, expiresAt);
      return reply({ url: plan.data.origin + "/connect/#" + ref, expiresAt });
    }
    if (step === "prepare") {
      const { value } = await getDraft(state, path, desktop);
      if (value.collected || value.grant || !value.signingKey) return reply({ error: "This agent has already been approved." }, 409);
      return reply({ pubkey: value.pubkey, connectorId: "connectorId" in agent ? agent.connectorId : undefined, owner: plan.data.ownerPubkey, adapter: plan.data.adapter, credential: { signingKey: value.signingKey, actionKey: value.actionKey } });
    }
    if (operator) {
      const current = await state.read<Draft>(path);
      if (step === "collect") {
        const saved = current?.value;
        return saved?.grant
          ? reply({ pubkey: saved.pubkey, credential: { signingKey: saved.signingKey, actionKey: saved.actionKey, federated: saved.grant } })
          : reply({ status: saved?.collected ? "collected" : "waiting" });
      }
      if (current?.value.collected) return reply({ status: "collected" });
      if (!current?.value.grant) return reply({ error: "The grant is still pending." }, 409);
      return await state.replace<Draft>(path, { pubkey: current.value.pubkey, collected: true }, current.etag, 1)
        ? reply({ status: "collected" }) : reply({ error: "Try again." }, 409);
    }

    const draft = await getDraft(state, path, desktop);
    const { pubkey, signingKey, grant, collected, lockedUntil, attempt } = draft.value;
    let approved = Boolean(grant || collected);
    if (desktop && !approved) {
      const credential = await fromConnect(desktop.credentialConnector!);
      const key = verifySigningKey(credential.signingKey, pubkey);
      const issued = credential.federated ?? await readDesktopGrant(desktop, key, state);
      if (issued && issued.ownerPubkey !== desktop.desktop!.ownerPubkey) throw new Error("Grant owner mismatch");
      approved = Boolean(issued);
    }
    if (step === "view" || approved) {
      return reply({ ...await profileOf(agent), pubkey, authorized: approved, ...(desktop && { desktop: true }) });
    }
    if (lockedUntil && lockedUntil > Date.now()) return reply({ error: "An authorization is already in progress." }, 409);
    if (step === "start") {
      const next = {
        verifier: randomBytes(32).toString("base64url"),
        callback: `http://127.0.0.1:61359/buzz/${randomBytes(18).toString("base64url")}`,
        expiresAt: Math.min(plan.data.expiresAt, Date.now() + 15 * 60_000),
      };
      if (!await state.replace(path, { ...draft.value, attempt: next, lockedUntil: undefined }, draft.etag, 1)) {
        return reply({ error: "Try starting sign-in again." }, 409);
      }
      return reply({ url: loginUrl(plan.data.adapter, next.callback, next.verifier) });
    }

    if (!attempt || attempt.expiresAt <= Date.now()) {
      return reply({ error: "That sign-in expired. Restart sign-in to get a new return address." }, 400);
    }
    const code = redirect && readCode(redirect, attempt.callback);
    if (!code) {
      return reply({ error: "Paste the full return address from this sign-in attempt." }, 400);
    }
    if (!proof || proof[1] !== plan.data.ownerPubkey || !signingKey || (desktop && !verifyOwner(pubkey, proof[1], proof))) {
      return reply({ error: "Go back and paste the ownership proof from the Buzz identity this invite was issued to." }, 400);
    }
    const profile = await profileOf(agent);
    const held = { ...draft.value, lockedUntil: Date.now() + 30_000 };
    if (!await state.replace(path, held, draft.etag, 1)) return reply({ error: "Try again." }, 409);
    const locked = await state.read<Draft>(path);
    if (locked?.value.lockedUntil !== held.lockedUntil) return reply({ error: "Try again." }, 409);
    try {
      const issue = async () => enrollAgent(plan.data.adapter, await exchangeLogin(plan.data.adapter, code, attempt.verifier), signingKey, proof);
      let completed: Draft;
      if (desktop) {
        await issueDesktopGrant(desktop, verifySigningKey(signingKey, pubkey), state, issue);
        completed = { pubkey, collected: true };
      } else {
        completed = { ...draft.value, grant: await issue(), attempt: undefined, lockedUntil: undefined };
      }
      if (!await state.replace(path, completed, locked.etag, 1)) throw new Error("Enrollment record changed");
      log("info", "buzz_enrollment_authorized", { registrationId: id });
      return reply({ ...profile, pubkey, authorized: true });
    } catch (error) {
      await state.replace(path, { ...draft.value, attempt: undefined, lockedUntil: undefined }, locked.etag, 1);
      log("warn", "buzz_enrollment_refused", {
        registrationId: id, error: errorName(error),
        ...(error instanceof EnrollmentRefused ? { providerStatus: error.status, step: error.step } : {}),
      });
      return reply({ error: "Buzz could not finish authorization. Start sign-in again and check the ownership proof." }, 422);
    }
  } catch (error) {
    log("warn", "buzz_enrollment_unavailable", { error: errorName(error) });
    return reply({ error: "The setup page is temporarily unavailable." }, 503);
  }
}

async function profileOf(agent: z.infer<typeof entry>) {
  if ("connectorId" in agent) return readConnectProfile(agent.connectorId);
  return { name: agent.name, picture: agent.picture };
}

async function getDraft(state: State, path: string, desktop?: Agent): Promise<Versioned<Draft>> {
  let draft = await state.read<Draft>(path);
  if (!draft) {
    const credential = desktop ? await fromConnect(desktop.credentialConnector!) : undefined;
    const secret = desktop && credential ? verifySigningKey(credential.signingKey, desktop.pubkey) : generateSecretKey();
    await state.create<Draft>(path, desktop && credential?.federated ? { pubkey: desktop.pubkey, collected: true } : {
      pubkey: getPublicKey(secret), signingKey: Buffer.from(secret).toString("hex"), actionKey: credential?.actionKey ?? randomBytes(32).toString("hex"),
    }, 1);
    draft = await state.read<Draft>(path);
  }
  if (!draft || (desktop && draft.value.pubkey !== desktop.pubkey)) throw new Error("Enrollment record unavailable");
  return draft;
}

function readCode(redirect: string, expectedCallback: string): string | undefined {
  try {
    const url = new URL(redirect);
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048 || [...url.searchParams].length !== 1) return;
    url.search = "";
    if (url.href === expectedCallback) return code;
  } catch { return; }
}
