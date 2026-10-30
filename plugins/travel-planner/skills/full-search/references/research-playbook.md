# Research playbook

How to turn a trip definition into priced, linked options. Read this once per trip before the
first search; it saves you from the three failure modes that make the dashboard useless: links that
open a homepage, estimates presented as live prices, and tiers that are all the same hotel.

## 1. Pick your tools

| Situation | Use | Why |
|---|---|---|
| Claude in Chrome is connected (`mcp__claude-in-chrome__*`) | **the user's Chrome, for every vendor (default)** | the user asked for it; their real profile and IP pass bot scoring that the built-in pane fails |
| Chrome is not connected, fails twice, or a site still gates it | the built-in pane, and the user takes over to confirm they are human (§4c) | the pane keeps that session cookie, so later pages on that site go through |
| No browser at all | `WebSearch` + `WebFetch` | anything you did not read on the provider's page is an estimate |
| No browser at all | `WebSearch` + `WebFetch` | finds listing pages and typical prices, but anything you did not read on the provider's page is an estimate |

Load the `chrome-browser` skill (`anthropic-skills:chrome-browser`) before the first Chrome call, and
the `built-in-browser` skill before falling back to the pane.

The browser is shared with the user. Do not sign in, sign out, accept cookie banners beyond the
"reject non-essential" choice, or enter any personal data. If a site asks you to prove you are human,
stop on that site: never attempt a CAPTCHA or press-and-hold check. Climb the ladder in §4c instead.

## 2. Before the first search: travelers and places

- **Travelers.** If the prompt carries a number (a fifth argument, "2 adults", "for 3 of us"),
  use it. Otherwise ask exactly one question before researching: how many people are traveling.
  Use `AskUserQuestion` when it exists (options 1, 2, 3, 4+ with "Other" for anything else);
  otherwise ask in one line. No answer, "skip", or "whatever" means 1. Nothing else is asked.
- **Places, case-insensitively.** `lax`, `Lax`, `LAX`, `lisbon`, `LISBON` all resolve. Run
  `python3 scripts/deeplinks.py --suggest "<what they typed>"` when the text is partial or could
  mean several places ("rio", "san j", "georgia"). One hit → use it and say what you resolved. Several
  hits → offer them as clickable choices with `AskUserQuestion` (the chat equivalent of a dropdown:
  "Rio de Janeiro, Brazil (GIG)", "Rio Grande, …"), in the same question as travelers when both are
  needed so the user answers once. No hit → use the airport code you know, or search "{place} airport
  IATA", and say which airport you picked.
- The bundled `assets/trip-request-form.html` is a real typeahead form (type "rio" and pick from the
  dropdown) that produces the exact prompt; point the user to it when they ask for a form or do this
  often.

## 3. Work the search in this order

Search **every vendor for every category it sells** (the matrix at the top of `providers.md`;
`deeplinks.py` prints the links vendor by vendor). Some vendors have nothing for a given
destination: note `no-inventory` for that cell and move on. The point is that the user asked for all
of them and can see in the dashboard's "Sources checked" table that each was tried.

1. **Flights first.** They anchor the dates and are the largest swing between tiers. Two searches per
   site (economy and business), 5 flights per tier per site: economy → budget + mid, business → upper + luxury.
2. **Lodging for all four tiers.** This is where the user spends the most time comparing.
3. **Car** (one option per tier, unchecked unless the user wants a car).
4. **Activities** (2–4 per tier; luxury tiers get private versions of the same experiences).
5. **Daily spend and insurance** as sourced estimates.
6. **Curated hospitals and other pins** for the map, then `scripts/fetch_pois.py` in the background
   while you finish the JSON.

Budget roughly 25 page loads for the whole trip. When you run out, ship with labeled estimates for
whatever is left and say which lines to re-check, rather than returning nothing.

## 4. The per-vendor routine (browser)

Two things learned from live runs, before the routine: the browser pane may be geolocated far from
the user (it has shown Philippine pesos and Ho Chi Minh City tours), so put the currency in every URL
that takes one (`currency=`, `selected_currency=`, `curr=`) and check the first results page for the
right city; and Google Flights only answers its query link with `hl=en&gl=us` and the phrasing
"Flights from X to Y on DATE returning DATE". Expect two or three vendors per trip to resist
automation (bot checks, forms that drop the origin, error pages): climb the ladder in §4c, and only
then record them as `blocked` with a one-line reason in `trip.notes`.


```
navigate(search deep link)
computer(action: "wait", duration: 5)          # results stream in after load
get_page_text()                                 # read prices, names, ratings, stops
javascript_tool: collect result links           # see snippet below
pick 1–3 candidates per tier
navigate(candidate link) → wait 4 s → get_page_text()
javascript_tool: location.href                  # the exact URL with dates/guests
deeplinks.py --clean "<that url>"               # strip tracking params
```

Snippet for collecting result links with their visible text (inspection only, nothing on the page
is changed):

```js
Array.from(document.querySelectorAll('a[href]'))
  .filter(a => /\/(hotel|rooms|hosteldetails|flights|cars)\b/.test(a.href) && a.innerText.trim())
  .slice(0, 40)
  .map(a => ({ text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 90), href: a.href }))
```

Pause two or three seconds between navigations and load one page at a time. Hammering a site is
the fastest way to get the "are you a robot" page, which ends your access to that provider for
the session.

What the headline number means on each site is in `providers.md`. Always record which it is:
per night, total for the stay, per person; taxes in or out. The `price_note` field exists so the
user is never surprised at checkout.

## 4b. Harvesting five options per vendor

One results page per vendor per category is enough for five options when you read it with a
JavaScript snippet instead of eyeballing: it returns every result card's name, price and link at
once. The snippets differ per site; these worked in live runs (adapt when a site's markup changes):

```js
// Booking.com search results: name, score, total price, property link
[...document.querySelectorAll('[data-testid="property-card"]')].slice(0, 8).map(c => ({
  name: c.querySelector('[data-testid="title"]')?.innerText, score: c.querySelector('[data-testid="review-score"]')?.innerText.replace(/\s+/g,' '),
  price: c.querySelector('[data-testid="price-and-discounted-price"]')?.innerText, taxes: c.querySelector('[data-testid="taxes-and-charges"]')?.innerText,
  href: c.querySelector('a[href*="/hotel/"]')?.href.split('?')[0] }))
// Airbnb search results: name, rating, total, listing link
[...document.querySelectorAll('[data-testid="card-container"]')].slice(0, 8).map(c => ({
  name: c.querySelector('[data-testid="listing-card-title"]')?.innerText, text: c.innerText.replace(/\s+/g,' ').slice(0, 160),
  href: c.querySelector('a[href*="/rooms/"]')?.href.split('?')[0] }))
// Generic fallback: anchors whose href looks like an item, with the card text around them
[...document.querySelectorAll('a[href]')].filter(a => /\/(hotel|rooms|hostels\/p|tours|things-to-do\/detail|-t\d+)/.test(a.href))
  .slice(0, 40).map(a => ({ text: (a.closest('li,article,div[class*="card"]') || a).innerText.replace(/\s+/g,' ').slice(0, 200), href: a.href.split('?')[0] }))
```

Flight results pages (Google Flights, Kayak, Booking, Trip.com, Expedia) are best read with
`get_page_text`: each result is a block of departure time, duration, stops, carrier and price. Take
the first five distinct itineraries per vendor; the link for each is the vendor's dated results
page (plus Google Flights' itinerary link for the ones you open).

Write every harvested option as an item with `provider` = the vendor, the dated link, the price as
shown, and no `tiers` field; after the hand-picked defaults are in, run
`python3 scripts/assign_tiers.py trip.json` to tier the rest by price rank.

## 4c. Chrome first, then the pane with the user's help

Why the pane gets blocked: it is a fresh, automated Chromium profile, often geolocated far from the
user, that opens many pages quickly. Skyscanner, Kayak and Booking.com's car engine score that as a
bot and show a robot check, a "Security Check — Continue" gate or an empty form. Nothing about the
prices is hidden from a normal person, so the fix is to look like one.

The user's standing instruction: run every vendor in their Chrome; if that does not work, fall back to
the pane where they confirm they are human. Pace requests either way: currency in the URL
(`currency=`/`selected_currency=`/`curr=`), `wait` 5 s after each navigate, one tab per vendor, no
reload loops.

1. **Claude in Chrome** (`mcp__claude-in-chrome__*`). Load `anthropic-skills:chrome-browser`, call
   `tabs_context_mcp`, open your own tabs with `tabs_create_mcp`, use the same deep links, and close
   your tabs at the end. Quirks seen in live runs:
   - `location.href` is blocked in `javascript_tool` there; read every URL from `tabs_context_mcp`.
   - Anchor harvesting that returns hrefs with a query string comes back as
     `[BLOCKED: Cookie/query string data]`; return just the id with a regex instead
     (`(a.getAttribute('href').match(/hotelId=(\d+)/)||[])[1]`) and rebuild the URL from the pattern.
   - After `tabs_close_mcp`, call `tabs_context_mcp` again before touching another tab, or the
     next call fails with a stale tab-group error.
   - Kayak's search pops an extra Booking.com comparison tab; Skyscanner's "Select" opens the
     seller (often Trip.com) in a new tab. Close both; they are not the results.
   - Chrome is signed in as the user on some vendors. Search only; never act on the account.
   - Kayak can gate Chrome too (it did on 25 Oct 2026 for flights, hotels and cars, a day after it
     loaded cleanly there). Treat it like any other gate: do not press its "Continue".
2. **The user takes over the pane.** Open the gated page in the pane, check `tabs_context` says the
   pane is displayed (if hidden: ask them to press Cmd+Shift+B / Ctrl+Shift+B), then tell them:
   "You can take over the pane and confirm you're human on {site}; the pane keeps that session
   cookie afterwards." Wait for their reply and continue on that site in the pane. Never click, hold
   or solve the check yourself. If they are away, finish the other vendors and ask once at the end.
3. **Record `blocked`** with the reason, and keep the deep link as the item URL with
   `verified: false` if you have a price from elsewhere. Say what actually failed: a bot check,
   a form that never accepts the origin (Agoda Flights), an error page (Agoda Activities), or a
   real "no cars" answer (Trip.com Car Hire for a 31-day rental is `no-inventory`, not `blocked`).

Record the rung that worked in each item's `details` ("opened through the user's Chrome") so
the user knows which prices came from their own profile.

## 4d. Order of work

Follow the seven stages in SKILL.md ("Search order"): flights (with every details panel opened),
stays, transfer / SIM / entry, cars and buses-trains-metro, activities and day trips, local food and
restaurants, then the map places. Rebuild and send after each stage.

## 5. Flights specifically

- Google Flights is the most reliable source and the only one that gives an itinerary-level URL
  without a fight. Open the search link, read the "Best" and "Cheapest" lists, click the row you
  want, wait, then read `location.href`; the URL now contains `tfs=` which encodes the chosen
  flights. That is the direct link.
- Choose per tier: **budget** = cheapest fare with at most one stop and total duration under about
  1.6× the fastest option; **mid** = best-ranked economy, nonstop when one exists; **upper** =
  premium economy (or business on routes under five hours); **luxury** = business or first on a
  full-service carrier. Change cabin by editing the `q=` text or the cabin dropdown on the page.
- Record: carrier(s), departure and arrival times, stops, duration, fare class, baggage note.
  Put them in `details`. Prices are per adult, so `unit: "per_person"`.
- Check the same route on every flight vendor (Google Flights, Skyscanner, Trip.com, Booking.com
  flights, Agoda flights, Kayak); if a fare is cheaper elsewhere, use that vendor's link and mention
  the others' prices in `details`.
- **Checked-bag fees.** For every flight option, find out what a checked bag costs on that fare and
  add a companion "Checked bags" line, following `references/baggage.md` (official airline page as
  the link, round-trip cost per person, ticked by default when the fare excludes bags).

## 6. Lodging specifically

- **Search by neighborhood, tier by tier.** For each tourist neighborhood and each lodging site:
  open the area search (`deeplinks.py --areas`), sort by price low to high and read 5 rated stays in
  the budget band (hostels, guesthouses, private rooms), then 5 in the mid band (3★, entire
  flats), then use the site's star or price filter for 5 upper (4★, boutique) and 5 luxury (5★,
  luxury brands). Set `tiers` and `neighborhood` on each at import; `assign_tiers.py` ranks any
  untiered stay within its own neighborhood. Keep a stay only if its address or the site's map puts
  it inside the area, not one whose name says "near X". A band the site does not sell in that area
  goes in the neighborhood's `gaps` with the reason.
- Brief the helpers from `references/area-stays-brief.md` (one or two sites each, in the user's Chrome,
  saving after every area), then `scripts/import_area_stays.py trip.json stays_*.json`. Keep each
  helper's area choice (it read the address and the site's area label): re-assigning by nearest centre
  pushed hotels named "Sanlitun Taikoo Li" into the next area. Tick defaults from well-reviewed,
  central stays with a live price: the cheapest well-rated hostel for budget, a big-review 3★ for mid,
  a boutique 4★ for upper, a luxury brand for luxury.

- Read the ratings (Booking score out of 10, Airbnb/Agoda out of 5, Hostelworld out of 10) and
  review counts; a 9.4 with 40 reviews is weaker evidence than an 8.9 with 2,000. Prefer well-reviewed
  places; the user's trust in the dashboard depends on the options being ones they would pick.
- Tier by the destination's own price distribution for the dates (see `tiers.md`), not by fixed
  dollar amounts. In Bangkok a $120 hotel is upper tier; in Zurich it is budget.
- One of the stays per tier gets `default_on: true`; all stays in a tier share
  `exclusive_group: "stay"` so checking one unchecks the others.
- Capture address text from the page and geocode it (`scripts/geocode.py`) so the stay appears on
  the map. Airbnb hides exact addresses: use the neighborhood name shown on the listing plus the
  city, and say in `details` that the pin is approximate.

## 7. Labeling and honesty

- `verified: true` + `checked_at: <today>` only when you read the price on the provider's own page.
- Everything else is `verified: false`, with `source` naming where the number came from
  ("Numbeo cost-of-living page", "WebSearch snippet from Booking.com, dates not applied",
  "typical price from GetYourGuide listing without date").
- Never invent a specific listing. If you cannot find a real one, use the search deep link, a
  generic name ("4-star hotel in Chiado, choose on Booking.com"), and `verified: false`.
- When a provider blocked you, record that in the trip JSON `trip.notes` and in your closing message,
  with the rung of the §4c ladder it failed at and which browser finally read the price.

## 8. Fallback without a browser

1. `WebSearch` for `site:booking.com {city} hotel {tier words}`, `site:airbnb.com/rooms {city}`,
   `site:hostelworld.com {city}` to find specific listing URLs; append the date/guest parameters
   from `providers.md` so the link still opens with the user's dates.
2. `WebFetch` the listing page; some return server-rendered text with a price, most do not. If a
   price is not visible, use a published typical price (`WebSearch` "{hotel} price per night") and
   label it an estimate.
3. Flights: `WebSearch` "{ORIG} to {DEST} flights {month} {year} price" for typical fares, use the
   Google Flights search deep link as the URL, `verified: false`.
4. Say plainly in the closing message that no live prices were read and why.


## Lessons from live runs

- Helpers return thin first passes (no aircraft, legroom, flight numbers, only page-1 results). Plan a second pass:
  resume the same helper and ask for detail panels, the time-of-day filter and more results; Google Flights gave
  aircraft + legroom, Kayak aircraft only, Booking / Skyscanner / Trip.com / Agoda / Expedia almost nothing.
- Small markets cannot reach 5 stays per area x site x tier (Funcionários and Santa Tereza had 0-5 listings per site):
  record the reason in `neighborhoods[].gaps` and say so in the summary rather than padding with far-away hotels.
- `fetch_pois.py` can take 10+ minutes per stay when Overpass is slow: run it with `-o` to a scratch copy in the
  background, and if the ticked stays are within ~1.5 km of each other, reuse one download for all of them.
- Never use `pgrep -f fetch_pois` to wait for it: the waiting shell matches itself. Poll the output file instead.
- Hostelworld "from" prices can be implausibly low (dorm bed $1-5): label them and tell the user to check.
