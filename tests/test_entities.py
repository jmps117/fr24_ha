from types import SimpleNamespace
from unittest.mock import MagicMock

from custom_components.fr24_tracker.binary_sensor import (
    FR24EmergencySquawkSensor,
    FR24LowAltitudeSensor,
    FR24WatchedAircraftSensor,
)
from custom_components.fr24_tracker.const import (
    CONF_LOW_ALT_RADIUS,
    CONF_LOW_ALT_THRESHOLD,
    CONF_WATCH_LIST,
)
from custom_components.fr24_tracker.sensor import FR24NearestAircraftSensor

HOME = SimpleNamespace(config=SimpleNamespace(latitude=51.47, longitude=-0.45))


def _coordinator(*aircraft):
    coordinator = MagicMock()
    coordinator.data = {ac["icao"]: ac for ac in aircraft}
    return coordinator


def _entry(**options):
    return SimpleNamespace(entry_id="e1", options=options)


def _ac(icao, lat=51.47, lon=-0.45, altitude=2000, squawk="1234", **extra):
    return {
        "icao": icao,
        "latitude": lat,
        "longitude": lon,
        "altitude": altitude,
        "squawk": squawk,
        **extra,
    }


def test_emergency_squawks_are_reported_with_their_meaning():
    sensor = FR24EmergencySquawkSensor(
        _coordinator(_ac("a", squawk="7700"), _ac("b", squawk="1200")), _entry()
    )
    assert sensor.is_on
    [emergency] = sensor.extra_state_attributes["aircraft"]
    assert emergency["icao"] == "a" and emergency["description"] == "General Emergency"


def test_no_data_means_off_not_an_error():
    sensor = FR24EmergencySquawkSensor(_coordinator(), _entry())
    sensor.coordinator.data = None
    assert sensor.is_on is False


def test_low_altitude_threshold_is_metres_converted_to_feet():
    # 1000 m is about 3281 ft: 3000 ft is under it, 3500 ft is not, 0 ft (on the ground) is ignored.
    sensor = FR24LowAltitudeSensor(
        _coordinator(
            _ac("low", altitude=3000), _ac("high", altitude=3500), _ac("ground", altitude=0)
        ),
        _entry(**{CONF_LOW_ALT_THRESHOLD: 1000}),
        HOME,
    )
    assert [a["icao"] for a in sensor.extra_state_attributes["aircraft"]] == ["low"]
    assert sensor.extra_state_attributes["threshold_ft"] == 3281


def test_low_altitude_radius_filters_by_distance_from_home():
    near = _ac("near", lat=51.48, lon=-0.45)  # ~1 km
    far = _ac("far", lat=52.47, lon=-0.45)  # ~111 km
    sensor = FR24LowAltitudeSensor(
        _coordinator(near, far),
        _entry(**{CONF_LOW_ALT_THRESHOLD: 3000, CONF_LOW_ALT_RADIUS: 10}),
        HOME,
    )
    assert [a["icao"] for a in sensor.extra_state_attributes["aircraft"]] == ["near"]
    assert sensor.extra_state_attributes["radius_km"] == 10


def test_low_altitude_skips_aircraft_without_a_position():
    sensor = FR24LowAltitudeSensor(
        _coordinator(_ac("nofix", lat=None, lon=None)),
        _entry(**{CONF_LOW_ALT_THRESHOLD: 3000}),
        HOME,
    )
    assert sensor.is_on is False


def test_watch_list_matches_callsign_or_registration_case_insensitively():
    sensor = FR24WatchedAircraftSensor(
        _coordinator(
            _ac("a", callsign="baw123"),
            _ac("b", registration="g-euPT"),
            _ac("c", callsign="EZY1"),
        ),
        _entry(**{CONF_WATCH_LIST: " BAW123, G-EUPT ,,"}),
    )
    assert sorted(a["icao"] for a in sensor.extra_state_attributes["aircraft"]) == ["a", "b"]
    assert sensor.extra_state_attributes["watching"] == ["BAW123", "G-EUPT"]


def test_an_empty_watch_list_matches_nothing():
    sensor = FR24WatchedAircraftSensor(
        _coordinator(_ac("a", callsign="")), _entry(**{CONF_WATCH_LIST: ""})
    )
    assert sensor.is_on is False


def test_nearest_aircraft_ignores_ones_without_a_fix():
    sensor = FR24NearestAircraftSensor(
        _coordinator(
            _ac("nofix", lat=None, lon=None),
            _ac("far", lat=52.47, lon=-0.45),
            _ac("near", lat=51.48, lon=-0.45, callsign="BAW1"),
        ),
        _entry(),
        HOME,
    )
    assert sensor.native_value == 1.1
    assert sensor.extra_state_attributes["icao"] == "near"
