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

---

## Planned

### v1.5.0 — Feeder Map
- `custom:fr24-map-card` — native Lovelace card showing **only** aircraft your feeder has detected; reads directly from `sensor.fr24_current_flights` via the `hass` object, no token or auth required
- Rotating plane icons driven by heading, auto-centred on your HA home location
- Click any aircraft for a full detail panel: callsign, registration, type, operator, altitude, speed, heading, vertical rate, squawk
- Aircraft removed from the map when they leave the feed; live count badge in the corner
- Card JS deployed automatically to `www/fr24_tracker/` and registered as a frontend resource on integration load — no manual resource setup needed
- Works in the HA browser frontend and mobile app
- Low altitude radius filter — optionally restrict `binary_sensor.fr24_low_altitude` to aircraft within a configurable distance (km) of your HA home location; 0 = no filter

### v1.6.0 — Geofence Zones
`binary_sensor.fr24_geofence` — on when any aircraft (or optionally only watched aircraft) enters a defined radius around a configurable point (defaults to HA home location). Radius and centre point configurable via options flow. Attributes include full aircraft details and distance. Enables automations that react to aircraft entering your local airspace without relying on altitude alone.

### v1.7.0 — Statistics & History
- Sensors for peak aircraft counts, busiest time-of-day, most common aircraft types
- Optional CSV logging of all tracked aircraft for long-term analysis
- Dashboard card showing activity over time

---

## Ideas / Backlog
- MLAT-only aircraft indicator (position less reliable)
- Integration with ADS-B Exchange or other aggregators as an alternative data source
- Persistent enrichment cache (survive HA restarts via HA storage API)
- Origin/destination lookup via callsign — requires a real-time flight data API (e.g. AviationStack free tier) since hexdb.io only provides static aircraft data; only applicable to aircraft with a callsign
