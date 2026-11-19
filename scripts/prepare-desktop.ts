import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { z } from "zod";
import { agentSchema } from "../lib/config.ts";
import { projectIdentity, registrationId, hexId } from "../lib/protocol.ts";

// Create a new per-agent connector. Existing IDs require an explicit, operator-authenticated pending draft.
const specSchema = z.object({
  id: registrationId, name: z.string().trim().min(1).max(80), uid: z.string().trim().min(1).max(256),
  icon: z.string().regex(/^[a-f0-9]{40}$/).optional(), connectorId: z.string().regex(/^scl_[A-Za-z0-9]+$/).optional(),
  gatewayProjectId: projectIdentity.shape.projectId, eveProject: projectIdentity, eveUrl: z.url(), relayUrl: z.url(),
  federatedIdentityAdapter: z.url(), desktop: z.object({ ownerPubkey: hexId, projectSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) }),
});
const [specFile, gateway] = process.argv.slice(2);
if (!specFile) throw new Error("Usage: node scripts/prepare-desktop.ts registration.json [gateway HTTPS origin for a pending web invitation]");
const spec = specSchema.parse(JSON.parse(await readFile(specFile, "utf8")));
function api(path: string, method = "GET", body?: unknown) {
  const args = ["api", path, "--method", method, "--scope", spec.eveProject.teamSlug, "--non-interactive"];
  if (body !== undefined) args.push("--input", "-");
  const response = spawnSync("vercel", args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8" });
  if (response.status !== 0) throw new Error("Vercel could not complete " + method + " " + path + ". Check your CLI login and project access.");
  return JSON.parse(response.stdout || "null");
}
let bundle: { signingKey: string; actionKey: string };
let pubkey: string;
if (spec.connectorId) {
  const operator = process.env.BUZZ_DESKTOP_OPERATOR;
  if (!gateway || new URL(gateway).origin !== gateway || !gateway.startsWith("https://") || !operator) {
    throw new Error("An existing connector requires its HTTPS gateway and the enrollment operator key in BUZZ_DESKTOP_OPERATOR.");
  }
  const response = await fetch(gateway + "/api/enroll", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { authorization: "Bearer " + operator, "content-type": "application/json" }, body: JSON.stringify({ id: spec.id, step: "prepare" }) });
  if (!response.ok) throw new Error("The gateway requires an unapproved draft for this connector (" + response.status + ").");
  const draft = z.object({ pubkey: hexId, connectorId: z.literal(spec.connectorId), owner: z.literal(spec.desktop.ownerPubkey),
    adapter: z.literal(spec.federatedIdentityAdapter), credential: z.object({ signingKey: hexId, actionKey: hexId }) }).parse(await response.json());
  bundle = draft.credential; pubkey = getPublicKey(Buffer.from(bundle.signingKey, "hex"));
  if (pubkey !== draft.pubkey) throw new Error("Gateway returned an inconsistent key");
} else {
  const secret = generateSecretKey(); pubkey = getPublicKey(secret);
  bundle = { signingKey: Buffer.from(secret).toString("hex"), actionKey: randomBytes(32).toString("hex") };
}
const registration = agentSchema.parse({ ...spec, pubkey, credentialConnector: spec.connectorId ?? "scl_pending",
  profileFromConnector: true, roomAccess: "membership", actionKeyDigest: createHash("sha256").update(bundle.actionKey).digest("hex") });
const credential = JSON.stringify(bundle);
let connectorId = spec.connectorId;
if (connectorId) {
  const found = api("/v1/connect/connectors/" + connectorId);
  const c = found.connector ?? found;
  if (c.id !== connectorId || c.type !== "api-key" || c.public !== false || c.uid !== spec.uid || c.data?.values?.length !== 1) {
    throw new Error("The selected private connector does not match this registration.");
  }
  for (const id of [spec.eveProject.projectId, spec.gatewayProjectId]) {
    const linked = api("/v1/connect/connectors/" + connectorId + "/projects/" + id);
    if (!linked?.enabledEnvironments?.includes("production")) throw new Error("Link this connector to both projects in Production first.");
  }
  api("/v2/connect/connectors/" + connectorId, "PATCH", { data: { toUpdate: [{ id: c.data.values[0].id, value: credential }] } });
} else {
  const created = api("/v1/connect/connectors", "POST", { type: "api-key", uid: spec.uid, name: spec.name, icon: spec.icon,
    projectId: spec.gatewayProjectId, environments: ["production"], data: { subjectType: "app", values: [{ value: credential }] } });
  connectorId = z.string().regex(/^scl_[A-Za-z0-9]+$/).parse((created.connector ?? created).id);
}
// Emit the non-secret registry entry before the last link so it can be used to recover an interrupted setup.
console.log(JSON.stringify({ ...registration, credentialConnector: connectorId }, null, 2));
if (!spec.connectorId) api("/v1/connect/connectors/" + connectorId + "/projects/" + spec.eveProject.projectId,
  "POST", { environments: ["production"] });
