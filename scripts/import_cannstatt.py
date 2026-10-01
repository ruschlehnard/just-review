#!/usr/bin/env python3
"""Lädt die 513 recherchierten Leads aus Bad Cannstatt und Münster nach Supabase.

Quelle ist cannstatt_leads.csv, erzeugt am 01.10.2026 aus OpenStreetMap über
die Overpass API. Nur Kern-Zielbranchen, Filialisten bereits entfernt.

    python scripts/import_cannstatt.py            # Probelauf
    python scripts/import_cannstatt.py --schreiben
"""
import argparse
import csv
import os
from collections import Counter

from common import import_key, supabase_client

CSV_PFAD = os.path.join(os.path.dirname(__file__), "cannstatt_leads.csv")

# Die Branchenbezeichnungen der Recherche auf eure Liste abbilden.
BRANCHE_MAP = {
    "Restaurant": "Restaurant / Gastronomie",
    "Imbiss": "Restaurant / Gastronomie",
    "Café": "Café / Bar",
    "Eiscafé": "Café / Bar",
    "Bar": "Café / Bar",
    "Kneipe": "Café / Bar",
    "Biergarten": "Café / Bar",
    "Club": "Café / Bar",
    "Friseur": "Friseur / Barbershop",
    "Kosmetikstudio": "Kosmetik / Nagelstudio",
    "Nagelstudio": "Kosmetik / Nagelstudio",
    "Massage": "Kosmetik / Nagelstudio",
    "Tattoostudio": "Kosmetik / Nagelstudio",
    "KFZ-Werkstatt": "Autohaus / Kfz-Werkstatt",
    "Autohaus": "Autohaus / Kfz-Werkstatt",
    "KFZ-Teile": "Autohaus / Kfz-Werkstatt",
    "Reifenhandel": "Autohaus / Kfz-Werkstatt",
}

# Alles aus dem Handwerk, was nicht oben steht, landet hier.
HANDWERK = "Handwerksbetrieb"
EINZELHANDEL = "Einzelhandel"


def branche_mappen(branche, gruppe):
    if branche in BRANCHE_MAP:
        return BRANCHE_MAP[branche]
    if gruppe == "Handwerk":
        return HANDWERK
    if gruppe == "Einzelhandel":
        return EINZELHANDEL
    return branche


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schreiben", action="store_true")
    ap.add_argument("--bearbeiter", default=None,
                    help="UUID des Mitarbeiters, dem die Leads zugeordnet werden.")
    args = ap.parse_args()

    with open(CSV_PFAD, encoding="utf-8") as f:
        zeilen = list(csv.DictReader(f, delimiter=";"))

    leads = []
    for z in zeilen:
        bezirk = z["Stadtbezirk"].split(" (")[0]
        notiz_teile = [f"Stadtbezirk {bezirk}"]
        if z["Hallschlag"]:
            notiz_teile.append("Stadtteil Hallschlag")
        if z["Adressquelle"] != "OSM-Tag":
            notiz_teile.append(f"Adresse: {z['Adressquelle']}")
        if z["Hinweis"]:
            notiz_teile.append(z["Hinweis"])

        leads.append({
            "firmenname": z["Firmenname"],
            "branche": branche_mappen(z["Branche"], z["Gruppe"]),
            "email": z["E-Mail"],
            "telefon": z["Telefon"],
            "website": z["Website"],
            "strasse": z["Strasse"],
            "plz": z["PLZ"],
            "ort": z["Ort"],
            "land": "Deutschland",
            "status": "Neu",
            "lead_quelle": "Recherche Leon 01.10.2026",
            "google_profil_vorhanden": None,   # nicht geprüft, also offen lassen
            "notizen": " · ".join(notiz_teile),
            "bearbeiter": args.bearbeiter,
            "import_schluessel": import_key(z["Firmenname"], z["Strasse"], z["Ort"]),
        })

    print(f"Leads in der CSV:  {len(zeilen)}")
    print(f"Branchen:          {dict(Counter(l['branche'] for l in leads).most_common())}")
    print(f"ohne Website:      {sum(1 for l in leads if not l['website'])}")
    if not args.bearbeiter:
        print("\nHinweis: Kein --bearbeiter angegeben, die Leads bleiben unzugeordnet.")

    if not args.schreiben:
        print("\nProbelauf - nichts geschrieben. Mit --schreiben ausführen.")
        return

    db = supabase_client()
    for i in range(0, len(leads), 200):
        db.table("leads").upsert(leads[i : i + 200], on_conflict="import_schluessel").execute()
        print(f"  {min(i + 200, len(leads))}/{len(leads)} geschrieben")
    print("\nFertig.")


if __name__ == "__main__":
    main()
