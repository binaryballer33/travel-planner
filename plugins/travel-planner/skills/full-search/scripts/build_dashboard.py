#!/usr/bin/env python3
"""Validate a trip JSON file and build the trip-cost dashboard HTML from the template.

  python3 build_dashboard.py trip.json -o lisbon-2026-11-trip-dashboard.html
  python3 build_dashboard.py trip.json --check          # validate only
  python3 build_dashboard.py trip.json --strict         # warnings fail the build

Validation enforces the contract in references/trip-schema.md. The two rules that matter most:
every item needs a direct link (a bare homepage fails), and every price is labelled verified or
estimate. Totals are printed per tier so they can be quoted in the chat summary.
"""
import argparse
import json
import re
import os
import sys
from collections import defaultdict
from datetime import date, datetime
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = os.path.join(HERE, "..", "assets", "dashboard-template.html")

TIERS = ["budget", "mid", "upper", "luxury"]
DEFAULT_CATEGORIES = [
    {"id": "flights", "label": "Flights"},
    {"id": "lodging", "label": "Lodging"},
    {"id": "car", "label": "Rental car"},
    {"id": "transfer", "label": "Airport transfer"},
    {"id": "activities", "label": "Activities & tours"},
    {"id": "food", "label": "Food & daily spend"},
    {"id": "transport", "label": "Local transport"},
    {"id": "sim", "label": "SIM & mobile data"},
    {"id": "insurance", "label": "Insurance & fees"},
    {"id": "other", "label": "Other"},
]
COVERAGE_MATRIX = {
    "Airbnb": ["lodging", "activities"], "Booking.com": ["lodging", "flights", "car", "activities"],
    "Expedia": ["flights", "lodging", "car", "activities"], "Kayak": ["flights", "lodging", "car"],
    "Skyscanner": ["flights", "lodging", "car"], "Trip.com": ["flights", "lodging", "car", "activities"],
    "Agoda": ["lodging", "flights", "activities"], "Hostelworld": ["lodging"],
    "Google Flights": ["flights"], "Google Hotels": ["lodging"],
}
TRIP_TYPES = {"round_trip", "one_way"}
COVERAGE_STATUS = {"searched", "no-inventory", "blocked"}
UNITS = {"per_person", "per_night", "per_day", "per_person_per_day", "per_person_per_night", "total"}
POI_TYPES = {"hospital", "pharmacy", "embassy", "grocery", "nightlife", "nature", "other"}
DATE_PARAMS = ("checkin", "check_in", "checkIn", "from", "date", "ddate", "tfs", "q", "dates", "startDate", "date_from")


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)


def is_homepage(url: str) -> bool:
    p = urlsplit(url)
    if p.path in ("", "/"):
        q = p.query.lower()
        return not any(k.lower() + "=" in q for k in DATE_PARAMS)
    return False


DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%m-%d-%y", "%Y/%m/%d", "%m.%d.%Y",
                "%b %d %Y", "%B %d %Y", "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y")


def parse_date(s, field, rep):
    """Accept yyyy-mm-dd, mm-dd-yyyy or mm/dd/yyyy (month first); the build normalises to ISO."""
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(str(s).strip(), fmt).date()
        except (TypeError, ValueError):
            continue
    rep.error(f"{field}: expected a date like 2026-11-10, 11-10-2026 or 11/10/2026, got {s!r}")
    return None


def normalise_dates(data, rep):
    """Rewrite every date field to ISO so the template's JavaScript can parse it."""
    trip = data.get("trip") or {}
    for f in ("start_date", "end_date", "generated_at"):
        if trip.get(f):
            d = parse_date(trip[f], f"trip.{f}", rep)
            if d:
                trip[f] = d.isoformat()
    for it in data.get("items") or []:
        if isinstance(it, dict) and it.get("checked_at"):
            d = parse_date(it["checked_at"], f"items[{it.get('id')}].checked_at", rep)
            if d:
                it["checked_at"] = d.isoformat()


def validate(data, rep: Report):
    if not isinstance(data, dict):
        rep.error("top level must be an object")
        return None
    trip = data.get("trip")
    if not isinstance(trip, dict):
        rep.error("missing 'trip' object")
        return None
    for f in ("title", "origin", "destination", "start_date", "end_date", "travelers", "currency", "generated_at"):
        if f not in trip:
            rep.error(f"trip.{f} is required")
    dest = trip.get("destination") or {}
    for f in ("city", "lat", "lng"):
        if f not in dest:
            rep.error(f"trip.destination.{f} is required (geocode the city with scripts/geocode.py)")
    start = parse_date(trip.get("start_date"), "trip.start_date", rep)
    end = parse_date(trip.get("end_date"), "trip.end_date", rep)
    nights = 0
    if start and end:
        nights = (end - start).days
        if nights <= 0:
            rep.error("trip.end_date must be after trip.start_date")
    parse_date(trip.get("generated_at"), "trip.generated_at", rep)
    if trip.get("trip_type") is not None and trip["trip_type"] not in TRIP_TYPES:
        rep.error(f"trip.trip_type must be one of {sorted(TRIP_TYPES)}")
    travelers = trip.get("travelers")
    if not isinstance(travelers, int) or travelers < 1:
        rep.error("trip.travelers must be an integer >= 1")
        travelers = 1
    days = trip.get("days") or nights + 1

    categories = data.get("categories") or DEFAULT_CATEGORIES
    cat_ids = {c["id"] for c in categories}
    data["categories"] = categories

    items = data.get("items")
    if not isinstance(items, list) or not items:
        rep.error("'items' must be a non-empty list")
        items = []
    seen = set()
    totals = {t: 0.0 for t in TIERS}
    counts = {t: {"items": 0, "verified": 0, "estimate": 0} for t in TIERS}
    for i, it in enumerate(items):
        where = f"items[{i}] ({it.get('id', '?')})"
        if not isinstance(it, dict):
            rep.error(f"{where}: must be an object")
            continue
        iid = it.get("id")
        if not iid:
            rep.error(f"{where}: id is required")
        elif iid in seen:
            rep.error(f"{where}: duplicate id")
        seen.add(iid)
        tiers = it.get("tiers")
        if tiers is None and it.get("tier"):
            tiers = [it["tier"]]
        if not isinstance(tiers, list) or not tiers:
            rep.error(f"{where}: 'tiers' (list) or 'tier' is required")
            tiers = []
        bad = [t for t in tiers if t not in TIERS]
        if bad:
            rep.error(f"{where}: unknown tier(s) {bad}; valid: {TIERS}")
        it["tiers"] = tiers
        if it.get("category") not in cat_ids:
            rep.error(f"{where}: category {it.get('category')!r} not in {sorted(cat_ids)}")
        for f in ("name", "provider"):
            if not it.get(f):
                rep.error(f"{where}: {f} is required")
        url = it.get("url") or ""
        if not url.startswith(("http://", "https://")):
            rep.error(f"{where}: url must be an absolute http(s) link")
        elif is_homepage(url):
            rep.error(f"{where}: url is a homepage ({url}); link the specific listing/itinerary or the dated search results")
        price = it.get("price")
        if not isinstance(price, (int, float)) or price < 0:
            rep.error(f"{where}: price must be a non-negative number")
            price = 0
        unit = it.get("unit")
        if unit not in UNITS:
            rep.error(f"{where}: unit {unit!r} not in {sorted(UNITS)}")
        if not isinstance(it.get("verified"), bool):
            rep.error(f"{where}: verified must be true or false")
        elif it["verified"] and not it.get("checked_at"):
            rep.warn(f"{where}: verified price without checked_at date")
        elif not it["verified"] and not it.get("source"):
            rep.warn(f"{where}: estimate without a 'source' (where did the number come from?)")
        if it.get("category") == "lodging" and (it.get("lat") is None or it.get("lng") is None):
            rep.warn(f"{where}: lodging without lat/lng will not appear on the map")
        elif it.get("category") == "lodging" and iid not in (data.get("nearby") or {}):
            rep.warn(f"{where}: no embedded 5-mile places; run scripts/fetch_pois.py so the map does not depend on live Overpass servers")
        qty = it.get("qty")
        if qty is None:
            qty = {"per_person": travelers, "per_night": nights, "per_day": days,
                   "per_person_per_day": travelers * days, "per_person_per_night": travelers * nights}.get(unit, 1)
        line = float(price) * float(qty)
        for t in tiers:
            if t in counts:
                counts[t]["items"] += 1
                counts[t]["verified" if it.get("verified") else "estimate"] += 1
                if it.get("default_on", True):
                    totals[t] += line

    coverage = data.get("coverage")
    if coverage is None:
        rep.warn("no 'coverage' object: the user asked for every vendor to be searched; record each vendor×category cell "
                 "(searched | no-inventory | blocked) so the dashboard can show it")
    elif not isinstance(coverage, dict):
        rep.error("'coverage' must be an object: vendor -> {category: status}")
    else:
        for vendor, cats in COVERAGE_MATRIX.items():
            got = coverage.get(vendor) or {}
            for c in cats:
                st = got.get(c)
                if st is None:
                    rep.warn(f"coverage: {vendor} × {c} not recorded (searched | no-inventory | blocked)")
                elif st not in COVERAGE_STATUS:
                    rep.error(f"coverage: {vendor} × {c} has status {st!r}; use one of {sorted(COVERAGE_STATUS)}")
    # Master Search List: every vendor x category results page, so the user can search by hand later
    links = data.get("search_links")
    if links is None:
        rep.warn("no 'search_links' object: the dashboard's Master Search List will be hidden; add vendor -> {category: url} "
                 "with each site's full results page for the route, dates and guests")
    elif not isinstance(links, dict):
        rep.error("'search_links' must be an object: vendor -> {category: url | {url, note?, label?}}")
    else:
        for vendor, cells in links.items():
            if not isinstance(cells, dict):
                rep.error(f"search_links[{vendor}] must be an object of category -> url"); continue
            for c, v in cells.items():
                url = v if isinstance(v, str) else (v or {}).get("url") if isinstance(v, dict) else None
                if not url or not str(url).startswith("http"):
                    rep.error(f"search_links[{vendor}][{c}]: needs an http(s) url")
                elif c in ("flights", "lodging", "car") and is_homepage(url):
                    rep.warn(f"search_links[{vendor}][{c}]: looks like a homepage, not a results page")
        if isinstance(coverage, dict):
            for vendor, cats in coverage.items():
                for c in (cats or {}):
                    if not (links.get(vendor) or {}).get(c):
                        rep.warn(f"search_links: {vendor} × {c} was searched but has no results link")
    if isinstance(coverage, dict):
        if not any(it.get("category") == "flights" and "bag" in str(it.get("name", "")).lower() for it in items):
            rep.warn("no checked-bag line among the flights items; the user wants bag fees priced (references/baggage.md)")

    nearby = data.get("nearby") or {}
    if not isinstance(nearby, dict):
        rep.error("'nearby' must be an object keyed by lodging item id (written by scripts/fetch_pois.py)")
    else:
        for sid, nb in nearby.items():
            if not isinstance(nb, dict) or not isinstance(nb.get("cats"), dict):
                rep.error(f"nearby[{sid}]: expected {{fetched_at, cats: {{category: [places]}}}}")

    pois = data.get("pois") or []
    if not isinstance(pois, list):
        rep.error("'pois' must be a list")
        pois = []
    data["pois"] = pois
    for i, p in enumerate(pois):
        where = f"pois[{i}] ({p.get('name', '?')})"
        for f in ("name", "type", "lat", "lng", "url"):
            if f not in p:
                rep.error(f"{where}: {f} is required")
        if p.get("type") not in POI_TYPES:
            rep.error(f"{where}: type {p.get('type')!r} not in {sorted(POI_TYPES)}")
    if not any(p.get("type") == "hospital" for p in pois):
        rep.warn("no curated hospital in 'pois'; add 2-3 top-rated international/private hospitals with ratings")

    for t in TIERS:
        if counts[t]["items"] == 0:
            rep.warn(f"tier '{t}' has no items; its tab will be empty")
    vendor_counts = {}
    for it in items:
        if isinstance(it, dict) and it.get("category") in ("flights", "lodging", "car", "activities") \
                and not (it.get("kind") == "bags" or str(it.get("id", "")).startswith("bags-")):
            vendor_counts.setdefault(it["category"], {}).setdefault(it.get("provider"), 0)
            vendor_counts[it["category"]][it.get("provider")] += 1
    fl = {}
    for it in items:
        if isinstance(it, dict) and it.get("category") == "flights" and not (it.get("kind") == "bags" or str(it.get("id", "")).startswith("bags-")):
            for t in it.get("tiers") or []:
                fl.setdefault(it.get("provider"), {}).setdefault(t, 0)
                fl[it.get("provider")][t] += 1
    for prov, tiers_n in fl.items():
        short = [f"{t} {tiers_n.get(t, 0)}" for t in TIERS if tiers_n.get(t, 0) < 5]
        if short:
            rep.warn(f"flights: {prov} has fewer than 5 options in tier(s) " + ", ".join(short) +
                     " (the user wants at least 5 flights per site in EVERY tier: economy search -> budget + mid, business search -> upper + luxury; say in trip.notes when a site truly shows fewer)")
    def _part(it):
        f = it.get("flight") or {}
        if f.get("period"):
            return f["period"]
        legs = f.get("legs") or []
        t = f.get("depart") or (legs[0].get("depart") if legs else "")
        try:
            h = int(str(t)[11:13])
        except ValueError:
            return ""
        return "morning" if 5 <= h < 12 else "afternoon" if 12 <= h < 18 else "night"
    fp = {}
    nocard = 0
    for it in items:
        if isinstance(it, dict) and it.get("category") == "flights" and not (it.get("kind") == "bags" or str(it.get("id", "")).startswith("bags-")):
            if not it.get("flight"):
                nocard += 1
                continue
            fl_ = it["flight"]
            if not (fl_.get("legs") or fl_.get("depart")):
                rep.warn(f"flight {it.get('id')}: flight object has no legs/depart; the card cannot show times")
            for t in it.get("tiers") or []:
                fp.setdefault((it.get("provider"), t, _part(it)), 0)
                fp[(it.get("provider"), t, _part(it))] += 1
    if nocard:
        rep.warn(f"{nocard} flight line(s) have no `flight` object, so they render as plain lines instead of flight cards (airline, times, legs, aircraft, legroom, bags: references/trip-schema.md)")
    provs = {k[0] for k in fp}
    short = []
    for prov in sorted(p_ for p_ in provs if p_):
        for t in TIERS:
            for part in ("morning", "afternoon", "night"):
                n = fp.get((prov, t, part), 0)
                if n < 5:
                    short.append(f"{prov}/{t}/{part} {n}")
    if short:
        rep.warn("flights per site x tier x time of day under 5 (the user wants 5 morning, 5 afternoon and 5 night flights in every tier on every site; list what exists and say in trip.notes where a site truly has fewer): " + "; ".join(short[:40]) + (" ..." if len(short) > 40 else ""))
    for cat, vend in vendor_counts.items():
        low = [f"{v} ({n})" for v, n in vend.items() if n < 5]
        if low:
            rep.warn(f"{cat}: fewer than 5 options from " + ", ".join(low) +
                     " (the user wants at least 5 per site per category, across all tiers; add more, or say in trip.notes that the site had no more)")

    # Reviews: the user wants a rating and review count on every stay, rental car and activity
    for cat, what in (("lodging", "stay"), ("car", "car (use the rental company's rating on that site)"), ("activities", "activity")):
        missing = [it.get("id") for it in items if isinstance(it, dict) and it.get("category") == cat and it.get("rating") is None and not it.get("rating_source")]
        if missing:
            rep.warn(f"{cat}: {len(missing)} line(s) without a rating/reviews ({', '.join(map(str, missing[:4]))}{'…' if len(missing) > 4 else ''}); "
                     f"read the rating and review count for every {what} off the results page (rating, rating_scale, reviews), or set rating_source saying none exists")
    if not any(isinstance(it, dict) and it.get("category") == "transfer" for it in items):
        rep.warn("no 'transfer' items: price the ride from the arrival airport to each tier's default stay "
                 "(Uber's estimate first; where Uber does not operate, Grab/Bolt/local apps, the airport taxi counter, bus, pre-booked transfer)")
    sims = [it for it in items if isinstance(it, dict) and it.get("category") == "sim"]
    if not sims:
        rep.warn("no 'sim' items: price every local mobile operator's tourist SIM and 3-4 eSIMs for the trip length, with links")
    else:
        if not any(it.get("kind") == "local" for it in sims):
            rep.warn("sim: no line with \"kind\": \"local\"; add the destination's own mobile operators' tourist SIMs (official pages), not only eSIM resellers")
        if not any(it.get("kind") == "esim" for it in sims):
            rep.warn("sim: no line with \"kind\": \"esim\"; add 3-4 eSIM plans (Airalo, Holafly, Nomad, Saily)")
    if not trip.get("ride_apps"):
        rep.warn("trip.ride_apps is empty: list the ride-hailing apps people actually use there [{name, url, note}] for the sidebar")
    ap = trip.get("arrival_airport")
    if ap is not None and (not isinstance(ap, dict) or ap.get("lat") is None or ap.get("lng") is None):
        rep.error("trip.arrival_airport needs {name, iata, lat, lng}")
    elif ap is None:
        rep.warn("no trip.arrival_airport {name, iata, lat, lng}: the map cannot show ride and directions links from the airport")

    w = data.get("weather")
    if w is None:
        rep.warn("no 'weather' object: run scripts/fetch_weather.py trip.json so the weather card shows the forecast or the monthly normal")
    elif not isinstance(w, dict) or not isinstance(w.get("normals", []), list) or not isinstance(w.get("forecast", []), list):
        rep.error("'weather' must be {normals: [...], forecast: [...], links: [...]} (written by scripts/fetch_weather.py)")
    else:
        if not w.get("links"):
            rep.warn("weather: no links; the user wants a page to verify the forecast")
        if not w.get("climate_months"):
            rep.warn("weather: no climate_months; rerun scripts/fetch_weather.py so the rainy-season chart can draw")
        rs = w.get("rainy_season")
        if not rs:
            rep.warn("weather: no rainy_season {months, label, peak, source, source_url}; look it up (national weather service / tourism board)")
        elif "ERA5" in str(rs.get("source", "")):
            rep.warn("weather.rainy_season is still the script's guess; confirm it with an official source and cite it")

    # Tourist neighborhoods (nightlife + food) and the stays searched in each: the user wants at least
    # 5 stays per neighborhood, per tier, per lodging site that was searched.
    nbs = data.get("neighborhoods")
    if not nbs:
        rep.warn("no 'neighborhoods': list the 3-6 tourist neighborhoods known for nightlife and food "
                 "(name, lat/lng, nightlife, food, source_url), then search lodging in each")
    elif not isinstance(nbs, list):
        rep.error("'neighborhoods' must be a list")
    else:
        nb_ids = set()
        for i, n in enumerate(nbs):
            where = f"neighborhoods[{i}] ({n.get('name', '?')})"
            if not n.get("id") or not n.get("name"):
                rep.error(f"{where}: id and name are required")
                continue
            nb_ids.add(n["id"])
            if n.get("lat") is None or n.get("lng") is None:
                rep.warn(f"{where}: no lat/lng, so the map cannot outline it")
            if not (n.get("nightlife") or n.get("food")):
                rep.warn(f"{where}: say what the nightlife and food are like")
            if not str(n.get("source_url", "")).startswith("http"):
                rep.warn(f"{where}: no source_url (Wikivoyage district page, tourism board or a city guide)")
        lodg = [it for it in items if isinstance(it, dict) and it.get("category") == "lodging"]
        for it in lodg:
            if it.get("neighborhood") and it["neighborhood"] not in nb_ids:
                rep.warn(f"lodging {it.get('id')}: neighborhood '{it['neighborhood']}' is not in neighborhoods")
        sites = sorted({p for p, cats in (coverage or {}).items() if isinstance(cats, dict) and cats.get("lodging") == "searched"}) \
            or sorted({it.get("provider") for it in lodg})
        if lodg and not any(it.get("neighborhood") for it in lodg):
            rep.warn("lodging: no stay carries a 'neighborhood'; search each neighborhood on every lodging site "
                     "(5 per tier per site) and tag each stay with its neighborhood id")
        elif lodg:
            for n in nbs:
                if not n.get("id") or n.get("search_stays") is False:
                    continue
                gaps = n.get("gaps") or {}
                short = []
                for prov in sites:
                    g = gaps.get(prov)
                    for t in ("budget", "mid", "upper", "luxury"):
                        # a gap note covers a tier when it names it ({"luxury": "…"} or "…no upper or luxury")
                        if (isinstance(g, dict) and g.get(t)) or (isinstance(g, str) and re.search(rf"\b{t}\b", g, re.I)):
                            continue
                        k = sum(1 for it in lodg if it.get("neighborhood") == n["id"] and it.get("provider") == prov and t in (it.get("tiers") or []))
                        if k < 5:
                            short.append(f"{prov} {t} {k}")
                if short:
                    rep.warn(f"lodging in {n.get('name')}: under 5 stays for {len(short)} site×tier cell(s): " + ", ".join(short[:8]) +
                             ("…" if len(short) > 8 else "") + " (add more, or record why in neighborhoods[].gaps, e.g. {\"Hostelworld\": \"hostels only\"})")

    lf = data.get("local_food")
    if lf is None:
        rep.warn("no 'local_food' object: list the destination's signature dishes and the best-rated restaurants that serve them, with links")
    elif not isinstance(lf, dict) or not isinstance(lf.get("restaurants"), list):
        rep.error("'local_food' must be {dishes: [...], restaurants: [...]}")
    else:
        dish_ids = {d.get("id") for d in lf.get("dishes") or []}
        scopes = {d.get("scope", "city") for d in lf.get("dishes") or []}
        if "country" not in scopes:
            rep.warn("local_food: no dish with \"scope\": \"country\"; add 8-10 national classics (and restaurants here that serve them)")
        if "city" not in scopes:
            rep.warn("local_food: no dish with \"scope\": \"city\"; add 8-10 dishes popular and specific to this city/region")
        for i, d in enumerate(lf.get("dishes") or []):
            if not d.get("id") or not d.get("name"):
                rep.error(f"local_food.dishes[{i}]: id and name are required")
            if not d.get("source_url"):
                rep.warn(f"local_food.dishes[{i}] ({d.get('name')}): no source_url describing the dish")
            if not (d.get("image") or {}).get("thumb"):
                rep.warn(f"local_food.dishes[{i}] ({d.get('name')}): no photo; run scripts/fetch_dish_images.py "
                         "(Wikimedia Commons, with credit) so the card shows what the dish looks like")
        for i, r in enumerate(lf["restaurants"]):
            where = f"local_food.restaurants[{i}] ({r.get('name', '?')})"
            if not r.get("name") or not str(r.get("url", "")).startswith("http"):
                rep.error(f"{where}: name and an http(s) url (its Google Maps page) are required")
            if r.get("rating") is None and not r.get("rating_source"):
                rep.warn(f"{where}: no rating/reviews; read them on Google Maps (Trip.com or Tripadvisor where Google is thin), or set rating_source saying none exists")
            if not r.get("evidence_url"):
                rep.warn(f"{where}: no evidence_url showing the dish on its menu")
            bad = [x for x in r.get("dishes") or [] if x not in dish_ids]
            if bad:
                rep.error(f"{where}: dishes {bad} are not in local_food.dishes")

    # Buses, trains & metro: required when the origin is in the destination's country
    same_country = None
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from deeplinks import resolve_place, _ascii
        oc = resolve_place(trip.get("origin", {}).get("iata") or trip.get("origin", {}).get("city", ""))[2]
        dc = trip.get("destination", {}).get("country", "")
        same_country = bool(oc and dc) and _ascii(oc).lower() == _ascii(dc).lower()
    except Exception:
        pass
    g = data.get("ground")
    if g is None:
        if same_country:
            rep.warn("no 'ground' object: origin and destination are in the same country, so research intercity buses and trains "
                     "(deeplinks.py prints the sites) and the city's metro / bus fares for the 'Buses, trains & metro' card")
    elif not isinstance(g, dict):
        rep.error("'ground' must be an object: {options: [...], local_transit: [...], stations: [...], search_links: [...]}")
    else:
        for i, o in enumerate(g.get("options") or []):
            where = f"ground.options[{i}] ({o.get('operator') or o.get('provider', '?')})"
            if not str(o.get("url", "")).startswith("http"):
                rep.error(f"{where}: a results-page url is required")
            if o.get("mode", "bus") not in ("bus", "train", "ferry", "rideshare"):
                rep.warn(f"{where}: mode should be bus, train, ferry or rideshare")
            if o.get("price") is not None and not o.get("verified") and not o.get("source"):
                rep.warn(f"{where}: estimate with no source")
        if same_country and not (g.get("options") or []):
            rep.warn("ground: no intercity departures listed (if none run, say so in ground.summary)")
        if not (g.get("local_transit") or []):
            rep.warn("ground: no local_transit (metro / bus / BRT fares and the fare card) for the destination")

    trips_ = data.get("day_trips")
    if trips_ is None:
        rep.warn("no 'day_trips': list 6-8 popular day trips with every way to get there and the round-trip cost per person")
    elif not isinstance(trips_, list):
        rep.error("'day_trips' must be a list")
    else:
        if len(trips_) < 5:
            rep.warn(f"day_trips: only {len(trips_)}; list 6-8 of the most popular")
        for i, d in enumerate(trips_):
            where = f"day_trips[{i}] ({d.get('name', '?')})"
            if not d.get("name"):
                rep.error(f"{where}: name is required")
            tr = d.get("transport") or []
            if not tr:
                rep.warn(f"{where}: no transport options (bus, car, tour...) with costs")
            for x in tr:
                if x.get("cost_usd") is not None and not str(x.get("url", "")).startswith("http"):
                    rep.warn(f"{where}: transport '{x.get('how') or x.get('mode')}' has a cost but no link to check it")
            if not (d.get("image") or {}).get("thumb"):
                rep.warn(f"{where}: no photo; give it a 'wiki' title and run scripts/fetch_dish_images.py")

    rr = data.get("restaurants")
    if rr is None:
        rep.warn("no 'restaurants' object: list the best-rated local and international restaurants for the 'Best restaurants' card")
    elif not isinstance(rr, dict) or not isinstance(rr.get("restaurants"), list):
        rep.error("'restaurants' must be {restaurants: [...]}")
    else:
        kinds = [r.get("kind") for r in rr["restaurants"]]
        for k in ("local", "international"):
            if kinds.count(k) < 8:
                rep.warn(f"restaurants: {kinds.count(k)} '{k}' places; list 10-12")
        for i, r in enumerate(rr["restaurants"]):
            where = f"restaurants.restaurants[{i}] ({r.get('name', '?')})"
            if not r.get("name") or not str(r.get("url", "")).startswith("http"):
                rep.error(f"{where}: name and an http(s) url (its Google Maps page) are required")
            if r.get("kind") not in ("local", "international"):
                rep.warn(f"{where}: kind should be 'local' or 'international'")
            if r.get("rating") is None and not r.get("rating_source"):
                rep.warn(f"{where}: no rating/reviews")

    # Entry rules banner: visa / vaccines / arrival forms for the traveler's passport (default US citizens)
    entry = data.get("entry")
    if entry is None:
        rep.warn("no 'entry' object: research visa, e-visa/ETA, vaccines and arrival-form rules for US citizens "
                 "(references/entry-requirements.md) so the dashboard can show its red warning banner")
    elif not isinstance(entry, dict) or not isinstance(entry.get("items"), list):
        rep.error("'entry' must be an object with an 'items' list")
    else:
        for i, x in enumerate(entry["items"]):
            if x.get("status") not in ("required", "recommended", "info", "not-required"):
                rep.error(f"entry.items[{i}]: status must be required | recommended | info | not-required")
            if not x.get("title"):
                rep.error(f"entry.items[{i}]: needs a title")
        if not entry.get("sources"):
            rep.warn("entry: no sources listed; cite the State Department / CDC / official visa pages")

    return {"nights": nights, "days": days, "travelers": travelers, "totals": totals, "counts": counts,
            "currency": trip.get("currency", ""), "vendor_counts": vendor_counts}


_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_MRX = r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?"


def add_weekdays(text, year):
    """Put the three-letter weekday in front of every written date: 'Nov 1 – 14 2026' ->
    'Sun Nov 1 – Sat Nov 14 2026', '25 Oct 2026' -> 'Sun 25 Oct 2026'. The user asked for the
    weekday wherever a date appears. Dates already carrying a weekday are left alone."""
    import re
    if not isinstance(text, str) or not re.search(_MRX, text):
        return text
    def wd(y, m, d):
        try:
            return _WD[date(int(y), m, int(d)).weekday()]
        except ValueError:
            return None
    pre = r"(?<!Mon )(?<!Tue )(?<!Wed )(?<!Thu )(?<!Fri )(?<!Sat )(?<!Sun )(?<!Mon, )(?<!Tue, )(?<!Wed, )(?<!Thu, )(?<!Fri, )(?<!Sat, )(?<!Sun, )"
    # month-first: Nov 1, Nov 1 2026, Nov 1 – 14 2026, Nov 1 – Dec 3, 2026
    def mfirst(m):
        mon = _MON.index(m.group(1)[:3]) + 1
        d1, d2, mon2, y = m.group(2), m.group(4), m.group(3), m.group(5) or year
        a = wd(y, mon, d1)
        if not a:
            return m.group(0)
        out = f"{a} {m.group(1)} {d1}"
        if d2:
            mon2n = _MON.index(mon2[:3]) + 1 if mon2 else mon
            b = wd(y, mon2n, d2)
            out += f" – {b} {(mon2 or m.group(1))} {d2}" if b else m.group(0)[len(m.group(1)) + 1 + len(d1):]
        if m.group(5):
            out += m.group(6) + m.group(5)
        return out
    text = re.sub(pre + r"\b" + _MRX + r" (\d{1,2})(?!\d|:)(?:\s*[–-]\s*(?:" + _MRX[:-5] + r"[a-z]*\.? )?(\d{1,2})(?!\d|:))?(?:(,? )(\d{4}))?",
                  lambda m: mfirst(_fix(m)), text)
    # day-first: 25 Oct 2026, 1 – 14 Nov 2026
    def dfirst(m):
        mon = _MON.index(m.group(3)[:3]) + 1
        y = m.group(4) or year
        a = wd(y, mon, m.group(1))
        if not a:
            return m.group(0)
        if m.group(2):
            b = wd(y, mon, m.group(2))
            return f"{a} {m.group(1)} – {b} {m.group(2)} {m.group(3)}" + (f" {m.group(4)}" if m.group(4) else "")
        return f"{a} {m.group(1)} {m.group(3)}" + (f" {m.group(4)}" if m.group(4) else "")
    text = re.sub(pre + r"\b(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))? " + _MRX + r"(?: (\d{4}))?(?![a-z])", dfirst, text)
    return text


class _M:  # adapts a match from the month-first pattern to fixed group numbers
    def __init__(self, m):
        g = m.groups()
        self._g = {0: m.group(0), 1: g[0], 2: g[1], 3: g[2], 4: g[3], 5: g[5] if len(g) > 5 else None, 6: g[4] if len(g) > 4 else None}
    def group(self, i):
        return self._g[i]


def _fix(m):
    return _M(m)


def weekday_everything(data):
    year = str(((data.get("trip") or {}).get("start_date") or "2026")[:4])
    for it in data.get("items") or []:
        for k in ("name", "details", "price_note", "source"):
            if k in it:
                it[k] = add_weekdays(it[k], year)
    t = data.get("trip") or {}
    if "notes" in t:
        t["notes"] = add_weekdays(t["notes"], year)
    for x in (data.get("entry") or {}).get("items") or []:
        for k in ("title", "text"):
            if k in x:
                x[k] = add_weekdays(x[k], year)
    for r in (data.get("local_food") or {}).get("restaurants") or []:
        if "notes" in r:
            r["notes"] = add_weekdays(r["notes"], year)
    rs = (data.get("weather") or {}).get("rainy_season") or {}
    if "note" in rs:
        rs["note"] = add_weekdays(rs["note"], year)


def build(data, template_path, out_path):
    weekday_everything(data)
    with open(template_path, encoding="utf-8") as f:
        html = f.read()
    for ph in ("__TRIP_DATA_JSON__", "__TRIP_TITLE__"):
        if ph not in html:
            raise SystemExit(f"template is missing placeholder {ph}")
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    title = str(data["trip"].get("title", "Trip")).replace("<", "&lt;").replace(">", "&gt;")
    html = html.replace("__TRIP_TITLE__", title).replace("__TRIP_DATA_JSON__", payload)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("-o", "--out", help="output HTML path (default: <trip_json basename>-dashboard.html)")
    ap.add_argument("--template", default=DEFAULT_TEMPLATE)
    ap.add_argument("--check", action="store_true", help="validate and print totals, do not write HTML")
    ap.add_argument("--strict", action="store_true", help="treat warnings as errors")
    ap.add_argument("--partial", nargs="?", const="lodging,car,transfer,activities,food,transport,sim,insurance", metavar="CATS",
                    help="early build while research continues: mark these categories as still searching "
                         "(default: everything but flights); the page shows a banner and reloads itself every minute "
                         "until you run the full build without --partial")
    ap.add_argument("--map-pending", action="store_true",
                    help="every price is in but scripts/fetch_pois.py is still running: build the whole dashboard now "
                         "with a 'map places still loading' banner; the page reloads itself every minute until you "
                         "rebuild without this flag once the map data is embedded")
    a = ap.parse_args(argv)
    if a.map_pending:
        a.partial = ",".join([c for c in (a.partial or "").split(",") if c.strip()] + ["map"])

    try:
        with open(a.trip_json, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: cannot read {a.trip_json}: {e}", file=sys.stderr)
        return 2

    rep = Report()
    if isinstance(data, dict) and isinstance(data.get("trip"), dict):
        if a.partial:
            data["trip"]["pending"] = [c.strip() for c in a.partial.split(",") if c.strip()]
        else:
            data["trip"].pop("pending", None)
    if isinstance(data, dict):
        normalise_dates(data, rep)
    summary = validate(data, rep)
    if a.partial:
        pend = data["trip"]["pending"]
        before = len(rep.warnings)
        cats = [c for c in pend if c != "map"]
        rep.warnings = [w for w in rep.warnings if not any(c in w for c in cats)
                        and not (cats and ("has no items" in w or "no curated hospital" in w)) and "fetch_pois" not in w]
        what = ", ".join(cats + (["the map's 5-mile places"] if "map" in pend else []))
        print(f"PARTIAL build: still waiting on {what}; {before - len(rep.warnings)} warning(s) about those hidden. "
              "The page reloads itself every minute until the full build replaces it.")
    for w in rep.warnings:
        print(f"WARNING: {w}")
    for e in rep.errors:
        print(f"ERROR: {e}")
    if rep.errors or (a.strict and rep.warnings):
        print(f"\n{len(rep.errors)} error(s), {len(rep.warnings)} warning(s). Not built.")
        return 1

    cur = summary["currency"]
    print(f"\nTrip: {data['trip']['title']} — {summary['nights']} nights / {summary['days']} days, "
          f"{summary['travelers']} traveler(s)")
    print(f"{'tier':8} {'default total':>16} {'per person':>12} {'lines':>6} {'verified':>9} {'estimate':>9}")
    for t in TIERS:
        c = summary["counts"][t]
        tot = summary["totals"][t]
        print(f"{t:8} {cur} {tot:>12,.0f} {cur} {tot / summary['travelers']:>8,.0f} {c['items']:>6} {c['verified']:>9} {c['estimate']:>9}")
    for cat, vend in summary["vendor_counts"].items():
        print(f"{cat:11} " + " · ".join(f"{v} {n}" for v, n in sorted(vend.items(), key=lambda x: -x[1])))
    if a.check:
        return 0

    out = a.out or os.path.splitext(os.path.basename(a.trip_json))[0] + "-dashboard.html"
    build(data, a.template, out)
    print(f"\nBuilt {out} ({os.path.getsize(out):,} bytes). {len(rep.warnings)} warning(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
