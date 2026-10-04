#!/usr/bin/env python3
"""Schreibt den Stand aus Supabase zurück in das Google Sheet.

Einbahnstraße: Supabase ist die Wahrheit, das Sheet ist der Spiegel. Der Tab
'Leads' wird vollständig neu geschrieben. Wer dort von Hand etwas ändert,
verliert es beim nächsten Lauf - genau deshalb legt der Lauf vorher eine
datierte Sicherungskopie des Tabs an.

    python scripts/export_to_sheet.py            # Probelauf
    python scripts/export_to_sheet.py --schreiben
"""
import argparse
from datetime import date, datetime

import gspread

from common import (
    format_date,
    format_number,
    sheets_client,
    supabase_client,
)
from sheet_schema import (
    BOOL_FIELDS,
    DATE_FIELDS,
    HEADER_ROW,
    NUMBER_FIELDS,
    PRIO_NAME,
    SPREADSHEET_ID,
    TAB_LEADS,
    export_fields,
    export_header,
)

# Wie viele datierte Sicherungen behalten werden.
BACKUPS_BEHALTEN = 7


def hole_leads(db):
    """Alle Leads über die Sicht, die Bearbeitername und Fälligkeit mitliefert."""
    alle, schritt, start = [], 1000, 0
    while True:
        antwort = (
            db.table("leads_ansicht")
            .select("*")
            .order("nr")
            .range(start, start + schritt - 1)
            .execute()
        )
        alle.extend(antwort.data)
        if len(antwort.data) < schritt:
            return alle
        start += schritt


def zelle(lead, feld):
    if not feld:
        return ""
    wert = lead.get(feld)
    if wert is None or wert == "":
        return ""
    if feld in DATE_FIELDS or feld in ("erstellt_am", "geaendert_am"):
        if feld in ("erstellt_am", "geaendert_am"):
            try:
                return datetime.fromisoformat(str(wert).replace("Z", "+00:00")).strftime(
                    "%d.%m.%Y %H:%M"
                )
            except ValueError:
                return str(wert)
        return format_date(wert)
    if feld in BOOL_FIELDS:
        return "Ja" if wert else "Nein"
    if feld == "prioritaet":
        return PRIO_NAME.get(int(wert), str(wert))
    if feld == "abschluss_wahrsch":
        return f"{float(wert) * 100:.0f} %"
    if feld in ("angebotswert", "gewichteter_wert"):
        # Der gewichtete Wert wird in der Datenbank immer gerechnet und ist
        # nie leer. Ohne Angebot steht da eine 0 - als Kolonne über tausend
        # Zeilen nur Rauschen, deshalb leer lassen.
        return "" if float(wert) == 0 else format_number(wert, 2)
    if feld in NUMBER_FIELDS:
        return format_number(wert, 0)
    return str(wert)


def raster_vergroessern(blatt, zeilen_noetig, spalten_noetig):
    """Google lehnt Schreibzugriffe ausserhalb des Rasters ab. Der Tab waechst
    nicht von allein mit, also vorher nachsehen und anbauen."""
    gewachsen = []

    if blatt.row_count < zeilen_noetig:
        blatt.add_rows(zeilen_noetig - blatt.row_count + 50)   # etwas Luft
        gewachsen.append(f"Zeilen {blatt.row_count}")

    if blatt.col_count < spalten_noetig:
        blatt.add_cols(spalten_noetig - blatt.col_count)
        gewachsen.append(f"Spalten {blatt.col_count}")

    return gewachsen


def sicherung_anlegen(buch, blatt):
    """Kopie des Tabs anlegen und alte Sicherungen aufräumen."""
    name = f"Sicherung {date.today():%Y-%m-%d}"
    for vorhandenes in buch.worksheets():
        if vorhandenes.title == name:
            buch.del_worksheet(vorhandenes)
            break
    kopie = blatt.duplicate(new_sheet_name=name, insert_sheet_index=len(buch.worksheets()))
    kopie.hide()

    sicherungen = sorted(
        (w for w in buch.worksheets() if w.title.startswith("Sicherung ")),
        key=lambda w: w.title,
    )
    for alt in sicherungen[:-BACKUPS_BEHALTEN]:
        buch.del_worksheet(alt)
        print(f"  alte Sicherung entfernt: {alt.title}")
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schreiben", action="store_true",
                    help="Tatsächlich ins Sheet schreiben. Ohne diese Angabe nur Probelauf.")
    ap.add_argument("--ohne-sicherung", action="store_true",
                    help="Keine Sicherungskopie anlegen (nicht empfohlen).")
    args = ap.parse_args()

    leads = hole_leads(supabase_client())
    kopf = export_header()
    felder = export_fields()
    zeilen = [[zelle(lead, feld) for feld in felder] for lead in leads]

    print(f"Leads aus Supabase:   {len(leads)}")
    print(f"Spalten:              {len(kopf)}")

    if not args.schreiben:
        print("\nProbelauf - es wurde nichts geschrieben. Mit --schreiben ausführen.")
        if zeilen:
            print("\nErste Zeile, wie sie im Sheet landen würde:")
            for name, wert in list(zip(kopf, zeilen[0]))[:14]:
                print(f"  {name:34} {wert!r}")
        return

    buch = sheets_client().open_by_key(SPREADSHEET_ID)
    blatt = buch.worksheet(TAB_LEADS)

    print(f"Tab vorher:           {blatt.row_count} Zeilen, {blatt.col_count} Spalten")
    gewachsen = raster_vergroessern(blatt, HEADER_ROW + len(zeilen), len(kopf))
    if gewachsen:
        print(f"  Raster erweitert -> {blatt.row_count} Zeilen, {blatt.col_count} Spalten")

    if not args.ohne_sicherung:
        name = sicherung_anlegen(buch, blatt)
        print(f"  Sicherung angelegt: {name}")

    # Ab der Kopfzeile alles raus, Titelbalken in Zeile 1 bleibt stehen.
    letzte = gspread.utils.rowcol_to_a1(blatt.row_count, blatt.col_count)
    blatt.batch_clear([f"A{HEADER_ROW}:{letzte}"])

    inhalt = [kopf] + zeilen
    blatt.update(
        inhalt,
        range_name=f"A{HEADER_ROW}",
        value_input_option=gspread.utils.ValueInputOption.user_entered,
    )
    blatt.format(
        f"A{HEADER_ROW}:{gspread.utils.rowcol_to_a1(HEADER_ROW, len(kopf))}",
        {"textFormat": {"bold": True}},
    )
    blatt.freeze(rows=HEADER_ROW)

    print(f"\nFertig. {len(zeilen)} Zeilen ins Sheet geschrieben.")
    print(f"Stand: {datetime.now():%d.%m.%Y %H:%M}")


if __name__ == "__main__":
    main()
