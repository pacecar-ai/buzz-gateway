import { stdin } from "node:process";

const [origin, id, flag] = process.argv.slice(2);
if (!origin || !/^https:\/\//.test(origin) || new URL(origin).origin !== origin ||
  !/^[a-z][a-z0-9-]{0,62}$/.test(id ?? "") || (flag && flag !== "--all") || process.argv.length > 5) {
  throw new Error("Usage: npm run buzz:invite -- https://gateway.example.org agent-id [--all]");
}
let operator = process.env.BUZZ_DESKTOP_OPERATOR;
if (!operator) {
  if (stdin.isTTY) throw new Error("Supply the operator key from your secret manager on stdin or in BUZZ_DESKTOP_OPERATOR.");
  const parts = [];
  for await (const chunk of stdin) parts.push(chunk);
  operator = Buffer.concat(parts).toString().trim();
}
if (!/^[A-Za-z0-9_-]{43}$/.test(operator)) throw new Error("Expected the private 32-byte base64url operator key.");
const response = await fetch(origin + "/api/desktop", {
  method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
  headers: { authorization: "Bearer " + operator, "content-type": "application/json" },
  body: JSON.stringify({ step: "invite", id, all: flag === "--all" }),
});
if (!response.ok) throw new Error("The gateway could not issue this invitation (HTTP " + response.status + ").");
const { path, expiresAt } = await response.json();
if (!/^\/connect\/#[-\w]{43}$/.test(path)) throw new Error("Invalid invitation returned by the gateway.");
console.log(origin + path);
console.log("Expires " + new Date(expiresAt).toISOString());
