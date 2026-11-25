// Giving Agent — a jolly helper that finds local charities to give to or volunteer with.
// Runs on a Fly.io Sprite. Uses Sprites connectors (Anthropic, Apify, Box) through the gateway,
// so no API keys ever live on the Sprite.
//
// Zero dependencies: Node 18+ only.

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const MOCK = process.env.MOCK === "1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SAVED_FILE = path.join(DATA_DIR, "saved.json");
const GATEWAY_LIST_URL = "https://api.sprites.dev/v1/gateway/list";
const MAX_TURNS = 8;

// ---------------------------------------------------------------------------
// Connector discovery
// ---------------------------------------------------------------------------
// Each connector is reached at https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/...
// You can set the base URLs yourself (copy them from the connector's page in the dashboard),
// or the app will look them up from the gateway's list endpoint on first use.

const connectors = {
  anthropic: process.env.ANTHROPIC_GATEWAY_URL || null,
  apify: process.env.APIFY_GATEWAY_URL || null,
  box: process.env.BOX_GATEWAY_URL || null,
};
let discovered = false;

async function discoverConnectors() {
  if (discovered || MOCK) return;
  discovered = true;
  if (Object.values(connectors).every(Boolean)) return;
  try {
    const res = await fetch(GATEWAY_LIST_URL);
    if (!res.ok) throw new Error(`gateway list returned ${res.status}`);
    const body = await res.json();
    // Be forgiving about the shape: find any object with a gateway_base_url.
    const entries = [];
    (function walk(v) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        if (v.gateway_base_url) entries.push(v);
        Object.values(v).forEach(walk);
      }
    })(body);
    for (const e of entries) {
      const label = JSON.stringify([e.provider, e.type, e.name, e.slug, e.gateway_base_url]).toLowerCase();
      for (const key of Object.keys(connectors)) {
        if (!connectors[key] && label.includes(key)) connectors[key] = e.gateway_base_url;
      }
    }
    console.log("[connectors]", connectors);
  } catch (err) {
    console.warn("[connectors] discovery failed:", err.message);
  }
}

const trimSlash = (s) => s.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Tools the agent can use
// ---------------------------------------------------------------------------

// Apify Actors, run through the Apify connector. Each call runs an Actor and waits for its dataset.
// Note: Actor runs use Apify credits. Both Actors below are Apify's public, widely used scrapers.
const MAPS_ACTOR = process.env.APIFY_MAPS_ACTOR || "compass~crawler-google-places";
const SEARCH_ACTOR = process.env.APIFY_SEARCH_ACTOR || "apify~google-search-scraper";

async function runActor(actor, input) {
  if (!connectors.apify) throw new Error("Apify connector isn't set up yet.");
  const res = await fetch(`${trimSlash(connectors.apify)}/v2/acts/${actor}/run-sync-get-dataset-items?timeout=120`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${actor} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Google Maps: real places near the person, with address, phone, hours.
async function searchPlaces({ query, location, max_results = 8 }) {
  if (MOCK) return mockPlaces(query);
  try {
    const items = await runActor(MAPS_ACTOR, {
      searchStringsArray: [query],
      locationQuery: location,
      maxCrawledPlacesPerSearch: Math.min(max_results, 12),
      language: "en",
      skipClosedPlaces: true,
    });
    return {
      places: items.map((p) => ({
        name: p.title,
        category: p.categoryName,
        address: p.address,
        phone: p.phone,
        website: p.website,
        maps_url: p.url,
        rating: p.totalScore,
        reviews: p.reviewsCount,
        state: p.state,
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Google Search: for drives, events and volunteer sign-ups that aren't places on a map.
async function searchWeb({ query, max_results = 8 }) {
  if (MOCK) return mockSearch(query);
  try {
    const items = await runActor(SEARCH_ACTOR, {
      queries: query,
      maxPagesPerQuery: 1,
      resultsPerPage: Math.min(max_results, 10),
    });
    const organic = items.flatMap((page) => page.organicResults || []);
    return {
      results: organic.slice(0, max_results).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.description || "").slice(0, 400),
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ProPublica Nonprofit Explorer: free, public IRS data. Confirms an org is a registered nonprofit.
async function verifyNonprofit({ name, state }) {
  if (MOCK) return mockVerify(name);
  const params = new URLSearchParams({ q: name });
  if (state) params.set("state[id]", state.toUpperCase().slice(0, 2));
  try {
    const res = await fetch(`https://projects.propublica.org/nonprofits/api/v2/search.json?${params}`);
    if (!res.ok) return { found: false, note: `lookup returned ${res.status}` };
    const data = await res.json();
    const orgs = (data.organizations || []).slice(0, 3).map((o) => ({
      name: o.name,
      ein: o.ein,
      city: o.city,
      state: o.state,
      subsection: o.subseccd, // 3 = 501(c)(3), tax-deductible
      profile: `https://projects.propublica.org/nonprofits/organizations/${o.ein}`,
    }));
    return { found: orgs.length > 0, matches: orgs };
  } catch (err) {
    return { found: false, note: err.message };
  }
}

const TOOLS = [
  {
    name: "search_places",
    description:
      "Find real places on Google Maps near a location: food banks, food pantries, meal programs, shelters, family resource centers, thrift stores run by charities. Returns name, address, phone, website and rating. Takes 20 to 60 seconds, so make each search count.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'food bank' or 'meals on wheels'. Don't include the location here." },
        location: { type: "string", description: "City and state, or ZIP, e.g. 'Portland, OR'" },
        max_results: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["query", "location"],
    },
  },
  {
    name: "search_web",
    description:
      "Search Google for things that aren't places on a map: toy drives, holiday meal drives, coat drives, volunteer sign-up pages, and donation pages. Include the city or ZIP in the query.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "verify_nonprofit",
    description:
      "Look up an organization in IRS nonprofit records (ProPublica Nonprofit Explorer). Returns EIN and a profile link if found. subsection 3 means a 501(c)(3), so gifts are usually tax-deductible.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        state: { type: "string", description: "Two-letter state code, if known" },
      },
      required: ["name"],
    },
  },
  {
    name: "show_results",
    description:
      "Show your picks to the person as cards. Call this exactly once, at the end, with 3 to 6 organizations. Only include organizations you found in search results; never invent URLs.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Optional short note under the heading, only if useful: a caveat, a seasonal tip, or why results are limited. The page already shows the heading \"Here are a few places to start\", so don't repeat that. Leave empty if there's nothing to add." },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              category: {
                type: "string",
                enum: ["food bank", "toy drive", "meal delivery", "shelter", "family support", "cash donation", "volunteer", "other"],
              },
              what_they_do: { type: "string" },
              how_to_help: {
                type: "array",
                items: { type: "string", enum: ["donate money", "donate goods", "volunteer"] },
              },
              location: { type: "string", description: "Street address or neighborhood" },
              phone: { type: "string", description: "Only if it came from search_places" },
              url: { type: "string", description: "Website, or the Google Maps link if there's no website" },
              ein: { type: "string", description: "EIN from verify_nonprofit, if found" },
              verified: { type: "boolean", description: "True only if verify_nonprofit matched this org" },
              seasonal_note: { type: "string", description: "Deadlines or seasonal programs, if any" },
            },
            required: ["name", "category", "what_they_do", "how_to_help", "url", "verified"],
          },
        },
        follow_up: { type: "string", description: "One question or suggestion to keep going" },
      },
      required: ["results"],
    },
  },
];

function systemPrompt() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `You are Jolly, a warm, cheerful guide who helps people find local charities to give to or volunteer with: food banks, toy drives, meal delivery for neighbors, shelters, family support programs, and good places for cash donations.

Today is ${today}. Mention seasonal programs (holiday toy drives, Thanksgiving meals, winter coat drives, back-to-school) only when they fit the date.

How you work:
1. If you don't know where the person is, ask for their city or ZIP in one friendly sentence and stop. Don't call tools yet.
2. Otherwise search for real, local organizations that match what they want. Use search_places for anything with a front door (food banks, pantries, meal programs, shelters). Use search_web for drives, events and sign-up pages (toy drives, holiday meals, coat drives). Searches are slow and cost credits, so run 1 to 3 focused ones, not more.
3. Verify the most promising ones with verify_nonprofit. Some good groups (church pantries, mutual aid, school drives) won't be in IRS records; you can still include them with verified=false.
4. Finish by calling show_results once. Keep the message short and upbeat, never preachy. Don't pressure anyone to give.

Rules: only recommend organizations you actually found; never make up a URL, phone number, or EIN. Prefer groups close to the person. Don't give tax advice beyond saying 501(c)(3) gifts are usually deductible.`;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

async function callClaude(messages) {
  if (MOCK) return mockClaude(messages);
  if (!connectors.anthropic) throw new Error("Anthropic connector isn't set up. See README: Connectors.");
  const res = await fetch(`${trimSlash(connectors.anthropic)}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, system: systemPrompt(), tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`Claude call failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

async function runAgent(history, onEvent) {
  await discoverConnectors();
  // Merge back-to-back user turns (e.g. a tool_result followed by a new question).
  const messages = [];
  for (const m of history) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === m.role && m.role === "user") {
      const asBlocks = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : c);
      prev.content = [...asBlocks(prev.content), ...asBlocks(m.content)];
    } else messages.push({ ...m });
  }
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await callClaude(messages);
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = reply.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { type: "message", text, messages };
    }

    const finish = toolUses.find((t) => t.name === "show_results");
    if (finish) {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: finish.id, content: "Shown to the person." }],
      });
      return { type: "results", ...finish.input, messages };
    }

    const results = [];
    for (const t of toolUses) {
      const run = {
        search_places: [() => searchPlaces(t.input), `Looking on the map for ${t.input.query} near ${t.input.location}`],
        search_web: [() => searchWeb(t.input), `Searching: ${t.input.query}`],
        verify_nonprofit: [() => verifyNonprofit(t.input), `Checking records for ${t.input.name}`],
      }[t.name];
      if (!run) {
        results.push({ type: "tool_result", tool_use_id: t.id, content: "Unknown tool", is_error: true });
        continue;
      }
      onEvent?.(run[1]);
      const out = await run[0]();
      results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return { type: "message", text: "I got a little lost in my lists there. Could you try asking again?", messages };
}

// ---------------------------------------------------------------------------
// Saved list (persists on the Sprite's disk)
// ---------------------------------------------------------------------------

async function loadSaved() {
  try {
    return JSON.parse(await readFile(SAVED_FILE, "utf8"));
  } catch {
    return [];
  }
}
async function storeSaved(list) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SAVED_FILE, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// Box: keep a copy of the giving list in Box, updated in place each time
// ---------------------------------------------------------------------------
// The connector forwards Box API calls (read, create folders, upload files and new versions).
// Box uploads normally go to upload.box.com/api/2.0/...; if your connector's API Usage example
// shows a different path, set BOX_UPLOAD_PATH (default "/2.0").

const BOX_FOLDER_ID = process.env.BOX_FOLDER_ID || "0"; // "0" = Box root folder
const BOX_UPLOAD_PATH = process.env.BOX_UPLOAD_PATH || "/2.0";
const BOX_STATE_FILE = path.join(DATA_DIR, "box.json");

function givingListMarkdown(list) {
  const year = new Date().getFullYear();
  const lines = [`# My giving list (${year})`, "", `Updated ${new Date().toLocaleString("en-US")} by Jolly.`, ""];
  for (const s of list) {
    lines.push(`## ${s.name}`);
    lines.push(`- Type: ${s.category}`);
    if (s.what_they_do) lines.push(`- What they do: ${s.what_they_do}`);
    if (s.how_to_help?.length) lines.push(`- Ways to help: ${s.how_to_help.join(", ")}`);
    if (s.location) lines.push(`- Where: ${s.location}`);
    if (s.phone) lines.push(`- Phone: ${s.phone}`);
    if (s.url) lines.push(`- Link: ${s.url}`);
    if (s.ein) lines.push(`- EIN: ${s.ein}${s.verified ? " (registered nonprofit)" : ""}`);
    if (s.seasonal_note) lines.push(`- Note: ${s.seasonal_note}`);
    lines.push("");
  }
  lines.push("_Keep your donation receipts with this list for tax time._", "");
  return lines.join("\n");
}

async function boxUpload(fileName, content, existingId) {
  const base = trimSlash(connectors.box) + BOX_UPLOAD_PATH;
  const url = existingId ? `${base}/files/${existingId}/content` : `${base}/files/content`;
  const form = new FormData();
  form.append("attributes", JSON.stringify(existingId ? { name: fileName } : { name: fileName, parent: { id: BOX_FOLDER_ID } }));
  form.append("file", new Blob([content], { type: "text/markdown" }), fileName);
  const res = await fetch(url, { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function saveListToBox() {
  const list = await loadSaved();
  if (!list.length) return { ok: false, error: "Your giving list is empty. Save a few cards first." };
  const fileName = `Jolly giving list ${new Date().getFullYear()}.md`;
  const content = givingListMarkdown(list);

  if (MOCK) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(path.join(DATA_DIR, fileName), content);
    return { ok: true, mock: true, file: fileName, link: null };
  }
  if (!connectors.box) return { ok: false, error: "Box connector isn't set up yet." };

  let state = {};
  try { state = JSON.parse(await readFile(BOX_STATE_FILE, "utf8")); } catch {}
  let fileId = state[fileName];

  let { status, body } = await boxUpload(fileName, content, fileId);
  // File already exists in Box (e.g. first run on a new Sprite): upload a new version instead.
  if (status === 409 && body?.context_info?.conflicts?.id) {
    fileId = body.context_info.conflicts.id;
    ({ status, body } = await boxUpload(fileName, content, fileId));
  }
  // Our remembered file was deleted in Box: start fresh.
  if (status === 404 && fileId) {
    fileId = null;
    ({ status, body } = await boxUpload(fileName, content, null));
  }
  if (status >= 300) return { ok: false, error: `Box upload failed (${status}): ${JSON.stringify(body).slice(0, 300)}` };

  fileId = body?.entries?.[0]?.id || fileId;
  state[fileName] = fileId;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(BOX_STATE_FILE, JSON.stringify(state, null, 2));
  return { ok: true, file: fileName, link: fileId ? `https://app.box.com/file/${fileId}` : null };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    // Chat: streams progress lines as NDJSON, then the final answer.
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const { messages } = await readBody(req);
      if (!Array.isArray(messages) || messages.length === 0) return json(res, 400, { error: "messages required" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const send = (o) => res.write(JSON.stringify(o) + "\n");
      try {
        const out = await runAgent(messages, (status) => send({ type: "status", status }));
        send(out);
      } catch (err) {
        console.error(err);
        send({ type: "error", error: err.message });
      }
      return res.end();
    }

    if (url.pathname === "/api/saved") {
      if (req.method === "GET") return json(res, 200, await loadSaved());
      if (req.method === "POST") {
        const item = await readBody(req);
        const list = (await loadSaved()).filter((s) => s.url !== item.url);
        list.unshift({ ...item, saved_at: new Date().toISOString() });
        await storeSaved(list);
        return json(res, 200, list);
      }
      if (req.method === "DELETE") {
        const list = (await loadSaved()).filter((s) => s.url !== url.searchParams.get("url"));
        await storeSaved(list);
        return json(res, 200, list);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/box/save") {
      await discoverConnectors();
      const out = await saveListToBox();
      return json(res, out.ok ? 200 : 400, out);
    }

    if (url.pathname === "/api/health") {
      await discoverConnectors();
      const status = Object.fromEntries(Object.entries(connectors).map(([k, v]) => [k, !!v]));
      return json(res, 200, { ok: true, mock: MOCK, model: MODEL, connectors: status });
    }

    // Static files
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(__dirname, "public", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (file.startsWith(path.join(__dirname, "public")) && existsSync(file)) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      return res.end(await readFile(file));
    }
    res.writeHead(404).end("Not found");
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Giving Agent on :${PORT}${MOCK ? " (mock mode)" : ""}`));

// ---------------------------------------------------------------------------
// Mock mode: lets you try the UI with no connectors. MOCK=1 node server.js
// ---------------------------------------------------------------------------

function mockSearch(query) {
  return {
    results: [
      { title: "Sample Community Food Bank", url: "https://example.org/food-bank", snippet: `Result for "${query}": weekly food distribution, volunteers welcome.` },
      { title: "Sample Toy Drive", url: "https://example.org/toy-drive", snippet: "Collecting new, unwrapped toys through December 15." },
    ],
  };
}
function mockPlaces(query) {
  return {
    places: [
      { name: "Sample Community Food Bank", category: "Food bank", address: "123 Main St, Portland, OR", phone: "(503) 555-0100", website: "https://example.org/food-bank", rating: 4.8, state: "OR" },
    ],
  };
}
function mockVerify(name) {
  return { found: true, matches: [{ name: name.toUpperCase(), ein: "00-0000000", subsection: 3, profile: "https://projects.propublica.org/nonprofits/" }] };
}
function mockClaude(messages) {
  const last = messages[messages.length - 1];
  const lastText = typeof last.content === "string" ? last.content
    : last.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const isNewQuestion = lastText.length > 0;
  const hasPlace = JSON.stringify(messages).includes("My location:");
  if (isNewQuestion && !hasPlace) {
    return { content: [{ type: "text", text: "Happy to help! What city or ZIP code should I look around?" }] };
  }
  if (isNewQuestion) {
    return {
      content: [
        { type: "tool_use", id: "t1a", name: "search_places", input: { query: "food bank", location: "Portland, OR" } },
        { type: "tool_use", id: "t1b", name: "search_web", input: { query: "toy drive Portland OR 2026" } },
      ],
    };
  }
  const usedVerify = JSON.stringify(messages).includes("verify_nonprofit");
  if (!usedVerify) {
    return { content: [{ type: "tool_use", id: "t2", name: "verify_nonprofit", input: { name: "Sample Community Food Bank" } }] };
  }
  return {
    content: [
      {
        type: "tool_use",
        id: "t3",
        name: "show_results",
        input: {
          message: "Mock mode: these are sample results.",
          results: [
            { name: "Sample Community Food Bank", category: "food bank", what_they_do: "Weekly grocery distribution for local families.", how_to_help: ["donate money", "volunteer"], location: "123 Main St, Portland, OR", phone: "(503) 555-0100", url: "https://example.org/food-bank", ein: "00-0000000", verified: true },
            { name: "Sample Toy Drive", category: "toy drive", what_they_do: "Gifts for kids whose families are stretched thin this season.", how_to_help: ["donate goods"], location: "Citywide drop-off bins", url: "https://example.org/toy-drive", verified: false, seasonal_note: "New, unwrapped toys by December 15" },
            { name: "Sample Meals on Wheels", category: "meal delivery", what_they_do: "Hot meals delivered to homebound seniors.", how_to_help: ["volunteer", "donate money"], location: "Eastside", url: "https://example.org/meals", verified: true },
          ],
          follow_up: "Want me to look for weekend volunteer shifts?",
        },
      },
    ],
  };
}
