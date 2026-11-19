import { randomBytes } from "node:crypto";

export function enrollmentPage(): Response {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Buzz</title>
<style nonce="${nonce}">
  :root {
    color-scheme: light;
    --canvas: #f5f3ef;
    --surface: #fff;
    --inset: #f7f5f2;
    --ink: #231e2a;
    --muted: #605869;
    --rule: #e6e1e7;
    --control: #9d93a5;
    --accent: #503788;
    --accent-hover: #3d286d;
    --tint: #eee8f8;
    --on-accent: #fff;
    --error: #9d323e;
    --error-bg: #fdf1f2;
    --success: #235e4b;
    --success-bg: #eaf5ef;
    --shadow: 0 12px 36px #2e1d3e12, 0 1px 3px #2e1d3e12;
    font: 100%/1.55 system-ui, sans-serif;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --canvas: #18151c;
      --surface: #231e28;
      --inset: #2e2735;
      --ink: #f2ebf7;
      --muted: #c1b4ca;
      --rule: #443a4d;
      --control: #82758c;
      --accent: #cfb7fb;
      --accent-hover: #e1d0ff;
      --tint: #3e3054;
      --on-accent: #281743;
      --error: #ffc0c6;
      --error-bg: #442a33;
      --success: #aadcc7;
      --success-bg: #233d34;
      --shadow: 0 12px 36px #0005, 0 1px 3px #0004;
    }
  }

  *, *::before, *::after { box-sizing: border-box }
  [hidden] { display: none !important }
  ::selection { background: var(--tint); color: var(--ink) }
  body {
    margin: 0;
    padding: 4rem 1.25rem;
    color: var(--ink);
    background: var(--canvas);
  }
  main {
    max-width: 33rem;
    margin-inline: auto;
    padding: 2rem;
    border-radius: 1rem;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  h1, h2, p, ol { margin: 0 }
  h1 { font-size: 2rem; line-height: 1.15; letter-spacing: -.035em }
  h2 { font-size: 1.225rem; line-height: 1.3; letter-spacing: -.02em }
  .identity {
    display: flex;
    align-items: center;
    gap: .625rem;
    margin-top: .875rem;
    font-size: .9375rem;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .identity img {
    width: 2.25rem;
    height: 2.25rem;
    flex: none;
    border-radius: .625rem;
    background: var(--inset);
    object-fit: cover;
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: .75rem;
    margin: 1.75rem 0 1.5rem;
    padding: 0;
    list-style: none;
    font-size: .8125rem;
    font-weight: 650;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: .5rem;
    padding-block: .625rem .75rem;
    border-top: 2px solid var(--rule);
    color: var(--muted);
    line-height: 1.25;
  }
  .steps li[aria-current="step"] { border-color: var(--accent); color: var(--accent) }
  .step-numeral {
    display: grid;
    place-items: center;
    flex: 0 0 1.375rem;
    height: 1.375rem;
    border-radius: 50%;
    background: var(--inset);
    font-size: .75rem;
    font-variant-numeric: tabular-nums;
  }
  .steps li[aria-current="step"] .step-numeral { background: var(--tint) }
  .instructions, .field-hint, .notice { color: var(--muted) }
  .instructions { margin-top: .5rem; font-size: .9375rem }
  .menu-path {
    margin-block: .625rem;
    padding: .625rem .875rem;
    border-radius: .5rem;
    background: var(--inset);
    font-size: .875rem;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  .menu-path span { color: var(--muted); margin-inline: .225rem }
  .field, .key, .actions { margin-top: 1.25rem }
  label, .key-label { font-size: .875rem; font-weight: 690 }
  label { display: block }
  input, button, .button { font: inherit }
  input {
    width: 100%;
    min-width: 0;
    min-height: 2.75rem;
    margin-top: .375rem;
    padding: .5rem .75rem;
    border: 1px solid var(--control);
    border-radius: .5rem;
    background: var(--surface);
    color: var(--ink);
    caret-color: var(--accent);
  }
  input::placeholder { color: var(--muted); opacity: 1; font-size: .875rem }
  input[aria-invalid="true"] { border-color: var(--error) }
  :is(button, a, input, summary):focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .field-hint { margin-top: .375rem; font-size: .8125rem }
  .key-line, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .875rem }
  .key-line { justify-content: space-between }
  details { margin-top: .375rem }
  summary, .text-button { color: var(--accent); font-size: .875rem; cursor: pointer }
  summary { padding-block: .375rem }
  .key-value {
    font: .8125rem/1.6 ui-monospace, "SF Mono", Consolas, monospace;
    background: var(--inset);
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    padding: .5rem .875rem;
    border: 1px solid transparent;
    border-radius: .5rem;
    font-size: .875rem;
    font-weight: 700;
    line-height: 1.3;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
  }
  .primary { background: var(--accent); color: var(--on-accent) }
  .primary:hover { background: var(--accent-hover) }
  .secondary { border-color: var(--control); background: var(--surface); color: var(--ink) }
  .secondary:hover { background: var(--inset) }
  .text-button {
    min-height: 2.75rem;
    padding: .375rem .25rem;
    border: 0;
    background: transparent;
  }
  .text-button:hover, summary:hover { text-decoration: underline; text-underline-offset: .18em }
  button:disabled { cursor: default; opacity: .62 }
  .notice { margin-top: 1rem; font-size: .9375rem }
  .feedback:not(:empty) {
    margin-top: .875rem;
    padding: .625rem .75rem;
    border-radius: .5rem;
    color: var(--error);
    background: var(--error-bg);
    font-size: .875rem;
  }
  .success {
    margin-top: 1.5rem;
    padding: 1rem;
    border-radius: .625rem;
    color: var(--success);
    background: var(--success-bg);
  }
  .success p { margin-top: .375rem; font-size: .9375rem }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 35rem) {
    body { padding: 1.25rem .75rem }
    main { padding: 1.375rem }
    h1 { font-size: 1.75rem }
    .actions .primary { flex: 1 0 100% }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Connect to Buzz</h1>
    <p class="identity" id="identity" hidden>
      <img id="picture" width="36" height="36" alt="" hidden>
      <span id="name"></span>
    </p>
  </header>
  <p class="notice" id="notice" role="status">Opening the setup link…</p>
  <noscript><p class="notice">Enable JavaScript and reopen your setup link.</p></noscript>
  <div id="setup" hidden>
    <ol class="steps" aria-label="Setup progress" role="list">
      <li id="approve-step" aria-current="step"><span class="step-numeral" aria-hidden="true">1</span> Approve agent</li>
      <li id="signin-step"><span class="step-numeral" aria-hidden="true">2</span> Sign in</li>
    </ol>
    <form id="approve" aria-labelledby="approve-heading">
      <h2 id="approve-heading" tabindex="-1">Approve the agent key</h2>
      <p class="instructions">In Buzz Desktop, go to</p>
      <p class="menu-path">Settings <span aria-hidden="true">›</span> Buzz <span aria-hidden="true">›</span> Security</p>
      <p class="instructions">Choose <strong>Authorize external identity</strong>, paste the agent’s public key, and review the approval in Buzz.</p>
      <div class="key">
        <div class="key-line">
          <span class="key-label">Agent public key</span>
          <button class="button secondary" type="button" id="copy-key">Copy public key</button>
        </div>
        <details id="key-details">
          <summary>View public key</summary>
          <input class="key-value" id="key" aria-label="Agent public key" readonly spellcheck="false">
        </details>
        <span class="sr-only" id="copy-status" role="status"></span>
      </div>
      <div class="field">
        <label for="proof">Ownership proof from Buzz</label>
        <input id="proof" type="password" autocomplete="off" spellcheck="false" required aria-describedby="proof-hint approve-error">
        <p class="field-hint" id="proof-hint">After approving the key, copy the ownership proof that Buzz shows and paste it here.</p>
      </div>
      <p class="feedback" id="approve-error" role="alert"></p>
      <div class="actions">
        <button class="button primary" type="submit">Continue to sign-in</button>
      </div>
    </form>
    <section id="signin" aria-labelledby="signin-heading" hidden>
      <h2 id="signin-heading" tabindex="-1">Sign in to Buzz</h2>
      <div id="login-prompt">
        <p class="instructions">Sign in with Builderlab in a new tab. Keep this page open to finish setup.</p>
        <p class="instructions" id="login-loading" role="status" hidden>Preparing the sign-in link…</p>
        <div class="actions">
          <a class="button primary" id="login" target="_blank" rel="noopener noreferrer" hidden>Open Buzz sign-in</a>
          <button class="button secondary" id="retry-login" type="button" hidden>Try again</button>
          <button class="text-button" id="back-before" type="button">Back to approval</button>
        </div>
      </div>
      <form id="finish" hidden>
        <p class="instructions">After sign-in, copy the full address from the tab Buzz sends you to, even if that tab shows a connection error. Paste it here.</p>
        <div class="field">
          <label for="redirect">Return address</label>
          <input id="redirect" type="password" autocomplete="off" spellcheck="false" required
            placeholder="http://127.0.0.1:…" aria-describedby="redirect-hint signin-error">
          <p class="field-hint" id="redirect-hint">The address starts with <code>http://127.0.0.1</code>.</p>
        </div>
        <div class="actions">
          <button class="button primary" id="finish-button" type="submit">Finish setup</button>
          <button class="text-button" id="back-after" type="button">Back to approval</button>
          <button class="text-button" id="restart" type="button">Restart sign-in</button>
        </div>
      </form>
      <p class="feedback" id="signin-error" role="alert"></p>
    </section>
  </div>
  <section class="success" id="success" aria-labelledby="success-heading" hidden>
    <h2 id="success-heading" tabindex="-1">Buzz authorization complete</h2>
    <p>The Vercel connector can now be set up. You can close this tab.</p>
  </section>
</main>
<script type="module" nonce="${nonce}">
  const [id, token] = location.hash.slice(1).split(".");
  history.replaceState(null, "", location.pathname);
  const element = id => document.getElementById(id);
  const notice = element("notice");
  const approval = element("approve");
  const proofField = element("proof");
  const approvalError = element("approve-error");
  const signIn = element("signin");
  const login = element("login");
  const signInError = element("signin-error");
  const finish = element("finish");
  const address = element("redirect");
  const finishButton = element("finish-button");
  const backAfter = element("back-after");
  const restart = element("restart");
  let proof;
  let signInOpened = false;

  async function call(step, fields = {}) {
    let response;
    try {
      response = await fetch(location.pathname, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ id, step, ...fields }),
      });
    } catch {
      throw new Error("Couldn't reach Vercel. Check your connection and try again.");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Vercel setup is temporarily unavailable. Try again.");
    return result;
  }

  function showStep(signingIn) {
    approval.hidden = signingIn;
    signIn.hidden = !signingIn;
    element(signingIn ? "approve-step" : "signin-step").removeAttribute("aria-current");
    element(signingIn ? "signin-step" : "approve-step").setAttribute("aria-current", "step");
    element(signingIn ? "signin-heading" : "approve-heading").focus();
  }

  function showSignIn() {
    element("login-prompt").hidden = signInOpened;
    finish.hidden = !signInOpened;
  }

  async function begin() {
    login.removeAttribute("href");
    login.hidden = true;
    element("retry-login").hidden = true;
    element("login-loading").hidden = false;
    address.value = "";
    address.removeAttribute("aria-invalid");
    signInError.textContent = "";
    signInOpened = false;
    showSignIn();
    try {
      const started = await call("start");
      if (started.authorized) return done();
      login.href = started.url;
      login.hidden = false;
    } catch (error) {
      signInError.textContent = error.message;
      element("retry-login").hidden = false;
    } finally {
      element("login-loading").hidden = true;
    }
  }

  function done() {
    proof = undefined;
    approval.reset();
    finish.reset();
    element("setup").hidden = true;
    notice.hidden = true;
    element("success").hidden = false;
    element("success-heading").focus();
  }

  element("copy-key").addEventListener("click", async () => {
    const key = element("key");
    const message = element("copy-status");
    try {
      await navigator.clipboard.writeText(key.value);
      element("copy-key").textContent = "Copied";
      message.textContent = "Public key copied.";
    } catch {
      element("key-details").open = true;
      key.focus();
      key.select();
      message.textContent = "Public key selected. Use your keyboard to copy it.";
    }
  });

  proofField.addEventListener("input", () => {
    proofField.removeAttribute("aria-invalid");
    approvalError.textContent = "";
  });
  approval.addEventListener("submit", event => {
    event.preventDefault();
    let parsed;
    try { parsed = JSON.parse(proofField.value.trim()); } catch {}
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== "auth") {
      approvalError.textContent = "Copy the entire ownership proof from Buzz, including the square brackets.";
      proofField.setAttribute("aria-invalid", "true");
      proofField.focus();
      return;
    }
    proof = parsed;
    showStep(true);
    if (!login.hasAttribute("href") && element("login-loading").hidden) {
      void begin();
    }
  });

  login.addEventListener("click", () => {
    signInOpened = true;
    // Let the browser open the link before switching the controls on this page.
    window.setTimeout(() => {
      showSignIn();
      if (!signIn.hidden) address.focus();
    }, 0);
  });
  element("back-before").addEventListener("click", () => showStep(false));
  backAfter.addEventListener("click", () => showStep(false));
  restart.addEventListener("click", () => {
    element("signin-heading").focus();
    void begin();
  });
  element("retry-login").addEventListener("click", () => {
    element("signin-heading").focus();
    void begin();
  });
  address.addEventListener("input", () => address.removeAttribute("aria-invalid"));
  finish.addEventListener("submit", async event => {
    event.preventDefault();
    const redirect = address.value.trim();
    if (!redirect.startsWith("http://127.0.0.1:")) {
      signInError.textContent = "Copy the full address from the tab Buzz opened after sign-in.";
      address.setAttribute("aria-invalid", "true");
      address.focus();
      return;
    }
    signInError.textContent = "";
    finishButton.disabled = backAfter.disabled = restart.disabled = true;
    finishButton.textContent = "Finishing setup…";
    try {
      await call("complete", { proof, redirect });
      done();
    } catch (error) {
      signInError.textContent = error.message;
    } finally {
      finishButton.disabled = backAfter.disabled = restart.disabled = false;
      finishButton.textContent = "Finish setup";
    }
  });

  try {
    if (!id || !token) throw new Error("Open the original invite link for your agent to start.");
    const profile = await call("view");
    document.title = "Connect " + profile.name + " to Buzz";
    element("name").textContent = profile.name;
    element("identity").hidden = false;
    if (profile.picture) {
      const picture = element("picture");
      picture.addEventListener("error", () => { picture.hidden = true; }, { once: true });
      picture.src = profile.picture;
      picture.hidden = false;
    }
    notice.hidden = true;
    if (profile.authorized) done();
    else {
      element("key").value = profile.pubkey;
      element("setup").hidden = false;
    }
  } catch (error) {
    notice.textContent = error.message;
  }
</script>
</body>
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
