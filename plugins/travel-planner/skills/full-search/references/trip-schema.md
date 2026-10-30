# Trip JSON schema

`scripts/build_dashboard.py` validates this structure and injects it into the dashboard template.
Field names are read by the template's JavaScript, so spell them exactly as below.
`assets/sample-trip.json` is a complete, buildable example.

## Top level

```json
{
  "trip": { ... },
  "items": [ ... ],
  "pois": [ ... ],
  "coverage": { ... },         // vendor → category → searched | no-inventory | blocked
  "search_links": { ... },     // vendor → category → results-page URL (the Master Search List)
  "entry": { ... },            // visa / vaccines / arrival-form rules for US citizens (references/entry-requirements.md)
  "nearby": { ... },           // written by scripts/fetch_pois.py
  "categories": [ ... ]        // optional: override the default category list/order
}
```

## `trip`

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | e.g. "Lisbon, Portugal · November 2026" |
| `origin` | `{ "city", "iata" }` | yes | iata may be an empty string for road trips |
| `destination` | `{ "city", "country", "iata", "lat", "lng" }` | yes | lat/lng centre the map; geocode the city if needed |
| `start_date`, `end_date` | date strings | yes | `yyyy-mm-dd`, `mm-dd-yyyy` or `mm/dd/yyyy` (the build normalises to ISO); end = checkout / return day; nights = end − start |
| `travelers` | integer ≥ 1 | yes | adults; put children in `travelers_note` |
| `trip_type` | `round_trip` \| `one_way` | no | shown in the header; one-way flights are priced on the check-in date only |
| `travelers_note` | string | no | "2 adults, 1 child (6)" |
| `currency` | ISO 4217 code | yes | all prices in this currency |
| `days` | integer | no | defaults to nights + 1; used for per-day lines |
| `generated_at` | ISO date | yes | the research date; shown as "prices checked on" |
| `notes` | string | no | caveats shown in the footer (blocked sites, flexible dates…) |
| `arrival_airport` | `{ "name", "iata", "lat", "lng" }` | recommended | the map shows driving directions and ride-app links from here to the selected stay |
| `uber_available` | boolean | no | `false` hides the Uber link and says Uber does not operate there |
| `ride_apps` | array of `{ "name", "url", "note" }` | recommended | ride apps people actually use there, most used first; shown in the sidebar and under the map |
| `fx` | `{ "code", "rate", "checked_at", "url" }` | recommended | 1 unit of `currency` in local money; shown in the sidebar |

## `items[]` — one per cost line

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | unique, kebab-case: `stay-mid-memmo-alfama` |
| `tiers` | array of tier ids | yes (or `tier`) | any of `budget`, `mid`, `upper`, `luxury`; `"tier": "mid"` is accepted shorthand. Leave it out and `scripts/assign_tiers.py` fills it by price rank |
| `category` | string | yes | `flights`, `lodging`, `car`, `transfer` (airport → stay), `activities`, `food`, `transport`, `sim` (SIM / eSIM), `insurance`, `other` |
| `name` | string | yes | what the user will recognise: "TAP Air Portugal LAX→LIS, 1 stop" |
| `provider` | string | yes | "Booking.com", "Airbnb", "Expedia", "Kayak", … shown as a pill, and it is the vendor tab the item lives under (up to 5 per vendor per category are shown) |
| `url` | string | yes | the direct link; the build fails on a bare homepage |
| `price` | number | yes | unit price in `trip.currency` |
| `unit` | string | yes | `per_person`, `per_night`, `per_day`, `per_person_per_day`, `per_person_per_night`, `total` |
| `qty` | number | no | overrides the automatic quantity (travelers, nights, days…) |
| `price_note` | string | no | "7 nights, taxes included" / "per adult, no checked bag" |
| `verified` | boolean | yes | true only if you read the price on the provider page |
| `checked_at` | ISO date | when verified | the day you read it |
| `source` | string | when not verified | where the estimate came from |
| `default_on` | boolean | no | included in the total on first load (default true) |
| `exclusive_group` | string | no | checking this item unchecks others with the same group in the same tier (`stay`, `flight`, `car`) |
| `details` | string | no | times, stops, room type, what is included; shown under the name |
| `rating`, `rating_scale`, `reviews` | number | stays, cars, activities | 8.9 / 10 / 2410 → "8.9/10 · 2,410 reviews"; `reviews` may be a string such as "1,000+" when the site rounds |
| `kind` | string | sim lines | `local` (the country's own carrier) or `esim` (international eSIM) |
| `tags` | array of strings | no | small pills on the line: "Local carrier", "Physical SIM", "eSIM" |
| `days`, `operator` | number, string | sim lines | validity in days and the carrier (AIS, True, dtac…); the sidebar averages each carrier's cheapest pack that covers the whole trip |
| `rating_source` | string | no | when the rating is not the provider's own guest score: "Google Maps", "Trustpilot", "rental company's score on Booking.com", "Kayak deal score". With no `rating`, the reason none exists ("New Vrbo listing, no reviews yet"); the page shows "No rating · …" |
| `rating_url` | url | no | the page the rating came from, when it is not `url` (the source name becomes a link) |
| `neighborhood` | string | lodging | id of the tourist neighborhood this stay is in (`neighborhoods[].id`); drives the Lodging card's Area filter |
| `lat`, `lng` | number | lodging | puts the stay on the map; omit for non-lodging |
| `address` | string | no | shown in the map popup |
| `alternatives` | array of `{ "provider", "url", "price" }` | no | the same stay/flight on other sites, shown as small links |

Automatic quantity when `qty` is absent:

| unit | qty |
|---|---|
| `per_person` | travelers |
| `per_night` | nights |
| `per_day` | days |
| `per_person_per_day` | travelers × days |
| `per_person_per_night` | travelers × nights |
| `total` | 1 |

## `coverage` — which vendor was searched for what

One entry per vendor the user named, per category that vendor sells (the matrix in
`providers.md`). Values: `searched` (you ran it and used or rejected its results), `no-inventory`
(it had nothing for this destination/dates), `blocked` (a bot check stopped you). The build warns
about every missing cell, and the dashboard footer shows the table, so the user can see that all
their vendors were tried.

```json
"coverage": {
  "Airbnb":        { "lodging": "searched", "activities": "searched" },
  "Booking.com":   { "lodging": "searched", "flights": "searched", "car": "searched", "activities": "no-inventory" },
  "Skyscanner":    { "flights": "blocked",  "lodging": "searched", "car": "searched" },
  "Trip.com":      { "flights": "searched", "lodging": "searched", "car": "searched", "activities": "searched" },
  "Agoda":         { "lodging": "searched", "flights": "searched", "activities": "no-inventory" },
  "Hostelworld":   { "lodging": "searched" },
  "Google Flights":{ "flights": "searched" },
  "Google Hotels": { "lodging": "searched" }
}
```

## `search_links` — the Master Search List

The dashboard shows this as a collapsed "Master Search List" panel above the category cards: one row
per site, one column per category (flights, lodging, rental car, activities, other), each cell a link
to that site's **full results page** for the trip's route, dates and guests. It is for the user to
redo a search by hand later, so every vendor × category you searched (every `searched` cell in
`coverage`, and the blocked ones too) needs a link; the build warns about gaps. Generate the starting
object with `scripts/deeplinks.py ... --search-links`, then swap in the results URLs you captured for
form-only sites.

A value is a URL string or `{ "url", "note"?, "label"? }`. `note` is shown under the link (use it for
anything the user must do on arrival); `label` names links in non-standard categories, which go to
the "Other" column.

```json
"search_links": {
  "Google Flights": { "flights": { "url": "https://www.google.com/travel/flights?q=Flights%20from%20MCO%20to%20GIG%20on%202027-04-01%20one%20way&hl=en&gl=us&curr=USD", "note": "Economy" },
                      "flights_business": { "url": "https://www.google.com/travel/flights?q=...%20in%20business%20class&hl=en&gl=us&curr=USD", "label": "Business class flights" } },
  "Skyscanner":     { "flights": "https://www.skyscanner.com/transport/flights/mco/gig/270401/?adults=1&adultsv2=1&cabinclass=economy&rtn=0&currency=USD",
                      "lodging": "https://www.skyscanner.com/hotels/search?entity_id=27541837&checkin=2027-04-01&checkout=2027-05-01&adults=1&rooms=1&currency=USD",
                      "car":     "https://www.skyscanner.com/carhire/results/95673347/95673347/2027-04-01T10:00/2027-05-01T10:00/30" },
  "Kayak":          { "flights": { "url": "https://www.kayak.com/flights/MCO-GIG/2027-04-01/1adults?sort=bestflight_a", "note": "May ask you to confirm you are not a bot; press Continue yourself" } },
  "Numbeo":         { "food": { "url": "https://www.numbeo.com/cost-of-living/in/Rio-De-Janeiro?displayCurrency=USD", "label": "Cost of living" } }
}
```

## `trip.pending` (set by `build_dashboard.py --partial`, do not hand-write)

During a flights-first build the script adds `trip.pending` (categories still being researched). The
page shows a "still searching" banner, placeholder cards and reloads itself every minute until a
normal build (without `--partial`) replaces the file. `--map-pending` adds `"map"`: every card is
shown, and the banner says the map's nearby places are still loading.

## Checked-bag lines

Give every checked-bag line `"kind": "bags"` (ids starting `bags-` are treated the same). The
dashboard groups them under a "Checked bags" site chip and always lists them below the flights,
whatever the sort order, and the 5-per-site check ignores them.


A bag fee is an ordinary `flights` item that accompanies a flight option:

```json
{
  "id": "bags-budget-tap-light", "tiers": ["budget"], "category": "flights",
  "name": "Checked bags: TAP Light fare, 1 × 23 kg each way", "provider": "TAP Air Portugal",
  "url": "https://www.flytap.com/en-us/baggage/checked-baggage", "price": 150, "unit": "per_person",
  "price_note": "first bag, round trip, bought online in advance", "verified": true, "checked_at": "2026-10-24",
  "default_on": true, "details": "Light fare includes carry-on only; airport price is higher."
}
```

## `weather` (written by `scripts/fetch_weather.py`)

```json
"weather": {
  "location": "Phuket", "checked_at": "2026-10-25",
  "normals": [{ "month": "November", "high_f": 89, "low_f": 77, "rain_days": 15, "days_in_month": 30,
                "precip_in": 7.0, "period": "1981–2010", "source": "Thai Meteorological Department",
                "source_url": "https://en.wikipedia.org/wiki/Phuket_province#Climate" }],
  "forecast": [{ "date": "2026-11-01", "high_f": 85, "low_f": 75, "precip_in": 0.23, "rain_chance": 78, "summary": "Drizzle" }],
  "links": [{ "label": "14-day forecast (timeanddate)", "url": "https://www.timeanddate.com/weather/thailand/phuket/ext" }]
}
```

Also `"code"` (WMO weather code) on each forecast day drives the tile icon, `"climate_months"` (12 ×
{month, high_f, low_f, precip_in, rain_days, days_in_month}) feeds the rain chart, and
`"rainy_season": {"months": [5,6,7,8,9,10], "label": "May – October", "peak": "September – October",
"source": "Tourism Authority of Thailand", "source_url": "…", "start": "05-15", "end": "10-15"}` drives the
rainy-season panel and sidebar (`start` / `end` are optional mid-month edges).

Days with a forecast show it; the rest show the month's normal in a dashed tile. Rerun the script
nearer departure to fill more days.

## `local_food` — signature dishes and the best-rated places that serve them

```json
"local_food": {
  "checked_at": "2026-10-25",
  "dishes": [{ "id": "moo_hong", "name": "Moo Hong (Phuket braised pork belly)", "thai": "หมูฮ้อง",
               "description": "…", "source_url": "https://guide.michelin.com/…" }],
  "restaurants": [{ "id": "one-chun", "name": "One Chun", "area": "Phuket Old Town", "address": "…",
                    "lat": 7.8858, "lng": 98.3907, "dishes": ["moo_hong", "mee_gaeng_poo"],
                    "rating": 4.4, "rating_scale": 5, "reviews": 6736, "rating_source": "Google Maps",
                    "url": "https://www.google.com/maps/place/…", "evidence_url": "https://guide.michelin.com/…",
                    "evidence_label": "Michelin Guide", "michelin": "Bib Gourmand", "price_note": "฿฿ moderate", "notes": "Open 10:00-22:00" }]
}
```

Dishes carry `"scope": "country"` (national classics) or `"scope": "city"` (city / regional
specialties); `local_food.city_label` and `country_label` name the two groups on the card.
`url` is the restaurant's Google Maps page (reviews, hours, booking); `evidence_url` shows the dish on
its menu or names it as a specialty. Not counted in the totals.

## `pois[]` — curated map pins (ratings live here)

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | |
| `type` | string | yes | `hospital`, `pharmacy`, `embassy`, `grocery`, `nightlife`, `nature`, `other` |
| `lat`, `lng` | number | yes | |
| `rating`, `rating_scale` | number | no | 4.4 / 5 |
| `rating_source` | string | no | "Google Maps", "Trip.com", "Tripadvisor"; with no `rating`, why none was found |
| `rating_url` | url | no | the page the rating came from (Trip.com / Tripadvisor restaurant page) |
| `url` | string | yes | the Google Maps page (or official site) used as the source |
| `note` | string | no | "Private; English-speaking; 24 h emergency" |

The dashboard shows curated pins in every tier, highlights the ones within 5 miles of the selected
stay, and lists their distance.

## `nearby` — embedded 5-mile places (written by `scripts/fetch_pois.py`, do not hand-write)

```json
"nearby": {
  "stay-mid-apartment-chiado": {
    "fetched_at": "2026-10-24", "radius_miles": 5, "source": "OpenStreetMap via Overpass API",
    "cats": { "hospital": [ { "id": "n123", "name": "…", "lat": 38.7, "lng": -9.1, "dist": 0.8, "tags": { "emergency": "yes" } } ], "pharmacy": [], "grocery": [], "nightlife": [], "nature": [], "hotel": [], "car_rental": [], "transit": [] }
  }
}
```

(The bundled `assets/sample-trip.json` keeps only the 5 nearest places per category to stay small; real runs keep up to 40.)

The dashboard renders this instantly when the user clicks the stay; stays without an entry fall back
to a live Overpass lookup in the browser. The build script warns about every mapped stay that has
no entry.

## Minimal valid example

```json
{
  "trip": {
    "title": "Lisbon, Portugal · 10–17 Nov 2026",
    "origin": { "city": "Los Angeles", "iata": "LAX" },
    "destination": { "city": "Lisbon", "country": "Portugal", "iata": "LIS", "lat": 38.7223, "lng": -9.1393 },
    "start_date": "2026-11-10", "end_date": "2026-11-17",
    "travelers": 2, "currency": "USD", "generated_at": "2026-10-24"
  },
  "items": [
    {
      "id": "flight-mid-tap-nonstop", "tiers": ["mid", "upper"], "category": "flights",
      "name": "TAP Air Portugal LAX→LIS nonstop, economy", "provider": "Google Flights",
      "url": "https://www.google.com/travel/flights?tfs=...", "price": 845, "unit": "per_person",
      "price_note": "round trip per adult, taxes included", "verified": true, "checked_at": "2026-10-24",
      "default_on": true, "exclusive_group": "flight",
      "details": "Depart 10 Nov 16:10 → arrive 11 Nov 11:40 (11h 30m). Return 17 Nov 13:05 → 17:50."
    },
    {
      "id": "stay-mid-alfama-apt", "tiers": ["mid"], "category": "lodging",
      "name": "Entire 1-bedroom apartment in Alfama", "provider": "Airbnb",
      "url": "https://www.airbnb.com/rooms/12345678?check_in=2026-11-10&check_out=2026-11-17&adults=2",
      "price": 1190, "unit": "total", "price_note": "7 nights incl. cleaning and service fees",
      "verified": true, "checked_at": "2026-10-24", "default_on": true, "exclusive_group": "stay",
      "rating": 4.9, "rating_scale": 5, "reviews": 312, "lat": 38.7118, "lng": -9.1300,
      "address": "Alfama, Lisbon (approximate pin)"
    }
  ],
  "pois": [
    {
      "name": "Hospital da Luz Lisboa", "type": "hospital", "lat": 38.7580, "lng": -9.1890,
      "rating": 4.3, "rating_scale": 5, "rating_source": "Google Maps",
      "url": "https://www.google.com/maps/search/Hospital%20da%20Luz%20Lisboa",
      "note": "Private hospital, English-speaking staff, 24 h emergency"
    }
  ]
}
```


## `neighborhoods` (tourist areas for nightlife and food)

A list, shown as a "Tourist neighborhoods: nightlife & food" fold at the top of the Lodging card (names always visible, details on click), as dashed outlines
on the map, and as the Lodging card's Area filter. Stays are searched in each one (5 per tier per site).

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | short slug, used by `items[].neighborhood` |
| `name` | string | yes | "Copacabana", "Gulou & Nanluoguxiang" |
| `local_name` | string | no | name in the local script |
| `lat`, `lng` | number | yes | centre of the area (the map draws a circle) |
| `radius_m` | number | no | circle radius, default 700 |
| `tags` | list | no | 2–3 short tags: "Nightlife", "Street food", "Beach" |
| `summary` | string | no | one line on what the area is |
| `nightlife` | string | yes* | what the bars/clubs/live music are like (*nightlife or food required) |
| `food` | string | yes* | what to eat there and where |
| `good_to_know` | string | no | crowds, safety, the subway stop |
| `source_url`, `source_label` | url, string | yes | Wikivoyage district page, tourism board, city guide |
| `maps_url` | url | no | defaults to a Google Maps search for the name |
| `search_stays` | bool | no | false = listed on the card, stays not searched there |
| `gaps` | object | no | site → why it has under 5 in a tier here: {"Hostelworld": "hostels only: no upper or luxury"} |

## Dish photos (`local_food.dishes[]`)

| Field | Type | Notes |
|---|---|---|
| `wiki` | string | English Wikipedia article ("Peking duck") or Commons file ("File:X.jpg") to take the photo from |
| `image` | object | written by `fetch_dish_images.py`: {thumb, full, page, credit, license, source, via, checked_at} |
| `photos_url` | url | Google Images search for the dish (written by the script; the page builds one if missing) |


## Flight cards (`item.flight`)

Every flight line (not the bag-fee lines) carries a `flight` object; the dashboard draws it as a roomy
flight card instead of a plain line. Times are local, naive ISO (`2027-01-15T07:05`).

```json
"flight": {
  "airline": "LATAM Airlines", "flight_numbers": ["LA 3300"],
  "cabin": "Economy", "fare": "Basic", "trip_type": "one_way",
  "origin": "GIG", "destination": "CNF",
  "depart": "2027-01-15T07:05", "arrive": "2027-01-15T08:30",
  "stops": 0, "total_min": 85,
  "legs": [{"from": "GIG", "to": "CNF", "airline": "LATAM", "flight_no": "LA 3300",
            "depart": "2027-01-15T07:05", "arrive": "2027-01-15T08:30", "duration_min": 85,
            "aircraft": "Airbus A320", "legroom_in": 30}],
  "layovers": [{"airport": "GRU", "city": "Sao Paulo", "minutes": 95, "note": "same terminal"}],
  "aircraft": "Airbus A320", "legroom_in": 30, "legroom_label": "Average legroom",
  "bags": {"carry_on": true, "checked": false},
  "period": "morning"
}
```

- `layovers[]`: one per stop, in order, each with the airport code (`airport`), its `city` and the wait in `minutes`; the card draws them as markers on the route line. Without `layovers`, the card derives them from consecutive `legs` (`to`, optional `to_city`).
- `period` is optional: morning = departs 05:00–11:59, afternoon = 12:00–17:59, night = 18:00–04:59.
- `bags.carry_on` / `bags.checked`: `true` (free), `false` (not included) or a string ("$35").
  Add `carry_on_kg` / `carry_on_lb` and `checked_kg` / `checked_lb` (the allowance for that fare, e.g. 12 kg carry-on,
  23 kg paid checked bag); the card shows both units. Each leg's `flight_no` is drawn on its stretch of the route line.
- `legroom_in` is seat pitch in inches as the site shows it (Google Flights: "Average legroom (30 in)").
  The card turns it into a verdict for the traveler's height (`trip.traveler_height_in`, default 73 = 6 ft 1 in):
  needs 32 in+ to be "enough", 31 in is "tight", 30 or less is "cramped".
- One line per flight; the same flight found on another site is its own line with that site's `provider` and `url`.
- Flight lines are tiered as before (economy search → budget + mid, business → upper + luxury), and the
  build warns for every site × tier × time-of-day cell under 5.


## `ground` — buses, trains & metro (trips inside one country)

Rendered as the "Buses, trains & metro" card (half width, next to Popular day trips, before Local food). Not in totals.

```json
"ground": {
  "same_country": true, "checked_at": "2026-10-28",
  "summary": "Buses take about 7 h and cost less than the cheapest flight once airport rides are added.",
  "options": [{ "id": "bus-clickbus-util-0800", "mode": "bus", "operator": "Util", "provider": "ClickBus", "class": "Executivo",
                "from": "Rodoviaria Novo Rio", "to": "Rodoviaria de Belo Horizonte", "depart": "2027-02-15T08:00", "arrive": "2027-02-15T15:00",
                "duration_min": 420, "price": 35.2, "price_brl": 191.2, "url": "https://www.clickbus.com.br/onibus/...?departureDate=2027-02-15",
                "verified": true, "checked_at": "2026-10-28", "rating": 4.3, "rating_scale": 5, "reviews": 1200, "rating_source": "ClickBus",
                "amenities": ["Wi-Fi", "USB"], "note": "" }],
  "no_train_note": "No passenger train runs between the two cities.", "no_train_source_url": "https://...",
  "stations": [{ "name": "Rodoviaria Novo Rio", "city": "Rio de Janeiro", "how": "Uber from Copacabana, about 25 min", "cost_usd": 6, "url": "https://..." }],
  "local_transit": [{ "id": "metro-bh", "name": "Metro BH Line 1", "mode": "metro", "fare_usd": 1.0, "fare_brl": 5.4, "note": "...", "url": "https://...", "verified": true }],
  "search_links": [{ "site": "ClickBus", "url": "https://...", "note": "" }]
}
```

`mode` is `bus`, `train`, `ferry` or `rideshare` for options; `metro`, `brt`, `bus`, `tram` or `card` for local transit.
Prices are per person, one way, in `trip.currency`; `price_brl` / `fare_brl` (local money) is optional.

## `day_trips` — popular day trips

Rendered as the "Popular day trips" card next to Buses, trains & metro. Closest first. Not in totals.

```json
"day_trips": [{ "id": "inhotim", "name": "Inhotim", "place": "Brumadinho", "wiki": "Inhotim", "lat": -20.12, "lng": -44.22,
  "distance_km": 60, "drive_min": 75, "summary": "Open-air contemporary art museum in a botanical garden.", "tags": ["Art", "Gardens"],
  "entry": { "price_usd": 9, "price_brl": 50, "note": "Free on the last Friday of the month", "url": "https://..." },
  "transport": [{ "mode": "bus", "how": "Saritur bus from the BH bus station", "duration_min": 90, "cost_usd": 12, "cost_brl": 65,
                  "cost_basis": "round trip per person", "url": "https://...", "verified": false, "source": "..." }],
  "maps_url": "https://www.google.com/maps/dir/?api=1&origin=...&destination=...", "source_url": "https://...", "source_label": "Wikivoyage" }]
```

`transport[].mode`: `bus`, `train`, `car`, `rideshare`, `tour`, `ferry`. The card marks the cheapest and shows
"From $X per person, round trip" (cheapest way + entry). `image` is written by `fetch_dish_images.py` from `wiki`.

## `restaurants` — best restaurants, local and international

Rendered as the "Best restaurants" card after Local food to try: chips for All / Local / International and by cuisine,
sorted by rating, with the distance from the selected stay and a photo from the restaurant's own website
(`image`, written by `fetch_dish_images.py` from `website`). Not in totals.

```json
"restaurants": { "checked_at": "2026-10-28", "city": "Belo Horizonte",
  "restaurants": [{ "id": "xapuri", "name": "Xapuri", "kind": "local", "cuisine": "Mineiro", "area": "Pampulha", "address": "...",
    "lat": -19.85, "lng": -43.97, "rating": 4.6, "rating_scale": 5, "reviews": 9000, "rating_source": "Google Maps", "price_level": "$$$",
    "signature": "...", "why": "...", "url": "https://www.google.com/maps/place/...", "evidence_url": "https://...",
    "evidence_label": "Veja Comer & Beber", "hours_note": "Closed Mondays", "reservations": "Recommended",
    "website": "https://...", "image": { "thumb": "https://.../og.jpg", "page": "https://...", "credit": "restaurant's website" } }] }
```
