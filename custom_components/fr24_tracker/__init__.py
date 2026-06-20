from pathlib import Path
import shutil

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_HOST, CONF_PORT, CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL, DOMAIN
from .coordinator import FR24DataUpdateCoordinator

PLATFORMS = ["binary_sensor", "device_tracker", "sensor"]


def _deploy_assets(hass: HomeAssistant) -> None:
    base = Path(__file__).parent

    www_dir = Path(hass.config.path("www/fr24_tracker"))
    www_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(base / "plane.svg", www_dir / "plane.svg")
    shutil.copy(base / "fr24-map-card.js", www_dir / "fr24-map-card.js")

    bp_dst = Path(hass.config.path("blueprints/automation/fr24_tracker"))
    bp_dst.mkdir(parents=True, exist_ok=True)
    for bp in (base / "blueprints").glob("*.yaml"):
        shutil.copy(bp, bp_dst / bp.name)


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await hass.async_add_executor_job(_deploy_assets, hass)

    coordinator = FR24DataUpdateCoordinator(
        hass,
        host=entry.data[CONF_HOST],
        port=entry.data[CONF_PORT],
        scan_interval=entry.data.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL),
    )
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unloaded
