'use strict';

const CONFIG = {
  CENTER: [25, 10],
  ZOOM: 3, MIN_ZOOM: 2, MAX_ZOOM: 11,
  API: '/api/flights',
  REFRESH_MS: 25000,
  TRAIL_MAX: 30,
  TILE: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  ATTR: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | ADS-B: <a href="https://adsb.fi">adsb.fi</a> / <a href="https://airplanes.live">airplanes.live</a>',
};

function altColor(alt) {
  if (alt == null) return '#9aa7b5';
  if (alt < 10000) return '#00e5ff';
  if (alt < 20000) return '#7CFC8A';
  if (alt < 30000) return '#FFD23F';
  if (alt < 40000) return '#FF8C42';
  return '#FF5A8A';
}

// ── Solar terminator (night-side polygon) ──────────────────────────────────────
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function sunPos(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, T = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * T) * D2R;
  const q = 280.459 + 0.98564736 * T;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * T) * D2R;
  return {
    ra: Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * R2D,
    dec: Math.asin(Math.sin(e) * Math.sin(L)) * R2D,
    gmst: (18.697374558 + 24.06570982441908 * T) % 24,
  };
}
function terminatorPolygon(date) {
  const { ra, dec, gmst } = sunPos(date);
  const pts = [];
  for (let lng = -180; lng <= 180; lng += 1) {
    const ha = (gmst * 15 + lng - ra) * D2R;
    pts.push([Math.atan(-Math.cos(ha) / Math.tan(dec * D2R)) * R2D, lng]);
  }
  const darkPole = dec > 0 ? -90 : 90;
  pts.push([darkPole, 180], [darkPole, -180]);
  return pts;
}

class FlightMap {
  constructor() {
    this.map = null;
    this.planes = new Map();
    this.visible = [];        // hexes currently in view
    this.drawn = [];          // {hex,x,y} from last draw, for hit-testing
    this.selected = null;
    this.terminator = null;
    this.trailLine = null;
    this.canvas = null; this.ctx = null; this.dpr = 1;
    this.hoverEl = null;
    this.timer = null; this._raf = null;
  }

  async init() {
    this.initMap();
    await this.fetchFlights();
    this.startAnimation();
    this.timer = setInterval(() => this.fetchFlights(), CONFIG.REFRESH_MS);
  }

  initMap() {
    this.map = L.map('map', {
      center: CONFIG.CENTER, zoom: CONFIG.ZOOM,
      minZoom: CONFIG.MIN_ZOOM, maxZoom: CONFIG.MAX_ZOOM, zoomControl: true,
      maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1.0,
    });
    L.tileLayer(CONFIG.TILE, { attribution: CONFIG.ATTR, subdomains: 'abcd', maxZoom: 20, noWrap: true }).addTo(this.map);
    this.updateTerminator();
    setInterval(() => this.updateTerminator(), 60000);

    // One canvas for all planes (pointer-events: none; the map handles clicks)
    const c = document.createElement('canvas');
    c.className = 'plane-canvas';
    this.map.getContainer().appendChild(c);
    this.canvas = c; this.ctx = c.getContext('2d');
    this.hoverEl = document.createElement('div');
    this.hoverEl.className = 'hover-tip'; this.hoverEl.style.display = 'none';
    this.map.getContainer().appendChild(this.hoverEl);
    this.sizeCanvas();

    this.map.on('resize', () => this.sizeCanvas());
    this.map.on('moveend zoomend', () => this.syncVisible());
    this.map.on('click', (e) => this.onClick(e));
    this.map.on('mousemove', (e) => this.onHover(e));
    this.map.on('mouseout', () => { this.hoverEl.style.display = 'none'; });
  }

  sizeCanvas() {
    const s = this.map.getSize();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = s.x * this.dpr; this.canvas.height = s.y * this.dpr;
    this.canvas.style.width = s.x + 'px'; this.canvas.style.height = s.y + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  updateTerminator() {
    const pts = terminatorPolygon(new Date());
    if (this.terminator) this.terminator.setLatLngs(pts);
    else this.terminator = L.polygon(pts, { stroke: false, fillColor: '#01030f', fillOpacity: 0.38, interactive: false }).addTo(this.map);
  }

  async fetchFlights() {
    this.setStatus('loading');
    try {
      const res = await fetch(`${CONFIG.API}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const now = Date.now(); const seen = new Set();
      for (const a of data.aircraft || []) {
        if (a.lat == null || a.lon == null) continue;
        seen.add(a.hex);
        const ex = this.planes.get(a.hex);
        if (ex) {
          ex.fromLat = ex.curLat; ex.fromLng = ex.curLng;
          ex.toLat = a.lat; ex.toLng = a.lon;
          ex.track = a.track; ex.alt = a.alt; ex.t0 = now; ex.lastSeen = now; ex.data = a;
          ex.trail.push([a.lat, a.lon]); if (ex.trail.length > CONFIG.TRAIL_MAX) ex.trail.shift();
        } else {
          this.planes.set(a.hex, {
            fromLat: a.lat, fromLng: a.lon, toLat: a.lat, toLng: a.lon,
            curLat: a.lat, curLng: a.lon, track: a.track, alt: a.alt,
            t0: now, lastSeen: now, data: a, trail: [[a.lat, a.lon]],
          });
        }
      }
      for (const [hex, p] of this.planes) {
        if (!seen.has(hex) && now - p.lastSeen > CONFIG.REFRESH_MS * 2) {
          this.planes.delete(hex);
          if (this.selected === hex) this.closeInfo();
        }
      }
      this.setCount(data.count != null ? data.count : this.planes.size);
      this.setUpdated(data.fetched_at);
      this.setStatus('ok');
      this.syncVisible();
      if (this.selected && this.planes.has(this.selected)) { this.renderInfo(this.selected); this.drawTrail(this.selected); }
    } catch (e) {
      console.error('[flights] fetch failed:', e.message);
      this.setStatus('err');
    }
  }

  syncVisible() {
    const b = this.map.getBounds().pad(0.1);
    const vis = [];
    for (const [hex, p] of this.planes) if (b.contains([p.curLat, p.curLng])) vis.push(hex);
    this.visible = vis;
    this.setShown(vis.length);
  }

  startAnimation() {
    const tick = () => {
      const now = Date.now();
      for (const hex of this.visible) {
        const p = this.planes.get(hex); if (!p) continue;
        const t = Math.min(1, (now - p.t0) / CONFIG.REFRESH_MS);
        p.curLat = p.fromLat + (p.toLat - p.fromLat) * t;
        p.curLng = p.fromLng + (p.toLng - p.fromLng) * t;
      }
      this.draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  draw() {
    const ctx = this.ctx, s = this.map.getSize();
    ctx.clearRect(0, 0, s.x, s.y);
    const drawn = [];
    for (const hex of this.visible) {
      const p = this.planes.get(hex); if (!p) continue;
      const pt = this.map.latLngToContainerPoint([p.curLat, p.curLng]);
      if (pt.x < -20 || pt.y < -20 || pt.x > s.x + 20 || pt.y > s.y + 20) continue;
      this.drawPlane(ctx, pt.x, pt.y, p.track || 0, altColor(p.alt), hex === this.selected);
      drawn.push({ hex, x: pt.x, y: pt.y });
    }
    this.drawn = drawn;
  }

  drawPlane(ctx, x, y, rotDeg, color, selected) {
    const s = selected ? 9 : 6.5;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotDeg * D2R);
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.16, -s * 0.18);
    ctx.lineTo(s, s * 0.28);
    ctx.lineTo(s, s * 0.48);
    ctx.lineTo(s * 0.16, s * 0.16);
    ctx.lineTo(s * 0.26, s * 0.78);
    ctx.lineTo(s * 0.5, s * 0.95);
    ctx.lineTo(0, s * 0.72);
    ctx.lineTo(-s * 0.5, s * 0.95);
    ctx.lineTo(-s * 0.26, s * 0.78);
    ctx.lineTo(-s * 0.16, s * 0.16);
    ctx.lineTo(-s, s * 0.48);
    ctx.lineTo(-s, s * 0.28);
    ctx.lineTo(-s * 0.16, -s * 0.18);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (selected) { ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    ctx.restore();
  }

  nearest(x, y) {
    let best = null, bd = 13 * 13;
    for (const d of this.drawn) {
      const dx = d.x - x, dy = d.y - y, dist = dx * dx + dy * dy;
      if (dist < bd) { bd = dist; best = d.hex; }
    }
    return best;
  }

  onClick(e) {
    const hex = this.nearest(e.containerPoint.x, e.containerPoint.y);
    if (hex) this.showInfo(hex); else this.closeInfo();
  }

  onHover(e) {
    const hex = this.nearest(e.containerPoint.x, e.containerPoint.y);
    if (hex) {
      const p = this.planes.get(hex);
      this.hoverEl.textContent = (p.data.flight || p.data.reg || hex.toUpperCase());
      this.hoverEl.style.left = (e.containerPoint.x + 12) + 'px';
      this.hoverEl.style.top = (e.containerPoint.y - 10) + 'px';
      this.hoverEl.style.display = 'block';
      L.DomUtil.addClass(this.map.getContainer(), 'plane-hover');
    } else {
      this.hoverEl.style.display = 'none';
      L.DomUtil.removeClass(this.map.getContainer(), 'plane-hover');
    }
  }

  drawTrail(hex) {
    const p = this.planes.get(hex);
    if (!p || !p.trail || p.trail.length < 2) { this.clearTrail(); return; }
    const style = { color: altColor(p.alt), weight: 2.5, opacity: 0.6 };
    if (this.trailLine) this.trailLine.setLatLngs(p.trail).setStyle(style);
    else this.trailLine = L.polyline(p.trail, style).addTo(this.map);
  }
  clearTrail() { if (this.trailLine) { this.map.removeLayer(this.trailLine); this.trailLine = null; } }

  showInfo(hex) {
    this.selected = hex;
    this.renderInfo(hex);
    this.drawTrail(hex);
    document.getElementById('info').classList.remove('hidden');
  }

  renderInfo(hex) {
    const p = this.planes.get(hex); if (!p) return;
    const a = p.data;
    const call = a.flight || a.reg || a.hex.toUpperCase();
    const alt = a.alt != null ? `${a.alt.toLocaleString()} ft` : '-';
    const spd = a.speed != null ? `${Math.round(a.speed)} kt (${Math.round(a.speed * 1.852)} km/h)` : '-';
    const trk = a.track != null ? `${Math.round(a.track)}°` : '-';
    const vsi = a.vsi != null && Math.abs(a.vsi) > 50
      ? `<span class="fi-v">${a.vsi > 0 ? '▲ climbing' : '▼ descending'} ${Math.abs(Math.round(a.vsi))} ft/min</span>` : '<span class="fi-v">level</span>';
    document.getElementById('info-body').innerHTML = `
      <div class="fi-call" style="color:${altColor(a.alt)}">${call}</div>
      <div class="fi-type">${[a.type, a.reg].filter(Boolean).join(' · ') || 'Unknown aircraft'}</div>
      <div class="fi-row"><span class="fi-k">Altitude</span><span class="fi-v">${alt}</span></div>
      <div class="fi-row"><span class="fi-k">Speed</span><span class="fi-v">${spd}</span></div>
      <div class="fi-row"><span class="fi-k">Heading</span><span class="fi-v">${trk}</span></div>
      <div class="fi-row"><span class="fi-k">Vertical</span>${vsi}</div>
      ${a.squawk ? `<div class="fi-row"><span class="fi-k">Squawk</span><span class="fi-v">${a.squawk}</span></div>` : ''}
    `;
  }

  closeInfo() {
    this.selected = null;
    this.clearTrail();
    document.getElementById('info').classList.add('hidden');
  }

  setStatus(s) {
    const el = document.getElementById('status'); if (!el) return;
    el.className = 'dot ' + ({ ok: 'ok', err: 'err', loading: 'loading' }[s] || '');
    el.title = { ok: 'live', err: 'data error', loading: 'updating' }[s] || '';
  }
  setCount(n) { const el = document.getElementById('count'); if (el) el.textContent = `· ${Number(n).toLocaleString()} worldwide`; }
  setShown(n) { const el = document.getElementById('shown'); if (el) el.textContent = n ? `showing ${Number(n).toLocaleString()}` : ''; }
  setUpdated(iso) {
    const el = document.getElementById('updated'); if (!el || !iso) return;
    el.textContent = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
