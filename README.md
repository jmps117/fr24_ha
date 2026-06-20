# FR24 Flight Tracker — Home Assistant Integration

A Home Assistant custom integration that tracks aircraft from your local FR24 feeder, displays them on the HA map, and exposes enriched flight data for automations and dashboards.

## Features

- Live aircraft positions on the Home Assistant map (one `device_tracker` entity per aircraft with position fix)
- Feeder-only interactive map (`custom:fr24-map-card`) — shows **only** aircraft your radar has detected, with rotating icons and a click panel for full aircraft details; deployed and registered automatically, no token or manual resource setup required
- Plane icon map markers — deployed automatically to `www/fr24_tracker/plane.svg` on setup
- Attributes per aircraft: callsign, registration, aircraft type, operator, altitude, speed, heading, squawk, vertical rate
- Aircraft registration and type enriched via [hexdb.io](https://hexdb.io) — looked up once per ICAO hex and cached
- Emergency squawk binary sensor — fires immediately on 7500 (hijacking), 7600 (radio failure), or 7700 (general emergency)
- Flights list sensor exposing all aircraft as a structured attribute — enables Jinja2 dashboard templates
- Low altitude binary sensor — fires when any aircraft drops below a configurable threshold; optional radius filter restricts it to aircraft within a set distance of your home
- Watched aircraft binary sensor — fires when a specific callsign or registration appears in the feed
- Automation blueprints deployed automatically — ready to use from Settings → Automations → Blueprints
- Automatic entity cleanup — entities are removed from the registry when aircraft leave the feed
- Polls your local feeder every 30 seconds (configurable)
- Config flow UI — no YAML needed

## Requirements

- A running [FR24 feeder](https://www.flightradar24.com/share-your-data) with its local web UI accessible on your network (default port 8754)
- Home Assistant 2023.6 or newer

## Installation via HACS

1. In HACS → **Integrations** → click the three-dot menu → **Custom repositories**
2. Add `https://github.com/jmps117/fr24_ha` and select category **Integration**
3. Install **FR24 Flight Tracker**
4. Restart Home Assistant

## Manual installation

Copy `custom_components/fr24_tracker/` into your HA `config/custom_components/` directory and restart.

## Setup

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **FR24 Flight Tracker**
3. Enter your feeder's host IP and port (default port: `8754`)
4. Adjust the scan interval if desired (default: 30 seconds)

## Entities created

| Entity | Type | Description |
|--------|------|-------------|
| `device_tracker.fr24_<icao>` | Device Tracker | One per aircraft with position fix — appears on HA map |
| `binary_sensor.fr24_emergency_squawk` | Binary Sensor | On when any aircraft squawks 7500 / 7600 / 7700 |
| `sensor.fr24_aircraft_tracked` | Sensor | Total aircraft in the feed |
| `sensor.fr24_aircraft_with_position` | Sensor | Aircraft with a GPS position fix |
| `sensor.fr24_nearest_aircraft` | Sensor | Distance (km) to nearest aircraft from your HA home location |
| `sensor.fr24_current_flights` | Sensor | All aircraft as a structured `flights` list attribute |
| `binary_sensor.fr24_low_altitude` | Binary Sensor | On when any aircraft is below the configured altitude threshold |
| `binary_sensor.fr24_watched_aircraft` | Binary Sensor | On when a watched callsign or registration is in the feed |

## Dashboard

Copy `dashboard_example.yaml` from the repo into a **Manual** card in HA (Edit Dashboard → Add Card → Manual).

The example includes:
- Stats and emergency squawk status
- Markdown flight list — callsign, registration, operator, type, altitude, speed, climb/descend state — showing only positioned aircraft sorted high-to-low
- Feeder-only interactive map — rotating plane icons, click for full aircraft details, only your radar's aircraft

### Feeder map setup

The map card (`fr24-map-card`) is deployed and registered automatically when the integration loads — no manual resource registration or token required. Add it to any dashboard with:

```yaml
type: custom:fr24-map-card
```

Optional configuration:

```yaml
type: custom:fr24-map-card
zoom: 9          # initial zoom level (default: 9)
height: 500px    # card height (default: 500px)
```

The card loads map tiles from OpenStreetMap, which requires the browser viewing the dashboard to have internet access. The HA server itself does not need internet access.

## Options

After setup, click **Configure** on the integration card in Settings → Devices & Services to adjust:

| Option | Default | Description |
|--------|---------|-------------|
| Low altitude threshold | 3000 m | Aircraft below this altitude trigger `binary_sensor.fr24_low_altitude` |
| Low altitude radius | 0 (disabled) | Only count aircraft within this many km of your HA home location — 0 means no radius filter |
| Watch list | *(empty)* | Comma-separated callsigns/registrations to watch for (e.g. `BAW123,G-EZWB`) — case-insensitive, matches on either |

**Choosing a low altitude threshold:**

| Threshold | Equivalent | What you'll catch |
|-----------|------------|-------------------|
| 5000 m | ~16 400 ft | Most aircraft on approach/departure within range |
| 3000 m *(default)* | ~9 800 ft | Aircraft clearly in approach/departure phase or low transits |
| 1500 m | ~5 000 ft | Noticeably low aircraft — GA circuits, helicopter ops |
| 300 m | ~1 000 ft | Very low flying — military low-level, crop dusters, emergencies |

## Blueprints

Two automation blueprints are deployed automatically to `config/blueprints/automation/fr24_tracker/` on setup and available in Settings → Automations → Blueprints:

- **FR24 Low Altitude Alert** — notify when aircraft drop below your threshold
- **FR24 Watched Aircraft Alert** — notify when a watched callsign or registration appears

## Emergency squawk automation example

```yaml
trigger:
  - platform: state
    entity_id: binary_sensor.fr24_emergency_squawk
    to: "on"
action:
  - service: notify.mobile_app
    data:
      message: >
        {{ trigger.to_state.attributes.aircraft[0].description }}
        — {{ trigger.to_state.attributes.aircraft[0].callsign }}
        squawking {{ trigger.to_state.attributes.aircraft[0].squawk }}
```

## Notes

- Aircraft without a position fix (received but out of ADS-B range) appear in the sensors but not on the map
- Aircraft are removed from the entity registry when they leave the feed
- Enrichment lookups (registration, type, operator) are made once per ICAO hex per session — hexdb.io is queried at most 4 requests concurrently
- The plane icon SVG and map card JS are redeployed on every HA restart to keep them in sync with the installed version
