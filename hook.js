/* ============================================================================
 * Better Marketplace — hook.js  (runs in the PAGE'S MAIN WORLD)
 * ----------------------------------------------------------------------------
 * This file is injected into Facebook's own JavaScript context (manifest:
 * "world": "MAIN") so it can observe the real window.fetch / XMLHttpRequest
 * calls Facebook uses to load Marketplace listings from its GraphQL endpoint.
 *
 * GOLDEN RULES (do not break these):
 *   1. PASSIVE ONLY. We observe. We pass every response back to Facebook
 *      completely untouched. We never block, delay meaningfully, or rewrite.
 *   2. NEVER THROW INTO THE PAGE. Every bit of our own parsing is wrapped in
 *      try/catch. If our code fails, Facebook must keep working as if we
 *      weren't here.
 *   3. CLIENT-SIDE ONLY. We only postMessage extracted data to our own
 *      content script (same window, same origin). Nothing is sent anywhere.
 *
 * The single most fragile thing here is extractListings(): Facebook's GraphQL
 * response shape is obfuscated and changes over time. It is written
 * defensively (tree search, not a hard-coded path) and is the function you'll
 * most likely tweak. See the big comment block above it.
 * ==========================================================================*/

(() => {
  "use strict";

  // Guard against double-injection (e.g. SPA navigations re-running scripts).
  if (window.__ML_HOOK_INSTALLED__) return;
  window.__ML_HOOK_INSTALLED__ = true;

  const TAG = "[Better Marketplace]";
  const MSG_TYPE = "ML_LISTINGS";

  // DIAGNOSTIC: when true, log ONE raw listing node + the request variables the
  // first time we extract listings. Use this to discover the current Facebook
  // GraphQL shape (where lat/lng + city live), then set the field paths in
  // normalizeListing()/extractSearchContext() and flip this back to false.
  const ML_DEBUG = false;
  let ml_debugDumped = false;

  /* --------------------------------------------------------------------------
   * postMessageOut — the ONLY way data leaves this hook. Goes to our own
   * content script via window.postMessage (same-origin). The content script
   * verifies event.source === window and the message shape before trusting it.
   * ------------------------------------------------------------------------*/
  function postMessageOut(payload) {
    try {
      window.postMessage(
        {
          __marketplaceLens: true, // namespacing marker so content.js can filter
          type: MSG_TYPE,
          ...payload,
        },
        window.location.origin // restrict target origin; never "*"
      );
    } catch (err) {
      // Swallow — must never disrupt the page.
      console.warn(TAG, "postMessage failed", err);
    }
  }

  /* --------------------------------------------------------------------------
   * parseMaybeNDJSON — Facebook's GraphQL responses are SOMETIMES a single
   * JSON object and SOMETIMES line-delimited JSON (NDJSON): multiple JSON
   * objects separated by newlines, used for streamed/deferred GraphQL chunks.
   *
   * Returns an array of parsed objects (one entry for the single-object case,
   * many for the NDJSON case). Lines that don't parse are skipped quietly.
   * ------------------------------------------------------------------------*/
  function parseMaybeNDJSON(text) {
    const results = [];
    if (!text || typeof text !== "string") return results;

    // Fast path: try the whole body as one JSON document first.
    try {
      results.push(JSON.parse(text));
      return results;
    } catch {
      // Not a single JSON doc — fall through to NDJSON handling.
    }

    // NDJSON path: parse each non-empty line independently.
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // A partial/non-JSON line — ignore it. (Common in streamed responses.)
      }
    }
    return results;
  }

  /* ==========================================================================
   * extractListings(responseJson)  ← THE FRAGILE, MOST-PATCHED FUNCTION
   * --------------------------------------------------------------------------
   * Goal: given one parsed GraphQL response object, return an array of
   * NORMALIZED listing objects:
   *
   *     { id, title, price, currency, locationName,
   *       latitude, longitude, createdTime, url, raw }
   *
   * WHY THIS IS WRITTEN AS A TREE SEARCH (and not response.data.foo.bar.edges):
   *   Facebook's response keys are obfuscated and unstable. Hard-coding one
   *   path breaks the moment they reshuffle. Instead we recursively walk the
   *   whole response tree and collect any node that "looks like" a marketplace
   *   listing, using a set of loose heuristics. When their shape drifts, you
   *   usually only need to widen the heuristics below — not rewrite a path.
   *
   * HOW TO DISCOVER THE REAL SHAPE (see README):
   *   DevTools → Network → filter "graphql" → scroll Marketplace → click a
   *   response → find the array of listings → confirm/extend the field-name
   *   candidates in pickFirst(...) below.
   * ========================================================================*/

  // __typename values (and substrings) that strongly indicate a listing node.
  // Add new ones here if you spot them in real responses.
  const LISTING_TYPENAME_HINTS = [
    "GroupCommerceProductItem",
    "MarketplaceListing",
    "Listing",
    "CommerceProductItem",
  ];

  // Helper: read the first present, non-null value among several candidate keys.
  function pickFirst(obj, keys) {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  }

  // Heuristic: does this plain object look like a marketplace listing node?
  //
  // Facebook's current search feed wraps each listing in a
  // MarketplaceFeedGeneralListingObject whose own `id` is a story UUID and
  // whose real fields are split across child objects (`data`/`entity`/
  // `listing`). We detect the WRAPPER and let normalizeListing() pull the
  // pieces together — and we deliberately do NOT treat the bare inner
  // `entity`/`listing` (which carry no title/price of their own) as standalone
  // listings, so each item is counted once.
  function looksLikeListing(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;

    // Signal 0: the feed wrapper — recognised by typename, or by carrying both
    // a `data` block and an `entity`/`listing` block.
    if (node.__typename === "MarketplaceFeedGeneralListingObject") return true;
    if (
      node.data &&
      typeof node.data === "object" &&
      (node.entity || node.listing)
    ) {
      return true;
    }

    // Signal 1: an explicit __typename that matches a known listing type —
    // but only when the node actually carries listing data itself (a title or
    // a price). A bare GroupCommerceProductItem fragment (just id + location,
    // or id + creation_time) is part of a wrapper, not a listing on its own.
    const typename = node.__typename;
    const hasTitleish =
      node.marketplace_listing_title !== undefined ||
      node.custom_title !== undefined ||
      node.title !== undefined;
    const hasPrice =
      node.listing_price !== undefined ||
      node.formatted_price !== undefined ||
      node.price !== undefined;
    if (typeof typename === "string" && (hasTitleish || hasPrice)) {
      for (const hint of LISTING_TYPENAME_HINTS) {
        if (typename.includes(hint)) return true;
      }
    }

    // Signal 2: shape-based — has an id AND something price-like AND something
    // title/location-like. This catches flat listings even when __typename
    // changes.
    const hasId = node.id !== undefined || node.legacy_id !== undefined;
    const hasLocationish =
      node.location !== undefined ||
      node.location_text !== undefined ||
      node.locationName !== undefined ||
      node.reverse_geocode !== undefined;

    if (hasId && hasPrice && (hasTitleish || hasLocationish)) return true;

    return false;
  }

  // Normalize a raw listing node into our clean, stable shape.
  //
  // Handles BOTH the current feed-wrapper shape (fields split across
  // `data`/`entity`/`listing`) AND a hypothetical flat listing, by reading
  // each field from the wrapper's sub-objects first and falling back to the
  // node itself. Each lookup uses a list of candidate keys (defensive against
  // renames).
  function normalizeListing(node) {
    // Wrapper sub-objects (may be absent on a flat listing — default to {}).
    const data = node.data && typeof node.data === "object" ? node.data : {};
    const entity =
      node.entity && typeof node.entity === "object" ? node.entity : {};
    const listing =
      node.listing && typeof node.listing === "object" ? node.listing : {};

    // --- price + currency (FB nests these a few different ways) ---
    let price;
    let currency;
    const priceObj =
      pickFirst(data, ["price"]) ||
      pickFirst(node, ["listing_price", "price"]) ||
      node.formatted_price;
    if (priceObj && typeof priceObj === "object") {
      // e.g. { amount_with_offset: "600000", currency: "USD" } (minor units),
      // or { amount: "120", currency: "USD", formatted_amount: "$120" }.
      price = pickFirst(priceObj, [
        "formatted_amount",
        "amount",
        "amount_with_offset",
        "text",
      ]);
      currency = pickFirst(priceObj, ["currency"]);
    } else if (typeof priceObj === "string" || typeof priceObj === "number") {
      price = priceObj;
    }

    // --- location: name + (rarely) lat/lng ---
    // Real listings only expose a reverse-geocoded city, not coordinates, so
    // locationName is the important output. It doubles as the geocoding query
    // in content.js, so prefer the most specific human-readable form.
    let locationName;
    let latitude;
    let longitude;
    const loc =
      pickFirst(entity, ["location"]) ||
      pickFirst(node, ["location"]) ||
      pickFirst(node, ["reverse_geocode", "reverse_geocode_detailed"]);
    if (loc && typeof loc === "object") {
      const rg = pickFirst(loc, ["reverse_geocode", "reverse_geocode_detailed"]);
      if (rg && typeof rg === "object") {
        // Prefer "City, State" via city_page.display_name; else build it.
        const cityPage = pickFirst(rg, ["city_page"]);
        const displayName =
          cityPage && typeof cityPage === "object"
            ? pickFirst(cityPage, ["display_name", "name"])
            : undefined;
        const city = pickFirst(rg, ["city", "name", "text"]);
        const stateName = pickFirst(rg, ["state", "region"]);
        if (typeof displayName === "string") {
          locationName = displayName;
        } else if (typeof city === "string" && typeof stateName === "string") {
          locationName = `${city}, ${stateName}`;
        } else if (typeof city === "string") {
          locationName = city;
        }
      } else if (typeof rg === "string") {
        locationName = rg;
      }
      // Fallback to flatter name fields on the location object.
      if (locationName === undefined) {
        locationName = pickFirst(loc, [
          "city",
          "city_page_name",
          "name",
          "text",
          "display_name",
        ]);
      }
      // Coordinates are not present on real listings today, but read them if a
      // future/other response ever includes them.
      const latlng = pickFirst(loc, ["latitude_longitude", "coordinates"]) || loc;
      if (latlng && typeof latlng === "object") {
        latitude = pickFirst(latlng, ["latitude", "lat"]);
        longitude = pickFirst(latlng, ["longitude", "lng", "lon"]);
      }
    }
    // Flat fallbacks.
    if (locationName === undefined) {
      locationName = pickFirst(node, ["location_text", "locationName"]);
    }

    // --- id / title / url / time ---
    // Prefer the real listing id (entity_id / entity.id / listing.id) over the
    // wrapper's own `id`, which is a story UUID.
    const id =
      pickFirst(node, ["entity_id"]) ||
      pickFirst(entity, ["id"]) ||
      pickFirst(listing, ["id"]) ||
      pickFirst(node, ["id", "legacy_id", "story_key"]);
    const title = pickFirst(
      { ...node, ...data },
      ["marketplace_listing_title", "custom_title", "title"]
    );
    const createdTime =
      pickFirst(listing, ["creation_time", "created_time"]) ||
      pickFirst(node, ["creation_time", "created_time", "creation_timestamp"]);

    let url = pickFirst(node, ["share_uri", "url", "story_uri"]);
    if (!url && id) {
      // Build a canonical Marketplace item URL from the id as a last resort.
      url = `https://www.facebook.com/marketplace/item/${id}/`;
    }

    return {
      id: id != null ? String(id) : undefined,
      title: typeof title === "string" ? title : undefined,
      price,
      currency,
      locationName: typeof locationName === "string" ? locationName : undefined,
      latitude: latitude != null ? Number(latitude) : undefined,
      longitude: longitude != null ? Number(longitude) : undefined,
      createdTime,
      url,
      raw: node, // keep the original node so you can inspect unmapped fields
    };
  }

  // Recursively walk an arbitrary parsed-JSON tree, collecting listing nodes.
  // Uses a visited set + depth guard so a pathological/cyclic object can't hang.
  function collectListings(root) {
    const found = [];
    const seen = new Set();
    const MAX_DEPTH = 40;

    function walk(node, depth) {
      if (depth > MAX_DEPTH || node === null || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }

      if (looksLikeListing(node)) {
        found.push(node);
        // Do NOT return — a listing node can still contain nested children
        // we don't care about, but stopping here avoids double-counting the
        // same listing reached via a different branch (the seen-set handles
        // identity, so it's safe to keep walking; we just won't re-add it).
      }

      for (const key in node) {
        // Skip our own injected marker if it ever appears.
        if (key === "__marketplaceLens") continue;
        try {
          walk(node[key], depth + 1);
        } catch {
          // Some FB objects have throwing getters — skip them.
        }
      }
    }

    walk(root, 0);
    return found;
  }

  function extractListings(responseJson) {
    try {
      const rawNodes = collectListings(responseJson);
      if (rawNodes.length === 0) {
        // IMPORTANT: surface "found nothing" loudly so shape-drift is visible.
        console.debug(
          TAG,
          "extractListings found NO listing nodes in this response.",
          "If Marketplace clearly has listings, the response shape may have",
          "changed — inspect this object and widen the heuristics in hook.js.",
          responseJson
        );
        return [];
      }
      const normalized = rawNodes.map(normalizeListing);
      console.debug(TAG, `extractListings found ${normalized.length} listing(s).`);
      return normalized;
    } catch (err) {
      console.warn(TAG, "extractListings threw (ignored):", err);
      return [];
    }
  }

  /* ==========================================================================
   * extractSearchContext(url, requestVars)
   * --------------------------------------------------------------------------
   * Determine the INTENDED search location — "where I'm searching" — from:
   *   (a) the page URL path/query, and
   *   (b) the intercepted GraphQL request variables when we have them.
   *
   * Returns: { locationId, query, latitude, longitude, radiusKm, source }
   * Any field may be undefined; the UI handles partial data.
   * ========================================================================*/
  function extractSearchContext(url, requestVars) {
    const ctx = { source: "url" };
    try {
      const u = new URL(url, window.location.origin);

      // Path patterns:
      //   /marketplace/<location_id>/search/?query=...
      //   /marketplace/category/<cat>/?...
      const segments = u.pathname.split("/").filter(Boolean); // drop empties
      const mpIdx = segments.indexOf("marketplace");
      if (mpIdx !== -1 && segments[mpIdx + 1]) {
        const next = segments[mpIdx + 1];
        if (next !== "category" && next !== "item" && next !== "search") {
          // Likely a location id / slug, e.g. "nyc" or a numeric id.
          ctx.locationId = next;
        }
      }

      // Query params commonly carried on Marketplace searches.
      const qp = u.searchParams;
      ctx.query = qp.get("query") || undefined;
      const lat = qp.get("latitude");
      const lng = qp.get("longitude");
      const radius = qp.get("radius") || qp.get("radius_km");
      if (lat) ctx.latitude = Number(lat);
      if (lng) ctx.longitude = Number(lng);
      if (radius) ctx.radiusKm = Number(radius);
    } catch {
      // Ignore URL parse issues.
    }

    // Merge in anything we found in the GraphQL request variables — these are
    // usually richer/more authoritative than the URL.
    try {
      if (requestVars && typeof requestVars === "object") {
        const v =
          requestVars.params ||
          requestVars.variables ||
          requestVars; // tolerate different nesting
        if (v && typeof v === "object") {
          // Current shape: variables.buyLocation { latitude, longitude } and a
          // top-level variables.radius. Tolerate older snake_case too.
          const buyLoc = v.buyLocation || v.buy_location || v.location || {};
          if (buyLoc.latitude != null) ctx.latitude = Number(buyLoc.latitude);
          if (buyLoc.longitude != null) ctx.longitude = Number(buyLoc.longitude);
          if (v.radius != null) ctx.radiusKm = Number(v.radius);
          else if (v.radius_km != null) ctx.radiusKm = Number(v.radius_km);
          if (v.query) ctx.query = v.query;
          if (v.location_vanity_or_id) ctx.locationId = v.location_vanity_or_id;
          ctx.source = "request+url";
        }
      }
    } catch {
      // Ignore — partial context is fine.
    }

    return ctx;
  }

  /* --------------------------------------------------------------------------
   * Best-effort: only bother parsing responses that look like GraphQL calls,
   * to keep overhead off unrelated requests (images, etc.).
   * ------------------------------------------------------------------------*/
  function isInterestingUrl(url) {
    if (typeof url !== "string") return false;
    return url.includes("/api/graphql") || url.includes("graphql");
  }

  // Shared: given a response body + the request URL + (optional) request vars,
  // parse, extract, and emit. Wrapped so callers never see an exception.
  function handleResponseBody(bodyText, url, requestVars) {
    try {
      const docs = parseMaybeNDJSON(bodyText);
      let allListings = [];
      for (const doc of docs) {
        const listings = extractListings(doc);
        if (listings.length) allListings = allListings.concat(listings);
      }

      // DIAGNOSTIC: dump one raw listing node + the request vars exactly once,
      // so the real location field paths can be confirmed. See ML_DEBUG above.
      if (ML_DEBUG && !ml_debugDumped && allListings.length) {
        ml_debugDumped = true;
        try {
          console.log(
            TAG,
            "ML_DEBUG sample raw listing node →",
            allListings[0].raw
          );
          console.log(TAG, "ML_DEBUG request variables →", requestVars);
          console.log(
            TAG,
            "ML_DEBUG: copy the two objects above (right-click → Store/Copy)",
            "and send them back so the lat/lng + location paths can be set."
          );
        } catch {
          /* never disrupt the page */
        }
      }

      const searchContext = extractSearchContext(
        window.location.href,
        requestVars
      );

      // Always emit search context (cheap) so the panel can show "Searching in"
      // even before any listings arrive. Only emit listings when we have some.
      postMessageOut({
        listings: allListings,
        searchContext,
        source: url,
      });
    } catch (err) {
      console.warn(TAG, "handleResponseBody error (ignored):", err);
    }
  }

  // Try to pull GraphQL variables out of a request body (form-encoded "variables"
  // field, or a raw JSON body). Best-effort; returns undefined on failure.
  function parseRequestVars(body) {
    try {
      if (!body) return undefined;
      if (typeof body === "string") {
        // Form-encoded: variables={...}&doc_id=...
        if (body.includes("variables=")) {
          const params = new URLSearchParams(body);
          const raw = params.get("variables");
          if (raw) return JSON.parse(raw);
        }
        // Raw JSON body.
        if (body.trim().startsWith("{")) return JSON.parse(body);
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /* ==========================================================================
   * HOOK 1: window.fetch
   * ========================================================================*/
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      // Call the REAL fetch immediately and return its promise to the caller.
      const promise = originalFetch.apply(this, args);

      // Observe without altering: clone the resolved response and read the
      // clone's body, so Facebook still consumes the original stream normally.
      promise
        .then((response) => {
          try {
            const url =
              (response && response.url) ||
              (typeof args[0] === "string" ? args[0] : args[0]?.url) ||
              "";
            if (!isInterestingUrl(url)) return;

            const requestVars = parseRequestVars(
              args[1] && args[1].body ? args[1].body : undefined
            );

            response
              .clone()
              .text()
              .then((text) => handleResponseBody(text, url, requestVars))
              .catch(() => {
                /* clone read failed — ignore, page unaffected */
              });
          } catch {
            /* never disrupt the page */
          }
        })
        .catch(() => {
          /* the page's own fetch rejected — not our concern */
        });

      return promise; // ← original promise, untouched
    };
    // Preserve identity hints some code checks for.
    try {
      window.fetch.toString = () => originalFetch.toString();
    } catch {
      /* ignore */
    }
    console.debug(TAG, "fetch hook installed.");
  }

  /* ==========================================================================
   * HOOK 2: XMLHttpRequest  (some GraphQL traffic still goes via XHR)
   * ========================================================================*/
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url, ...rest) {
      // Stash request metadata on the instance for use in the load handler.
      try {
        this.__ml_url = url;
      } catch {
        /* ignore */
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function (body) {
      try {
        const url = this.__ml_url || "";
        if (isInterestingUrl(url)) {
          const requestVars = parseRequestVars(body);
          // Attach a passive listener; do not consume/alter responseText.
          this.addEventListener("load", function () {
            try {
              // responseText is only valid for "" / "text" responseType.
              if (this.responseType === "" || this.responseType === "text") {
                handleResponseBody(this.responseText, url, requestVars);
              }
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* never disrupt the page */
      }
      return originalSend.call(this, body);
    };
    console.debug(TAG, "XMLHttpRequest hook installed.");
  }

  console.debug(TAG, "hook.js ready (MAIN world).");
})();
