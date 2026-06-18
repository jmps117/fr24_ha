import logging

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import FR24DataUpdateCoordinator

_LOGGER = logging.getLogger(__name__)

EMERGENCY_SQUAWKS = {
    "7500": "Hijacking",
    "7600": "Radio Failure",
    "7700": "General Emergency",
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: FR24DataUpdateCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([FR24EmergencySquawkSensor(coordinator, entry)])


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
