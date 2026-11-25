# Jolly: a giving agent on a Fly.io Sprite

Jolly is a cheerful agent that helps you find a local way to give: food banks, toy drives, meal delivery, family support, cash donations, or volunteer shifts. Tell it your city or ZIP and what you'd like to do. Jolly finds real places on the map and searches for drives and sign-up pages. It also checks organizations against IRS nonprofit records and gives you a short list of cards. Save the ones you like, then send your giving list to Box so it's ready at tax time.

It works all year, and it switches to a holiday look from mid-November to early January. The ❄ button toggles the look by hand.

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

1. **Create a Sprite**
   ```bash
   curl https://sprites.dev/install.sh | bash
   sprite login
   sprite create jolly
   sprite console -s jolly
   ```

2. **Add the connectors.** In the Fly.io dashboard, go to your org, then Sprites → Connectors → Add connector:
   * **Anthropic:** paste your Anthropic API key.
   * **Apify:** paste an Apify API token. Actor runs use Apify credits, and the free plan's monthly credit covers a demo.
   * **Box:** choose "Continue with Box" and approve file access.

   Grant each connector access to this Sprite. Connectors deny every Sprite until you do. Restrict access by name prefix, e.g. `jolly`.

3. **Get the code onto the Sprite.** Inside the console:
   ```bash
   git clone <your repo url> jolly && cd jolly
   ```

4. **Point the app at the connectors.** The app tries to find them on its own through `https://api.sprites.dev/v1/gateway/list`. To set them by hand, copy each connector's gateway URL from its page in the dashboard:
   ```bash
   export ANTHROPIC_GATEWAY_URL="https://api.sprites.dev/v1/gateway/anthropic/<connection_id>"
   export APIFY_GATEWAY_URL="https://api.sprites.dev/v1/gateway/apify/<connection_id>"
   export BOX_GATEWAY_URL="https://api.sprites.dev/v1/gateway/box/<connection_id>"
   ```
   Optional settings:
   | Variable | Default | What it does |
   |---|---|---|
   | `MODEL` | `claude-sonnet-5-5` | Claude model |
   | `BOX_FOLDER_ID` | `0` (root) | Box folder for the giving list |
   | `BOX_UPLOAD_PATH` | `/2.0` | Path prefix for Box uploads. Change it if the Box connector's "API Usage" example uses a different one. |
   | `APIFY_MAPS_ACTOR` | `compass~crawler-google-places` | Google Maps Actor |
   | `APIFY_SEARCH_ACTOR` | `apify~google-search-scraper` | Google Search Actor |

5. **Start it**
   ```bash
   node server.js
   curl localhost:8080/api/health   # anthropic, apify and box should all say true
   ```
   For a server that keeps running after you close the console, register it as a Sprite service; see `sprite-env --help` in the Sprite. The Sprite sleeps when it's idle, and a visit to its URL wakes it.

6. **Open it.** Each Sprite has its own HTTPS URL that routes to port 8080. Make the URL public so judges can try it.

## Try it without connectors

```bash
MOCK=1 node server.js
```
Mock mode returns sample results, and "Save list to Box" writes the file to `data/` instead of Box. That lets you work on the look without spending credits.

## Customizing

* **Mascot:** put an image at `public/art/jolly.png` and replace the placeholder in `public/index.html`.
* **Holiday look:** every holiday style is under `[data-season="holiday"]` in `public/style.css`.
* **Personality:** edit `systemPrompt()` in `server.js`.

## Notes

* A map search takes 20 to 60 seconds while the Actor runs. The chat shows what Jolly is doing in the meantime.
* Jolly only recommends organizations it found in search results. A card is marked "Registered nonprofit" only when the ProPublica lookup matches it.
* Church pantries, school drives, and mutual aid groups often aren't in IRS records. They can still show up, just without the badge.
