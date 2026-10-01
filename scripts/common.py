"""Zugänge und Hilfsfunktionen für Import und Export."""
import os
import re
import sys
from datetime import date, datetime

import gspread
from google.oauth2.service_account import Credentials
from supabase import create_client

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def _require(name):
    val = os.environ.get(name)
    if not val:
        sys.exit(
            f"Umgebungsvariable {name} fehlt.\n"
            "Lokal: in eine .env schreiben und 'set -a; source .env; set +a' ausführen.\n"
            "In GitHub: unter Settings → Secrets and variables → Actions hinterlegen."
        )
    return val


def sheets_client():
    """Google-Client über den Dienstaccount."""
    raw = _require("GOOGLE_SERVICE_ACCOUNT_JSON")
    import json

    try:
        info = json.loads(raw)
    except json.JSONDecodeError:
        # Erlaubt auch einen Pfad statt des JSON-Inhalts.
        with open(raw) as f:
            info = json.load(f)
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return gspread.authorize(creds)


def supabase_client():
    """Supabase mit dem Service-Role-Schlüssel - umgeht RLS, nur serverseitig."""
    return create_client(_require("SUPABASE_URL"), _require("SUPABASE_SERVICE_KEY"))


# --------------------------------------------------------------- Umwandlung

_DATE_PATTERNS = ("%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d", "%d/%m/%Y")


def parse_date(value):
    """Deutsche und ISO-Datumsangaben zu einem date-Objekt."""
    if not value:
        return None
    if isinstance(value, (date, datetime)):
        return value.date() if isinstance(value, datetime) else value
    text = str(value).strip()
    if not text:
        return None
    for pattern in _DATE_PATTERNS:
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def parse_number(value):
    """'1.234,56 €' und '45 %' zu einer Zahl. Prozent wird zum Bruch."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return value
    text = str(value).strip()
    if not text:
        return None
    prozent = "%" in text
    text = re.sub(r"[^\d,.\-]", "", text)
    if not text or text in ("-", ".", ","):
        return None
    # Deutsche Schreibweise: Punkt trennt Tausender, Komma die Dezimalen.
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        num = float(text)
    except ValueError:
        return None
    return num / 100 if prozent else num


def parse_bool(value):
    if value is None or value == "":
        return None
    text = str(value).strip().lower()
    if text in ("ja", "true", "wahr", "1", "x", "y", "yes"):
        return True
    if text in ("nein", "false", "falsch", "0", "n", "no"):
        return False
    return None


def format_date(value):
    """Zurück ins deutsche Format, wie es im Sheet steht."""
    if not value:
        return ""
    if isinstance(value, str):
        value = parse_date(value)
        if not value:
            return ""
    return value.strftime("%d.%m.%Y")


def format_number(value, nachkomma=2):
    if value is None or value == "":
        return ""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return str(value)
    if num == int(num) and nachkomma == 0:
        return str(int(num))
    return f"{num:.{nachkomma}f}".replace(".", ",")


def import_key(firmenname, strasse, ort):
    """Stabiler Schlüssel, um dieselbe Zeile wiederzuerkennen.

    Bewusst unempfindlich gegen Gross-/Kleinschreibung und Mehrfach-
    Leerzeichen, damit ein erneuter Import keine Dubletten erzeugt.
    """
    teile = [re.sub(r"\s+", " ", (t or "").strip().lower()) for t in (firmenname, strasse, ort)]
    return "|".join(teile)
