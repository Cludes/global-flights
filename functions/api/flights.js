/**
 * Cloudflare Pages Function - GET /api/flights  (GLOBAL, keyless + live)
 *
 * OpenSky can't be reached from Cloudflare (522) and its free tier caps at ~90s anyway,
 * so for a genuinely LIVE global map we sweep a grid of points across the world's busy
 * regions using the keyless community ADS-B aggregators (which work from Cloudflare),
 * merge + de-dupe by hex, add CORS, and edge-cache 25s.
 *
 * Coverage is feeder-dependent: excellent over Europe / N America / E Asia / Australia,
 * sparser over remote oceans and quiet regions.
 */

const UA = 'global-flights/1.0 (+https://global-flights.pages.dev)';
const CACHE_TTL = 25;

// [lat, lon, radius_nm] across the world's busy aviation regions. Kept to a count where
// points x 2 sources stays under Cloudflare's 50-subrequest/request limit.
const POINTS = [
  [53, 0, 250], [48, 11, 250], [40, 0, 250], [52, 24, 250], [39, 32, 250], // Europe
  [25, 52, 250], [27, 77, 250], [13, 80, 250],                              // Middle East + India
  [9, 100, 250], [-2, 107, 250], [31, 117, 250], [36, 138, 250],            // SE Asia + E Asia
  [43, -74, 250], [33, -86, 250], [39, -104, 250], [37, -120, 250],         // North America
  [-23, -46, 250], [-34, -62, 250],                                         // South America
  [30, 31, 250], [-29, 25, 250],                                            // Africa
  [-33, 148, 250],                                                          // Australia
];

const HOSTS = [
  (la, lo, d) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${d}`,
  (la, lo, d) => `https://api.airplanes.live/v2/point/${la}/${lo}/${d}`,
];

async function fetchPoint([la, lo, d]) {
  for (const host of HOSTS) {
    try {
      const r = await fetch(host(la, lo, d), { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.ac)) return j.ac;
    } catch (e) { /* next host */ }
  }
  return [];
}

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/__global_flights', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  const results = await Promise.all(POINTS.map(fetchPoint));

  const seen = new Set();
  const aircraft = [];
  for (const arr of results) {
    for (const a of arr) {
      if (a.lat == null || a.lon == null || a.alt_baro === 'ground') continue;
      if (seen.has(a.hex)) continue;
      seen.add(a.hex);
      aircraft.push({
        hex: a.hex,
        flight: (a.flight || '').trim() || null,
        reg: a.r || null,
        type: a.t || null,
        lat: a.lat,
        lon: a.lon,
        alt: typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom ?? null),
        speed: a.gs ?? null,
        track: a.track ?? a.true_heading ?? null,
        vsi: a.baro_rate ?? a.geom_rate ?? null,
        squawk: a.squawk || null,
      });
    }
  }

  if (!aircraft.length) return cors(json({ error: 'all upstream sources failed' }, 502));

  const resp = json({ fetched_at: new Date().toISOString(), count: aircraft.length, aircraft });
  resp.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return cors(resp);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return new Response(resp.body, { status: resp.status, headers: h });
}
