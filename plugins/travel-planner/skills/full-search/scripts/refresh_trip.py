#!/usr/bin/env python3
"""Refresh out-of-date prices in an existing trip (flights, stays, rental cars, anything with a checked_at).

  python refresh_trip.py scan  <trip.json> [--days 3] [--categories lodging,flights,car] [--defaults-only]
  python refresh_trip.py apply <trip.json> <updates.json> [--build-to dashboard.html]

scan   Lists every line whose price is older than --days (estimates always count as stale), grouped by
       provider, and writes <trip folder>/refresh/worklist.json. Research helpers work through it one
       provider at a time: open each line's url, read today's price, write updates.json.
       --defaults-only limits it to the lines ticked by default (the ones in the tier totals).
       Warns when check-in has already passed.

apply  Merges updates.json into trip.json (a backup goes to refresh/trip.<date>.bak.json):
         {"checked_at": "2026-11-06",              # optional, default today
          "updates": [{"id": "n-tri-central-0", "price": 24.0,            # new price, same unit as before
                       "rating": 8.9, "reviews": 120, "url": "...", "note": "..."},
                      {"id": "...", "unavailable": true, "note": "sold out for these dates"},
                      {"id": "...", "unreadable": true, "note": "page blocked"}],   # left as it was
          "add": [ {full item, as in trip-schema.md} ]}                # new options found on the way
       For each update: the old price is kept in price_prev / prev_checked_at, price and checked_at are
       replaced, verified becomes true, unavailable lines are unticked and marked, and every change is
       logged in trip.price_history. trip.generated_at becomes the refresh date (first_generated_at keeps
       the original), and the before/after tier totals and biggest movers are printed.
       With --build-to it rebuilds the dashboard when done.

The dashboard shows each tier total from the lines ticked by default, so refreshed prices flow straight
into the totals. Lines the helpers could not read keep their old price and old checked_at, so the page
still tells the truth about how old they are.
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TODAY = dt.date.today().isoformat()


def load(p):
    return json.load(open(p, encoding='utf-8'))


def save(p, d):
    json.dump(d, open(p, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)


def trip_folder(p):
    return os.path.dirname(os.path.abspath(p))


def totals(trip_json):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'build_dashboard.py'), trip_json, '--check'],
                       capture_output=True, text=True, encoding='utf-8')
    out = {}
    for line in r.stdout.splitlines():
        m = re.match(r'^(budget|mid|upper|luxury)\s+\S+\s+(\d[\d,.]*)', line)
        if m:
            out[m.group(1)] = float(m.group(2).replace(',', ''))
    return out


def age_days(it):
    c = it.get('checked_at')
    if not c or not it.get('verified'):
        return 999
    try:
        return (dt.date.today() - dt.date.fromisoformat(str(c)[:10])).days
    except ValueError:
        return 999


def scan(a):
    d = load(a.trip)
    t = d['trip']
    try:
        if dt.date.fromisoformat(t['start_date']) <= dt.date.today():
            print(f"WARNING: check-in {t['start_date']} is today or already past: today's prices will not be for these "
                  f"dates. Ask the user for new dates and run a normal search instead.")
    except Exception:
        pass
    cats = set(a.categories.split(',')) if a.categories else None
    work = {}
    n = 0
    for it in d['items']:
        if cats and it['category'] not in cats:
            continue
        if a.defaults_only and not it.get('default_on'):
            continue
        if it.get('unavailable'):
            continue
        age = age_days(it)
        if age < a.days:
            continue
        n += 1
        work.setdefault(it.get('provider', '?'), []).append({
            'id': it['id'], 'category': it['category'], 'name': it['name'], 'url': it['url'],
            'price': it['price'], 'unit': it['unit'], 'price_note': it.get('price_note'),
            'default_on': bool(it.get('default_on')), 'tiers': it.get('tiers'),
            'checked_at': it.get('checked_at'), 'age_days': None if age == 999 else age,
            'verified': it.get('verified')})
    fol = os.path.join(trip_folder(a.trip), 'refresh')
    os.makedirs(fol, exist_ok=True)
    out = {'scanned': TODAY, 'trip': t.get('title'), 'start_date': t['start_date'], 'end_date': t['end_date'],
           'currency': t.get('currency'), 'travelers': t.get('travelers'), 'count': n,
           'providers': {p: sorted(v, key=lambda x: (not x['default_on'], x['category'])) for p, v in work.items()}}
    save(os.path.join(fol, 'worklist.json'), out)
    print(f'{n} stale line(s) of {len(d["items"])} (older than {a.days} day(s) or estimates) -> {fol}\\worklist.json')
    for p, v in sorted(work.items(), key=lambda kv: -len(kv[1])):
        dflt = sum(1 for x in v if x['default_on'])
        cs = {}
        for x in v:
            cs[x['category']] = cs.get(x['category'], 0) + 1
        print(f'  {p:32s} {len(v):4d} lines ({dflt} ticked by default)  {cs}')


def apply(a):
    d = load(a.trip)
    u = load(a.updates)
    when = u.get('checked_at', TODAY)
    fol = os.path.join(trip_folder(a.trip), 'refresh')
    os.makedirs(fol, exist_ok=True)
    shutil.copy(a.trip, os.path.join(fol, f'trip.{when}.bak.json'))
    before = totals(a.trip)
    byid = {i['id']: i for i in d['items']}
    hist = d['trip'].setdefault('price_history', [])
    moves, gone, unread, missing = [], 0, 0, []
    for up in u.get('updates', []):
        it = byid.get(up['id'])
        if not it:
            missing.append(up['id'])
            continue
        if up.get('unreadable'):
            unread += 1
            continue
        if up.get('unavailable'):
            it['unavailable'] = True
            it['default_on'] = False
            it['details'] = (f"No longer available on {when}" + (f": {up['note']}" if up.get('note') else '')
                             + ('. ' + it['details'] if it.get('details') else ''))
            hist.append({'date': when, 'id': it['id'], 'name': it['name'], 'old': it['price'], 'new': None})
            gone += 1
            continue
        old = it['price']
        new = float(up['price'])
        if new != old:
            it['price_prev'] = old
            it['prev_checked_at'] = it.get('checked_at')
            moves.append((new - old, it['name'], it['provider'], old, new, bool(it.get('default_on'))))
            hist.append({'date': when, 'id': it['id'], 'name': it['name'], 'old': old, 'new': new})
        it['price'] = new
        it['verified'] = True
        it['checked_at'] = when
        it.pop('source', None)
        for k in ('rating', 'reviews', 'rating_scale', 'url', 'price_note'):
            if up.get(k) is not None:
                it[k] = up[k]
        if up.get('note'):
            it['details'] = (it.get('details') or '') + f' Refreshed {when}: {up["note"]}'
    added = 0
    for new_it in u.get('add', []):
        if new_it['id'] not in byid:
            d['items'].append(new_it)
            added += 1
    t = d['trip']
    t.setdefault('first_generated_at', t.get('generated_at'))
    t['generated_at'] = when
    t['last_refresh'] = when
    t['notes'] = (t.get('notes') or '') + f' Prices refreshed {when}: {len(u.get("updates", [])) - unread - len(missing)} line(s) re-read, {unread} could not be read and keep their old date, {gone} no longer available.'
    save(a.trip, d)
    after = totals(a.trip)
    print(f'applied {len(u.get("updates", []))} update(s): {len(moves)} price change(s), {gone} unavailable, '
          f'{unread} unreadable (unchanged), {added} added, {len(missing)} unknown id(s) {missing[:5] if missing else ""}')
    print('tier totals  before -> after')
    for k in ('budget', 'mid', 'upper', 'luxury'):
        if k in before or k in after:
            b, c = before.get(k), after.get(k)
            print(f'  {k:8s} {b} -> {c}' + (f'  ({c - b:+.0f})' if b is not None and c is not None else ''))
    for delta, name, prov, old, new, dflt in sorted(moves, key=lambda m: -abs(m[0]))[:8]:
        print(f'  {"*" if dflt else " "} {delta:+8.2f}  {name[:46]:46s} {prov:16s} {old} -> {new}')
    print('(* = ticked by default, so it moves a tier total)')
    if a.build_to:
        r = subprocess.run([sys.executable, os.path.join(HERE, 'build_dashboard.py'), a.trip, '-o', a.build_to],
                           capture_output=True, text=True, encoding='utf-8')
        print((r.stdout.strip().splitlines() or [''])[-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('scan'); s.add_argument('trip'); s.add_argument('--days', type=int, default=3)
    s.add_argument('--categories'); s.add_argument('--defaults-only', action='store_true'); s.set_defaults(fn=scan)
    p = sub.add_parser('apply'); p.add_argument('trip'); p.add_argument('updates'); p.add_argument('--build-to')
    p.set_defaults(fn=apply)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
