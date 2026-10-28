# travel-planner

A [Claude Code](https://claude.com/claude-code) plugin that plans and prices a whole trip from four things:
**origin, destination, check-in date, check-out date**. Claude researches the trip on the big booking sites,
then hands you one self-contained HTML dashboard with every option it found, a direct link for each one, four
price tiers you can compare, and a map.

```
/travel-planner:travel-planner LAX Lisbon 11/10/2026 11/17/2026 2
```

Plain English works too: *"plan a trip from LAX to Lisbon Nov 10–17 2026 for 2"*.

> Claude researches and links. **It never books, pays, signs in, creates accounts or solves CAPTCHAs.** You
> click the links and book yourself.

## What you get

One HTML file (`<destination>-<yyyy-mm>-trip-dashboard.html`) that opens in any browser and can be emailed or
shared. It contains:

- **Entry rules**: what a US passport holder needs (visa, travel authorization, arrival forms, vaccines),
  with a link to each official page.
- **Tier tabs**: Budget, Mid-tier, Upper class, Luxury and Custom. Every line has a checkbox and the totals
  update as you tick.
- **Flights**: every flight found, with times, stops, layovers, aircraft, legroom and bag fees for the
  economy fare. Filter by tier, time of day and site.
- **Lodging**: stays searched per tourist neighborhood, with ratings, review counts, the stay's total price
  and a map pin.
- **Rental car, airport transfer, activities, daily food, SIM and eSIM, insurance**: priced options with
  ratings and links.
- **Buses, trains and metro, day trips, local food, restaurants, weather**: for trips inside one country
  and for planning each day.
- **Map**: each stay with hospitals, pharmacies, groceries, nightlife, nature and transit within 5 miles.
- **Master Search List**: the full results page on every site for your route and dates, so you can redo any
  search by hand.

Every price shows **"Live price"** (read on the site that day) or **"Estimate"**, with the date it was checked.

## Install

```
claude plugin marketplace add binaryballer33/travel-planner
claude plugin install travel-planner@travel-planner
```

Restart Claude Code if the skill doesn't show up straight away. To update later:

```
claude plugin marketplace update travel-planner
claude plugin update travel-planner@travel-planner
```

## Requirements

- Claude Code (CLI, desktop app or IDE extension).
- Python 3.9 or newer on your PATH (`python3` or `python`). The bundled scripts use only the standard library.
- Strongly recommended: [Claude in Chrome](https://claude.com/chrome). Booking sites block most automated
  browsers, and your own Chrome passes. Without it Claude falls back to the built-in browser and then to web
  search, labelling every price an estimate.

## What the plugin runs, fetches and sends

Nothing here runs on its own. The skill only starts when you ask for a trip, and it has no hooks, no MCP
servers and no background processes.

- **Booking sites**: Claude opens the search pages of Airbnb, Booking.com, Expedia, Kayak, Skyscanner,
  Trip.com, Agoda, Hostelworld, Google Flights and Google Hotels in your browser, with your route, dates and
  traveler count in the page address. It reads prices and builds direct links. It never logs in or pays.
- **Python scripts** (in `skills/travel-planner/scripts/`) build the dashboard and read public data:
  - `fetch_weather.py` calls Open-Meteo with the destination's coordinates and your dates.
  - `fetch_pois.py` calls public Overpass (OpenStreetMap) servers with each stay's coordinates.
  - `geocode.py` calls OpenStreetMap Nominatim with place names.
  - `fetch_dish_images.py` calls Wikipedia and Wikimedia Commons with dish names, and reads the public share
    image of a restaurant's own website.
  - `build_dashboard.py`, `deeplinks.py`, `assign_tiers.py`, `import_flights.py`, `import_area_stays.py` and
    `build_request_form.py` only read and write local files.
- **Email (optional)**: if you give an address, `email_results.py` writes a styled summary as a local `.eml`
  file. Claude sends it only to the address you gave, through a mail connector you have already set up
  (Gmail or Google Workspace, Resend) or your own signed-in Gmail in Chrome. The plugin stores no
  credentials and has no mail account of its own.
- **The dashboard page** is a local HTML file. When you open it, your browser loads the map library from
  cdnjs.cloudflare.com, map tiles from OpenStreetMap and the photos from the sites that host them, and a
  stay without saved nearby places is looked up live from OpenStreetMap (Overpass, Nominatim) using that
  stay's coordinates.
- **Files**: dashboards and trip data are written to the folder you run Claude Code in. Nothing is uploaded
  anywhere else.

No API keys are needed.

## Privacy

The plugin has no server, no tracking and no analytics, and the author receives none of your data. The full
statement is in [PRIVACY.md](PRIVACY.md).

## Layout

```
.claude-plugin/plugin.json     plugin manifest
skills/travel-planner/
  SKILL.md                     the skill: inputs, research stages, dashboard and email steps
  scripts/                     Python helpers (standard library only)
  references/                  per-site URL patterns, tier rules, trip JSON schema, research playbook
  assets/                      dashboard template, request form, sample trip JSON
PRIVACY.md                     what the plugin handles and where it goes
```

## License

MIT. See [LICENSE](LICENSE).
