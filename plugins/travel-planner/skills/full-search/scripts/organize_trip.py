#!/usr/bin/env python3
"""Sort a trip folder's working files into one subfolder per category.

  python3 organize_trip.py <trip folder>             # move files
  python3 organize_trip.py <trip folder> --dry-run   # show the moves only

Stays in stays/, flights in flights/, food in food/, activities (and day trips) in activities/,
buses/trains in transport/, SIM and airport transfer in transfer-sim/, insurance in insurance/,
map places (pois) in map/, weather and entry rules in info/, helper briefs in briefs/, scratch
files, logs and one-off scripts in work/.

Stays at the top level, because the user opens or rebuilds from them:
  trip.json, the *-dashboard.html, the *.eml email, closing-summary.md, email-preview.html,
  and any folder already in the trip folder.

Safe to run again at any time: files already in a subfolder are left alone, nothing is overwritten
(a name clash gets a numeric suffix), unknown files stay where they are. Run it as the last step
before the email, and after any helper finishes (helpers may still write to the top level while
they run: wait for them first).

Scripts read helper files with a recursive glob, e.g. glob.glob('**/stays_*.json', recursive=True).
"""
import argparse, os, re, shutil, sys

KEEP_TOP = [r'^trip\.json$', r'-dashboard\.html$', r'\.eml$', r'^closing-summary\.md$', r'^email-preview\.html$',
            r'^\.run_timer\.json$', r'^trip_base\.json$']
# first match wins; patterns are matched against the lower-cased file name
RULES = [
    ('briefs',       [r'^brief.*\.(md|txt)$', r'-brief\.md$']),
    ('stays',        [r'^stays?[_-]', r'^lodging', r'^neighborhoods?', r'^area[_-]stays']),
    ('flights',      [r'^flights?[_-]', r'^flights\.', r'^bags?[_-]', r'^gf_flights', r'^items_.*flights']),
    ('food',         [r'^local_food', r'^restaurants?', r'^daily_spend', r'^food', r'^dishes', r'^hospitals?\b.*food']),
    ('activities',   [r'^activit', r'^day_trips?', r'^tours?[_-]', r'^things', r'^items_.*(activities|tours)']),
    ('transport',    [r'^ground', r'^transport', r'^buses', r'^trains?', r'^cars?[_-]', r'^car\.']),
    ('transfer-sim', [r'^transfer', r'^sim[_.-]', r'^esim']),
    ('insurance',    [r'^insurance']),
    ('map',          [r'^pois', r'^nearby', r'^overlay', r'^hospitals?', r'^map[_-]']),
    ('info',         [r'^weather', r'^entry', r'^fx', r'^currency']),
    ('work',         [r'\.(py|sh)$', r'^items_', r'^coverage', r'^email-body', r'^trip_work', r'^trip_for_pois', r'\.flag$', r'\.log$', r'^post\.py$', r'^merge\.py$', r'\.tmp$',
                      r'^stays_work', r'^scratch', r'^contact', r'^preview', r'\.(png|jpg|jpeg)$']),
]


def target_for(name):
    low = name.lower()
    if any(re.search(p, low) for p in KEEP_TOP):
        return None
    for folder, pats in RULES:
        if any(re.search(p, low) for p in pats):
            return folder
    return None


def unique(path):
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(f'{base}-{n}{ext}'):
        n += 1
    return f'{base}-{n}{ext}'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    root = os.path.abspath(a.folder)
    if not os.path.isdir(root):
        sys.exit(f'not a folder: {root}')
    moved, left = [], []
    for name in sorted(os.listdir(root)):
        src = os.path.join(root, name)
        if os.path.isdir(src):  # helper work folders, e.g. _helpers_stays_b -> stays/, combined -> work/
            m = re.match(r'^_?helpers?[_-](stays|flights|food|activities|transport|map)', name.lower())
            folder = m.group(1) if m else ('work' if name.lower() in ('combined', 'tmp', 'temp', 'scratch') else None)
            if folder and name != folder:
                moved.append((name + '/', folder))
                if not a.dry_run:
                    os.makedirs(os.path.join(root, folder), exist_ok=True)
                    shutil.move(src, unique(os.path.join(root, folder, name)))
            continue
        folder = target_for(name)
        if not folder:
            left.append(name)
            continue
        dst_dir = os.path.join(root, folder)
        dst = unique(os.path.join(dst_dir, name))
        moved.append((name, folder))
        if not a.dry_run:
            os.makedirs(dst_dir, exist_ok=True)
            shutil.move(src, dst)
    verb = 'would move' if a.dry_run else 'moved'
    for name, folder in moved:
        print(f'  {folder}/{name}')
    print(f'{verb} {len(moved)} file(s); {len(left)} left at the top: {", ".join(left) or "none"}')


if __name__ == '__main__':
    main()
