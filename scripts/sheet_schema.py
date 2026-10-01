"""Gemeinsame Beschreibung eures Google Sheets.

Import und Export lesen beide hieraus, damit es nur eine Stelle gibt, an der
die Spaltenreihenfolge steht. Ändert sich die Tabelle, ändert sich nur diese
Datei.
"""

SPREADSHEET_ID = "1Wq90ST8TcM_aT2k2hNxRuf1VImynTLI5-JN0fvwGeoE"
TAB_LEADS = "Leads"

# Kopfzeile steht in Zeile 2, Zeile 1 ist der verbundene Titelbalken.
HEADER_ROW = 2
FIRST_DATA_ROW = 3

# Reihenfolge der Spalten im Sheet (Spalte A .. AM), so wie sie heute ist.
# "" bedeutet: Spalte bleibt beim Export leer bzw. wird beim Import ignoriert.
SHEET_COLUMNS = [
    ("Nr.", "nr"),
    ("Firmenname", "firmenname"),
    ("Branche", "branche"),
    ("Ansprechpartner", "ansprechpartner"),
    ("Position", "position"),
    ("E-Mail", "email"),
    ("Telefon", "telefon"),
    ("Website", "website"),
    ("Straße & Hausnr.", "strasse"),
    ("Straße & Nr.", ""),          # Dublette im Sheet, bleibt leer
    ("PLZ", "plz"),
    ("Ort", "ort"),
    ("Land", "land"),
    ("Google Unternehmensprofil (Link)", "google_profil_link"),
    ("Google Maps Standort (Link)", "google_maps_link"),
    ("Google Bewertung (⌀)", "google_bewertung"),
    ("Anzahl Google-Bewertungen", "google_bewertungen"),
    ("Status", "status"),
    ("Kontaktiert am", "kontaktiert_am"),
    ("Kontaktkanal", "kontaktkanal"),
    ("Letzter Kontakt am", "letzter_kontakt_am"),
    ("Anzahl Kontakte", "anzahl_kontakte"),
    ("Wiedervorlage am", "wiedervorlage_am"),
    ("Fällig in (Tagen)", "faellig_in_tagen"),
    ("Angebot gesendet am", "angebot_gesendet_am"),
    ("Angebotswert (€)", "angebotswert"),
    ("Abschluss-Wahrsch.", "abschluss_wahrsch"),
    ("Gewichteter Wert (€)", "gewichteter_wert"),
    ("Google-Profil vorhanden", "google_profil_vorhanden"),
    ("Zuletzt geprüft", "zuletzt_geprueft"),
    ("Lead-Quelle", "lead_quelle"),
    ("Place-ID", "place_id"),
    ("Bewertungslink", "bewertungslink"),
    ("Kurzlink", "kurzlink"),
    ("Link-Herkunft", "link_herkunft"),
    ("Linktest", "linktest"),
    ("Getestet am", "getestet_am"),
    ("Eintrag erstellt am", "erstellt_am"),
    ("Notizen / nächster Schritt", "notizen"),
]

# Beim Export zusätzlich hinten angehängt - das, was im Sheet bisher fehlt.
EXTRA_COLUMNS = [
    ("Bearbeiter", "bearbeiter_name"),
    ("Zuletzt geändert am", "geaendert_am"),
    ("Produktinteresse", "produktinteresse"),
]

DATE_FIELDS = {
    "kontaktiert_am", "letzter_kontakt_am", "wiedervorlage_am",
    "angebot_gesendet_am", "zuletzt_geprueft", "getestet_am",
}
NUMBER_FIELDS = {
    "google_bewertung", "google_bewertungen", "anzahl_kontakte",
    "angebotswert", "abschluss_wahrsch", "gewichteter_wert", "faellig_in_tagen",
}
BOOL_FIELDS = {"google_profil_vorhanden"}


def export_header():
    return [name for name, _ in SHEET_COLUMNS] + [name for name, _ in EXTRA_COLUMNS]


def export_fields():
    return [field for _, field in SHEET_COLUMNS] + [f for _, f in EXTRA_COLUMNS]
