# Provider URL patterns

Two kinds of link matter:

- **Search deep link** — opens the provider's results for the exact route/city, dates and guests.
  `scripts/deeplinks.py` generates these. Acceptable as a fallback link in the dashboard.
- **Item deep link** — opens one specific flight itinerary, hotel, listing, hostel or car offer with
  dates and guests preserved. This is what the user asked for; capture it whenever the site allows.

Sites change their URL schemes without notice. If a pattern below stops working, fill in the site's
own search form in the browser, then copy the resulting address bar URL: that is always a valid
search deep link. Run any captured URL through `python3 scripts/deeplinks.py --clean "<url>"` to strip
tracking parameters while keeping the ones that carry dates and guests.

Placeholders: `{ORIG}`/`{DEST}` = IATA codes, `{YYYY-MM-DD}` = ISO dates, `{yymmdd}` = 2-digit year
form (2026-11-10 → 261110), `{n}` = adults, `{City}` = URL-encoded city name.

## Who sells what: search every cell

The user named these vendors and wants each one searched for everything it offers. Run every
vendor for every category it has; skip only the cells a vendor genuinely does not sell. Record the
result of each cell in the trip JSON `coverage` object (`searched`, `no-inventory` when the vendor
had nothing for that destination/dates, `blocked` when a bot check stopped you).

| Vendor | Flights | Lodging | Cars | Activities |
|---|---|---|---|---|
| Airbnb | – | homes, rooms | – | Experiences |
| Booking.com | flights.booking.com | hotels, apartments | cars.booking.com | Attractions |
| Skyscanner | yes | hotels (form) | car hire (form) | – |
| Trip.com | yes | hotels | car hire (form) | Things to do |
| Agoda | yes | hotels, homes | – | Activities (form) |
| Hostelworld | – | hostels | – | – |
| Google Flights | yes | – | – | – |
| Google Hotels | – | hotels | – | – |
| Expedia | yes | hotels, homes | yes | Things to do |
| Kayak | yes | yes | yes | – |
| (added) GetYourGuide, Viator | – | – | – | yes |

`scripts/deeplinks.py` prints the links in exactly this vendor-by-vendor order with the dates and
guests filled in; cells marked "form" need the site's own search box.

## Flights

### Google Flights
- Search (round trip): `https://www.google.com/travel/flights?q=Flights%20from%20{ORIG}%20to%20{DEST}%20on%20{YYYY-MM-DD}%20returning%20{YYYY-MM-DD}&hl=en&gl=us&curr=USD`
  (`gl=us` and the word *returning* matter: without them the query is ignored and the homepage loads).
- One way: same with `...on {YYYY-MM-DD}%20one%20way`. Cabin: append `%20in%20business%20class` (works); `premium economy` is not understood by the query link: use Booking.com flights with `cabinClass=PREMIUM_ECONOMY` or Trip.com `class=s` for that cabin.
- The booking page (after choosing both legs) lists every fare brand with its bag rules, e.g. "1st checked bag: $129" or "2 free checked bags": that is the fastest verified bag-fee source.
- Item link: click an itinerary. The address bar URL gains a `tfs=` parameter that encodes the
  selected flights; read it with `location.href` and keep it whole (`tfs`, `tfu`, `hl`, `gl`, `curr`
  are all needed). The "Share" button on the selected-flights page gives the same link shortened.
- Price shown: round-trip total per adult, taxes included. Baggage is often extra on basic fares.

### Skyscanner
- Search: `https://www.skyscanner.com/transport/flights/{orig}/{dest}/{yymmdd}/{yymmdd}/?adults={n}&adultsv2={n}&cabinclass=economy&rtn=1&preferdirects=false&currency=USD`
  (lowercase IATA codes; `cabinclass` ∈ economy, premiumeconomy, business, first; one way: drop the second date and set `rtn=0`).
- Item link: press "Select" on an itinerary; the URL becomes `.../transport/flights/{orig}/{dest}/{yymmdd}/{yymmdd}/config/{itinerary-id}?...`. Keep everything.
- Skyscanner is the most aggressive about bot checks ("Are you a person or a robot?") in the pane.
  Do not try to pass it: run the same link through Claude in Chrome (playbook §4c), where a live run
  read six priced itineraries with no check at all. Only if that fails too keep the search deep link,
  take the price from Google Flights or Kayak, and note the block.
- Price shown: per adult, round trip, taxes included; "Mashup" fares combine two one-ways.

### Trip.com (flights)
- Search: `https://www.trip.com/flights/showfarefirst?dcity={orig}&acity={dest}&ddate={YYYY-MM-DD}&rdate={YYYY-MM-DD}&triptype=rt&class=y&quantity={n}&locale=en-US&curr=USD`
  (`class`: y economy, s premium economy, c business, f first; one way: `triptype=ow`, no `rdate`).
- Item link: Trip.com itineraries do not have stable URLs. Use the search link and describe the
  flight (carrier, times, stops) in `details`.
- Price shown: per adult; check whether baggage is included (often it is not on the cheapest fare).

### Booking.com (flights)
- Search: `https://flights.booking.com/flights/{ORIG}.AIRPORT-{DEST}.AIRPORT/?type=ROUNDTRIP&adults={n}&cabinClass=ECONOMY&children=&from={ORIG}.AIRPORT&to={DEST}.AIRPORT&depart={YYYY-MM-DD}&return={YYYY-MM-DD}&sort=BEST`
  (`cabinClass`: ECONOMY, PREMIUM_ECONOMY, BUSINESS, FIRST).
- Item link: click an itinerary; the URL gains an offer token. Copy `location.href` and keep it whole.
- Price shown: total for all travelers (divide by adults for `per_person`); baggage shown per fare.

### Agoda (flights)
- Search: `https://www.agoda.com/flights/results?departureFrom={ORIG}&departureTo={DEST}&departDate={YYYY-MM-DD}&returnDate={YYYY-MM-DD}&searchType=2&cabinType=Economy&adults={n}&sort=8` (`searchType=2` = round trip). The page keeps the dates and destination but drops the origin; in a live run even typing it into the "Flying from" box did not register, so expect to record this cell as blocked.
- Item link: results level only; describe the itinerary in `details`.

### Expedia (flights)
- Search: `https://www.expedia.com/Flights-Search?trip=roundtrip&leg1=from:{ORIG},to:{DEST},departure:{MM/DD/YYYY}TANYT&leg2=from:{DEST},to:{ORIG},departure:{MM/DD/YYYY}TANYT&passengers=adults:{n},children:0,infantinlap:N&mode=search` (one way: `trip=oneway`, no `leg2`).
- Item link: results level; Expedia's fare-detail URLs carry session tokens that expire.
- Price shown: per traveler, taxes included.

### Kayak (flights)
- Search: `https://www.kayak.com/flights/{ORIG}-{DEST}/{YYYY-MM-DD}/{YYYY-MM-DD}/{n}adults?sort=bestflight_a` (one way: drop the second date).
- Item link: results pages only. Kayak "View Deal" opens the airline/OTA, whose URL rarely survives a reload.
- The pane gets a "Security Check — Continue" page from Kayak (flights, hotels and cars alike). Do not
  press it; Claude in Chrome loads the same URLs without it (playbook §4c). Kayak's search also opens a
  Booking.com comparison tab: close it.

## Lodging

### Booking.com
- Search: `https://www.booking.com/searchresults.html?ss={City}%2C%20{Country}&checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&group_adults={n}&no_rooms=1&group_children=0&selected_currency=USD`
  Useful filters appended: `&nflt=class%3D4` (4-star), `class%3D5`, `review_score%3D80` (8+), `ht_id%3D204` (hotels only), `ht_id%3D201` (apartments).
- Item link: `https://www.booking.com/hotel/{cc}/{slug}.html?checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&group_adults={n}&no_rooms=1&group_children=0&selected_currency=USD`
  Keep: `checkin checkout group_adults no_rooms group_children selected_currency req_adults req_children`.
  Strip: `aid label sid srpvid srepoch from ucfs highlighted_blocks all_sr_blocks matching_block_id sr_pri_blocks dist type sb_price_type hapos hpos sr_order`.
- Price shown: total for the whole stay for the cheapest room, for the dates chosen. Look for the
  line "Includes taxes and charges" or "+ US$X taxes and charges" and record which.

### Airbnb
- Search: `https://www.airbnb.com/s/{City}--{Country}/homes?checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&adults={n}&currency=USD`
  (`currency=` matters: the browser pane may be geolocated elsewhere and show local currency otherwise).
  Filters: `&room_types%5B%5D=Entire%20home%2Fapt`, `&price_max=200`, `&min_bedrooms=2`.
- Item link: `https://www.airbnb.com/rooms/{listing-id}?check_in={YYYY-MM-DD}&check_out={YYYY-MM-DD}&adults={n}`
  (note `check_in`/`check_out` with underscores on listing pages, `checkin`/`checkout` on search).
  Keep: `check_in check_out adults children infants pets guests`.
  Strip: `source_impression_id previous_page_section_name federated_search_id search_mode _set_bev_on_new_domain locale`.
- Price shown: the listing page shows the total for the stay including cleaning and service fees once
  dates are set; some regions show nightly before fees with a "total before taxes" toggle. Record the
  all-in total as `unit: "total"` with the nights in `price_note`.

### Agoda
- Search: `https://www.agoda.com/search?textToSearch={City}&checkIn={YYYY-MM-DD}&checkOut={YYYY-MM-DD}&rooms=1&adults={n}&children=0&currency=USD` now redirects to the homepage; the city page works instead: `https://www.agoda.com/city/{city-slug}-{cc}.html?checkIn={YYYY-MM-DD}&los={nights}&rooms=1&adults={n}&children=0&currencyCode=USD` (US cities carry the state: `seattle-wa-us`).
- Item link: `https://www.agoda.com/{property-slug}/hotel/{city}-{cc}.html?checkIn={YYYY-MM-DD}&los={nights}&adults={n}&rooms=1&children=0&currencyCode=USD`
  Some city pages (Phuket, Oct 2026) open properties by script with no `href` on the cards; then link the
  city page and say "search the name" in `details`. The same happens on some Kayak hotel result pages.
  Keep: `checkIn checkOut los adults children rooms currencyCode`.
  Strip: `cid tag gclid searchrequestid tspTypes showReviewSubmissionEntry travellerType pslc ds`.
- Price shown: usually per night, often before taxes and fees ("+ taxes & fees"); open the room
  list to see the final price. Record per night with `price_note` saying whether taxes are included.

### Hostelworld
- Search: the city page `https://www.hostelworld.com/hostels/{continent}/{country}/{city}/?from={YYYY-MM-DD}&to={YYYY-MM-DD}&guests={n}&currency=USD` (e.g. `/hostels/north-america/usa/seattle/`); the old `/s?q=` search 404s. `deeplinks.py` builds the city page for known countries.
- Property pages: `https://www.hostelworld.com/hostels/p/{id}/{slug}/?from=…&to=…&guests=…&currency=USD` (collect the ids from the city page's links).
- Item link: copy the property URL from the address bar after opening it; it must contain
  `from`, `to` and `guests` (append them if the site dropped them).
- Price shown: per person per night for a dorm bed, or per room for private rooms. Use
  `unit: "per_person_per_night"` for dorm beds.

### Skyscanner (hotels)
- Search: `https://www.skyscanner.com/hotels/search?entity_id={id}&checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&adults={n}&rooms=1&currency=USD`.
  Without `entity_id` the URL lands on the hotel search form: type the city, pick it, and the results
  URL gains the id (Rio de Janeiro 27541837). Prices are per night before taxes; "Cheapest from" is the
  lowest of the sellers it compares.
- Item link: property pages `https://www.skyscanner.com/hotels/{country}/{city}-hotels/{slug}/ht-{id}?checkin=…&checkout=…&adults={n}&rooms=1&currency=USD`
  keep the dates. Harvest them from the results page with `a[href*="/ht-"]` (the `aria-label` is
  "More details about {hotel}"). "Go to site" hands off to the seller, so the Skyscanner page is the
  stable link.

### Expedia (hotels)
- Search: `https://www.expedia.com/Hotel-Search?destination={City}%2C%20{Country}&startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}&adults={n}&rooms=1&sort=RECOMMENDED`
- Item link: property pages `https://www.expedia.com/{City}-Hotels-{Name}.h{id}.Hotel-Information?chkin={YYYY-MM-DD}&chkout={YYYY-MM-DD}&adults={n}` keep the dates; collect them from the results page's links.
- Expedia hotels will not sell more than 28 nights. For longer stays search 28 nights, store the nightly
  average as `per_night`, and say in `trip.notes` that the last nights are booked separately.

### Kayak (hotels)
- Search: `https://www.kayak.com/hotels/{City},{Country}/{YYYY-MM-DD}/{YYYY-MM-DD}/{n}adults?sort=rank_a`;
  Kayak redirects to its own place id (`Rio-de-Janeiro,Brazil-p46811`), which you can keep.
- Item link: none that survives (result cards are buttons, not anchors). Use the results URL as the
  item link, name the hotel exactly, and say "find it by name" in `details`. Prices are per night
  including fees, before taxes (Kayak's default display), so label them that way.

### Google Hotels
- Search: `https://www.google.com/travel/search?q=hotels%20in%20{City}&dates={YYYY-MM-DD},{YYYY-MM-DD}&adults={n}&gl=us&hl=en&curr=USD`; the dates parameter is often ignored ("Prices shown for …"), so set them on the page. Its best use is the Google rating and review count for each property. In a Chrome geolocated abroad it also shows the local currency (pesos in the Philippines): convert and mark the line an estimate with a `source`.
- Item link: open the property; the URL `https://www.google.com/travel/hotels/entity/{id}?...` from
  `location.href` keeps the dates. Google Hotels is best used to compare prices across OTAs for a
  property you already chose, and as the lodging ratings source.

### Trip.com (hotels)
- Search: `https://us.trip.com/hotels/list?city={cityId}&cityName={City}&checkin={YYYY/MM/DD}&checkout={YYYY/MM/DD}&adult={n}&children=0&crn=1&curr=USD&locale=en-US`.
  Use the `us.trip.com` host: `www.trip.com` sent Beijing (city id 1) to the homepage. The `searchWord=` form of this URL returns "0 properties found" in every browser: the list only
  fills with Trip.com's numeric city id (Rio de Janeiro 769; `scripts/deeplinks.py` keeps the known
  ones in `TRIP_CITY_IDS`). To learn a new id, run a Trip.com Car Hire search for the city and read
  `pcity=` from its results URL, or pick the city from the hotel page's own search box and read
  `city=` from the new URL.
- Item link: `https://us.trip.com/hotels/detail/?cityId={cityId}&hotelId={hotelId}&checkIn={YYYY-MM-DD}&checkOut={YYYY-MM-DD}&adult={n}&children=0&crn=1&curr=USD&locale=en-US`
  opens the property with the dates and the total price (verified). Harvest `hotelId` from the list
  with `a[href*="hotels/detail"]` and a `/hotelId=(\d+)/` regex (in Chrome the full href is
  redacted). Totals shown are for the whole stay including taxes & fees.

## Lodging by neighborhood: area searches and tier filters

`deeplinks.py --areas "A,B"` prints these. What narrows each site to one area, and what reaches each tier:

| Site | Area | Budget / mid | Upper / luxury |
|---|---|---|---|
| Airbnb | `/s/{Area}--{City}--{Country}/homes` | `room_types[]=Private room` for budget; `price_max=` | `price_min=`; "Luxe" / guest-favourite listings |
| Booking.com | `ss={Area}, {City}` (pick the district suggestion if it bounces) | `order=price`; `nflt=ht_id%3D203` hostels | `nflt=class%3D4` / `class%3D5` |
| Expedia | `destination={Area}, {City}, {Country}` | `sort=PRICE_LOW_TO_HIGH` | `star=40` / `star=50` |
| Kayak | `/hotels/{Area},{City},{Country}/…` or its Neighborhood filter | `sort=price_a` | Stars filter |
| Google Hotels | `q=hotels in {Area}, {City}` | sort by lowest price | 4- and 5-star filter |
| Skyscanner, Agoda, Trip.com | city search, then the map / Area / Location filter | price sort | star filter |
| Hostelworld | city search, map view (no area URL) | dorms, private rooms | none: record `gaps` |

## Results pages for the Master Search List

`deeplinks.py --search-links` prints one results URL per vendor × category. These are the patterns it
relies on beyond the ones above (all verified in live runs):

- Booking.com attractions: `https://www.booking.com/attractions/searchresults/{cc}/{city-slug}.html?start_date=…&end_date=…&selected_currency=USD`
  (the `/things-to-do/city/` page is a guide without a result list).
- Agoda lodging: the city page `https://www.agoda.com/city/{city-slug}-{cc}.html?checkIn=…&los={nights}&adults=…&rooms=1&children=0&currencyCode=USD`;
  its prices are "average per night", not quotes for the dates, so label them estimates.
- Expedia things to do: the location URL Expedia rewrites to (with `rid=`) keeps the dates; copy it from the address bar.
- Skyscanner hotels and car hire, Kayak hotels, Trip.com hotels and car hire: results URLs need the
  site's own ids. Known ids live in the tables at the top of `deeplinks.py`; add new ones as you learn them.

## China and other destinations with gaps

- Airbnb has no listings or experiences in mainland China: its Beijing search redirects to wherever your
  Chrome is (Manila, Bangkok).
  Record Airbnb lodging and activities as `no-inventory` and say why.
- Booking.com Cars returned no cars at PEK; Expedia, Skyscanner and Kayak show Hertz, and Trip.com
  shows local suppliers. Add the licence note: mainland China does not accept foreign licences or the
  International Driving Permit (a Chinese temporary permit is needed).
- Google is blocked in China, so Google Maps ratings there are few and often for the wrong branch.
  For restaurants use Trip.com's restaurant pages (best branch match, `trip.com/restaurant/china/{city}/detail/…`;
  find them with a Google search `site:trip.com/restaurant {Chinese name} {branch}`) or Tripadvisor;
  put the page in `rating_url` and the site in `rating_source`. Tripadvisor's own search is an AI box
  that returns nothing to scripts: search Google for "tripadvisor {name} {city}" instead.
- **Map coordinates in mainland China:** Booking.com, Skyscanner, Google Hotels and Expedia hand out
  GCJ-02 (China's legally offset datum), about 550 m north-east of the real spot in Beijing; Trip.com
  gives WGS84; Agoda cards give none. Record `coord_datum` per site and let `import_area_stays.py`
  convert, or the pins land a block or two off on OpenStreetMap. Measured Oct 2026 by matching the
  same hotels across sites (≈550 m apart raw, ≈40 m after conversion).
- Beijing per-neighborhood stays (Oct 2026): only Sanlitun has its own area search on Booking.com
  (elsewhere use the distance-from-landmark filter); Agoda's areas are wide ("Back Lakes" spans Houhai,
  Gulou and Guijie) and its cards show only "x m from <station>"; Hostelworld has just 4 hostels inside
  the six tourist areas; Expedia sells little for 28+ nights in the hutong areas; the hutong areas
  have few 5-star hotels on any site. Google Hotels shows a 30-night price for only ~30% of listings.
- Beijing ids: Booking.com `dest_id=-1898541` (`BOOKING_DEST`), Hostelworld city 811, Trip.com city 1,
  Skyscanner hotel entity 27545090, car place PEK 128668664, Kayak `Beijing-c3286`, GetYourGuide 186.
- Hertz at PEK (Expedia, Skyscanner) and Trip.com's local suppliers show no ratings anywhere: set
  `rating_source` to say so rather than leaving it blank.
- GetYourGuide showed "No results" for dates a year out; drop the dates to browse and use other
  vendors' prices.

## Rental cars

Search every vendor that has cars: Booking.com (cars.booking.com), Skyscanner Car Hire, Trip.com
Car Hire, plus Kayak as the cross-check. All three vendor car engines are form-driven: open the
link, enter the city/airport and times, copy the results URL, then open the specific offer and copy
its URL as the item link.


- Kayak: `https://www.kayak.com/cars/{IATA}/{YYYY-MM-DD}-10h/{YYYY-MM-DD}-10h` (airport code; a city name can resolve to a suburb) — results-level
  deep link; "View Deal" opens the rental company's page, whose URL is rarely stable.
- Expedia: `https://www.expedia.com/carsearch?locn={IATA}&date1={MM/DD/YYYY}&time1=1000&date2={MM/DD/YYYY}&time2=1000` — results level.
- Booking.com Cars: `https://cars.booking.com/search-results?locationIata={IATA}&dropLocationIata={IATA}&puDay={D}&puMonth={M}&puYear={YYYY}&puHour=10&puMinute=0&doDay={D}&doMonth={M}&doYear={YYYY}&doHour=10&doMinute=0&driversAge=35&prefcurrency=USD&preflang=en&cor=us`
  is a clean results-level deep link (`deeplinks.py` prints it). The pane gets an empty page from
  this engine; Claude in Chrome read 41 cars for GIG. Strip `aid`, `affiliateCode`, `label`,
  `adcamp`, `adplat` and `vehicleId` from any URL you copy. Rentalcars.com's old
  `SearchResults.do?ftsType=A…` form of the same engine returns an error page.
- Discover Cars: `https://www.discovercars.com/` → fill the form, copy the results URL.
- Skyscanner Car Hire: `https://www.skyscanner.com/carhire` → form (type the airport, pick the
  "(GIG)" suggestion, pick dates from the month combobox), then copy the results URL
  `https://www.skyscanner.com/carhire/results/{pickup-id}/{dropoff-id}/{YYYY-MM-DDTHH:MM}/{YYYY-MM-DDTHH:MM}/{driver-age}`
  (Rio Galeão pick-up id 95673347; these ids differ from the hotel `entity_id`). Results-level link;
  "Show deals" opens the broker (Rentcars.com, Priceline, QEEQ, Movida). Works in Chrome; the pane
  gets the robot check.
  For Phuket (Oct 2026) Car Hire showed the PerimeterX "Are you a person or a robot?" check in Chrome
  too, and then in the pane: leave it for the user to answer (playbook §4c) and record `blocked` if they cannot.
- Trip.com Car Hire: `https://us.trip.com/carhire/?locale=en-US&curr=USD` → form, copy the results URL
  (`/carhire/online/list?…pcity={cityId}&pcode={IATA}&ptime={YYYY/MM/DD HH:MM}&rtime=…&age=30-60`).
  A 31-day rental at GIG returned "No suitable cars found": that is `no-inventory`, not `blocked`.
- Rental company direct (Sixt, Hertz, Europcar, Enterprise): the quote page URL after selecting a
  car usually survives a reload; capture it as the item link when it does.
- Price shown: total for the rental period; note whether it includes basic insurance and whether a
  deposit or one-way fee applies.

## Activities

Vendor cells with activities: Expedia Things to Do (`https://www.expedia.com/things-to-do/search?location={City}&startDate=…&endDate=…`), Airbnb Experiences (`/s/{City}--{Country}/experiences?checkin=…&checkout=…&currency=USD`), Booking.com Attractions
(city page `https://www.booking.com/things-to-do/city/{cc}/{city-slug}.html?selected_currency=USD`; the `attractions/searchresults` form 404s),
Trip.com Things to Do (`https://www.trip.com/things-to-do/list?keyword={City}`), Agoda Activities
(form). Product pages on all of them have stable URLs: open the activity and copy `location.href`.

## Added sources for activities and daily spend

- GetYourGuide: the `/s/?q={City}` search ignores the city in the browser pane; open the location page instead (`https://www.getyourguide.com/{city}-l{id}/?date_from=…&date_to=…`, e.g. `seattle-l198`; find the id with a web search for "getyourguide {city}"). Prices show in USD and activity pages have stable URLs (`…-t{id}/`).
- Viator: `https://www.viator.com/searchResults/all?text={City}`; product pages have stable URLs.
- Airbnb Experiences: `https://www.airbnb.com/s/{City}/experiences?checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}`.
- Daily food/transport estimates: Numbeo `https://www.numbeo.com/cost-of-living/in/{City}` and
  BudgetYourTrip `https://www.budgetyourtrip.com/{country}`. Always `verified: false`; the `url` is
  the source page, which satisfies the "no homepage" rule because it is destination-specific.
- Travel insurance quotes: SafetyWing `https://safetywing.com/nomad-insurance/`, World Nomads
  `https://www.worldnomads.com/travel-insurance/`. Estimates unless you read a quote for the dates.

## Checked-bag fees

See `references/baggage.md`: the routine and the airlines' official baggage pages. The item URL
for a bag-fee line is that official page.

## Map and places

- Geocoding (no key): `https://nominatim.openstreetmap.org/search?q={query}&format=json&limit=1`
  (use `scripts/geocode.py`, which sends the required User-Agent and waits 1 s between calls).
- Places near a stay: the dashboard queries the Overpass API (`https://overpass-api.de/api/interpreter`)
  live in the browser. No key, no setup.
- Ratings: OpenStreetMap has none. For the curated hospital pins, read the rating on the place's
  Google Maps page (`https://www.google.com/maps/search/{name}%20{City}`) and store that URL as
  `rating_source_url`. Every live POI in the dashboard also gets an "Open in Google Maps" link so the
  user can see ratings there.

## Airport transfers and ride apps

- **Uber**: the estimator (`https://www.uber.com/global/en/price-estimate/`) takes pickup and drop-off,
  then shows "Log in to see ride options": never sign in. Check `https://www.uber.com/global/en/cities/`
  first; Uber is absent from Thailand and most of Southeast Asia (sold to Grab in 2018). Where it
  operates, the dashboard's map builds Uber's universal link (`m.uber.com/ul/?action=setPickup…`) for
  the selected stay; set `trip.uber_available: false` where it does not.
- **Bolt** publishes route-price pages per city:
  `https://bolt.eu/en/cities/{city}/route/{from-slug}-to-{to-slug}/` (e.g. Phuket airport → Patong
  Beach, THB 570.60) with every class; read them in Chrome and mark them verified.
- **Grab** publishes no fares; use dated traveler reports and label the line an estimate.
- **Airport counters**: the airport's own site lists the official limousine / taxi operator, often with
  fixed zone fares (Phuket: phuketairportlimousine.com, 650–800 THB by zone).
- **Pre-booked**: Booking.com Attractions has airport-transfer products with stable URLs and ratings;
  GetYourGuide and Kiwitaxi likewise. taxi.booking.com redirects to taxis.booking.com, which only
  prices after a form search.

## SIMs and eSIMs

- Operators' tourist SIM pages give official prices (Thailand: `ais.th/travellersim`,
  `true.th/en/prepaid/sim/tourist`; dtac's page now redirects to True).
- eSIMs: Airalo (`airalo.com/{country}-esim?currency=USD`), Holafly, Nomad (`nomadesim.com`), Saily
  (blocks automated reads; check in Chrome). Ratings: Trustpilot pages.

## Ratings by site (where the number sits on the results page)

Booking.com `[data-testid=review-score]` (x/10 + count); Airbnb card text "4.92 (13)" or "4.9 out of 5
average rating"; Expedia "9.2 out of 10 … 151 reviews"; Agoda score + "N reviews"; Hostelworld
"9.8 (2,049)"; Skyscanner "4.3/5 … 5,495 reviews"; Trip.com "8.9 … 1,935 reviews"; Kayak hotels
"8.6 Excellent (1,689)", Kayak cars show only a deal score; Booking.com Cars "Customer rating 8.2 …
600+ reviews" per rental company; Expedia cars "8.4 Very good 5 reviews"; Trip.com cars "9.1/10 … 1064
review(s)"; Google Maps `div.F7nice` "4.4 (6,736)"; Trip.com restaurants "4.8 /5 … 89 reviews".

When nothing rates a line (a brand-new listing, a rental desk with no Google entry), set only
`rating_source` with the reason ("New Vrbo listing, no reviews yet"): the page shows "No rating · …"
and the build counts it as checked. Add `rating_url` whenever the rating came from a page other than
the line's own link.

## Learned ids and quirks (Rio de Janeiro, Oct 2026)

- Agoda: the /city/rio-de-janeiro-br.html page gives no date-specific prices; type the city in Agoda's
  own box to get `search?city=7395&checkIn=…&los=30`. Few Rio places can be booked for 30 nights
  (23–79 per area), and repeat runs of the same filter loaded more each time.
- Expedia and some Trip.com stays only price up to 28 nights: record `total_28_nights` (the import turns
  it into a nightly average). Hostelworld ignored the URL dates again (set them in its form) and had only
  ~36 Rio places for a month, none in Leblon.
- Google Hotels showed Thai baht in this Chrome and its price for the same hotel moved up to ~40%
  between reloads: keep those lines as estimates. GetYourGuide and Viator showed pesos.
- Kayak's "Security Check" did not appear on Oct 27 (it did on Oct 25). Agoda Flights still drops the
  origin and date.
- 5-star hotels with a 30-night price are scarce: Copacabana Palace priced only on Expedia; Fasano and
  Sofitel Ipanema sold out. Airbnb fills every tier in every area (monthly prices, shifted map pins).
- Overnight flights from the US leave on the check-in evening and land the next morning: say so in
  `trip.notes` (the first night is unused) and start car hire the morning after.

## Learned ids and quirks (Bangkok, Oct 2026)

- Booking.com: `ss=Bangkok, Thailand` bounces to the homepage; `ss=Bangkok&dest_id=-3414440&dest_type=city`
  works (`BOOKING_DEST` in deeplinks.py). Trip.com city 359; Skyscanner hotel entity 27536671 and car
  place 95673349 (BKK); Kayak hotels `Bangkok,Thailand-p18056` (the city form can resolve to the
  airport: re-pick the city); Agoda dated search `city=9395`; Hostelworld ignores URL dates (set them in
  its form); GetYourGuide `bangkok-l169`.
- Kayak flights hide "longer flights" by default; add `fs=baditin%3Dbaditin` to see every result.
