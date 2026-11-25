# Jolly: a giving agent on a Fly.io Sprite

Jolly is a cheerful agent that helps you find a local way to give: food banks, toy drives, meal delivery, family support, cash donations, or volunteer shifts. Tell it your city or ZIP and what you'd like to do. Jolly finds real places on the map and searches for drives and sign-up pages. It also checks organizations against IRS nonprofit records and gives you a short list of cards. Save the ones you like, then send your giving list to Box so it's ready at tax time.

It works all year. The snowflake in the corner switches to a winter look with falling snow.

Built for **Hacksgiving 2026**.

## How it works

```
Browser ──► server.js on the Sprite (:8080)
              │
              ├─ Anthropic connector ──► Claude (agent loop with tools)
              ├─ Apify connector ──────► Google Maps scraper (local places: address, phone, hours)
              │                          Google Search scraper (toy drives, events, sign-up pages)
              ├─ Box connector ────────► "Jolly giving list 2026.md", updated in place
              └─ ProPublica Nonprofit Explorer (public API) ──► "Registered nonprofit" check
```

* **Connectors used:** Anthropic, Apify and Box, all through the Sprites gateway. No API keys are stored on the Sprite.
* **Agent tools:** `search_places` and `search_web` (both Apify Actors), `verify_nonprofit`, and `show_results`. Claude calls `show_results` to finish, and the UI turns that into cards.
* **Persistence:** saved picks go in `data/saved.json` on the Sprite's disk. The Box file ID goes in `data/box.json`, so later saves update the same file and add a new version.
* **No dependencies:** you only need Node 18 or newer.

## Run it on a Sprite

1. **Add the connectors** in the Fly.io dashboard: your org → Sprites → Connectors → Add connector.
   * **Anthropic:** an API key from console.anthropic.com (Settings → API keys).
   * **Apify:** a token from console.apify.com (Settings → API & Integrations). Actor runs use Apify credits.
   * **Box:** choose "Continue with Box" and approve file access.

   For each one, turn off "Allow all sprites" and allow names starting with `jolly`.

2. **Create the Sprite** (on your computer):
   ```bash
   curl https://sprites.dev/install.sh | bash
   sprite login
   sprite create -o <your-org> jolly
   sprite console -o <your-org> -s jolly
   ```

3. **Inside the Sprite** (the prompt reads `sprite@jolly`), get the code and check the connectors:
   ```bash
   git clone https://github.com/ahruygt/jolly.git && cd jolly
   node server.js &
   sleep 2 && curl -s localhost:8080/api/health   # anthropic, apify and box should all say true
   kill %1
   ```

4. **Keep it running** as a Sprite service, which restarts whenever the Sprite wakes:
   ```bash
   sprite-env services create jolly --cmd node --args "$PWD/server.js"
   ```

5. **Make it public** (back on your computer) and find the URL:
   ```bash
   sprite config update -o <your-org> -s jolly --url-auth public
   sprite info -o <your-org> -s jolly
   ```

If the health check shows `false` for a connector, set its gateway URL by hand (copy it from the connector's page in the dashboard) as `ANTHROPIC_GATEWAY_URL`, `APIFY_GATEWAY_URL` or `BOX_GATEWAY_URL`.

Optional settings:

| Variable | Default | What it does |
|---|---|---|
| `MODEL` | `claude-sonnet-5-5` | Claude model |
| `BOX_FOLDER_ID` | `0` (root) | Box folder for the giving list |
| `BOX_UPLOAD_PATH` | `/2.0` | Path prefix for Box uploads, if the Box connector's "API Usage" example differs |
| `APIFY_MAPS_ACTOR` | `compass~crawler-google-places` | Google Maps Actor |
| `APIFY_SEARCH_ACTOR` | `apify~google-search-scraper` | Google Search Actor |

## Try it without connectors

```bash
MOCK=1 node server.js
```
Mock mode returns sample results, and "Save list to Box" writes the file to `data/` instead of Box. That lets you work on the look without spending credits.

## Customizing

* **Art:** the logo and the two background drawings are in `public/art/`.
* **Winter look:** the snowflake button switches between teal-and-pink and blues-and-crimson with falling snow. Winter colors are under `[data-season="holiday"]` in `public/style.css`.
* **Personality:** edit `systemPrompt()` in `server.js`.

## Notes

* A map search takes 20 to 60 seconds while the Actor runs. The chat shows what Jolly is doing in the meantime.
* Jolly only recommends organizations it found in search results. A card is marked "Registered nonprofit" only when the ProPublica lookup matches it.
* Church pantries, school drives, and mutual aid groups often aren't in IRS records. They can still show up, just without the badge.
