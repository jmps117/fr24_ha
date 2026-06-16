import logging

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
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
    known: set[str] = set()

    @callback
    def _check_for_new_aircraft() -> None:
        new = [
            FR24TrackerEntity(coordinator, icao)
            for icao, data in coordinator.data.items()
            if icao not in known and data["latitude"] is not None
        ]
        for entity in new:
            known.add(entity.icao)
        if new:
            async_add_entities(new)

    coordinator.async_add_listener(_check_for_new_aircraft)
    _check_for_new_aircraft()


class FR24TrackerEntity(CoordinatorEntity, TrackerEntity):
    _attr_icon = "mdi:airplane"

    def __init__(self, coordinator: FR24DataUpdateCoordinator, icao: str) -> None:
        super().__init__(coordinator)
        self.icao = icao
        self._attr_unique_id = f"fr24_{icao}"

    @property
    def _data(self) -> dict:
        return self.coordinator.data.get(self.icao, {})

    @property
    def name(self) -> str:
        callsign = self._data.get("callsign")
        return callsign if callsign else self.icao.upper()

    @property
    def latitude(self) -> float | None:
        return self._data.get("latitude")

    @property
    def longitude(self) -> float | None:
        return self._data.get("longitude")

    @property
    def source_type(self) -> SourceType:
        return SourceType.GPS

    @property
    def battery_level(self) -> int | None:
        return None

    @property
    def location_accuracy(self) -> int:
        return 0

    @property
    def available(self) -> bool:
        return self.icao in self.coordinator.data and self.coordinator.last_update_success

    @property
    def extra_state_attributes(self) -> dict:
        d = self._data
        return {
            "icao": self.icao,
            "callsign": d.get("callsign"),
            "altitude_ft": d.get("altitude"),
            "speed_kts": d.get("speed"),
            "track_deg": d.get("track"),
            "squawk": d.get("squawk"),
            "vertical_rate_fpm": d.get("vertical_rate"),
            "last_seen": d.get("last_seen"),
        }
