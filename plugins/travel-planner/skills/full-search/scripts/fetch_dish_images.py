#!/usr/bin/env python3
"""Give every local dish a photo (Wikimedia Commons) and a Google Images link, in place.

  python3 fetch_dish_images.py trip.json                  # dishes without an image
  python3 fetch_dish_images.py trip.json --force          # redo every dish
  python3 fetch_dish_images.py trip.json --set baodu="Bao du" --set chao_gan=File:Chao_gan.jpg

Why Wikimedia Commons rather than Google Images: Commons photos are freely licensed (the page can
show them with a credit), their URLs are stable, and the Wikipedia article for a dish leads with a
photo of the dish itself. Google Images thumbnails are other sites' copyrighted photos behind
short-lived URLs, so the dashboard links to a Google Images search ("More photos") instead of
embedding one.

How each dish is matched, in order:
  1. dish["wiki"]: an English Wikipedia article title ("Peking duck") or a Commons file ("File:…").
  2. dish["source_url"] when it is a Wikipedia article.
  3. a Wikipedia search for the dish's short name (the part before " (") plus "dish"/"food",
     keeping the first article whose title is the dish's name (or contained in it) and whose
     summary reads like food.
  4. a Commons file search for the short name, keeping a file whose name carries the dish name and
     reads like food. This is the weakest match: always look at these.
The lead image is used only when it lives on Commons (en.wikipedia "non-free" images are skipped).
Every match is printed: open the thumbnails (or the built page) and fix a wrong one with --set.

Writes on each dish:
  image       {thumb, full, page, credit, license, source: "Wikimedia Commons", via, checked_at}
  photos_url  a Google Images search for the dish in this country
"""
import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

UA = {"User-Agent": "travel-planner-skill/1.0 (personal trip dashboard; dish photos)"}
FOODY = re.compile(r"dish|food|cuisine|noodle|soup|dumpling|bun|bread|pastry|snack|dessert|sweet|stew|meat|pork|beef|chicken|duck|mutton|lamb|fish|rice|tofu|curry|sauce|salad|hot ?pot|drink|beverage|tea|confection|street food|fried|grilled|roast", re.I)


_last = [0.0]


def get(url, tries=5):
    """GET JSON, paced to ~1 request a second, backing off on 429 (Wikimedia rate-limits bursts)."""
    for k in range(tries):
        wait = 1.0 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and k < tries - 1:
                time.sleep(int(e.headers.get("Retry-After") or 0) or 5 * 2 ** k)
                continue
            raise


def squash(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def same_dish(title, name):
    """Search hits must be the dish itself: 'Jianbing' for 'Jianbing Guozi', not 'Duck as food' for 'Peking Roast Duck'."""
    t, n = squash(title), squash(short(name))
    return bool(t) and (t in n or n in t)


def short(name):
    return str(name).split(" (")[0].strip()


def strip_tags(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def commons_info(filename, width=480):
    """Thumb/full/page/credit/license for a Commons file name (with or without 'File:')."""
    fn = filename if filename.startswith("File:") else "File:" + filename
    q = urllib.parse.urlencode({"action": "query", "titles": fn, "prop": "imageinfo", "iiprop": "url|extmetadata|mime",
                                "iiurlwidth": width, "format": "json", "formatversion": 2})
    pages = get("https://commons.wikimedia.org/w/api.php?" + q).get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing") or not pages[0].get("imageinfo"):
        return None
    ii = pages[0]["imageinfo"][0]
    if not str(ii.get("mime", "")).startswith("image/") or ii.get("mime") == "image/svg+xml":
        return None
    md = ii.get("extmetadata", {})
    credit = strip_tags(md.get("Artist", {}).get("value")) or strip_tags(md.get("Credit", {}).get("value"))
    return {"thumb": ii.get("thumburl") or ii.get("url"), "full": ii.get("url"), "page": ii.get("descriptionurl"),
            "credit": re.sub(r"\s+", " ", credit)[:120] or "Wikimedia Commons contributor",
            "license": strip_tags(md.get("LicenseShortName", {}).get("value")) or None, "source": "Wikimedia Commons"}


def from_article(title):
    """Lead image of an English Wikipedia article, if it is a Commons photo."""
    try:
        s = get("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title.replace(" ", "_")))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        raise
    img = (s.get("originalimage") or s.get("thumbnail") or {}).get("source", "").split("?")[0]  # drop ?utm_… tracking
    if "/wikipedia/commons/" not in img:
        return None, s
    fn = urllib.parse.unquote(img.split("/")[-1])
    if re.match(r"^\d+px-", fn):  # a thumbnail path: the real name is the folder before it
        fn = urllib.parse.unquote(img.split("/")[-2])
    info = commons_info(fn)
    if info:
        info["via"] = "Wikipedia: " + s.get("title", title)
    return info, s


def search_article(q, name):
    p = urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": q, "srlimit": 5, "format": "json"})
    for hit in get("https://en.wikipedia.org/w/api.php?" + p).get("query", {}).get("search", []):
        if not same_dish(hit["title"], name):
            continue
        info, s = from_article(hit["title"])
        text = " ".join([(s or {}).get("description", ""), (s or {}).get("extract", "")[:300]])
        if info and FOODY.search(text):
            return info
    return None


def search_commons(q):
    p = urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": q + " food filetype:bitmap", "srnamespace": 6,
                                "srlimit": 10, "format": "json"})
    for hit in get("https://commons.wikimedia.org/w/api.php?" + p).get("query", {}).get("search", []):
        # the file name must carry the dish name ("Nantianmen, Baodu Zhai" is a building; skip names without food words)
        if squash(q) not in squash(hit["title"]) or not FOODY.search(hit["title"] + " " + hit.get("snippet", "")):
            continue
        info = commons_info(hit["title"])
        if info:
            info["via"] = "Commons search: " + q
            return info
    return None


def site_photo(url):
    """A restaurant's own share image (og:image / twitter:image) from its website: the photo the owner
    publishes for link previews. Returns (image_url, page_url) or (None, None)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (travel-planner dashboard; link preview)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        html = r.read(600000).decode("utf-8", "replace")
        final = r.geturl()
    for prop in ("og:image", "og:image:url", "twitter:image", "twitter:image:src"):
        m = (re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']+)' % re.escape(prop), html, re.I)
             or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']%s["\']' % re.escape(prop), html, re.I))
        if m and not re.search(r"logo|icon|favicon", m.group(1), re.I):
            return urllib.parse.urljoin(final, m.group(1).strip()), final
    # no usable share image: the first large photo on the homepage (not a logo, icon or SVG)
    for m in re.finditer(r'<img[^>]+?(?:data-src|src)=["\']([^"\']+\.(?:jpe?g|webp|png)(?:\?[^"\']*)?)["\'][^>]*>', html, re.I):
        tag, src = m.group(0), m.group(1)
        if re.search(r"logo|icon|sprite|favicon|avatar|badge|selo|whatsapp|instagram|facebook|ifood|tripadvisor"
                     r"|dummy|placeholder|popup|premi|award|team|marca|pattern", tag, re.I):
            continue
        w = re.search(r'width=["\']?(\d+)', tag)
        if w and int(w.group(1)) < 300:
            continue
        return urllib.parse.urljoin(final, src.strip()), final
    return None, None


def full_size(url):
    """Wix pages embed a tiny blurred placeholder (/v1/fill/...,blur_2/...); the original sits before /v1/."""
    return url.split("/v1/")[0] if "wixstatic.com/media/" in url else url


def restaurant_photos(data, force=False):
    """restaurants.restaurants[]: a photo from each place's own website (field `website`, or `og_image` already
    read in the browser). Logo-only images (og_image_kind == "logo only") are skipped."""
    rs = (data.get("restaurants") or {}).get("restaurants") or []
    ok = 0
    for r in rs:
        if r.get("photo") is False:   # looked at and rejected (logo, award graphic, stock photo): keep the icon
            r.pop("image", None)
            continue
        if r.get("image") and not force:
            ok += 1
            continue
        img, page = (r.get("og_image"), r.get("website")) if r.get("og_image") else (None, None)
        if r.get("og_image_kind") in ("logo only", "none"):
            img = None
        if not img and r.get("website"):
            try:
                img, page = site_photo(r["website"])
            except Exception as e:
                print(f"  {r.get('id')}: website fetch failed ({e})", file=sys.stderr)
        if img:
            img = full_size(img)
            r["image"] = {"thumb": img, "full": img, "page": page or r.get("website"), "credit": "restaurant's website",
                          "source": "Restaurant website", "via": "og:image", "checked_at": date.today().isoformat()}
            ok += 1
            print(f"  {r['id']:<28} {img[:90]}")
        else:
            print(f"  {r['id']:<28} no site photo (set restaurants[].website, or leave it: the row shows an icon)")
    return ok, len(rs)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip_json")
    ap.add_argument("--force", action="store_true", help="redo dishes that already have an image")
    ap.add_argument("--set", action="append", default=[], metavar="ID=TITLE",
                    help='override a match: a Wikipedia title ("Instant-boiled mutton") or a Commons file ("File:X.jpg")')
    a = ap.parse_args()
    with open(a.trip_json, encoding="utf-8") as f:
        data = json.load(f)
    lf = data.get("local_food") or {}
    dishes = lf.get("dishes") or []
    trips = data.get("day_trips") or []  # day-trip tiles get a photo the same way
    if not dishes and not trips and not (data.get("restaurants") or {}).get("restaurants"):
        sys.exit("No local_food.dishes, day_trips or restaurants in " + a.trip_json)
    overrides = dict(x.split("=", 1) for x in a.set)
    t = data.get("trip", {})
    country = (t.get("destination") or {}).get("country", "")
    today = date.today().isoformat()
    n_ok = 0
    for d, kind in [(x, "dish") for x in dishes] + [(x, "trip") for x in trips]:
        if d.get("id") in overrides:
            d["wiki"] = overrides[d["id"]]
        q = f"{short(d['name'])} {country} food" if kind == "dish" else f"{d['name']} {d.get('place', '')} {country}"
        d["photos_url"] = "https://www.google.com/search?tbm=isch&q=" + urllib.parse.quote(" ".join(q.split()))
        if d.get("image") and not a.force and d.get("id") not in overrides:
            n_ok += 1
            continue
        info = None
        try:
            w = d.get("wiki")
            if w and w.startswith("File:"):
                info = commons_info(w)
                if info:
                    info["via"] = "set by hand"
            elif w:
                info, _ = from_article(w)
            if not info and "wikipedia.org/wiki/" in str(d.get("source_url", "")):
                info, _ = from_article(urllib.parse.unquote(d["source_url"].split("/wiki/")[1]))
            if not info and kind == "trip":
                info = search_article(d["name"], d["name"]) or search_article(f"{d['name']} {d.get('place', '')}".strip(), d["name"])
            if not info and kind == "dish":
                info = search_article(f"{short(d['name'])} dish", d["name"]) or search_article(f"{short(d['name'])} {country} food", d["name"])
            if not info:
                info = search_commons(short(d["name"]))
        except Exception as e:  # keep going: one failed dish should not stop the rest
            print(f"  {d.get('id')}: lookup failed ({e})", file=sys.stderr)
        if info:
            info["checked_at"] = today
            d["image"] = info
            n_ok += 1
            print(f"  {d['id']:<20} {info['via'][:48]:<48} {info['license'] or '?':<14} {info['page']}")
        else:
            d.pop("image", None)
            print(f"  {d['id']:<20} NO PHOTO FOUND: set dish.wiki or --set {d['id']}=\"Article title\" (the page keeps a Google Images link)")
    r_ok, r_n = restaurant_photos(data, a.force)
    with open(a.trip_json, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"{r_ok} of {r_n} restaurants have a photo from their own website.")
    print(f"\n{n_ok} of {len(dishes) + len(trips)} dishes and day trips have a photo; wrote {a.trip_json}. Check each match (the 'via' column) before sending.")


if __name__ == "__main__":
    main()
