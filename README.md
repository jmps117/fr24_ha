# FR24 Flight Tracker — Home Assistant Integration

A Home Assistant custom integration that tracks aircraft from your local FR24 feeder, displays them on the HA map, and exposes enriched flight data for automations.

## Features

- Live aircraft positions on the Home Assistant map (one `device_tracker` entity per aircraft with position fix)
- Plane icon map markers — save a plane SVG to `/config/www/plane.svg` (see Map Setup below)
- Attributes per aircraft: callsign, registration, aircraft type, operator, altitude, speed, heading, squawk, vertical rate
- Aircraft registration and type enriched via [hexdb.io](https://hexdb.io) — looked up once per ICAO hex and cached
- Emergency squawk binary sensor — fires immediately on 7500 (hijacking), 7600 (radio failure), or 7700 (general emergency)
- Sensors: total aircraft tracked, aircraft with position fix, distance to nearest aircraft
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

## Map setup

Add a **Map** card to your Lovelace dashboard — all `device_tracker.fr24_*` entities appear automatically as plane icons. The integration deploys the icon to your HA `www` folder automatically on first setup, no manual steps required.

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
- Enrichment lookups (registration, type, operator) are made once per ICAO hex per session and cached — hexdb.io is queried at most 4 requests concurrently
- The plane icon SVG is deployed automatically to `www/fr24_tracker/plane.svg` on first setup
