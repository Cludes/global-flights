# Global Flights

Live map of aircraft around the world, on a dark Leaflet map with a real-time day/night
terminator. Planes are coloured by altitude, rotated to heading, smoothed between updates,
hover for callsign, click for details, and a fading trail shows the selected plane's path.

## Data - OpenSky Network (free account)
OpenSky returns the whole planet's traffic in one `/states/all` call. It needs an OAuth2 client
(free): create an account at https://opensky-network.org, then make an API client in your account
settings to get a **client id + secret**. Set them as Pages secrets `OPENSKY_CLIENT_ID` and
`OPENSKY_CLIENT_SECRET`; until then `/api/flights` returns a "not configured" message.

The Pages Function (`functions/api/flights.js`) fetches an OAuth token, calls `/states/all`, trims +
adds CORS, and edge-caches for 100s to stay inside OpenSky's free 4000-credits/day quota.

## Performance
OpenSky returns ~10,000 aircraft worldwide, so the frontend renders only what's in view, capped at
~1,200 (highest-altitude first), recomputed on pan/zoom. The header shows total worldwide vs shown.

## Deploy
GitHub Action -> Cloudflare Pages project `global-flights` on every push to `master`
(secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://global-flights.pages.dev
