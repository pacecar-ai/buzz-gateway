const open = document.getElementById("open");
const install = document.getElementById("install");
const help = document.getElementById("help");
const reference = location.hash.slice(1);
if (reference) history.replaceState(null, "", location.pathname);
let ref = reference;
try {
  if (/^[A-Za-z0-9_-]{43}$/.test(ref)) sessionStorage.setItem("buzz-handoff", ref);
  else if (!ref) ref = sessionStorage.getItem("buzz-handoff");
} catch {}
try {
  const response = await fetch("/buzz-plugin/release.json", { cache: "no-store" });
  if (!response.ok) throw new Error();
  const { id, sha256 } = await response.json();
  if (id !== "pacecar.vercel" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error();
  const artifact = new URL("/buzz-plugin/" + sha256 + ".json", location.origin);
  install.href = "buzz://plugin-install?" + new URLSearchParams({ id, url: artifact.href, sha256 });
  install.hidden = false;
  if (ref && /^[A-Za-z0-9_-]{43}$/.test(ref)) {
    open.href = "buzz://plugin?" + new URLSearchParams({ id, page: "agents", "route.invitation": ref });
    open.hidden = false;
    document.getElementById("intro").textContent = "Review your agents in Buzz Desktop. Each agent keeps its own Vercel connector, name, and portrait.";
    let previouslyOpened = false;
    try { previouslyOpened = localStorage.getItem("buzz-plugin-review") === sha256; } catch {}
    function openReview() {
      install.className = "secondary"; open.className = "primary";
      help.textContent = "After approving the plugin in Buzz, choose Open agents in Buzz.";
      try { localStorage.setItem("buzz-plugin-review", sha256); } catch {}
    }
    if (previouslyOpened) openReview();
    else {
      install.className = "primary"; open.className = "secondary";
      install.parentElement.prepend(install);
      help.textContent = "Install once on this computer. If you already have the plugin, open your agents.";
    }
    install.addEventListener("click", () => {
      openReview();
      setTimeout(() => open.parentElement.prepend(open), 0);
    });
  } else {
    install.className = "primary";
    help.textContent = "After installation, open Settings → Plugins → Vercel. Use your team’s setup link to add agents.";
  }
} catch {
  help.textContent = "The plugin could not load. Refresh this page to try again.";
}
