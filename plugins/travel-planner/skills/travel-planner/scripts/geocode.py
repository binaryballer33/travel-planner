#!/usr/bin/env python3
"""Geocode addresses or place names with OpenStreetMap's Nominatim (no API key).

  python3 geocode.py "Memmo Alfama Hotel, Lisbon" "Hospital da Luz, Lisbon"
  python3 geocode.py --json "Chiado, Lisbon, Portugal"

Respects the Nominatim usage policy: identifies itself and waits a second between requests.
Prints: lat, lng, and the matched display name. Exit code 1 if any query found nothing.
"""
import json
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "travel-planner-skill/1.0 (Claude Code skill; personal trip planning)"


def geocode(query: str):
    url = ENDPOINT + "?" + urllib.parse.urlencode({"q": query, "format": "jsonv2", "limit": 1, "addressdetails": 0})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8"))
    if not data:
        return None
    hit = data[0]
    return {"query": query, "lat": round(float(hit["lat"]), 6), "lng": round(float(hit["lon"]), 6),
            "display_name": hit.get("display_name", ""), "type": hit.get("type", "")}


def main(argv):
    as_json = "--json" in argv
    queries = [a for a in argv if a != "--json"]
    if not queries:
        print(__doc__)
        return 2
    results, failed = [], 0
    for i, q in enumerate(queries):
        if i:
            time.sleep(1.1)
        try:
            hit = geocode(q)
        except Exception as e:  # network or HTTP error: report and continue
            hit = None
            print(f"ERROR {q!r}: {e}", file=sys.stderr)
        if hit is None:
            failed += 1
            results.append({"query": q, "lat": None, "lng": None, "display_name": ""})
            if not as_json:
                print(f"{q}\n  not found — try a simpler query (neighbourhood + city) or read coordinates off the listing page")
            continue
        results.append(hit)
        if not as_json:
            print(f"{q}\n  lat: {hit['lat']}  lng: {hit['lng']}\n  matched: {hit['display_name']}")
    if as_json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
