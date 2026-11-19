const title = document.getElementById("title");
const intro = document.getElementById("intro");
const install = document.getElementById("install");
const open = document.getElementById("open");
const help = document.getElementById("help");
const validInvite = /^[A-Za-z0-9_-]{43}$/;
const reference = location.hash.slice(1);
const updating = new URLSearchParams(location.search).get("update") === "1";
let invitation = reference;
if (reference) history.replaceState(null, "", location.pathname + location.search);
try {
  if (validInvite.test(reference)) sessionStorage.setItem("buzz-handoff", reference);
  else if (!reference && !updating) invitation = sessionStorage.getItem("buzz-handoff");
} catch {}

try {
  const response = await fetch("/buzz-plugin/release.json", { cache: "no-store" });
  if (!response.ok) throw new Error();
  const { id, sha256 } = await response.json();
  if (id !== "pacecar.vercel" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error();
  const artifact = new URL("/buzz-plugin/" + sha256 + ".json", location.origin);
  const invited = validInvite.test(invitation || "");
  let previous;
  try { previous = localStorage.getItem("buzz-plugin-review"); } catch {}
  const update = updating || Boolean(previous && previous !== sha256);
  install.href = "buzz://plugin-install?" + new URLSearchParams({ id, url: artifact.href, sha256 });
  install.hidden = false;
  install.textContent = update ? "Review plugin update" : "Install plugin in Buzz";
  open.href = invited ? "buzz://plugin?" + new URLSearchParams({ id, page: "agents", "route.invitation": invitation }) : "buzz://";
  open.textContent = invited ? "Open agents in Buzz" : "Return to Buzz";
  if (update) {
    title.textContent = "Update Vercel for Buzz";
    intro.textContent = "Review the update in Buzz Desktop. Your existing agent approvals carry over.";
  } else if (invited) {
    intro.textContent = "Install the plugin on this computer, then choose which agents to connect in Buzz Desktop.";
  }
  open.hidden = !invited && !update;
  help.textContent = invited ? "Already installed? Open your agents directly." : "You’ll find Vercel under Settings → Plugins in Buzz.";

  function continueInBuzz() {
    if (!invited && !update) return;
    open.hidden = false;
    open.className = "button primary";
    install.className = "button secondary";
    open.parentElement.prepend(open);
    help.textContent = update ? "After confirming Update plugin in Buzz, return to the app." :
      "After choosing Install plugin in Buzz, open your agents.";
  }
  if (!updating && previous === sha256 && invited) continueInBuzz();
  install.addEventListener("click", () => {
    try { localStorage.setItem("buzz-plugin-review", sha256); } catch {}
    setTimeout(continueInBuzz, 0);
  });
} catch {
  help.textContent = "The plugin could not load. Refresh this page to try again.";
}
