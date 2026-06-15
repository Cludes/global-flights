/**
 * Cloudflare Pages Function - GET /api/flights  (GLOBAL via OpenSky Network)
 *
 * OpenSky returns the whole planet's traffic in one /states/all call, but needs an
 * OAuth2 client (free account). Set these as Pages secrets:
 *   OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET
 * Until they're set, this returns a "not configured" 500.
 *
 * Edge-cached 100s to stay inside OpenSky's free 4000-credits/day quota
 * (global /states/all ~4 credits/call -> ~860 calls/day worst case).
 */

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all';
const CACHE_TTL = 100;

async function getToken(env) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.OPENSKY_CLIENT_ID,
    client_secret: env.OPENSKY_CLIENT_SECRET,
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  return (await r.json()).access_token;
}

export async function onRequestOptions() {
  return cors(new Response(null, { status: 204 }));
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) {
    return cors(json({ error: 'not configured: set OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET (Pages secrets)' }, 500));
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + '/__global_flights', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cors(cached);

  let token;
  try { token = await getToken(env); } catch (e) { return cors(json({ error: 'auth failed', detail: String(e) }, 502)); }

  let up;
  try { up = await fetch(STATES_URL, { headers: { Authorization: 'Bearer ' + token } }); }
  catch (e) { return cors(json({ error: 'upstream fetch failed', detail: String(e) }, 502)); }
  if (!up.ok) return cors(json({ error: `upstream HTTP ${up.status}` }, 502));

  let data;
  try { data = await up.json(); } catch (e) { return cors(json({ error: 'bad upstream json' }, 502)); }

  const M2FT = 3.28084, MS2KT = 1.94384, MS2FPM = 196.85;
  const aircraft = [];
  for (const s of data.states || []) {
    const lon = s[5], lat = s[6];
    if (lat == null || lon == null) continue;
    if (s[8]) continue; // on_ground
    const altM = s[13] != null ? s[13] : s[7];
    aircraft.push({
      hex: s[0],
      flight: (s[1] || '').trim() || null,
      lat, lon,
      alt: altM != null ? Math.round(altM * M2FT) : null,
      speed: s[9] != null ? Math.round(s[9] * MS2KT) : null,
      track: s[10] != null ? s[10] : null,
      vsi: s[11] != null ? Math.round(s[11] * MS2FPM) : null,
      squawk: s[14] || null,
      country: s[2] || null,
    });
  }

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
