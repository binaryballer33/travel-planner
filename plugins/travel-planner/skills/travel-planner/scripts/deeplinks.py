#!/usr/bin/env python3
"""Generate provider search deep links for a trip, or clean captured listing URLs.

Only four inputs are required: origin, destination, check-in, check-out. Cities may be names or
airport codes in any casing; dates may be mm-dd-yyyy, mm/dd/yyyy or yyyy-mm-dd. A fifth positional
value is the number of travelers (default 1).

  python3 deeplinks.py "Los Angeles" Lisbon 11/10/2026 11/17/2026 2
  python3 deeplinks.py lax lis 11-10-2026 11-17-2026 --travelers 2 --cabin business
  python3 deeplinks.py --origin LAX --dest "Lisbon, Portugal" --checkin 2026-11-10 --checkout 2026-11-17 --json
  python3 deeplinks.py --suggest rio          # city/airport matches for a partial, case-insensitive
  python3 deeplinks.py --clean "https://www.booking.com/hotel/pt/x.html?checkin=2026-11-10&aid=123&label=abc"
  python3 deeplinks.py --cities-json          # the city table, for assets/trip-request-form.html

Output is grouped by vendor so every vendor gets searched for every category it offers; the
coverage checklist at the end is what the trip JSON "coverage" object must account for.
"""
import argparse
import json
import re
import sys
import unicodedata
from datetime import date, datetime
from urllib.parse import quote, urlsplit, urlunsplit, parse_qsl, urlencode

CABIN = {
    "economy": {"google": "", "sky": "economy", "trip": "y", "kayak": ""},
    "premium": {"google": " in premium economy", "sky": "premiumeconomy", "trip": "s", "kayak": "/premium"},
    "business": {"google": " in business class", "sky": "business", "trip": "c", "kayak": "/business"},
    "first": {"google": " in first class", "sky": "first", "trip": "f", "kayak": "/first"},
}

# city (lowercase, ascii) -> (main international airport IATA, country). Edit freely.
CITIES = {
    # North America
    "los angeles": ("LAX", "United States"), "la": ("LAX", "United States"), "new york": ("JFK", "United States"),
    "nyc": ("JFK", "United States"), "new york city": ("JFK", "United States"), "chicago": ("ORD", "United States"),
    "san francisco": ("SFO", "United States"), "sf": ("SFO", "United States"), "miami": ("MIA", "United States"),
    "dallas": ("DFW", "United States"), "houston": ("IAH", "United States"), "atlanta": ("ATL", "United States"),
    "boston": ("BOS", "United States"), "seattle": ("SEA", "United States"), "washington": ("IAD", "United States"),
    "washington dc": ("IAD", "United States"), "dc": ("IAD", "United States"), "denver": ("DEN", "United States"),
    "las vegas": ("LAS", "United States"), "orlando": ("MCO", "United States"), "phoenix": ("PHX", "United States"),
    "philadelphia": ("PHL", "United States"), "san diego": ("SAN", "United States"), "austin": ("AUS", "United States"),
    "nashville": ("BNA", "United States"), "new orleans": ("MSY", "United States"), "honolulu": ("HNL", "United States"),
    "maui": ("OGG", "United States"), "detroit": ("DTW", "United States"), "minneapolis": ("MSP", "United States"),
    "salt lake city": ("SLC", "United States"), "portland": ("PDX", "United States"), "charlotte": ("CLT", "United States"),
    "baltimore": ("BWI", "United States"), "tampa": ("TPA", "United States"), "san jose": ("SJC", "United States"),
    "sacramento": ("SMF", "United States"), "raleigh": ("RDU", "United States"), "st louis": ("STL", "United States"),
    "kansas city": ("MCI", "United States"), "pittsburgh": ("PIT", "United States"), "cleveland": ("CLE", "United States"),
    "anchorage": ("ANC", "United States"), "toronto": ("YYZ", "Canada"), "vancouver": ("YVR", "Canada"),
    "montreal": ("YUL", "Canada"), "calgary": ("YYC", "Canada"), "mexico city": ("MEX", "Mexico"), "cancun": ("CUN", "Mexico"),
    "guadalajara": ("GDL", "Mexico"), "cabo": ("SJD", "Mexico"), "cabo san lucas": ("SJD", "Mexico"), "los cabos": ("SJD", "Mexico"),
    "puerto vallarta": ("PVR", "Mexico"), "oaxaca": ("OAX", "Mexico"), "tulum": ("TQO", "Mexico"),
    # Caribbean & Central America
    "san juan": ("SJU", "Puerto Rico"), "punta cana": ("PUJ", "Dominican Republic"), "santo domingo": ("SDQ", "Dominican Republic"),
    "montego bay": ("MBJ", "Jamaica"), "kingston": ("KIN", "Jamaica"), "nassau": ("NAS", "Bahamas"), "havana": ("HAV", "Cuba"),
    "san jose costa rica": ("SJO", "Costa Rica"), "liberia": ("LIR", "Costa Rica"), "panama city": ("PTY", "Panama"),
    "aruba": ("AUA", "Aruba"), "barbados": ("BGI", "Barbados"), "st lucia": ("UVF", "Saint Lucia"), "belize city": ("BZE", "Belize"),
    "guatemala city": ("GUA", "Guatemala"), "san salvador": ("SAL", "El Salvador"), "managua": ("MGA", "Nicaragua"),
    # South America
    "bogota": ("BOG", "Colombia"), "medellin": ("MDE", "Colombia"), "cartagena": ("CTG", "Colombia"), "lima": ("LIM", "Peru"),
    "cusco": ("CUZ", "Peru"), "santiago": ("SCL", "Chile"), "buenos aires": ("EZE", "Argentina"), "sao paulo": ("GRU", "Brazil"),
    "rio de janeiro": ("GIG", "Brazil"), "rio": ("GIG", "Brazil"), "quito": ("UIO", "Ecuador"), "galapagos": ("GPS", "Ecuador"),
    "montevideo": ("MVD", "Uruguay"), "la paz": ("LPB", "Bolivia"), "asuncion": ("ASU", "Paraguay"), "caracas": ("CCS", "Venezuela"),
    # Europe
    "london": ("LHR", "United Kingdom"), "manchester": ("MAN", "United Kingdom"), "edinburgh": ("EDI", "United Kingdom"),
    "glasgow": ("GLA", "United Kingdom"), "dublin": ("DUB", "Ireland"), "paris": ("CDG", "France"), "nice": ("NCE", "France"),
    "lyon": ("LYS", "France"), "marseille": ("MRS", "France"), "bordeaux": ("BOD", "France"), "madrid": ("MAD", "Spain"),
    "barcelona": ("BCN", "Spain"), "seville": ("SVQ", "Spain"), "malaga": ("AGP", "Spain"), "palma": ("PMI", "Spain"),
    "mallorca": ("PMI", "Spain"), "ibiza": ("IBZ", "Spain"), "valencia": ("VLC", "Spain"), "bilbao": ("BIO", "Spain"),
    "tenerife": ("TFS", "Spain"), "lisbon": ("LIS", "Portugal"), "porto": ("OPO", "Portugal"), "faro": ("FAO", "Portugal"),
    "algarve": ("FAO", "Portugal"), "madeira": ("FNC", "Portugal"), "funchal": ("FNC", "Portugal"), "azores": ("PDL", "Portugal"),
    "rome": ("FCO", "Italy"), "milan": ("MXP", "Italy"), "venice": ("VCE", "Italy"), "florence": ("FLR", "Italy"),
    "naples": ("NAP", "Italy"), "amalfi": ("NAP", "Italy"), "sicily": ("CTA", "Italy"), "catania": ("CTA", "Italy"),
    "palermo": ("PMO", "Italy"), "bologna": ("BLQ", "Italy"), "turin": ("TRN", "Italy"), "sardinia": ("OLB", "Italy"),
    "amsterdam": ("AMS", "Netherlands"), "brussels": ("BRU", "Belgium"), "bruges": ("BRU", "Belgium"), "luxembourg": ("LUX", "Luxembourg"),
    "berlin": ("BER", "Germany"), "munich": ("MUC", "Germany"), "frankfurt": ("FRA", "Germany"), "hamburg": ("HAM", "Germany"),
    "cologne": ("CGN", "Germany"), "dusseldorf": ("DUS", "Germany"), "stuttgart": ("STR", "Germany"), "zurich": ("ZRH", "Switzerland"),
    "geneva": ("GVA", "Switzerland"), "basel": ("BSL", "Switzerland"), "vienna": ("VIE", "Austria"), "salzburg": ("SZG", "Austria"),
    "innsbruck": ("INN", "Austria"), "prague": ("PRG", "Czechia"), "budapest": ("BUD", "Hungary"), "warsaw": ("WAW", "Poland"),
    "krakow": ("KRK", "Poland"), "gdansk": ("GDN", "Poland"), "copenhagen": ("CPH", "Denmark"), "stockholm": ("ARN", "Sweden"),
    "gothenburg": ("GOT", "Sweden"), "oslo": ("OSL", "Norway"), "bergen": ("BGO", "Norway"), "tromso": ("TOS", "Norway"),
    "helsinki": ("HEL", "Finland"), "reykjavik": ("KEF", "Iceland"), "athens": ("ATH", "Greece"), "santorini": ("JTR", "Greece"),
    "mykonos": ("JMK", "Greece"), "crete": ("HER", "Greece"), "heraklion": ("HER", "Greece"), "rhodes": ("RHO", "Greece"),
    "corfu": ("CFU", "Greece"), "thessaloniki": ("SKG", "Greece"), "istanbul": ("IST", "Turkey"), "antalya": ("AYT", "Turkey"),
    "cappadocia": ("NAV", "Turkey"), "bodrum": ("BJV", "Turkey"), "izmir": ("ADB", "Turkey"), "dubrovnik": ("DBV", "Croatia"),
    "split": ("SPU", "Croatia"), "zagreb": ("ZAG", "Croatia"), "ljubljana": ("LJU", "Slovenia"), "belgrade": ("BEG", "Serbia"),
    "sarajevo": ("SJJ", "Bosnia and Herzegovina"), "tirana": ("TIA", "Albania"), "podgorica": ("TGD", "Montenegro"),
    "skopje": ("SKP", "North Macedonia"), "bucharest": ("OTP", "Romania"), "sofia": ("SOF", "Bulgaria"), "tallinn": ("TLL", "Estonia"),
    "riga": ("RIX", "Latvia"), "vilnius": ("VNO", "Lithuania"), "kyiv": ("KBP", "Ukraine"), "kiev": ("KBP", "Ukraine"),
    "moscow": ("SVO", "Russia"), "st petersburg": ("LED", "Russia"), "malta": ("MLA", "Malta"), "valletta": ("MLA", "Malta"),
    "cyprus": ("LCA", "Cyprus"), "larnaca": ("LCA", "Cyprus"), "paphos": ("PFO", "Cyprus"), "tbilisi": ("TBS", "Georgia"),
    "yerevan": ("EVN", "Armenia"), "baku": ("GYD", "Azerbaijan"), "porto santo": ("PXO", "Portugal"),
    # Middle East
    "dubai": ("DXB", "United Arab Emirates"), "abu dhabi": ("AUH", "United Arab Emirates"), "doha": ("DOH", "Qatar"),
    "riyadh": ("RUH", "Saudi Arabia"), "jeddah": ("JED", "Saudi Arabia"), "muscat": ("MCT", "Oman"), "amman": ("AMM", "Jordan"),
    "petra": ("AMM", "Jordan"), "tel aviv": ("TLV", "Israel"), "jerusalem": ("TLV", "Israel"), "beirut": ("BEY", "Lebanon"),
    "cairo": ("CAI", "Egypt"), "luxor": ("LXR", "Egypt"), "sharm el sheikh": ("SSH", "Egypt"), "hurghada": ("HRG", "Egypt"),
    "manama": ("BAH", "Bahrain"), "kuwait city": ("KWI", "Kuwait"), "tehran": ("IKA", "Iran"),
    # Africa
    "marrakech": ("RAK", "Morocco"), "marrakesh": ("RAK", "Morocco"), "casablanca": ("CMN", "Morocco"), "fez": ("FEZ", "Morocco"),
    "tangier": ("TNG", "Morocco"), "tunis": ("TUN", "Tunisia"), "algiers": ("ALG", "Algeria"), "nairobi": ("NBO", "Kenya"),
    "mombasa": ("MBA", "Kenya"), "cape town": ("CPT", "South Africa"), "johannesburg": ("JNB", "South Africa"),
    "durban": ("DUR", "South Africa"), "zanzibar": ("ZNZ", "Tanzania"), "dar es salaam": ("DAR", "Tanzania"),
    "arusha": ("JRO", "Tanzania"), "kilimanjaro": ("JRO", "Tanzania"), "addis ababa": ("ADD", "Ethiopia"), "accra": ("ACC", "Ghana"),
    "lagos": ("LOS", "Nigeria"), "abuja": ("ABV", "Nigeria"), "mauritius": ("MRU", "Mauritius"), "seychelles": ("SEZ", "Seychelles"),
    "kigali": ("KGL", "Rwanda"), "kampala": ("EBB", "Uganda"), "entebbe": ("EBB", "Uganda"), "dakar": ("DSS", "Senegal"),
    "windhoek": ("WDH", "Namibia"), "victoria falls": ("VFA", "Zimbabwe"), "livingstone": ("LVI", "Zambia"), "lusaka": ("LUN", "Zambia"),
    "maputo": ("MPM", "Mozambique"), "antananarivo": ("TNR", "Madagascar"), "gaborone": ("GBE", "Botswana"),
    # Asia
    "tokyo": ("HND", "Japan"), "osaka": ("KIX", "Japan"), "kyoto": ("KIX", "Japan"), "sapporo": ("CTS", "Japan"),
    "fukuoka": ("FUK", "Japan"), "okinawa": ("OKA", "Japan"), "nagoya": ("NGO", "Japan"), "hiroshima": ("HIJ", "Japan"),
    "seoul": ("ICN", "South Korea"), "busan": ("PUS", "South Korea"), "jeju": ("CJU", "South Korea"), "beijing": ("PEK", "China"),
    "shanghai": ("PVG", "China"), "guangzhou": ("CAN", "China"), "shenzhen": ("SZX", "China"), "chengdu": ("TFU", "China"),
    "xian": ("XIY", "China"), "hangzhou": ("HGH", "China"), "hong kong": ("HKG", "Hong Kong"), "macau": ("MFM", "Macau"),
    "taipei": ("TPE", "Taiwan"), "manila": ("MNL", "Philippines"), "cebu": ("CEB", "Philippines"), "boracay": ("MPH", "Philippines"),
    "palawan": ("PPS", "Philippines"), "el nido": ("ENI", "Philippines"), "bangkok": ("BKK", "Thailand"), "phuket": ("HKT", "Thailand"),
    "chiang mai": ("CNX", "Thailand"), "krabi": ("KBV", "Thailand"), "koh samui": ("USM", "Thailand"), "pattaya": ("UTP", "Thailand"),
    "singapore": ("SIN", "Singapore"), "kuala lumpur": ("KUL", "Malaysia"), "penang": ("PEN", "Malaysia"), "langkawi": ("LGK", "Malaysia"),
    "kota kinabalu": ("BKI", "Malaysia"), "jakarta": ("CGK", "Indonesia"), "bali": ("DPS", "Indonesia"), "denpasar": ("DPS", "Indonesia"),
    "ubud": ("DPS", "Indonesia"), "lombok": ("LOP", "Indonesia"), "yogyakarta": ("YIA", "Indonesia"), "ho chi minh city": ("SGN", "Vietnam"),
    "saigon": ("SGN", "Vietnam"), "hanoi": ("HAN", "Vietnam"), "da nang": ("DAD", "Vietnam"), "hoi an": ("DAD", "Vietnam"),
    "nha trang": ("CXR", "Vietnam"), "phu quoc": ("PQC", "Vietnam"), "phnom penh": ("PNH", "Cambodia"), "siem reap": ("SAI", "Cambodia"),
    "vientiane": ("VTE", "Laos"), "luang prabang": ("LPQ", "Laos"), "yangon": ("RGN", "Myanmar"), "delhi": ("DEL", "India"),
    "new delhi": ("DEL", "India"), "mumbai": ("BOM", "India"), "bangalore": ("BLR", "India"), "bengaluru": ("BLR", "India"),
    "goa": ("GOI", "India"), "chennai": ("MAA", "India"), "hyderabad": ("HYD", "India"), "kolkata": ("CCU", "India"),
    "jaipur": ("JAI", "India"), "kochi": ("COK", "India"), "kathmandu": ("KTM", "Nepal"), "colombo": ("CMB", "Sri Lanka"),
    "male": ("MLE", "Maldives"), "maldives": ("MLE", "Maldives"), "dhaka": ("DAC", "Bangladesh"), "karachi": ("KHI", "Pakistan"),
    "lahore": ("LHE", "Pakistan"), "islamabad": ("ISB", "Pakistan"), "tashkent": ("TAS", "Uzbekistan"), "samarkand": ("SKD", "Uzbekistan"),
    "almaty": ("ALA", "Kazakhstan"), "astana": ("NQZ", "Kazakhstan"), "bishkek": ("FRU", "Kyrgyzstan"), "ulaanbaatar": ("UBN", "Mongolia"),
    "thimphu": ("PBH", "Bhutan"), "paro": ("PBH", "Bhutan"),
    # Oceania
    "sydney": ("SYD", "Australia"), "melbourne": ("MEL", "Australia"), "brisbane": ("BNE", "Australia"), "perth": ("PER", "Australia"),
    "adelaide": ("ADL", "Australia"), "cairns": ("CNS", "Australia"), "gold coast": ("OOL", "Australia"), "hobart": ("HBA", "Australia"),
    "darwin": ("DRW", "Australia"), "auckland": ("AKL", "New Zealand"), "queenstown": ("ZQN", "New Zealand"),
    "wellington": ("WLG", "New Zealand"), "christchurch": ("CHC", "New Zealand"), "fiji": ("NAN", "Fiji"), "nadi": ("NAN", "Fiji"),
    "tahiti": ("PPT", "French Polynesia"), "papeete": ("PPT", "French Polynesia"), "bora bora": ("BOB", "French Polynesia"),
    "guam": ("GUM", "Guam"), "noumea": ("NOU", "New Caledonia"), "port moresby": ("POM", "Papua New Guinea"),
    # more North America
    "fort lauderdale": ("FLL", "United States"), "west palm beach": ("PBI", "United States"), "key west": ("EYW", "United States"),
    "savannah": ("SAV", "United States"), "charleston": ("CHS", "United States"), "asheville": ("AVL", "United States"),
    "memphis": ("MEM", "United States"), "louisville": ("SDF", "United States"), "cincinnati": ("CVG", "United States"),
    "columbus": ("CMH", "United States"), "indianapolis": ("IND", "United States"), "milwaukee": ("MKE", "United States"),
    "omaha": ("OMA", "United States"), "oklahoma city": ("OKC", "United States"), "tulsa": ("TUL", "United States"),
    "albuquerque": ("ABQ", "United States"), "santa fe": ("SAF", "United States"), "el paso": ("ELP", "United States"),
    "san antonio": ("SAT", "United States"), "boise": ("BOI", "United States"), "spokane": ("GEG", "United States"),
    "reno": ("RNO", "United States"), "tucson": ("TUS", "United States"), "palm springs": ("PSP", "United States"),
    "santa barbara": ("SBA", "United States"), "monterey": ("MRY", "United States"), "fresno": ("FAT", "United States"),
    "oakland": ("OAK", "United States"), "burbank": ("BUR", "United States"), "long beach": ("LGB", "United States"),
    "orange county": ("SNA", "United States"), "ontario": ("ONT", "United States"), "jacksonville": ("JAX", "United States"),
    "richmond": ("RIC", "United States"), "norfolk": ("ORF", "United States"), "buffalo": ("BUF", "United States"),
    "rochester": ("ROC", "United States"), "albany": ("ALB", "United States"), "hartford": ("BDL", "United States"),
    "providence": ("PVD", "United States"), "burlington": ("BTV", "United States"), "portland maine": ("PWM", "United States"),
    "des moines": ("DSM", "United States"), "madison": ("MSN", "United States"), "grand rapids": ("GRR", "United States"),
    "birmingham": ("BHM", "United States"), "little rock": ("LIT", "United States"), "jackson": ("JAN", "United States"),
    "kona": ("KOA", "United States"), "kauai": ("LIH", "United States"), "lihue": ("LIH", "United States"),
    "fairbanks": ("FAI", "United States"), "juneau": ("JNU", "United States"), "bozeman": ("BZN", "United States"),
    "jackson hole": ("JAC", "United States"), "aspen": ("ASE", "United States"), "vail": ("EGE", "United States"),
    "ottawa": ("YOW", "Canada"), "quebec city": ("YQB", "Canada"), "halifax": ("YHZ", "Canada"), "edmonton": ("YEG", "Canada"),
    "winnipeg": ("YWG", "Canada"), "victoria": ("YYJ", "Canada"), "kelowna": ("YLW", "Canada"), "whistler": ("YVR", "Canada"),
    "monterrey": ("MTY", "Mexico"), "merida": ("MID", "Mexico"), "san miguel de allende": ("BJX", "Mexico"),
    "leon": ("BJX", "Mexico"), "mazatlan": ("MZT", "Mexico"), "cozumel": ("CZM", "Mexico"), "huatulco": ("HUX", "Mexico"),
    "tijuana": ("TIJ", "Mexico"), "queretaro": ("QRO", "Mexico"), "puebla": ("PBC", "Mexico"), "acapulco": ("ACA", "Mexico"),
    "playa del carmen": ("CUN", "Mexico"), "la paz mexico": ("LAP", "Mexico"), "loreto": ("LTO", "Mexico"),
    # more Caribbean & Central America
    "turks and caicos": ("PLS", "Turks and Caicos"), "providenciales": ("PLS", "Turks and Caicos"), "grand cayman": ("GCM", "Cayman Islands"),
    "cayman": ("GCM", "Cayman Islands"), "bermuda": ("BDA", "Bermuda"), "st thomas": ("STT", "U.S. Virgin Islands"),
    "st croix": ("STX", "U.S. Virgin Islands"), "st maarten": ("SXM", "Sint Maarten"), "antigua": ("ANU", "Antigua and Barbuda"),
    "curacao": ("CUR", "Curaçao"), "trinidad": ("POS", "Trinidad and Tobago"), "port of spain": ("POS", "Trinidad and Tobago"),
    "grenada": ("GND", "Grenada"), "st kitts": ("SKB", "Saint Kitts and Nevis"), "martinique": ("FDF", "Martinique"),
    "guadeloupe": ("PTP", "Guadeloupe"), "puerto plata": ("POP", "Dominican Republic"), "samana": ("AZS", "Dominican Republic"),
    "ocho rios": ("MBJ", "Jamaica"), "negril": ("MBJ", "Jamaica"), "roatan": ("RTB", "Honduras"), "tegucigalpa": ("TGU", "Honduras"),
    "san pedro sula": ("SAP", "Honduras"), "bocas del toro": ("BOC", "Panama"), "tamarindo": ("LIR", "Costa Rica"),
    "ambergris caye": ("SPR", "Belize"), "placencia": ("PLJ", "Belize"), "flores": ("FRS", "Guatemala"), "antigua guatemala": ("GUA", "Guatemala"),
    # more South America
    "cali": ("CLO", "Colombia"), "santa marta": ("SMR", "Colombia"), "barranquilla": ("BAQ", "Colombia"), "arequipa": ("AQP", "Peru"),
    "iquitos": ("IQT", "Peru"), "valparaiso": ("SCL", "Chile"), "puerto varas": ("PMC", "Chile"), "punta arenas": ("PUQ", "Chile"),
    "easter island": ("IPC", "Chile"), "san carlos de bariloche": ("BRC", "Argentina"), "bariloche": ("BRC", "Argentina"),
    "mendoza": ("MDZ", "Argentina"), "cordoba": ("COR", "Argentina"), "ushuaia": ("USH", "Argentina"), "el calafate": ("FTE", "Argentina"),
    "salta": ("SLA", "Argentina"), "iguazu": ("IGR", "Argentina"), "brasilia": ("BSB", "Brazil"), "salvador": ("SSA", "Brazil"),
    "recife": ("REC", "Brazil"), "fortaleza": ("FOR", "Brazil"), "florianopolis": ("FLN", "Brazil"), "manaus": ("MAO", "Brazil"),
    "foz do iguacu": ("IGU", "Brazil"), "belo horizonte": ("CNF", "Brazil"), "porto alegre": ("POA", "Brazil"), "natal": ("NAT", "Brazil"),
    "guayaquil": ("GYE", "Ecuador"), "cuenca": ("CUE", "Ecuador"), "punta del este": ("PDP", "Uruguay"), "santa cruz": ("VVI", "Bolivia"),
    "georgetown": ("GEO", "Guyana"), "paramaribo": ("PBM", "Suriname"),
    # more Europe
    "birmingham uk": ("BHX", "United Kingdom"), "bristol": ("BRS", "United Kingdom"), "liverpool": ("LPL", "United Kingdom"),
    "newcastle": ("NCL", "United Kingdom"), "leeds": ("LBA", "United Kingdom"), "belfast": ("BFS", "United Kingdom"),
    "cardiff": ("CWL", "United Kingdom"), "inverness": ("INV", "United Kingdom"), "cork": ("ORK", "Ireland"), "shannon": ("SNN", "Ireland"),
    "galway": ("SNN", "Ireland"), "toulouse": ("TLS", "France"), "nantes": ("NTE", "France"), "strasbourg": ("SXB", "France"),
    "montpellier": ("MPL", "France"), "lille": ("LIL", "France"), "corsica": ("AJA", "France"), "ajaccio": ("AJA", "France"),
    "biarritz": ("BIQ", "France"), "cannes": ("NCE", "France"), "monaco": ("NCE", "Monaco"), "granada": ("GRX", "Spain"),
    "alicante": ("ALC", "Spain"), "santiago de compostela": ("SCQ", "Spain"), "san sebastian": ("EAS", "Spain"), "menorca": ("MAH", "Spain"),
    "gran canaria": ("LPA", "Spain"), "las palmas": ("LPA", "Spain"), "lanzarote": ("ACE", "Spain"), "fuerteventura": ("FUE", "Spain"),
    "coimbra": ("OPO", "Portugal"), "lagos portugal": ("FAO", "Portugal"), "genoa": ("GOA", "Italy"), "pisa": ("PSA", "Italy"),
    "verona": ("VRN", "Italy"), "bari": ("BRI", "Italy"), "brindisi": ("BDS", "Italy"), "puglia": ("BRI", "Italy"),
    "lake como": ("MXP", "Italy"), "cinque terre": ("GOA", "Italy"), "cagliari": ("CAG", "Italy"), "rotterdam": ("RTM", "Netherlands"),
    "eindhoven": ("EIN", "Netherlands"), "antwerp": ("BRU", "Belgium"), "ghent": ("BRU", "Belgium"), "nuremberg": ("NUE", "Germany"),
    "leipzig": ("LEJ", "Germany"), "dresden": ("DRS", "Germany"), "hanover": ("HAJ", "Germany"), "bremen": ("BRE", "Germany"),
    "bern": ("BRN", "Switzerland"), "lucerne": ("ZRH", "Switzerland"), "interlaken": ("BRN", "Switzerland"), "zermatt": ("GVA", "Switzerland"),
    "graz": ("GRZ", "Austria"), "linz": ("LNZ", "Austria"), "brno": ("BRQ", "Czechia"), "bratislava": ("BTS", "Slovakia"),
    "wroclaw": ("WRO", "Poland"), "poznan": ("POZ", "Poland"), "aarhus": ("AAR", "Denmark"), "billund": ("BLL", "Denmark"),
    "malmo": ("MMX", "Sweden"), "stavanger": ("SVG", "Norway"), "trondheim": ("TRD", "Norway"), "bodo": ("BOO", "Norway"),
    "lofoten": ("EVE", "Norway"), "rovaniemi": ("RVN", "Finland"), "turku": ("TKU", "Finland"), "akureyri": ("AEY", "Iceland"),
    "faroe islands": ("FAE", "Faroe Islands"), "greenland": ("GOH", "Greenland"), "nuuk": ("GOH", "Greenland"),
    "kefalonia": ("EFL", "Greece"), "zakynthos": ("ZTH", "Greece"), "kos": ("KGS", "Greece"), "naxos": ("JNX", "Greece"),
    "paros": ("PAS", "Greece"), "chania": ("CHQ", "Greece"), "ankara": ("ESB", "Turkey"), "dalaman": ("DLM", "Turkey"),
    "fethiye": ("DLM", "Turkey"), "trabzon": ("TZX", "Turkey"), "zadar": ("ZAD", "Croatia"), "pula": ("PUY", "Croatia"),
    "hvar": ("SPU", "Croatia"), "kotor": ("TIV", "Montenegro"), "tivat": ("TIV", "Montenegro"), "mostar": ("OMO", "Bosnia and Herzegovina"),
    "ohrid": ("OHD", "North Macedonia"), "cluj": ("CLJ", "Romania"), "cluj napoca": ("CLJ", "Romania"), "brasov": ("OTP", "Romania"),
    "varna": ("VAR", "Bulgaria"), "burgas": ("BOJ", "Bulgaria"), "plovdiv": ("PDV", "Bulgaria"), "chisinau": ("KIV", "Moldova"),
    "minsk": ("MSQ", "Belarus"), "lviv": ("LWO", "Ukraine"), "odesa": ("ODS", "Ukraine"), "kutaisi": ("KUT", "Georgia"), "batumi": ("BUS", "Georgia"),
    "gozo": ("MLA", "Malta"), "gibraltar": ("GIB", "Gibraltar"), "andorra": ("BCN", "Andorra"), "liechtenstein": ("ZRH", "Liechtenstein"),
    # more Middle East & Africa
    "aqaba": ("AQJ", "Jordan"), "eilat": ("ETM", "Israel"), "haifa": ("TLV", "Israel"), "alexandria": ("HBE", "Egypt"),
    "aswan": ("ASW", "Egypt"), "dammam": ("DMM", "Saudi Arabia"), "medina": ("MED", "Saudi Arabia"), "salalah": ("SLL", "Oman"),
    "ras al khaimah": ("RKT", "United Arab Emirates"), "sharjah": ("SHJ", "United Arab Emirates"), "agadir": ("AGA", "Morocco"),
    "rabat": ("RBA", "Morocco"), "essaouira": ("ESU", "Morocco"), "chefchaouen": ("TNG", "Morocco"), "djerba": ("DJE", "Tunisia"),
    "tripoli": ("MJI", "Libya"), "khartoum": ("KRT", "Sudan"), "asmara": ("ASM", "Eritrea"), "djibouti": ("JIB", "Djibouti"),
    "mogadishu": ("MGQ", "Somalia"), "zanzibar city": ("ZNZ", "Tanzania"), "serengeti": ("JRO", "Tanzania"), "masai mara": ("NBO", "Kenya"),
    "diani": ("UKA", "Kenya"), "port elizabeth": ("PLZ", "South Africa"), "gqeberha": ("PLZ", "South Africa"), "kruger": ("MQP", "South Africa"),
    "nelspruit": ("MQP", "South Africa"), "george": ("GRJ", "South Africa"), "swakopmund": ("WVB", "Namibia"), "walvis bay": ("WVB", "Namibia"),
    "maun": ("MUB", "Botswana"), "kasane": ("BBK", "Botswana"), "harare": ("HRE", "Zimbabwe"), "lilongwe": ("LLW", "Malawi"),
    "blantyre": ("BLZ", "Malawi"), "nosy be": ("NOS", "Madagascar"), "praia": ("RAI", "Cape Verde"), "sal": ("SID", "Cape Verde"),
    "cape verde": ("SID", "Cape Verde"), "abidjan": ("ABJ", "Côte d'Ivoire"), "bamako": ("BKO", "Mali"), "ouagadougou": ("OUA", "Burkina Faso"),
    "niamey": ("NIM", "Niger"), "cotonou": ("COO", "Benin"), "lome": ("LFW", "Togo"), "freetown": ("FNA", "Sierra Leone"),
    "monrovia": ("ROB", "Liberia"), "conakry": ("CKY", "Guinea"), "banjul": ("BJL", "Gambia"), "douala": ("DLA", "Cameroon"),
    "yaounde": ("NSI", "Cameroon"), "libreville": ("LBV", "Gabon"), "kinshasa": ("FIH", "DR Congo"), "luanda": ("LAD", "Angola"),
    "port louis": ("MRU", "Mauritius"), "reunion": ("RUN", "Réunion"), "saint denis": ("RUN", "Réunion"),
    # more Asia
    "kobe": ("UKB", "Japan"), "nara": ("KIX", "Japan"), "kanazawa": ("KMQ", "Japan"), "nagasaki": ("NGS", "Japan"), "kagoshima": ("KOJ", "Japan"),
    "sendai": ("SDJ", "Japan"), "niseko": ("CTS", "Japan"), "hakone": ("HND", "Japan"), "incheon": ("ICN", "South Korea"),
    "daegu": ("TAE", "South Korea"), "chongqing": ("CKG", "China"), "kunming": ("KMG", "China"), "guilin": ("KWL", "China"),
    "xiamen": ("XMN", "China"), "qingdao": ("TAO", "China"), "nanjing": ("NKG", "China"), "wuhan": ("WUH", "China"),
    "harbin": ("HRB", "China"), "lhasa": ("LXA", "China"), "sanya": ("SYX", "China"), "kaohsiung": ("KHH", "Taiwan"),
    "taichung": ("RMQ", "Taiwan"), "davao": ("DVO", "Philippines"), "bohol": ("TAG", "Philippines"), "siargao": ("IAO", "Philippines"),
    "clark": ("CRK", "Philippines"), "iloilo": ("ILO", "Philippines"), "koh phangan": ("USM", "Thailand"), "koh tao": ("USM", "Thailand"),
    "chiang rai": ("CEI", "Thailand"), "hua hin": ("HHQ", "Thailand"), "phi phi": ("KBV", "Thailand"), "khao lak": ("HKT", "Thailand"),
    "johor bahru": ("JHB", "Malaysia"), "malacca": ("KUL", "Malaysia"), "kuching": ("KCH", "Malaysia"), "ipoh": ("IPH", "Malaysia"),
    "surabaya": ("SUB", "Indonesia"), "medan": ("KNO", "Indonesia"), "makassar": ("UPG", "Indonesia"), "labuan bajo": ("LBJ", "Indonesia"),
    "komodo": ("LBJ", "Indonesia"), "raja ampat": ("SOQ", "Indonesia"), "gili islands": ("LOP", "Indonesia"), "canggu": ("DPS", "Indonesia"),
    "seminyak": ("DPS", "Indonesia"), "hue": ("HUI", "Vietnam"), "da lat": ("DLI", "Vietnam"), "dalat": ("DLI", "Vietnam"),
    "ha long": ("HPH", "Vietnam"), "halong bay": ("HPH", "Vietnam"), "sapa": ("HAN", "Vietnam"), "can tho": ("VCA", "Vietnam"),
    "sihanoukville": ("KOS", "Cambodia"), "koh rong": ("KOS", "Cambodia"), "mandalay": ("MDL", "Myanmar"), "bagan": ("NYU", "Myanmar"),
    "pune": ("PNQ", "India"), "ahmedabad": ("AMD", "India"), "udaipur": ("UDR", "India"), "jodhpur": ("JDH", "India"),
    "agra": ("DEL", "India"), "varanasi": ("VNS", "India"), "amritsar": ("ATQ", "India"), "srinagar": ("SXR", "India"),
    "leh": ("IXL", "India"), "kerala": ("COK", "India"), "trivandrum": ("TRV", "India"), "thiruvananthapuram": ("TRV", "India"),
    "pokhara": ("PKR", "Nepal"), "galle": ("CMB", "Sri Lanka"), "kandy": ("CMB", "Sri Lanka"), "chittagong": ("CGP", "Bangladesh"),
    "peshawar": ("PEW", "Pakistan"), "bukhara": ("BHK", "Uzbekistan"), "khiva": ("UGC", "Uzbekistan"), "dushanbe": ("DYU", "Tajikistan"),
    "ashgabat": ("ASB", "Turkmenistan"), "kabul": ("KBL", "Afghanistan"), "baghdad": ("BGW", "Iraq"), "erbil": ("EBL", "Iraq"),
    "damascus": ("DAM", "Syria"), "sanaa": ("SAH", "Yemen"), "shiraz": ("SYZ", "Iran"), "isfahan": ("IFN", "Iran"),
    # more Oceania & Pacific
    "canberra": ("CBR", "Australia"), "newcastle australia": ("NTL", "Australia"), "byron bay": ("BNK", "Australia"),
    "sunshine coast": ("MCY", "Australia"), "townsville": ("TSV", "Australia"), "alice springs": ("ASP", "Australia"),
    "uluru": ("AYQ", "Australia"), "broome": ("BME", "Australia"), "launceston": ("LST", "Australia"), "tasmania": ("HBA", "Australia"),
    "whitsundays": ("HTI", "Australia"), "hamilton island": ("HTI", "Australia"), "rotorua": ("ROT", "New Zealand"),
    "dunedin": ("DUD", "New Zealand"), "nelson": ("NSN", "New Zealand"), "napier": ("NPE", "New Zealand"), "suva": ("SUV", "Fiji"),
    "moorea": ("MOZ", "French Polynesia"), "rarotonga": ("RAR", "Cook Islands"), "cook islands": ("RAR", "Cook Islands"),
    "apia": ("APW", "Samoa"), "samoa": ("APW", "Samoa"), "tonga": ("TBU", "Tonga"), "vanuatu": ("VLI", "Vanuatu"),
    "port vila": ("VLI", "Vanuatu"), "honiara": ("HIR", "Solomon Islands"), "palau": ("ROR", "Palau"), "saipan": ("SPN", "Northern Mariana Islands"),
}
IATA_TO_CITY = {}
for _name, (_code, _country) in CITIES.items():
    IATA_TO_CITY.setdefault(_code, (_name, _country))

# Query parameters that carry dates/guests (keep) vs tracking (strip), per host suffix.
KEEP = {
    "booking.com": {"checkin", "checkout", "group_adults", "no_rooms", "group_children", "selected_currency",
                    "req_adults", "req_children", "ss", "nflt", "dest_id", "dest_type", "age"},
    "airbnb.com": {"check_in", "check_out", "checkin", "checkout", "adults", "children", "infants", "pets",
                   "guests", "room_types[]", "price_max", "price_min", "min_bedrooms", "query"},
    "agoda.com": {"checkIn", "checkOut", "los", "adults", "children", "rooms", "currencyCode", "currency",
                  "textToSearch", "city", "childAges"},
    "hostelworld.com": {"from", "to", "guests", "q", "type", "id", "city", "country", "page", "number_of_guests",
                        "date_from", "date_to"},
    "google.com": {"q", "tfs", "tfu", "hl", "gl", "curr", "dates", "checkin", "checkout", "adults", "children"},
    "skyscanner.com": {"adults", "adultsv2", "childrenv2", "children", "cabinclass", "rtn", "preferdirects",
                       "currency", "market", "locale", "outboundaltsenabled", "inboundaltsenabled", "ref"},
    "trip.com": {"dcity", "acity", "ddate", "rdate", "triptype", "class", "quantity", "childqty", "babyqty",
                 "locale", "curr", "checkin", "checkout", "adult", "children", "crn", "searchWord", "searchType",
                 "city", "hotelId", "ages"},
    "kayak.com": {"sort", "fs"},
    "getyourguide.com": {"q", "date_from", "date_to", "lc", "searchSource"},
    "viator.com": {"text", "startDate", "endDate"},
}
ALWAYS_STRIP_PREFIX = ("utm_", "gclid", "fbclid", "msclkid", "yclid", "_ga", "mc_", "ref_", "aff")

DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%m/%d/%y", "%m-%d-%y", "%Y/%m/%d", "%m.%d.%Y",
                "%b %d %Y", "%B %d %Y", "%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y")


def parse_date(s: str) -> date:
    """Accept yyyy-mm-dd, mm-dd-yyyy, mm/dd/yyyy (2- or 4-digit year) and a few spelled-out forms."""
    s = s.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unrecognised date {s!r}; use mm-dd-yyyy, mm/dd/yyyy or yyyy-mm-dd")


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().strip()


def resolve_place(text: str):
    """'Lisbon', 'Lisbon, Portugal', 'LIS' or 'lis' -> (iata, city, country). iata is '' when unknown."""
    raw = (text or "").strip()
    if not raw:
        return "", "", ""
    key = _ascii(re.sub(r"\s+", " ", raw.replace("-", " ")))
    if key in CITIES:  # nicknames like "nyc" or "la" win over airport-code lookup
        code, country = CITIES[key]
        city = raw.split(",")[0].strip()
        return code, (_pretty(city) if city == city.lower() else city), country
    if re.fullmatch(r"[A-Za-z]{3}", raw):
        code = raw.upper()
        city, country = IATA_TO_CITY.get(code, (code, ""))
        return code, (_pretty(city) if city == city.lower() else city), country
    key = re.sub(r"\b(st)\.", r"\1", key)
    parts = [p.strip() for p in key.split(",") if p.strip()]
    for cand in (key, parts[0] if parts else key):
        if cand in CITIES:
            code, country = CITIES[cand]
            city = raw.split(",")[0].strip()
            if city == city.lower():
                city = _pretty(city)
            return code, city, (parts[1].title() if len(parts) > 1 else country)
    city = raw.split(",")[0].strip()
    country = raw.split(",")[1].strip() if "," in raw else ""
    return "", city, country


ISO2 = {
    "united states": "US", "canada": "CA", "mexico": "MX", "united kingdom": "GB", "ireland": "IE", "france": "FR", "spain": "ES",
    "portugal": "PT", "italy": "IT", "netherlands": "NL", "belgium": "BE", "luxembourg": "LU", "germany": "DE", "switzerland": "CH",
    "austria": "AT", "czechia": "CZ", "hungary": "HU", "poland": "PL", "denmark": "DK", "sweden": "SE", "norway": "NO", "finland": "FI",
    "iceland": "IS", "greece": "GR", "turkey": "TR", "croatia": "HR", "slovenia": "SI", "serbia": "RS", "romania": "RO", "bulgaria": "BG",
    "estonia": "EE", "latvia": "LV", "lithuania": "LT", "ukraine": "UA", "russia": "RU", "malta": "MT", "cyprus": "CY", "georgia": "GE",
    "armenia": "AM", "azerbaijan": "AZ", "united arab emirates": "AE", "qatar": "QA", "saudi arabia": "SA", "oman": "OM", "jordan": "JO",
    "israel": "IL", "lebanon": "LB", "egypt": "EG", "morocco": "MA", "tunisia": "TN", "kenya": "KE", "south africa": "ZA", "tanzania": "TZ",
    "ethiopia": "ET", "ghana": "GH", "nigeria": "NG", "mauritius": "MU", "seychelles": "SC", "rwanda": "RW", "senegal": "SN", "japan": "JP",
    "south korea": "KR", "china": "CN", "hong kong": "HK", "macau": "MO", "taiwan": "TW", "philippines": "PH", "thailand": "TH",
    "singapore": "SG", "malaysia": "MY", "indonesia": "ID", "vietnam": "VN", "cambodia": "KH", "laos": "LA", "myanmar": "MM", "india": "IN",
    "nepal": "NP", "sri lanka": "LK", "maldives": "MV", "bangladesh": "BD", "pakistan": "PK", "uzbekistan": "UZ", "kazakhstan": "KZ",
    "mongolia": "MN", "australia": "AU", "new zealand": "NZ", "fiji": "FJ", "french polynesia": "PF", "puerto rico": "PR",
    "dominican republic": "DO", "jamaica": "JM", "bahamas": "BS", "cuba": "CU", "costa rica": "CR", "panama": "PA", "aruba": "AW",
    "barbados": "BB", "belize": "BZ", "guatemala": "GT", "colombia": "CO", "peru": "PE", "chile": "CL", "argentina": "AR", "brazil": "BR",
    "ecuador": "EC", "uruguay": "UY", "bolivia": "BO", "paraguay": "PY",
}
CONTINENT = {
    "north-america": {"united states", "canada", "mexico", "puerto rico", "dominican republic", "jamaica", "bahamas", "cuba", "costa rica",
                      "panama", "aruba", "barbados", "belize", "guatemala", "honduras", "nicaragua", "el salvador"},
    "south-america": {"colombia", "peru", "chile", "argentina", "brazil", "ecuador", "uruguay", "bolivia", "paraguay", "venezuela"},
    "europe": {"united kingdom", "ireland", "france", "spain", "portugal", "italy", "netherlands", "belgium", "luxembourg", "germany",
               "switzerland", "austria", "czechia", "hungary", "poland", "denmark", "sweden", "norway", "finland", "iceland", "greece",
               "turkey", "croatia", "slovenia", "serbia", "romania", "bulgaria", "estonia", "latvia", "lithuania", "ukraine", "malta", "cyprus"},
    "africa": {"egypt", "morocco", "tunisia", "kenya", "south africa", "tanzania", "ethiopia", "ghana", "nigeria", "rwanda", "senegal"},
    "asia": {"japan", "south korea", "china", "hong kong", "taiwan", "philippines", "thailand", "singapore", "malaysia", "indonesia", "vietnam",
             "cambodia", "laos", "india", "nepal", "sri lanka", "maldives", "united arab emirates", "qatar", "israel", "jordan"},
    "oceania": {"australia", "new zealand", "fiji", "french polynesia"},
}
HW_COUNTRY = {"united states": "usa", "united kingdom": "england", "czechia": "czech-republic"}


def _slug(text: str) -> str:
    return "-".join(_ascii(text).replace("'", "").split())


def hostelworld_url(city, country, checkin, checkout, guests, currency):
    """Hostelworld city pages (/hostels/<continent>/<country>/<city>/) take dates, guests and currency.
    Its /s?q= search 404s, so when the continent is unknown fall back to a site search hint."""
    c = _ascii(country)
    continent = next((k for k, v in CONTINENT.items() if c in v), None)
    params = f"?from={checkin}&to={checkout}&guests={guests}&currency={currency}"
    if continent:
        return f"https://www.hostelworld.com/hostels/{continent}/{HW_COUNTRY.get(c, _slug(country))}/{_slug(city)}/{params}"
    return f"https://www.hostelworld.com/hostels/{_slug(city)}/{params}  (if this 404s, search the web for 'hostelworld hostels {city}' and add the same ?from=&to=&guests= parameters)"


def suggest(text: str, limit: int = 8):
    """Case-insensitive matches for a partial city name or airport code, best first."""
    key = _ascii(text).replace("-", " ").strip()
    if not key:
        return []
    scored = []
    for name, (code, country) in CITIES.items():
        if name.startswith(key):
            score = 0
        elif any(w.startswith(key) for w in name.split()):
            score = 1
        elif key in name:
            score = 2
        elif key == code.lower():
            score = 0
        elif code.lower().startswith(key) and len(key) >= 2:
            score = 3
        else:
            continue
        scored.append((score, len(name), _pretty(name), code, country))
    if any(sc == 0 and code.lower() == key for sc, _, _, code, _ in scored):
        scored = [t for t in scored if t[0] == 0]  # an exact airport code: no substring noise
    scored.sort(key=lambda t: (t[0], -t[1]))  # best score first; within a score the fuller name first
    out, seen = [], set()
    for _, _, name, code, country in scored:
        if (code, country) in seen:  # "Rio" and "Rio de Janeiro" are one place: keep the fuller name
            continue
        seen.add((code, country))
        out.append({"city": _pretty(name), "iata": code, "country": country})
        if len(out) >= limit:
            break
    return out


SMALL_WORDS = {"de", "da", "do", "del", "des", "di", "du", "la", "le", "las", "los", "el", "of", "and", "on", "the", "al", "en", "sur"}


def _pretty(name: str) -> str:
    """Title-case a city name, keeping connector words lowercase: 'rio de janeiro' -> 'Rio de Janeiro'."""
    words = name.split()
    return " ".join(w if (i and w.lower() in SMALL_WORDS) else w[:1].upper() + w[1:] for i, w in enumerate(words))


def yymmdd(d: date) -> str:
    return d.strftime("%y%m%d")


# Trip.com's hotel list only fills with its own numeric city id (its searchWord= form returns "0 properties").
# Learn a new id from a Trip.com Car Hire results URL (pcity=) or from the hotel page's own city picker (city=).
TRIP_CITY_IDS = {"rio de janeiro": 769, "beijing": 1, "manaus": 1256, "istanbul": 532, "phuket": 725, "bangkok": 359}
# Skyscanner hotels need entity_id (read it from the results URL after typing the city once).
SKY_HOTEL_ENTITY = {"rio de janeiro": "27541837", "beijing": "27545090", "manaus": "27544857", "istanbul": "27542903", "phuket": "81972816", "bangkok": "27536671"}
# Skyscanner car hire uses its own place ids in /carhire/results/{pickup}/{dropoff}/... (differs from the hotel id).
SKY_CAR_PLACE = {"GIG": "95673347", "PEK": "128668664", "MAO": "95674366", "IST": "95673323", "BKK": "95673349"}
# Kayak hotels redirect city names to a place id; using it skips one redirect.
KAYAK_HOTEL_PLACE = {"rio de janeiro": "Rio-de-Janeiro,Brazil-p46811", "beijing": "Beijing-c3286", "manaus": "Manaus-c1117", "istanbul": "Istanbul-c3430", "phuket": "Phuket-c23911", "bangkok": "Bangkok,Thailand-p18056"}
# Trip.com car hire results need the city id and the airport's coordinates.
TRIP_CAR = {"GIG": {"city": 769, "city_name": "Rio de Janeiro", "country": "Brazil", "scountry": 66,
                    "address": "Galeão International Airport(GIG)", "lat": -22.80527, "lng": -43.256628},
            "PEK": {"city": 1, "city_name": "Beijing", "country": "China", "scountry": 1,
                    "address": "Beijing Capital International Airport(PEK)", "lat": 40.0799, "lng": 116.6031},
            "MAO": {"city": 1256, "city_name": "Manaus", "country": "Brazil", "scountry": 66,
                    "address": "Eduardo Gomes International Airport(MAO)", "lat": -3.0386, "lng": -60.0497},
            "IST": {"city": 532, "city_name": "Istanbul", "country": "Türkiye", "scountry": 66,
                    "address": "Istanbul Airport", "lat": 41.276148, "lng": 28.728735},
            "HKT": {"city": 725, "city_name": "Phuket", "country": "Thailand", "scountry": 66,
                    "address": "Phuket International Airport", "lat": 8.10534, "lng": 98.305429},
            "BKK": {"city": 359, "city_name": "Bangkok", "country": "Thailand", "scountry": 66,
                    "address": "Suvarnabhumi Airport (BKK)", "lat": 13.681897, "lng": 100.746869}}
# GetYourGuide location pages (/{slug}-l{id}/); its /s/?q= search ignores the city.
# Booking.com destination ids for cities whose plain ss= search bounces to the homepage
BOOKING_DEST = {"bangkok": "-3414440", "beijing": "-1898541"}  # ss=City alone can bounce to the homepage
GYG_LOCATION = {"rio de janeiro": 9, "seattle": 198, "beijing": 186, "manaus": 917, "istanbul": 56, "phuket": 32123, "bangkok": 169}


# Buses, trains and metro for trips inside one country (the dashboard's "Buses, trains & metro" card).
# Rome2Rio and Google Maps transit work everywhere; the national sites below sell the tickets.
FILL = "  (fill the form on the page, then copy the results URL)"
EUROPE = {"austria", "belgium", "bulgaria", "croatia", "czechia", "denmark", "estonia", "finland", "france", "germany", "greece",
          "hungary", "ireland", "italy", "latvia", "lithuania", "luxembourg", "netherlands", "norway", "poland", "portugal",
          "romania", "slovakia", "slovenia", "spain", "sweden", "switzerland", "united kingdom"}
# Brazilian state codes for ClickBus / Buser results URLs (/onibus/{city}-{uf}/{city}-{uf}); add cities as you meet them.
BR_UF = {"rio de janeiro": "rj", "sao paulo": "sp", "belo horizonte": "mg", "brasilia": "df", "salvador": "ba", "recife": "pe",
         "fortaleza": "ce", "curitiba": "pr", "porto alegre": "rs", "florianopolis": "sc", "manaus": "am", "belem": "pa",
         "goiania": "go", "vitoria": "es", "natal": "rn", "maceio": "al", "joao pessoa": "pb", "campinas": "sp",
         "foz do iguacu": "pr", "porto seguro": "ba", "ouro preto": "mg", "paraty": "rj", "buzios": "rj", "santos": "sp"}
SE_ASIA = {"thailand", "vietnam", "cambodia", "laos", "malaysia", "indonesia", "philippines", "myanmar"}


def ground_links(o_city: str, d_city: str, country: str, day: str) -> dict:
    """site -> results/search URL for buses and trains between two cities in the same country (empty if not)."""
    hy = lambda t: quote(_ascii(t).title().replace(" ", "-"))
    sl = lambda t: _slug(_ascii(t))
    out = {
        "Rome2Rio": f"https://www.rome2rio.com/map/{hy(o_city)}/{hy(d_city)}  (every mode with typical prices and operators)",
        "Google Maps (transit)": "https://www.google.com/maps/dir/?api=1&origin=" + quote(f"{o_city}, {country}") +
                                 "&destination=" + quote(f"{d_city}, {country}") + "&travelmode=transit",
        "Busbud": "https://www.busbud.com/en" + FILL,
    }
    c = _ascii(country).lower()
    if c == "brazil":
        ou, du = BR_UF.get(_ascii(o_city).lower()), BR_UF.get(_ascii(d_city).lower())
        if ou and du:
            leg = f"onibus/{sl(o_city)}-{ou}/{sl(d_city)}-{du}"
            out["ClickBus"] = f"https://www.clickbus.com.br/{leg}?departureDate={day}  (may need a reload; it did not load on 28 Oct 2026)"
            out["Buser"] = f"https://www.buser.com.br/{leg}?ida={day}  (app buses from neighbourhood pickup points)"
        else:
            out["ClickBus"] = "https://www.clickbus.com.br/" + FILL + "  (add the cities' state codes to BR_UF)"
            out["Buser"] = "https://www.buser.com.br/" + FILL
    elif c == "united states":
        out["Wanderu"] = "https://www.wanderu.com/en-us/" + FILL
        out["Amtrak"] = "https://www.amtrak.com/home" + FILL
        out["Greyhound"] = "https://www.greyhound.com/" + FILL
    elif c in EUROPE:
        out["Trainline"] = "https://www.thetrainline.com/" + FILL
        out["Omio"] = "https://www.omio.com/" + FILL
        out["FlixBus"] = "https://global.flixbus.com/" + FILL
    elif c in SE_ASIA:
        out["12Go"] = f"https://12go.asia/en/travel/{sl(o_city)}/{sl(d_city)}?date={day}"
    elif c == "india":
        out["redBus"] = "https://www.redbus.in/" + FILL
        out["IRCTC (trains)"] = "https://www.irctc.co.in/nget/train-search" + FILL
    elif c == "mexico":
        out["ADO"] = "https://www.ado.com.mx/" + FILL
    elif c == "china":
        out["Trip.com trains"] = "https://www.trip.com/trains/china/" + FILL
    elif c == "japan":
        out["Japan Transit (Jorudan)"] = "https://world.jorudan.co.jp/mln/en/" + FILL
    return out


def build_links(a) -> dict:
    cabin = CABIN[a.cabin]
    o_iata, o_city, o_country = resolve_place(a.origin)
    d_iata, d_city, d_country = resolve_place(a.dest)
    city = a.city or d_city
    country = a.country or d_country
    ci, co = parse_date(a.checkin), parse_date(a.checkout)
    checkin, checkout = ci.isoformat(), co.isoformat()
    nights = (co - ci).days
    city_q = quote(city)
    country_q = quote(country) if country else ""
    city_country = f"{city_q}%2C%20{country_q}" if country else city_q
    adults, kids = a.adults, a.children
    notes = []

    notes = []
    has_air = bool(o_iata and d_iata)
    if not has_air:
        missing = [n for n, v in (("origin", o_iata), ("destination", d_iata)) if not v]
        notes.append(f"No airport code known for {', '.join(missing)}; pass the IATA code(s) (e.g. --origin LAX) to get flight links.")
    o, d = o_iata, d_iata
    ol, dl = o.lower(), d.lower()
    kids_v2 = '%2C'.join(['8'] * kids) if kids else ''
    kayak_guests = f"{adults}adults" + (f"/children-{'-'.join(['11'] * kids)}" if kids else "")
    FORM = "  (fill the form on the page, then copy the results URL)"

    # vendor -> category -> url. Every vendor the user named, for every category it offers.
    ow = getattr(a, "one_way", False)
    exp_leg2 = "" if ow else f"&leg2=from:{d},to:{o},departure:{co.strftime('%m/%d/%Y')}TANYT"
    # results-page links for vendors that are otherwise form-only, when the site's own ids are known
    ck = city.lower()
    iso = ISO2.get(_ascii(country), "").lower() if country else ""
    uq = lambda v: quote(str(v), safe="")
    sky_ht = (f"https://www.skyscanner.com/hotels/search?entity_id={SKY_HOTEL_ENTITY[ck]}&checkin={checkin}&checkout={checkout}&adults={adults}&rooms={a.rooms}&currency={a.currency}"
              if ck in SKY_HOTEL_ENTITY else
              f"https://www.skyscanner.com/hotels/search?checkin={checkin}&checkout={checkout}&adults={adults}&rooms={a.rooms}&currency={a.currency}" + FORM +
              "  (type the city; the results URL gains entity_id=…, add it to SKY_HOTEL_ENTITY; property pages are /hotels/{country}/{city}-hotels/{slug}/ht-{id}?checkin&checkout&adults&rooms)")
    sky_car = (f"https://www.skyscanner.com/carhire/results/{SKY_CAR_PLACE[d]}/{SKY_CAR_PLACE[d]}/{checkin}T10:00/{checkout}T10:00/30"
               if d and d in SKY_CAR_PLACE else
               "https://www.skyscanner.com/carhire" + FORM + "  (results URL: /carhire/results/{pickup-id}/{dropoff-id}/{YYYY-MM-DDTHH:MM}/{YYYY-MM-DDTHH:MM}/{driver-age}; add the id to SKY_CAR_PLACE)")
    if d and d in TRIP_CAR:
        t = TRIP_CAR[d]
        leg = lambda pre: (f"&{pre}city={t['city']}&{pre}cityname={uq(t['city_name'])}&{pre}code={d}&{pre}address={uq(t['address'])}&{pre}type=1"
                           f"&{pre}countryname={uq(t['country'])}&{pre}lat={t['lat']}&{pre}lon={t['lng']}")
        trip_car = (f"https://us.trip.com/carhire/online/list?scountry={t['scountry']}&locale=en-US&curr={a.currency}" + leg("p") +
                    f"&ptime={uq(ci.strftime('%Y/%m/%d') + ' 10:00')}" + leg("r") + f"&rtime={uq(co.strftime('%Y/%m/%d') + ' 10:00')}&age=30-60")
    else:
        trip_car = (f"https://us.trip.com/carhire/?locale=en-US&curr={a.currency}" + FORM +
                    "  (results URL carries pcity=, pcode=, ptime=, rtime=; add the airport to TRIP_CAR; long rentals may return 'No suitable cars found' = no-inventory)")
    kayak_ht = (f"https://www.kayak.com/hotels/{KAYAK_HOTEL_PLACE[ck]}/{checkin}/{checkout}/{adults}adults?sort=rank_a" if ck in KAYAK_HOTEL_PLACE
                else f"https://www.kayak.com/hotels/{city_q}{',' + country_q if country else ''}/{checkin}/{checkout}/{adults}adults?sort=rank_a")
    agoda_ht = (f"https://www.agoda.com/city/{_slug(city)}-{iso}.html?checkIn={checkin}&los={nights}&adults={adults}&rooms={a.rooms}&children={kids}&currencyCode={a.currency}" if iso
                else f"https://www.agoda.com/search?textToSearch={city_q}&checkIn={checkin}&checkOut={checkout}&los={nights}&rooms={a.rooms}&adults={adults}&children={kids}&currency={a.currency}  (textToSearch often lands on the homepage: use the /city/ page)")
    bk_act = (f"https://www.booking.com/attractions/searchresults/{iso}/{_slug(city)}.html?start_date={checkin}&end_date={checkout}&selected_currency={a.currency}" if iso
              else f"https://www.booking.com/things-to-do/searchresults.html?ss={city_q}&selected_currency={a.currency}")
    gyg = (f"https://www.getyourguide.com/{_slug(city)}-l{GYG_LOCATION[ck]}/?date_from={checkin}&date_to={checkout}&currency={a.currency}" if ck in GYG_LOCATION
           else f"https://www.getyourguide.com/s/?q={city_q}&date_from={checkin}&date_to={checkout}  (if this shows another city, search the web for 'getyourguide {city}' and open the location page, e.g. /seattle-l198/, then add it to GYG_LOCATION)")
    vendors = {
        "Airbnb": {
            "lodging": f"https://www.airbnb.com/s/{city_q}{'--' + country_q if country else ''}/homes?checkin={checkin}&checkout={checkout}&adults={adults}&children={kids}&currency={a.currency}",
            "activities": f"https://www.airbnb.com/s/{city_q}{'--' + country_q if country else ''}/experiences?checkin={checkin}&checkout={checkout}&currency={a.currency}",
        },
        "Booking.com": {
            "lodging": (f"https://www.booking.com/searchresults.html?ss={quote(city)}&dest_id={BOOKING_DEST[ck]}&dest_type=city&checkin" if ck in BOOKING_DEST else f"https://www.booking.com/searchresults.html?ss={city_country}&checkin")
                       + f"={checkin}&checkout={checkout}&group_adults={adults}&no_rooms={a.rooms}&group_children={kids}&selected_currency={a.currency}",
            "flights": (f"https://flights.booking.com/flights/{o}.AIRPORT-{d}.AIRPORT/?type={'ONEWAY' if ow else 'ROUNDTRIP'}&adults={adults}&cabinClass={ {'economy': 'ECONOMY', 'premium': 'PREMIUM_ECONOMY', 'business': 'BUSINESS', 'first': 'FIRST'}[a.cabin] }&children=&from={o}.AIRPORT&to={d}.AIRPORT&depart={checkin}{'' if ow else '&return=' + checkout}&sort=BEST" if has_air else None),
            "car": (f"https://cars.booking.com/search-results?locationIata={d}&dropLocationIata={d}&puDay={ci.day}&puMonth={ci.month}&puYear={ci.year}&puHour=10&puMinute=0&doDay={co.day}&doMonth={co.month}&doYear={co.year}&doHour=10&doMinute=0&driversAge=35&prefcurrency={a.currency}&preflang=en&cor=us" if d else f"https://cars.booking.com/?preflang=en&prefcurrency={a.currency}" + FORM),
            "activities": bk_act,
        },
        "Expedia": {
            "flights": (f"https://www.expedia.com/Flights-Search?trip={'oneway' if ow else 'roundtrip'}&leg1=from:{o},to:{d},departure:{ci.strftime('%m/%d/%Y')}TANYT{exp_leg2}&passengers=adults:{adults},children:{kids},infantinlap:N&mode=search" if has_air else None),
            "lodging": f"https://www.expedia.com/Hotel-Search?destination={city_country}&startDate={checkin}&endDate={checkout}&adults={adults}&rooms={a.rooms}&sort=RECOMMENDED",
            "car": f"https://www.expedia.com/carsearch?locn={d if d else city_q}&date1={ci.strftime('%m/%d/%Y')}&time1=1000&date2={co.strftime('%m/%d/%Y')}&time2=1000",
            "activities": f"https://www.expedia.com/things-to-do/search?location={city_q}&startDate={checkin}&endDate={checkout}",
        },
        "Kayak": {
            "flights": (f"https://www.kayak.com/flights/{o}-{d}/{checkin}{'' if ow else '/' + checkout}{cabin['kayak']}/{kayak_guests}?sort=bestflight_a" if has_air else None),
            "lodging": kayak_ht,
            "car": f"https://www.kayak.com/cars/{d if d else city_q + (',' + country_q if country else '')}/{checkin}-10h/{checkout}-10h",
        },
        "Skyscanner": {
            "flights": (f"https://www.skyscanner.com/transport/flights/{ol}/{dl}/{yymmdd(ci)}/{'' if ow else yymmdd(co) + '/'}?adults={adults}&adultsv2={adults}&childrenv2={kids_v2}&cabinclass={cabin['sky']}&rtn={0 if ow else 1}&preferdirects=false&currency={a.currency}" if has_air else None),
            "lodging": sky_ht,
            "car": sky_car,
        },
        "Trip.com": {
            "flights": (f"https://www.trip.com/flights/showfarefirst?dcity={ol}&acity={dl}&ddate={checkin}{'' if ow else '&rdate=' + checkout}&triptype={'ow' if ow else 'rt'}&class={cabin['trip']}&quantity={adults}&childqty={kids}&locale=en-US&curr={a.currency}" if has_air else None),
            "lodging": (f"https://us.trip.com/hotels/list?city={TRIP_CITY_IDS[city.lower()]}&cityName={city_q}&checkin={checkin.replace('-', '/')}&checkout={checkout.replace('-', '/')}&adult={adults}&children={kids}&crn={a.rooms}&curr={a.currency}&locale=en-US" if city.lower() in TRIP_CITY_IDS else
                        f"https://www.trip.com/hotels/list?searchWord={city_q}&checkin={checkin.replace('-', '/')}&checkout={checkout.replace('-', '/')}&adult={adults}&children={kids}&crn={a.rooms}&searchType=CT&curr={a.currency}  (returns 0 properties until the city is picked from the page's own search box; then add its city id to TRIP_CITY_IDS)"),
            "car": trip_car,
            "activities": f"https://www.trip.com/things-to-do/list?keyword={city_q}",
        },
        "Agoda": {
            "lodging": agoda_ht,
            "flights": (f"https://www.agoda.com/flights/results?departureFrom={o}&departureFromType=1&arrivalTo={d}&arrivalToType=0&departDate={checkin}{'' if ow else '&returnDate=' + checkout}&searchType={1 if ow else 2}&cabinType={ {'economy': 'Economy', 'premium': 'PremiumEconomy', 'business': 'Business', 'first': 'First'}[a.cabin] }&adults={adults}&sort=8  (typed origin/destination params worked on 28 Oct 2026; arrivalToType=0 searches the city's airports)" if has_air else None),
            "activities": f"https://www.agoda.com/activities/search?city={city_q}&currency={a.currency}" + FORM,
        },
        "Hostelworld": {
            "lodging": hostelworld_url(city, country, checkin, checkout, adults + kids, a.currency),
        },
        "Google Flights": {
            "flights": ("https://www.google.com/travel/flights?q=" + quote(f"Flights from {o} to {d} on {checkin}{' one way' if ow else ' returning ' + checkout}{cabin['google']}") + f"&hl=en&gl=us&curr={a.currency}" if has_air else None),
        },
        "Google Hotels": {
            "lodging": f"https://www.google.com/travel/search?q=" + quote(f"hotels in {city} {country}".strip()) + f"&dates={checkin},{checkout}&adults={adults}&gl=us&hl=en&curr={a.currency}  (dates are often ignored: set them on the page; best used for Google ratings)",
        },
        "Rentalcars.com / Discover Cars (cars)": {
            "car": f"https://www.rentalcars.com/?preflang=en&prefcurrency={a.currency}" + FORM + "  |  https://www.discovercars.com/" + FORM,
        },
        "GetYourGuide / Viator (activities)": {
            "activities": gyg + f"  |  https://www.viator.com/searchResults/all?text={city_q}",
        },
        "Numbeo / BudgetYourTrip (daily spend)": {
            "food": f"https://www.numbeo.com/cost-of-living/in/{quote(city.title().replace(' ', '-'))}?displayCurrency={a.currency}  |  " + (f"https://www.budgetyourtrip.com/{quote(_ascii(country).replace(' ', '-'))}" if country else "https://www.budgetyourtrip.com/"),
        },
        "SafetyWing / World Nomads (insurance)": {
            "insurance": "https://safetywing.com/nomad-insurance/  |  https://www.worldnomads.com/travel-insurance/",
        },
        "Google Maps": {
            "map": "https://www.google.com/maps/search/" + quote(f"{city} {country}".strip()) + "  |  hospitals: https://www.google.com/maps/search/" + quote(f"international hospital {city}"),
        },
    }
    same_country = bool(o_country and country and _ascii(o_country).lower() == _ascii(country).lower() and o_city.lower() != city.lower())
    if same_country:  # intercity buses and trains, and the destination's metro: the "Buses, trains & metro" card
        for site, url in ground_links(o_city, city, country, checkin).items():
            vendors.setdefault(site, {})["ground"] = url
    for v in vendors.values():
        for k in [k for k, u in v.items() if u is None]:
            del v[k]

    # the user's named vendors and which categories each one offers: the coverage contract
    coverage_matrix = {
        "Airbnb": ["lodging", "activities"], "Booking.com": ["lodging", "flights", "car", "activities"],
        "Expedia": ["flights", "lodging", "car", "activities"], "Kayak": ["flights", "lodging", "car"],
        "Skyscanner": ["flights", "lodging", "car"], "Trip.com": ["flights", "lodging", "car", "activities"],
        "Agoda": ["lodging", "flights", "activities"], "Hostelworld": ["lodging"],
        "Google Flights": ["flights"], "Google Hotels": ["lodging"],
    }
    return {
        "meta": {"origin": o_iata, "origin_city": o_city, "dest": d_iata, "city": city, "country": country,
                 "checkin": checkin, "checkout": checkout, "nights": nights, "adults": adults, "children": kids,
                 "rooms": a.rooms, "cabin": a.cabin, "currency": a.currency, "trip_type": "one_way" if ow else "round_trip", "notes": notes,
                 "same_country": same_country},
        "vendors": vendors, "coverage_matrix": coverage_matrix,
    }


SPLIT_VENDORS = {"GetYourGuide / Viator (activities)": ["GetYourGuide", "Viator"],
                 "Rentalcars.com / Discover Cars (cars)": ["Rentalcars.com", "Discover Cars"],
                 "Numbeo / BudgetYourTrip (daily spend)": ["Numbeo", "BudgetYourTrip"],
                 "SafetyWing / World Nomads (insurance)": ["SafetyWing", "World Nomads"]}


def search_links(links: dict) -> dict:
    """vendor -> {category: {url, note?}} for the trip JSON's `search_links` (the dashboard's Master Search List).

    Each value is the vendor's full results page for the route, dates and guests. Links that still need a form
    (no known site id) carry the instruction as `note`; replace them with the results URL you copy during research.
    """
    out = {}
    for vendor, cats in links["vendors"].items():
        if vendor in ("Google Maps", "Rentalcars.com / Discover Cars (cars)"):
            continue  # a map and two homepage-only car brokers: not results pages
        names = SPLIT_VENDORS.get(vendor, [vendor])
        for cat, raw in cats.items():
            for i, part in enumerate(str(raw).split("  |  ")):
                url, _, note = part.strip().partition("  ")
                if i >= len(names) or not url.startswith("http"):
                    continue
                cell = {"url": url}
                if cat == "ground":
                    cell["label"] = "Buses & trains"
                note = note.strip().strip("()").strip()
                if note:
                    cell["note"] = note.replace(") (", "; ").replace("(", "").replace(")", "")
                out.setdefault(names[i], {})[cat] = cell
    return out


def area_links(links: dict, area: str, a) -> dict:
    """Lodging results pages for one neighborhood on every lodging site.

    The user wants at least 5 stays per neighborhood, per tier, per site, so each neighborhood gets its
    own search. Sites that take free text get the area in the URL; the rest open the city search with a
    note on the filter that narrows it to the area.
    """
    m = links["meta"]
    city, country = m["city"], m["country"]
    ci, co, ad, kids = m["checkin"], m["checkout"], m["adults"], m["children"]
    v = links["vendors"]
    city_link = lambda name: str(v.get(name, {}).get("lodging", "")).split("  (")[0]
    full = ", ".join(x for x in (area, city, country) if x)
    out = {
        "Airbnb": f"https://www.airbnb.com/s/{quote(area)}--{quote(city)}{'--' + quote(country) if country else ''}/homes?checkin={ci}&checkout={co}&adults={ad}&children={kids}&currency={a.currency}",
        "Booking.com": f"https://www.booking.com/searchresults.html?ss={quote(area + ', ' + city)}&checkin={ci}&checkout={co}&group_adults={ad}&no_rooms={a.rooms}&group_children={kids}&selected_currency={a.currency}&order=price"
                       f"  (if it lands on the homepage, type '{area}' and pick the district suggestion; upper/luxury: add &nflt=class%3D4 or class%3D5)",
        "Expedia": f"https://www.expedia.com/Hotel-Search?destination={quote(full)}&startDate={ci}&endDate={co}&adults={ad}&rooms={a.rooms}&sort=PRICE_LOW_TO_HIGH"
                   "  (upper/luxury: add &star=40 or &star=50)",
        "Kayak": f"https://www.kayak.com/hotels/{area.replace(' ', '-')},{city.replace(' ', '-')}{',' + country.replace(' ', '-') if country else ''}/{ci}/{co}/{ad}adults?sort=price_a"
                 "  (if Kayak resolves to the whole city, use its Neighborhood filter)",
        "Google Hotels": "https://www.google.com/travel/search?q=" + quote(f"hotels in {full}") + f"&adults={ad}&gl=us&hl=en&curr={a.currency}  (set the dates on the page)",
        "Skyscanner": city_link("Skyscanner") + f"  (narrow to {area} with the map or the 'Neighbourhood'/'Area' filter)",
        "Agoda": city_link("Agoda") + f"  (narrow to {area} with the 'Area' filter on the left)",
        "Trip.com": city_link("Trip.com") + f"  (type '{area}' in the search box or use Location → Area)",
        "Hostelworld": city_link("Hostelworld") + f"  (no area URL: open the map view and keep hostels inside {area}, or sort by distance)",
    }
    return {k: u for k, u in out.items() if u and not u.startswith("  (")}


def clean_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = parts.netloc.lower()
    keep = None
    for suffix, names in KEEP.items():
        if host == suffix or host.endswith("." + suffix):
            keep = names
            break
    q = []
    for k, v in parse_qsl(parts.query, keep_blank_values=True):
        if k.lower().startswith(ALWAYS_STRIP_PREFIX):
            continue
        if keep is not None and k not in keep:
            continue
        q.append((k, v))
    return urlunsplit((parts.scheme or "https", parts.netloc, parts.path, urlencode(q, safe="%,:/[]"), ""))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("positional", nargs="*", metavar="ORIGIN DEST CHECKIN CHECKOUT [TRAVELERS]",
                   help="shorthand for --origin --dest --checkin --checkout [--travelers]")
    p.add_argument("--clean", nargs="+", metavar="URL", help="strip tracking params from captured URLs and exit")
    p.add_argument("--suggest", metavar="TEXT", help="print city/airport matches for a partial name and exit")
    p.add_argument("--cities-json", action="store_true", help="print the city table as JSON and exit")
    p.add_argument("--origin", help="origin city or airport code, e.g. 'Los Angeles' or LAX")
    p.add_argument("--dest", help="destination city or airport code, e.g. 'Lisbon, Portugal' or LIS")
    p.add_argument("--checkin", help="mm-dd-yyyy, mm/dd/yyyy or yyyy-mm-dd (also the outbound flight date)")
    p.add_argument("--checkout", help="same formats (also the return flight date)")
    p.add_argument("--city", help="destination city name, if different from --dest")
    p.add_argument("--country", help="destination country, if not known from the city table")
    p.add_argument("--adults", "--travelers", dest="adults", type=int, default=1, help="number of travelers (adults); default 1")
    p.add_argument("--one-way", action="store_true", help="one-way flight on the check-in date (lodging still uses both dates)")
    p.add_argument("--children", type=int, default=0)
    p.add_argument("--rooms", type=int, default=1)
    p.add_argument("--cabin", choices=list(CABIN), default="economy")
    p.add_argument("--currency", default="USD")
    p.add_argument("--json", action="store_true", help="print JSON instead of markdown")
    p.add_argument("--areas", metavar="A,B,C",
                   help="tourist neighborhoods to search stays in, comma-separated (e.g. 'Copacabana,Ipanema,Lapa'): "
                        "prints each lodging site's search for each area")
    p.add_argument("--search-links", action="store_true",
                   help="print the trip JSON `search_links` object (Master Search List) and exit")
    a = p.parse_args(argv)

    if a.clean:
        for u in a.clean:
            print(clean_url(u))
        return 0
    if a.suggest is not None:
        hits = suggest(a.suggest)
        if a.json:
            print(json.dumps(hits, indent=2))
        elif hits:
            for h in hits:
                print(f"{h['city']}, {h['country']} ({h['iata']})")
        else:
            print(f"no match for {a.suggest!r}; use the airport code or 'City, Country'")
        return 0
    if a.cities_json:
        print(json.dumps([{"city": _pretty(n), "iata": c, "country": k} for n, (c, k) in CITIES.items()], ensure_ascii=False))
        return 0

    pos = a.positional
    if pos:
        if len(pos) not in (4, 5):
            p.error("positional form: ORIGIN DEST CHECKIN CHECKOUT [TRAVELERS]")
        a.origin, a.dest, a.checkin, a.checkout = (a.origin or pos[0], a.dest or pos[1], a.checkin or pos[2], a.checkout or pos[3])
        if len(pos) == 5:
            try:
                a.adults = int(pos[4])
            except ValueError:
                p.error(f"TRAVELERS must be a number, got {pos[4]!r}")
    if a.adults < 1:
        p.error("travelers must be at least 1")
    missing = [n for n in ("origin", "dest", "checkin", "checkout") if not getattr(a, n)]
    if missing:
        p.error("need " + ", ".join("--" + m for m in missing) + "  (or: ORIGIN DEST CHECKIN CHECKOUT)")
    try:
        ci, co = parse_date(a.checkin), parse_date(a.checkout)
    except ValueError as e:
        p.error(str(e))
    if co <= ci:
        p.error(f"check-out ({co}) must be after check-in ({ci})")
    if ci < date.today():
        print(f"WARNING: check-in {ci} is in the past.", file=sys.stderr)

    links = build_links(a)
    if a.areas:
        links["areas"] = {ar.strip(): area_links(links, ar.strip(), a) for ar in a.areas.split(",") if ar.strip()}
    if a.search_links:
        print(json.dumps(search_links(links), indent=1, ensure_ascii=False))
        return 0
    if a.json:
        print(json.dumps(links, indent=2))
        return 0

    m = links["meta"]
    print(f"# Search links: {m['origin'] or m['origin_city'] or '—'} → {m['city']}{' (' + m['dest'] + ')' if m['dest'] else ''}"
          f"{', ' + m['country'] if m['country'] else ''} · {m['checkin']} → {m['checkout']} · {m['nights']} nights · "
          f"{m['adults']} traveler{'s' if m['adults'] != 1 else ''}{', ' + str(m['children']) + ' children' if m['children'] else ''}"
          f" · {m['cabin']} · {m['currency']} · {'one-way flight' if m['trip_type'] == 'one_way' else 'round trip'}\n")
    for n in m["notes"]:
        print(f"NOTE: {n}\n")
    for vendor, cats in links["vendors"].items():
        print(f"## {vendor}")
        for cat, url in cats.items():
            print(f"- {cat}: {url}")
        print()
    for area, sites in (links.get("areas") or {}).items():
        print(f"## Stays in {area} (5 per tier per site: budget, mid, upper, luxury)")
        for site, url in sites.items():
            print(f"- {site}: {url}")
        print()
    print("## Coverage checklist (record each pair in trip JSON `coverage`: searched | no-inventory | blocked)")
    for vendor, cats in links["coverage_matrix"].items():
        print(f"- {vendor}: {', '.join(cats)}")
    print("\nLinks marked '(fill the form…)' have no stable deep link: open, fill dates/guests, copy the results URL.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
