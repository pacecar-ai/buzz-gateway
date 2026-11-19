import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { transform } from "esbuild";

const inferred = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const source = process.argv[2] || process.env.BUZZ_GATEWAY_PUBLIC_ORIGIN ||
  (process.env.BUZZ_GATEWAY_ENROLLMENT && JSON.parse(process.env.BUZZ_GATEWAY_ENROLLMENT).origin) ||
  (inferred && "https://" + inferred);
if (!source) throw new Error("Specify the gateway HTTPS origin or set BUZZ_GATEWAY_PUBLIC_ORIGIN");
const origin = new URL(source);
if (origin.protocol !== "https:" || origin.origin !== source) throw new Error("Use an HTTPS origin without a path");
const directory = resolve(process.argv[3] ?? "public/buzz-plugin");
const callback = await readFile(new URL("../buzz-plugin/callback.cjs", import.meta.url), "utf8");
const compiled = (await transform(callback, { format: "iife", minify: true, target: "node20" })).code.trim();
if (Buffer.byteLength(compiled) > 1024) throw new Error("The listener exceeds Buzz's limit for a fixed process argument");
const identity = process.env.BUZZ_GATEWAY_DESKTOP_IDENTITY && JSON.parse(process.env.BUZZ_GATEWAY_DESKTOP_IDENTITY);
let removal = null;
if (identity) {
  const adapter = new URL(identity.adapter);
  if (adapter.protocol !== "https:" || adapter.username || adapter.password || adapter.hash || adapter.search ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(identity.authority)) throw new Error("Invalid Buzz identity provider");
  removal = { authority: identity.authority, path: adapter.pathname.replace(/\/$/, "") + "/v1/nip-fi/agent-revoke" };
}
const manifest = {
  id: "pacecar.vercel", name: "Vercel", apiVersion: 1,
  description: "Connect Vercel agents to your Buzz community. Buzz handles approval and the agent list.",
  host: { ...(removal && { federatedIdentity: { authority: removal.authority, operations: [{ method: "POST", path: removal.path }] } }), commands: [], networkOrigins: [origin.origin], processes: [
    { id: "sign-in-return", program: "node", args: ["-e", compiled, "--"] },
  ] },
};
const template = await readFile(new URL("../buzz-plugin/plugin.js", import.meta.url), "utf8");
const code = template.replace('"__GATEWAY_ORIGIN__"', JSON.stringify(origin.origin)).replace('"__REVOCATION_CONFIG__"', JSON.stringify(removal));
const artifact = JSON.stringify({ manifest, code });
const sha256 = createHash("sha256").update(artifact).digest("hex");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, sha256 + ".json"), artifact);
await writeFile(resolve(directory, "release.json"), JSON.stringify({ id: manifest.id, sha256 }) + "\n");
if (process.argv[4]) {
  const folder = resolve(process.argv[4]);
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(resolve(folder, "plugin.js"), code);
}
console.log("Built Buzz plugin " + sha256);
