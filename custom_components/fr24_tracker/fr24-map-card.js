(function () {
  // Shadow-DOM lifecycle and Leaflet init patterns (own shadow root housing
  // <ha-card>, serialized async map init with a post-teardown DOM recheck,
  // invalidateSize() instead of pre-computed width) adapted from
  // AlexandrErohin/home-assistant-flightradar24's flightradar24-card.js
  // (MIT licensed, Copyright (c) 2023 AlexandrErohin).
  const CARD_VERSION = '1.8.1';

  // Mirrors EMERGENCY_SQUAWKS in binary_sensor.py — duplicated here because
  // the card is a standalone frontend file with no build step sharing code
  // with the backend.
  const EMERGENCY_SQUAWK_LABELS = {
    '7500': 'Hijacking',
    '7600': 'Radio Failure',
    '7700': 'General Emergency',
  };
  // Inlined from plane.svg so the marker's fill can be set dynamically
  // (altitude colour) without an extra request per colour variant.
  const PLANE_SVG_PATH =
    'M21,16V14L13,9V3.5A1.5,1.5,0,0,0,11.5,2,1.5,1.5,0,0,0,10,3.5V9L2,14V16L10,13.5V19L8,20.5V22L11.5,21L15,22V20.5L13,19V13.5Z';

  // Red (low) -> blue (high) altitude ramp, precomputed offline in OKLCH
  // (fixed L=0.46, per-hue chroma at 90% of the max that stays inside the
  // sRGB gamut at that lightness) rather than computed live in the browser.
  // Shipping oklch() directly (an earlier version of this ramp did) means
  // every point outside the sRGB gamut gets silently gamut-mapped by
  // whatever algorithm the rendering engine uses — Chrome, Firefox and the
  // HA companion app's Android WebView are not guaranteed to agree, so the
  // colour (and therefore the contrast this ramp exists for) wouldn't
  // actually be the value that was verified. These 9 stops were confirmed
  // in-gamut (no clamping/mapping needed by any engine) and >=4.9:1 WCAG
  // contrast against sampled Esri tile colours (cream land, pale green/
  // blue, white roads, light gray urban); runtime just linearly interpolates
  // between adjacent stops in sRGB, which for 9 close stops tracks the
  // OKLCH curve closely enough for a 22px marker.
  const ALTITUDE_COLOR_STOPS = [
    '#a11b22', '#834614', '#6f5314', '#585d14', '#186a15',
    '#186653', '#186468', '#17607e', '#1251b4',
  ];
  const ALTITUDE_COLOR_GRAY = '#585858'; // same L=0.46, C=0 — ground/unknown

  const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  // How long a load failure is shown before a connected card (one that never
  // disconnects/reconfigures) automatically tries again, in case the
  // browser's network comes back on its own.
  const LOAD_RETRY_COOLDOWN_MS = 60000;
  // The `height` card-config value is spliced into an innerHTML template
  // (needed since it varies the shadow DOM's own style block, not just an
  // element property), so it must be validated as a plain CSS length first —
  // unlike a `style.cssText` assignment, string-built HTML has no built-in
  // immunity to a value that isn't the length it claims to be.
  const CSS_LENGTH_RE = /^\d+(\.\d+)?(px|%|em|rem|vh|vw)$/;

  // Single shared promise so multiple cards on the same page only load Leaflet
  // once. Reset to null on failure so a later reconnect (e.g. after the
  // browser regains connectivity) actually retries the CDN fetch instead of
  // replaying a cached rejection forever — which requires removing the failed
  // <script> tag too, since a <script> element's load/error events only ever
  // fire once; a later attempt that just re-listens on the same dead element
  // would hang forever instead of retrying.
  let _leafletLoad = null;
  function ensureLeaflet() {
    if (_leafletLoad) return _leafletLoad;
    _leafletLoad = new Promise((resolve, reject) => {
      if (window.L) { resolve(window.L); return; }
      if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = LEAFLET_CSS;
        document.head.appendChild(link);
      }
      let script = document.querySelector(`script[src="${LEAFLET_JS}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = LEAFLET_JS;
        document.head.appendChild(script);
      }
      script.addEventListener('load', () => resolve(window.L), { once: true });
      script.addEventListener(
        'error',
        () => reject(new Error('Failed to load Leaflet from ' + LEAFLET_JS)),
        { once: true }
      );
    }).catch((err) => {
      document.querySelector(`script[src="${LEAFLET_JS}"]`)?.remove();
      _leafletLoad = null;
      throw err;
    });
    return _leafletLoad;
  }

  class FR24MapCard extends HTMLElement {
    constructor() {
      super();
      this._map            = null;
      this._mapInitPromise = null;
      this._initGeneration = 0;
      this._resizeObserver = null;
      this._markers        = {};
      this._trails         = {};
      this._lowAltCircle   = null;
      this._hass           = null;
      this._config         = {};
      this._configKey      = null;
      this._entityId       = 'sensor.fr24_current_flights';
      this._lastUpdated    = null;
      this._loadFailedAt   = null;
      this._retryTimer     = null;
    }

    setConfig(config) {
      const nextConfig = config || {};
      const nextEntity = nextConfig.entity || 'sensor.fr24_current_flights';
      const nextKey = [
        nextEntity,
        nextConfig.zoom ?? '',
        nextConfig.height ?? '',
        nextConfig.show_trails ?? '',
        nextConfig.trail_length ?? '',
        nextConfig.color_by_altitude ?? '',
        nextConfig.show_low_altitude_radius ?? '',
        nextConfig.low_altitude_entity ?? '',
      ].join('|');

      this._config   = nextConfig;
      this._entityId = nextEntity;

      // Any field folded into nextKey affects the map or its overlays — if
      // one changed on an already-initialized card (e.g. live dashboard-
      // editor reconfiguration), tear down so the next update rebuilds with
      // the new values (this also clears trail history and the tile layer,
      // not just an in-place style tweak). On the very first setConfig()
      // call there's nothing to compare against yet, so this is a no-op.
      if (this._configKey && this._configKey !== nextKey) {
        this._destroyMap();
      }
      this._configKey = nextKey;
      this._update();
    }

    set hass(hass) {
      this._hass = hass;
      this._update();
    }

    getCardSize() {
      return this._config.card_size ?? 5;
    }

    connectedCallback() {
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
      }
      // _update() calls _renderShell() itself; a second direct call here
      // would just tear down and rebuild the DOM it had just built.
      this._update();
    }

    disconnectedCallback() {
      this._destroyMap();
    }

    _destroyMap() {
      // Any _initMap() still awaiting Leaflet from before this teardown is
      // now stale — bump the generation so it recognizes that and bails
      // instead of racing a later init for the same DOM node (e.g. a
      // disconnect/reconnect while the CDN load is still in flight).
      this._initGeneration++;
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      if (this._map) {
        try {
          this._map.remove();
        } catch (err) {
          console.warn('[fr24-map-card] error removing map', err);
        }
        this._map = null;
      }
      this._mapInitPromise = null;
      this._markers = {};
      // Trails/circle are Leaflet layers on the map instance just removed —
      // no separate .remove() needed, but the references must be dropped so
      // a rebuilt map starts with fresh trail history rather than carrying
      // stale points into markers that don't exist yet.
      this._trails = {};
      this._lowAltCircle = null;
      // A fresh teardown deserves a fresh attempt at loading Leaflet, and the
      // rebuilt map has drawn nothing yet regardless of whether the tracked
      // entity's state has changed since the last (now-discarded) map did.
      this._loadFailedAt = null;
      this._lastUpdated = null;
    }

    _loadRecentlyFailed() {
      return (
        this._loadFailedAt != null &&
        Date.now() - this._loadFailedAt < LOAD_RETRY_COOLDOWN_MS
      );
    }

    _styles() {
      return `
        :host { display: block; }
        ha-card { position: relative; overflow: hidden; isolation: isolate; }
        .badge {
          position: absolute; top: 10px; right: 10px; z-index: 1000;
          background: rgba(0,0,0,.55); color: #fff; font: 13px/1 sans-serif;
          padding: 5px 10px; border-radius: 12px; pointer-events: none;
        }
        @keyframes fr24-emergency-pulse {
          0%   { transform: scale(0.9); opacity: .55; }
          70%  { transform: scale(1.8); opacity: 0; }
          100% { transform: scale(1.8); opacity: 0; }
        }
      `;
    }

    _renderShell() {
      if (!this.shadowRoot) return;
      // Healthy: DOM present and either a live map, an init in flight, or a
      // latched load failure already surfaced to the user. Any of those means
      // there's nothing to rebuild — in particular, treating "init in
      // flight" as unhealthy would tear down and restart the very init that
      // is already running every time hass updates while Leaflet is loading.
      const mapEl = this.shadowRoot.getElementById('map');
      if (mapEl && (this._map || this._mapInitPromise || this._loadRecentlyFailed())) return;
      // Rebuild after HA tears down and recreates the shadow DOM (dashboard
      // edit-mode, view switches, etc.) — Leaflet leaves stale state on the
      // old node that needs clearing before a fresh init.
      this._destroyMap();
      const configuredHeight = this._config.height;
      const height =
        typeof configuredHeight === 'string' && CSS_LENGTH_RE.test(configuredHeight)
          ? configuredHeight
          : '500px';
      this.shadowRoot.innerHTML = `
        <style>${this._styles()}</style>
        <link rel="stylesheet" href="${LEAFLET_CSS}">
        <ha-card>
          <div id="map" style="height:${height};width:100%"></div>
          <div class="badge" id="badge">— aircraft</div>
        </ha-card>
      `;
    }

    _showLoadError(err) {
      console.error('[fr24-map-card] Leaflet failed to load', err);
      this._loadFailedAt = Date.now();
      const mapEl = this.shadowRoot?.getElementById('map');
      if (mapEl) {
        mapEl.innerHTML =
          '<div style="padding:16px;color:#c62828;font-family:sans-serif">' +
          '<b>FR24 Map Card</b>: could not load Leaflet. ' +
          'Check your browser has internet access for CDN resources.</div>';
      }
      const badgeEl = this.shadowRoot?.getElementById('badge');
      if (badgeEl) badgeEl.style.display = 'none';
      // _loadRecentlyFailed() expiring is only checked reactively, inside
      // _update() — on a quiet dashboard with no other entity churn, nothing
      // would otherwise call _update() again to notice the cooldown elapsed.
      if (this._retryTimer) clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this._update();
      }, LOAD_RETRY_COOLDOWN_MS);
    }

    async _ensureMap() {
      const mapEl = this.shadowRoot?.getElementById('map');
      if (!mapEl) return null;
      if (this._map) return this._map;
      // Serialize concurrent init attempts — the hass setter and
      // connectedCallback can both fire before the first init finishes.
      if (this._mapInitPromise) return this._mapInitPromise;
      this._mapInitPromise = this._initMap();
      try {
        return await this._mapInitPromise;
      } finally {
        this._mapInitPromise = null;
      }
    }

    async _initMap() {
      const generation = this._initGeneration;
      const L = await ensureLeaflet();
      if (this._map) return this._map;
      if (generation !== this._initGeneration) {
        // A teardown happened while we were awaiting Leaflet — this attempt
        // is stale, let whatever init (if any) came after it own the node.
        return null;
      }
      // The shadow DOM may have been rebuilt while we were awaiting Leaflet
      // (in which case _renderShell() already produced a brand-new, never-
      // initialized #map node — nothing to clear here).
      const mapEl = this.shadowRoot?.getElementById('map');
      if (!this.isConnected || !mapEl) return null;

      const cfg  = this._hass.config;
      const zoom = this._config.zoom ?? 9;
      this._map = L.map(mapEl).setView([cfg.latitude, cfg.longitude], zoom);

      // CartoDB's free anonymous tiles now require an API key (every style
      // watermarked "API KEY REQUIRED", confirmed 2026-09-04) and OSM's own
      // tile servers 403 us with "Access blocked — Referer is required by
      // tile usage policy" (confirmed same day, live in the HA dashboard —
      // it isn't sending a Referer OSM will accept).
      // Esri's free World Street Map tile service has no key and no Referer
      // requirement — verified with empty Referer/User-Agent headers.
      // Note the {z}/{y}/{x} order: Esri's REST tile API takes level/row/col,
      // not Leaflet's usual {z}/{x}/{y}.
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © <a href="https://www.esri.com">Esri</a>',
        maxZoom: 19,
      }).addTo(this._map);

      // ResizeObserver fires once immediately with the current size (fixing
      // the case where the card mounts hidden, e.g. an inactive dashboard
      // tab) and again on every subsequent resize — more robust than a
      // one-shot invalidateSize() that never re-fires once the container's
      // size settles.
      this._resizeObserver = new ResizeObserver(() => this._map?.invalidateSize());
      this._resizeObserver.observe(mapEl);

      // Confirmed on the HA companion app's WebView: ResizeObserver's
      // initial callback either doesn't fire or fires against a size that
      // hasn't settled yet, and — unlike a real browser — nothing else ever
      // triggers a later resize to correct it, leaving Leaflet's tile grid
      // permanently misaligned. Browsers (desktop and mobile) don't need
      // this; it's a bounded, self-cancelling safety net for the one
      // environment that does, not a return to open-ended width polling.
      for (const delay of [100, 500, 1500]) {
        setTimeout(() => this._map?.invalidateSize(), delay);
      }
      return this._map;
    }

    // Red (low) through blue (high), same convention as FR24's own app and
    // most ADS-B trackers (tar1090, etc.) — capped at a typical airliner
    // cruise ceiling so anything above it just reads as "high" rather than
    // compressing the whole low-altitude range into a sliver of the scale.
    // See ALTITUDE_COLOR_STOPS above for why this interpolates a precomputed
    // table instead of computing OKLCH live.
    _altitudeColor(altFt) {
      if (!Number.isFinite(altFt) || altFt <= 0) return ALTITUDE_COLOR_GRAY;
      const frac = Math.max(0, Math.min(1, altFt / 40000));
      const pos = frac * (ALTITUDE_COLOR_STOPS.length - 1);
      const i = Math.min(Math.floor(pos), ALTITUDE_COLOR_STOPS.length - 2);
      return this._lerpHex(ALTITUDE_COLOR_STOPS[i], ALTITUDE_COLOR_STOPS[i + 1], pos - i);
    }

    _lerpHex(hexA, hexB, t) {
      const a = parseInt(hexA.slice(1), 16);
      const b = parseInt(hexB.slice(1), 16);
      const chan = (h, shift) => (h >> shift) & 0xff;
      const mix = (shift) => Math.round(chan(a, shift) + (chan(b, shift) - chan(a, shift)) * t);
      const r = mix(16), g = mix(8), bch = mix(0);
      return `#${((r << 16) | (g << 8) | bch).toString(16).padStart(6, '0')}`;
    }

    _markerColor(f) {
      return this._config.color_by_altitude === false
        ? '#03a9f4'
        : this._altitudeColor(f.altitude_ft);
    }

    // undefined for a non-emergency squawk — never falls through to
    // Object.prototype (f.squawk is spoofable over SDR, so a garbled value
    // like "constructor" or "toString" must not resolve to a truthy label).
    _emergencyLabel(f) {
      return Object.prototype.hasOwnProperty.call(EMERGENCY_SQUAWK_LABELS, f.squawk)
        ? EMERGENCY_SQUAWK_LABELS[f.squawk]
        : undefined;
    }

    _iconKey(f, color) {
      return `${f.track_deg ?? 0}|${color}|${!!this._emergencyLabel(f)}`;
    }

    _icon(f, color) {
      const ring = this._emergencyLabel(f)
        ? '<div style="position:absolute;inset:-7px;border-radius:50%;' +
          'background:var(--error-color, #d32f2f);opacity:.6;' +
          'animation:fr24-emergency-pulse 1.2s ease-out infinite"></div>'
        : '';
      return L.divIcon({
        className: '',
        html:
          `<div style="position:relative;width:28px;height:28px;` +
          `display:flex;align-items:center;justify-content:center">` +
          ring +
          `<div style="position:relative;transform:rotate(${f.track_deg ?? 0}deg);` +
          `width:22px;height:22px;color:${color}">` +
          `<svg viewBox="0 0 24 24" width="100%" height="100%">` +
          // paint-order draws the stroke first so the fill sits cleanly on
          // top instead of the stroke doubling the shape's apparent width —
          // a dark outline independent of marker colour, so a plane stays
          // legible even where the fill colour and the tile underneath it
          // are close (e.g. a pale altitude band over light water/parkland).
          `<path fill="currentColor" stroke="rgba(0,0,0,.65)" stroke-width="1.5" ` +
          `stroke-linejoin="round" paint-order="stroke" d="${PLANE_SVG_PATH}"/></svg>` +
          `</div></div>`,
        iconSize:    [28, 28],
        iconAnchor:  [14, 14],
        popupAnchor: [0, -16],
      });
    }

    // Trails are accumulated client-side from successive poll snapshots —
    // the feeder only ever reports current position, no history — so they
    // reset on every card reconnect/reconfigure and are naturally capped to
    // recent movement, which is what you want for a live "where are they
    // right now and where did they just come from" view rather than a
    // permanent flight-log overlay.
    _updateTrail(map, f, color) {
      if (this._config.show_trails === false) return;
      const maxPoints = Math.max(2, Number(this._config.trail_length) || 20);
      let trail = this._trails[f.icao];
      if (!trail) {
        trail = {
          points: [],
          line: L.polyline([], { weight: 2, opacity: 0.6 }).addTo(map),
        };
        this._trails[f.icao] = trail;
      }
      trail.points.push([f.latitude, f.longitude]);
      if (trail.points.length > maxPoints) trail.points.shift();
      trail.line.setLatLngs(trail.points);
      trail.line.setStyle({ color });
    }

    _removeTrail(icao) {
      const trail = this._trails[icao];
      if (trail) {
        trail.line.remove();
        delete this._trails[icao];
      }
    }

    // Mirrors CONF_LOW_ALT_RADIUS from the integration's own config — read
    // off the low-altitude binary sensor's attributes rather than
    // duplicating that config into the card, so the circle can't drift out
    // of sync with what the sensor is actually watching. Only drawn when a
    // radius is actually configured (binary_sensor.py omits the attribute
    // entirely when the radius filter is disabled).
    _updateLowAltitudeCircle(map) {
      if (this._config.show_low_altitude_radius === false) {
        this._removeLowAltitudeCircle();
        return;
      }
      const entityId = this._config.low_altitude_entity || 'binary_sensor.fr24_low_altitude';
      const radiusKm = this._hass.states[entityId]?.attributes?.radius_km;
      if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
        this._removeLowAltitudeCircle();
        return;
      }
      const cfg = this._hass.config;
      const center = [cfg.latitude, cfg.longitude];
      // var(...) with a fallback, resolved against the shadow root's host
      // element so it still picks up the dashboard's theme rather than
      // whatever's in scope at the top-level document.
      const warningColor =
        getComputedStyle(this).getPropertyValue('--warning-color').trim() || '#ff9800';
      if (!this._lowAltCircle) {
        this._lowAltCircle = L.circle(center, {
          radius: radiusKm * 1000,
          color: warningColor,
          weight: 1,
          dashArray: '4 4',
          fillColor: warningColor,
          fillOpacity: 0.06,
          interactive: false,
        }).addTo(map);
      } else {
        this._lowAltCircle.setLatLng(center);
        this._lowAltCircle.setRadius(radiusKm * 1000);
      }
    }

    _removeLowAltitudeCircle() {
      if (this._lowAltCircle) {
        this._lowAltCircle.remove();
        this._lowAltCircle = null;
      }
    }

    _escape(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    _popupHtml(f) {
      const vr    = f.vertical_rate_fpm;
      const climb = vr > 64 ? '▲ Climbing' : vr < -64 ? '▼ Descending' : '— Level';
      // Callsign/squawk come from ADS-B broadcasts (spoofable over SDR), and
      // registration/type/operator (hexdb.io) and route/airline (adsbdb.com)
      // from unauthenticated third-party APIs — all attacker-reachable
      // strings rendered as HTML in the popup, so they must be escaped
      // before interpolation.
      const route = (f.origin_iata && f.destination_iata)
        ? `${this._escape(f.origin_iata)} → ${this._escape(f.destination_iata)}`
        : '—';
      const routeTitle = (f.origin_name && f.destination_name)
        ? this._escape(`${f.origin_name} → ${f.destination_name}`)
        : '';
      const rows  = [
        ['Callsign',     this._escape(f.callsign      || '—')],
        ['Registration', this._escape(f.registration  || '—')],
        ['Type',         this._escape(f.aircraft_type || '—')],
        ['Operator',     this._escape(f.operator      || '—')],
        ['Route',        routeTitle ? `<span title="${routeTitle}">${route}</span>` : route],
        ['Altitude',     f.altitude_ft  != null
                           ? `${f.altitude_ft.toLocaleString()} ft / ${(f.altitude_m || 0).toLocaleString()} m`
                           : '—'],
        ['Speed',        f.speed_kts    != null
                           ? `${f.speed_kts} kts / ${f.speed_kmh} km/h`
                           : '—'],
        ['Heading',      f.track_deg    != null ? `${f.track_deg}°`        : '—'],
        ['Vert rate',    vr             != null ? `${vr} fpm — ${climb}`   : '—'],
        ['Squawk',       this._escape(f.squawk || '—')],
        ['ICAO',         this._escape(f.icao)],
      ];
      const emergency = this._emergencyLabel(f);
      if (emergency) {
        rows.unshift(['⚠ Emergency', `<span style="color:var(--error-color, #d32f2f)">${this._escape(emergency)}</span>`]);
      }
      return (
        '<table style="border-collapse:collapse;font-size:13px;min-width:190px">' +
        rows.map(([k, v]) =>
          `<tr>` +
          `<td style="padding:2px 8px 2px 0;color:#666;white-space:nowrap">${k}</td>` +
          `<td style="font-weight:600">${v}</td>` +
          `</tr>`
        ).join('') +
        '</table>'
      );
    }

    async _update() {
      // Cheap early-exit before touching the DOM or awaiting anything: hass
      // is reassigned on every state change system-wide, not just this
      // sensor's, and once the map already exists there's nothing to do
      // until the tracked entity's own state actually moves. Compares
      // last_updated, not last_changed: this sensor's *state* is just an
      // aircraft count (sensor.py's native_value), which only bumps
      // last_changed when the count itself changes — the actual position/
      // heading data lives in attributes, which only bump last_updated.
      // Gating on last_changed would freeze the map in place across any run
      // of polls with a stable aircraft count.
      if (this._map) {
        const currentState = this._hass?.states?.[this._entityId];
        if (currentState && currentState.last_updated === this._lastUpdated) return;
      }

      this._renderShell();
      if (!this.shadowRoot || !this._hass || this._loadRecentlyFailed()) return;

      // Init the basemap as soon as hass is available, independent of
      // whether the configured entity has state yet — a slow-to-populate or
      // briefly-unavailable sensor shouldn't leave the map itself blank.
      let map;
      try {
        map = await this._ensureMap();
      } catch (err) {
        this._showLoadError(err);
        return;
      }
      // A disconnect (or reconfigure) can land while the await above was
      // suspended and tear this exact map down — re-check against the live
      // instance rather than trusting the local reference.
      if (!map || map !== this._map) return;

      const state  = this._hass.states[this._entityId];
      const badgeEl = this.shadowRoot.getElementById('badge');
      if (!state) {
        if (badgeEl) badgeEl.textContent = 'unavailable';
        // The entity itself is gone (renamed/misconfigured entity_id) —
        // don't leave stale aircraft frozen on the map looking live.
        for (const icao of Object.keys(this._markers)) {
          this._markers[icao].remove();
          delete this._markers[icao];
          this._removeTrail(icao);
        }
        return;
      }

      // Only redraw when the sensor was actually updated.
      if (state.last_updated === this._lastUpdated) return;
      this._lastUpdated = state.last_updated;

      try {
        const flights = (state.attributes.flights || []).filter(
          (f) => f.has_position && Number.isFinite(f.latitude) && Number.isFinite(f.longitude)
        );
        const seen = new Set();

        for (const f of flights) {
          seen.add(f.icao);
          const html = this._popupHtml(f);
          const existing = this._markers[f.icao];
          // Computed once per flight per poll and threaded through, rather
          // than each of iconKey/icon/trail re-deriving it from f.altitude_ft.
          const color = this._markerColor(f);
          const iconKey = this._iconKey(f, color);

          if (existing) {
            existing.setLatLng([f.latitude, f.longitude]);
            // Rebuilding the divIcon is wasted work when heading, altitude
            // band and emergency state haven't changed, which is most polls
            // for most aircraft.
            if (existing._frIconKey !== iconKey) {
              existing._frIconKey = iconKey;
              existing.setIcon(this._icon(f, color));
            }
            existing.getPopup()?.setContent(html);
          } else {
            const marker = L.marker(
              [f.latitude, f.longitude],
              { icon: this._icon(f, color) }
            ).bindPopup(html).addTo(map);
            marker._frIconKey = iconKey;
            this._markers[f.icao] = marker;
          }

          this._updateTrail(map, f, color);
        }

        for (const icao of Object.keys(this._markers)) {
          if (!seen.has(icao)) {
            this._markers[icao].remove();
            delete this._markers[icao];
            this._removeTrail(icao);
          }
        }

        this._updateLowAltitudeCircle(map);

        if (badgeEl) badgeEl.textContent = `${flights.length} aircraft`;
      } catch (err) {
        console.error('[fr24-map-card] error updating markers', err);
        if (badgeEl) badgeEl.textContent = 'error';
      }
    }
  }

  if (!customElements.get('fr24-map-card')) {
    customElements.define('fr24-map-card', FR24MapCard);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.find(c => c.type === 'fr24-map-card')) {
    window.customCards.push({
      type:        'fr24-map-card',
      name:        'FR24 Feeder Map',
      description: 'Interactive map of aircraft detected by your FR24 feeder — rotating icons, click for details',
      preview:     false,
    });
  }

  console.info(
    '%c FR24-MAP-CARD %c v' + CARD_VERSION + ' ',
    'background:#1976d2;color:white;padding:2px 4px;border-radius:3px 0 0 3px',
    'background:#ddd;padding:2px 4px;border-radius:0 3px 3px 0'
  );
})();
