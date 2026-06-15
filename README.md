# Global Flights

Live map of aircraft around the world, on a dark Leaflet map with a real-time day/night
terminator. Planes are coloured by altitude, rotated to heading, smoothed between updates,
hover for callsign, click for details, and a fading trail shows the selected plane's path.

## Data - keyless, live (~25s)
OpenSky was the first choice but it can't be reached from Cloudflare Workers (522) and its free tier
caps at ~90s anyway. For a genuinely live map, `functions/api/flights.js` instead sweeps a grid of
points across the world's busy regions using the keyless community ADS-B aggregators (adsb.fi /
airplanes.live), merges + de-dupes by hex, adds CORS, and edge-caches 25s. No API key.

Coverage is feeder-dependent: excellent over Europe / North America / E Asia / Australia, sparser over
remote oceans and quiet regions.

## Performance
OpenSky returns ~10,000 aircraft worldwide, so the frontend renders only what's in view, capped at
~1,200 (highest-altitude first), recomputed on pan/zoom. The header shows total worldwide vs shown.

## Deploy
GitHub Action -> Cloudflare Pages project `global-flights` on every push to `master`
(secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).

Live: https://global-flights.pages.dev
