import { renderQuote } from "/quotes.js";

const quoteEl = document.getElementById("quote");
renderQuote(quoteEl);
quoteEl.querySelector(".q-shuffle").addEventListener("click", () => renderQuote(quoteEl));

const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const locationEl = document.getElementById("location");
const savedEl = document.getElementById("saved-list");

let history = [];
let busy = false;

// ---- Season ---------------------------------------------------------------
// Theme: everyday (teal + pink) by default; the snowflake switches to winter (blues + crimson) and back.
const seasonBtn = document.querySelector(".season-toggle");
function setSeason(season) {
  document.body.dataset.season = season;
  const winter = season === "holiday";
  seasonBtn.setAttribute("aria-pressed", String(winter));
  const label = winter ? "Switch back to the everyday look" : "Switch to the winter look";
  seasonBtn.title = label;
  seasonBtn.setAttribute("aria-label", label);
  if (winter) makeSnow();
}
// Snow for the winter look: a mix of soft dots and a few snowflake shapes.
function makeSnow() {
  const overlay = document.querySelector(".overlay");
  if (!overlay || overlay.childElementCount) return;
  const count = window.innerWidth < 600 ? 28 : 55;
  for (let i = 0; i < count; i++) {
    const f = document.createElement("span");
    const star = i % 7 === 0;
    const size = star ? 12 + Math.random() * 12 : 3 + Math.random() * 6;
    f.className = "flake" + (star ? " star" : "");
    if (star) f.textContent = "\u2744\uFE0E";
    else { f.style.width = f.style.height = size + "px"; }
    // Stagger: spread flakes evenly across the width (with a little jitter)
    // and evenly through their fall, so they never bunch up or arrive in rows.
    const slot = (i * 37) % count; // shuffles the order so neighbors don't fall together
    f.style.left = ((slot + 0.2 + Math.random() * 0.6) / count) * 100 + "%";
    f.style.setProperty("--size", size + "px");
    const dur = 4.5 + Math.random() * 7; // twice as fast as before
    f.style.setProperty("--d", dur.toFixed(1) + "s");
    f.style.setProperty("--delay", (-((i + Math.random()) / count) * dur).toFixed(2) + "s");
    f.style.setProperty("--s", (3 + Math.random() * 4).toFixed(1) + "s");
    f.style.setProperty("--x", (8 + Math.random() * 30).toFixed(0) + "px");
    f.style.setProperty("--o", (0.55 + Math.random() * 0.45).toFixed(2));
    f.style.setProperty("--rest", (Math.random() * 100).toFixed(0) + "%");
    overlay.appendChild(f);
  }
}
setSeason(localStorageGet("theme") === "holiday" ? "holiday" : "everyday");
seasonBtn.addEventListener("click", () => {
  const next = document.body.dataset.season === "holiday" ? "everyday" : "holiday";
  setSeason(next);
  localStorageSet("theme", next);
});

// ---- Location memory -------------------------------------------------------
locationEl.value = localStorageGet("location") || "";
locationEl.addEventListener("change", () => localStorageSet("location", locationEl.value.trim()));

// ---- Chat ------------------------------------------------------------------
greet();

document.querySelectorAll(".chips button").forEach((b) =>
  b.addEventListener("click", () => ask(b.dataset.ask))
);
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) ask(text);
  input.value = "";
});

function greet() {
  bubble("agent greeting", "Hi there! Pick an option above, or tell me what kind of giving you have in mind and I'll find good places near you.");
}

async function ask(text) {
  if (busy) return;
  const place = locationEl.value.trim();
  // Add location context to the first message, or whenever it changes.
  const lastPlace = history._place;
  const content = place && place !== lastPlace ? `${text}\n\n(My location: ${place})` : text;
  history._place = place || lastPlace;

  bubble("user", text);
  history.push({ role: "user", content });
  busy = true;
  form.classList.add("busy");
  const status = bubble("agent status", "");
  const setStatus = (text) => {
    status.textContent = text + "… ";
    const note = document.createElement("span");
    note.className = "status-note";
    note.textContent = "This may take a minute.";
    status.appendChild(note);
  };
  setStatus("Rolling up my sleeves");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let final = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const evt = JSON.parse(line);
        if (evt.type === "status") setStatus(evt.status);
        else final = evt;
      }
    }
    status.remove();
    handleFinal(final);
  } catch (err) {
    status.remove();
    bubble("agent error", "Oops, something went sideways: " + err.message);
  } finally {
    busy = false;
    form.classList.remove("busy");
  }
}

function handleFinal(evt) {
  if (!evt) return bubble("agent error", "No answer came back. Try again?");
  if (evt.type === "error") return bubble("agent error", evt.error);
  history = Object.assign(evt.messages || history, { _place: history._place });
  if (evt.type === "message") return bubble("agent", evt.text);
  if (evt.type === "results") {
    const head = document.createElement("h2");
    head.className = "results-heading";
    head.textContent = "Here are a few places to start";
    chatEl.appendChild(head);
    if (evt.message) {
      const note = document.createElement("p");
      note.className = "results-note";
      note.textContent = evt.message;
      chatEl.appendChild(note);
    }
    const grid = document.createElement("div");
    grid.className = "cards";
    (evt.results || []).forEach((r) => grid.appendChild(card(r)));
    chatEl.appendChild(grid);
    if (evt.follow_up) {
      const q = bubble("agent follow-up", evt.follow_up + " ");
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "yes-link";
      yes.textContent = "Yes";
      yes.addEventListener("click", () => { yes.disabled = true; ask("Yes, please."); });
      q.appendChild(yes);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "back-btn";
    back.textContent = "← Back to search";
    back.addEventListener("click", backToSearch);
    chatEl.appendChild(back);
    grid.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Clear the conversation and return to the form at the top (the giving list stays).
function backToSearch() {
  if (busy) return;
  history = [];
  chatEl.innerHTML = "";
  greet();
  document.querySelector(".setup").scrollIntoView({ behavior: "smooth", block: "start" });
  locationEl.focus({ preventScroll: true });
  locationEl.select();
}

function bubble(kind, text) {
  const el = document.createElement("div");
  el.className = "bubble " + kind;
  el.textContent = text;
  chatEl.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

function card(r) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.category = r.category;
  el.innerHTML = `
    <div class="card-top">
      <span class="tag"></span>
      ${r.verified ? '<span class="verified" title="Found in IRS nonprofit records">✓ Registered nonprofit</span>' : ""}
    </div>
    <h3></h3>
    <p class="what"></p>
    <p class="where"></p>
    <p class="phone"></p>
    <p class="season"></p>
    <ul class="ways"></ul>
    <div class="actions">
      <a class="visit" target="_blank" rel="noopener">Visit site</a>
      <button class="save" type="button" title="Save to my giving list">♡ Save</button>
    </div>`;
  el.querySelector(".tag").textContent = r.category;
  el.querySelector("h3").textContent = r.name;
  el.querySelector(".what").textContent = r.what_they_do;
  el.querySelector(".where").textContent = r.location || "";
  el.querySelector(".phone").textContent = r.phone ? "☎ " + r.phone : "";
  el.querySelector(".season").textContent = r.seasonal_note ? "🗓 " + r.seasonal_note : "";
  const ways = el.querySelector(".ways");
  (r.how_to_help || []).forEach((w) => {
    const li = document.createElement("li");
    li.textContent = w;
    ways.appendChild(li);
  });
  const link = el.querySelector(".visit");
  if (/^https?:\/\//.test(r.url)) link.href = r.url;
  else link.remove();
  el.querySelector(".save").addEventListener("click", async (e) => {
    await fetch("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) });
    e.target.textContent = "♥ Saved";
    e.target.classList.add("is-saved");
    loadSaved();
  });
  return el;
}

// ---- Saved list --------------------------------------------------------------
async function loadSaved() {
  const list = await fetch("/api/saved").then((r) => r.json()).catch(() => []);
  savedEl.innerHTML = "";
  if (!list.length) {
    savedEl.innerHTML = '<li class="empty">Nothing saved yet. Tap ♡ on any card.</li>';
    return;
  }
  list.forEach((s) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = s.name;
    if (/^https?:\/\//.test(s.url)) { a.href = s.url; a.target = "_blank"; a.rel = "noopener"; }
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", async () => {
      await fetch("/api/saved?url=" + encodeURIComponent(s.url), { method: "DELETE" });
      loadSaved();
    });
    li.append(a, document.createTextNode(" · " + s.category + " "), rm);
    savedEl.appendChild(li);
  });
}
loadSaved();

// ---- Box -------------------------------------------------------------------------
const boxBtn = document.getElementById("box-save");
const boxStatus = document.getElementById("box-status");
boxBtn.addEventListener("click", async () => {
  boxBtn.disabled = true;
  boxStatus.textContent = "Saving to Box…";
  try {
    const out = await fetch("/api/box/save", { method: "POST" }).then((r) => r.json());
    if (!out.ok) {
      boxStatus.textContent = out.error;
    } else {
      boxStatus.textContent = `Saved "${out.file}" to Box${out.mock ? " (mock mode: saved on the Sprite instead)" : ""}. `;
      if (out.link) {
        const a = document.createElement("a");
        a.href = out.link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open it";
        boxStatus.appendChild(a);
      }
    }
  } catch (err) {
    boxStatus.textContent = "Couldn't reach Box: " + err.message;
  } finally {
    boxBtn.disabled = false;
  }
});

// ---- helpers -------------------------------------------------------------------
function localStorageGet(k) { try { return localStorage.getItem("jolly:" + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem("jolly:" + k, v); } catch {} }
