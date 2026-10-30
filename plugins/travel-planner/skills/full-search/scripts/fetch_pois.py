#!/usr/bin/env python3
"""Embed the places within 5 miles of every stay into a trip JSON (OpenStreetMap via Overpass).

  python3 fetch_pois.py trip.json                 # enrich in place, skips stays already fetched
  python3 fetch_pois.py trip.json --force         # refetch everything
  python3 fetch_pois.py trip.json --stay-id stay-mid-apartment-chiado
  python3 fetch_pois.py trip.json --radius-miles 5 --per-category 40 -o enriched.json

Why: the dashboard can query Overpass live, but the public servers are often at capacity and
browsers give up after ~30 s. Fetching here, with retries across mirrors and exponential backoff,
makes the map instant and independent of server mood. Results land in data["nearby"][stay_id].
"""
import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "travel-planner-skill/1.0 (Claude Code skill; personal trip planning)"

# Exact-match selectors only: regex filters make Overpass scan every tag value in the area.
SELECTORS = {
    "hospital": ['node["amenity"="hospital"]', 'way["amenity"="hospital"]', 'relation["amenity"="hospital"]',
                 'node["healthcare"="hospital"]', 'way["healthcare"="hospital"]'],
    "pharmacy": ['node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'],
    "grocery": ['node["shop"="supermarket"]', 'way["shop"="supermarket"]', 'node["shop"="grocery"]', 'node["shop"="greengrocer"]'],
    "nightlife": ['node["amenity"="bar"]', 'way["amenity"="bar"]', 'node["amenity"="pub"]', 'way["amenity"="pub"]',
                  'node["amenity"="nightclub"]', 'way["amenity"="nightclub"]'],
    "nature": ['node["leisure"="park"]', 'way["leisure"="park"]', 'relation["leisure"="park"]',
               'node["leisure"="nature_reserve"]', 'way["leisure"="nature_reserve"]', 'relation["leisure"="nature_reserve"]',
               'node["natural"="beach"]', 'way["natural"="beach"]', 'node["tourism"="viewpoint"]', 'node["natural"="peak"]'],
    "hotel": ['node["tourism"="hotel"]', 'way["tourism"="hotel"]', 'node["tourism"="hostel"]', 'way["tourism"="hostel"]',
              'node["tourism"="guest_house"]', 'way["tourism"="guest_house"]'],
    "car_rental": ['node["amenity"="car_rental"]', 'way["amenity"="car_rental"]', 'node["shop"="car_rental"]'],
    "transit": ['node["railway"="station"]', 'node["station"="subway"]', 'node["public_transport"="station"]',
                'node["amenity"="ferry_terminal"]'],
}
NAMED_ONLY = {"grocery", "nightlife", "nature", "hotel", "transit"}
GROUPS = [["hospital", "pharmacy", "car_rental", "transit"], ["grocery", "nature"], ["nightlife", "hotel"]]
KEEP_TAGS = ("name", "name:en", "brand", "operator", "operator:type", "addr:street", "addr:housenumber",
             "opening_hours", "website", "contact:website", "phone", "contact:phone", "emergency", "healthcare",
             "amenity", "shop", "tourism", "leisure", "natural", "railway", "station", "public_transport", "stars")


def classify(t):
    if t.get("amenity") == "hospital" or t.get("healthcare") == "hospital":
        return "hospital"
    if t.get("amenity") == "pharmacy":
        return "pharmacy"
    if t.get("shop") in ("supermarket", "grocery", "greengrocer"):
        return "grocery"
    if t.get("amenity") in ("bar", "pub", "nightclub"):
        return "nightlife"
    if t.get("leisure") in ("park", "nature_reserve") or t.get("natural") in ("beach", "peak") or t.get("tourism") == "viewpoint":
        return "nature"
    if t.get("tourism") in ("hotel", "hostel", "guest_house"):
        return "hotel"
    if t.get("amenity") == "car_rental" or t.get("shop") == "car_rental":
        return "car_rental"
    if t.get("railway") == "station" or t.get("station") == "subway" or t.get("public_transport") == "station" or t.get("amenity") == "ferry_terminal":
        return "transit"
    return None


def miles(lat1, lng1, lat2, lng2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlng = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def overpass(query, rounds=4, log=print):
    """POST the query to each mirror in turn; back off between rounds. Returns parsed JSON."""
    last = None
    for rnd in range(rounds):
        for ep in ENDPOINTS:
            host = urllib.parse.urlsplit(ep).netloc
            req = urllib.request.Request(ep, data=("data=" + urllib.parse.quote(query)).encode(),
                                         headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
            t0 = time.time()
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = r.read()
                data = json.loads(body.decode("utf-8"))
                log(f"    {host}: {len(data.get('elements', []))} elements in {time.time() - t0:.0f}s")
                return data
            except urllib.error.HTTPError as e:
                last = f"{host}: HTTP {e.code}"
            except Exception as e:  # timeouts, connection errors, bad JSON
                last = f"{host}: {e.__class__.__name__}"
            log(f"    {last} after {time.time() - t0:.0f}s")
        wait = 5 * (2 ** rnd)
        log(f"  all mirrors failed (round {rnd + 1}/{rounds}); waiting {wait}s")
        time.sleep(wait)
    raise RuntimeError(f"Overpass unavailable ({last})")


def fetch_stay(lat, lng, radius_m, per_cat, log=print):
    out = {c: [] for c in SELECTORS}
    seen = set()
    for group in GROUPS:
        sel = "".join(f"{s}(around:{radius_m},{lat},{lng});" for c in group for s in SELECTORS[c])
        q = f"[out:json][timeout:90];({sel});out center qt;"
        log(f"  fetching {', '.join(group)} …")
        data = overpass(q, log=log)
        for e in data.get("elements", []):
            la = e.get("lat", (e.get("center") or {}).get("lat"))
            lo = e.get("lon", (e.get("center") or {}).get("lon"))
            if la is None or lo is None:
                continue
            tags = e.get("tags") or {}
            cat = classify(tags)
            if cat not in group:
                continue
            name = tags.get("name") or tags.get("name:en") or tags.get("brand") or tags.get("operator") or ""
            if cat in NAMED_ONLY and not name:
                continue
            dist = miles(lat, lng, la, lo)
            if dist > radius_m / 1609.344 + 0.05:
                continue
            key = (cat, (name or f"{e['type'][0]}{e['id']}").lower(), round(la, 3), round(lo, 3))
            if key in seen:
                continue
            seen.add(key)
            out[cat].append({
                "id": f"{e['type'][0]}{e['id']}", "name": name, "lat": round(la, 6), "lng": round(lo, 6),
                "dist": round(dist, 2), "tags": {k: v for k, v in tags.items() if k in KEEP_TAGS},
            })
        time.sleep(1.5)  # be polite between groups
    for c in out:
        out[c].sort(key=lambda p: p["dist"])
        del out[c][per_cat:]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("-o", "--out", help="write here instead of updating trip_json in place")
    ap.add_argument("--radius-miles", type=float, default=5.0)
    ap.add_argument("--per-category", type=int, default=40, help="nearest N kept per category per stay")
    ap.add_argument("--stay-id", action="append", help="only these lodging item ids (repeatable)")
    ap.add_argument("--force", action="store_true", help="refetch stays that already have data")
    a = ap.parse_args(argv)

    with open(a.trip_json, encoding="utf-8") as f:
        data = json.load(f)
    nearby = data.setdefault("nearby", {})
    stays = [it for it in data.get("items", []) if it.get("category") == "lodging" and it.get("lat") is not None and it.get("lng") is not None]
    if a.stay_id:
        stays = [it for it in stays if it["id"] in set(a.stay_id)]
    if not stays:
        print("No lodging items with lat/lng; nothing to fetch.")
        return 1
    radius_m = int(round(a.radius_miles * 1609.344))
    by_coord = {}
    done = 0
    for it in stays:
        if it["id"] in nearby and not a.force:
            print(f"- {it['id']}: already fetched {nearby[it['id']].get('fetched_at')}, skipping (use --force to refetch)")
            continue
        ck = (round(float(it["lat"]), 4), round(float(it["lng"]), 4))
        if ck in by_coord:
            nearby[it["id"]] = dict(nearby[by_coord[ck]])
            print(f"- {it['id']}: same location as {by_coord[ck]}, reused")
            continue
        print(f"- {it['id']} ({it['lat']}, {it['lng']})")
        try:
            cats = fetch_stay(float(it["lat"]), float(it["lng"]), radius_m, a.per_category)
        except RuntimeError as e:
            print(f"  FAILED: {e}. The dashboard will fall back to live lookup for this stay.")
            continue
        nearby[it["id"]] = {"fetched_at": date.today().isoformat(), "radius_miles": a.radius_miles,
                            "lat": it["lat"], "lng": it["lng"], "source": "OpenStreetMap via Overpass API", "cats": cats}
        by_coord[ck] = it["id"]
        done += 1
        print("  " + " · ".join(f"{len(v)} {k}" for k, v in cats.items()))
        out_path = a.out or a.trip_json
        with open(out_path, "w", encoding="utf-8") as f:  # save after every stay so a crash loses nothing
            json.dump(data, f, indent=2, ensure_ascii=False)
    out_path = a.out or a.trip_json
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {out_path}: nearby data for {len([s for s in stays if s['id'] in nearby])} of {len(stays)} stays ({done} fetched now).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
