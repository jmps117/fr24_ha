import logging
import math

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import FR24DataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: FR24DataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            FR24TotalCountSensor(coordinator, entry),
            FR24PositionedCountSensor(coordinator, entry),
            FR24NearestAircraftSensor(coordinator, entry, hass),
        ]
    )


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class FR24TotalCountSensor(CoordinatorEntity, SensorEntity):
    _attr_icon = "mdi:airplane-search"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "aircraft"

    def __init__(self, coordinator: FR24DataUpdateCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_total"
        self._attr_name = "FR24 Aircraft Tracked"

    @property
    def native_value(self) -> int:
        return len(self.coordinator.data) if self.coordinator.data else 0


class FR24PositionedCountSensor(CoordinatorEntity, SensorEntity):
    _attr_icon = "mdi:map-marker-radius"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "aircraft"

    def __init__(self, coordinator: FR24DataUpdateCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_positioned"
        self._attr_name = "FR24 Aircraft With Position"

    @property
    def native_value(self) -> int:
        if not self.coordinator.data:
            return 0
        return sum(1 for a in self.coordinator.data.values() if a["latitude"] is not None)


class FR24NearestAircraftSensor(CoordinatorEntity, SensorEntity):
    _attr_icon = "mdi:airplane-landing"
    _attr_native_unit_of_measurement = "km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        coordinator: FR24DataUpdateCoordinator,
        entry: ConfigEntry,
        hass: HomeAssistant,
    ) -> None:
        super().__init__(coordinator)
        self._hass = hass
        self._attr_unique_id = f"{entry.entry_id}_nearest"
        self._attr_name = "FR24 Nearest Aircraft"

    def _nearest(self) -> tuple[float, dict] | tuple[None, None]:
        home_lat = self._hass.config.latitude
        home_lon = self._hass.config.longitude
        if not self.coordinator.data or not home_lat:
            return None, None

        best_dist = None
        best_ac = None
        for ac in self.coordinator.data.values():
            if ac["latitude"] is None:
                continue
            d = _haversine_km(home_lat, home_lon, ac["latitude"], ac["longitude"])
            if best_dist is None or d < best_dist:
                best_dist = d
                best_ac = ac
        return best_dist, best_ac

    @property
    def native_value(self) -> float | None:
        dist, _ = self._nearest()
        return round(dist, 1) if dist is not None else None

    @property
    def extra_state_attributes(self) -> dict:
        _, ac = self._nearest()
        if ac is None:
            return {}
        return {
            "icao": ac["icao"],
            "callsign": ac.get("callsign"),
            "registration": ac.get("registration"),
            "aircraft_type": ac.get("aircraft_type"),
            "operator": ac.get("operator"),
            "altitude_ft": ac.get("altitude"),
            "speed_kts": ac.get("speed"),
            "track_deg": ac.get("track"),
            "squawk": ac.get("squawk"),
            "vertical_rate_fpm": ac.get("vertical_rate"),
        }
