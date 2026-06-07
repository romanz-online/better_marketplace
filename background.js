/* ============================================================================
 * Marketplace Lens — background.js  (MV3 service worker)
 * ----------------------------------------------------------------------------
 * Sole job: turn a city name (e.g. "Gardner, Massachusetts") into coordinates
 * so content.js can compute the distance from the search center.
 *
 * WHY A SERVICE WORKER: in MV3 a content script's cross-origin fetch is subject
 * to page CORS, but a background worker with host_permissions can call the
 * geocoder directly. content.js messages us; we answer with {lat,lng}|{error}.
 *
 * POLITENESS: Facebook listings expose only a CITY, so we geocode UNIQUE city
 * names — never per-listing — cache them permanently in chrome.storage.local,
 * and serialise requests to ~1/sec to respect the geocoder's usage policy.
 * ==========================================================================*/

"use strict";

// Geocoding provider. Swap this single line (and the response parser in
// geocodeRemote) to use a different/keyed service later.
const GEOCODER_URL = "https://nominatim.openstreetmap.org/search";

const CACHE_PREFIX = "mlGeo:"; // chrome.storage.local key prefix
const MIN_REQUEST_GAP_MS = 1100; // serialise to ~1 req/sec (Nominatim policy)
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // retry "not found" after a day

// ----- serial, throttled request queue -------------------------------------
let chain = Promise.resolve(); // tail of the serial promise chain
let lastRequestAt = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Schedule fn() to run after the previous request AND the min gap have elapsed.
function enqueue(fn) {
  const run = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - now);
    if (wait) await delay(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive regardless of individual failures.
  chain = run.catch(() => {});
  return run;
}

// ----- cache helpers --------------------------------------------------------
function cacheKey(q) {
  return CACHE_PREFIX + q.trim().toLowerCase();
}

function getCached(q) {
  return new Promise((resolve) => {
    const key = cacheKey(q);
    try {
      chrome.storage.local.get(key, (obj) => {
        if (chrome.runtime.lastError) return resolve(undefined);
        resolve(obj ? obj[key] : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function setCached(q, value) {
  try {
    chrome.storage.local.set({ [cacheKey(q)]: value });
  } catch {
    /* cache is best-effort */
  }
}

// ----- the actual network call ---------------------------------------------
async function geocodeRemote(q) {
  const url =
    GEOCODER_URL +
    "?format=json&limit=1&q=" +
    encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("geocoder HTTP " + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null; // not found
  const lat = Number(arr[0].lat);
  const lng = Number(arr[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// Resolve a query to {lat,lng} | {error}, using cache + the throttled queue.
async function geocode(q) {
  if (typeof q !== "string" || !q.trim()) return { error: "empty query" };

  const cached = await getCached(q);
  if (cached) {
    if (cached.lat != null && cached.lng != null) {
      return { lat: cached.lat, lng: cached.lng };
    }
    // Negative cache entry — honour it until its TTL expires.
    if (cached.notFound && Date.now() - (cached.at || 0) < NEGATIVE_TTL_MS) {
      return { error: "not found (cached)" };
    }
  }

  try {
    const coords = await enqueue(() => geocodeRemote(q));
    if (coords) {
      setCached(q, { lat: coords.lat, lng: coords.lng, at: Date.now() });
      return coords;
    }
    setCached(q, { notFound: true, at: Date.now() });
    return { error: "not found" };
  } catch (err) {
    // Don't cache transient errors — allow a later retry.
    return { error: String((err && err.message) || err) };
  }
}

// ----- message bridge -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "ML_GEOCODE") return false;
  geocode(msg.q).then(sendResponse);
  return true; // keep the message channel open for the async response
});
