# Roadmap

## Released

### v1.0.0
- `device_tracker` entity per aircraft with position fix — appears on HA map
- Attributes per aircraft: callsign, altitude, speed, heading, squawk, vertical rate, last seen
- Sensors: total aircraft tracked, aircraft with position fix, nearest aircraft (km + details)
- Config flow UI — no YAML required
- Polls local FR24 feeder at configurable interval (default 30s)

### v1.1.0
- Plane icon on map instead of generic dot marker — deployed automatically to `www/fr24_tracker/plane.svg` on setup
- Automatic entity cleanup — aircraft removed from entity registry when they leave the feed
- Emergency squawk binary sensor (`binary_sensor.fr24_emergency_squawk`) — fires on 7500 (hijacking), 7600 (radio failure), 7700 (general emergency) with full aircraft details in attributes

### v1.2.0 — Data Enrichment
- Aircraft registration, ICAO type code, full type name, and operator added as attributes on all entities
- Lookups via [hexdb.io](https://hexdb.io) — one request per new ICAO hex, cached for the session
- Up to 4 concurrent enrichment requests with semaphore limiting
- Cache misses recorded so unavailable ICAOs are not retried every poll cycle

### v1.3.0 — Dashboard
- `sensor.fr24_current_flights` — exposes all aircraft as a list attribute with ft/metric conversions pre-calculated, enabling Jinja2 dashboard templates
- Example dashboard YAML (`dashboard_example.yaml`) — flights list markdown card + live map via adsb.fi iframe (rotating icons, no custom card required)

### v1.4.0 — Alerts & Automations
- `binary_sensor.fr24_low_altitude` — on when any positioned aircraft is below a configurable altitude threshold (default 3000m); attributes include threshold in both metres and feet plus full aircraft details
- `binary_sensor.fr24_watched_aircraft` — on when any aircraft's callsign or registration matches a user-defined watch list (comma-separated, case-insensitive)
- Options flow — **Configure** button on the integration card in Devices & Services; sets low altitude threshold and watch list without reconfiguring the whole integration; changes take effect immediately via integration reload
- Two automation blueprints deployed automatically to `config/blueprints/automation/fr24_tracker/` — low altitude alert and watched aircraft alert

### v1.5.0 — Feeder Map
- `custom:fr24-map-card` — native Lovelace card showing **only** aircraft your feeder has detected; reads directly from `sensor.fr24_current_flights` via the `hass` object, no token or auth required
- Rotating plane icons driven by heading, auto-centred on your HA home location
- Click any aircraft for a full detail panel: callsign, registration, type, operator, altitude, speed, heading, vertical rate, squawk
- Aircraft removed from the map when they leave the feed; live count badge in the corner
- Card JS deployed automatically to `www/fr24_tracker/`; register once as a Lovelace resource via Settings → Dashboards → Resources
- Works in the HA browser frontend and mobile app
- Low altitude radius filter — optionally restrict `binary_sensor.fr24_low_altitude` to aircraft within a configurable distance (km) of your HA home location; 0 = no filter
- Map tiles from CartoDB (Voyager); Leaflet loaded from unpkg.com CDN — browser needs internet, HA server does not

### v1.6.2 — Map Card Stability
- Rewrote `custom:fr24-map-card` internals to fix persistent rendering bugs (blank/misaligned map, shadow DOM getting overwritten by HA)
- Card now uses its own shadow root with `<ha-card>` nested inside it, instead of avoiding shadow DOM entirely — gets HA's card chrome for free and stops HA's dashboard re-renders from clobbering the map
- Map init is serialized and re-checks the DOM after Leaflet's async load, since HA can tear down and rebuild the card's DOM mid-init (dashboard edit mode, view switches)
- Replaced the one-time width-polling hack with `invalidateSize()` calls after init and on layout-relevant updates — self-corrects if the container is resized later instead of only working if the very first measurement was stable
- Fixed the HA companion app specifically (desktop and mobile browsers were unaffected): its WebView doesn't fire `ResizeObserver`'s initial callback reliably, leaving the tile grid permanently misaligned with no later resize to correct it — a short backup sequence of `invalidateSize()` calls after init now catches that case too
- Escaped externally-sourced popup fields (hexdb.io enrichment, ADS-B callsign/squawk) to close an HTML-injection hole, and fixed marker redraw being gated on the sensor's `last_changed` instead of `last_updated` (the former only bumps on aircraft-count changes, not position/heading updates, so the map could freeze in place)
- No user-facing config changes — `zoom` and `height` options behave the same

### v1.6.3 / v1.6.4 — Tile Provider Fixes
CartoDB's free anonymous tiles started requiring an API key (every style watermarked "API KEY REQUIRED"), and a same-day attempt to fall back to OSM's own tile servers got 403'd by their Referer usage policy. Landed on Esri's World Street Map tile service (`v1.6.4`) — free, no key, and empirically tolerant of the missing/LAN Referer that sank the other two.

### v1.7.0 — Map Card Overlays
- Flight trails — each aircraft's recent positions accumulated client-side (the feeder only reports current position, no history) and drawn as a polyline, capped at a configurable point count and reset on card reload
- Altitude colouring — markers and trails shift red (low) to blue (high), same convention as FR24's own app and most ADS-B trackers; togglable
- Emergency squawk highlight — 7500/7600/7700 gets a pulsing ring plus a highlighted popup row, independent of altitude colouring
- Low-altitude radius circle — drawn from `binary_sensor.fr24_low_altitude`'s live `radius_km` attribute rather than a duplicated config value, so it can't drift out of sync; only shown when a radius is actually configured

---

## Planned

### v1.8.0 — Origin/Destination Lookup — in progress
Route (origin/destination airport) enrichment by callsign, added alongside the existing hexdb.io aircraft enrichment. Only applicable to aircraft broadcasting a callsign. hexdb.io only covers static aircraft data (registration/type/operator), not live routes, so this needs a second, real-time-aware source.

### v1.9.0 — Geofence Zones
`binary_sensor.fr24_geofence` — on when any aircraft (or optionally only watched aircraft) enters a defined radius around a configurable point (defaults to HA home location). Radius and centre point configurable via options flow. Attributes include full aircraft details and distance. Enables automations that react to aircraft entering your local airspace without relying on altitude alone.

### v1.10.0 — Statistics & History
- Sensors for peak aircraft counts, busiest time-of-day, most common aircraft types
- Optional CSV logging of all tracked aircraft for long-term analysis
- Dashboard card showing activity over time

---

## Ideas / Backlog
- MLAT-only aircraft indicator (position less reliable)
- Integration with ADS-B Exchange or other aggregators as an alternative data source
- Persistent enrichment cache (survive HA restarts via HA storage API)
