import { z } from "zod";
import { hexId, projectIdentity, registrationId, stableId } from "./protocol.ts";

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/);
export const channelId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const name = z.string().trim().min(1).max(80);

function urlFor(schemes: string[]) {
  return z.url().transform(value => new URL(value)).refine(
    url => schemes.includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search,
    "Expected an authenticated-transport URL without credentials, a query, or a fragment",
  ).transform(url => url.href);
}

export const agentSchema = z.object({
  id: registrationId,
  relayUrl: urlFor(["wss:", "ws:"]).refine(value => {
    const url = new URL(value);
    return url.protocol === "wss:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }, "Relay connections require WSS outside loopback"),
  pubkey: hexId,
  signingKeyEnv: envName.optional(),
  ownerAttestationEnv: envName.optional(),
  credentialConnector: z.string().trim().min(1).max(512).optional(),
  federatedIdentityAdapter: urlFor(["https:"]).optional(),
  // An existing Buzz profile can be managed by the relay operator instead.
  profile: z.object({
    name,
    description: z.string().max(400).default(""),
    picture: urlFor(["https:"]).optional(),
  }).optional(),
  eveUrl: urlFor(["https:"]).refine(value => new URL(value).pathname === "/", "Expected the eve deployment origin"),
  eveProject: projectIdentity,
  actionKeyDigest: hexId.optional(),
  roomAccess: z.enum(["configured", "membership"]).default("configured"),
  channels: z.array(channelId).max(100).default([]),
  directMessages: z.array(z.object({ channelId, authors: z.array(hexId).min(1).max(64) })).max(100).default([]),
}).refine(agent => Boolean(agent.signingKeyEnv) !== Boolean(agent.credentialConnector), {
  path: ["credentialConnector"],
  message: "Provide one signing credential source",
}).refine(agent => !agent.ownerAttestationEnv || Boolean(agent.signingKeyEnv), {
  path: ["ownerAttestationEnv"],
  message: "An environment attestation requires an environment signing key",
}).refine(agent => {
  if (!agent.federatedIdentityAdapter) return true;
  const url = new URL(agent.relayUrl);
  return Boolean(agent.credentialConnector) && url.protocol === "wss:" && url.pathname === "/"
    && url.port !== "80" && !url.hostname.endsWith(".");
}, {
  path: ["federatedIdentityAdapter"],
  message: "Federated installations require a connector and a root WSS relay URL",
}).refine(agent => agent.roomAccess === "configured" || (!agent.channels.length && !agent.directMessages.length), {
  path: ["roomAccess"],
  message: "Membership mode gets rooms from Buzz",
});

export type Agent = z.infer<typeof agentSchema> & { namespace: string; relayIdentity: string };

export function loadAgents(env: NodeJS.ProcessEnv = process.env): Map<string, Agent> {
  let value: unknown;
  try {
    value = JSON.parse(env.BUZZ_GATEWAY_AGENTS ?? "[]");
  } catch {
    throw new Error("BUZZ_GATEWAY_AGENTS must contain valid JSON");
  }
  const result = z.array(agentSchema).max(32).safeParse(value);
  if (!result.success) {
    const path = result.error.issues[0]?.path.join(".") || "registrations";
    throw new Error(`Invalid BUZZ_GATEWAY_AGENTS field: ${path}`);
  }
  const agents = new Map<string, Agent>();
  const identities = new Set<string>();
  for (const agent of result.data) {
    const identity = stableId(agent.relayUrl, agent.pubkey);
    const rooms = [...agent.channels, ...agent.directMessages.map(dm => dm.channelId)];
    if (agents.has(agent.id) || identities.has(identity) || new Set(rooms).size !== rooms.length) {
      throw new Error("Agent IDs, relay identities, and rooms within a registration must be unique");
    }
    const { teamId, projectId, environment } = agent.eveProject;
    agents.set(agent.id, {
      ...agent,
      relayIdentity: identity,
      namespace: stableId(agent.id, identity, agent.eveUrl, teamId, projectId, environment),
    });
    identities.add(identity);
  }
  return agents;
}

export function gatewayRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region = env.BUZZ_GATEWAY_REGION ?? env.VERCEL_REGION;
  if (!region || !/^[a-z]{3}\d$/.test(region)) throw new Error("Set BUZZ_GATEWAY_REGION to your Vercel region");
  return region;
}
