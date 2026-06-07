# Better Marketplace

A **personal, client-side** Chrome (Manifest V3) extension that overlays a small
custom panel on Facebook Marketplace. It shows, live as you scroll:

- **Searching in** — the location/area your current search is targeting.
- **Results arriving from** — the actual locations attached to the listings
  streaming in, with a count per location.

> "My search says X, but results are actually coming from A, B, C."

### How it works (and what it explicitly does *not* do)

Facebook renders Marketplace listings from structured JSON it fetches from its
own GraphQL endpoint. Instead of scraping the page's obfuscated HTML, this
extension **passively intercepts those fetches** (`window.fetch` and
`XMLHttpRequest`), reads the structured listing data as it arrives, and drives
its own UI from it.

- ✅ Everything runs locally, in your browser, on the real `facebook.com` page
  where you're already logged in as yourself.
- ✅ Responses are passed back to Facebook **completely untouched** — we observe,
  never block or rewrite. The page keeps working normally.
- ❌ No data is sent to any server. No analytics. No remote storage. No
  exfiltration. (The only stored state would be local-only via
  `chrome.storage.local`, and v1 doesn't even use it yet.)
- ❌ No automation — it never scrolls, clicks, or messages on your behalf. It's a
  passive reformatting of what you load by browsing normally.

This is for personal use only.

---

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked**.
4. Select this folder (`marketplace-lens`).
5. Go to `https://www.facebook.com/marketplace/…` — the **Better Marketplace**
   card appears in the top-right corner.

To pick up code changes: edit the files, then hit the **↻ reload** icon on the
extension card in `chrome://extensions`, and refresh the Marketplace tab.

### Using it

- The panel starts with: *"Waiting for Marketplace data… scroll to load
  listings."*
- As you scroll and Facebook loads more listings, **Results arriving from**
  fills in with locations and live counts.
- Click **–/+** in the header to collapse/expand.

---

## ⚠️ The one function you'll likely need to patch: `extractListings`

Facebook's GraphQL response shape is obfuscated and **changes over time**.
`extractListings()` in [`hook.js`](hook.js) is written defensively — it
**recursively searches the response tree** for nodes that "look like" listings
rather than following a brittle hard-coded path. But if Facebook changes things
enough, it may stop finding listings. When that happens:

- The panel shows a clear orange notice:
  *"Couldn't read listing data — Facebook may have changed format…"*
- The DevTools **console** logs (prefixed `[Better Marketplace]`) either how many
  listings were found, or a loud "found NO listing nodes" message **with the
  raw response object** so you can inspect it.

### How to inspect a real response and update the heuristics

1. On a Marketplace page, open **DevTools → Network**.
2. In the filter box, type `graphql`.
3. Scroll Marketplace to trigger listing loads; click one of the `graphql`
   requests.
4. Open the **Response** (or **Preview**) tab and explore the JSON. Find the
   array of listing objects. Note:
   - the field that holds the **title** (e.g. `marketplace_listing_title`),
   - the **price** object (e.g. `listing_price.formatted_amount` + `currency`),
   - the **location** (e.g. `location.reverse_geocode.city`, and
     `latitude`/`longitude`),
   - any `__typename` like `GroupCommerceProductItem`.
5. In [`hook.js`](hook.js), widen the candidate lists / heuristics:
   - `LISTING_TYPENAME_HINTS` — add any new listing `__typename` values.
   - `looksLikeListing(node)` — adjust which field signatures qualify a node.
   - `normalizeListing(node)` — add the real field names to the `pickFirst(...)`
     candidate arrays for each output field.
6. Reload the extension and refresh.

> **NDJSON gotcha:** Some Marketplace GraphQL responses are *line-delimited
> JSON* (several JSON objects separated by newlines), not a single object.
> `parseMaybeNDJSON()` in `hook.js` already handles both — keep that in mind if
> a raw response looks like multiple concatenated JSON blobs.

Every normalized listing keeps its original node under `raw`, so you can always
inspect unmapped fields from the console.

---

## Where each stub lives (for building v2+)

All stubs are clearly marked with `// STUB:` comments.

| Stub | File | What it's for |
| --- | --- | --- |
| `applyFilters(listings)` | [`content.js`](content.js) | Custom filtering: price-per-unit, distance radius from lat/lng, keyword allow/block lists, hide-already-seen, saved-search matching, custom re-sort. **v1: no-op pass-through.** |
| `annotateListing(listing)` | [`content.js`](content.js) | Tag/annotate individual listings (deal score, distance, tags). **v1: no-op.** |
| `setupDomObserver()` | [`content.js`](content.js) | `MutationObserver` wiring point to match filtered data back to DOM cards and hide/reorder them. **v1: observes but takes no action.** |
| `CONFIG` + persistence | [`content.js`](content.js) | Defaults object; the place to add user-configurable params and load/save them via `chrome.storage.local`. |

---

## File layout

| File | World | Role |
| --- | --- | --- |
| [`manifest.json`](manifest.json) | — | MV3 manifest; declares the two content scripts. |
| [`hook.js`](hook.js) | **MAIN** (page) | Hooks `fetch`/`XHR`, parses responses (incl. NDJSON), `extractListings()`, `extractSearchContext()`, `postMessage`s normalized data out. |
| [`content.js`](content.js) | **ISOLATED** | Owns the UI panel + state; receives messages; holds the stubs. |
| [`panel.css`](panel.css) | — | Self-contained styling, all classes prefixed `ml-`. |

### Why `hook.js` runs in the page's MAIN world

Content scripts run in an *isolated* JavaScript world and **cannot see or hook
the page's real `window.fetch`**. To intercept Facebook's own requests, the hook
must run in the page's **MAIN** world. We do this declaratively in
`manifest.json` with `"world": "MAIN"` (clean, reliable, Chrome 111+).

**Fallback (older approach):** if `"world": "MAIN"` isn't available, you can
instead have the isolated content script inject a `<script src=…>` tag pointing
at `hook.js` (declared as a `web_accessible_resource`). The page then executes
it in the MAIN world. Functionally equivalent; just more plumbing.

The MAIN-world hook talks to the isolated content script via
`window.postMessage` (same-origin, namespaced with a `__marketplaceLens` marker
that the content script verifies).

---

## Verify it works

1. Load unpacked — confirm there are **no manifest errors** on the extension card.
2. Open `facebook.com/marketplace/…` — the corner panel appears with the
   waiting/empty state.
3. **Searching in** reflects your current search/location.
4. Scroll — **Results arriving from** populates with locations + counts and
   updates live.
5. Open the DevTools **console** — confirm `[Better Marketplace]` logs show
   listings found (or a clear "found nothing" log telling you to patch
   `extractListings`).
6. Confirm Marketplace itself still behaves normally (responses pass through
   untouched).
