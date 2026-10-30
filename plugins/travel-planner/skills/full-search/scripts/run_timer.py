#!/usr/bin/env python3
"""Start/end timer for a travel-planner run.

  run_timer.py start [--at "2026-10-30 19:05"] [--file .run_timer.json]   # first thing a run does
  run_timer.py end   [--trip trip.json] [--file .run_timer.json]          # last thing, before the email

`start` stores the local start time. `end` stores the end time, prints
"Started 7:05 PM · Finished 9:12 PM · Took 2 h 7 min" and (with --trip) writes it to
trip.run and appends it to trip.notes so the dashboard and email carry it.
"""
import argparse, json, datetime as dt, os

def fmt(t): return t.strftime("%a %b %-d %Y, %-I:%M %p") if os.name != "nt" else t.strftime("%a %b %d %Y, %I:%M %p").replace(" 0", " ")
def dur(s):
    m = int(round(s / 60)); h, m = divmod(m, 60)
    return (f"{h} h {m} min" if h else f"{m} min")

ap = argparse.ArgumentParser()
ap.add_argument("cmd", choices=["start", "end"])
ap.add_argument("--at"); ap.add_argument("--trip"); ap.add_argument("--file", default=".run_timer.json")
a = ap.parse_args()
if a.cmd == "start":
    t = dt.datetime.strptime(a.at, "%Y-%m-%d %H:%M") if a.at else dt.datetime.now()
    json.dump({"started_at": t.isoformat(timespec="seconds")}, open(a.file, "w"))
    print("Started", fmt(t))
else:
    d = json.load(open(a.file)); s = dt.datetime.fromisoformat(d["started_at"]); e = dt.datetime.now()
    run = {"started_at": s.isoformat(timespec="seconds"), "finished_at": e.isoformat(timespec="seconds"),
           "elapsed_min": round((e - s).total_seconds() / 60), "elapsed": dur((e - s).total_seconds())}
    json.dump({**d, **run}, open(a.file, "w"))
    line = f"Started {fmt(s)} · Finished {fmt(e)} · Took {run['elapsed']}"
    print(line)
    if a.trip:
        t = json.load(open(a.trip)); t["trip"]["run"] = run
        t["trip"]["notes"] = (t["trip"].get("notes", "") + " Run time: " + line + ".").strip()
        json.dump(t, open(a.trip, "w"), indent=1, ensure_ascii=False)
