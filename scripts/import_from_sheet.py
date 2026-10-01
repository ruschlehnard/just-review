#!/usr/bin/env python3
"""Liest den Tab 'Leads' aus dem Google Sheet und legt ihn in Supabase ab.

Einmalig beim Aufsetzen. Lässt sich gefahrlos wiederholen: Zeilen werden über
den Import-Schlüssel (Firmenname|Straße|Ort) wiedererkannt, nicht doppelt
angelegt.

    python scripts/import_from_sheet.py            # Probelauf, schreibt nichts
    python scripts/import_from_sheet.py --schreiben
"""
import argparse
import sys
from collections import Counter

from common import (
    import_key,
    parse_bool,
    parse_date,
    parse_number,
    sheets_client,
    supabase_client,
)
from sheet_schema import (
    BOOL_FIELDS,
    DATE_FIELDS,
    FIRST_DATA_ROW,
    HEADER_ROW,
    NUMBER_FIELDS,
    SHEET_COLUMNS,
    SPREADSHEET_ID,
    TAB_LEADS,
)

# Felder, die nur im Dashboard berechnet werden und nicht importiert gehören.
BERECHNET = {"nr", "faellig_in_tagen", "gewichteter_wert", "erstellt_am"}


def lies_sheet():
    sheet = sheets_client().open_by_key(SPREADSHEET_ID).worksheet(TAB_LEADS)
    werte = sheet.get_all_values()
    if len(werte) < FIRST_DATA_ROW:
        sys.exit("Der Tab 'Leads' enthält keine Datenzeilen.")

    kopf = werte[HEADER_ROW - 1]
    erwartet = [name for name, _ in SHEET_COLUMNS]
    if kopf[: len(erwartet)] != erwartet:
        print("WARNUNG: Die Kopfzeile weicht von sheet_schema.py ab.")
        for i, (ist, soll) in enumerate(zip(kopf, erwartet)):
            if ist != soll:
                print(f"  Spalte {i + 1}: Sheet='{ist}'  erwartet='{soll}'")
        print("  Prüfe sheet_schema.py, bevor du mit --schreiben arbeitest.\n")

    return werte[FIRST_DATA_ROW - 1 :]


def zeile_zu_lead(zeile):
    lead = {}
    for i, (_, feld) in enumerate(SHEET_COLUMNS):
        if not feld or feld in BERECHNET:
            continue
        roh = zeile[i] if i < len(zeile) else ""
        if feld in DATE_FIELDS:
            wert = parse_date(roh)
            lead[feld] = wert.isoformat() if wert else None
        elif feld in NUMBER_FIELDS:
            lead[feld] = parse_number(roh)
        elif feld in BOOL_FIELDS:
            lead[feld] = parse_bool(roh)
        else:
            lead[feld] = (roh or "").strip()

    # Abschluss-Wahrscheinlichkeit muss zwischen 0 und 1 liegen.
    aw = lead.get("abschluss_wahrsch")
    if aw is not None and aw > 1:
        lead["abschluss_wahrsch"] = round(aw / 100, 2)

    lead["anzahl_kontakte"] = int(lead.get("anzahl_kontakte") or 0)
    lead["land"] = lead.get("land") or "Deutschland"
    lead["status"] = lead.get("status") or "Neu"
    lead["import_schluessel"] = import_key(
        lead.get("firmenname"), lead.get("strasse"), lead.get("ort")
    )
    return lead


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schreiben", action="store_true",
                    help="Tatsächlich in Supabase schreiben. Ohne diese Angabe nur Probelauf.")
    args = ap.parse_args()

    zeilen = lies_sheet()
    leads, leer, dubletten = [], 0, Counter()
    gesehen = set()

    for zeile in zeilen:
        lead = zeile_zu_lead(zeile)
        # Eine Zeile ohne Firmenname und ohne Ansprechpartner ist eine Leerzeile.
        if not lead["firmenname"] and not lead["ansprechpartner"]:
            leer += 1
            continue
        schluessel = lead["import_schluessel"]
        if schluessel in gesehen:
            dubletten[schluessel] += 1
            continue
        gesehen.add(schluessel)
        leads.append(lead)

    print(f"Zeilen im Sheet:      {len(zeilen)}")
    print(f"Leerzeilen übersprungen: {leer}")
    print(f"Dubletten im Sheet:   {sum(dubletten.values())}")
    print(f"Zu importieren:       {len(leads)}")

    if dubletten:
        print("\nDubletten (Firmenname|Straße|Ort):")
        for schluessel, anzahl in dubletten.most_common(15):
            print(f"  {anzahl + 1}x  {schluessel}")

    ohne_name = sum(1 for lead in leads if not lead["firmenname"])
    if ohne_name:
        print(f"\nHinweis: {ohne_name} Leads haben keinen Firmennamen, nur einen "
              "Ansprechpartner. Die kommen mit, sind im Dashboard aber schwer zu finden.")

    if not args.schreiben:
        print("\nProbelauf - es wurde nichts geschrieben. Mit --schreiben ausführen.")
        if leads:
            print("\nBeispiel des ersten Datensatzes:")
            for k, v in list(leads[0].items())[:12]:
                print(f"  {k:24} {v!r}")
        return

    db = supabase_client()
    block = 200
    geschrieben = 0
    for i in range(0, len(leads), block):
        teil = leads[i : i + block]
        db.table("leads").upsert(teil, on_conflict="import_schluessel").execute()
        geschrieben += len(teil)
        print(f"  {geschrieben}/{len(leads)} geschrieben")

    print(f"\nFertig. {geschrieben} Leads in Supabase.")


if __name__ == "__main__":
    main()
