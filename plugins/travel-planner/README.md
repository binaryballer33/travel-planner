# travel-planner

A [Claude Code](https://claude.com/claude-code) skill that plans and prices a whole trip from four things:
**origin, destination, check-in date, check-out date**. Claude researches the trip on the big booking sites,
then hands you a single self-contained HTML dashboard with every option it found, a direct link for each one,
four price tiers you can compare, and a map.

```
/travel-planner:full-search LAX Lisbon 11/10/2026 11/17/2026 2
```

> Claude researches and links. **It never books, pays, signs in, creates accounts or solves CAPTCHAs.** You
> click the links and book yourself.

---

## What you get

**One HTML file** (`<destination>-<yyyy-mm>-trip-dashboard.html`) that opens in any browser, works offline
apart from the map tiles and links, and can be emailed or shared. It contains:

| Section | What's in it |
|---|---|
| **Entry rules banner** | What a US passport holder needs (visa / e-visa, travel authorization, arrival forms, vaccines, passport validity), collapsed to the must-dos with a link to each official page. |
| **Tier tabs** | **Budget, Mid-tier, Upper class, Luxury** and **Custom** (mix any tier). Every line has a checkbox; totals update as you tick. |
| **Flights** | Every flight found on every site, as cards: times, each stop's airport code, city and layover, the flight number and flying time on each leg, aircraft, legroom (judged for a tall traveler), and bags for the economy fare (carry-on ✅/❌, checked ✅/❌ with the fee and kg / lb). Filter by tier, time of day (morning / afternoon / night, sorted by departure) and site. |
| **Lodging** | Stays searched **per tourist neighborhood**, per tier, per site, with ratings, review counts, the stay's total price and a map pin. A fold at the top describes each neighborhood's nightlife and food. |
| **Rental car, airport transfer, activities, daily food spend, SIM & eSIM, insurance** | Priced options with ratings and links, local mobile carriers first. |
| **Buses, trains & metro** | For trips inside one country: intercity departures compared with the cheapest flight, a "no train" note when none runs, getting to the stations, and the city's metro / bus fares. |
| **Popular day trips** | 6–8 trips with a photo, distance, entry fee and every way to get there (bus, car, ride app, tour) with its round-trip cost. |
| **Local food to try** | National classics and city specialties with credited photos, and the best-rated places that serve each dish. |
| **Best restaurants** | 10–12 local and 10–12 international places, filterable by cuisine, with distance from your stay. |
| **Weather** | The forecast for trip days within 16 days, monthly normals for the rest (°F and °C), and the rainy season. |
| **Map** | Each stay with hospitals, pharmacies, groceries, nightlife, nature, transit and more within 5 miles (8 km), plus directions and ride-app links from the airport. |
| **Sidebar** | Entry must-haves, exchange rate, your selection, rainy season, a trip calendar, your Custom total, airport → stay cost, SIM prices. |
| **Master Search List** | The full results page on every site for your route and dates, so you can redo any search by hand. |

Every price shows **"Live price"** (read on the site that day) or **"Estimate"**, with the date it was checked.

Optionally, Claude also **emails you a styled one-page summary** of the dashboard with the dashboard and trip
data attached.

---

## Install

In Claude Code:

```
/plugin marketplace add binaryballer33/shaqs-claude-plugins
/plugin install travel-planner@shaqs-claude-plugins
```

Restart Claude Code if the skill doesn't show up straight away. To update later:

```
/plugin marketplace update shaqs-claude-plugins
```

**Manual install** (no plugin system): copy `plugins/travel-planner/skills/full-search` into
`~/.claude/skills/` (Windows: `%USERPROFILE%\.claude\skills\`).

### Requirements

- **Claude Code** (CLI, desktop app or IDE extension).
- **Python 3.9+** on your PATH (`python3` or `python`). The scripts use only the standard library.
- **Strongly recommended: [Claude in Chrome](https://claude.com/chrome).** Booking sites block most automated
  browsers; your own Chrome passes. Without it Claude falls back to the built-in browser (you may be asked to
  confirm you're human on some sites) and, with no browser at all, to web search, labelling every price an
  estimate.
- Internet access. Weather (Open-Meteo), maps (OpenStreetMap), photos (Wikimedia Commons) and exchange rates
  need no API keys.

---

## Use

```
/travel-planner:full-search <origin> <destination> <check-in> [check-out] [travelers] [one way] [extras]
```

Plain English works too: *"plan a trip from LAX to Lisbon Nov 10–17 2026 for 2"*.

### Examples

```
/travel-planner:full-search LAX Lisbon 11/10/2026 11/17/2026 2
/travel-planner:full-search TPA GIG 01/15/2027 02/15/2027 1 one way
/travel-planner:full-search rio de janeiro to belo horizonte 02/15/2027 03/15/2027 one way
/travel-planner:full-search NYC Tokyo 2027-04-01 2027-04-12 2 adults 1 child business class
/travel-planner:full-search Chicago Mexico City 03/05/2027 3/12/2027 no car, budget $2000, want street food tours
/travel-planner:full-search London Bangkok 12/01/2026 for 2 in GBP
```

### Inputs

| Input | Required | Accepted | Default |
|---|---|---|---|
| Origin | yes | City or airport code, any casing ("lax", "Los Angeles", "rio") | — |
| Destination | yes | City or airport code | — |
| Check-in | yes | `mm/dd/yyyy`, `mm-dd-yyyy` or `yyyy-mm-dd` (month first when ambiguous) | — |
| Check-out | no | Same formats; also the return-flight date | check-in + 7 days |
| Travelers | no | A number after the dates, "2 adults", "the three of us" | 1 adult |
| Trip type | no | "one way" | round trip |

If a place is ambiguous ("rio", "san j", "georgia"), Claude offers the matching cities and airports to pick from.
A check-in date in the past is the only other thing it asks about.

### Options you can add anywhere in the prompt

| Option | Example | Effect |
|---|---|---|
| Cabin | "business", "first", "premium economy" | Flight search cabin (upper / luxury tiers use business anyway) |
| Currency | "in EUR", "GBP" | All prices in that currency (default USD) |
| Children | "2 adults 1 child (6)" | Passenger and room counts |
| Rooms | "2 rooms" | Lodging searches |
| Car | "no car" / "with a car" | Cars are always researched; this ticks or hides them |
| Budget | "budget $2000" | Claude points out which tier fits |
| Must-haves | "beach", "nightlife", "kid friendly", "near the metro" | Shapes neighborhoods, stays and activities |
| Email | "email it to me@example.com" | Sends the summary email at the end |

### The four tiers

| | Flights | Stays | Extras |
|---|---|---|---|
| **Budget** | Cheapest economy, at most a stop or two | Hostels, guesthouses, private rooms | Bus or metro from the airport, local SIM, street-food budget |
| **Mid-tier** | Best-ranked economy, nonstop when one exists | 3★ hotels, whole apartments | Ride app, casual restaurants |
| **Upper class** | Business, or the best economy where no business cabin is sold | 4★ / boutique | Airport taxi, unlimited eSIM, better restaurants |
| **Luxury** | Business or first on a full-service carrier | 5★ / luxury brands | Private transfer, fine dining |

Tiers follow the destination's own prices: a $120 hotel is upper tier in Bangkok and budget in Zurich.

---

## How a run works

Claude searches in seven stages and **updates the dashboard after each one**. The page shows "still
searching" placeholders and reloads itself, so you can start looking at flights while the rest comes in.

1. **Flights:** Google Flights, Kayak, Skyscanner, Booking.com, Expedia, Trip.com and Agoda, economy and
   business, opening each flight's details panel for layovers, flight numbers and bag fees.
2. **Stays:** picks the 3–6 neighborhoods visitors base themselves in, then searches Airbnb, Booking.com,
   Expedia, Hostelworld, Agoda, Trip.com, Kayak, Skyscanner and Google Hotels in each one, per tier. The map's
   nearby places, weather and exchange rate start downloading in the background.
3. **Airport transfer, SIM / eSIM, entry rules.**
4. **Rental cars, then buses, trains & metro** (same-country trips).
5. **Activities, then day trips.**
6. **Local food, then best restaurants**, daily spend, insurance and curated hospitals.
7. **Final build** with the map places, a check in the browser, then the optional email.

Large stages are split across parallel helper agents (one or two sites each). A full run takes a while and
uses a good amount of tokens; the flights-first build arrives early.

Sites that show a robot check are never bypassed: they're recorded as **blocked** in the dashboard's
"Sources checked" table and kept in the Master Search List for you to open yourself.

---

## Files

```
plugins/travel-planner/skills/full-search/
  SKILL.md                     the instructions Claude follows
  assets/dashboard-template.html   the dashboard
  assets/sample-trip.json      a complete example input
  assets/trip-request-form.html    a typeahead form that writes the prompt for you
  references/                  research playbook, provider URL patterns, tier rules, trip JSON schema,
                               entry-rule research, baggage rules, helper briefs
  scripts/
    deeplinks.py               search links for every site from route, dates and guests (--suggest, --areas, --search-links)
    build_dashboard.py         validates the trip JSON and builds the HTML (--partial, --map-pending, --check)
    import_flights.py          merges flight helpers' results
    import_area_stays.py       merges per-neighborhood stay results
    assign_tiers.py            tiers untiered options by price rank
    fetch_weather.py           forecast + monthly normals (Open-Meteo)
    fetch_pois.py              places within 5 miles of each stay (OpenStreetMap)
    fetch_dish_images.py       credited Wikimedia photos for dishes and day trips
    geocode.py                 coordinates for an address
    email_results.py           the styled summary email (.eml) with attachments (--to, --preview)
```

You can run the scripts yourself, for example to rebuild a dashboard after editing `trip.json`:

```
python3 scripts/build_dashboard.py trip.json -o lisbon-2026-11-trip-dashboard.html
python3 scripts/deeplinks.py LAX Lisbon 11/10/2026 11/17/2026 --adults 2
```

---

## Privacy and safety

- Claude **only searches and reads**. It never books, pays, adds to cart, signs in or out, creates accounts,
  enters personal data or solves CAPTCHAs, and it rejects non-essential cookies.
- In your Chrome it opens its own tabs and closes them when done. If you are signed in to a site (for
  example a hotel loyalty program), prices may be member prices; the dashboard says so.
- The email goes only to the address you give. Nothing is sent anywhere else.
- Prices change daily. Each line carries the date it was read and a link: check it before you book.

## Troubleshooting

- **"Python was not found"**: install Python 3 and make sure `python3` or `python` runs in a terminal.
- **A site shows "are you a robot"**: expected on some sites (Skyscanner, Kayak). Use Claude in Chrome, or open
  the link from the Master Search List yourself.
- **Map places say "loading"**: the public OpenStreetMap servers are busy; the page falls back to a live lookup
  when you click a stay.
- **No photo for a dish or day trip**: Wikipedia had no usable image; the card links to an image search instead.

## License

MIT, see [LICENSE](LICENSE).
