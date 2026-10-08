"""Lead pipeline entry point.

Usage:
  python run.py doctor                      check keys, APIs and sheet access
  python run.py find [--limit N]            next N searches in the rotation
  python run.py find --term kaderníctvo --district Petržalka   one ad-hoc search
"""
import argparse
import json
import sys
from datetime import datetime

from leads.config import ROOT, ConfigError, load_config
from leads.places import (IDS_ONLY_FIELDS, PlacesClient, PlacesError, Search,
                          UsageTracker, build_searches, find_leads)

USAGE_FILE = ROOT / "state" / "usage.json"
DATA_DIR = ROOT / "data"


def cmd_doctor(cfg, args) -> int:
    ok = True
    searches = build_searches(cfg.categories, cfg.districts)
    print(f"[ok] config.yaml: {sum(map(len, cfg.categories.values()))} search terms x "
          f"{len(cfg.districts)} districts = {len(searches)} searches")

    for name, env in [("google_api_key", "GOOGLE_API_KEY"), ("sheet_id", "SHEET_ID")]:
        if getattr(cfg, name):
            print(f"[ok] {env} is set")
        else:
            print(f"[!!] {env} is missing in .env")
            ok = False
    if not cfg.anthropic_api_key:
        print("[--] ANTHROPIC_API_KEY not set yet (only needed for call briefs, stage 5)")

    if cfg.google_api_key:
        try:
            # IDs-only request: free tier, not counted against the monthly cap.
            data = PlacesClient(cfg.google_api_key).search_text(
                "kaderníctvo Bratislava", fields=IDS_ONLY_FIELDS)
            print(f"[ok] Places API (New) works ({len(data.get('places', []))} test results)")
        except PlacesError as e:
            print(f"[!!] {e}")
            ok = False

    ok = check_sheet(cfg) and ok

    usage = UsageTracker(USAGE_FILE)
    print(f"[ok] Places requests this month: {usage.places_this_month} / cap {cfg.monthly_cap}")
    print("\nAll good." if ok else "\nFix the [!!] items above, then run doctor again.")
    return 0 if ok else 1


def check_sheet(cfg) -> bool:
    sa = cfg.service_account_file
    if not sa.exists():
        print(f"[!!] Service account file not found: {sa}")
        return False
    sa_email = json.loads(sa.read_text(encoding="utf-8")).get("client_email", "?")
    print(f"[ok] Service account: {sa_email}")
    if not cfg.sheet_id:
        return False
    import gspread
    try:
        sheet = gspread.service_account(filename=str(sa)).open_by_key(cfg.sheet_id)
    except gspread.exceptions.APIError as e:
        print(f"[!!] Cannot open the sheet ({e}).\n"
              f"     Share it with {sa_email} as Editor, and check that the "
              f"Google Sheets API is enabled.")
        return False
    except gspread.exceptions.SpreadsheetNotFound:
        print(f"[!!] Sheet not found. Check SHEET_ID and share it with {sa_email}.")
        return False
    tabs = [ws.title for ws in sheet.worksheets()]
    if cfg.sheet_tab not in tabs:
        print(f"[!!] Sheet '{sheet.title}' has no tab named '{cfg.sheet_tab}' "
              f"(tabs: {', '.join(tabs)})")
        return False
    print(f"[ok] Sheet '{sheet.title}' -> tab '{cfg.sheet_tab}' is accessible")
    return True


def cmd_find(cfg, args) -> int:
    cfg.require("google_api_key")
    usage = UsageTracker(USAGE_FILE)
    client = PlacesClient(cfg.google_api_key, delay_seconds=cfg.delay_seconds)

    if args.term or args.district:
        if not (args.term and args.district):
            print("Use --term and --district together.")
            return 2
        category = next((c for c, terms in cfg.categories.items() if args.term in terms),
                        "Other")
        searches, rotate = [Search(category, args.term, args.district)], False
    else:
        searches, rotate = build_searches(cfg.categories, cfg.districts), True

    limit = args.limit if args.limit is not None else cfg.searches_per_run
    print(f"Running up to {limit} search(es); "
          f"used this month: {usage.places_this_month}/{cfg.monthly_cap}")
    try:
        leads = find_leads(client, usage, searches, cfg.districts, limit, cfg.monthly_cap,
                           pages_per_search=cfg.pages_per_search, rotate=rotate)
    except PlacesError as e:
        print(f"Error: {e}")
        return 1

    DATA_DIR.mkdir(exist_ok=True)
    out = DATA_DIR / f"found_{datetime.now():%Y-%m-%d_%H%M}.json"
    out.write_text(json.dumps(leads, ensure_ascii=False, indent=2), encoding="utf-8")

    print_table(leads)
    print(f"\n{len(leads)} businesses saved to {out.relative_to(ROOT)}")
    print(f"Places requests this month: {usage.places_this_month}/{cfg.monthly_cap}")
    return 0


def print_table(leads: list[dict]) -> None:
    if not leads:
        print("\nNo businesses found.")
        return
    print()
    print(f"{'Business':<38} {'District':<18} {'Phone':<16} {'Rating':>6} {'Reviews':>7}  Website")
    for lead in sorted(leads, key=lambda l: -(l["reviews"] or 0)):
        rating = f"{lead['rating']:.1f}" if lead["rating"] else "-"
        print(f"{lead['name'][:38]:<38} {lead['district'][:18]:<18} {lead['phone'][:16]:<16} "
              f"{rating:>6} {lead['reviews'] or 0:>7}  {lead['website'][:45] or '(none)'}")


def main() -> int:
    # Slovak characters in the Windows console.
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Bratislava lead pipeline")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor", help="check keys, APIs and sheet access")
    find = sub.add_parser("find", help="search businesses with Google Places")
    find.add_argument("--limit", type=int, help="max searches this run")
    find.add_argument("--term", help="one search term, e.g. kaderníctvo")
    find.add_argument("--district", help="one district, e.g. Petržalka")
    args = parser.parse_args()

    try:
        cfg = load_config()
    except ConfigError as e:
        print(f"Config problem: {e}")
        return 2
    commands = {"doctor": cmd_doctor, "find": cmd_find}
    try:
        return commands[args.command](cfg, args)
    except ConfigError as e:
        print(f"Config problem: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
