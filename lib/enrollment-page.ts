import { randomBytes } from "node:crypto";

export function enrollmentPage(): Response {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Buzz agent</title>
<style nonce="${nonce}">
  body { color-scheme: light dark; font: 16px/1.55 system-ui, sans-serif; margin: 0 }
  main { max-width: 40rem; padding: 2rem 1.25rem; margin: auto }
  header { display: flex; gap: 1rem; align-items: center }
  img { width: 3rem; height: 3rem; border-radius: .5rem }
  input, button { font: inherit; padding: .55rem .7rem; box-sizing: border-box }
  input { width: 100%; margin-top: .35rem; margin-bottom: .8rem }
  a { color: LinkText }
  button, a { cursor: pointer }
</style>
<main>
  <header><img id="picture" alt="" hidden><h1 id="name">Authorize Buzz agent</h1></header>
  <p id="status" role="status">Opening your setup link…</p>
  <form id="setup" hidden>
    <p>In Buzz Desktop, go to Settings → Buzz → Security → Authorize external identity. Review the permission and authorize this agent key.</p>
    <label for="key">Public key</label>
    <input id="key" readonly spellcheck="false">
    <label for="proof">Ownership proof from Buzz</label>
    <input id="proof" type="password" autocomplete="off" required>
    <p><a id="login" target="_blank" rel="noopener noreferrer">Continue to Buzz</a> <button id="restart" type="button">Restart sign-in</button></p>
    <p>After sign-in, Buzz returns to a <code>127.0.0.1</code> tab. Copy the full address from that tab, even if it shows a connection error. Return here straight away.</p>
    <label for="redirect">Buzz return address</label>
    <input id="redirect" type="password" autocomplete="off" required>
    <button id="submit" type="submit">Authorize agent</button>
  </form>
</main>
<script type="module" nonce="${nonce}">
  const [id, token] = location.hash.slice(1).split(".");
  history.replaceState(null, "", location.pathname);
  const element = id => document.getElementById(id);
  const status = text => { element("status").textContent = text; };
  async function call(step, fields = {}) {
    const response = await fetch(location.pathname, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ id, step, ...fields }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  async function begin() {
    element("login").removeAttribute("href");
    element("restart").disabled = true;
    element("submit").disabled = true;
    try {
      const started = await call("start");
      if (started.authorized) return done();
      element("login").href = started.url;
      element("redirect").value = "";
      status("Authorize the key in Buzz, then complete Builderlab sign-in.");
    } catch (error) { status(error.message); }
    finally {
      element("restart").disabled = false;
      element("submit").disabled = !element("login").hasAttribute("href");
    }
  }
  function done() {
    element("setup").reset();
    element("setup").hidden = true;
    status("Buzz granted access for this agent. You can close this tab.");
  }
  element("restart").addEventListener("click", begin);
  element("setup").addEventListener("submit", async event => {
    event.preventDefault();
    let proof;
    try { proof = JSON.parse(element("proof").value); }
    catch { return status("Paste the ownership proof from Buzz, including the square brackets."); }
    element("submit").disabled = true;
    element("restart").disabled = true;
    try {
      await call("complete", { proof, redirect: element("redirect").value.trim() });
      done();
    } catch (error) { status(error.message); }
    finally {
      element("submit").disabled = false;
      element("restart").disabled = false;
    }
  });
  try {
    if (!id || !token) throw new Error("Open the original setup link.");
    const profile = await call("view");
    element("name").textContent = "Authorize " + profile.name;
    if (profile.picture) {
      element("picture").src = profile.picture;
      element("picture").hidden = false;
    }
    if (profile.authorized) done();
    else {
      element("key").value = profile.pubkey;
      element("setup").hidden = false;
      await begin();
    }
  } catch (error) { status(error.message); }
</script>
</html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; connect-src 'self'; img-src https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
    },
  });
}
