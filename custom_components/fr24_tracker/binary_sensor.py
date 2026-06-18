import logging

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    CONF_LOW_ALT_RADIUS,
    CONF_LOW_ALT_THRESHOLD,
    CONF_WATCH_LIST,
    DEFAULT_LOW_ALT_RADIUS,
    DEFAULT_LOW_ALT_THRESHOLD,
    DEFAULT_WATCH_LIST,
    DOMAIN,
)
from .coordinator import FR24DataUpdateCoordinator
from .util import haversine_km

_LOGGER = logging.getLogger(__name__)

EMERGENCY_SQUAWKS = {
    "7500": "Hijacking",
    "7600": "Radio Failure",
    "7700": "General Emergency",
}

_FT_PER_METRE = 3.28084


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: FR24DataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            FR24EmergencySquawkSensor(coordinator, entry),
            FR24LowAltitudeSensor(coordinator, entry, hass),
            FR24WatchedAircraftSensor(coordinator, entry),
        ]
    )


class FR24EmergencySquawkSensor(CoordinatorEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:alarm-light"

    def __init__(self, coordinator: FR24DataUpdateCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_emergency"
        self._attr_name = "FR24 Emergency Squawk"

    def _emergencies(self) -> list[dict]:
        if not self.coordinator.data:
            return []
        result = []
        for ac in self.coordinator.data.values():
            squawk = ac.get("squawk", "")
            if squawk in EMERGENCY_SQUAWKS:
                result.append(
                    {
                        "icao": ac["icao"],
                        "callsign": ac.get("callsign"),
                        "squawk": squawk,
                        "description": EMERGENCY_SQUAWKS[squawk],
                        "latitude": ac.get("latitude"),
                        "longitude": ac.get("longitude"),
                        "altitude_ft": ac.get("altitude"),
                    }
                )
        return result

    @property
    def is_on(self) -> bool:
        return bool(self._emergencies())

    @property
    def extra_state_attributes(self) -> dict:
        emergencies = self._emergencies()
        return {
            "count": len(emergencies),
            "aircraft": emergencies,
        }


class FR24LowAltitudeSensor(CoordinatorEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:airplane-alert"

    def __init__(
        self,
        coordinator: FR24DataUpdateCoordinator,
        entry: ConfigEntry,
        hass: HomeAssistant,
    ) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._hass = hass
        self._attr_unique_id = f"{entry.entry_id}_low_altitude"
        self._attr_name = "FR24 Low Altitude"

    @property
    def _threshold_ft(self) -> float:
        threshold_m = self._entry.options.get(CONF_LOW_ALT_THRESHOLD, DEFAULT_LOW_ALT_THRESHOLD)
        return threshold_m * _FT_PER_METRE

    @property
    def _radius_km(self) -> float:
        return self._entry.options.get(CONF_LOW_ALT_RADIUS, DEFAULT_LOW_ALT_RADIUS)

    def _low_aircraft(self) -> list[dict]:
        if not self.coordinator.data:
            return []
        radius = self._radius_km
        home_lat = self._hass.config.latitude
        home_lon = self._hass.config.longitude
        result = []
        for ac in self.coordinator.data.values():
            alt = ac.get("altitude", 0)
            lat = ac.get("latitude")
            lon = ac.get("longitude")
            if lat is None or not (0 < alt < self._threshold_ft):
                continue
            dist = haversine_km(home_lat, home_lon, lat, lon)
            if radius > 0 and dist > radius:
                continue
            result.append(
                {
                    "icao": ac["icao"],
                    "callsign": ac.get("callsign"),
                    "registration": ac.get("registration"),
                    "aircraft_type": ac.get("aircraft_type"),
                    "operator": ac.get("operator"),
                    "altitude_ft": alt,
                    "altitude_m": round(alt / _FT_PER_METRE),
                    "distance_km": round(dist, 1),
                    "latitude": lat,
                    "longitude": lon,
                }
            )
        return result

    @property
    def is_on(self) -> bool:
        return bool(self._low_aircraft())

    @property
    def extra_state_attributes(self) -> dict:
        aircraft = self._low_aircraft()
        attrs: dict = {
            "threshold_m": self._entry.options.get(
                CONF_LOW_ALT_THRESHOLD, DEFAULT_LOW_ALT_THRESHOLD
            ),
            "threshold_ft": round(self._threshold_ft),
            "count": len(aircraft),
            "aircraft": aircraft,
        }
        radius = self._radius_km
        if radius > 0:
            attrs["radius_km"] = radius
        return attrs


class FR24WatchedAircraftSensor(CoordinatorEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PRESENCE
    _attr_icon = "mdi:airplane-check"

    def __init__(self, coordinator: FR24DataUpdateCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_watched"
        self._attr_name = "FR24 Watched Aircraft"

    @property
    def _watch_set(self) -> set[str]:
        raw = self._entry.options.get(CONF_WATCH_LIST, DEFAULT_WATCH_LIST)
        return {w.strip().upper() for w in raw.split(",") if w.strip()}

    def _matches(self) -> list[dict]:
        if not self.coordinator.data or not self._watch_set:
            return []
        result = []
        for ac in self.coordinator.data.values():
            callsign = (ac.get("callsign") or "").upper()
            registration = (ac.get("registration") or "").upper()
            if callsign in self._watch_set or registration in self._watch_set:
                result.append(
                    {
                        "icao": ac["icao"],
                        "callsign": ac.get("callsign"),
                        "registration": ac.get("registration"),
                        "aircraft_type": ac.get("aircraft_type"),
                        "operator": ac.get("operator"),
                        "altitude_ft": ac.get("altitude"),
                        "latitude": ac.get("latitude"),
                        "longitude": ac.get("longitude"),
                    }
                )
        return result

    @property
    def is_on(self) -> bool:
        return bool(self._matches())

    @property
    def extra_state_attributes(self) -> dict:
        aircraft = self._matches()
        return {
            "watching": sorted(self._watch_set),
            "count": len(aircraft),
            "aircraft": aircraft,
        }
