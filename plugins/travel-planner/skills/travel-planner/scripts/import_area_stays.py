#!/usr/bin/env python3
"""Merge per-neighborhood stay searches into a trip JSON as lodging lines.

  python3 import_area_stays.py trip.json stays_booking.json stays_agoda.json …   [--dry-run]

Each input file is what a research helper writes (format in references/area-stays-brief.md):
  {"site": "Booking.com", "checked_at": "YYYY-MM-DD", "coord_datum": "GCJ-02"?,   # file default
   "areas": {"<neighborhood id>": {"results_url": "…", "gaps": {"luxury": "why"},
             "stays": [{name, tier, price, price_basis, taxes, price_local?, price_with_taxes?,
                        rating, rating_scale, reviews, stars, address, lat, lng, coord_datum?,
                        url, url_is_results_page, note?, price_room_type?}]}}}

What it does:
  * one lodging item per stay, tagged "neighborhood" and "tiers": [tier], exclusive_group "stay";
  * prices: per_night stays per night; "total_<N>_nights" is a total when N is the trip's nights, else a
    nightly average (Expedia sells at most 28 nights); price_with_taxes / total incl. taxes win;
  * coordinates: GCJ-02 (China's map offset: Booking, Skyscanner, Google, Expedia in mainland China)
    are converted to WGS84 so pins land right on OpenStreetMap; stays without coordinates get the
    neighborhood centre, marked "approximate pin";
  * gaps go to neighborhoods[].gaps[site][tier]; a stay with no rating gets an honest rating_source;
  * the same property already listed by the same site (an earlier city-wide search) is replaced.
Run assign_tiers.py afterwards only for items without tiers; pick one default_on stay per tier yourself.
"""
import argparse
import json
import math
import re
import sys

TIERS = ("budget", "mid", "upper", "luxury")


def gcj_to_wgs(lat, lng):
    """GCJ-02 → WGS84 (a few metres' error); the offset in Beijing is about 550 m."""
    a, ee = 6378245.0, 0.00669342162296594323
    def tl(x, y):
        r = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*math.sqrt(abs(x))
        r += (20.0*math.sin(6.0*x*math.pi) + 20.0*math.sin(2.0*x*math.pi)) * 2.0/3.0
        r += (20.0*math.sin(y*math.pi) + 40.0*math.sin(y/3.0*math.pi)) * 2.0/3.0
        r += (160.0*math.sin(y/12.0*math.pi) + 320*math.sin(y*math.pi/30.0)) * 2.0/3.0
        return r
    def tg(x, y):
        r = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*math.sqrt(abs(x))
        r += (20.0*math.sin(6.0*x*math.pi) + 20.0*math.sin(2.0*x*math.pi)) * 2.0/3.0
        r += (20.0*math.sin(x*math.pi) + 40.0*math.sin(x/3.0*math.pi)) * 2.0/3.0
        r += (150.0*math.sin(x/12.0*math.pi) + 300.0*math.sin(x/30.0*math.pi)) * 2.0/3.0
        return r
    dlat, dlng = tl(lng - 105.0, lat - 35.0), tg(lng - 105.0, lat - 35.0)
    rl = lat / 180.0 * math.pi
    m = 1 - ee * math.sin(rl) ** 2
    sm = math.sqrt(m)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (m * sm) * math.pi)
    dlng = (dlng * 180.0) / (a / sm * math.cos(rl) * math.pi)
    return lat - dlat, lng - dlng


def num(x):
    if x in (None, ""):
        return None
    try:
        return float(str(x).replace(",", "").replace("$", "").strip())
    except ValueError:
        return None


def norm(s):
    return re.sub(r"[^a-z0-9一-鿿]", "", str(s).lower())


def slug(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())[:3] or "x"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    d = json.load(open(a.trip_json, encoding="utf-8"))
    from datetime import date
    t = d["trip"]
    nights = (date.fromisoformat(t["end_date"]) - date.fromisoformat(t["start_date"])).days
    NB = {n["id"]: n for n in d.get("neighborhoods") or []}
    if not NB:
        sys.exit("trip JSON has no neighborhoods; add them first")
    new, rep = [], {}
    for f in a.files:
        S = json.load(open(f, encoding="utf-8"))
        prov = S["site"]
        pre = slug(prov)
        seen = set()
        for area, blk in (S.get("areas") or {}).items():
            if area not in NB:
                print(f"{f}: unknown area {area!r} (not in neighborhoods)", file=sys.stderr)
                continue
            n = NB[area]
            for tier, why in (blk.get("gaps") or {}).items():
                n.setdefault("gaps", {}).setdefault(prov, {})
                if isinstance(n["gaps"][prov], dict):
                    n["gaps"][prov][tier] = why
            for k, x in enumerate(blk.get("stays") or []):
                name, tier = (x.get("name") or "").strip(), x.get("tier")
                if num(x.get("total_%d_nights_incl_taxes" % nights)):
                    x["price"], x["price_basis"], x["taxes"] = x["total_%d_nights_incl_taxes" % nights], "total_%d_nights" % nights, "incl"
                price = num(x.get("price_with_taxes")) or num(x.get("price"))
                if num(x.get("price_with_taxes")):
                    x["taxes"] = "incl"
                if not name or tier not in TIERS or not price or price <= 0:
                    continue
                key = (norm(name), area, x.get("lat"))
                if key in seen:
                    continue
                seen.add(key)
                basis, taxes = str(x.get("price_basis") or "per_night"), str(x.get("taxes") or "?")
                tx = ", taxes included" if taxes.startswith("incl") else ", before taxes" if taxes.startswith("excl") else ""
                m = re.match(r"total_(\d+)", basis)
                if m and int(m.group(1)) != nights:
                    nn = int(m.group(1))
                    unit, p, note = "per_night", round(price / nn, 2), f"nightly average of {prov}'s {nn}-night total (${price:,.0f}){tx}"
                elif m:
                    unit, p, note = "total", round(price, 2), f"{nights} nights total{tx}"
                else:
                    unit, p, note = "per_night", round(price, 2), f"per night{tx}"
                loc = x.get("price_local") if isinstance(x.get("price_local"), dict) and x["price_local"].get("amount") else None
                lat, lng = num(x.get("lat")), num(x.get("lng"))
                approx = lat is None or lng is None
                if approx:
                    lat, lng = n["lat"], n["lng"]
                elif str(x.get("coord_datum") or S.get("coord_datum") or "").upper().startswith("GCJ"):
                    lat, lng = gcj_to_wgs(lat, lng)
                det = f"{prov}, {n['name']}, read in your Chrome."
                if loc:
                    det += f" Shown as {loc.get('currency', '')} {loc['amount']:,} a night, converted to USD."
                if x.get("price_room_type"):
                    det += f" Price is for a {x['price_room_type']}."
                if x.get("note"):
                    det += " " + str(x["note"]).strip().rstrip(".") + "."
                if x.get("url_is_results_page"):
                    det += " The link opens the area's results page; find it by name."
                it = {"id": f"n-{pre}-{area}-{k}", "category": "lodging", "name": name, "provider": prov,
                      "url": x.get("url") or blk.get("results_url"), "price": p, "unit": unit, "verified": not loc,
                      "checked_at": S.get("checked_at"), "default_on": False, "exclusive_group": "stay", "tiers": [tier],
                      "neighborhood": area, "lat": lat, "lng": lng,
                      "address": (x.get("address") or n["name"]).strip() + (f" (approximate pin: {n['name']})" if approx else ""),
                      "price_note": note, "details": det}
                if num(x.get("stars")):
                    it["tags"] = [f"{int(num(x['stars']))}★"]
                r = num(x.get("rating"))
                if r is not None:
                    it.update(rating=r, rating_scale=num(x.get("rating_scale")) or (5 if r <= 5 else 10))
                    if num(x.get("reviews")):
                        it["reviews"] = int(num(x["reviews"]))
                else:
                    it["rating_source"] = f"No rating shown on {prov} yet"
                if loc:
                    it["source"] = f"{prov}, shown in {loc.get('currency', 'local currency')} and converted at today's rate"
                new.append(it)
                rep.setdefault(prov, {}).setdefault(area, dict.fromkeys(TIERS, 0))[tier] += 1
    keys = {(i["provider"], norm(i["name"])) for i in new}
    old = [i for i in d["items"] if i["category"] == "lodging" and (i["provider"], norm(i["name"])) not in keys and not i["id"].startswith("n-")]
    for prov, areas in rep.items():
        print(f"{prov:14} " + " | ".join(f"{ar} " + "/".join(str(c[t]) for t in TIERS) for ar, c in areas.items()))
    print(f"{len(new)} stays from {len(a.files)} file(s); {len(old)} earlier stays kept (duplicates replaced)")
    if not a.dry_run:
        d["items"] = [i for i in d["items"] if i["category"] != "lodging"] + new + old
        json.dump(d, open(a.trip_json, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
        print("wrote", a.trip_json)


if __name__ == "__main__":
    main()
