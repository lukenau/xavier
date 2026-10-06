#!/usr/bin/env python3
"""Apple WeatherKit, in the shape the hub app's chat weather widget draws.

This is a self-contained example connector for self-hosters: it asks Apple's
WeatherKit REST API for the current conditions, the hourly strip and the
days-ahead forecast, then prints JSON whose fields line up one-to-one with the
props of the `weather` widget in `app/src/chat/widget.ts`. Anything the script
prints with exit code 0 can be handed straight to `hub_widget` as that
widget's props, and cron jobs or briefings can call it the same way.

    python3 weatherkit.py --lat 48.8566 --lon 2.3522 --place Paris --timezone Europe/Paris

Auth is a ten-minute ES256 (P-256 ECDSA) JWT signed with the .p8 key
downloaded from an Apple Developer account. The key is read from disk, used
to sign the token, and never printed or logged; the token itself is minted,
used for the one request, and dropped. Signing is implemented with the
standard library only — no third-party packages.

Everything identifying is environment-driven, so a key rotation is a file
swap plus a variable change, not a code edit:

    WEATHERKIT_KEY_ID       key id from the developer portal
    WEATHERKIT_TEAM_ID      App Store Connect team id
    WEATHERKIT_SERVICE_ID   the WeatherKit service identifier
    WEATHERKIT_KEY_PATH     directory holding AuthKey_<KEY_ID>.p8
                            (default: ./secrets/weatherkit)
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY_DIR = pathlib.Path(os.environ.get("WEATHERKIT_KEY_PATH", "./secrets/weatherkit"))
KEY_ID = os.environ.get("WEATHERKIT_KEY_ID", "")
TEAM_ID = os.environ.get("WEATHERKIT_TEAM_ID", "")
SERVICE_ID = os.environ.get("WEATHERKIT_SERVICE_ID", "")
BASE = "https://weatherkit.apple.com/api/v1/weather"
TIMEOUT = 20

# Apple's conditionCode vocabulary is long; the widget draws ten skies. Anything
# not named here falls through to the substring rules below, and then to cloudy.
CONDITIONS = {
    "Clear": "clear",
    "MostlyClear": "clear",
    "PartlyCloudy": "partly_cloudy",
    "MostlyCloudy": "cloudy",
    "Cloudy": "cloudy",
    "Haze": "fog",
    "Foggy": "fog",
    "Smoky": "fog",
    "Breezy": "wind",
    "Windy": "wind",
    "Drizzle": "rain",
    "Rain": "rain",
    "HeavyRain": "rain",
    "Showers": "rain",
    "Flurries": "snow",
    "Snow": "snow",
    "HeavySnow": "snow",
    "Sleet": "snow",
    "Hail": "storm",
    "Thunderstorms": "storm",
    "IsolatedThunderstorms": "storm",
    "SevereThunderstorm": "storm",
}


def condition_of(code: str) -> str:
    if code in CONDITIONS:
        return CONDITIONS[code]
    low = (code or "").lower()
    for needle, name in (
        ("thunder", "storm"), ("rain", "rain"), ("shower", "rain"), ("drizzle", "rain"),
        ("snow", "snow"), ("sleet", "snow"), ("hail", "storm"), ("wind", "wind"),
        ("fog", "fog"), ("haze", "fog"), ("clear", "clear"), ("cloud", "cloudy"),
    ):
        if needle in low:
            return name
    return "cloudy"


# --- pure-stdlib ES256 (P-256 ECDSA) signing --------------------------------
#
# Apple's WeatherKit tokens are ES256 JWTs: an ECDSA signature over the SHA-256
# digest of `header.payload`, encoded as the raw 64-byte r||s pair. The P-256
# domain parameters below are the ones from SEC 2 / NIST SP 800-186.

_P = 2**256 - 2**224 + 2**192 + 2**96 - 1
_A = _P - 3
# (b, Gx, Gy, n) constants for the NIST P-256 curve.
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551

# DER object identifiers, compared as raw content bytes.
_OID_EC_PUBLIC_KEY = bytes.fromhex("2a8648ce3d0201")      # 1.2.840.10045.2.1
_OID_PRIME256V1 = bytes.fromhex("2a8648ce3d030107")       # 1.2.840.10045.3.1.7


def _der_read(buf: bytes, off: int) -> tuple[int, bytes, int]:
    """One TLV from a DER buffer: returns (tag, content, offset past it)."""
    tag = buf[off]
    off += 1
    length = buf[off]
    off += 1
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(buf[off:off + n], "big")
        off += n
    return tag, buf[off:off + length], off + length


def _ec_private_scalar(pem_text: str) -> int:
    """Pull the 32-byte private scalar out of a PKCS#8 EC private key (.p8)."""
    der = base64.b64decode("".join(
        line for line in pem_text.splitlines() if "-----" not in line))
    tag, body, _ = _der_read(der, 0)          # SEQUENCE — the PKCS#8 wrapper
    if tag != 0x30:
        raise ValueError("not a PKCS#8 structure")
    tag, version, off = _der_read(body, 0)    # INTEGER version
    if tag != 0x02:
        raise ValueError("missing PKCS#8 version")
    tag, algid, off = _der_read(body, off)    # AlgorithmIdentifier
    if tag != 0x30:
        raise ValueError("missing AlgorithmIdentifier")
    oids = []
    pos = 0
    while pos < len(algid):
        _, content, pos = _der_read(algid, pos)
        if content in (_OID_EC_PUBLIC_KEY, _OID_PRIME256V1):
            oids.append(content)
    if _OID_EC_PUBLIC_KEY not in oids or _OID_PRIME256V1 not in oids:
        raise ValueError("key is not a P-256 (prime256v1) EC key")
    tag, ecpriv, _ = _der_read(body, off)     # OCTET STRING -> ECPrivateKey
    if tag != 0x04:
        raise ValueError("missing ECPrivateKey")
    tag, seq, _ = _der_read(ecpriv, 0)        # SEQUENCE
    if tag != 0x30:
        raise ValueError("malformed ECPrivateKey")
    _, _, pos = _der_read(seq, 0)             # INTEGER version (1)
    tag, priv, _ = _der_read(seq, pos)        # OCTET STRING — the scalar
    if tag != 0x04:
        raise ValueError("missing private scalar")
    return int.from_bytes(priv, "big")


def _point_add(p1: tuple[int, int] | None, p2: tuple[int, int] | None) -> tuple[int, int] | None:
    """Affine point addition on P-256; `None` is the point at infinity."""
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + _A) * pow(2 * y1, -1, _P) % _P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (lam * lam - x1 - x2) % _P
    return (x3, (lam * (x1 - x3) - y1) % _P)


def _scalar_mult(k: int, point: tuple[int, int]) -> tuple[int, int] | None:
    result = None
    addend = point
    while k:
        if k & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        k >>= 1
    return result


def _es256_sign(message: bytes, private_scalar: int) -> bytes:
    """ECDSA over SHA-256, returned as the raw 64-byte r||s a JWT expects."""
    z = int.from_bytes(hashlib.sha256(message).digest(), "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1
        x, _ = _scalar_mult(k, (_GX, _GY))
        r = x % _N
        if r == 0:
            continue
        s = (pow(k, -1, _N) * (z + r * private_scalar)) % _N
        if s == 0:
            continue
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def token() -> str:
    for name in ("WEATHERKIT_KEY_ID", "WEATHERKIT_TEAM_ID", "WEATHERKIT_SERVICE_ID"):
        if not os.environ.get(name):
            raise ValueError(f"{name} is not set")
    key_path = KEY_DIR / f"AuthKey_{KEY_ID}.p8"
    scalar = _ec_private_scalar(key_path.read_text())
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        "iss": TEAM_ID,
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(minutes=10)).timestamp()),
        "sub": SERVICE_ID,
    }
    header = {"alg": "ES256", "kid": KEY_ID, "id": f"{TEAM_ID}.{SERVICE_ID}"}
    signing_input = f"{_b64url(json.dumps(header).encode())}.{_b64url(json.dumps(payload).encode())}"
    return f"{signing_input}.{_b64url(_es256_sign(signing_input.encode(), scalar))}"


def fetch(lat: float, lon: float, timezone: str, lang: str = "en") -> dict:
    query = urllib.parse.urlencode({
        "dataSets": "currentWeather,forecastHourly,forecastDaily",
        "timezone": timezone,
    })
    url = f"{BASE}/{lang}/{lat:.4f}/{lon:.4f}?{query}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token()}"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def f(celsius) -> float | None:
    """Apple reports Celsius; the widget draws Fahrenheit."""
    if not isinstance(celsius, (int, float)):
        return None
    return round(celsius * 9 / 5 + 32, 1)


def clock(iso: str, timezone: str) -> str:
    """`2027-01-01T18:00:00Z` -> `2PM`, in the target timezone."""
    try:
        from zoneinfo import ZoneInfo

        when = dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo(timezone))
    except Exception:
        return ""
    hour = when.strftime("%I").lstrip("0") or "12"
    return f"{hour}{when.strftime('%p')}"


def weekday(iso: str, timezone: str, today: dt.date) -> str:
    try:
        from zoneinfo import ZoneInfo

        when = dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo(timezone))
    except Exception:
        return ""
    return "Today" if when.date() == today else when.strftime("%a")


def hours_of_day(hourly: list, day_start: str, timezone: str) -> list:
    """Each hour's chance of rain, for one calendar day in the target timezone."""
    try:
        from zoneinfo import ZoneInfo

        zone = ZoneInfo(timezone)
        target = dt.datetime.fromisoformat(day_start.replace("Z", "+00:00")).astimezone(zone).date()
    except Exception:
        return []
    out = []
    for h in hourly:
        try:
            when = dt.datetime.fromisoformat(h.get("forecastStart", "").replace("Z", "+00:00")).astimezone(zone)
        except Exception:
            continue
        if when.date() == target:
            out.append(round((h.get("precipitationChance") or 0) * 100))
    return out


def widget_props(raw: dict, place: str | None, timezone: str, hours: int, days: int) -> dict:
    now = raw.get("currentWeather") or {}
    hourly = (raw.get("forecastHourly") or {}).get("hours") or []
    daily = (raw.get("forecastDaily") or {}).get("days") or []

    try:
        from zoneinfo import ZoneInfo

        today = dt.datetime.now(ZoneInfo(timezone)).date()
    except Exception:
        today = dt.datetime.now(dt.timezone.utc).date()

    upcoming = [h for h in hourly if h.get("forecastStart", "") >= now.get("asOf", "")][:hours] or hourly[:hours]
    return {
        "place": place,
        "temp": f(now.get("temperature")),
        "feels_like": f(now.get("temperatureApparent")),
        "hours": [
            {
                "label": "Now" if i == 0 else clock(h.get("forecastStart", ""), timezone),
                "temp": f(h.get("temperature")),
                "condition": condition_of(h.get("conditionCode", "")),
                "night": not h.get("daylight", True),
                "precip": round((h.get("precipitationChance") or 0) * 100),
                # The rest of the measures, for the single-metric and composite
                # hourly views. Apple reports km/h and 0-1 fractions.
                "feels_like": f(h.get("temperatureApparent")),
                "wind": round((h.get("windSpeed") or 0) * 0.621371, 1),
                "humidity": round((h.get("humidity") or 0) * 100),
                "uv": h.get("uvIndex"),
                "cloud": round((h.get("cloudCover") or 0) * 100),
            }
            for i, h in enumerate(upcoming)
        ],
        "days": [
            {
                "label": weekday(d.get("forecastStart", ""), timezone, today),
                "low": f(d.get("temperatureMin")),
                "high": f(d.get("temperatureMax")),
                "condition": condition_of(d.get("conditionCode", "")),
                "precip": round((d.get("precipitationChance") or 0) * 100),
                # Apple reports millimetres; the widget writes inches.
                "precip_in": round((d.get("precipitationAmount") or 0) / 25.4, 2),
                # The hours of this day, for the precipitation view's sparkline.
                # Empty for days beyond the hourly forecast, which draws as the
                # day's own chance rather than as nothing.
                "precip_hours": hours_of_day(hourly, d.get("forecastStart", ""), timezone),
            }
            for d in daily[:days]
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Apple WeatherKit, shaped for the hub app's weather widget")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--place", default=None, help="what to call it on the card")
    ap.add_argument("--timezone", default=os.environ.get("TZ", "UTC"))
    ap.add_argument("--hours", type=int, default=8,
                    help="how many hours the strip and the hourly views cover (24 for a full day)")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--raw", action="store_true", help="Apple's own payload instead of widget props")
    args = ap.parse_args()

    try:
        raw = fetch(args.lat, args.lon, args.timezone)
    except urllib.error.HTTPError as exc:
        # 401 means the identifiers are wrong, not the key: the JWT is signed
        # either way. Say which three to check rather than echoing Apple's body.
        detail = "check WEATHERKIT_TEAM_ID / WEATHERKIT_SERVICE_ID / WEATHERKIT_KEY_ID" if exc.code in (401, 403) else ""
        print(json.dumps({"error": f"weatherkit returned {exc.code}", "detail": detail}))
        return 1
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        print(json.dumps({"error": "weatherkit unreachable", "detail": str(exc)[:120]}))
        return 1
    except ValueError as exc:
        print(json.dumps({"error": "cannot sign token", "detail": str(exc)}))
        return 1

    if args.raw:
        print(json.dumps(raw, indent=1))
        return 0
    print(json.dumps(widget_props(raw, args.place, args.timezone, args.hours, args.days), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
