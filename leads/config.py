"""Loads settings from .env (secrets) and config.yaml (everything else)."""
import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


class ConfigError(Exception):
    pass


@dataclass
class Config:
    categories: dict[str, list[str]]
    districts: list[str]
    searches_per_run: int
    monthly_cap: int
    pages_per_search: int
    delay_seconds: float
    score_threshold: int
    brief_model: str
    google_api_key: str = ""
    service_account_file: Path = field(default_factory=Path)
    sheet_id: str = ""
    sheet_tab: str = "Leads"
    anthropic_api_key: str = ""

    def require(self, *names: str) -> None:
        """Fail with a friendly message if any of the given secrets are missing."""
        missing = [n for n in names if not getattr(self, n)]
        if missing:
            env_names = {
                "google_api_key": "GOOGLE_API_KEY",
                "sheet_id": "SHEET_ID",
                "anthropic_api_key": "ANTHROPIC_API_KEY",
            }
            raise ConfigError(
                "Missing in .env: " + ", ".join(env_names.get(n, n) for n in missing)
            )


def load_config(root: Path = ROOT) -> Config:
    load_dotenv(root / ".env")
    config_path = root / "config.yaml"
    if not config_path.exists():
        raise ConfigError(f"config.yaml not found in {root}")
    with open(config_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    categories = raw.get("categories") or {}
    districts = raw.get("districts") or []
    if not categories or not all(categories.values()):
        raise ConfigError("config.yaml: every category needs at least one search term")
    if not districts:
        raise ConfigError("config.yaml: 'districts' is empty")

    places = raw.get("places") or {}
    sa_file = Path(os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "secrets/service-account.json"))
    if not sa_file.is_absolute():
        sa_file = root / sa_file

    return Config(
        categories=categories,
        districts=districts,
        searches_per_run=int(places.get("searches_per_run", 60)),
        monthly_cap=int(places.get("monthly_cap", 900)),
        pages_per_search=int(places.get("pages_per_search", 1)),
        delay_seconds=float(places.get("delay_seconds", 0.3)),
        score_threshold=int(raw.get("score_threshold", 60)),
        brief_model=raw.get("brief_model", "claude-sonnet-5-5"),
        google_api_key=os.getenv("GOOGLE_API_KEY", "").strip(),
        service_account_file=sa_file,
        sheet_id=os.getenv("SHEET_ID", "").strip(),
        sheet_tab=os.getenv("SHEET_TAB", "Leads").strip() or "Leads",
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
    )
