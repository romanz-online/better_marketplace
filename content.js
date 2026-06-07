/* ============================================================================
 * Better Marketplace — content.js  (runs in the ISOLATED content-script world)
 * ----------------------------------------------------------------------------
 * Owns ALL UI and state. Receives normalized listing data from hook.js via
 * window.postMessage and renders the corner panel:
 *
 *     "Searching in:"          — the intended search location
 *     "Results arriving from:" — actual result locations, with live counts
 *
 * This script never talks to the network and never touches Facebook's data
 * directly — it only consumes what hook.js hands it.
 * ==========================================================================*/

(() => {
  "use strict";

  if (window.__ML_CONTENT_INSTALLED__) return;
  window.__ML_CONTENT_INSTALLED__ = true;

  const TAG = "[Better Marketplace]";
  const MSG_TYPE = "ML_LISTINGS";

  /* ==========================================================================
   * CONFIG — defaults live here. This is the obvious home for user-configurable
   * settings later (loaded/saved via chrome.storage.local).
   * ========================================================================*/
  const CONFIG = {
    panelTitle: "Better Marketplace",
    startCollapsed: false,
    maxLocationsShown: 50, // cap the rendered location list for sanity
    // How many messages with zero listings (while we DO have a search context)
    // before we show the "couldn't read data" degraded notice.
    emptyResponsesBeforeWarning: 8,

    // User's true search radius in MILES (the FB UI value, e.g. "within 10
    // miles"). null = filtering OFF (everything passes through). Persisted.
    radiusMiles: null,
    // Buffer added to the radius to account for FB's intentional location
    // obfuscation. Kept in km to match the hook's distance math.
    bufferKm: 5,
  };

  const MILES_TO_KM = 1.60934;
  const STORAGE_KEY = "mlConfig";

  // Persistence: settings live in chrome.storage.local under STORAGE_KEY.
  function loadConfig(done) {
    try {
      chrome.storage.local.get(STORAGE_KEY, (obj) => {
        if (!chrome.runtime.lastError && obj && obj[STORAGE_KEY]) {
          const saved = obj[STORAGE_KEY];
          if (saved.radiusMiles != null && Number.isFinite(Number(saved.radiusMiles))) {
            CONFIG.radiusMiles = Number(saved.radiusMiles);
          }
        }
        if (typeof done === "function") done();
      });
    } catch {
      if (typeof done === "function") done();
    }
  }

  function saveConfig() {
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: { radiusMiles: CONFIG.radiusMiles },
      });
    } catch {
      /* best-effort */
    }
  }

  // Push the active filtering config to hook.js (MAIN world). radiusKm null =
  // filtering off. Called on init and whenever the radius changes, and in reply
  // to the hook's ML_CONFIG_REQ (it may have loaded before us).
  function pushConfigToPage() {
    try {
      const radiusKm =
        CONFIG.radiusMiles != null ? CONFIG.radiusMiles * MILES_TO_KM : null;
      window.postMessage(
        {
          __marketplaceLens: true,
          type: "ML_CONFIG",
          radiusKm,
          bufferKm: CONFIG.bufferKm,
        },
        window.location.origin
      );
    } catch {
      /* ignore */
    }
  }

  /* ==========================================================================
   * STATE
   * ========================================================================*/
  const state = {
    searchContext: null, // last { locationId, query, latitude, longitude, radiusKm }
    listingsById: new Map(), // id -> normalized listing (dedupe across scroll)
    locationCounts: new Map(), // locationName -> count
    cityCoords: new Map(), // locationName -> { lat, lng } | null (null = no coords)
    geocodeRequested: new Set(), // locationNames we've already asked to geocode
    listingsWithoutLocation: 0,
    collapsed: CONFIG.startCollapsed,
    emptyResponseStreak: 0, // consecutive messages with 0 listings
    sawAnyListing: false,
    filteredTotal: 0, // listings hidden from packets (out of radius), running sum
  };

  /* ==========================================================================
   * STUBS — clearly-marked extension points. None of these do anything in v1.
   * ========================================================================*/

  // STUB: applyFilters(listings)
  // v1 is a no-op pass-through. Later this is where custom filtering goes:
  //   - price-per-unit thresholds
  //   - distance radius computed from lat/lng vs. search center
  //   - keyword allow/block lists (title matching)
  //   - hide-already-seen (track seen ids in chrome.storage.local)
  //   - saved-search matching
  //   - custom re-sorting
  // Must return the (possibly filtered/reordered) array of listings.
  function applyFilters(listings) {
    // TODO: implement custom filtering. For now, pass everything through.
    return listings;
  }

  // Great-circle distance between two lat/lng points, in kilometres.
  // Pure local math (Haversine) — no network, no geocoding.
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth mean radius (km)
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // annotateListing(listing) — hook for per-listing tags. Distance is computed
  // at render time from the listing's CITY coordinates (Facebook only exposes a
  // city, not exact coordinates), so there's nothing to attach here in v1.
  function annotateListing(listing) {
    return listing;
  }

  // requestGeocode(name) — ask the background worker to resolve a city name to
  // coordinates (once per unique name). Results land in state.cityCoords and
  // trigger a re-render. Facebook gives us only a city, so this is the only way
  // to compute a kilometre distance.
  function requestGeocode(name) {
    if (!name || state.geocodeRequested.has(name)) return;
    state.geocodeRequested.add(name);
    state.cityCoords.set(name, null); // mark pending (null) until a reply lands
    try {
      chrome.runtime.sendMessage({ type: "ML_GEOCODE", q: name }, (resp) => {
        // A missing/closed channel shows up as lastError — ignore quietly.
        if (chrome.runtime.lastError || !resp) {
          state.cityCoords.set(name, false); // unresolved; stop showing "locating…"
          render();
          return;
        }
        if (resp.lat != null && resp.lng != null) {
          state.cityCoords.set(name, { lat: resp.lat, lng: resp.lng });
        } else {
          state.cityCoords.set(name, false); // not found: show name without distance
        }
        render();
      });
    } catch (err) {
      console.warn(TAG, "geocode request failed (ignored):", err);
    }
  }

  /* ==========================================================================
   * BRIDGE for hook.js (MAIN world) — it can't call chrome.runtime, so it asks
   * us to (a) relay city→coords geocode requests to the background worker, and
   * (b) hand it the current filtering config. Only same-window, namespaced
   * messages are trusted.
   * ========================================================================*/
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__marketplaceLens !== true) return;

    if (data.type === "ML_GEOCODE_REQ") {
      const reqId = data.reqId;
      const reply = (ok, lat, lng) => {
        try {
          window.postMessage(
            { __marketplaceLens: true, type: "ML_GEOCODE_RES", reqId, ok, lat, lng },
            window.location.origin
          );
        } catch {
          /* ignore */
        }
      };
      try {
        chrome.runtime.sendMessage({ type: "ML_GEOCODE", q: data.q }, (resp) => {
          if (chrome.runtime.lastError || !resp || resp.lat == null || resp.lng == null) {
            reply(false);
          } else {
            reply(true, resp.lat, resp.lng);
          }
        });
      } catch {
        reply(false);
      }
    } else if (data.type === "ML_CONFIG_REQ") {
      // Hook started up and wants the current config.
      pushConfigToPage();
    }
  });

  // STUB: setupDomObserver()
  // This is the clearly-labeled place where, later, we will match filtered
  // data back to the DOM cards Facebook already painted and hide/reorder them.
  // v1 OBSERVES ONLY and takes NO action on the DOM.
  let domObserver = null;
  function setupDomObserver() {
    try {
      if (domObserver) return;
      domObserver = new MutationObserver(() => {
        // TODO: when DOM filtering is implemented:
        //   1. Locate the results grid container.
        //   2. For each card, resolve its listing id (from its item URL/href).
        //   3. Cross-reference applyFilters() output; hide or reorder cards.
        // Intentionally a no-op in v1.
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
      console.debug(TAG, "DOM observer wired (no-op in v1).");
    } catch (err) {
      console.warn(TAG, "setupDomObserver failed (ignored):", err);
    }
  }

  /* ==========================================================================
   * DATA INGESTION
   * ========================================================================*/
  function ingestListings(listings) {
    if (!Array.isArray(listings) || listings.length === 0) return false;

    let addedAny = false;
    // Run through the (stubbed) filter/annotate pipeline before counting.
    const filtered = applyFilters(listings);

    for (const raw of filtered) {
      const listing = annotateListing(raw);
      if (!listing || !listing.id) {
        // No id → can't dedupe reliably; still count its location below.
      } else if (state.listingsById.has(listing.id)) {
        continue; // already counted this listing
      } else {
        state.listingsById.set(listing.id, listing);
      }

      addedAny = true;
      state.sawAnyListing = true;

      const loc = (listing.locationName || "").trim();
      if (loc) {
        state.locationCounts.set(loc, (state.locationCounts.get(loc) || 0) + 1);
        requestGeocode(loc); // resolve coords for distance (once per city)
      } else {
        state.listingsWithoutLocation += 1;
      }
    }
    return addedAny;
  }

  /* ==========================================================================
   * MESSAGE LISTENER — only trust same-window, correctly-shaped messages.
   * ========================================================================*/
  window.addEventListener("message", (event) => {
    // Security: must originate from THIS window (our MAIN-world hook), and
    // carry our namespace marker + expected type.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__marketplaceLens !== true || data.type !== MSG_TYPE) {
      return;
    }

    try {
      if (data.searchContext) {
        state.searchContext = data.searchContext;
      }

      if (typeof data.filteredCount === "number" && data.filteredCount > 0) {
        state.filteredTotal += data.filteredCount;
      }

      const added = ingestListings(data.listings);

      // Track empty-response streaks to drive the degraded-mode notice.
      if (Array.isArray(data.listings) && data.listings.length === 0) {
        state.emptyResponseStreak += 1;
      } else if (added) {
        state.emptyResponseStreak = 0;
      }

      render();
    } catch (err) {
      console.warn(TAG, "message handling error (ignored):", err);
    }
  });

  /* ==========================================================================
   * UI — build the corner card once, then re-render on each update.
   * ========================================================================*/
  let els = null;

  function buildPanel() {
    const root = document.createElement("div");
    root.className = "ml-panel";
    root.setAttribute("data-ml-collapsed", String(state.collapsed));

    // --- Header (title + collapse/expand toggle) ---
    const header = document.createElement("div");
    header.className = "ml-header";

    const title = document.createElement("div");
    title.className = "ml-title";
    title.innerHTML =
      '<span class="ml-dot"></span><span class="ml-title-text"></span>';
    title.querySelector(".ml-title-text").textContent = CONFIG.panelTitle;

    const toggle = document.createElement("button");
    toggle.className = "ml-toggle";
    toggle.type = "button";
    toggle.title = "Collapse / expand";
    toggle.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      // STUB: persist collapsed state via chrome.storage.local (saveConfig()).
      render();
    });

    header.appendChild(title);
    header.appendChild(toggle);

    // --- Body ---
    const body = document.createElement("div");
    body.className = "ml-body";

    // Section: Searching in
    const searchSection = document.createElement("section");
    searchSection.className = "ml-section ml-section--search";
    searchSection.innerHTML =
      '<div class="ml-section-label">Searching in</div>' +
      '<div class="ml-search-value"></div>';

    // Section: Radius control — the user's TRUE radius (FB's packet radius is
    // unreliable). Empty = filtering off. Drives packet-level filtering in hook.js.
    const radiusSection = document.createElement("section");
    radiusSection.className = "ml-section ml-section--radius";
    radiusSection.innerHTML =
      '<div class="ml-section-label">Show within</div>' +
      '<div class="ml-radius-row">' +
      '<input class="ml-radius-input" type="number" min="0" step="1" ' +
      'inputmode="decimal" placeholder="off" /> ' +
      '<span class="ml-radius-unit">miles</span>' +
      "</div>" +
      '<div class="ml-radius-hint"></div>';

    const radiusInput = radiusSection.querySelector(".ml-radius-input");
    if (CONFIG.radiusMiles != null) radiusInput.value = String(CONFIG.radiusMiles);

    const onRadiusChange = () => {
      const v = radiusInput.value.trim();
      if (v === "" || Number(v) <= 0 || !Number.isFinite(Number(v))) {
        CONFIG.radiusMiles = null; // off
      } else {
        CONFIG.radiusMiles = Number(v);
      }
      saveConfig();
      pushConfigToPage();
      render();
    };
    radiusInput.addEventListener("change", onRadiusChange);
    radiusInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        radiusInput.blur();
      }
    });

    // Section: Results arriving from
    const resultsSection = document.createElement("section");
    resultsSection.className = "ml-section ml-section--results";
    resultsSection.innerHTML =
      '<div class="ml-section-label">Results arriving from' +
      ' <span class="ml-total-badge"></span></div>' +
      '<div class="ml-dist-summary"></div>' +
      '<div class="ml-filtered-note"></div>' +
      '<ul class="ml-loc-list"></ul>' +
      '<div class="ml-empty"></div>';

    body.appendChild(searchSection);
    body.appendChild(radiusSection);
    body.appendChild(resultsSection);

    root.appendChild(header);
    root.appendChild(body);
    document.body.appendChild(root);

    els = {
      root,
      toggle,
      searchValue: searchSection.querySelector(".ml-search-value"),
      radiusInput,
      radiusHint: radiusSection.querySelector(".ml-radius-hint"),
      totalBadge: resultsSection.querySelector(".ml-total-badge"),
      distSummary: resultsSection.querySelector(".ml-dist-summary"),
      filteredNote: resultsSection.querySelector(".ml-filtered-note"),
      locList: resultsSection.querySelector(".ml-loc-list"),
      empty: resultsSection.querySelector(".ml-empty"),
    };
  }

  // Render "Searching in:" from the current search context.
  function renderSearchContext() {
    const ctx = state.searchContext;
    if (!ctx) {
      els.searchValue.textContent = "—";
      els.searchValue.classList.add("ml-muted");
      return;
    }
    els.searchValue.classList.remove("ml-muted");

    const parts = [];
    if (ctx.query) parts.push(`“${ctx.query}”`);
    if (ctx.locationId) parts.push(ctx.locationId);
    if (ctx.latitude != null && ctx.longitude != null) {
      parts.push(`(${ctx.latitude.toFixed(3)}, ${ctx.longitude.toFixed(3)})`);
    }
    if (ctx.radiusKm != null) parts.push(`· ${ctx.radiusKm} km`);

    els.searchValue.textContent = parts.length ? parts.join(" ") : "Marketplace";
  }

  // Format a distance in km for display: "<1 km", "12 km", "1,240 km".
  function formatKm(km) {
    if (km < 1) return "<1 km";
    if (km < 100) return `${Math.round(km)} km`;
    return `${Math.round(km).toLocaleString()} km`;
  }

  // Distance (km) from the search center to a city's resolved coordinates,
  // or undefined when either the center or the city's coords are unknown.
  function cityDistanceKm(name) {
    const ctx = state.searchContext;
    if (!ctx || ctx.latitude == null || ctx.longitude == null) return undefined;
    const c = state.cityCoords.get(name);
    if (!c || typeof c !== "object") return undefined; // null=pending, false=unresolved
    return haversineKm(ctx.latitude, ctx.longitude, c.lat, c.lng);
  }

  // Render the compact distance summary (nearest / median / farthest, and the
  // count beyond the active radius). Hidden when no distances are available.
  // Distances are computed here (render time) since geocoding is asynchronous;
  // each listing counts at its city's distance.
  function renderDistanceSummary() {
    const d = [];
    for (const [name, count] of state.locationCounts) {
      const km = cityDistanceKm(name);
      if (km != null) for (let i = 0; i < count; i++) d.push(km);
    }
    if (!d.length) {
      els.distSummary.style.display = "none";
      els.distSummary.textContent = "";
      return;
    }
    const sorted = d.sort((a, b) => a - b);
    const nearest = sorted[0];
    const farthest = sorted[sorted.length - 1];
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    const parts = [
      `nearest ${formatKm(nearest)}`,
      `median ${formatKm(median)}`,
      `farthest ${formatKm(farthest)}`,
    ];

    const radius = state.searchContext && state.searchContext.radiusKm;
    if (typeof radius === "number" && Number.isFinite(radius)) {
      const beyond = sorted.filter((x) => x > radius).length;
      if (beyond > 0) parts.push(`${beyond} beyond ${formatKm(radius)}`);
    }

    els.distSummary.style.display = "block";
    els.distSummary.textContent = parts.join(" · ");
  }

  // Render the live "Results arriving from:" location list.
  function renderResults() {
    const total = state.listingsById.size;
    els.totalBadge.textContent = total ? `${total}` : "";

    // Sort locations by count desc, then name asc.
    const entries = Array.from(state.locationCounts.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );

    els.locList.innerHTML = "";
    renderDistanceSummary();

    if (!state.sawAnyListing) {
      // Initial / empty state.
      els.distSummary.style.display = "none";
      els.locList.style.display = "none";
      els.empty.style.display = "block";

      const driftMode =
        !!state.searchContext &&
        state.emptyResponseStreak >= CONFIG.emptyResponsesBeforeWarning;

      if (driftMode) {
        // Degraded mode: we're clearly seeing GraphQL traffic but extracting
        // nothing — most likely Facebook changed its response shape.
        els.empty.classList.add("ml-warn");
        els.empty.textContent =
          "Couldn't read listing data — Facebook may have changed format. " +
          "Open DevTools console and update extractListings() in hook.js.";
      } else {
        els.empty.classList.remove("ml-warn");
        els.empty.textContent =
          "Waiting for Marketplace data… scroll to load listings.";
      }
      return;
    }

    els.empty.style.display = "none";
    els.locList.style.display = "block";

    const shown = entries.slice(0, CONFIG.maxLocationsShown);
    for (const [name, count] of shown) {
      const li = document.createElement("li");
      li.className = "ml-loc-item";

      const nameEl = document.createElement("span");
      nameEl.className = "ml-loc-name";
      const km = cityDistanceKm(name);
      if (km != null) {
        nameEl.textContent = `${name} — ~${formatKm(km)}`;
      } else if (state.cityCoords.get(name) === null) {
        nameEl.textContent = `${name} — locating…`; // geocode in flight
      } else {
        nameEl.textContent = name;
      }
      nameEl.title = name;

      const countEl = document.createElement("span");
      countEl.className = "ml-loc-count";
      countEl.textContent = String(count);

      li.appendChild(nameEl);
      li.appendChild(countEl);
      els.locList.appendChild(li);
    }

    // Footer notes: unknown-location count + truncation note.
    if (state.listingsWithoutLocation > 0) {
      const li = document.createElement("li");
      li.className = "ml-loc-item ml-loc-item--muted";
      li.innerHTML =
        '<span class="ml-loc-name">No location given</span>' +
        '<span class="ml-loc-count"></span>';
      li.querySelector(".ml-loc-count").textContent = String(
        state.listingsWithoutLocation
      );
      els.locList.appendChild(li);
    }
    if (entries.length > shown.length) {
      const li = document.createElement("li");
      li.className = "ml-loc-note";
      li.textContent = `+ ${entries.length - shown.length} more locations…`;
      els.locList.appendChild(li);
    }
  }

  // Render the radius hint + the "N hidden" note from current state.
  function renderFilterStatus() {
    if (CONFIG.radiusMiles != null) {
      const km = Math.round(CONFIG.radiusMiles * MILES_TO_KM);
      els.radiusHint.textContent = `filtering · +${CONFIG.bufferKm} km buffer (~${km} km)`;
      els.radiusHint.classList.remove("ml-muted");
    } else {
      els.radiusHint.textContent = "off — set a radius to hide far listings";
      els.radiusHint.classList.add("ml-muted");
    }

    if (state.filteredTotal > 0) {
      els.filteredNote.style.display = "block";
      els.filteredNote.textContent = `${state.filteredTotal} hidden (out of radius)`;
    } else {
      els.filteredNote.style.display = "none";
      els.filteredNote.textContent = "";
    }
  }

  function render() {
    if (!els) return;
    els.root.setAttribute("data-ml-collapsed", String(state.collapsed));
    els.toggle.textContent = state.collapsed ? "+" : "–";
    renderSearchContext();
    renderFilterStatus();
    renderResults();
  }

  /* ==========================================================================
   * INIT
   * ========================================================================*/
  function init() {
    if (!document.body) {
      // document_idle should guarantee body, but be safe.
      window.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    // Load persisted settings BEFORE building the panel so the radius input is
    // pre-filled, then push the config to the hook (MAIN world).
    loadConfig(() => {
      buildPanel();
      render();
      pushConfigToPage();
      setupDomObserver(); // no-op observer (stub) in v1
      console.debug(TAG, "content.js UI ready.");
    });
  }

  init();
})();
