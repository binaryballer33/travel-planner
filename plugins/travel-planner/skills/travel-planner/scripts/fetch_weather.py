#!/usr/bin/env python3
"""Embed the weather for the trip dates into a trip JSON (Open-Meteo, no API key).

  python3 fetch_weather.py trip.json                       # destination from trip.destination
  python3 fetch_weather.py trip.json --timeanddate thailand/phuket   # fix the verify-link slug

Writes data["weather"]:
  normals   one entry per calendar month the trip touches: the average daily high and low (°F), days with
            at least 0.1 in of rain, and total rain, from the last 10 full years of Open-Meteo's ERA5
            archive. Reanalysis runs a few °F cool on coasts and islands: compare it with the climate page
            in `links` (or the national weather service) and, if they differ, overwrite high_f / low_f /
            rain_days with the page's numbers and set "source" and "source_url" on that month.
            The dashboard turns it into "Normally during November in Phuket, the weather is 76–88 °F".
  forecast  the real daily forecast for every trip day that falls inside Open-Meteo's 16-day range
            (empty when the trip is further out). Rerun close to departure to fill more days.
  climate_months  all 12 months (avg high/low °F, rain inches, rainy days) for the rainy-season chart.
  rainy_season    first guess {months, label, peak}: the longest run of wetter-than-average months.
                  Confirm it with the official source and overwrite it, citing that page.
  links     pages the user can open to check: timeanddate's 14-day forecast and climate pages, and
            the Open-Meteo request itself.

Why: the user wants the projected weather even when the trip is too far out for a forecast, and the
actual forecast as soon as one exists, each with a link they can verify.
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta

WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog",
       51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
       61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
       71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers",
       82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorms", 96: "Thunderstorms, hail",
       99: "Thunderstorms, hail"}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
UA = {"User-Agent": "travel-planner-skill/1.0 (personal trip dashboard)"}


def get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lng", type=float)
    ap.add_argument("--timeanddate", help="country/city slug for timeanddate.com links, e.g. thailand/phuket")
    ap.add_argument("--years", type=int, default=10, help="years of history for the normals (default 10)")
    a = ap.parse_args()

    with open(a.trip_json, encoding="utf-8") as f:
        data = json.load(f)
    t = data["trip"]
    d = t["destination"]
    lat, lng = a.lat if a.lat is not None else d["lat"], a.lng if a.lng is not None else d["lng"]
    start, end = date.fromisoformat(t["start_date"]), date.fromisoformat(t["end_date"])
    days = [start + timedelta(n) for n in range((end - start).days + 1)]
    city = d.get("city", "")
    today = date.today()

    # normals: last N full years, every month the trip touches
    months = sorted({(x.month) for x in days}, key=lambda m: [x.month for x in days].index(m))
    y1 = today.year - 1
    y0 = y1 - a.years + 1
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lng, "start_date": f"{y0}-01-01", "end_date": f"{y1}-12-31",
                                "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
                                "temperature_unit": "fahrenheit", "precipitation_unit": "inch", "timezone": "auto"})
    hist_url = "https://archive-api.open-meteo.com/v1/archive?" + q
    normals, climate = [], []
    try:
        h = get(hist_url, timeout=120)["daily"]
        for m in range(1, 13):  # every month, for the rainy-season chart
            idx = [i for i, s in enumerate(h["time"]) if int(s[5:7]) == m]
            hi = [h["temperature_2m_max"][i] for i in idx if h["temperature_2m_max"][i] is not None]
            lo = [h["temperature_2m_min"][i] for i in idx if h["temperature_2m_min"][i] is not None]
            pr = [h["precipitation_sum"][i] for i in idx if h["precipitation_sum"][i] is not None]
            years = len({h["time"][i][:4] for i in idx}) or 1
            climate.append({"month": MONTHS[m - 1][:3], "high_f": round(sum(hi) / len(hi)), "low_f": round(sum(lo) / len(lo)),
                            "precip_in": round(sum(pr) / years, 1), "rain_days": round(sum(1 for p in pr if p >= 0.1) / years),
                            "days_in_month": round(len(idx) / years)})
        for m in months:
            idx = [i for i, s in enumerate(h["time"]) if int(s[5:7]) == m]
            hi = [h["temperature_2m_max"][i] for i in idx if h["temperature_2m_max"][i] is not None]
            lo = [h["temperature_2m_min"][i] for i in idx if h["temperature_2m_min"][i] is not None]
            pr = [h["precipitation_sum"][i] for i in idx if h["precipitation_sum"][i] is not None]
            years = len({h["time"][i][:4] for i in idx}) or 1
            normals.append({"month": MONTHS[m - 1], "high_f": round(sum(hi) / len(hi)), "low_f": round(sum(lo) / len(lo)),
                            "rain_days": round(sum(1 for p in pr if p >= 0.1) / years),
                            "days_in_month": round(len(idx) / years),
                            "precip_in": round(sum(pr) / years, 1), "period": f"{y0}–{y1}",
                            "source": "Open-Meteo ERA5 history", "source_url": hist_url})
    except Exception as e:  # keep going: the forecast and links are still useful
        print(f"WARNING: normals failed ({e})", file=sys.stderr)

    # forecast: only trip days inside the 16-day window
    forecast = []
    fq = urllib.parse.urlencode({"latitude": lat, "longitude": lng,
                                 "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max",
                                 "temperature_unit": "fahrenheit", "precipitation_unit": "inch", "timezone": "auto",
                                 "forecast_days": 16})
    fc_url = "https://api.open-meteo.com/v1/forecast?" + fq
    if start <= today + timedelta(15) and end >= today:
        try:
            fd = get(fc_url)["daily"]
            want = {x.isoformat() for x in days}
            for i, s in enumerate(fd["time"]):
                if s in want:
                    code = fd["weather_code"][i]
                    forecast.append({"date": s, "code": code, "high_f": round(fd["temperature_2m_max"][i]), "low_f": round(fd["temperature_2m_min"][i]),
                                     "precip_in": fd["precipitation_sum"][i], "rain_chance": fd["precipitation_probability_max"][i],
                                     "summary": WMO.get(code, f"code {code}")})
        except Exception as e:
            print(f"WARNING: forecast failed ({e})", file=sys.stderr)

    # rainy season, first guess: the longest run of months wetter than the monthly average (wrapping
    # around the new year). Confirm it with the national weather service or tourism board and overwrite
    # "label", "months", "peak", "source" and "source_url" with what they say.
    rainy = None
    if climate:
        avg = sum(c["precip_in"] for c in climate) / 12
        wet = [c["precip_in"] > avg for c in climate]
        best, cur, start_best = [], [], 0
        for k in range(24):
            if wet[k % 12]:
                cur.append(k % 12 + 1)
                if len(cur) > len(best) and len(cur) <= 12: best = cur[:]
            else:
                cur = []
        spread = max(c["precip_in"] for c in climate) / max(0.01, min(c["precip_in"] for c in climate))
        if best and spread >= 2 and len(best) < 12:
            top = sorted(sorted(best, key=lambda m: -climate[m - 1]["precip_in"])[:2], key=best.index)  # season order (Dec before Jan)
            rainy = {"months": best, "label": f"{MONTHS[best[0] - 1]} – {MONTHS[best[-1] - 1]}",
                     "peak": " – ".join(MONTHS[m - 1] for m in top) if len(top) == 2 else MONTHS[top[0] - 1],
                     "source": "Open-Meteo ERA5 history (computed; confirm with the national weather service)", "source_url": hist_url}

    tad = a.timeanddate or f"{slug(d.get('country'))}/{slug(city)}"
    links = [{"label": "14-day forecast (timeanddate)", "url": f"https://www.timeanddate.com/weather/{tad}/ext"},
             {"label": "Climate by month (timeanddate)", "url": f"https://www.timeanddate.com/weather/{tad}/climate"},
             {"label": "Forecast data (Open-Meteo)", "url": fc_url},
             {"label": "History used for normals (Open-Meteo)", "url": hist_url}]
    data["weather"] = {"location": city, "lat": lat, "lng": lng, "checked_at": today.isoformat(),
                       "normals": normals, "forecast": forecast, "climate_months": climate,
                       "climate_source": f"Open-Meteo ERA5 {y0}–{y1}", "climate_source_url": hist_url, "rainy_season": rainy,
                       "forecast_days_total": len(days), "source": "Open-Meteo (forecast and ERA5 history)", "links": links}
    with open(a.trip_json, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    n = ", ".join(f"{x['month']} {x['low_f']}–{x['high_f']} °F, rain ~{x['rain_days']} days" for x in normals) or "none"
    print(f"Wrote weather to {a.trip_json}: normals {n}; forecast for {len(forecast)} of {len(days)} trip days; "
          f"rainy season guess: {rainy['label'] if rainy else 'none distinct'}.")
    if not forecast:
        print("No trip day is inside the 16-day forecast yet; rerun nearer departure to add it.")


if __name__ == "__main__":
    main()
