# Tier definitions

The dashboard has four tabs. Each tier is a coherent way to take the same trip, not just a price
band: the luxury traveler flies up front *and* stays at the five-star *and* books the private tour.
Keep the categories consistent within a tier so the total means something.

| Tier id | Label | The traveler |
|---|---|---|
| `budget` | Budget | Backpacker / student: cheapest safe options, public transit, street food |
| `mid` | Mid-tier | Typical couple or family: comfortable 3-star, economy nonstop, rental compact, restaurant dinners |
| `upper` | Upper class | Boutique 4-star, premium economy or short-haul business, guided tours, nice dinners |
| `luxury` | Luxury | Five-star or luxury brand, business/first, private driver or premium car, private tours, fine dining |

## Per category

| Category | Budget | Mid-tier | Upper class | Luxury |
|---|---|---|---|---|
| Flights | cheapest fare, ≤1 stop, basic economy acceptable | main-cabin economy, nonstop if available | premium economy (business on flights under ~5 h) | business or first on a full-service carrier |
| Lodging | hostel dorm or private room, guesthouse, private room on Airbnb, rating ≥ 8.0 | 3-star hotel or entire Airbnb apartment, rating ≥ 8.3 | 4-star / boutique hotel or design apartment, rating ≥ 8.7 | 5-star or luxury brand (Four Seasons, Aman, Mandarin Oriental, Ritz-Carlton, top local palace hotels), rating ≥ 9.0 |
| Rental car | none (transit) or cheapest economy car, unchecked | compact / intermediate | mid-size SUV or premium sedan | luxury class, or private driver per day |
| Activities | free walking tour, self-guided, public museums | 2–3 group tours or tickets | small-group or skip-the-line tours, a day trip | private guides, private day trip, exclusive experiences |
| Food & daily spend | street food, groceries, one cheap restaurant meal | mix of casual restaurants | good restaurants, one tasting menu | fine dining, hotel breakfast, chauffeured transfers |
| Local transport | metro / bus pass | transit plus occasional rideshare | rideshare and taxis | private transfers |
| Insurance | basic medical (e.g. SafetyWing) | standard trip insurance | comprehensive with cancellation | comprehensive plus premium medical evacuation |

## Choosing tiers from what the site shows

Fixed dollar thresholds fail across destinations. Use the price distribution on the results page
for the user's dates instead:

- **Budget**: cheapest 20% of well-rated options (ignore anything with a rating below 7.5 or fewer
  than ~30 reviews; a cheap bad stay is not a budget option, it is a bad option).
- **Mid-tier**: 30th–60th percentile.
- **Upper class**: 70th–90th percentile, or any 4-star with ≥ 8.7.
- **Luxury**: top 5%, or recognised luxury brands regardless of where they fall.

When a destination simply has no luxury supply (small towns, islands with one resort), say so and
fill the tier with the best available option plus a note.

## Daily spend estimates

Take M = the destination's "meal, inexpensive restaurant" price from Numbeo (or an equivalent
local figure) and estimate food per person per day as:

| Tier | Food/day | Local transport/day |
|---|---|---|
| budget | 2.5 × M | one transit day pass |
| mid | 4 × M | transit pass + 1 short rideshare |
| upper | 7 × M | 2–3 rideshares |
| luxury | 12 × M | private transfer / driver (quote from a chauffeur service when possible) |

These are always `verified: false` with the Numbeo page as `url` and `source`. The user sees an
"Estimate" badge and can uncheck the line.

## Travelers and rooms

- Two adults share one room or listing: lodging `unit` is `per_night` or `total`, never per person.
- Dorm beds are per person per night (`per_person_per_night`).
- Three or more adults: note the room configuration in `details` and make `qty` explicit when two
  rooms are needed.
- Children change flight and room pricing; carry them through to the deep links (`children`
  parameters) and mention them in `price_note`.
