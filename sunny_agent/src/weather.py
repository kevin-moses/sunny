from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from tools import format_time_for_voice

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_TIMEOUT = httpx.Timeout(6.0, connect=3.0)
_GEOCODE_CANDIDATES = 10

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
    pass


@dataclass(frozen=True)
class Place:
    name: str
    latitude: float
    longitude: float
    country_code: str


def _matches_qualifier(result: dict[str, Any], qualifier: str) -> bool:
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
    name, _, rest = location.partition(",")
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
    try:
        for result in data.get("results") or []:
            if _matches_qualifier(result, qualifier):
                return Place(
                    name=str(result.get("name", name.strip())),
                    latitude=float(result["latitude"]),
                    longitude=float(result["longitude"]),
                    country_code=str(result.get("country_code", "")).upper(),
                )
    except (AttributeError, KeyError, TypeError, ValueError) as e:
        raise WeatherError(f"Unexpected geocoding response: {e}") from e
    return None


async def weather_report(
    place: Place,
    tz: str,
    now: datetime | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
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
            f"{format_time_for_voice(f'{moment.hour:02d}:00')} {round(hourly['temperature_2m'][i])} degrees, "
            f"{_condition(hourly['weather_code'][i])}{rain_text}"
        )
    if hours:
        lines.append("Rest of today by hour: " + "; ".join(hours) + ".")
    return " ".join(lines)


def _condition(code: Any) -> str:
    try:
        return _WEATHER_CODES.get(int(code), "unknown conditions")
    except (TypeError, ValueError):
        return "unknown conditions"


async def _get_json(
    url: str, params: dict[str, Any], transport: httpx.AsyncBaseTransport | None
) -> dict[str, Any]:
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
