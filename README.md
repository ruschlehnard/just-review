# just-review Lead-Dashboard

Gemeinsames Lead-Dashboard für das Team. Alle sehen dieselben Leads, Änderungen
erscheinen bei allen sofort, und jede Nacht wird euer Google Sheet daraus neu
geschrieben.

Kein eigener Server, keine laufenden Kosten, kein Claude im Betrieb.

```
Browser (statische Seite)  ──►  Supabase (PostgreSQL)  ──►  Google Sheet
  GitHub Pages                   Daten + Anmeldung           nächtlicher Spiegel
                                 + Echtzeit                  via GitHub Action
```

**Einbahnstraße:** Supabase ist die Wahrheit, das Sheet ist der Spiegel.
Wer im Sheet von Hand etwas ändert, verliert es beim nächsten nächtlichen Lauf.
Das muss im Team bekannt sein. Vor jedem Export legt das Skript eine datierte
Sicherungskopie des Tabs an, die letzten sieben bleiben erhalten.

---

## Was drin ist

| Ordner | Inhalt |
|---|---|
| `supabase/schema.sql` | Tabellen, Rechte, Änderungsprotokoll, Echtzeit |
| `web/` | Die Oberfläche: drei Dateien, sonst nichts |
| `scripts/` | Import aus dem Sheet, Export zurück, Import der Cannstatt-Leads |
| `.github/workflows/` | Nächtlicher Export |

---

## Einrichtung

Rechne mit rund einer Stunde. Die Reihenfolge ist wichtig.

### 1 · Supabase-Projekt anlegen

1. Auf [supabase.com](https://supabase.com) mit GitHub anmelden, **New Project**.
2. Region **Frankfurt (eu-central-1)** wählen — die Daten bleiben in der EU.
3. Das Datenbank-Passwort notieren. Du brauchst es selten, aber es gibt keinen
   zweiten Weg daran.
4. Warten, bis das Projekt bereitsteht (ein bis zwei Minuten).

### 2 · Schema einspielen

1. Im Supabase-Projekt links auf **SQL Editor** → **New query**.
2. Den gesamten Inhalt von `supabase/schema.sql` einfügen und **Run** drücken.
3. Es sollte „Success. No rows returned" erscheinen.

Unter **Table Editor** stehen jetzt `profiles`, `einladungen`, `listen`,
`leads` und `aktivitaet`.

### 3 · Google-Anmeldung einschalten

1. In der [Google Cloud Console](https://console.cloud.google.com) ein Projekt
   anlegen → **APIs & Services** → **Credentials** → **Create Credentials** →
   **OAuth client ID** → **Web application**.
2. Bei **Authorized redirect URIs** eintragen:
   `https://DEIN-PROJEKT.supabase.co/auth/v1/callback`
   Die genaue Adresse steht in Supabase unter **Authentication → Providers →
   Google**.
3. Client-ID und Client-Secret dort in Supabase eintragen und Google
   aktivieren.
4. Unter **Authentication → URL Configuration** die **Site URL** auf die
   spätere GitHub-Pages-Adresse setzen, z. B.
   `https://deinname.github.io/just-review-dashboard/` — und dieselbe Adresse
   zusätzlich unter **Redirect URLs** eintragen.

### 4 · Euch selbst einladen

Ohne Eintrag in `einladungen` kommt niemand hinein — auch du nicht. Im SQL
Editor ausführen und die Adressen ersetzen:

```sql
insert into public.einladungen (email, name, rolle) values
  ('leon@beispiel.de',    'Leon',    'admin'),
  ('kollege1@beispiel.de','Kollege 1','mitarbeiter'),
  ('kollege2@beispiel.de','Kollege 2','mitarbeiter');
```

Die E-Mail muss exakt die des Google-Kontos sein, mit dem sich die Person
anmeldet. Das Profil entsteht beim ersten Login automatisch.

Später jemanden hinzufügen: dieselbe Zeile mit neuer Adresse. Jemandem den
Zugang entziehen: `update public.profiles set aktiv = false where email = '…';`

### 5 · Oberfläche veröffentlichen

1. Dieses Verzeichnis als Repository zu GitHub hochladen.
2. `web/config.example.js` zu `web/config.js` kopieren und die beiden Werte aus
   Supabase unter **Settings → API** eintragen: **Project URL** und den
   **anon public** Schlüssel.
   Niemals den `service_role`-Schlüssel — der umgeht alle Rechte.
3. Im Repository **Settings → Pages** → Source **Deploy from a branch**,
   Branch `main`, Ordner `/web`.
4. Nach ein bis zwei Minuten ist die Seite unter
   `https://deinname.github.io/just-review-dashboard/` erreichbar.

`config.js` steht in `.gitignore`. Für GitHub Pages musst du sie trotzdem
mithochladen — beide Werte dürfen öffentlich sein, die Rechte liegen in den
RLS-Regeln der Datenbank. Nimm dafür `git add -f web/config.js`.

### 6 · Dienstaccount für den Sheet-Export

1. In der Google Cloud Console → **IAM & Admin** → **Service Accounts** →
   **Create Service Account**. Name z. B. `just-review-export`.
2. Danach **Keys** → **Add Key** → **Create new key** → **JSON**. Die Datei
   wird einmalig heruntergeladen; es gibt keinen zweiten Download.
3. Unter **APIs & Services → Library** die **Google Sheets API** aktivieren.
4. Euer Google Sheet öffnen → **Freigeben** → die E-Mail des Dienstaccounts
   (steht in der JSON unter `client_email`) als **Bearbeiter** hinzufügen.

### 7 · Daten importieren

Lokal, einmalig:

```bash
cd scripts
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export SUPABASE_URL="https://DEIN-PROJEKT.supabase.co"
export SUPABASE_SERVICE_KEY="…"          # Settings → API → service_role
export GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ~/Downloads/dienstaccount.json)"

python import_from_sheet.py              # Probelauf, schreibt nichts
python import_from_sheet.py --schreiben
```

Der Probelauf zeigt, wie viele Zeilen gefunden wurden, welche Dubletten es
gibt und wie der erste Datensatz aussieht. **Schau ihn dir an, bevor du
schreibst.** Weicht die Kopfzeile von `scripts/sheet_schema.py` ab, warnt das
Skript — dann erst dort die Spalten anpassen.

Die 513 recherchierten Leads aus Bad Cannstatt und Münster dazu:

```bash
python import_cannstatt.py                           # Probelauf
python import_cannstatt.py --schreiben --bearbeiter DEINE-PROFIL-UUID
```

Deine UUID findest du nach dem ersten Login in Supabase unter
**Table Editor → profiles**.

### 8 · Nächtlichen Export einrichten

Im Repository unter **Settings → Secrets and variables → Actions** drei
Secrets anlegen:

| Name | Wert |
|---|---|
| `SUPABASE_URL` | die Project URL |
| `SUPABASE_SERVICE_KEY` | der `service_role`-Schlüssel |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | der **komplette Inhalt** der JSON-Datei |

Dann unter **Actions** → **Export nach Google Sheets** → **Run workflow** den
ersten Lauf von Hand starten und das Ergebnis im Sheet prüfen. Ab dann läuft er
täglich um 03:00 UTC.

---

## Bedienung

**Kacheln** filtern mit einem Klick: meine Leads, nie kontaktiert,
Wiedervorlage fällig, ohne Website, gewonnen.

**Zeile anklicken** öffnet die Bearbeitung. Jedes Feld speichert beim
Verlassen, Auswahlfelder sofort. Unten steht der Verlauf: wer wann was geändert
hat.

**Schnellaktionen** oben in der Schublade:

| Knopf | Was passiert |
|---|---|
| Angerufen | Letzter Kontakt auf heute, Zähler +1, Status auf „Kontaktiert", Lead dir zugewiesen falls noch frei |
| Erreicht, Follow-up | Status „Follow-up", Wiedervorlage in 7 Tagen |
| Mir zuweisen | setzt dich als Bearbeiter |
| Wiedervorlage +7 Tage | schiebt den Termin |

Oben rechts zeigt **live** an, ob die Echtzeitverbindung steht. Steht dort
„nicht verbunden", lade die Seite neu — deine Änderungen gehen trotzdem durch,
du siehst nur die der anderen nicht sofort.

---

## Was euch das kostet

Alles im Gratisrahmen: Supabase (500 MB Datenbank, 50.000 aktive Nutzer im
Monat), GitHub Pages, GitHub Actions. Bei 5 Leuten und einigen tausend Leads
ist davon nichts in Sichtweite.

Supabase pausiert Projekte, die eine Woche lang gar nicht genutzt werden. Der
nächtliche Export zählt als Nutzung, insofern passiert das bei euch nicht.

---

## Was ihr ändern wollen werdet

**Neue Dropdown-Werte** — neue Branche, neuer Status:

```sql
insert into public.listen (kategorie, wert, sortierung)
values ('branche', 'Apotheke', 20);
```

**Spalten im Sheet umsortiert** — nur `scripts/sheet_schema.py` anpassen,
Import und Export lesen beide daraus.

**Andere Export-Uhrzeit** — den `cron`-Ausdruck in
`.github/workflows/export.yml` ändern. Die Zeit ist UTC.

---

## Wenn etwas klemmt

**„Für … ist kein Zugang freigeschaltet"** — die E-Mail steht nicht in
`einladungen`, oder sie ist anders geschrieben als beim Google-Konto.

**Anmeldung springt zurück zur Startseite** — die Adresse unter
**Authentication → URL Configuration** stimmt nicht mit der tatsächlichen
überein. Sie muss exakt passen, Schrägstrich am Ende eingeschlossen.

**Tabelle bleibt leer, obwohl Leads da sind** — meist RLS: Es gibt ein
`auth.users`-Konto, aber kein `profiles`-Zeile. In Supabase unter
**Table Editor → profiles** nachsehen.

**Export schreibt nichts** — im Actions-Reiter das Protokoll öffnen. Häufigste
Ursache: Der Dienstaccount wurde dem Sheet nicht als **Bearbeiter**
freigegeben, nur als Betrachter.

**Export hat etwas kaputt gemacht** — im Sheet gibt es versteckte Tabs
`Sicherung JJJJ-MM-TT`. Rechtsklick auf den Tab → **Einblenden**, dann den
Inhalt zurückkopieren.

---

## Wichtig zu wissen

- **Das Sheet ist ab sofort ein Spiegel.** Änderungen dort werden nachts
  überschrieben. Gearbeitet wird im Dashboard.
- **Der `service_role`-Schlüssel gehört nur in GitHub-Secrets und auf deinen
  Rechner.** Nie in `config.js`, nie ins Repository, nie in einen Chat.
- **Gelöscht wird nur vom Admin.** Mitarbeiter können alles ändern, aber nichts
  entfernen — bei gemeinsamen Daten die sicherere Voreinstellung.
- **Das Protokoll in `aktivitaet` wächst.** Bei sehr vielen Änderungen irgendwann
  alte Einträge löschen:
  `delete from public.aktivitaet where zeit < now() - interval '1 year';`
