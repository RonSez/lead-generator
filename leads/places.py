"""Stage 1 - Find: search businesses with the Google Places API (New) Text Search.

Only the fields needed for calling are requested (data minimisation + cost).
Every request is counted in state/usage.json so a monthly cap can be enforced.
"""
import json
import time
import unicodedata
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import requests

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Fields we store. Requesting phone/website/rating puts the call in the
# "Text Search Enterprise" pricing tier, so keep this list short.
LEAD_FIELDS = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.addressComponents",
    "places.nationalPhoneNumber",
    "places.websiteUri",
    "places.rating",
    "places.userRatingCount",
    "places.businessStatus",
    "nextPageToken",
]
# IDs-only requests are in the free "Essentials (IDs Only)" tier; used by `doctor`.
IDS_ONLY_FIELDS = ["places.id"]

# Rectangle around the city of Bratislava (all 17 city parts).
BRATISLAVA_BOUNDS = {
    "rectangle": {
        "low": {"latitude": 48.00, "longitude": 16.94},
        "high": {"latitude": 48.28, "longitude": 17.26},
    }
}

RETRY_STATUSES = {429, 500, 502, 503, 504}


class PlacesError(Exception):
    pass


class MonthlyCapReached(Exception):
    pass


@dataclass(frozen=True)
class Search:
    category: str
    term: str
    district: str

    @property
    def query(self) -> str:
        return f"{self.term} {self.district} Bratislava"


def build_searches(categories: dict[str, list[str]], districts: list[str]) -> list[Search]:
    """Every search term in every district, district by district."""
    return [
        Search(category, term, district)
        for district in districts
        for category, terms in categories.items()
        for term in terms
    ]


def normalize(text: str) -> str:
    """Lowercase and strip diacritics: 'Ružinov' -> 'ruzinov'."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


class UsageTracker:
    """Remembers API usage for the current month and where the rotation stopped."""

    def __init__(self, path: Path, today: date | None = None):
        self.path = path
        self.month = (today or date.today()).strftime("%Y-%m")
        data = {}
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
        self.rotation_index = int(data.get("rotation_index", 0))
        months = data.get("months", {})
        self.months = months
        self.months.setdefault(self.month, {"places_text_search": 0})

    @property
    def places_this_month(self) -> int:
        return self.months[self.month]["places_text_search"]

    def add_places_request(self) -> None:
        self.months[self.month]["places_text_search"] += 1
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {"rotation_index": self.rotation_index, "months": self.months}
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")


class PlacesClient:
    def __init__(self, api_key: str, session: requests.Session | None = None,
                 delay_seconds: float = 0.3, sleep=time.sleep):
        self.api_key = api_key
        self.session = session or requests.Session()
        self.delay_seconds = delay_seconds
        self.sleep = sleep

    def search_text(self, query: str, fields: list[str] = LEAD_FIELDS,
                    page_token: str | None = None) -> dict:
        body = {
            "textQuery": query,
            "languageCode": "sk",
            "regionCode": "SK",
            "locationRestriction": BRATISLAVA_BOUNDS,
            "pageSize": 20,
        }
        if page_token:
            body["pageToken"] = page_token
        headers = {
            "X-Goog-Api-Key": self.api_key,
            "X-Goog-FieldMask": ",".join(fields),
            "Content-Type": "application/json",
        }
        for attempt in range(3):
            self.sleep(self.delay_seconds if attempt == 0 else 2 ** attempt)
            resp = self.session.post(SEARCH_URL, json=body, headers=headers, timeout=30)
            if resp.status_code in RETRY_STATUSES and attempt < 2:
                continue
            if resp.status_code != 200:
                raise PlacesError(_error_message(resp))
            return resp.json()
        raise PlacesError("unreachable")


def _error_message(resp) -> str:
    try:
        msg = resp.json().get("error", {}).get("message", "")
    except ValueError:
        msg = resp.text[:200]
    return f"Places API error {resp.status_code}: {msg}"


def detect_district(place: dict, districts: list[str], fallback: str) -> str:
    """Find the city part in the address; fall back to the district we searched."""
    texts = [place.get("formattedAddress", "")]
    for comp in place.get("addressComponents", []):
        texts.append(comp.get("longText", ""))
    haystack = normalize(" | ".join(texts))
    # Longest names first so "Devínska Nová Ves" wins over "Devín".
    for district in sorted(districts, key=len, reverse=True):
        if normalize(district) in haystack:
            return district
    return fallback


def parse_place(place: dict, search: Search, districts: list[str],
                found_on: str) -> dict | None:
    """Turn an API result into a lead, or None if it should be skipped."""
    status = place.get("businessStatus", "OPERATIONAL")
    address = place.get("formattedAddress", "")
    if status != "OPERATIONAL" or "bratislava" not in normalize(address):
        return None
    place_id = place["id"]
    return {
        "place_id": place_id,
        "name": place.get("displayName", {}).get("text", ""),
        "category": search.category,
        "search_term": search.term,
        "district": detect_district(place, districts, search.district),
        "address": address,
        "phone": place.get("nationalPhoneNumber", ""),
        "website": place.get("websiteUri", ""),
        "rating": place.get("rating"),
        "reviews": place.get("userRatingCount", 0),
        "maps_link": f"https://www.google.com/maps/place/?q=place_id:{place_id}",
        "first_found": found_on,
    }


def find_leads(client: PlacesClient, usage: UsageTracker, searches: list[Search],
               districts: list[str], max_searches: int, monthly_cap: int,
               pages_per_search: int = 1, rotate: bool = True,
               log=print) -> list[dict]:
    """Run up to `max_searches` searches and return unique leads.

    With rotate=True, starts where the previous run stopped and saves the new
    position, so repeated runs walk through all searches.
    """
    if not searches:
        return []
    start = usage.rotation_index % len(searches) if rotate else 0
    count = min(max_searches, len(searches))
    batch = [searches[(start + i) % len(searches)] for i in range(count)]
    found_on = date.today().isoformat()
    leads: dict[str, dict] = {}
    done = 0
    try:
        for search in batch:
            page_token = None
            for _ in range(pages_per_search):
                if usage.places_this_month >= monthly_cap:
                    raise MonthlyCapReached(
                        f"Monthly cap of {monthly_cap} Places requests reached; stopping."
                    )
                data = client.search_text(search.query, page_token=page_token)
                usage.add_places_request()
                places = data.get("places", [])
                new = 0
                for place in places:
                    lead = parse_place(place, search, districts, found_on)
                    if lead and lead["place_id"] not in leads:
                        leads[lead["place_id"]] = lead
                        new += 1
                log(f"  {search.query}: {len(places)} results, {new} new")
                page_token = data.get("nextPageToken")
                if not page_token:
                    break
            done += 1
    except MonthlyCapReached as e:
        log(str(e))
    finally:
        if rotate:
            usage.rotation_index = (start + done) % len(searches)
            usage.save()
    return list(leads.values())
