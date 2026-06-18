import asyncio
from datetime import timedelta
import logging

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    DOMAIN,
    F_ALTITUDE,
    F_CALLSIGN,
    F_LAT,
    F_LON,
    F_SPEED,
    F_SQUAWK,
    F_TIMESTAMP,
    F_TRACK,
    F_VERT_RATE,
    MIN_FIELDS,
)

_LOGGER = logging.getLogger(__name__)

HEXDB_URL = "https://hexdb.io/api/v1/aircraft/{icao}"
ENRICHMENT_TIMEOUT = aiohttp.ClientTimeout(total=5)
ENRICHMENT_CONCURRENCY = 4


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


def _parse_enrichment(data: dict) -> dict:
    return {
        "registration": data.get("Registration") or None,
        "icao_type": data.get("ICAOTypeCode") or None,
        "aircraft_type": data.get("Type") or None,
        "operator": data.get("RegisteredOwners") or None,
    }


class FR24DataUpdateCoordinator(DataUpdateCoordinator):
    def __init__(self, hass: HomeAssistant, host: str, port: int, scan_interval: int) -> None:
        self.host = host
        self.port = port
        self._url = f"http://{host}:{port}/flights.json"
        self._session = async_get_clientsession(hass)
        self._enrichment_cache: dict[str, dict] = {}
        self._enrichment_sem = asyncio.Semaphore(ENRICHMENT_CONCURRENCY)
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=scan_interval),
        )

    async def _fetch_enrichment(self, icao: str) -> None:
        async with self._enrichment_sem:
            try:
                url = HEXDB_URL.format(icao=icao)
                async with self._session.get(url, timeout=ENRICHMENT_TIMEOUT) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        self._enrichment_cache[icao] = _parse_enrichment(data)
                        return
            except Exception:
                pass
            # Cache the miss so we don't retry every poll cycle
            self._enrichment_cache[icao] = {}

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

        # Fetch enrichment for any ICAOs we haven't seen before
        new_icaos = [icao for icao in result if icao not in self._enrichment_cache]
        if new_icaos:
            await asyncio.gather(*[self._fetch_enrichment(icao) for icao in new_icaos])

        # Merge enrichment into each aircraft dict
        for icao, aircraft in result.items():
            aircraft.update(self._enrichment_cache.get(icao, {}))

        return result
