---
name: travel-planner
description: >
  Plan and price a whole trip from origin, destination and dates (mm/dd/yyyy or yyyy-mm-dd; cities or
  airport codes). Defaults: 1 traveler, 1-week stay, round trip. Searches Airbnb, Booking.com, Expedia,
  Kayak, Skyscanner, Trip.com, Agoda, Hostelworld, Google Flights and Google Hotels for flights (5 per
  tier per time of day), stays by neighborhood, cars, activities, food, SIMs and transfers, with DIRECT
  links, then builds a self-contained HTML dashboard (Budget / Mid / Upper / Luxury / Custom tabs,
  checkboxes, map) and emails it to the requester. Use it for any trip, vacation, travel budget,
  flights plus hotel, "how much to go to X", or booking links, even without the word "dashboard".
model: sonnet
effort: high
---

# Travel Planner

## Model and effort (required)

This skill runs on **Claude Sonnet at effort high**, and so does every helper it starts. The frontmatter
(`model: sonnet`, `effort: high`) switches the session to Sonnet / high when the skill is invoked; that
switch lasts for the turn, so on every later turn of a run (helper reports, map downloads, the email) keep
working the same way and keep starting helpers as below.

- **Helpers:** start every research helper with the Agent tool's `model: "sonnet"` and `effort: "high"`.
  Never use `haiku` or `fable` for this skill, and do not use `opus` while Sonnet works.
- **Fallback, only when Sonnet is unavailable** (the model is refused or not in the allowed list, or a
  helper fails because Sonnet could not be used): use `opus` with `effort: "high"`. Relaunch a failed helper
  with `model: "opus"`, `effort: "high"`, and say in `trip.notes` which helpers ran on Opus and why.
- **Main session:** if the session is on a model other than Sonnet (or Opus when Sonnet is unavailable) or
  below effort high, say so in one line in the opening message and carry on: the research still runs in
  Sonnet / high helpers. The user can switch the session with `/model sonnet` and effort high.

You are producing two things for the user:

1. **Researched options with direct links.** For each price tier and each cost category, real
   options found on the booking sites, each with the price you saw, the date you saw it, and a link
   that opens *that specific flight / listing / car* with the user's dates and guests pre-filled.
2. **A trip-cost dashboard** (one self-contained HTML file) built from `assets/dashboard-template.html`
   by `scripts/build_dashboard.py`. Tier tabs (Budget, Mid-tier, Upper class, Luxury) plus a
   **Custom** tab that mixes any tier; a summary row (selected total, where the money goes, tier
   comparison) above two-column category cards; vendor tabs inside each category with up to five
   options each; a checkbox on every line; and a map of each stay, or any address or Google Maps
   link the user pastes, with everything useful within a 5-mile radius.

The dashboard is only as good as the research behind it. Most of your time goes into step 2.

## Invocation and arguments

```
/travel-planner <origin> <destination> <check-in> <check-out> [travelers] [one way]
/travel-planner LAX Lisbon 11/10/2026 11/17/2026 2
/travel-planner TPA GIG 01/15/2027 02/15/2027 1 one way
/travel-planner rio de janeiro to belo horizonte 01/15/2027 one way   # 1 traveler, nothing else asked
```

Plain English works the same ("LAX to Lisbon Nov 10–17 2026 for 2"). Casing never matters for
cities or airport codes. Flights are round trip unless the prompt says one way (then the check-in
date is the flight date and lodging still runs check-in to check-out). Optional extras anywhere in
the prompt: cabin (business, first), currency, children, "no car" / "with a car", a budget, must-haves.

## Step 0 — Four inputs, one question, sensible defaults

The skill runs on exactly four things from the user:

1. **Check-in date** — `mm-dd-yyyy`, `mm/dd/yyyy` or `yyyy-mm-dd` (month first when ambiguous)
2. **Check-out date** — same formats; also the return-flight date (default: check-in + 7 days)
3. **Origin** — city or airport code, any casing
4. **Destination** — city or airport code, any casing

**Standing defaults (apply them silently and say so in the opening line):**

- **Travelers: 1** unless the prompt says otherwise ("2 adults", "the three of us", a number after the dates). Do not ask.
- **Check-out missing: check-in + 7 days** (one week).
- **Trip type missing: round trip.** Only "one way" in the prompt makes it one way.
- **Email the result automatically** every time a run finishes (Step 6), without being asked and without
  asking for confirmation, to the address the requester gave. **If no email address is known, ask for one**
  (one short question) and send as soon as they answer; never guess an address.

If origin, destination or check-in is missing, ask for just that one thing. A past check-in date is the
only other thing worth a question (the user has twice chosen the same dates one year later: say that you
assumed it when you do not ask). That is the whole interview: every other input has a default, and more
questions turn a one-line request into a form the user did not ask for.

| Input | Default | Shown as |
|---|---|---|
| Travelers | 1 adult (never asked) | "for 1 traveler" (per-person lines × 1) |
| Rooms | 1 | |
| Cabin | economy; upper/luxury tiers upgrade per `references/tiers.md` | |
| Currency | USD | |
| Rental car | researched for every tier, left **unchecked** | user ticks it if they want one |
| Trip style | general sightseeing | activities chosen accordingly |
| Children | none | |

When the user volunteers more (budget, must-haves, a car, a cabin, children), use it.

**Resolve places the way a dropdown would.** `scripts/deeplinks.py --suggest "<text>"` returns
case-insensitive matches from a table of about 750 cities and their main international airports.
One match → use it and say what you resolved ("Lisbon (LIS)"). Several plausible matches, or a
partial word ("rio", "san j", "georgia") → present them as clickable options with
`AskUserQuestion` (combine with the travelers question so the user answers once). No match → use
the airport code you know, or search "{place} airport IATA", and say which airport you picked. The
bundled `assets/trip-request-form.html` is a real typeahead form (type "rio", pick "Rio de Janeiro
(GIG), Brazil" from the dropdown) that generates the exact prompt; offer it when the user asks for
a form or plans trips often.

A past check-in date or a check-out before check-in are the only other things worth a question;
everything else you assume and state.

Open your reply with one line that states the resolved parameters and the defaults you applied, for
example: "Planning LAX → Lisbon (LIS), Nov 10–17 2026, 7 nights, 2 travelers, USD, economy; say if
any of that should change." Then start researching without waiting for a reply.

## Step 1 — Generate the starting search links

```bash
python3 ~/.claude/skills/travel-planner/scripts/deeplinks.py "Los Angeles" Lisbon 11/10/2026 11/17/2026
# optional: --adults 2 --children 1 --rooms 1 --cabin business --currency EUR --json
```

Pass the four inputs exactly as the user gave them: city names or airport codes, dates in any of the
accepted formats. The script resolves cities to airport codes and prints the normalised trip line.

This prints one results-page link per provider (flights, lodging, cars) with the dates and guests
already in the URL. These are *starting points* for your research, and they are also acceptable
fallback links for the dashboard because they land on the user's exact search, not a homepage.
`references/providers.md` documents every URL pattern and which query parameters each site needs.

## Step 2 — Research every tier (the core of the job)

Read `references/research-playbook.md` before the first search. It covers tool choice, how to read
prices off each site, how to capture the exact listing URL, what to do about anti-bot pages, and how
to label what you found. Read `references/tiers.md` for what counts as budget / mid / upper / luxury
in each category.

Non-negotiables, because they are the whole point of the deliverable:

- **Direct links only.** A link must open the specific flight itinerary, hotel, Airbnb listing,
  hostel or car offer, with dates and guests in the URL. When a site will not give you an
  itinerary-level URL (flights often won't), use the results-page deep link for the exact route and
  dates and say so in the item's `details`. A bare homepage is never acceptable; the build script
  rejects it.
- **Label verified vs. estimate honestly.** `verified: true` means you read that price on that
  provider's page today. Anything else (a price from a search snippet, a typical-price article, your
  own knowledge) is `verified: false` and shows an "Estimate" badge. Never dress an estimate up as a
  live price. Prices move daily, so the badge and the `checked_at` date protect the user.
- **Flights: five per site, per tier, per part of the day.** For every flight site and every tier
  (budget, mid, upper, luxury) list at least **5 morning** (departs 05:00–11:59), **5 afternoon**
  (12:00–17:59) and **5 night** (18:00–04:59) flights: 15 per tier, 60 per site (Google Flights after
  searching should show 5 morning budget, 5 afternoon budget, 5 night budget, 5 morning mid-tier …).
  Read them off the results page (sort by cheapest, then use the site's time-of-day / departure-time
  filter for each band; business searches for upper and luxury). Where a band truly has fewer on a
  route, list what exists and say so in `trip.notes`. Every flight line carries a `flight` object
  (`references/trip-schema.md` § Flight cards) so the dashboard can draw the flight card: airline and
  flight number(s), origin → destination, date and time, connections, each leg's flight time, layover
  time, total time, the site it was found on and a link to the flight, cabin, whether a carry-on and/or
  checked bag is free, one way or round trip, the aircraft type (e.g. Airbus A350-900) and the legroom in
  inches as the site shows it (the card judges it for a 6 ft 1 in traveler: `trip.traveler_height_in`,
  default 73). A missing field shows "Not listed": read the flight's details panel on the site (Google
  Flights and Kayak show aircraft and legroom) rather than leaving it empty. This is a lot of lines: split flight
  sites across helpers (one or two sites each) and have them save JSON after every tier.
  Earlier rule, still true: economy search → budget + mid, business search → upper + luxury.
- **Flights: at least five per site in EVERY tier.** Run two searches on every flight site: economy
  (sorted cheapest) and business / premium (sorted cheapest). From economy, the 5 cheapest distinct
  flights are `budget` and the next 5 are `mid` (put full-service carriers there when the site lists
  them); from business, the 5 cheapest are `upper` and the next 5 are `luxury` (first class when it
  exists). That is at least 20 flights per site, each tiered explicitly, each linking that site's
  results page for its cabin. Where a route truly has fewer business seats, list what the site shows
  and say so in `trip.notes`. The build warns about any site with fewer than 5 in a tier.
- **Tourist neighborhoods, then stays in each one.** Before searching lodging, find the 3–6
  neighborhoods visitors base themselves in for nightlife and food (Wikivoyage district pages, the
  tourism board, Time Out / Lonely Planet "where to stay"): for Rio, Copacabana, Ipanema, Lapa,
  Botafogo. Write them to `neighborhoods` [{id, name, local_name, lat, lng, radius_m, tags, summary,
  nightlife, food, good_to_know, source_url, source_label}]; they render as a "Tourist neighborhoods: nightlife & food" fold at the top of the Lodging card
  (area names always visible, click to expand the details), as outlined areas on the map, and as an
  **Area** filter on the Lodging card.
  **Then search stays in every neighborhood on every lodging site, at least 5 per tier**: 5 budget,
  5 mid, 5 upper and 5 luxury from Hostelworld, 5 of each from Airbnb, from Booking.com, and so on
  (`deeplinks.py --areas "Copacabana,Ipanema,Lapa"` prints each site's search per area). Tag every
  stay with `"neighborhood": "<id>"` and set its `tiers` from the band you searched (tiers.md: hostel
  or private room → budget, 3★ or entire flat → mid, 4★/boutique → upper, 5★/luxury brand →
  luxury); sort each area's results by price and use the site's star filter to reach the upper and
  luxury bands. Where a site has none in a band (Hostelworld sells no 5★; a quiet area has two
  luxury hotels), list what exists and record it in that neighborhood's `gaps`
  ({"Hostelworld": "hostels only: no upper or luxury"}). The build warns about every
  neighborhood × site × tier cell under 5 without a gap note. This is the biggest research job in a
  run (4 areas × 9 sites × 4 tiers × 5 ≈ 700 stays): split it across subagents by site (four
  helpers with two sites each did Beijing's 6 areas × 8 sites, about 800 stays, in 25–40 minutes),
  each briefed from `references/area-stays-brief.md` and saving its JSON after every area; merge
  them with `scripts/import_area_stays.py trip.json stays_*.json`, then tick one stay per tier. Cities with more than 6 tourist areas: keep the 4–5 most popular for
  stays and list the rest on the card with `"search_stays": false`.
- **At least five options per site per category, across all tiers** (cars, activities; lodging
  follows the neighborhood rule above).
  Harvest at least five options from every site that returned results (its results
  page, read once and scrolled, gives them: `references/research-playbook.md` § harvesting), each
  with its own dated link, whatever tier they will land in: a luxury hotel still goes in when you are
  filling the budget tier. Only when a site truly has fewer (Hostelworld lists four Manaus hostels;
  Expedia had one Beijing property for a month) list what exists and say so in `trip.notes`; the
  build warns about every site under five. Every card in the dashboard lists every option from every
  site and tier, cheapest first by default (the user can re-sort), so nothing is hidden. Then tier
  them: hand-pick the lines ticked by default (one flight, one stay per tier) and let
  `scripts/assign_tiers.py` place the rest by price rank. Daily spend and insurance stay one line per
  tier. Give checked-bag lines `"kind": "bags"` so they group under "Checked bags" below the flights.
- **Entry rules for US citizens (the red banner).** Unless the user says otherwise, research what a
  US passport holder needs to enter the destination: visa or e-visa, electronic travel authorization
  (ETA/ETIAS/ESTA-style), arrival card or health form, required and recommended vaccines and
  malaria advice, passport validity. Read the State Department country page and the CDC traveler
  page (in Chrome; both block the fetch tool), plus the official visa portal. Record it in the trip
  JSON `entry` object (`references/entry-requirements.md`); the dashboard turns any `required` item
  into a big red banner at the top of the page.
- **Every vendor, every category it sells.** Airbnb, Booking.com, Expedia, Kayak, Skyscanner,
  Trip.com, Agoda, Hostelworld, Google Flights and Google Hotels each get searched for each category
  they offer (matrix at the top of `references/providers.md`; `deeplinks.py` prints the links vendor
  by vendor). Record each cell in the trip JSON `coverage` object as `searched`, `no-inventory` or
  `blocked`; the dashboard shows that table under "Sources checked", and the build warns about
  missing cells.
- **Checked-bag fees.** For every flight option, find what a checked bag costs on that fare and add
  a companion "Checked bags" line linking the airline's official baggage page
  (`references/baggage.md`). Budget fares usually exclude bags; that line is what makes the budget
  tier honest.
- **Ratings and reviews on everything that has them.** Every stay, rental car and activity line
  carries `rating`, `rating_scale` and `reviews` (count) read off the same results page as its price:
  the site's guest score for stays, the rental company's score for cars (Kayak shows only its own
  deal score: label it with `rating_source`), the activity's stars. If a site shows none, use the
  property's Google Maps rating and set `"rating_source": "Google Maps"` (where Google is thin, as in
  China, Trip.com or Tripadvisor, with the page in `rating_url`). Restaurants, transfers and
  eSIMs get theirs too (Google Maps, the booking site, Trustpilot). When no site rates it, set only
  `rating_source` with the reason; the page shows "No rating · …". The build warns about any
  stay, car, activity or restaurant with neither.
- **Trips that start today.** Same-day searches lose inventory: flight sites drop departed flights
  and car hire refuses a pick-up time that has passed. Search cars from a time after the flight lands,
  and say in `trip.notes` which sites showed little same-day inventory.
- **Overnight flights.** When the cheap flights leave on the check-in evening and land the next
  morning, say so in `trip.notes` (the first booked night goes unused; suggest checking in on the
  arrival day) and start car hire after landing.
- **Airport to the stay.** Price the ride from the arrival airport to each tier's default stay in a
  `transfer` card: Uber's estimate first (uber.com/global/en/price-estimate; it now asks the user to
  log in before it shows prices, so never sign in: check Uber's country list instead and, where
  Uber operates, link its universal ride link and take the fare from the app's public city page or
  a reputable report, labelled an estimate). Then the local ride apps (Bolt publishes route-price
  pages, `bolt.eu/en/cities/{city}/route/…`; Grab does not), the airport's official taxi or limousine
  counter, the airport bus, and pre-booked private transfers (Booking.com Attractions, GetYourGuide,
  Kiwitaxi) with their ratings. Set `trip.arrival_airport` and `trip.uber_available` so the map shows
  directions and ride links for whichever stay is selected.
- **SIM and mobile data: local carriers first.** In every country, list each of the destination's
  own mobile network operators (Thailand: AIS, True/dtac, NT; elsewhere the national carriers) with
  every tourist / visitor package they sell that fits the trip: official price, validity, data,
  calls, physical SIM or eSIM, where to buy at the arrival airport, and the official page. Mark them
  `"kind": "local"` with `"tags": ["Local carrier", "Physical SIM" | "eSIM"]`. Then add 3–4
  international eSIMs (Airalo, Holafly, Nomad, Saily) as `"kind": "esim"` with Trustpilot ratings.
  The sidebar shows the average local-SIM price and the cheapest eSIM.
- **Local food: country classics AND city specialties.** A `local_food` block with two groups of
  dishes: 8–10 national classics (`"scope": "country"`, e.g. pad thai, tom yum, green curry) and 8–10
  dishes popular and specific to the city or region (`"scope": "city"`, e.g. Bangkok boat noodles,
  Phuket moo hong), plus `city_label` / `country_label` ("Bangkok specialties", "Thailand classics").
  Each dish has a page describing it and the best-rated restaurants that serve them (Google Maps rating and review count
  read in Chrome, a link proving the dish is on the menu: Michelin Guide page, the menu, a local
  food guide). Leave out places under about 4.0. It renders as the "Local food to try" card with
  dish filters; it is not part of the totals.
  **Every dish gets a photo.** Give each dish `wiki` (its English Wikipedia article, e.g. "Peking
  duck") and run `scripts/fetch_dish_images.py trip.json`: it takes the article's lead photo from
  Wikimedia Commons (free licence, credited on the page, stable URL) and adds a Google Images search
  link for more photos. Commons rather than Google Images because Google's results are other sites'
  copyrighted photos behind short-lived URLs. Look at every match (the script prints where each came
  from; a contact sheet or the built page shows them) and fix a wrong one with
  `--set id="Article"` or `--set id="File:Name.jpg"`. The card shows a photo strip of every dish and a
  larger photo with its credit for the chosen dish.
- **Buses, trains & metro (same-country trips).** When the origin is in the destination's country (deeplinks.py
  then prints a `ground` link per site: Rome2Rio, Google Maps transit, Busbud, and the national sellers such as ClickBus
  and Buser in Brazil, Amtrak / Greyhound / Wanderu in the US, Trainline / Omio / FlixBus in Europe, 12Go in Southeast
  Asia), research the intercity buses and trains for the travel date: up to 5 departures per site across the day, with
  operator, seat class, terminals, times, duration, price and rating, each linking the dated results page. Say plainly
  when no passenger train runs (`ground.no_train_note` with a source). Add how to reach each bus or train station, and
  the destination's metro / bus / BRT fares and fare card (official operator pages). Write it to `ground`
  (`references/trip-schema.md`); it renders as the "Buses, trains & metro" card before Local food, with a cheapest
  bus vs cheapest flight comparison. Not in the totals.
- **Popular day trips.** List the 6-8 most popular day trips from the destination (tourism board, Wikivoyage
  "Go next", Tripadvisor). For each: distance and drive time, why go, entry fee (official site), and every way to get
  there with a round-trip cost per person: public bus or train (operator timetable and fare), rental car (fuel and
  tolls, labelled an estimate), ride app if sensible, and an organized tour with its rating. Give each a `wiki` title;
  `fetch_dish_images.py` adds a credited photo. Write them to `day_trips`; they render as the "Popular day trips" card
  next to Buses, trains & metro. Not in the totals.
- **Best restaurants.** Beyond the dish-led Local food card, list the 10-12 best-rated local restaurants and 10-12
  international ones across different cuisines (Google Maps 4.5+ with many reviews, nothing under 4.3; candidates from
  respected local lists and awards), each with cuisine, area, coordinates, rating, review count, price level, what it
  is known for, why it is on the list, Google Maps link, the list or award page, and its own `website`
  (the Website link on its Google Maps page). `fetch_dish_images.py` then adds a photo from the website's share
  image (og:image), credited to the restaurant; logo-only images are skipped and the row keeps an icon. Write them to `restaurants`; they
  render as the "Best restaurants" card after Local food, filterable by local / international and cuisine.
- **Rainy season.** `fetch_weather.py` writes all 12 months of rain and a first guess at the rainy
  season; confirm the months with the national weather service or tourism board and overwrite
  `weather.rainy_season` {months, label, peak, source, source_url}, and replace `climate_months` with
  the official monthly table when one exists. When the season starts or ends mid-month, add
  `"start": "05-15"` / `"end": "10-15"` so trip days after the end are not counted as rainy. The weather card opens with a coloured rainy-season
  panel (red: trip inside it, amber: partly or right next to it, green: dry season), a 12-month rain
  chart with the trip months outlined, and the share of trip days likely to rain.
- **Weather.** Run `scripts/fetch_weather.py trip.json` (Open-Meteo, no key). It stores the real
  daily forecast for every trip day inside the 16-day window and the monthly normal for the rest,
  with links to verify. Reanalysis runs cool on coasts: check the national weather service's climate
  table (or timeanddate's climate page) and overwrite the month's `high_f`/`low_f`/`rain_days` with
  it, citing the page. The card sits above the map: "Normally during November in Phuket, the weather
  is 77–89 °F…" plus a tile per day.
- **Dates carry their weekday.** Write dates as "Sun Nov 1 2026" / "Sun 1 – Sat 14 Nov 2026". The
  build adds the weekday to any date in item text that lacks one, the page formats every date it
  prints with the weekday, and the title reads "Phuket, Thailand · Sun 1 – Sat 14 Nov 2026 (13 Nights)".
- **Proof of onward travel (sidebar card).** Fill `trip.onward_ticket` {status, level, note, options,
  tip}: say whether this trip needs one (one-way into a visa-exempt country usually can), and list
  only real, verifiable options: onward-ticket rental services that make a genuine reservation with
  a PNR checkable on the airline's site (OnwardTicket.com, BestOnwardTicket.com — verify each still
  says so), a refundable fare out, or a cheap real ticket out. Never link "dummy" or "fake" ticket
  generators: a fabricated ticket shown to an airline or immigration is misrepresentation and can get
  the traveler refused boarding or entry. If the user asks for one, explain that and offer these.
- **Sidebar essentials, in this order:** entry must-haves; currency (rate plus what $10 and $20 are in
  local money); "Your selection" (collapsed at first: the open tab and its total; expanded, every ticked
  line grouped by category with its price, each name a direct link to that listing); rainy season; calendar of the trip month(s) (stay highlighted, check-in/out ends,
  ✈️ on flight days, today marked); Custom trip total; airport → stay cost together with the ride apps
  used there; SIM & eSIM; proof of onward travel. Set `trip.ride_apps` [{name, url, note}] (the apps locals actually use,
  most used first), `trip.uber_available`, and `trip.fx` {code, rate, checked_at, url} (today's rate
  from open.er-api.com, linked to a converter). The right-hand sidebar shows: rainy season and the %
  of trip days likely to rain, entry must-haves (status "required" items), the Custom trip total,
  airport → stay cost, local SIM average, ride apps (Uber struck through when absent) and the rate.
- **Every line has a link** the user can open to verify or buy: items, restaurants, dishes,
  transfers, SIMs, weather. The build rejects homepages for items and warns when a link is missing.
- **Never book, pay, create accounts, enter personal data or solve a CAPTCHA.** You research and
  link; the user clicks and books.

**Browser: the user's own Chrome first, for every vendor.** The user asked that every run use their
personal Chrome profile through Claude in Chrome (`mcp__claude-in-chrome__*`; load
`anthropic-skills:chrome-browser` first). Their real profile and home IP pass the bot scoring that
the fresh, proxied built-in pane fails: Skyscanner, Booking.com Cars and Trip.com loaded there after
blocking the pane. Call `tabs_context_mcp` (with `createIfEmpty: true`), open your own tabs with
`tabs_create_mcp`, run every vendor's deep link there, and close your tabs at the end. It is their
browser, with their sign-ins: search only, never act on an
account, never sign out, and reject non-essential cookies only.

**Fallback when Chrome does not work** (the extension is not connected, a tool call fails twice, or
a site still shows a robot check / "Security Check — Continue" / a form that never submits there):

1. **The user takes over the pane and confirms they are human.** Open that vendor's same deep link
   in the built-in browser (`mcp__Claude_Browser__*`), call `tabs_context` to make sure the pane is
   displayed (if hidden, ask them to press Cmd+Shift+B / Ctrl+Shift+B), and tell them in one line:
   "You can take over the pane and confirm you're human on {site}; the pane keeps that session cookie
   afterwards." Wait for their reply, then read the results in the pane; later pages on that site go
   through on the same cookie. You never click, hold or solve the check yourself. If the user is not
   around to answer, finish every other vendor first, leave the gated page open in the pane, and ask
   once at the end.
2. **Record `blocked`** with a one-line reason in `trip.notes` only when both fail, and keep the
   site's results link in the Master Search List with a note. Some failures are not bot checks
   (Agoda's flight form never accepts an origin; Trip.com Car Hire finds no cars for some long
   rentals): say what actually happened.

Say which browser read each price in the item `details` ("read in your Chrome", "read in the pane
after you confirmed"). With no browser at all, fall back to `WebFetch`/`WebSearch` and label every
result an estimate. `references/research-playbook.md` §4c has the per-site quirks.

### Search order: seven stages, a dashboard update after each

The user set this order: flights first, stays second, then the rest in the order that is fastest and
lets each stage feed the next. After every stage, rebuild to the same output path and send the file
when it is quick to do (a build takes seconds); `--partial` lists the sections still being searched,
so the open page shows "still searching" placeholders for them and reloads itself every minute
(skipping a reload while the user scrolls or types, and keeping their ticks).

1. **Flights** on every site (economy and business searches), with **each flight's details panel
   opened** (Booking.com "View details", Google Flights row expand, Kayak / Expedia / Trip.com
   details): every leg's flight number, each layover's airport code, city and minutes, aircraft,
   legroom, and the economy / basic fare's carry-on and checked-bag allowance or fee. Add `entry`,
   `search_links` and the `coverage` cells you have, then
   `python3 ~/.claude/skills/travel-planner/scripts/build_dashboard.py trip.json --partial lodging,car,transfer,activities,food,transport,sim,insurance -o <name>-trip-dashboard.html` → send.
2. **Stays**: tourist neighborhoods, then stays per area and tier on every lodging site; tick one
   default stay per tier. Then `python3 ~/.claude/skills/travel-planner/scripts/build_dashboard.py trip.json --partial car,transfer,activities,food,transport,sim,insurance -o …` → send.
   Start the scripts that need no browser in the background now: `fetch_pois.py` for each default
   stay (write to a copy with `-o pois_out.json` so it never rewrites `trip.json` under you; merge
   its `nearby` when it exits), `fetch_weather.py`, and today's exchange rate.
3. **Airport transfer, SIM / eSIM, entry rules**: short official pages; the transfer needs stage 2's
   stays and the flight's arrival airport. `python3 ~/.claude/skills/travel-planner/scripts/build_dashboard.py trip.json --partial car,activities,food,transport,insurance -o …` → send.
4. **Rental cars, then buses, trains & metro** (same-country trips): car pick-up starts after the
   flight lands; the ground card compares buses with stage 1's cheapest flight, and the bus sites
   also show the regional operators stage 5 needs. `python3 ~/.claude/skills/travel-planner/scripts/build_dashboard.py trip.json --partial activities,food,insurance -o …` → send.
5. **Activities, then popular day trips**: the activity sites already list the day tours with prices
   and ratings, and stage 4 gave the bus operators and fares; run `fetch_dish_images.py` for the
   day-trip photos. `python3 ~/.claude/skills/travel-planner/scripts/build_dashboard.py trip.json --partial food,insurance -o …` → send.
6. **Local food, then best restaurants** (one Google Maps session; restaurant distances use stage 2's
   stays), then daily spend, insurance and curated hospitals. Build with `--map-pending` if the map
   places are still downloading, else the normal build → verify → send.
7. **Map places**: when `fetch_pois.py` exits, merge its `nearby`, run the normal build (no flag) to
   the same output path, verify, send the final file (a copy on another device does not refresh),
   then email it (Step 6). If it reports "0 of 1 stays" for some, retry those once; if they still
   fail, ship anyway and say which stays use the live map.

Split each stage's sites across helpers (one or two sites each, saving JSON as they go), each started
with `model: "sonnet"` and `effort: "high"` (Opus / high only if Sonnet is unavailable; see Model and effort). A stage's
helpers can start while you merge the previous stage, as long as they work on different sites
in their own Chrome tabs.

## Step 3 — Build the map layer

The map shows every stay and, when the user clicks one, lists hospitals, pharmacies, grocery,
nightlife, nature, hotels, car rental and transit within 5 miles. Three things make that work:

1. **Coordinates for every stay** (`lat`/`lng`). Get them with
   `python3 scripts/geocode.py "Hotel name or address, City"` (OpenStreetMap geocoder, no key), or
   read them from the listing page. Without coordinates a stay does not appear on the map.
2. **Embedded places.** Once `trip.json` exists with its stays (step 4), and before you build, run
   `python3 scripts/fetch_pois.py trip.json`. It pulls the 5-mile places for each stay from
   OpenStreetMap (Overpass), retrying across mirrors with backoff, and writes them into the JSON
   under `nearby`. Do this at build time because the public Overpass servers are often at capacity
   and a browser gives up after ~30 s; with the snapshot embedded the map answers instantly, and the
   page keeps a live "Refresh" fallback plus Google Maps "nearby" links for ratings. The script can
   take several minutes when servers are busy: run it in the background and ship the
   `--map-pending` build meanwhile (above).
3. **Curated `pois`**: the 2–3 highest-rated international / private hospitals (with their rating,
   where the rating came from, and a link), plus anything else worth pinning (24-hour pharmacy,
   embassy). OpenStreetMap has no ratings, so this is the only way "high-rated" gets onto the map.
   Search the web for "international hospital {city} English-speaking", open the Google Maps page for
   each candidate to read its rating, and record the Google Maps URL as the source.

## Step 4 — Write the trip JSON and build

Write `trip.json` following `references/trip-schema.md` exactly (field names matter: the template
reads them). Include `search_links`, the dashboard's **Master Search List**: for every vendor and
every category you searched, the URL of that site's full results page for the route, dates and
guests, so the user can redo any search by hand later. Start from

```bash
python3 ~/.claude/skills/travel-planner/scripts/deeplinks.py MCO GIG 04/01/2027 05/01/2027 --one-way --search-links
```

then replace every entry that still carries a "fill the form" note with the results URL you copied
during research (read it from `tabs_context` in Chrome), and add a `note` where the user must do
something on arrival ("press Continue on Kayak's check", "type the origin on Agoda"). When you learn
a new site id (Skyscanner `entity_id`, a car-hire place id, a Trip.com city id, a GetYourGuide
location id), add it to the id tables at the top of `deeplinks.py` so the next run gets a real
results link straight away.

Start `scripts/fetch_pois.py trip.json --stay-id <default stay>` in the background for at least each
tier's default stay (step 3), send the `--map-pending` build while it runs, then once it exits:

```bash
python3 ~/.claude/skills/travel-planner/scripts/build_dashboard.py trip.json -o lisbon-2026-11-trip-dashboard.html
```

The script validates the JSON (required fields, dates, tier and category ids, homepage links),
prints a per-tier total so you can quote it, and writes the HTML. Fix every error it reports; treat
its warnings (missing coordinates, many estimates) as a to-do list, not noise.

Save the output in the user's working directory (or a `trips/` folder they name) with a descriptive
name: `<destination>-<yyyy-mm>-trip-dashboard.html`. Keep `trip.json` next to it so the dashboard
can be rebuilt after edits.

## Step 5 — Verify, then deliver

Open the built file and check it before handing it over: the four tier tabs switch, unchecking a line
changes the total, every link opens the right provider page, the Master Search List (a collapsed
panel above the category cards) lists a results link for every vendor × category you searched, every
the page uses 95% of the screen width with the essentials sidebar on the right (above the content and
swipeable on phones), Flights, Lodging and Local food to try each take a full-width row (every card 500px tall), chip rows (tier, site, dish, map places) stay on one
line and scroll sideways with a "+N ›" button, weather tiles carry an icon (sun, cloud, light/heavy
rain, storm, snow, fog), each lists every option from
every site and tier (cheapest first, with the sort menu working; the Morning / Afternoon / Night flight tabs list flights by departure time, and each stop sits on the route line with its airport code, city and layover length) with its rating and review count and
scrolls inside, the Airport transfer, SIM & mobile data and Local food to try cards are filled, the
red entry banner shows what US citizens need, the weather card above the map shows the forecast or
the monthly normal, and the map opens zoomed to about a mile around the tier's ticked stay (main
road names readable) with only that stay's pin plus its hospitals, pharmacies and groceries ("Show
all stays" and the place chips add the rest) and directions / ride links from the airport. Use the built-in browser (serve the folder with `python3 -m http.server` through
`preview_start`; the pane cannot open `file://` paths) or publish it with the `Artifact` tool when
that tool exists (load the `artifact-design` skill first, as that tool requires). Send the file with
`SendUserFile` when available so it reaches the user's other devices.

Your closing message to the user should contain, in this order:

1. The resolved trip parameters (route, dates, travelers, currency).
2. A four-row table: tier → default total → what is included, per person.
3. The count of verified vs. estimated lines and which ones are estimates, so they know what to
   re-check before booking.
4. Where the file is, and one line on how to use it (tabs, checkboxes, Master Search List, map).
5. One line on vendors: all ten searched, or which ones were blocked / had no inventory, and what
   you used instead.

Keep prices out of prose except in the table. Do not paste the item list into chat; the dashboard
is the item list.

## Step 6 — Email the result

Every run ends with this step: when the final build is delivered, email it to the requester without being
asked and without asking for confirmation, at the address they gave (pass it with `--to`); if none is known,
ask for it (one question) and send when they reply (skip the email only if they decline).
**Send only when everything is finished**: every stage researched and merged, the photos fetched, and the map
places embedded for every default stay (stage 7 done, final build without `--partial` or `--map-pending`).
If `fetch_pois.py` is still running, wait for it; if a stay still fails after one retry, do the final build,
say in the email which stay loads its map live, and send. Build the message first:

```bash
python3 ~/.claude/skills/travel-planner/scripts/email_results.py trip.json dashboard.html \
  --summary closing-summary.md --to you@example.com
```

The email body is a **styled one-page summary of the dashboard** that the script builds from the trip JSON (inline styles and tables, so Gmail, Outlook and Apple Mail show it the same): trip header, the red entry banner, a card per tier with its default flight / stay / transfer / SIM and total, where the money goes, the cheapest flight in each part of the day with its stops, stays by neighborhood, weather, currency, airport transfer, SIM, local food photos, caveats and sources checked. Add `--preview email-preview.html` and look at it in the browser before sending. The email you create also contains: a **subject line you write** ("Trip plan: Rio de Janeiro → Belo Horizonte ·
Fri Jan 15 2027 · 1 traveler · from $214"), the **summary** (the same content as your closing message:
parameters, tier table, verified vs estimate, vendors, key notes), and the **attachments** needed to view the
trip on any computer: the self-contained dashboard `.html`, the trip `.json`, and a how-to-open note. Write
`closing-summary.md` first; the script turns it into the plain-text and HTML bodies.

Then send it, using the first of these that works (check what is connected; do not ask the user to set one up
mid-run):

1. A Gmail / Google Workspace connector or the `google-workspace` skill: send (or at least draft) to the address.
2. Resend, if its MCP server is authorized.
3. Gmail in the user's Chrome (Claude in Chrome): compose to the address, paste the subject and summary, attach
   the files with `file_upload`, and press Send only because this standing instruction authorizes mail to the
   user's own address. Never send to anyone else without asking.
   How: open https://mail.google.com/mail/u/0/#inbox?compose=new, type the address in To and the
   subject in Subject, then load the styled body without pasting it as text: write the `<body>` contents of the
   `--preview` file to a fragment file, add a hidden `<input type=file>` to the page with `javascript_tool`, `file_upload`
   the fragment into it, read it with `files[0].text()` and insert it into `div[aria-label="Message Body"]` with
   `document.execCommand('insertHTML', false, trustedTypes.createPolicy('tpMail' + Date.now(), {createHTML: s => s}).createHTML(html))`
   (Gmail enforces Trusted Types; plain insertHTML is refused). Remove the helper input, `file_upload` the dashboard and
   trip JSON into Gmail's own "Attach files" input, check To / subject / attachments, then Send and confirm "Message sent".
   Check the To field on screen (a screenshot of the compose header) before Send: the typed address can fail
   to register when the compose window has not taken focus. Click the Recipients line, type the address,
   press Enter, and confirm the recipient chip appears. After sending, open the copy in Sent to confirm the
   recipient, the styled body and both attachments.
4. None available: run the script with `--open` so the `.eml` opens in the default mail app, and tell the user
   plainly that it was prepared but not sent, with the path.

Say in the closing message whether the email was sent, drafted or only prepared. Never claim it was sent
unless a tool confirmed it.

## Resources

- `references/research-playbook.md` — how to search, read, capture URLs, label, and recover from blocks. Read first.
- `references/providers.md` — URL patterns per provider, parameters to keep, parameters to strip.
- `references/tiers.md` — what each tier means per category, and how to adapt bands to the destination.
- `references/trip-schema.md` — the trip JSON contract the template reads, with a full example.
- `references/entry-requirements.md` — what US citizens need to enter (visa, ETA, arrival card, vaccines) and how to research it for the red banner.
- `references/baggage.md` — how to price checked bags, with the airlines' official baggage pages.
- `scripts/email_results.py` — builds the results email (.eml) with subject, summary and attachments (Step 6).
- `scripts/deeplinks.py` — search links for every provider from route, dates and guests.
- `scripts/geocode.py` — coordinates for an address via OpenStreetMap (polite, 1 request/second).
- `scripts/fetch_pois.py` — embeds the 5-mile places for every stay into the trip JSON (run before building).
- `scripts/import_area_stays.py` — merges the per-neighborhood stay files (helper output) into lodging lines, converting China's GCJ-02 coordinates.
- `references/area-stays-brief.md` — the brief to hand each stays helper (trip, areas, tiers, safety rules, output format).
- `scripts/fetch_dish_images.py` — a credited Wikimedia Commons photo and a Google Images link for every local dish.
- `scripts/fetch_weather.py` — embeds the forecast (inside 16 days) and monthly normals for the trip dates, with verify links.
- `scripts/assign_tiers.py` — tiers untiered items by price rank within their category (quality floors applied).
- `scripts/build_dashboard.py` — validate trip JSON and build the dashboard HTML.
- `assets/dashboard-template.html` — the dashboard; `assets/sample-trip.json` — a complete example input.
- `assets/trip-request-form.html` — typeahead form (cities/airports dropdown, dates, travelers) that writes the prompt.
