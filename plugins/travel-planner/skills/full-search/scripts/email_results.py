#!/usr/bin/env python3
"""Package a finished trip as an email: a styled summary of the dashboard, plus every file needed to view it.

  python3 email_results.py trip.json dashboard.html --to you@example.com [--summary summary.md]
                           [--extra file ...] [--out trip-email.eml] [--preview preview.html] [--open]

Writes a standards-compliant .eml (RFC 822, MIME) with
  * a Subject line ("Trip plan: Rio de Janeiro → Belo Horizonte · Mon Feb 15 2027 · 1 traveler · from $X"),
  * an HTML body that looks like a one-page version of the dashboard: trip header, the red entry banner,
    one card per tier with its default flight / stay / transfer / SIM and total, where the money goes,
    flights by time of day (with each stop's code, city and layover), stays by neighborhood, buses / trains vs
    the cheapest flight, popular day trips with their cheapest way there, the top local and international
    restaurants, weather,
    currency, airport transfer, SIM, local food photos, caveats and the sources checked. Inline styles and
    tables only, so Gmail, Outlook and Apple Mail render it the same;
  * a plain-text part (the --summary file, or the same summary as text),
  * attachments: the dashboard HTML (self-contained: open it in any browser), the trip JSON (to rebuild
    or edit it later), and any --extra files.
Totals use the dashboard's own rules (default-on lines per tier, quantities from units), so they match it.
`--preview` also writes the HTML body to a file so it can be checked in a browser before sending.

It never sends anything by itself (no credentials). SKILL.md Step 6 lists how to send: a Gmail / Google
Workspace connector, Resend, or Gmail in the user's Chrome; failing those, `--open` opens the .eml in the
default mail app and the file path is given to the user.
"""
import argparse
import json
import mimetypes
import re
import os
import subprocess
import sys
from datetime import date
from email.message import EmailMessage
from html import escape

DEFAULT_TO = None  # the requester's address: pass --to
LIMIT = 24 * 1024 * 1024

TIERS = [("budget", "Budget", "#2f8a5b"), ("mid", "Mid-tier", "#2a78d6"), ("upper", "Upper class", "#7b57c2"), ("luxury", "Luxury", "#b07a1e")]
CATS = [("flights", "Flights", "#2a78d6"), ("lodging", "Lodging", "#7b57c2"), ("car", "Rental car", "#c25b57"),
        ("transfer", "Airport transfer", "#d08a2c"), ("activities", "Activities", "#2f8a5b"), ("food", "Food & daily spend", "#c2577f"),
        ("transport", "Local transport", "#4f9aa6"), ("sim", "SIM & data", "#5b6bc2"), ("insurance", "Insurance & fees", "#8a8880"), ("other", "Other", "#a8a59c")]
C = {"bg": "#f5f4f0", "surface": "#fcfcfb", "surface2": "#f0efec", "border": "#e2e0da", "text": "#0b0b0b", "text2": "#52514e",
     "muted": "#8a8880", "accent": "#2a78d6", "soft": "#e4effb", "red": "#b3261e", "redsoft": "#fdecea", "ok": "#1a7a4c"}
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"


# ---- the dashboard's arithmetic ----------------------------------------------------------------
def iso(d):
    d = str(d)
    if "/" in d or (len(d) == 10 and d[2] == "-"):
        m, dd, y = d.replace("/", "-").split("-")
        return date(int(y), int(m), int(dd))
    return date.fromisoformat(d[:10])


def nice_date(d, year=True):
    d = iso(d)
    return d.strftime("%a %b ") + str(d.day) + (d.strftime(" %Y") if year else "")


class Trip:
    def __init__(self, data):
        self.data, self.t = data, data["trip"]
        self.items = data.get("items", [])
        self.trav = int(self.t.get("travelers", 1) or 1)
        self.nights = (iso(self.t["end_date"]) - iso(self.t["start_date"])).days
        self.days = int(self.t.get("days") or self.nights + 1)

    def qty(self, it):
        if it.get("qty") is not None:
            return float(it["qty"])
        return {"per_person": self.trav, "per_night": self.nights, "per_day": self.days, "per_person_per_day": self.trav * self.days,
                "per_person_per_night": self.trav * self.nights}.get(it.get("unit"), 1)

    def line(self, it):
        return float(it.get("price") or 0) * self.qty(it)

    def tiers_of(self, it):
        return it.get("tiers") or ([it["tier"]] if it.get("tier") else [])

    def on(self, tier):
        return [it for it in self.items if tier in self.tiers_of(it) and it.get("default_on", True)]

    def total(self, tier):
        return sum(self.line(it) for it in self.on(tier))

    def by_cat(self, tier):
        out = {}
        for it in self.on(tier):
            out[it["category"]] = out.get(it["category"], 0) + self.line(it)
        return out

    def pick(self, tier, cat, pred=lambda it: True):
        c = [it for it in self.on(tier) if it["category"] == cat and pred(it)]
        return max(c, key=self.line) if c else None


def money(v, cur="USD", cents=False):
    sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(cur, cur + " ")
    return f"{sym}{v:,.2f}" if cents else f"{sym}{round(v):,}"


def period_of(f):
    if f.get("period"):
        return f["period"]
    h = int(str(f.get("depart") or "T00")[11:13] or 0)
    return "morning" if 5 <= h < 12 else "afternoon" if 12 <= h < 18 else "night"


def hm(m):
    return "" if m is None else f"{int(m) // 60}h {int(m) % 60:02d}m"


def clock(t):
    if not t:
        return ""
    h, m = int(str(t)[11:13]), str(t)[14:16]
    return f"{(h + 11) % 12 + 1}:{m} {'AM' if h < 12 else 'PM'}"


def rating10(it):
    r, s = it.get("rating"), it.get("rating_scale") or 10
    return None if r is None else float(r) * 10 / float(s)


# ---- HTML pieces (inline styles only) ----------------------------------------------------------
def a(url, text, color=None, bold=False):
    if not url:
        return escape(text)
    return (f'<a href="{escape(url)}" style="color:{color or C["accent"]};text-decoration:none;'
            f'{"font-weight:600;" if bold else ""}">{escape(text)}</a>')


def brief(text, limit=70):
    """The first phrase of a long note: 'Metropolitan bus (Sabara lines...). Fare...' -> 'Metropolitan bus'."""
    t = re.split(r" \(|\. |; |: ", str(text))[0].strip()
    return t if len(t) <= limit else t[:limit - 1].rstrip() + "…"


def plink(it, text):
    """A price (or name) that opens the exact listing it came from."""
    return a(it.get("url"), text, C["accent"], True)


def card(inner, pad=18, bg=None, border=None):
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;'
            f'background:{bg or C["surface"]};border:1px solid {border or C["border"]};border-radius:14px;margin:0 0 14px">'
            f'<tr><td style="padding:{pad}px">{inner}</td></tr></table>')


def h2(text, sub=""):
    span = f'<span style="font-size:13px;font-weight:400;color:{C["muted"]}"> &nbsp;{escape(sub)}</span>' if sub else ""
    return f'<div style="font-size:17px;font-weight:700;color:{C["text"]};margin:0 0 10px">{escape(text)}{span}</div>'


def pill(text, color, soft=None):
    return (f'<span style="display:inline-block;font-size:11px;font-weight:600;color:{color};background:{soft or C["surface2"]};'
            f'border-radius:999px;padding:2px 8px;margin:0 4px 2px 0;white-space:nowrap">{escape(text)}</span>')


def small(text, color=None):
    return f'<div style="font-size:12px;line-height:1.45;color:{color or C["muted"]}">{text}</div>'


def stops_html(f):
    lays = f.get("layovers") or []
    n = f.get("stops") if f.get("stops") is not None else max(0, len(f.get("legs") or []) - 1)
    if not n:
        return f'<span style="color:{C["ok"]};font-weight:600">Nonstop</span>'
    parts = []
    for i in range(n):
        l = lays[i] if i < len(lays) else {}
        bits = [b for b in (l.get("airport"), l.get("city")) if b]
        parts.append(f'<b>{escape(" ".join(bits) or "Stop")}</b>' + (f' · {hm(l["minutes"])} layover' if l.get("minutes") is not None else ""))
    return f'{n} stop{"s" if n > 1 else ""}: ' + " &rarr; ".join(parts)


def build_html(T, summary_md=None):
    t, d, cur = T.t, T.data, T.t.get("currency", "USD")
    org, dst = t.get("origin", {}), t.get("destination", {})
    route = f'{escape(org.get("city", ""))} ({escape(org.get("iata", ""))}) &rarr; {escape(dst.get("city", ""))} ({escape(dst.get("iata", ""))})'
    one_way = t.get("trip_type") == "one_way"
    html = []

    # header
    html.append(card(
        f'<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:{C["accent"]};font-weight:700">Your trip plan</div>'
        f'<div style="font-size:24px;line-height:1.25;font-weight:800;color:{C["text"]};margin:4px 0 6px">{escape(dst.get("city", ""))}, {escape(dst.get("country", ""))}</div>'
        f'<div style="font-size:15px;color:{C["text2"]}">{route} &nbsp;·&nbsp; {"One-way flight" if one_way else "Round trip"}</div>'
        f'<div style="font-size:15px;color:{C["text2"]}">{nice_date(t["start_date"], False)} – {nice_date(t["end_date"])} &nbsp;·&nbsp; {T.nights} nights &nbsp;·&nbsp; {T.trav} traveler{"s" if T.trav > 1 else ""}</div>'
        + small(f'Prices checked {nice_date(t.get("generated_at", date.today().isoformat()))} · {escape(cur)} · the full interactive dashboard is attached'),
        pad=22, border=C["border"]))

    # entry banner
    ent = d.get("entry") or {}
    req = [i for i in ent.get("items", []) if i.get("status") == "required"]
    if ent.get("headline") or req:
        lis = "".join(f'<li style="margin:4px 0"><b>{escape(i.get("title", ""))}</b>'
                      f'{" · " + a(i["url"], i.get("link_label") or "official page", C["red"], True) if i.get("url") else ""}</li>' for i in req)
        html.append(card(f'<div style="font-size:15px;font-weight:700;color:{C["red"]};margin:0 0 4px">&#9888; Action needed before you fly</div>'
                         f'<div style="font-size:14px;color:{C["text"]}">{escape(ent.get("headline", ""))}</div>'
                         + (f'<ul style="margin:6px 0 0 18px;padding:0;font-size:14px;color:{C["text"]}">{lis}</ul>' if lis else ""),
                         bg=C["redsoft"], border="#f2b8b5"))

    # tier cards (2 x 2)
    def tier_card(tid, label, color):
        tot = T.total(tid)
        rows = []
        fl = T.pick(tid, "flights", lambda it: it.get("flight") and it.get("kind") != "bags")
        if fl:
            f = fl["flight"]
            rows.append(("&#9992;&#65039;", f'{escape(f.get("airline") or fl["name"])} · {clock(f.get("depart"))} &rarr; {clock(f.get("arrive"))}',
                         stops_html(f) + " · " + plink(fl, money(T.line(fl), cur)) + f' on {escape(fl["provider"])}', fl))
        st = T.pick(tid, "lodging")
        if st:
            r = rating10(st)
            rows.append(("&#127976;", escape(st["name"]), (f"{r:.1f}/10" if r else "") + (f' · {st["reviews"]:,} reviews' if isinstance(st.get("reviews"), int) else "")
                         + " · " + plink(st, money(T.line(st), cur)) + f' for {T.nights} nights on {escape(st["provider"])}', st))
        for cat, icon in (("transfer", "&#128661;"), ("sim", "&#128246;"), ("food", "&#127869;&#65039;"), ("insurance", "&#128737;&#65039;")):
            it = T.pick(tid, cat)
            if it:
                rows.append((icon, escape(it["name"]), plink(it, money(T.line(it), cur, cents=T.line(it) < 100)), it))
        body = "".join(
            f'<tr><td valign="top" style="width:22px;padding:5px 0;font-size:14px">{ic}</td>'
            f'<td style="padding:5px 0;font-size:13px;line-height:1.4;color:{C["text"]}">'
            f'<a href="{escape(it.get("url", ""))}" style="color:{C["text"]};text-decoration:none;font-weight:600">{name}</a>'
            f'<div style="font-size:12px;color:{C["muted"]}">{sub}</div></td></tr>' for ic, name, sub, it in rows)
        n_on = len(T.on(tid))
        est = sum(1 for it in T.on(tid) if not it.get("verified"))
        return (f'<td valign="top" width="50%" style="padding:6px;height:1px">'
                f'<table role="presentation" width="100%" height="100%" cellpadding="0" cellspacing="0" style="height:100%;background:{C["surface"]};border:1px solid {C["border"]};border-top:4px solid {color};border-radius:12px">'
                f'<tr><td valign="top" style="padding:14px 14px 10px">'
                f'<div style="font-size:13px;font-weight:700;color:{color};text-transform:uppercase;letter-spacing:.05em">{label}</div>'
                f'<div style="font-size:28px;font-weight:800;color:{C["text"]};line-height:1.15">{money(tot, cur)}</div>'
                f'<div style="font-size:12px;color:{C["muted"]}">{money(tot / T.trav, cur)} per person · {n_on} lines ticked · {est} estimate{"s" if est != 1 else ""}</div>'
                f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid {C["border"]}">{body}</table>'
                f'</td></tr></table></td>')
    cells = [tier_card(*x) for x in TIERS]
    html.append(h2("Four ways to do it", "default picks per tier; tick other options in the dashboard"))
    html.append(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px 8px;width:calc(100% + 12px)">'
                f'<tr>{cells[0]}{cells[1]}</tr><tr>{cells[2]}{cells[3]}</tr></table>')

    # where the money goes
    rows = []
    for tid, label, color in TIERS:
        bc, tot = T.by_cat(tid), T.total(tid) or 1
        segs = "".join(f'<td width="{max(1, round(v * 100 / tot))}%" style="background:{cc};height:14px;font-size:0;line-height:0" title="{escape(cl)}">&nbsp;</td>'
                       for cid, cl, cc in CATS for v in [bc.get(cid, 0)] if v > 0)
        rows.append(f'<tr><td style="width:96px;font-size:13px;font-weight:600;color:{C["text"]};padding:5px 8px 5px 0">{label}</td>'
                    f'<td style="padding:5px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:7px;overflow:hidden"><tr>{segs}</tr></table></td>'
                    f'<td style="width:70px;text-align:right;font-size:13px;font-weight:700;color:{C["text"]};padding-left:8px">{money(T.total(tid), cur)}</td></tr>')
    used = [c for c in CATS if any(T.by_cat(tid).get(c[0]) for tid, _, _ in TIERS)]
    legend = " ".join(f'<span style="white-space:nowrap;font-size:12px;color:{C["text2"]};margin-right:10px">'
                      f'<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:{cc};margin-right:4px"></span>{escape(cl)}</span>' for _, cl, cc in used)
    html.append(card(h2("Where the money goes") + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>'
                     + f'<div style="margin-top:8px">{legend}</div>'))

    # flights by time of day
    fl = [it for it in T.items if it.get("category") == "flights" and it.get("flight") and it.get("kind") != "bags"]
    if fl:
        sites = sorted({it["provider"] for it in fl})
        rows = []
        for key, label in (("morning", "Morning"), ("afternoon", "Afternoon"), ("night", "Night")):
            band = [it for it in fl if period_of(it["flight"]) == key]
            if not band:
                continue
            best = min(band, key=T.line)
            f = best["flight"]
            non = [it for it in band if (it["flight"].get("stops") or 0) == 0]
            best_non = min(non, key=T.line) if non else None
            alt = (f'<div style="font-size:12px;color:{C["muted"]};margin-top:2px">Cheapest nonstop: '
                   f'{a(best_non.get("url"), escape(best_non["flight"].get("airline", "")) + " " + clock(best_non["flight"].get("depart")) + " · " + money(T.line(best_non), cur))}</div>'
                   if best_non and best_non is not best else "")
            rows.append(f'<tr><td valign="top" style="padding:10px 0;border-top:1px solid {C["border"]};width:92px">{pill(label, C["accent"], C["soft"])}'
                        f'<div style="font-size:11px;color:{C["muted"]};margin-top:3px">{len(band)} options</div></td>'
                        f'<td valign="top" style="padding:10px 8px;border-top:1px solid {C["border"]}">'
                        f'<div style="font-size:15px;font-weight:700;color:{C["text"]}">{a(best.get("url"), clock(f.get("depart")) + " → " + clock(f.get("arrive")), C["text"], True)}'
                        f' <span style="font-weight:400;color:{C["text2"]};font-size:13px">{escape(f.get("airline", ""))} · {hm(f.get("total_min"))}</span></div>'
                        f'<div style="font-size:13px;color:{C["text2"]};margin-top:2px">{stops_html(f)}</div>{alt}</td>'
                        f'<td valign="top" style="padding:10px 0;border-top:1px solid {C["border"]};text-align:right;white-space:nowrap">'
                        f'<div style="font-size:18px;font-weight:800">{plink(best, money(T.line(best), cur))}</div>'
                        f'<div style="font-size:12px">{a(best.get("url"), "on " + best["provider"])}</div></td></tr>')
        html.append(card(h2("Flights", f'{len(fl)} options on {len(sites)} sites · cheapest in each part of the day') +
                         f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>'))

    # stays by neighborhood
    stays = [it for it in T.items if it.get("category") == "lodging"]
    nbs = d.get("neighborhoods") or []
    if stays and nbs:
        rows = []
        for nb in nbs:
            ss = [s for s in stays if s.get("neighborhood") == nb["id"]]
            if not ss:
                continue
            good = [s for s in ss if rating10(s) and isinstance(s.get("reviews"), int) and s["reviews"] >= 50] or [s for s in ss if rating10(s)]
            top = max(good, key=lambda s: (rating10(s), s.get("reviews") if isinstance(s.get("reviews"), int) else 0)) if good else None
            srt = sorted(ss, key=T.line)
            lo_it, hi_it = srt[0], srt[int(len(srt) * .9) - 1 if len(srt) > 3 else -1]
            maps = nb.get("maps_url") or "https://www.google.com/maps/search/?api=1&query=" + (nb["name"] + ", " + t["destination"].get("city", "")).replace(" ", "+")
            tags = "".join(pill(x, C["text2"]) for x in (nb.get("tags") or [])[:2])
            rows.append(f'<tr><td valign="top" style="padding:10px 0;border-top:1px solid {C["border"]}">'
                        f'<div style="font-size:15px;font-weight:700">&#128205; {a(maps, nb["name"], C["text"], True)}</div>{tags}'
                        f'<div style="font-size:12px;color:{C["muted"]};margin-top:2px">{escape(nb.get("summary", ""))}</div></td>'
                        f'<td valign="top" style="padding:10px 8px;border-top:1px solid {C["border"]};font-size:13px;color:{C["text2"]}">'
                        f'<b style="color:{C["text"]}">{len(ss)} stays</b><br>{plink(lo_it, money(T.line(lo_it), cur))} – {plink(hi_it, money(T.line(hi_it), cur))}<br><span style="font-size:11px;color:{C["muted"]}">for {T.nights} nights</span></td>'
                        f'<td valign="top" style="padding:10px 0;border-top:1px solid {C["border"]};font-size:13px;width:38%">'
                        + (f'<div style="font-size:11px;color:{C["muted"]}">Best rated</div>{a(top.get("url"), top["name"], C["text"], True)}'
                           f'<div style="font-size:12px;color:{C["muted"]}">{rating10(top):.1f}/10 · {escape(top["provider"])} · {plink(top, money(T.line(top), cur))}</div>' if top else "")
                        + '</td></tr>')
        html.append(card(h2("Where to stay", f'{len(stays)} stays on {len({s["provider"] for s in stays})} sites') +
                         f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>'))

    # buses, trains & metro (same-country trips): the comparison, the 3 cheapest departures, local fares
    g = d.get("ground") or {}
    opts = sorted([o for o in g.get("options") or [] if o.get("price") is not None], key=lambda o: float(o["price"]))
    if opts or g.get("local_transit"):
        icon = {"bus": "&#128652;", "train": "&#128646;", "ferry": "&#9972;&#65039;"}
        fl_ = [it for it in T.items if it.get("category") == "flights" and it.get("flight") and it.get("kind") != "bags"]
        cf = min(fl_, key=lambda it: float(it.get("price") or 1e9)) if fl_ else None
        rows = []
        for o in opts[:3]:
            same_day = str(o.get("arrive", ""))[:10] == str(o.get("depart", ""))[:10]
            rows.append(f'<tr><td valign="top" style="padding:8px 0;border-top:1px solid {C["border"]};width:22px;font-size:15px">{icon.get(o.get("mode"), "&#128652;")}</td>'
                        f'<td valign="top" style="padding:8px 6px;border-top:1px solid {C["border"]}">'
                        f'<div style="font-size:14px;font-weight:700">{a(o.get("url"), clock(o.get("depart")) + " → " + clock(o.get("arrive")) + ("" if same_day else " (+1)"), C["text"], True)}'
                        f' <span style="font-weight:400;font-size:13px;color:{C["text2"]}">{escape(o.get("operator") or o.get("provider", ""))}{" · " + escape(o["class"]) if o.get("class") else ""} · {hm(o.get("duration_min"))}</span></div>'
                        f'<div style="font-size:12px;color:{C["muted"]}">{escape(o.get("from", ""))} &rarr; {escape(o.get("to", ""))}</div></td>'
                        f'<td valign="top" style="padding:8px 0;border-top:1px solid {C["border"]};text-align:right;white-space:nowrap">'
                        f'<div style="font-size:16px;font-weight:800">{plink(o, money(float(o["price"]), cur, True))}</div>'
                        f'<div style="font-size:11px;color:{C["muted"]}">on {escape(o.get("provider", ""))}</div></td></tr>')
        cmp_ = ""
        if opts:
            cmp_ = (f'Cheapest bus {plink(opts[0], money(float(opts[0]["price"]), cur, True))} · {hm(opts[0].get("duration_min"))}'
                    + (f' &nbsp;vs&nbsp; cheapest flight {plink(cf, money(float(cf["price"]), cur, True))} · {hm((cf.get("flight") or {}).get("total_min"))} plus airport rides' if cf else ""))
        lt = g.get("local_transit") or []
        fares = " · ".join(f'{a(x.get("url"), x.get("name", ""))} {money(float(x["fare_usd"]), cur, True)}' for x in lt if x.get("fare_usd") is not None)
        notrain = escape(g["no_train_note"]) if g.get("no_train_note") and not any(o.get("mode") == "train" for o in opts) else ""
        html.append(card(h2("Buses, trains & metro", f'{len(g.get("options") or [])} departures · {escape(t["origin"].get("city", ""))} → {escape(t["destination"].get("city", ""))}') +
                         (f'<div style="font-size:13px;color:{C["text2"]};background:{C["surface2"]};border-radius:10px;padding:8px 10px;margin-bottom:6px">{cmp_}</div>' if cmp_ else "") +
                         (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>' if rows else "") +
                         (f'<div style="font-size:12px;color:{C["muted"]};margin-top:6px">&#128646; {notrain}</div>' if notrain else "") +
                         (f'<div style="font-size:12px;color:{C["text2"]};margin-top:4px">&#128647; In {escape(t["destination"].get("city", ""))}: {fares}</div>' if fares else "")))

    # popular day trips: one row each, closest first, with the cheapest way there and the round-trip cost
    trips = [x for x in d.get("day_trips") or [] if x.get("name")]
    if trips:
        trips = sorted(trips, key=lambda x: x.get("drive_min") or (x.get("distance_km") or 999) * 1.2)
        rows = []
        for x in trips:
            tr = sorted([y for y in x.get("transport") or [] if y.get("cost_usd") is not None], key=lambda y: float(y["cost_usd"]))
            best = tr[0] if tr else None
            entry = float((x.get("entry") or {}).get("price_usd") or 0)
            dist = " · ".join(v for v in [f'{x["distance_km"]} km ({round(x["distance_km"] / 1.609344)} mi)' if x.get("distance_km") else "", (hm(x["drive_min"]) + " by car") if x.get("drive_min") else ""] if v)
            img = (x.get("image") or {}).get("thumb")
            pic = (f'<img src="{escape(img)}" alt="" width="56" height="56" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:8px;border:0">'
                   if img else f'<div style="width:56px;height:56px;border-radius:8px;background:{C["surface2"]};text-align:center;line-height:56px;font-size:22px">&#127966;&#65039;</div>')
            rows.append(f'<tr><td valign="top" style="padding:8px 10px 8px 0;border-top:1px solid {C["border"]};width:56px">{pic}</td>'
                        f'<td valign="top" style="padding:8px 6px 8px 0;border-top:1px solid {C["border"]}">'
                        f'<div style="font-size:14px;font-weight:700">{a(x.get("maps_url"), x["name"], C["text"], True)}</div>'
                        f'<div style="font-size:12px;color:{C["muted"]}">{escape(dist)}</div>'
                        + (f'<div style="font-size:12px;color:{C["text2"]};margin-top:2px">Cheapest: {a(best.get("url"), brief(best.get("how") or best.get("mode", "")))}</div>' if best else "")
                        + f'</td><td valign="top" style="padding:8px 0;border-top:1px solid {C["border"]};text-align:right;white-space:nowrap">'
                        + (f'<div style="font-size:16px;font-weight:800">{plink(best, money(float(best["cost_usd"]) + entry, cur, True))}</div>'
                           f'<div style="font-size:11px;color:{C["muted"]}">round trip{" + entry" if entry else ""}</div>' if best else "")
                        + '</td></tr>')
        html.append(card(h2("Popular day trips", f'{len(trips)} trips from {t["destination"].get("city", "")} · closest first') +
                         f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>'))

    # best restaurants: top 5 local and top 5 international, side by side, equal height
    rs = [x for x in (d.get("restaurants") or {}).get("restaurants") or [] if x.get("name")]
    if rs:
        def top(kind):
            return sorted([x for x in rs if x.get("kind") == kind], key=lambda x: (-(rating10(x) or 0), -(x.get("reviews") or 0) if isinstance(x.get("reviews"), int) else 0))[:5]
        def col(title, lst):
            items_ = "".join(f'<tr><td style="padding:6px 0;border-top:1px solid {C["border"]}">'
                             f'<div style="font-size:13px;font-weight:700">{a(x.get("url"), x["name"], C["text"], True)}</div>'
                             f'<div style="font-size:12px;color:{C["muted"]}">&#9733; {x.get("rating")}'
                             + (f' · {x["reviews"]:,} reviews' if isinstance(x.get("reviews"), int) else "")
                             + f' · {escape(x.get("cuisine", ""))}{" · " + escape(x["area"]) if x.get("area") else ""}</div></td></tr>' for x in lst)
            return (f'<td valign="top" width="50%" style="padding:6px;height:1px"><table role="presentation" width="100%" height="100%" cellpadding="0" cellspacing="0" '
                    f'style="height:100%;background:{C["surface"]};border:1px solid {C["border"]};border-radius:12px"><tr><td valign="top" style="padding:12px 14px">'
                    f'<div style="font-size:13px;font-weight:700;color:{C["text"]};margin-bottom:4px">{title}</div>'
                    f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{items_}</table></td></tr></table></td>')
        html.append(h2("Best restaurants", f'{len(rs)} top-rated places in the dashboard · Google Maps ratings'))
        html.append(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px 8px;width:calc(100% + 12px)"><tr>'
                    f'{col("&#128205; Local", top("local"))}{col("&#127757; International", top("international"))}</tr></table>')

    # good to know: weather, money, getting in, data
    boxes = []
    w = d.get("weather") or {}
    if w.get("normals"):
        nm = " · ".join(f'{escape(n["month"])} {n["low_f"]}–{n["high_f"]} °F ({round((n["low_f"] - 32) * 5 / 9)}–{round((n["high_f"] - 32) * 5 / 9)} °C), ~{n["rain_days"]} rainy days' for n in w["normals"])
        rs = w.get("rainy_season") or {}
        tm = {iso(t["start_date"]).month, iso(t["end_date"]).month}
        inside = bool(set(rs.get("months") or []) & tm)
        wsrc = rs.get("source_url") or (w["normals"][0].get("source_url")) or ((w.get("links") or [{}])[0].get("url"))
        boxes.append(("&#127783;&#65039; Weather", f'{nm}' + (" · " + a(wsrc, "source") if wsrc else "") + f'' + (f'<br><b style="color:{"#a35a00" if inside else C["ok"]}">{"Rainy season" if inside else "Dry season"}</b>'
                                                             f' ({escape(rs.get("label", ""))})' if rs.get("label") else "")))
    fx = t.get("fx") or {}
    if fx.get("rate"):
        boxes.append(("&#128177; Money", f'1 {escape(cur)} = {fx["rate"]:.2f} {escape(fx.get("code", ""))}<br>'
                                         f'$20 ≈ {escape(fx.get("code", ""))} {20 * fx["rate"]:,.0f} · {a(fx.get("url"), "rate source")}'))
    tr = sorted([it for it in T.items if it.get("category") == "transfer"], key=T.line)
    if tr:
        apps = ", ".join(escape(x["name"]) for x in (t.get("ride_apps") or [])[:4])
        boxes.append(("&#128661; Airport to your stay", f'From {plink(tr[0], money(T.line(tr[0]), cur, True))} ({a(tr[0].get("url"), tr[0]["name"])})<br>'
                                                       f'up to {plink(tr[-1], money(T.line(tr[-1]), cur, True))} ({a(tr[-1].get("url"), tr[-1]["name"])})' + (f'<br>Ride apps: {apps}' if apps else "")))
    sims = [it for it in T.items if it.get("category") == "sim"]
    if sims:
        loc = [it for it in sims if it.get("kind") == "local"]
        es = sorted([it for it in sims if it.get("kind") == "esim"], key=T.line)
        txt = []
        if loc:
            cheap = min(loc, key=T.line)
            ops = ", ".join(a(x.get("url"), x.get("operator") or x["provider"]) for x in sorted(loc, key=lambda x: x.get("operator") or x["provider"]))
            txt.append(f'Local SIM about {plink(cheap, money(sum(T.line(x) for x in loc) / len(loc), cur, True))} ({ops})')
        if es:
            txt.append(f'Cheapest eSIM {a(es[0].get("url"), es[0]["name"])} {plink(es[0], money(T.line(es[0]), cur, True))}')
        boxes.append(("&#128246; Phone & data", "<br>".join(txt)))
    if boxes:
        cells = [f'<td valign="top" width="50%" style="padding:6px;height:1px"><table role="presentation" width="100%" height="100%" cellpadding="0" cellspacing="0" '
                 f'style="height:100%;background:{C["surface"]};border:1px solid {C["border"]};border-radius:12px"><tr><td valign="top" style="padding:12px 14px">'
                 f'<div style="font-size:13px;font-weight:700;color:{C["text"]};margin-bottom:4px">{tt}</div>'
                 f'<div style="font-size:13px;line-height:1.5;color:{C["text2"]}">{bb}</div></td></tr></table></td>' for tt, bb in boxes]
        grid = "".join(f'<tr>{"".join(cells[i:i + 2])}{"<td></td>" if len(cells[i:i + 2]) == 1 else ""}</tr>' for i in range(0, len(cells), 2))
        html.append(h2("Good to know"))
        html.append(f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px 8px;width:calc(100% + 12px)">{grid}</table>')

    # local food photos
    lf = d.get("local_food") or {}
    dishes = [x for x in lf.get("dishes", []) if (x.get("image") or {}).get("thumb")]
    if dishes:
        dishes = sorted(dishes, key=lambda x: x.get("scope") != "city")[:6]
        tds = "".join(f'<td valign="top" width="33%" style="padding:5px">'
                      f'<a href="{escape(x.get("source_url") or x["image"].get("page", ""))}" style="text-decoration:none">'
                      f'<img src="{escape(x["image"]["thumb"])}" alt="{escape(x["name"])}" width="190" style="display:block;width:100%;max-width:190px;height:120px;object-fit:cover;border-radius:10px;border:0"></a>'
                      f'<div style="font-size:13px;font-weight:600;margin-top:4px">{a(x.get("source_url") or x["image"].get("page"), x["name"], C["text"], True)}</div>'
                      f'<div style="font-size:10px;color:{C["muted"]}">Photo: {escape(x["image"].get("credit", ""))}, {escape(x["image"].get("license", ""))}</div></td>' for x in dishes)
        cellsf = tds.split('<td valign="top" width="33%"')[1:]
        cellsf = ['<td valign="top" width="33%"' + c for c in cellsf]
        grid = "".join(f'<tr>{"".join(cellsf[i:i + 3])}</tr>' for i in range(0, len(cellsf), 3))
        rest = len(lf.get("restaurants", []))
        html.append(card(h2("Local food to try", f'{len(lf.get("dishes", []))} dishes · {rest} top-rated places in the dashboard') +
                         f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -5px;width:calc(100% + 10px)">{grid}</table>'))

    # before you book + sources
    ver = sum(1 for it in T.items if it.get("verified"))
    notes = escape(t.get("notes", ""))
    cov = d.get("coverage") or {}
    mark = {"searched": ("&#10003;", C["ok"]), "no-inventory": ("–", C["muted"]), "blocked": ("&#10007; blocked", C["red"])}
    covrows = "".join(f'<tr><td style="font-size:12px;color:{C["text"]};padding:3px 8px 3px 0;white-space:nowrap;font-weight:600">{escape(v)}</td>'
                      f'<td style="font-size:12px;color:{C["text2"]};padding:3px 0">'
                      + " &nbsp; ".join(f'{escape(k)} <span style="color:{mark.get(s, ("?", C["muted"]))[1]}">{mark.get(s, (escape(s), C["muted"]))[0]}</span>' for k, s in cats.items())
                      + '</td></tr>' for v, cats in cov.items())
    html.append(card(h2("Before you book") +
                     f'<div style="font-size:13px;color:{C["text2"]};margin-bottom:8px"><b style="color:{C["text"]}">{ver} of {len(T.items)}</b> prices were read live on the booking site; '
                     f'the rest are labelled estimates in the dashboard. Prices move daily: open each link to confirm. Nothing was booked.</div>'
                     + (f'<div style="font-size:12px;line-height:1.55;color:{C["muted"]}">{notes}</div>' if notes else "")
                     + (f'<div style="font-size:13px;font-weight:700;color:{C["text"]};margin:12px 0 4px">Sources checked</div>'
                        f'<table role="presentation" cellpadding="0" cellspacing="0">{covrows}</table>' if covrows else "")))

    if summary_md:
        paras = "".join(f'<p style="margin:0 0 8px">{escape(p).replace(chr(10), "<br>")}</p>' for p in summary_md.split("\n\n") if p.strip())
        html.append(card(h2("Planner's notes") + f'<div style="font-size:13px;color:{C["text2"]}">{paras}</div>'))

    html.append(f'<div style="font-size:12px;line-height:1.55;color:{C["muted"]};padding:4px 6px 20px">'
                f'<b style="color:{C["text2"]}">Open the full dashboard:</b> save the attached <b>.html</b> file and double-click it. It works in any browser: '
                f'tier tabs, a checkbox on every flight, stay, car and activity, the Master Search List and the map. '
                f'The attached <b>.json</b> is the data behind it, for rebuilding or editing the trip later.</div>')

    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<meta name="color-scheme" content="light"><title>{escape(t.get("title", "Trip plan"))}</title></head>'
            f'<body style="margin:0;padding:0;background:{C["bg"]};font-family:{FONT};color:{C["text"]}">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{C["bg"]}"><tr><td align="center" style="padding:20px 12px">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px"><tr><td>{"".join(html)}</td></tr></table>'
            f'</td></tr></table></body></html>')


def build_text(T, summary_md=None):
    t, cur = T.t, T.t.get("currency", "USD")
    lines = [t.get("title", "Trip plan"),
             f'{t["origin"].get("city")} ({t["origin"].get("iata")}) -> {t["destination"].get("city")} ({t["destination"].get("iata")}), '
             f'{nice_date(t["start_date"])} to {nice_date(t["end_date"])}, {T.nights} nights, {T.trav} traveler(s), {cur}', ""]
    ent = (T.data.get("entry") or {}).get("headline")
    if ent:
        lines += ["ACTION NEEDED: " + ent, ""]
    for tid, label, _ in TIERS:
        lines.append(f"{label:<12} {money(T.total(tid), cur):>10}")
    lines.append("")
    if summary_md:
        lines += [summary_md.strip(), ""]
    lines.append("Open the attached .html dashboard in any browser for every option, link and the map.")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("dashboard")
    ap.add_argument("--to", required=True, help="the requester's email address")
    ap.add_argument("--summary", help="markdown/plain text closing summary; used as the plain-text part and as 'Planner's notes'")
    ap.add_argument("--subject")
    ap.add_argument("--extra", nargs="*", default=[])
    ap.add_argument("--out")
    ap.add_argument("--preview", help="also write the HTML body to this file to check it in a browser")
    ap.add_argument("--open", action="store_true", help="open the .eml in the default mail app")
    a_ = ap.parse_args()

    data = json.load(open(a_.trip_json, encoding="utf-8-sig"))
    T = Trip(data)
    t = T.t
    cur = t.get("currency", "USD")
    low = min(T.total(tid) for tid, _, _ in TIERS if T.on(tid)) if any(T.on(tid) for tid, _, _ in TIERS) else 0
    subject = a_.subject or (f'Trip plan: {t["origin"].get("city")} → {t["destination"].get("city")} · {nice_date(t["start_date"])} · '
                             f'{T.trav} traveler{"s" if T.trav != 1 else ""}' + (f" · from {money(low, cur)}" if low else ""))
    summary = open(a_.summary, encoding="utf-8-sig").read() if a_.summary else None
    body_html = build_html(T, summary)

    msg = EmailMessage()
    msg["To"] = a_.to
    msg["Subject"] = subject
    msg.set_content(build_text(T, summary))
    msg.add_alternative(body_html, subtype="html")
    if a_.preview:
        open(a_.preview, "w", encoding="utf-8").write(body_html)
        print(f"preview: {a_.preview}")

    files = [(a_.dashboard, True), (a_.trip_json, True)] + [(f, False) for f in a_.extra]
    size = 0
    for path, must in files:
        b = open(path, "rb").read()
        if not must and size + len(b) > LIMIT:
            print(f"skipped (over 24 MB total): {path}", file=sys.stderr)
            continue
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        main_, sub = ctype.split("/", 1)
        msg.add_attachment(b, maintype=main_, subtype=sub, filename=os.path.basename(path))
        size += len(b)
        print(f"attached {os.path.basename(path)} ({len(b) / 1024:.0f} KB)")
    if size > LIMIT:
        print("WARNING: attachments exceed Gmail's 25 MB limit; share the dashboard another way.", file=sys.stderr)
    out = a_.out or os.path.splitext(a_.dashboard)[0] + "-email.eml"
    open(out, "wb").write(bytes(msg))
    print("tier totals: " + ", ".join(f"{l} {money(T.total(tid), cur)}" for tid, l, _ in TIERS))
    print(f"To: {a_.to}\nSubject: {subject}\nWrote {out}")
    if a_.open:
        if sys.platform == "darwin":
            subprocess.run(["open", out])
        elif sys.platform == "win32":
            os.startfile(out)


if __name__ == "__main__":
    main()
