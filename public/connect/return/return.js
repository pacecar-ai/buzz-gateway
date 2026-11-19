const title = document.getElementById("title");
const intro = document.getElementById("intro");
const list = document.getElementById("agents");
const retry = document.getElementById("retry");
const validReceipt = /^[A-Za-z0-9_-]{43}$/;
const fragment = location.hash.slice(1);
const receipt = fragment ? fragment : history.state?.buzzReceipt;
if (location.hash || location.search) {
  history.replaceState(validReceipt.test(receipt || "") ? { buzzReceipt: receipt } : null, "", location.pathname);
}

document.getElementById("open").addEventListener("click", () => { document.getElementById("help").hidden = false; });
let controller, timer, previousRows;
function copy(heading, detail) {
  if (title.textContent === heading && intro.textContent === detail) return;
  title.textContent = heading;
  document.title = heading + " · Buzz";
  intro.textContent = detail;
}
function renderRows(rows) {
  const key = JSON.stringify(rows);
  if (previousRows === key) return;
  previousRows = key;
  const elements = rows.map(row => {
    const item = document.createElement("li");
    const portrait = document.createElement("span");
    portrait.className = "portrait";
    portrait.setAttribute("aria-hidden", "true");
    const initial = document.createElement("span");
    initial.textContent = Array.from(row.name.trim())[0] || "";
    portrait.append(initial);
    if (row.picture && /^https:\/\/vercel\.com\/api\/www\/avatar\/[a-f0-9]{40}$/.test(row.picture)) {
      const image = new Image();
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = row.picture;
      portrait.append(image);
    }
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = row.name;
    const status = document.createElement("span");
    status.className = "agent-status";
    status.dataset.status = row.status;
    status.textContent = { approved: "Approved", pending: "Confirming", attention: "Needs attention" }[row.status];
    item.append(portrait, name, status);
    return item;
  });
  list.replaceChildren(...elements);
  list.hidden = false;
}

function cancel() {
  clearTimeout(timer);
  controller?.abort();
}
async function check(signal, deadline) {
  try {
    const response = await fetch("/api/desktop", { method: "POST", cache: "no-store",
      headers: { authorization: "Bearer " + receipt, "content-type": "application/json" },
      body: JSON.stringify({ step: "receipt" }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (signal.aborted) return;
    if (response.status === 410 || response.status === 403) {
      list.hidden = true;
      previousRows = undefined;
      copy("Check approval in Buzz", "This sign-in status is no longer available here. Open the Vercel panel in Buzz to see your agents.");
      return;
    }
    if (!response.ok) throw new Error();
    const { agents } = await response.json();
    if (signal.aborted) return;
    if (!Array.isArray(agents) || !agents.length || agents.length > 8 ||
      !agents.every(a => typeof a.name === "string" && ["pending", "approved", "attention"].includes(a.status))) throw new Error();
    renderRows(agents);
    if (agents.every(a => a.status === "approved")) {
      const single = agents.length === 1;
      copy(single ? "Agent approved" : "Agents approved", single ?
        "Return to Buzz to find your agent in Agents and invite it to a room." :
        "Return to Buzz to find these agents in Agents and invite them to a room.");
    } else if (agents.some(a => a.status === "attention")) {
      copy("Finish approval in Buzz", "Open the Vercel panel in Buzz to retry the agents marked as needing attention.");
    } else if (Date.now() >= deadline) {
      copy("Check progress in Buzz", "Buzz is still confirming this sign-in. Open the app for the latest status.");
      retry.hidden = false;
    } else {
      copy("Finishing sign-in", "Buzz is checking approval for your selected agents. You can return to the app now.");
      timer = setTimeout(() => check(signal, deadline), 2200);
    }
  } catch {
    if (signal.aborted) return;
    copy("Check approval in Buzz", "The browser couldn’t check the result. Open Buzz to see the current status, or try again here.");
    retry.hidden = false;
  }
}
function start() {
  cancel();
  controller = new AbortController();
  retry.hidden = true;
  copy("Checking approval", "Buzz is confirming your sign-in. You can return to the app now.");
  void check(controller.signal, Date.now() + 30_000);
}
if (validReceipt.test(receipt || "")) {
  retry.addEventListener("click", start);
  window.addEventListener("pagehide", cancel);
  window.addEventListener("pageshow", event => { if (event.persisted) start(); });
  start();
}
