import asyncio
from collections import OrderedDict
from datetime import timedelta
import logging
import re

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

# adsbdb.com — free, keyless, CORS-enabled, purpose-built for callsign ->
# probable-route lookups (hexdb.io only covers static aircraft data, not
# routes). See https://github.com/mrjackwills/adsbdb.
ADSBDB_URL = "https://api.adsbdb.com/v0/callsign/{callsign}"
ROUTE_TIMEOUT = aiohttp.ClientTimeout(total=5)
ROUTE_CONCURRENCY = 4
# Unlike _enrichment_cache (bounded by the finite set of aircraft hexes a
# fixed feeder location ever sees), callsigns churn constantly — every
# flight number, positioning leg and daily variant mints a new key — so this
# cache needs an explicit bound or it grows for as long as HA stays up.
ROUTE_CACHE_MAX_SIZE = 500
# Real ICAO callsigns are uppercase letters/digits only, 2-8 chars. Callsign
# comes straight off an ADS-B broadcast (spoofable over SDR) and is
# interpolated into the adsbdb.com request path, so it's validated before
# ever being used as a cache key or URL segment — not just normalized.
CALLSIGN_RE = re.compile(r"^[A-Z0-9]{2,8}$")


def _normalize_callsign(raw: str | None) -> str | None:
    if not raw:
        return None
    callsign = raw.strip().upper()
    return callsign if CALLSIGN_RE.fullmatch(callsign) else None


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


def _parse_route(data: dict) -> dict:
    # A miss (unknown callsign) comes back as {"response": "unknown callsign"}
    # — a string, not a dict — so this returns {} rather than raising.
    flightroute = data.get("response")
    if not isinstance(flightroute, dict):
        return {}
    flightroute = flightroute.get("flightroute") or {}
    origin = flightroute.get("origin") or {}
    destination = flightroute.get("destination") or {}
    airline = flightroute.get("airline") or {}
    return {
        "origin_iata": origin.get("iata_code") or None,
        "origin_icao": origin.get("icao_code") or None,
        "origin_name": origin.get("name") or None,
        "origin_municipality": origin.get("municipality") or None,
        "destination_iata": destination.get("iata_code") or None,
        "destination_icao": destination.get("icao_code") or None,
        "destination_name": destination.get("name") or None,
        "destination_municipality": destination.get("municipality") or None,
        "route_airline": airline.get("name") or None,
    }


class FR24DataUpdateCoordinator(DataUpdateCoordinator):
    def __init__(self, hass: HomeAssistant, host: str, port: int, scan_interval: int) -> None:
        self.host = host
        self.port = port
        self._url = f"http://{host}:{port}/flights.json"
        self._session = async_get_clientsession(hass)
        self._enrichment_cache: dict[str, dict] = {}
        self._enrichment_sem = asyncio.Semaphore(ENRICHMENT_CONCURRENCY)
        # Keyed by callsign, not ICAO — a callsign changes per-flight while
        # an aircraft's hex stays fixed, so this needs its own cache rather
        # than sharing the per-aircraft enrichment cache above. Bounded LRU
        # (see ROUTE_CACHE_MAX_SIZE) — use _route_cache_get/_set, not the
        # dict directly, so eviction ordering stays correct.
        self._route_cache: OrderedDict[str, dict] = OrderedDict()
        self._route_sem = asyncio.Semaphore(ROUTE_CONCURRENCY)
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

    def _route_cache_get(self, callsign: str) -> dict | None:
        data = self._route_cache.get(callsign)
        if data is not None:
            self._route_cache.move_to_end(callsign)
        return data

    def _route_cache_set(self, callsign: str, data: dict) -> None:
        self._route_cache[callsign] = data
        self._route_cache.move_to_end(callsign)
        if len(self._route_cache) > ROUTE_CACHE_MAX_SIZE:
            self._route_cache.popitem(last=False)

    async def _fetch_route(self, callsign: str) -> None:
        async with self._route_sem:
            try:
                url = ADSBDB_URL.format(callsign=callsign)
                async with self._session.get(url, timeout=ROUTE_TIMEOUT) as resp:
                    if resp.status == 200:
                        data = await resp.json(content_type=None)
                        self._route_cache_set(callsign, _parse_route(data))
                        return
            except Exception:
                pass
            # 404 (unknown callsign), a malformed callsign, or a network
            # error — cache the miss so we don't retry every poll cycle.
            self._route_cache_set(callsign, {})

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

        # Route lookups, keyed by callsign — only aircraft broadcasting one
        # that also looks like a real ICAO callsign are eligible (the raw
        # value is attacker-reachable ADS-B data and gets interpolated into
        # the adsbdb.com request path, so it's validated, not just read).
        callsigns = {
            cs for ac in result.values() if (cs := _normalize_callsign(ac.get("callsign")))
        }
        new_callsigns = [cs for cs in callsigns if cs not in self._route_cache]
        if new_callsigns:
            await asyncio.gather(*[self._fetch_route(cs) for cs in new_callsigns])

        for aircraft in result.values():
            callsign = _normalize_callsign(aircraft.get("callsign"))
            if callsign:
                aircraft.update(self._route_cache_get(callsign) or {})

        return result
