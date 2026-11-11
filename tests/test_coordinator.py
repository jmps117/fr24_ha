import pytest

from custom_components.fr24_tracker.coordinator import (
    ADSBDB_URL,
    HEXDB_URL,
    ROUTE_CACHE_MAX_SIZE,
    FR24DataUpdateCoordinator,
    _normalize_callsign,
    _parse_aircraft,
    _parse_route,
)

FEEDER = "http://feeder.test:8754/flights.json"


def _fields(lat=51.5, lon=-0.1, callsign="BAW123", squawk="1234", altitude=3500):
    """One flights.json row: 17+ positional fields (see const.py's F_* indices)."""
    row = [""] * 17
    row[1], row[2], row[3], row[4], row[5] = lat, lon, 90, altitude, 250
    row[6], row[10], row[15], row[16] = squawk, 1_700_000_000, -640, callsign
    return row


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("baw123 ", "BAW123"),
        ("EZY45", "EZY45"),
        ("", None),
        (None, None),
        ("A", None),  # too short
        ("ABCDEFGHI", None),  # too long
        ("BAW/../x", None),  # spoofed ADS-B text must never reach the URL path
        ("BAW 12", None),
    ],
)
def test_normalize_callsign(raw, expected):
    assert _normalize_callsign(raw) == expected


def test_parse_aircraft_treats_0_0_as_no_position_fix():
    parsed = _parse_aircraft("abc123", _fields(lat=0, lon=0, callsign=""))
    assert parsed["latitude"] is None and parsed["longitude"] is None
    assert parsed["callsign"] is None


def test_parse_aircraft_rejects_a_short_row():
    assert _parse_aircraft("abc123", [0] * 16) is None


def test_parse_route_handles_a_miss_and_a_hit():
    assert _parse_route({"response": "unknown callsign"}) == {}
    route = _parse_route(
        {
            "response": {
                "flightroute": {
                    "origin": {"iata_code": "LHR", "name": "Heathrow"},
                    "destination": {"iata_code": "JFK"},
                    "airline": {"name": "British Airways"},
                }
            }
        }
    )
    assert route["origin_iata"] == "LHR"
    assert route["destination_iata"] == "JFK"
    assert route["route_airline"] == "British Airways"
    assert route["destination_name"] is None


async def test_update_merges_enrichment_and_route_and_caches_misses(hass, aioclient_mock):
    aioclient_mock.get(
        FEEDER,
        json={"abc123": _fields(), "def456": _fields(callsign="bad/cs"), "short": [1, 2]},
    )
    aioclient_mock.get(
        HEXDB_URL.format(icao="abc123"),
        json={"Registration": "G-EUPT", "ICAOTypeCode": "A319", "RegisteredOwners": "BA"},
    )
    aioclient_mock.get(HEXDB_URL.format(icao="def456"), status=404)
    aioclient_mock.get(
        ADSBDB_URL.format(callsign="BAW123"),
        json={"response": {"flightroute": {"origin": {"iata_code": "LHR"}}}},
    )

    coordinator = FR24DataUpdateCoordinator(hass, "feeder.test", 8754, 30)
    data = await coordinator._async_update_data()

    assert set(data) == {"abc123", "def456"}  # the short row is dropped
    assert data["abc123"]["registration"] == "G-EUPT"
    assert data["abc123"]["origin_iata"] == "LHR"
    assert "registration" not in data["def456"]  # hexdb 404, cached as a miss
    # The invalid callsign was never looked up.
    assert not any("bad" in str(url) for _, url, _, _ in aioclient_mock.mock_calls)

    calls_before = aioclient_mock.call_count
    await coordinator._async_update_data()
    # Second cycle: only the feeder again; enrichment and routes (hits and misses) are cached.
    assert aioclient_mock.call_count == calls_before + 1


async def test_an_unreachable_feeder_raises_update_failed(hass, aioclient_mock):
    from homeassistant.helpers.update_coordinator import UpdateFailed

    aioclient_mock.get(FEEDER, status=500)
    coordinator = FR24DataUpdateCoordinator(hass, "feeder.test", 8754, 30)
    with pytest.raises(UpdateFailed):
        await coordinator._async_update_data()


async def test_route_cache_evicts_least_recently_used(hass):
    coordinator = FR24DataUpdateCoordinator(hass, "feeder.test", 8754, 30)
    for i in range(ROUTE_CACHE_MAX_SIZE):
        coordinator._route_cache_set(f"CS{i}", {"n": i})
    coordinator._route_cache_get("CS0")  # touch the oldest, so CS1 becomes the oldest
    coordinator._route_cache_set("NEW", {})

    assert len(coordinator._route_cache) == ROUTE_CACHE_MAX_SIZE
    assert coordinator._route_cache_get("CS0") == {"n": 0}
    assert coordinator._route_cache_get("CS1") is None
