#!/usr/bin/env python3
"""Refresh the city table inside assets/trip-request-form.html from scripts/deeplinks.py.

  python3 build_request_form.py            # rewrites the form in place

Run it after editing CITIES in deeplinks.py so the form's dropdown and the skill agree.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from deeplinks import CITIES  # noqa: E402

FORM = os.path.join(HERE, "..", "assets", "trip-request-form.html")


def main():
    with open(FORM, encoding="utf-8") as f:
        html = f.read()
    table = [{"city": n, "iata": c, "country": k} for n, (c, k) in CITIES.items()]
    payload = json.dumps(table, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    new, n = re.subn(r"/\*CITIES-START\*/.*?/\*CITIES-END\*/", lambda m: "/*CITIES-START*/" + payload + "/*CITIES-END*/", html, flags=re.S)
    if n != 1:
        raise SystemExit("markers /*CITIES-START*/ … /*CITIES-END*/ not found exactly once")
    with open(FORM, "w", encoding="utf-8") as f:
        f.write(new)
    print(f"trip-request-form.html: {len(table)} cities embedded ({os.path.getsize(FORM):,} bytes)")


if __name__ == "__main__":
    main()
