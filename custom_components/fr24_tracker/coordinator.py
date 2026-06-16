import logging
from datetime import timedelta

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    DOMAIN,
    F_ICAO, F_LAT, F_LON, F_TRACK, F_ALTITUDE,
    F_SPEED, F_SQUAWK, F_TIMESTAMP, F_VERT_RATE, F_CALLSIGN,
    MIN_FIELDS,
)

_LOGGER = logging.getLogger(__name__)


def _parse_aircraft(icao: str, fields: list) -> dict | None:
    if len(fields) < MIN_FIELDS:
        return None
    lat = fields[F_LAT]
    lon = fields[F_LON]
    # Both 0,0 means no position fix received
    has_position = not (lat == 0 and lon == 0)
    return {
        "icao": icao,
        "latitude": lat if has_position else None,
        "longitude": lon if has_position else None,
        "track": fields[F_TRACK],
        "altitude": fields[F_ALTITUDE],
        "speed": fields[F_SPEED],
        "squawk": fields[F_SQUAWK],
        "last_seen": fields[F_TIMESTAMP],
        "vertical_rate": fields[F_VERT_RATE],
        "callsign": fields[F_CALLSIGN] or None,
    }


class FR24DataUpdateCoordinator(DataUpdateCoordinator):
    def __init__(
        self, hass: HomeAssistant, host: str, port: int, scan_interval: int
    ) -> None:
        self.host = host
        self.port = port
        self._url = f"http://{host}:{port}/flights.json"
        self._session = async_get_clientsession(hass)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
        )

    async def _async_update_data(self) -> dict:
        try:
            async with self._session.get(
                self._url, timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                resp.raise_for_status()
                raw = await resp.json(content_type=None)
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"FR24 feeder unreachable: {err}") from err

        result = {}
        for icao, fields in raw.items():
            parsed = _parse_aircraft(icao, fields)
            if parsed is not None:
                result[icao] = parsed
        return result
