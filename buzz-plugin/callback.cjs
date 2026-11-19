// Runs only after approval. The fixed Node process receives no user-supplied arguments.
const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const path = "/buzz/" + randomBytes(24).toString("base64url");
let origin;
let used = false;
const server = createServer((req, res) => {
  let url;
  try { url = new URL(req.url, origin); } catch { res.writeHead(400).end(); return; }
  const code = url.searchParams.get("code");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (used || req.method !== "GET" || "http://" + req.headers.host !== origin ||
      url.origin !== origin || url.pathname !== path || url.searchParams.size !== 1 ||
      !code || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) {
    res.writeHead(404).end();
    return;
  }
  used = true;
  res.end("Sign-in received. Return to Buzz to see your agent.", () => console.log(JSON.stringify(["code", code])));
  server.close();
});
server.listen(0, "127.0.0.1", () => {
  origin = "http://127.0.0.1:" + server.address().port;
  console.log(JSON.stringify(["ready", origin + path]));
});
setTimeout(() => process.exit(1), 5 * 60_000).unref();
