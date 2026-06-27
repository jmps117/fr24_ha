(function () {
  const CARD_VERSION = '1.5.5';

  const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

  // Single shared promise so multiple cards on the same page only load Leaflet once
  let _leafletLoad = null;
  function ensureLeaflet() {
    if (_leafletLoad) return _leafletLoad;
    _leafletLoad = new Promise((resolve, reject) => {
      if (window.L) { resolve(); return; }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
      const script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load Leaflet from ' + LEAFLET_JS));
      document.head.appendChild(script);
    });
    return _leafletLoad;
  }

  class FR24MapCard extends HTMLElement {
    constructor() {
      super();
      this._map         = null;
      this._mapEl       = null;
      this._badge       = null;
      this._markers     = {};
      this._ready       = false;
      this._starting    = false;
      this._hass        = null;
      this._config      = {};
      this._entityId    = 'sensor.fr24_current_flights';
      this._lastChanged = null;
    }

    setConfig(config) {
      this._config   = config || {};
      this._entityId = config.entity || 'sensor.fr24_current_flights';
    }

    set hass(hass) {
      this._hass = hass;

      if (!this._ready) {
        if (!this._starting) this._start();
        return;
      }

      // Only redraw when the sensor state actually changed
      const state   = hass.states[this._entityId];
      const changed = state ? state.last_changed : null;
      if (changed !== this._lastChanged) {
        this._lastChanged = changed;
        this._update();
      }
    }

    async _start() {
      if (this._starting) return;
      this._starting = true;

      this.style.display = 'block';

      try {
        await ensureLeaflet();
      } catch (e) {
        console.error('[fr24-map-card]', e);
        this.innerHTML =
          '<div style="padding:16px;color:#c62828;font-family:sans-serif">' +
          '<b>FR24 Map Card</b>: could not load Leaflet. ' +
          'Check your browser has internet access for CDN resources.</div>';
        return;
      }

      this.innerHTML = '';
      const height = this._config.height || '500px';

      // Plain div styled with HA CSS variables rather than <ha-card>.
      // ha-card's shadow DOM was positioning slotted content ~46px above the host
      // element, causing the top and bottom of the map to be clipped by overflow:hidden.
      // isolation:isolate scopes Leaflet's z-indices (400-700) to this element so
      // they don't bleed over sibling cards when the dashboard is scrolled.
      const card = document.createElement('div');
      card.style.cssText =
        `height:${height};position:relative;overflow:hidden;isolation:isolate;` +
        'background:var(--ha-card-background,var(--card-background-color,#fff));' +
        'border-radius:var(--ha-card-border-radius,4px);' +
        'box-shadow:var(--ha-card-box-shadow,' +
          '0 2px 2px 0 rgba(0,0,0,.14),' +
          '0 3px 1px -2px rgba(0,0,0,.12),' +
          '0 1px 5px 0 rgba(0,0,0,.2))';
      this.appendChild(card);

      this._mapEl = document.createElement('div');
      this._mapEl.style.cssText = `height:${height};width:100%;`;
      card.appendChild(this._mapEl);

      this._badge = document.createElement('div');
      this._badge.style.cssText =
        'position:absolute;top:10px;right:10px;z-index:1000;' +
        'background:rgba(0,0,0,.55);color:#fff;font:13px/1 sans-serif;' +
        'padding:5px 10px;border-radius:12px;pointer-events:none;';
      this._badge.textContent = '— aircraft';
      card.appendChild(this._badge);

      // Defer Leaflet map creation until the container has real dimensions.
      // Initialising L.map() against a 0×0 container causes tile fragmentation
      // even after invalidateSize() — creating it once the size is known is cleaner.
      const cfg  = this._hass.config;
      const zoom = this._config.zoom || 9;

      const ro = new ResizeObserver(([entry]) => {
        // Guard: skip until the grid column has settled to a real width,
        // and never double-init if the observer fires a second time.
        if (!entry.contentRect.width || this._map) return;
        ro.disconnect();

        this._map = L.map(this._mapEl).setView([cfg.latitude, cfg.longitude], zoom);

        // CartoDB tiles — no Referer restrictions, works from local HA instances
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
            '© <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: 'abcd',
          maxZoom: 19,
        }).addTo(this._map);

        this._ready = true;
        this._update();

        // Two-pass invalidation: RAF catches next-frame layout shifts; the
        // 400 ms timeout catches Lovelace grid settling that takes longer.
        requestAnimationFrame(() => this._map.invalidateSize());
        setTimeout(() => this._map && this._map.invalidateSize(), 400);
      });
      ro.observe(this._mapEl);
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

    _popupHtml(f) {
      const vr    = f.vertical_rate_fpm;
      const climb = vr > 64 ? '▲ Climbing' : vr < -64 ? '▼ Descending' : '— Level';
      const rows  = [
        ['Callsign',     f.callsign      || '—'],
        ['Registration', f.registration  || '—'],
        ['Type',         f.aircraft_type || '—'],
        ['Operator',     f.operator      || '—'],
        ['Altitude',     f.altitude_ft  != null
                           ? `${f.altitude_ft.toLocaleString()} ft / ${(f.altitude_m || 0).toLocaleString()} m`
                           : '—'],
        ['Speed',        f.speed_kts    != null
                           ? `${f.speed_kts} kts / ${f.speed_kmh} km/h`
                           : '—'],
        ['Heading',      f.track_deg    != null ? `${f.track_deg}°`        : '—'],
        ['Vert rate',    vr             != null ? `${vr} fpm — ${climb}`   : '—'],
        ['Squawk',       f.squawk       || '—'],
        ['ICAO',         f.icao],
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

    _update() {
      if (!this._ready || !this._hass) return;

      const state = this._hass.states[this._entityId];
      if (!state) return;

      const flights = (state.attributes.flights || []).filter(f => f.has_position);
      const seen    = new Set();

      for (const f of flights) {
        seen.add(f.icao);
        const html = this._popupHtml(f);

        if (this._markers[f.icao]) {
          this._markers[f.icao].setLatLng([f.latitude, f.longitude]);
          this._markers[f.icao].setIcon(this._icon(f.track_deg));
          this._markers[f.icao].getPopup()?.setContent(html);
        } else {
          this._markers[f.icao] = L.marker(
            [f.latitude, f.longitude],
            { icon: this._icon(f.track_deg) }
          ).bindPopup(html).addTo(this._map);
        }
      }

      for (const icao of Object.keys(this._markers)) {
        if (!seen.has(icao)) {
          this._markers[icao].remove();
          delete this._markers[icao];
        }
      }

      this._badge.textContent = `${flights.length} aircraft`;
    }

    getCardSize() {
      return this._config.card_size ?? 5;
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
