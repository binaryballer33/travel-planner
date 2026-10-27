# Entry requirements (the red banner)

The dashboard opens with a banner that tells the traveler, in plain words, whether they need anything
before they fly: a visa or e-visa, an electronic travel authorization (ETA, ETIAS, ESTA-style), an
arrival card or health form, vaccines, malaria tablets, or a passport with enough validity. Any item
with status `required` turns the banner red; `recommended` items alone make it amber; nothing needed
gives a small green line. The banner is a collapsible panel: open by default, with a Hide/Show details toggle.

Check the **origin** too: some countries require proof of yellow fever vaccination only when you arrive from a yellow-fever country (Turkey, China, many others), and a round trip back to a visa country (Brazil) needs that visa to still be valid.

## Who it is for

Default to **US citizens** (US passport holders) unless the user says otherwise. If the user gives a
nationality or the trip starts outside the US, still research for the US passport unless told
otherwise, and say so in `nationality`.

## Where to read it (in this order)

1. **State Department country page**: `https://travel.state.gov/en/international-travel/travel-advisories/{country}.html`
   ("Travel requirements": tourist visa, vaccinations, passport validity, blank pages, currency).
   The site blocks the fetch tool; open it in the user's Chrome (or the pane).
2. **CDC Travelers' Health**: `https://wwwnc.cdc.gov/travel/destinations/traveler/none/{country}`
   (yellow fever recommendation by state/region, malaria areas, other vaccines). Match the
   destination city: Rio de Janeiro and Manaus get the yellow-fever recommendation; Manaus (all of
   Amazonas state) also gets malaria prevention.
3. **The official visa / authorization portal** for how to apply, fee, processing time and validity
   (Brazil e-Visa: brazil.vfsevisa.com; China: Chinese Visa Application Service Center; ETIAS:
   travel-europe.europa.eu/etias_en).
4. **Arrival forms**: search "{country} arrival card online {year}" and confirm on a government site
   (China's online arrival card has been mandatory for foreigners since 20 Nov 2025).

Note transit rules only when they fit the trip: China's 240-hour visa-free transit needs an onward
ticket to a third country within 10 days, so it never covers a month-long stay.

## JSON shape

```json
"entry": {
  "nationality": "US citizens",
  "checked_at": "2026-10-25",
  "headline": "Brazil e-Visa required",
  "items": [
    { "status": "required", "title": "Brazil e-Visa",
      "text": "US citizens need a visa approved before they fly (rule back in force since 10 Apr 2025)...",
      "url": "https://brazil.vfsevisa.com/", "link_label": "Apply for the e-Visa" },
    { "status": "recommended", "title": "Yellow fever vaccine", "text": "Not required to enter; CDC recommends it for ...",
      "url": "https://wwwnc.cdc.gov/travel/destinations/traveler/none/brazil" },
    { "status": "info", "title": "Passport", "text": "Valid for at least one month on entry ..." },
    { "status": "not-required", "title": "Arrival card or health form", "text": "None listed ..." }
  ],
  "sources": [ { "label": "State Department: Brazil", "url": "https://travel.state.gov/en/international-travel/travel-advisories/brazil.html" } ]
}
```

`status` is one of `required`, `recommended`, `info`, `not-required`. Write `text` for a reader who
has never travelled there: what to do, how much it costs, how long it takes. Always cite sources and
set `checked_at`; the banner tells the user to confirm on the official links before booking.

## Researched so far (US citizens, checked 25 Oct 2026)

| Destination | Required | Recommended | Notes |
|---|---|---|---|
| Brazil | e-Visa (US$80.90, up to 10 years, 90 days per visit) | Yellow fever for most states incl. Rio de Janeiro and Amazonas; malaria tablets for Amazonas (Manaus) | Passport valid 1 month on entry; no arrival card |
| China | L tourist visa; online arrival card | – | Passport valid 6 months beyond arrival, 2 blank pages; register address within 24 h (hotels do it) |
| Portugal / Schengen | – | ETIAS once live (due Q4 2026, with a transition period) | EES biometrics at first entry; passport valid 3 months beyond departure |
| United States (returning) | – | – | US passport; Mobile Passport Control optional |
| Turkey (arriving from Brazil) | Yellow fever certificate (ICVP), because Brazil is a yellow-fever country; a still-valid Brazil e-Visa for the flight back to Rio | Hepatitis A and B, meningitis, tetanus | No visa for 90 days; passport valid 6 months beyond arrival |
