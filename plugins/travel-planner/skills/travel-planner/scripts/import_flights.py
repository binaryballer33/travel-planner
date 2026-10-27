#!/usr/bin/env python3
"""Merge flight-helper JSON (references/flight-helper-brief.md) into a trip JSON as flight-card lines.

  python3 import_flights.py trip.json flights_google.json flights_kayak.json ...  [--dry-run]

Each helper file: {"site", "flights": [{provider, tier, cabin, price, url, airline, flight_numbers, depart, arrive,
stops, legs, layovers, total_min, aircraft, legroom_in, legroom_label, bags, ...}], "gaps": {...}, "blocked": ...}.
Writes one `flights` item per flight with an `flight` object (the dashboard draws it as a flight card),
replaces earlier lines from the same provider, records gaps in trip.notes and coverage, and prints the
count per site x tier x part of day so short cells are obvious.
"""
import argparse
import json
import re
import sys
from datetime import date, datetime

TIERS = ["budget", "mid", "upper", "luxury"]


def part(f):
    t = f.get("depart") or ((f.get("legs") or [{}])[0].get("depart")) or ""
    try:
        h = int(t[11:13])
    except ValueError:
        return "?"
    return "morning" if 5 <= h < 12 else "afternoon" if 12 <= h < 18 else "night"


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("trip_json")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    data = json.load(open(a.trip_json, encoding="utf-8"))
    today = date.today().isoformat()
    new, seen_prov, gaps, blocked = [], set(), {}, {}
    for fn in a.files:
        h = json.load(open(fn, encoding="utf-8"))
        site = h.get("site")
        if h.get("blocked"):
            blocked[site] = h["blocked"]
        for k, v in (h.get("gaps") or {}).items():
            gaps.setdefault(site, {})[k] = v
        for f in h.get("flights", []):
            prov = f.get("provider") or site
            seen_prov.add(prov)
            legs = f.get("legs") or []
            fl = {k: f.get(k) for k in ("airline", "flight_numbers", "cabin", "fare", "trip_type", "origin", "destination", "depart", "arrive",
                                         "stops", "total_min", "aircraft", "legroom_in", "legroom_label", "bags", "layovers") if f.get(k) is not None}
            fl["legs"] = legs
            if not fl.get("depart") and legs:
                fl["depart"] = legs[0].get("depart")
            if not fl.get("arrive") and legs:
                fl["arrive"] = legs[-1].get("arrive")
            fl.setdefault("origin", legs[0].get("from") if legs else None)
            fl.setdefault("destination", legs[-1].get("to") if legs else None)
            # derive what the page implies: total time and layovers from local clock times (same time zone)
            def _t(x):
                try:
                    return datetime.fromisoformat(x)
                except (TypeError, ValueError):
                    return None
            if fl.get("total_min") is None and _t(fl.get("depart")) and _t(fl.get("arrive")):
                fl["total_min"] = int((_t(fl["arrive"]) - _t(fl["depart"])).total_seconds() // 60)
            if not fl.get("layovers") and len(legs) > 1:
                lay = []
                for x, y in zip(legs, legs[1:]):
                    if _t(x.get("arrive")) and _t(y.get("depart")):
                        lay.append({"airport": x.get("to"), "minutes": int((_t(y["depart"]) - _t(x["arrive"])).total_seconds() // 60)})
                if lay:
                    fl["layovers"] = lay
            for l_ in fl.get("layovers") or []:
                if l_.get("minutes") is None and l_.get("note"):
                    m = re.search(r"(?:(\d+)\s*h(?:r|our)?s?)?\s*(?:(\d+)\s*m(?:in)?)?", str(l_["note"]))
                    if m and (m.group(1) or m.group(2)):
                        l_["minutes"] = int(m.group(1) or 0) * 60 + int(m.group(2) or 0)
            if str(fl.get("trip_type", "")).replace(" ", "_").lower() in ("one_way", "oneway"):
                fl["trip_type"] = "one_way"
            elif fl.get("trip_type"):
                fl["trip_type"] = "round_trip"
            if f.get("cabin") and not fl.get("cabin"):
                fl["cabin"] = f["cabin"]
            fl["period"] = part(fl)
            nos = " ".join(fl.get("flight_numbers") or [])
            stops = fl.get("stops") or 0
            name = f"{fl.get('airline', 'Flight')} {nos} {fl.get('origin')}→{fl.get('destination')}, {fl['depart'][11:16] if fl.get('depart') else ''}, " \
                   f"{'nonstop' if not stops else str(stops) + ' stop' + ('s' if stops > 1 else '')}, {fl.get('cabin', 'economy').lower()}"
            new.append({
                "id": f"fl-{slug(prov)}-{f['tier']}-{slug(nos or fl.get('airline'))}-{(fl.get('depart') or '')[11:16].replace(':', '')}-{len(new)}",
                "tiers": [f["tier"]], "category": "flights", "name": name.replace("  ", " "), "provider": prov,
                "url": f["url"], "price": f["price"], "unit": "per_person", "verified": bool(f.get("verified", True)),
                "checked_at": f.get("checked_at") or today, "exclusive_group": "flight", "default_on": False, "flight": fl,
            })
    items = [it for it in data["items"] if not (it.get("category") == "flights" and it.get("provider") in seen_prov and it.get("kind") != "bags")]
    items += new
    cnt = {}
    for it in new:
        cnt[(it["provider"], it["tiers"][0], it["flight"]["period"])] = cnt.get((it["provider"], it["tiers"][0], it["flight"]["period"]), 0) + 1
    for prov in sorted(seen_prov):
        print(prov)
        for t in TIERS:
            print("  ", t, {p: cnt.get((prov, t, p), 0) for p in ("morning", "afternoon", "night")})
    if blocked:
        print("blocked:", blocked)
    if a.dry_run:
        return
    data["items"] = items
    cov = data.setdefault("coverage", {})
    for p in seen_prov:
        cov.setdefault(p, {})["flights"] = "searched"
    for s_, why in blocked.items():
        cov.setdefault(s_, {})["flights"] = "blocked"
    data.setdefault("flight_gaps", {}).update(gaps)
    json.dump(data, open(a.trip_json, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"merged {len(new)} flights into {a.trip_json}")


if __name__ == "__main__":
    main()
