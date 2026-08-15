(function () {
  // Shadow-DOM lifecycle and Leaflet init patterns (own shadow root housing
  // <ha-card>, serialized async map init with a post-teardown DOM recheck,
  // invalidateSize() instead of pre-computed width) adapted from
  // AlexandrErohin/home-assistant-flightradar24's flightradar24-card.js
  // (MIT licensed, Copyright (c) 2023 AlexandrErohin).
  const CARD_VERSION = '1.6.1';

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
      const nextKey = `${nextEntity}|${nextConfig.zoom ?? ''}|${nextConfig.height ?? ''}`;

      this._config   = nextConfig;
      this._entityId = nextEntity;

      // Only entity/zoom/height affect the map itself — if one of those
      // changed on an already-initialized card (e.g. live dashboard-editor
      // reconfiguration), tear down so the next update rebuilds with the new
      // values. On the very first setConfig() call there's nothing to compare
      // against yet, so this is a no-op.
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

      // CartoDB tiles — no Referer restrictions, works from local HA instances
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
          '© <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(this._map);

      // ResizeObserver fires once immediately with the current size (fixing
      // the case where the card mounts hidden, e.g. an inactive dashboard
      // tab) and again on every subsequent resize — more robust than a
      // one-shot invalidateSize() that never re-fires once the container's
      // size settles.
      this._resizeObserver = new ResizeObserver(() => this._map?.invalidateSize());
      this._resizeObserver.observe(mapEl);
      return this._map;
    }

    _icon(trackDeg) {
      return L.divIcon({
        className: '',
        html:
          `<div style="transform:rotate(${trackDeg ?? 0}deg);` +
          `width:28px;height:28px;display:flex;align-items:center;justify-content:center">` +
          `<img src="/local/fr24_tracker/plane.svg" style="width:22px;height:22px" alt=""></div>`,
        iconSize:    [28, 28],
        iconAnchor:  [14, 14],
        popupAnchor: [0, -16],
      });
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
      // Callsign/squawk come from ADS-B broadcasts (spoofable over SDR) and
      // registration/type/operator from the unauthenticated hexdb.io API —
      // both are attacker-reachable strings rendered as HTML in the popup,
      // so they must be escaped before interpolation.
      const rows  = [
        ['Callsign',     this._escape(f.callsign      || '—')],
        ['Registration', this._escape(f.registration  || '—')],
        ['Type',         this._escape(f.aircraft_type || '—')],
        ['Operator',     this._escape(f.operator      || '—')],
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

          if (existing) {
            existing.setLatLng([f.latitude, f.longitude]);
            // Rebuilding the divIcon is wasted work when the heading hasn't
            // moved, which is most polls for most aircraft.
            if (existing._frTrackDeg !== f.track_deg) {
              existing._frTrackDeg = f.track_deg;
              existing.setIcon(this._icon(f.track_deg));
            }
            existing.getPopup()?.setContent(html);
          } else {
            const marker = L.marker(
              [f.latitude, f.longitude],
              { icon: this._icon(f.track_deg) }
            ).bindPopup(html).addTo(map);
            marker._frTrackDeg = f.track_deg;
            this._markers[f.icao] = marker;
          }
        }

        for (const icao of Object.keys(this._markers)) {
          if (!seen.has(icao)) {
            this._markers[icao].remove();
            delete this._markers[icao];
          }
        }

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
