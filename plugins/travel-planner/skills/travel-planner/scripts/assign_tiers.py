#!/usr/bin/env python3
"""Assign a tier to every item that has none, by price rank within its category.

  python3 assign_tiers.py trip.json             # fills missing "tiers" in place
  python3 assign_tiers.py trip.json --dry-run   # show the assignment only

Why: with five options per vendor per category there are too many lines to hand-tier. Price
percentile within the category is a fair first cut (budget = cheapest 25%, mid = next 25%, upper =
next 30%, luxury = top 20%), with a quality floor: a lodging item rated below 7.5/10 (3.8/5) never
lands in upper or luxury, and a nonstop flight is never pushed below mid. Items that already carry
"tiers" (or "tier") are left alone, so hand-picked lines keep their place. Stays that carry a
"neighborhood" are ranked within that neighborhood. When you searched a neighborhood tier by tier
(star or price filters), set "tiers" yourself at import and this script leaves them alone.
"""
import argparse
import json

BANDS = [("budget", 0.25), ("mid", 0.50), ("upper", 0.80), ("luxury", 1.01)]


def unit_cost(it, travelers, nights, days):
    q = it.get("qty")
    if q is None:
        q = {"per_person": travelers, "per_night": nights, "per_day": days,
             "per_person_per_day": travelers * days, "per_person_per_night": travelers * nights}.get(it.get("unit"), 1)
    return float(it.get("price", 0)) * float(q)


def rating_ok(it):
    r, scale = it.get("rating"), it.get("rating_scale") or 10
    if r is None:
        return True
    return (float(r) / float(scale)) >= 0.75


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    with open(a.trip_json, encoding="utf-8") as f:
        data = json.load(f)
    t = data["trip"]
    from datetime import date
    nights = max(1, (date.fromisoformat(t["end_date"]) - date.fromisoformat(t["start_date"])).days)
    days = t.get("days") or nights + 1
    travelers = int(t.get("travelers", 1))
    items = data["items"]
    by_cat = {}
    for it in items:
        # stays searched per neighborhood are ranked against their own neighborhood, so every area
        # keeps its own budget-to-luxury spread (the user wants 5 per area, per tier, per site)
        key = (it["category"], it.get("neighborhood") if it["category"] == "lodging" else None)
        by_cat.setdefault(key, []).append(it)
    changed = 0
    for (cat, _area), lst in by_cat.items():
        untiered = [it for it in lst if not it.get("tiers") and not it.get("tier")]
        if not untiered:
            continue
        ranked = sorted(lst, key=lambda x: unit_cost(x, travelers, nights, days))
        n = len(ranked)
        for it in untiered:
            pos = (ranked.index(it) + 0.5) / n
            tier = next(name for name, cut in BANDS if pos < cut)
            if cat == "lodging" and tier in ("upper", "luxury") and not rating_ok(it):
                tier = "mid"
            if cat == "flights" and tier == "budget" and "nonstop" in (it.get("name", "") + it.get("details", "")).lower() and n > 3:
                tier = "mid"
            it["tiers"] = [tier]
            changed += 1
            print(f"{cat:11} {tier:7} {unit_cost(it, travelers, nights, days):9,.0f}  {it['provider'][:14]:14} {it['name'][:60]}")
    if a.dry_run:
        print(f"\n{changed} item(s) would be tiered (dry run).")
        return
    with open(a.trip_json, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\n{changed} item(s) tiered; wrote {a.trip_json}")


if __name__ == "__main__":
    main()
