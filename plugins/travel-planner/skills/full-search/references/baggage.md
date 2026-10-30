# Checked-bag fees

Budget fares on most carriers exclude checked bags, and the fee is often the difference between
the "cheapest" and the "mid" option. Every flight line in the dashboard gets a companion line for
checked bags so the user sees the real cost and can untick it if they travel carry-on only.

## Routine

1. From the itinerary, note the **operating airline(s)** and the **fare class / brand name**
   (Basic Economy, Light, Economy Standard, Main Cabin, Flex…). Google Flights shows a bag icon
   per itinerary ("1 checked bag included" / "no checked bag"); Skyscanner and Trip.com show it in
   the fare details after you click.
2. Open the airline's **official checked-baggage page** (table below) in the browser and read the
   fee for the route type (domestic / transatlantic / intra-Europe…), fare brand and bag number.
   When the page gives a range or "from", take the price for the first bag and say so.
3. Record a `flights` item named like "Checked bags: TAP Light fare, 1 × 23 kg each way", with
   `price` = the round-trip cost of one bag per person, `unit: "per_person"`, `url` = the airline's
   baggage page (a direct page, not the airline homepage), `verified: true` only if you read it on
   that page today, and `details` explaining what is included. Put it in the same tiers as the
   flight it belongs to, `default_on: true` when the fare excludes a bag, `default_on: false` when
   the fare already includes one (keep the line so the user sees the allowance).
4. Mixed-carrier itineraries: the first marketing carrier's rules usually apply to the whole
   ticket; say which airline's fee you used.

## Official baggage pages

Airlines move these pages; if one 404s, search "{airline} checked baggage fees" and link the
official page you land on. Never link a third-party fee aggregator as the item URL.

| Airline | Checked-bag page |
|---|---|
| American Airlines | https://www.aa.com/i18n/travel-info/baggage/checked-baggage-policy.jsp |
| Delta | https://www.delta.com/us/en/baggage/checked-bags |
| United | https://www.united.com/en/us/fly/baggage/checked-bags.html |
| Southwest | https://www.southwest.com/help/baggage/checked-bags |
| JetBlue | https://www.jetblue.com/help/checked-bags |
| Alaska | https://www.alaskaair.com/content/travel-info/baggage/checked-bags |
| Spirit | https://www.spirit.com/bags |
| Frontier | https://www.flyfrontier.com/travel/travel-info/bag-options/ |
| Allegiant | https://www.allegiantair.com/baggage |
| Hawaiian | https://www.hawaiianairlines.com/travel-information/baggage/checked-baggage |
| Air Canada | https://www.aircanada.com/us/en/aco/home/plan/baggage/checked.html |
| WestJet | https://www.westjet.com/en-ca/baggage/checked-bags |
| Aeromexico | https://aeromexico.com/en-us/travel-information/baggage |
| LATAM | https://www.latamairlines.com/us/en/experience/prepare-your-trip/baggage |
| Avianca | https://www.avianca.com/en/your-booking/travel-info/baggage/ |
| British Airways | https://www.britishairways.com/en-us/information/baggage-essentials/checked-baggage |
| Lufthansa | https://www.lufthansa.com/us/en/baggage-overview |
| Swiss | https://www.swiss.com/us/en/prepare/baggage |
| KLM | https://www.klm.com/information/baggage/checked-baggage |
| Air France | https://wwws.airfrance.us/information/bagages/bagages-en-soute |
| Iberia | https://www.iberia.com/us/baggage/ |
| TAP Air Portugal | https://www.flytap.com/en-us/baggage/checked-baggage |
| Aer Lingus | https://www.aerlingus.com/travel-information/baggage-information/checked-baggage/ |
| Finnair | https://www.finnair.com/us-en/baggage/checked-baggage |
| SAS | https://www.flysas.com/en/travel-info/baggage/checked-baggage/ |
| Icelandair | https://www.icelandair.com/support/baggage/checked-baggage/ |
| Norse Atlantic | https://flynorse.com/travel-info/baggage |
| Ryanair | https://www.ryanair.com/gb/en/useful-info/help-centre/fees |
| easyJet | https://www.easyjet.com/en/help/baggage/cabin-bag-and-hold-luggage |
| Wizz Air | https://wizzair.com/en-gb/information-and-services/travel-information/baggage |
| Turkish Airlines | https://www.turkishairlines.com/en-int/any-questions/free-baggage/ |
| Emirates | https://www.emirates.com/us/english/before-you-fly/baggage/checked-baggage/ |
| Qatar Airways | https://www.qatarairways.com/en/baggage/allowance.html |
| Etihad | https://www.etihad.com/en-us/fly-etihad/baggage |
| Singapore Airlines | https://www.singaporeair.com/en_UK/us/travel-info/baggage/checked-baggage/ |
| Cathay Pacific | https://www.cathaypacific.com/cx/en_US/baggage/check-in-baggage.html |
| ANA | https://www.ana.co.jp/en/us/travel-information/baggage-information/ |
| Japan Airlines | https://www.jal.co.jp/jp/en/inter/baggage/checked/ |
| EVA Air | https://www.evaair.com/en-us/fly-prepare/baggage/checked-baggage/ |
| Qantas | https://www.qantas.com/us/en/travel-info/baggage/checked-baggage.html |
| Air New Zealand | https://www.airnewzealand.com/baggage |
| Jetstar | https://www.jetstar.com/au/en/help/articles/baggage |

Low-cost carriers (Spirit, Frontier, Ryanair, easyJet, Wizz, AirAsia, Scoot, Volaris, Viva)
price bags by weight band and by when you buy (online in advance vs. at the airport); record the
advance online price and note the airport price in `details`.
