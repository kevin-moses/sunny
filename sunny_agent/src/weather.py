# weather.py
# Purpose: Current conditions and today's hourly forecast for the household's weather location,
# from Open-Meteo (geocoding plus forecast; no API key), phrased as plain text for the voice
# agent's get_weather tool. The location is the free-text households.weatherLocation a caregiver
# sets, e.g. "Brooklyn, NY": the part before the first comma is searched by name and the next
# part (a US state abbreviation or name, a region, a country or a country code) picks among the
# matches; with no such part the first match is used, and a part that matches nothing finds no
# place rather than a namesake elsewhere. A US location gets Fahrenheit and mph, anywhere else Celsius and km/h. The hourly
# lines run from the current local hour to the end of the household's day, so a question like
# "Do I need an umbrella for my walk at 2?" can be answered from the hour of the walk.
#
# No LiveKit imports; Assistant.get_weather in agent.py calls lookup_place and weather_report.
# Every network call has a short timeout; failures raise WeatherError, which the tool turns
# into a plain spoken sentence.
#
# Last modified: 2026-11-09

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = httpx.Timeout(6.0, connect=3.0)
_GEOCODE_CANDIDATES = 10

# WMO weather interpretation codes used by Open-Meteo, in plain words.
_WEATHER_CODES: dict[int, str] = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "freezing fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    56: "light freezing drizzle",
    57: "freezing drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "light freezing rain",
    67: "freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light rain showers",
    81: "rain showers",
    82: "heavy rain showers",
    85: "light snow showers",
    86: "heavy snow showers",
    95: "thunderstorms",
    96: "thunderstorms with hail",
    99: "thunderstorms with heavy hail",
}

_US_STATES: dict[str, str] = {
    "al": "alabama",
    "ak": "alaska",
    "az": "arizona",
    "ar": "arkansas",
    "ca": "california",
    "co": "colorado",
    "ct": "connecticut",
    "de": "delaware",
    "dc": "district of columbia",
    "fl": "florida",
    "ga": "georgia",
    "hi": "hawaii",
    "id": "idaho",
    "il": "illinois",
    "in": "indiana",
    "ia": "iowa",
    "ks": "kansas",
    "ky": "kentucky",
    "la": "louisiana",
    "me": "maine",
    "md": "maryland",
    "ma": "massachusetts",
    "mi": "michigan",
    "mn": "minnesota",
    "ms": "mississippi",
    "mo": "missouri",
    "mt": "montana",
    "ne": "nebraska",
    "nv": "nevada",
    "nh": "new hampshire",
    "nj": "new jersey",
    "nm": "new mexico",
    "ny": "new york",
    "nc": "north carolina",
    "nd": "north dakota",
    "oh": "ohio",
    "ok": "oklahoma",
    "or": "oregon",
    "pa": "pennsylvania",
    "ri": "rhode island",
    "sc": "south carolina",
    "sd": "south dakota",
    "tn": "tennessee",
    "tx": "texas",
    "ut": "utah",
    "vt": "vermont",
    "va": "virginia",
    "wa": "washington",
    "wv": "west virginia",
    "wi": "wisconsin",
    "wy": "wyoming",
}


class WeatherError(Exception):
    """
    purpose: Raised when Open-Meteo cannot be reached or answers with something unusable.
    """


@dataclass(frozen=True)
class Place:
    """
    purpose: A geocoded place the forecast is fetched for.
    """

    name: str
    latitude: float
    longitude: float
    country_code: str


def _matches_qualifier(result: dict[str, Any], qualifier: str) -> bool:
    """
    purpose: Whether a geocoding result fits the words after the comma ("NY", "New York",
             "UK", "Ontario").
    @param result: (dict) One Open-Meteo geocoding result.
    @param qualifier: (str) Lower-cased qualifier; "" matches everything.
    @return: (bool) True when the qualifier names the result's region, country or code.
    """
    if not qualifier:
        return True
    names = {
        str(result.get(key, "")).lower()
        for key in ("admin1", "admin2", "country", "country_code")
    }
    return qualifier in names or _US_STATES.get(qualifier, "") in names - {""}


async def lookup_place(
    location: str, transport: httpx.AsyncBaseTransport | None = None
) -> Place | None:
    """
    purpose: Geocode a free-text location such as "Brooklyn, NY".
    @param location: (str) The household's weather location.
    @param transport: (httpx.AsyncBaseTransport | None) Override for tests.
    @return: (Place | None) The best match, or None when nothing matches.
    @raises: WeatherError when the geocoding service fails.
    """
    name, _, rest = location.partition(",")
    # Only the first qualifier is used: "Brooklyn, NY, USA" is matched on "NY".
    qualifier = " ".join(rest.split(",")[0].split()).lower()
    if not name.strip():
        return None
    params: dict[str, str | int] = {
        "name": name.strip(),
        "count": _GEOCODE_CANDIDATES,
        "language": "en",
        "format": "json",
    }
    data = await _get_json(GEOCODE_URL, params, transport)
    for result in data.get("results") or []:
        if _matches_qualifier(result, qualifier):
            return Place(
                name=str(result.get("name", name.strip())),
                latitude=float(result["latitude"]),
                longitude=float(result["longitude"]),
                country_code=str(result.get("country_code", "")).upper(),
            )
    return None


async def weather_report(
    place: Place,
    tz: str,
    now: datetime | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """
    purpose: Current conditions and the rest of today by hour, as text for the agent.
    @param place: (Place) Where.
    @param tz: (str) The household's IANA timezone (the forecast's hours are local to it).
    @param now: (datetime | None) Current time; defaults to the clock in tz.
    @param transport: (httpx.AsyncBaseTransport | None) Override for tests.
    @return: (str) e.g. "Weather for Brooklyn now: 54 degrees Fahrenheit, light rain, ...".
    @raises: WeatherError when the forecast service fails.
    """
    us = place.country_code == "US"
    params: dict[str, str | int | float] = {
        "latitude": place.latitude,
        "longitude": place.longitude,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "temperature_unit": "fahrenheit" if us else "celsius",
        "wind_speed_unit": "mph" if us else "kmh",
        "timezone": tz,
        "forecast_days": 1,
    }
    data = await _get_json(FORECAST_URL, params, transport)
    local_now = now or datetime.now(ZoneInfo(tz))
    try:
        return describe_forecast(place.name, data, local_now, us)
    except (KeyError, TypeError, ValueError) as e:
        raise WeatherError(f"Unexpected forecast response: {e}") from e


def describe_forecast(name: str, data: dict[str, Any], now: datetime, us: bool) -> str:
    """
    purpose: Phrase an Open-Meteo forecast response for the agent.
    @param name: (str) Place name.
    @param data: (dict) Forecast JSON with "current" and "hourly".
    @param now: (datetime) Local now; hours before its hour are left out.
    @param us: (bool) Fahrenheit and mph when True, Celsius and km/h otherwise.
    @return: (str) Current conditions, then one entry per remaining hour of today.
    @raises: KeyError, TypeError or ValueError on a malformed response.
    """
    unit = "Fahrenheit" if us else "Celsius"
    wind_unit = "miles per hour" if us else "kilometers per hour"
    current = data["current"]
    lines = [
        f"Weather for {name} now: {round(current['temperature_2m'])} degrees {unit}, "
        f"{_condition(current.get('weather_code'))}, feels like "
        f"{round(current['apparent_temperature'])}, wind "
        f"{round(current['wind_speed_10m'])} {wind_unit}."
    ]
    hourly = data["hourly"]
    hours = []
    for i, stamp in enumerate(hourly["time"]):
        moment = datetime.fromisoformat(stamp)
        if moment.date() != now.date() or moment.hour < now.hour:
            continue
        rain = hourly["precipitation_probability"][i]
        rain_text = f", {rain}% chance of rain" if rain is not None else ""
        hours.append(
            f"{_hour_for_voice(moment.hour)} {round(hourly['temperature_2m'][i])} degrees, "
            f"{_condition(hourly['weather_code'][i])}{rain_text}"
        )
    if hours:
        lines.append("Rest of today by hour: " + "; ".join(hours) + ".")
    return " ".join(lines)


def _condition(code: Any) -> str:
    """
    purpose: Plain words for a WMO weather code.
    @param code: (Any) The code, possibly missing.
    @return: (str) e.g. "light rain"; "unknown conditions" for an unknown code.
    """
    try:
        return _WEATHER_CODES.get(int(code), "unknown conditions")
    except (TypeError, ValueError):
        return "unknown conditions"


def _hour_for_voice(hour: int) -> str:
    """
    purpose: A whole hour as people say it.
    @param hour: (int) 0..23.
    @return: (str) e.g. "midnight", "9 AM", "noon", "3 PM".
    """
    if hour == 0:
        return "midnight"
    if hour == 12:
        return "noon"
    return f"{hour % 12} {'AM' if hour < 12 else 'PM'}"


async def _get_json(
    url: str, params: dict[str, Any], transport: httpx.AsyncBaseTransport | None
) -> dict[str, Any]:
    """
    purpose: GET a JSON object from Open-Meteo.
    @param url: (str) Endpoint.
    @param params: (dict) Query parameters.
    @param transport: (httpx.AsyncBaseTransport | None) Override for tests.
    @return: (dict) The decoded body.
    @raises: WeatherError on a transport error, a non-2xx status or a body that is not an object.
    """
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, transport=transport) as http:
            response = await http.get(url, params=params)
            response.raise_for_status()
            body = response.json()
    except (httpx.HTTPError, ValueError) as e:
        raise WeatherError(f"Open-Meteo request failed: {e}") from e
    if not isinstance(body, dict):
        raise WeatherError("Open-Meteo returned an unexpected body")
    return body
