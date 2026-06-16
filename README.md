# FR24 Flight Tracker — Home Assistant Integration

A Home Assistant custom integration that tracks aircraft from your local FR24 feeder and displays them on the HA map.

## Features

- Live aircraft positions on the Home Assistant map (one `device_tracker` entity per aircraft)
- Attributes per aircraft: callsign, altitude, speed, heading, squawk, vertical rate
- Sensors: total aircraft tracked, aircraft with position fix, distance to nearest aircraft
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
| `device_tracker.fr24_<icao>` | Device Tracker | One per aircraft with position fix |
| `sensor.fr24_aircraft_tracked` | Sensor | Total aircraft in the feed |
| `sensor.fr24_aircraft_with_position` | Sensor | Aircraft with a GPS position fix |
| `sensor.fr24_nearest_aircraft` | Sensor | Distance (km) to nearest aircraft from your HA home location |

## Map setup

Add a **Map** card to your Lovelace dashboard. All `device_tracker.fr24_*` entities will appear automatically as aircraft icons.

## Notes

- Aircraft without a position fix (received but out of ADS-B range) appear in the sensors but not on the map
- When an aircraft leaves the feed it becomes **Unavailable**; the entity persists in the registry and will become active again if the aircraft returns
