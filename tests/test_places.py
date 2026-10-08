import json
from datetime import date
from pathlib import Path

import pytest

from leads.places import (PlacesClient, PlacesError, Search, UsageTracker,
                          build_searches, detect_district, find_leads, parse_place)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "search_kadernictvo_petrzalka.json")
    .read_text(encoding="utf-8"))
DISTRICTS = ["Staré Mesto", "Petržalka", "Devín", "Devínska Nová Ves"]
SEARCH = Search("Beauty & hair", "kaderníctvo", "Petržalka")


class FakeResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self._data = data
        self.text = json.dumps(data)

    def json(self):
        return self._data


class FakeSession:
    """Returns queued responses and records every request body."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.bodies = []

    def post(self, url, json, headers, timeout):
        self.bodies.append(json)
        return self.responses.pop(0)


def client_with(*responses):
    session = FakeSession(responses)
    return PlacesClient("key", session=session, sleep=lambda s: None), session


def test_build_searches_covers_every_term_in_every_district():
    searches = build_searches({"A": ["t1", "t2"], "B": ["t3"]}, ["D1", "D2"])
    assert len(searches) == 6
    assert searches[0] == Search("A", "t1", "D1")
    assert searches[0].query == "t1 D1 Bratislava"


def test_parse_place_keeps_only_needed_fields():
    lead = parse_place(FIXTURE["places"][0], SEARCH, DISTRICTS, "2026-10-06")
    assert lead == {
        "place_id": "ChIJ_salon_one",
        "name": "Salón Krása",
        "category": "Beauty & hair",
        "search_term": "kaderníctvo",
        "district": "Petržalka",
        "address": "Romanova 12, 851 02 Bratislava-Petržalka, Slovensko",
        "phone": "0905 123 456",
        "website": "http://www.salonkrasa.sk/",
        "rating": 4.8,
        "reviews": 213,
        "maps_link": "https://www.google.com/maps/place/?q=place_id:ChIJ_salon_one",
        "first_found": "2026-10-06",
    }


def test_parse_place_skips_closed_and_outside_bratislava():
    assert parse_place(FIXTURE["places"][1], SEARCH, DISTRICTS, "x") is None
    assert parse_place(FIXTURE["places"][2], SEARCH, DISTRICTS, "x") is None


def test_missing_website_and_district_fall_back():
    lead = parse_place(FIXTURE["places"][3], SEARCH, DISTRICTS, "x")
    assert lead["website"] == ""
    assert lead["district"] == "Petržalka"  # the district we searched in


def test_detect_district_prefers_longest_match():
    assert detect_district(FIXTURE["places"][4], DISTRICTS, "Staré Mesto") == "Devínska Nová Ves"


def test_find_leads_dedupes_and_counts_usage(tmp_path):
    client, session = client_with(FakeResponse(200, FIXTURE), FakeResponse(200, FIXTURE))
    usage = UsageTracker(tmp_path / "usage.json", today=date(2026, 10, 6))
    searches = [SEARCH, Search("Beauty & hair", "barbershop", "Petržalka")]
    leads = find_leads(client, usage, searches, DISTRICTS, max_searches=2,
                       monthly_cap=100, log=lambda m: None)
    assert sorted(l["place_id"] for l in leads) == ["ChIJ_dnv", "ChIJ_no_site", "ChIJ_salon_one"]
    assert usage.places_this_month == 2
    assert session.bodies[0]["textQuery"] == "kaderníctvo Petržalka Bratislava"
    assert session.bodies[0]["regionCode"] == "SK"


def test_rotation_continues_where_last_run_stopped(tmp_path):
    path = tmp_path / "usage.json"
    searches = build_searches({"A": ["t1", "t2", "t3"]}, ["D1"])
    empty = FakeResponse(200, {})

    client, session = client_with(empty, empty)
    find_leads(client, UsageTracker(path), searches, ["D1"], 2, 100, log=lambda m: None)
    client, session = client_with(empty, empty)
    find_leads(client, UsageTracker(path), searches, ["D1"], 2, 100, log=lambda m: None)

    # Second run: t3, then wraps around to t1.
    assert [b["textQuery"] for b in session.bodies] == ["t3 D1 Bratislava", "t1 D1 Bratislava"]
    assert UsageTracker(path).rotation_index == 1


def test_monthly_cap_stops_requests(tmp_path):
    usage = UsageTracker(tmp_path / "usage.json")
    usage.months[usage.month]["places_text_search"] = 5
    client, session = client_with()
    leads = find_leads(client, usage, [SEARCH], DISTRICTS, 1, monthly_cap=5, log=lambda m: None)
    assert leads == [] and session.bodies == []
    assert usage.rotation_index == 0  # the skipped search runs next time


def test_usage_resets_each_month(tmp_path):
    path = tmp_path / "usage.json"
    october = UsageTracker(path, today=date(2026, 10, 30))
    october.add_places_request()
    november = UsageTracker(path, today=date(2026, 11, 1))
    assert november.places_this_month == 0
    assert november.months["2026-10"]["places_text_search"] == 1


def test_pagination_follows_next_page_token(tmp_path):
    last_page = {"places": []}
    client, session = client_with(FakeResponse(200, FIXTURE), FakeResponse(200, last_page))
    usage = UsageTracker(tmp_path / "usage.json")
    find_leads(client, usage, [SEARCH], DISTRICTS, 1, 100, pages_per_search=3,
               log=lambda m: None)
    assert session.bodies[1]["pageToken"] == "page-2-token"
    assert usage.places_this_month == 2


def test_retries_then_raises_readable_error(tmp_path):
    busy = FakeResponse(503, {})
    denied = FakeResponse(403, {"error": {"message": "API key not valid."}})
    client, session = client_with(busy, denied)
    with pytest.raises(PlacesError, match="403: API key not valid"):
        client.search_text("x")
    assert len(session.bodies) == 2
