# Roadmap

## Released

### v1.0.0
- `device_tracker` entity per aircraft with position fix — appears on HA map
- Attributes per aircraft: callsign, altitude, speed, heading, squawk, vertical rate, last seen
- Sensors: total aircraft tracked, aircraft with position fix, nearest aircraft (km + details)
- Config flow UI — no YAML required
- Polls local FR24 feeder at configurable interval (default 30s)

### v1.1.0
- Plane icon on map instead of generic dot marker (`/local/plane.svg`)
- Automatic entity cleanup — aircraft removed from entity registry when they leave the feed
- Emergency squawk binary sensor (`binary_sensor.fr24_emergency_squawk`) — fires on 7500 (hijacking), 7600 (radio failure), 7700 (general emergency) with full aircraft details in attributes

### v1.2.0 — Data Enrichment
- Aircraft registration, ICAO type code, full type name, and operator added as attributes on all entities
- Lookups via [hexdb.io](https://hexdb.io) — one request per new ICAO hex, cached for the session
- Up to 4 concurrent enrichment requests with semaphore limiting
- Cache misses recorded so unavailable ICAOs are not retried every poll cycle

---

## Planned

### v1.3.0 — Rotating Map Icons
Plane icons that rotate to match the aircraft's current heading on the map. Requires a compatible custom Lovelace map card from HACS. Target cards to investigate:
- `lovelace-map-card`
- `ha-flightradar-card`

### v1.4.0 — Alerts & Automations
Additional sensors and helpers to make automations easier:
- Low altitude alert binary sensor (configurable threshold in metres)
- Specific callsign/registration watch sensor — triggers when a named aircraft enters the feed
- Example automation blueprints bundled with the integration

### v1.5.0 — Aircraft Table Card
Custom Lovelace card showing all currently tracked aircraft in a sortable table with enriched data (registration, type, operator, altitude, speed, heading). Installable via HACS as a frontend resource.

### v1.6.0 — Flight Path Trails
Store recent position history in the coordinator and render trail lines on the map showing where each aircraft has been during the current session. Trail length configurable (default: 10 positions).

### v1.7.0 — Statistics & History
- Sensors for peak aircraft counts, busiest time-of-day, most common aircraft types
- Optional CSV logging of all tracked aircraft for long-term analysis
- Dashboard card showing activity over time

---

## Ideas / Backlog
- MLAT-only aircraft indicator (position less reliable)
- Integration with ADS-B Exchange or other aggregators as an alternative data source
- Geofence sensor — alert when any aircraft enters a defined radius around a point
- Persistent enrichment cache (survive HA restarts via HA storage API)
