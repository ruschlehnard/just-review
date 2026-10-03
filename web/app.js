/* just-review Lead-Dashboard
   Statische Seite, redet direkt mit Supabase. Kein eigener Server.

   Drei Ansichten über denselben Datenbestand:
     Liste    Tabelle mit Filtern, auf dem Handy als Kartenliste
     Straße   nach Straße gruppiert, Hausnummern der Reihe nach - Außendienst
     Heute    überfällige Wiedervorlagen und die nächsten offenen Leads
*/

"use strict";

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

if (!window.CONFIG || window.CONFIG.SUPABASE_URL.includes("DEIN-PROJEKT")) {
  document.body.innerHTML =
    '<div class="gate"><div class="gate-card"><h1>Einrichtung fehlt</h1>' +
    "<p>Kopiere <code>config.example.js</code> zu <code>config.js</code> " +
    "und trag die Werte aus Supabase ein.</p></div></div>";
  throw new Error("config.js fehlt oder ist nicht ausgefüllt");
}

const sb = window.supabase.createClient(
  window.CONFIG.SUPABASE_URL,
  window.CONFIG.SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

const STATUS = [
  "Neu", "Recherchiert", "Kontaktiert", "Follow-up", "Termin vereinbart",
  "Angebot gesendet", "Verhandlung", "Gewonnen", "Verloren / kein Interesse",
  "Nicht relevant",
];

// Status, die als abgeschlossen gelten - sie zählen nicht mehr als offen.
const ERLEDIGT = new Set(["Gewonnen", "Verloren / kein Interesse", "Nicht relevant"]);

const state = {
  profil: null,
  leads: [],
  team: [],
  listen: {},
  offen: null,
  bereich: "leads",     // leads | mein
  // Ansicht innerhalb von "leads". "strasse" und "heute" sind gebaut, aber
  // derzeit nicht verlinkt - siehe #streets im HTML.
  view: "liste",
  q: "", ort: "", bearbeiter: "", branche: "",
  status: new Set(),
  kachel: "",
  sort: { k: "firmenname", dir: 1 },
  auswahl: new Set(),
};

/* Letzte Änderung je Lead, damit sie zurückgenommen werden kann:
   lead-id -> { label, vorher: {feld: Wert davor} }
   Nur im Speicher. Was dauerhaft nachvollziehbar sein muss, steht im Verlauf. */
const rueckgaengig = new Map();

/* ------------------------------------------------------------- Werkzeuge */

let toastTimer;
function toast(msg) {
  let t = el("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4000);
}

const heute = () => new Date().toISOString().slice(0, 10);

function datumDe(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("de-DE");
}

function zeitDe(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE",
    { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function tageBis(iso) {
  if (!iso) return null;
  const ms = new Date(iso + "T00:00:00") - new Date(heute() + "T00:00:00");
  return Math.round(ms / 86400000);
}

function inTagen(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const initialen = (name) =>
  (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();

/** "Alemannenstraße 7" -> {strasse: "Alemannenstraße", nr: "7", sort: 7} */
function adresseTeilen(roh) {
  const text = (roh || "").trim();
  const m = text.match(/^(.*?)[\s,]+(\d+\s*[-/]?\s*\w*)$/);
  if (!m) return { strasse: text || "Ohne Straße", nr: "", sort: 0 };
  return { strasse: m[1].trim(), nr: m[2].trim(), sort: parseInt(m[2], 10) || 0 };
}

/* ------------------------------------------------------------- Anmeldung */

async function anmelden() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href.split("#")[0] },
  });
  if (error) {
    el("gate-note").textContent = "Anmeldung fehlgeschlagen: " + error.message;
    el("gate-note").className = "note err";
  }
}

/** Fehler, die Google oder Supabase als Parameter zurückschicken, sichtbar
 *  machen - sonst landet man wortlos wieder auf der Anmeldemaske. */
function urlFehler() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const lies = (k) => q.get(k) || h.get(k);
  const code = lies("error") || lies("error_code");
  if (!code) return null;
  const text = (lies("error_description") || "").replace(/\+/g, " ");
  return text ? `${code} — ${decodeURIComponent(text)}` : code;
}

async function start() {
  const fehler = urlFehler();
  if (fehler) {
    console.error("Anmeldung fehlgeschlagen:", fehler);
    history.replaceState(null, "", location.pathname);
    return zeigeGate("Anmeldung fehlgeschlagen: " + fehler);
  }

  const { data: { session }, error: sitzungsfehler } = await sb.auth.getSession();
  if (sitzungsfehler) {
    console.error("getSession:", sitzungsfehler);
    return zeigeGate("Sitzung konnte nicht gelesen werden: " + sitzungsfehler.message);
  }
  if (!session) {
    if (new URLSearchParams(location.search).has("code")) {
      history.replaceState(null, "", location.pathname);
      return zeigeGate(
        "Google hat zurückgeleitet, aber Supabase konnte daraus keine Sitzung " +
        "erzeugen. Prüf den Client-Schlüssel und die Redirect-URLs. " +
        "Details stehen in der Browser-Konsole und in den Auth Logs von Supabase."
      );
    }
    return zeigeGate();
  }

  const { data: profil, error } = await sb
    .from("profiles").select("*").eq("id", session.user.id).maybeSingle();

  if (error) return zeigeGate(`Profil konnte nicht geladen werden: ${error.message}`);
  if (!profil) {
    return zeigeGate(
      `Für ${session.user.email} ist kein Zugang freigeschaltet. ` +
      "Bitte Leon melden, damit er dich in der Tabelle 'einladungen' einträgt."
    );
  }

  state.profil = profil;
  el("gate").hidden = true;
  el("app").hidden = false;
  el("username").textContent = profil.name || profil.email;
  el("avatar").textContent = initialen(profil.name || profil.email);

  await Promise.all([ladeTeam(), ladeListen(), ladeWatchlist()]);
  await ladeLeads();
  abonniere();
}

function zeigeGate(nachricht) {
  el("app").hidden = true;
  el("gate").hidden = false;
  if (nachricht) {
    el("gate-note").textContent = nachricht;
    el("gate-note").className = "note err";
    el("login").textContent = "Mit anderem Konto anmelden";
  }
}

el("login").onclick = anmelden;
el("logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

/* ----------------------------------------------------------------- Laden */

async function ladeTeam() {
  const { data } = await sb.from("profiles").select("id,name,email").order("name");
  state.team = data || [];
}

async function ladeListen() {
  const { data } = await sb.from("listen").select("kategorie,wert").order("sortierung");
  state.listen = {};
  (data || []).forEach(({ kategorie, wert }) => { (state.listen[kategorie] ||= []).push(wert); });
  if (!state.listen.status) state.listen.status = STATUS;
}

async function ladeLeads() {
  const alle = [];
  const schritt = 1000;
  for (let von = 0; ; von += schritt) {
    const { data, error } = await sb
      .from("leads_ansicht").select("*").order("nr").range(von, von + schritt - 1);
    if (error) { toast("Leads konnten nicht geladen werden: " + error.message); break; }
    alle.push(...data);
    if (data.length < schritt) break;
  }
  state.leads = alle;
  zeichneFilter();
  zeichne();
}

/* -------------------------------------------------------------- Echtzeit */

function abonniere() {
  sb.channel("leads-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, ({ eventType, new: neu, old: alt }) => {
      if (eventType === "DELETE") {
        state.leads = state.leads.filter((l) => l.id !== alt.id);
        state.auswahl.delete(alt.id);
      } else {
        const i = state.leads.findIndex((l) => l.id === neu.id);
        // Realtime liefert die Tabelle, nicht die Sicht - Abgeleitetes ergänzen.
        const voll = {
          ...neu,
          bearbeiter_name: state.team.find((t) => t.id === neu.bearbeiter)?.name || "",
          faellig_in_tagen: tageBis(neu.wiedervorlage_am),
        };
        if (i >= 0) state.leads[i] = voll; else state.leads.push(voll);

        if (state.offen?.id === neu.id && document.activeElement?.form?.id !== "d-form") {
          state.offen = voll;
          zeichneSchublade();
        }
      }
      if (state.bereich === "mein") zeichneMein(); else zeichne();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "termine" }, () => {
      // Termine aendern sich selten - einfach neu laden statt einzeln pflegen.
      if (state.bereich === "mein") ladeTermine().then(zeichneMein);
    })
    .subscribe((status) => {
      const an = status === "SUBSCRIBED";
      el("live").dataset.on = String(an);
      el("live").textContent = an ? "live" : "nicht verbunden";
    });
}

/* --------------------------------------------------------------- Kacheln */

const KACHELN = [
  { id: "", cls: "", lbl: "Leads gesamt", f: () => true },
  { id: "meine", cls: "t-acc", lbl: "Meine Leads", f: (l) => l.bearbeiter === state.profil.id },
  { id: "frei", cls: "t-grey", lbl: "Nicht zugewiesen", f: (l) => !l.bearbeiter },
  { id: "offen", cls: "", lbl: "Nie kontaktiert", f: (l) => !l.letzter_kontakt_am && !ERLEDIGT.has(l.status) },
  { id: "faellig", cls: "t-warn", lbl: "Wiedervorlage fällig", f: (l) => {
      const t = tageBis(l.wiedervorlage_am); return t !== null && t <= 0 && !ERLEDIGT.has(l.status); } },
  { id: "noweb", cls: "t-hot", lbl: "Ohne Website", f: (l) => !l.website },
  { id: "gewonnen", cls: "t-good", lbl: "Gewonnen", f: (l) => l.status === "Gewonnen" },
];

function zeichneKacheln() {
  el("tiles").innerHTML = KACHELN.map((k) => `
    <button class="tile ${k.cls}" data-k="${k.id}" aria-pressed="${state.kachel === k.id}">
      <span class="num">${state.leads.filter(k.f).length}</span>
      <span class="lbl">${esc(k.lbl)}</span>
    </button>`).join("");
  el("tiles").querySelectorAll(".tile").forEach((b) => {
    b.onclick = () => { state.kachel = state.kachel === b.dataset.k ? "" : b.dataset.k; zeichne(); };
  });
}

function zeichneFilter() {
  const fuellen = (id, werte, aktuell) => {
    const s = el(id);
    const erste = s.options[0].outerHTML;
    s.innerHTML = erste + werte.map((w) =>
      `<option value="${esc(w.v)}"${w.v === aktuell ? " selected" : ""}>${esc(w.t)}</option>`).join("");
  };

  const orte = [...new Set(state.leads.map((l) => l.ort).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  fuellen("f-ort", orte.map((o) => ({ v: o, t: `${o} (${state.leads.filter((l) => l.ort === o).length})` })), state.ort);

  const leute = [{ v: "__keiner", t: "– nicht zugeordnet –" },
    ...state.team.map((t) => ({ v: t.id, t: t.name || t.email }))];
  fuellen("f-bearbeiter", leute, state.bearbeiter);

  const branchen = [...new Set(state.leads.map((l) => l.branche).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  fuellen("f-branche", branchen.map((b) => ({ v: b, t: b })), state.branche);

  // Sammelaktionen teilen sich die Listen
  el("bulk-bearbeiter").innerHTML =
    '<option value="">Bearbeiter zuweisen …</option><option value="__keiner">– niemandem –</option>' +
    state.team.map((t) => `<option value="${esc(t.id)}">${esc(t.name || t.email)}</option>`).join("");
  el("bulk-status").innerHTML =
    '<option value="">Status setzen …</option>' +
    (state.listen.status || STATUS).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

  el("status-chips").innerHTML = (state.listen.status || STATUS).map((s) => `
    <button class="chip" data-s="${esc(s)}" aria-pressed="${state.status.has(s)}">
      ${esc(s)}<span class="c">${state.leads.filter((l) => l.status === s).length}</span>
    </button>`).join("");
  el("status-chips").querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => {
      const s = b.dataset.s;
      state.status.has(s) ? state.status.delete(s) : state.status.add(s);
      zeichne();
    };
  });
}

/* ----------------------------------------------------------------- Filter */

function sichtbar() {
  const kachel = KACHELN.find((k) => k.id === state.kachel);
  const q = state.q.toLowerCase().trim();

  let out = state.leads.filter((l) => {
    if (kachel && kachel.id && !kachel.f(l)) return false;
    if (state.ort && l.ort !== state.ort) return false;
    if (state.branche && l.branche !== state.branche) return false;
    if (state.status.size && !state.status.has(l.status)) return false;
    if (state.bearbeiter === "__keiner" && l.bearbeiter) return false;
    if (state.bearbeiter && state.bearbeiter !== "__keiner" && l.bearbeiter !== state.bearbeiter) return false;
    if (q) {
      const heu = `${l.firmenname} ${l.branche} ${l.strasse} ${l.ort} ${l.ansprechpartner} ${l.telefon}`;
      if (!heu.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  if (state.view === "heute") {
    // Überfällige Wiedervorlagen zuerst, dann meine offenen, dann der Rest.
    out = out.filter((l) => {
      if (ERLEDIGT.has(l.status)) return false;
      const t = tageBis(l.wiedervorlage_am);
      if (t !== null && t <= 0) return true;
      return l.bearbeiter === state.profil.id && !l.letzter_kontakt_am;
    });
    return out.sort((a, b) => {
      const ta = tageBis(a.wiedervorlage_am), tb = tageBis(b.wiedervorlage_am);
      if (ta !== null && tb === null) return -1;
      if (ta === null && tb !== null) return 1;
      if (ta !== null && tb !== null && ta !== tb) return ta - tb;
      return (a.strasse || "").localeCompare(b.strasse || "", "de", { numeric: true });
    });
  }

  const { k, dir } = state.sort;
  out.sort((a, b) => {
    // Priorisierte stehen immer oben, erst danach greift die Spaltensortierung.
    // Ausser man sortiert ausdruecklich nach der Prio-Spalte selbst.
    if (k !== "prioritaet") {
      const pa = a.prioritaet || 9, pb = b.prioritaet || 9;
      if (pa !== pb) return pa - pb;
    }
    const av = a[k] ?? "", bv = b[k] ?? "";
    if (!av && bv) return 1;
    if (av && !bv) return -1;
    return String(av).localeCompare(String(bv), "de", { numeric: true }) * dir;
  });
  return out;
}

/* ------------------------------------------------------- Zeichnen gesamt */

function zeichne() {
  zeichneKacheln();
  const rows = sichtbar();

  const gefiltert = state.q || state.ort || state.bearbeiter || state.branche
    || state.status.size || state.kachel;
  el("filter-reset").hidden = !gefiltert;

  el("tablewrap").hidden = state.view === "strasse";
  el("streets").hidden = state.view !== "strasse";

  if (state.view === "strasse") zeichneStrassen(rows);
  else zeichneTabelle(rows);

  el("count").textContent = state.view === "heute"
    ? `${rows.length} heute dran — überfällige Wiedervorlagen und deine offenen Leads`
    : `${rows.length} von ${state.leads.length} Leads angezeigt`;

  zeichneBulk();
  if (el("stats").hidden === false) zeichneStats();
}

function zeilenKlasse(l) {
  const t = tageBis(l.wiedervorlage_am);
  return [
    !l.website ? "no-web" : "",
    t !== null && t <= 0 && !ERLEDIGT.has(l.status) ? "faellig" : "",
    ERLEDIGT.has(l.status) ? "inaktiv" : "",
    state.auswahl.has(l.id) ? "gewaehlt" : "",
  ].filter(Boolean).join(" ");
}

/* Nur Auffälliges markieren. "Keine Website" und "keine Nummer" sind bei
   diesem Bestand der Normalfall (62 % bzw. 86 %) - als Marke wären sie
   Rauschen. Die fehlende Website zeigt der rote Streifen links, die Nummer
   sieht man in der Kontaktspalte. */
function marken(l) {
  const t = tageBis(l.wiedervorlage_am);
  return [
    l.bearbeiter === state.profil.id ? '<span class="tag mine">meiner</span>' : "",
    state.watch.has(l.id) ? '<span class="tag watch">Watchlist</span>' : "",
    t !== null && t <= 0 && !ERLEDIGT.has(l.status)
      ? `<span class="tag due">${t === 0 ? "heute fällig" : `${-t} T überfällig`}</span>` : "",
  ].filter(Boolean).join("");
}

/* ------------------------------------------------- Priorität und Google */

const PRIO_NAME = { 1: "hoch", 2: "mittel", 3: "niedrig" };

/** Google-Suche aus Name und Adresse - dieselbe Zusammensetzung wie Spalte N
 *  im Google Sheet. Funktioniert auch bei Leads ganz ohne Kontaktdaten. */
function googleSuche(l) {
  const begriff = [l.firmenname, l.strasse, l.plz, l.ort].filter(Boolean).join(" ");
  return "https://www.google.com/search?q=" + encodeURIComponent(begriff);
}

function prioZelle(l) {
  const p = l.prioritaet || 0;
  const titel = p ? `Priorität ${PRIO_NAME[p]} — klicken zum Wechseln` : "Keine Priorität — klicken zum Setzen";
  return `<button class="prio-btn" data-p="${p}" title="${esc(titel)}"
    aria-label="${esc(titel)}"><i></i><i></i><i></i></button>`;
}

function kontaktZellen(l) {
  return `
    ${l.telefon ? `<a class="tel" href="tel:${esc(l.telefon)}" onclick="event.stopPropagation()">${esc(l.telefon)}</a>`
      : '<span class="dot">T</span>'}
    ${l.email ? `<a class="dot on" href="mailto:${esc(l.email)}" title="${esc(l.email)}" onclick="event.stopPropagation()">@</a>` : ""}
    ${l.website ? `<a class="dot on" href="${esc(l.website)}" target="_blank" rel="noopener noreferrer" title="${esc(l.website)}" onclick="event.stopPropagation()">W</a>` : ""}
    <a class="dot on google" href="${esc(googleSuche(l))}" target="_blank" rel="noopener noreferrer"
       title="Bei Google suchen" onclick="event.stopPropagation()">G</a>
    ${l.google_profil_link ? `<a class="dot on" href="${esc(l.google_profil_link)}" target="_blank" rel="noopener noreferrer" title="Hinterlegtes Google-Profil" onclick="event.stopPropagation()">P</a>` : ""}`;
}

/* --------------------------------------------------------- Ansicht Liste */

function zeichneTabelle(rows) {
  el("empty").hidden = rows.length > 0;
  el("empty").textContent = state.view === "heute"
    ? "Nichts fällig und nichts Offenes zugewiesen. Schöner Tag."
    : "Kein Treffer. Filter zurücksetzen.";

  el("tb").innerHTML = rows.map((l) => `
    <tr data-id="${l.id}" class="${zeilenKlasse(l)}" aria-selected="${state.offen?.id === l.id}">
      <td class="pick"><input type="checkbox" ${state.auswahl.has(l.id) ? "checked" : ""}
          aria-label="${esc(l.firmenname || "Lead")} auswählen"></td>
      <td class="prio" data-label="Prio">${prioZelle(l)}</td>
      <td class="stripe"><i></i></td>
      <td class="klick zelle-name">
        <span class="nm">${esc(l.firmenname) || '<span class="sub">ohne Firmenname</span>'}</span>
        ${marken(l) ? `<div class="tags">${marken(l)}</div>` : ""}
        <div class="sub">${esc(l.branche)}${l.strasse ? " · " + esc(l.strasse) : ""}</div>
      </td>
      <td class="klick" data-label="Ort">${esc(l.ort)}<div class="sub mono">${esc(l.plz)}</div></td>
      <td class="klick" data-label="Status"><span class="status" data-s="${esc(l.status)}">${esc(l.status)}</span></td>
      <td class="klick" data-label="Bearbeiter">${esc(l.bearbeiter_name) || '<span class="sub">—</span>'}</td>
      <td class="notiz-zelle" data-label="Notiz"><div class="notiz" tabindex="0"
          title="Klicken zum Bearbeiten">${esc(l.notizen) || '<span class="sub">—</span>'}</div></td>
      <td class="klick mono" data-label="Wiedervorlage">${datumDe(l.wiedervorlage_am) || '<span class="sub">—</span>'}</td>
      <td class="zelle-kontakt">${kontaktZellen(l)}</td>
    </tr>`).join("");

  el("tb").querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelectorAll("td.klick").forEach((td) => { td.onclick = () => oeffne(id); });
    tr.querySelector("td.pick input").onchange = (e) => waehle(id, e.target.checked);
    tr.querySelector(".prio-btn").onclick = (e) => { e.stopPropagation(); prioWeiter(id); };
    const notiz = tr.querySelector(".notiz");
    notiz.onclick = (e) => { e.stopPropagation(); notizBearbeiten(notiz, id); };
    notiz.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); notizBearbeiten(notiz, id); }
    };
  });

  const alleGewaehlt = rows.length > 0 && rows.every((l) => state.auswahl.has(l.id));
  el("pick-all").checked = alleGewaehlt;
  el("pick-all").indeterminate = !alleGewaehlt && rows.some((l) => state.auswahl.has(l.id));
}

/* ------------------------------------------ Bearbeiten direkt in der Zeile */

/** Schreibt eine Änderung an einen beliebigen Lead, auch ohne offene
 *  Schublade. Gibt den aktualisierten Datensatz zurück oder null. */
async function speichereLead(id, aenderung) {
  const { data, error } = await sb.from("leads")
    .update({ ...aenderung, geaendert_von: state.profil.id })
    .eq("id", id).select().single();

  if (error) { toast("Nicht gespeichert: " + error.message); return null; }

  const i = state.leads.findIndex((l) => l.id === id);
  if (i >= 0) {
    Object.assign(state.leads[i], data, {
      bearbeiter_name: state.team.find((t) => t.id === data.bearbeiter)?.name || "",
      faellig_in_tagen: tageBis(data.wiedervorlage_am),
    });
  }
  return data;
}

/** keine -> hoch -> mittel -> niedrig -> keine */
async function prioWeiter(id) {
  const lead = state.leads.find((l) => l.id === id);
  if (!lead) return;
  const naechste = { 0: 1, 1: 2, 2: 3, 3: null }[lead.prioritaet || 0];
  merkeVorzustand(lead, { prioritaet: naechste }, "Priorität");
  if (await speichereLead(id, { prioritaet: naechste })) {
    toast(naechste ? `Priorität ${PRIO_NAME[naechste]}` : "Priorität entfernt");
    zeichne();
    if (state.offen?.id === id) zeichneSchublade();
  }
}

/** Notiz an Ort und Stelle bearbeiten: Klick macht ein Eingabefeld daraus.
 *  istWatch = true bearbeitet die persönliche Watchlist-Notiz statt der
 *  Notiz am Lead, die das ganze Team sieht. */
function notizBearbeiten(zelle, id, istWatch = false) {
  if (zelle.querySelector("input")) return;        // schon offen
  const lead = state.leads.find((l) => l.id === id);
  if (!lead) return;

  const alt = istWatch ? (state.watch.get(id)?.notiz || "") : (lead.notizen || "");
  const feld = document.createElement("input");
  feld.type = "text";
  feld.value = alt;
  feld.className = "notiz-feld";
  feld.setAttribute("aria-label", "Notiz bearbeiten");

  zelle.textContent = "";
  zelle.appendChild(feld);
  feld.focus();
  feld.select();

  let fertig = false;
  const beenden = async (speichern) => {
    if (fertig) return;
    fertig = true;
    const neu = feld.value.trim();
    if (speichern && neu !== alt) {
      if (istWatch) {
        await watchNotiz(id, neu);
      } else {
        merkeVorzustand(lead, { notizen: neu }, "Notiz");
        await speichereLead(id, { notizen: neu });
        if (state.offen?.id === id) zeichneSchublade();
      }
    }
    if (state.bereich === "mein") zeichneMein(); else zeichne();
  };

  feld.onblur = () => beenden(true);
  feld.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); beenden(true); }
    if (e.key === "Escape") { e.preventDefault(); beenden(false); }
  };
}

/* ------------------------------------------------------- Ansicht Straße */

function zeichneStrassen(rows) {
  if (!rows.length) {
    el("streets").innerHTML = '<div class="empty">Kein Treffer. Filter zurücksetzen.</div>';
    return;
  }

  const gruppen = new Map();
  for (const l of rows) {
    const a = adresseTeilen(l.strasse);
    const schluessel = `${l.ort} · ${a.strasse}`;
    if (!gruppen.has(schluessel)) gruppen.set(schluessel, []);
    gruppen.get(schluessel).push({ ...l, _nr: a.nr, _sort: a.sort });
  }

  const sortiert = [...gruppen.entries()].sort((a, b) => a[0].localeCompare(b[0], "de"));
  // Beim Blättern offene Gruppen merken, damit sie nicht zuklappen.
  const offeneGruppen = new Set(
    [...el("streets").querySelectorAll("details[open]")].map((d) => d.dataset.g)
  );

  el("streets").innerHTML = sortiert.map(([name, leads]) => {
    leads.sort((a, b) => a._sort - b._sort || a._nr.localeCompare(b._nr, "de"));
    const fertig = leads.filter((l) => l.letzter_kontakt_am || ERLEDIGT.has(l.status)).length;
    const auf = offeneGruppen.has(name) || sortiert.length <= 3;
    return `
      <details class="street" data-g="${esc(name)}"${auf ? " open" : ""}>
        <summary>
          <h3>${esc(name)}</h3>
          <span class="zahl">${fertig} / ${leads.length} bearbeitet</span>
        </summary>
        <div class="hausnummern">
          ${leads.map((l) => `
            <div class="haus ${state.auswahl.has(l.id) ? "gewaehlt" : ""} ${
              l.letzter_kontakt_am || ERLEDIGT.has(l.status) ? "erledigt" : ""}" data-id="${l.id}">
              <input type="checkbox" ${state.auswahl.has(l.id) ? "checked" : ""}
                aria-label="${esc(l.firmenname || "Lead")} auswählen" onclick="event.stopPropagation()">
              <span class="hnr">${esc(l._nr) || "–"}</span>
              <span class="wer">
                <span class="nm">${esc(l.firmenname) || "ohne Firmenname"}</span>
                <span class="sub">${esc(l.branche)}${l.bearbeiter_name ? " · " + esc(l.bearbeiter_name) : ""}</span>
              </span>
              <span class="kontakt-spalte">
                <span class="status" data-s="${esc(l.status)}">${esc(l.status)}</span>
              </span>
            </div>`).join("")}
        </div>
      </details>`;
  }).join("");

  el("streets").querySelectorAll(".haus").forEach((h) => {
    const id = h.dataset.id;
    h.onclick = () => oeffne(id);
    h.querySelector("input").onchange = (e) => waehle(id, e.target.checked);
  });
}

/* ------------------------------------------------------- Sammelaktionen */

function waehle(id, an) {
  an ? state.auswahl.add(id) : state.auswahl.delete(id);
  zeichne();
}

function zeichneBulk() {
  const n = state.auswahl.size;
  el("bulkbar").hidden = n === 0;
  el("bulk-count").textContent = `${n} ausgewählt`;
}

el("pick-all").onchange = (e) => {
  const rows = sichtbar();
  if (e.target.checked) rows.forEach((l) => state.auswahl.add(l.id));
  else rows.forEach((l) => state.auswahl.delete(l.id));
  zeichne();
};

el("bulk-clear").onclick = () => { state.auswahl.clear(); zeichne(); };

async function sammelAendern(aenderung, beschreibung) {
  const ids = [...state.auswahl];
  if (!ids.length) return;
  if (!confirm(`${beschreibung} für ${ids.length} Leads?`)) return;

  const block = 200;
  let fertig = 0;
  for (let i = 0; i < ids.length; i += block) {
    const teil = ids.slice(i, i + block);
    const { error } = await sb.from("leads")
      .update({ ...aenderung, geaendert_von: state.profil.id })
      .in("id", teil);
    if (error) { toast("Fehlgeschlagen: " + error.message); return; }
    fertig += teil.length;
    el("bulk-count").textContent = `${fertig} von ${ids.length} geändert …`;
  }

  // Lokal nachziehen, damit es sofort steht - Realtime liefert es ohnehin auch.
  state.leads.forEach((l) => {
    if (state.auswahl.has(l.id)) {
      Object.assign(l, aenderung);
      l.bearbeiter_name = state.team.find((t) => t.id === l.bearbeiter)?.name || "";
      l.faellig_in_tagen = tageBis(l.wiedervorlage_am);
    }
  });

  toast(`${beschreibung} für ${ids.length} Leads erledigt.`);
  state.auswahl.clear();
  zeichne();
}

el("bulk-bearbeiter").onchange = (e) => {
  const v = e.target.value;
  if (!v) return;
  const name = v === "__keiner" ? "niemandem" : state.team.find((t) => t.id === v)?.name;
  sammelAendern({ bearbeiter: v === "__keiner" ? null : v }, `Zuweisen an ${name}`);
  e.target.value = "";
};

el("bulk-status").onchange = (e) => {
  const v = e.target.value;
  if (!v) return;
  sammelAendern({ status: v }, `Status „${v}" setzen`);
  e.target.value = "";
};

el("bulk-mein").onclick = () =>
  sammelAendern({ bearbeiter: state.profil.id }, "In deinen Bereich übernehmen");

el("bulk-watch").onclick = async () => {
  const ids = [...state.auswahl];
  if (!ids.length) return;
  if (!confirm(`${ids.length} Leads auf die Watchlist setzen?`)) return;

  const zeilen = ids.map((lead_id) => ({ benutzer: state.profil.id, lead_id }));
  for (let i = 0; i < zeilen.length; i += 200) {
    const { error } = await sb.from("watchlist").upsert(zeilen.slice(i, i + 200));
    if (error) return toast("Fehlgeschlagen: " + error.message);
  }
  ids.forEach((id) => state.watch.set(id, state.watch.get(id) || { notiz: "" }));
  toast(`${ids.length} Leads auf der Watchlist.`);
  state.auswahl.clear();
  zeichne();
};

el("bulk-datum").onchange = (e) => {
  const v = e.target.value;
  if (!v) return;
  sammelAendern({ wiedervorlage_am: v }, `Wiedervorlage ${datumDe(v)} setzen`);
  e.target.value = "";
};

/* ------------------------------------------------------------ Fortschritt */

async function zeichneStats() {
  const seit = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: akt } = await sb.from("aktivitaet")
    .select("benutzer, lead_id").gte("zeit", seit).limit(5000);

  const wocheProPerson = new Map();
  (akt || []).forEach((a) => {
    if (!a.benutzer) return;
    if (!wocheProPerson.has(a.benutzer)) wocheProPerson.set(a.benutzer, new Set());
    wocheProPerson.get(a.benutzer).add(a.lead_id);
  });

  const karten = state.team.map((t) => {
    const meine = state.leads.filter((l) => l.bearbeiter === t.id);
    const bearbeitet = meine.filter((l) => l.status !== "Neu").length;
    const gewonnen = meine.filter((l) => l.status === "Gewonnen").length;
    const woche = wocheProPerson.get(t.id)?.size || 0;
    const anteil = meine.length ? Math.round((bearbeitet / meine.length) * 100) : 0;
    return `
      <div class="stat-person">
        <h3>${esc(t.name || t.email)}</h3>
        <div class="balken"><i style="width:${anteil}%"></i></div>
        <div class="stat-zeile"><span>zugewiesen</span><b>${meine.length}</b></div>
        <div class="stat-zeile"><span>angefasst</span><b>${bearbeitet}</b></div>
        <div class="stat-zeile"><span>letzte 7 Tage</span><b>${woche}</b></div>
        <div class="stat-zeile"><span>gewonnen</span><b>${gewonnen}</b></div>
      </div>`;
  });

  const frei = state.leads.filter((l) => !l.bearbeiter).length;
  karten.push(`
    <div class="stat-person">
      <h3>Nicht zugewiesen</h3>
      <div class="balken"><i style="width:0%"></i></div>
      <div class="stat-zeile"><span>offen</span><b>${frei}</b></div>
      <div class="stat-zeile"><span class="note">Über die Kachel auswählen und unten zuweisen.</span></div>
    </div>`);

  el("stats").innerHTML = karten.join("");
}

el("stats-toggle").onclick = () => {
  const auf = el("stats").hidden;
  el("stats").hidden = !auf;
  el("stats-toggle").setAttribute("aria-expanded", String(auf));
  if (auf) zeichneStats();
};

/* -------------------------------------------------------------- Steuerung */

el("q").oninput = (e) => { state.q = e.target.value; zeichne(); };
el("f-ort").onchange = (e) => { state.ort = e.target.value; zeichne(); };
el("f-bearbeiter").onchange = (e) => { state.bearbeiter = e.target.value; zeichne(); };
el("f-branche").onchange = (e) => { state.branche = e.target.value; zeichne(); };

el("filter-toggle").onclick = () => {
  const auf = el("filter-mehr").classList.toggle("auf");
  el("filter-toggle").setAttribute("aria-expanded", String(auf));
};

el("filter-reset").onclick = () => {
  Object.assign(state, { q: "", ort: "", bearbeiter: "", branche: "", kachel: "" });
  state.status.clear();
  el("q").value = ""; el("f-ort").value = ""; el("f-bearbeiter").value = ""; el("f-branche").value = "";
  zeichneFilter();
  zeichne();
};

/* ------------------------------------------------------------- Bereiche */

const TITEL = { leads: "Leads", mein: "Mein Bereich" };

function zeigeBereich(name) {
  state.bereich = name;
  el("b-leads").hidden = name !== "leads";
  el("b-mein").hidden = name !== "mein";
  el("bereich-titel").textContent = TITEL[name] || "Leads";
  document.querySelectorAll(".nav-btn").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.bereich === name)));
  seitenleisteZu();
  if (name === "leads") zeichne();
  if (name === "mein") {
    zeichneMein();                       // sofort mit dem, was schon da ist
    ladeTermine().then(zeichneMein);     // dann mit frischen Terminen
  }
}

document.querySelectorAll(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => zeigeBereich(b.dataset.bereich));
});

/* Seitenleiste auf dem Handy */

function seitenleisteAuf(an) {
  el("sidebar").classList.toggle("offen", an);
  el("sidebar-scrim").hidden = !an;
  el("burger").setAttribute("aria-expanded", String(an));
}

const seitenleisteZu = () => seitenleisteAuf(false);

el("burger").addEventListener("click", () =>
  seitenleisteAuf(!el("sidebar").classList.contains("offen")));
el("sidebar-scrim").addEventListener("click", seitenleisteZu);

document.querySelectorAll("th.sortable").forEach((th) => {
  th.onclick = () => {
    const k = th.dataset.k;
    state.sort = { k, dir: state.sort.k === k ? -state.sort.dir : 1 };
    document.querySelectorAll("th.sortable").forEach((o) => o.removeAttribute("data-dir"));
    th.dataset.dir = state.sort.dir > 0 ? "asc" : "desc";
    th.querySelector(".arrow").textContent = state.sort.dir > 0 ? "↓" : "↑";
    zeichne();
  };
});

/* -------------------------------------------------------------- Schublade */

const FELDER = [
  { legend: "Beim Gespräch", kern: true, felder: [
    { k: "status", t: "Status", typ: "liste", liste: "status" },
    { k: "prioritaet", t: "Priorität", typ: "prio" },
    { k: "bearbeiter", t: "Bearbeiter", typ: "team" },
    { k: "wiedervorlage_am", t: "Wiedervorlage am", typ: "datum" },
    { k: "kontaktkanal", t: "Kontaktkanal", typ: "liste", liste: "kontaktkanal" },
    { k: "notizen", t: "Notizen / nächster Schritt", typ: "mehrzeilig", voll: true },
  ]},
  { legend: "Kontaktverlauf", felder: [
    { k: "anzahl_kontakte", t: "Anzahl Kontakte", typ: "zahl" },
    { k: "kontaktiert_am", t: "Erstkontakt am", typ: "datum" },
    { k: "letzter_kontakt_am", t: "Letzter Kontakt am", typ: "datum" },
    { k: "produktinteresse", t: "Produktinteresse", typ: "liste", liste: "produktinteresse" },
  ]},
  { legend: "Angebot", felder: [
    { k: "angebot_gesendet_am", t: "Angebot gesendet am", typ: "datum" },
    { k: "angebotswert", t: "Angebotswert (€)", typ: "zahl", schritt: "0.01" },
    { k: "abschluss_wahrsch", t: "Abschluss-Wahrsch. (0–1)", typ: "zahl", schritt: "0.05", max: "1" },
  ]},
  { legend: "Firma und Kontakt", felder: [
    { k: "firmenname", t: "Firmenname", typ: "text", voll: true },
    { k: "branche", t: "Branche", typ: "liste", liste: "branche" },
    { k: "ansprechpartner", t: "Ansprechpartner", typ: "text" },
    { k: "position", t: "Position", typ: "text" },
    { k: "telefon", t: "Telefon", typ: "tel" },
    { k: "email", t: "E-Mail", typ: "email" },
    { k: "website", t: "Website", typ: "url", voll: true },
  ]},
  { legend: "Adresse", felder: [
    { k: "strasse", t: "Straße & Nr.", typ: "text", voll: true },
    { k: "plz", t: "PLZ", typ: "text" },
    { k: "ort", t: "Ort", typ: "text" },
  ]},
  { legend: "Google-Profil und NFC", felder: [
    { k: "google_profil_vorhanden", t: "Google-Profil vorhanden", typ: "janein" },
    { k: "zuletzt_geprueft", t: "Zuletzt geprüft", typ: "datum" },
    { k: "place_id", t: "Place-ID", typ: "text", voll: true },
    { k: "bewertungslink", t: "Bewertungslink", typ: "url", voll: true },
    { k: "kurzlink", t: "Kurzlink", typ: "text" },
    { k: "linktest", t: "Linktest", typ: "text" },
  ]},
];

function oeffne(id) {
  state.offen = state.leads.find((l) => l.id === id);
  if (!state.offen) return;
  el("scrim").hidden = false;
  el("drawer").hidden = false;
  zeichneSchublade();
  ladeVerlauf(id);
  zeichne();
}

function schliesse() {
  state.offen = null;
  el("scrim").hidden = true;
  el("drawer").hidden = true;
  el("d-saving").textContent = "";
  zeichne();
}

/** Im aktuell gefilterten Satz einen Schritt weiter oder zurück. */
function blaettern(richtung) {
  const rows = sichtbar();
  const i = rows.findIndex((l) => l.id === state.offen?.id);
  const ziel = rows[i + richtung];
  if (!ziel) return toast(richtung > 0 ? "Letzter Lead der Liste." : "Erster Lead der Liste.");
  oeffne(ziel.id);
  ladeVerlauf(ziel.id);
}

/** Endgültig löschen. Der Verlauf hängt per CASCADE daran und geht mit. */
async function leadLoeschen() {
  const lead = state.offen;
  if (!lead) return;
  const name = lead.firmenname || lead.ansprechpartner || "dieser Lead";
  if (!confirm(`„${name}“ endgültig löschen?\n\n`
    + "Der komplette Verlauf geht mit verloren und lässt sich nicht "
    + "wiederherstellen.")) return;

  const { error } = await sb.from("leads").delete().eq("id", lead.id);
  if (error) return toast("Nicht gelöscht: " + error.message);

  state.leads = state.leads.filter((l) => l.id !== lead.id);
  state.auswahl.delete(lead.id);
  rueckgaengig.delete(lead.id);
  schliesse();
  toast(`„${name}“ gelöscht.`);
}

el("d-delete").onclick = leadLoeschen;
el("d-close").onclick = schliesse;
el("scrim").onclick = schliesse;
el("d-prev").onclick = () => blaettern(-1);
el("d-next").onclick = () => blaettern(1);

document.addEventListener("keydown", (e) => {
  if (el("drawer").hidden) return;
  const tippt = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (e.key === "Escape") return schliesse();
  if (tippt) return;
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); blaettern(1); }
  if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); blaettern(-1); }
});

/** praefix trennt die IDs der Schublade von denen des Neu-Formulars -
 *  doppelte IDs im Dokument hängen sonst die Beschriftungen falsch an. */
function feldHtml(f, lead, praefix = "f") {
  const wert = lead[f.k];
  const id = `${praefix}-${f.k}`;
  const cls = f.voll ? ' class="full"' : "";
  let eingabe;

  if (f.typ === "liste" || f.typ === "team" || f.typ === "janein" || f.typ === "prio") {
    let opts;
    if (f.typ === "team") {
      opts = [{ v: "", t: "– nicht zugeordnet –" },
        ...state.team.map((t) => ({ v: t.id, t: t.name || t.email }))];
    } else if (f.typ === "janein") {
      opts = [{ v: "", t: "– offen –" }, { v: "true", t: "Ja" }, { v: "false", t: "Nein" }];
    } else if (f.typ === "prio") {
      opts = [{ v: "", t: "– keine –" },
        { v: "1", t: "1 – hoch" }, { v: "2", t: "2 – mittel" }, { v: "3", t: "3 – niedrig" }];
    } else {
      const werte = state.listen[f.liste] || [];
      const extra = wert && !werte.includes(wert) ? [wert] : [];
      opts = [{ v: "", t: "– leer –" }, ...[...extra, ...werte].map((w) => ({ v: w, t: w }))];
    }
    const aktuell = (f.typ === "janein" || f.typ === "prio")
      ? (wert === null || wert === undefined ? "" : String(wert))
      : (wert ?? "");
    eingabe = `<select id="${id}" name="${f.k}">${opts.map((o) =>
      `<option value="${esc(o.v)}"${String(o.v) === String(aktuell) ? " selected" : ""}>${esc(o.t)}</option>`
    ).join("")}</select>`;
  } else if (f.typ === "mehrzeilig") {
    eingabe = `<textarea id="${id}" name="${f.k}">${esc(wert ?? "")}</textarea>`;
  } else {
    const typ = { datum: "date", zahl: "number" }[f.typ] || f.typ;
    const extra = [
      f.schritt ? `step="${f.schritt}"` : "",
      f.max ? `max="${f.max}"` : "",
      f.typ === "zahl" ? 'min="0"' : "",
    ].filter(Boolean).join(" ");
    eingabe = `<input type="${typ}" id="${id}" name="${f.k}" value="${esc(wert ?? "")}" ${extra}>`;
  }

  return `<label${cls} for="${id}">${esc(f.t)}${eingabe}</label>`;
}

function gruppeHtml(g, lead) {
  const inhalt = `<div class="grid2">${g.felder.map((f) => feldHtml(f, lead)).join("")}</div>`;
  if (g.kern) return `<fieldset class="kern"><legend>${esc(g.legend)}</legend>${inhalt}</fieldset>`;
  return `<details class="mehr"><summary>${esc(g.legend)}</summary>${inhalt}</details>`;
}

function zeichneSchublade() {
  const lead = state.offen;
  if (!lead) return;

  el("d-title").textContent = lead.firmenname || lead.ansprechpartner || "Ohne Namen";
  el("d-sub").textContent = [lead.branche, lead.strasse, `${lead.plz || ""} ${lead.ort || ""}`.trim()]
    .filter(Boolean).join(" · ");

  zeichneQuick();

  el("d-form").innerHTML = FELDER.map((g) => gruppeHtml(g, lead)).join("");
  el("d-form").querySelectorAll("input, select, textarea").forEach((eingabe) => {
    const ereignis = eingabe.tagName === "SELECT" ? "change" : "blur";
    eingabe.addEventListener(ereignis, () => speichereFeld(eingabe));
  });
}

/** Nur die Knopfleiste neu zeichnen - das Formular bleibt stehen, damit der
 *  Fokus beim Weiterarbeiten nicht springt. */
function zeichneQuick() {
  const lead = state.offen;
  if (!lead) return;
  const zurueck = rueckgaengig.get(lead.id);
  el("d-quick").innerHTML = `
    ${lead.telefon ? `<a class="btn small" href="tel:${esc(lead.telefon)}">Anrufen</a>` : ""}
    <button class="btn ${lead.telefon ? "ghost " : ""}small" data-q="angerufen">Kontaktiert</button>
    <button class="btn ghost small" data-q="erreicht">Erreicht, Follow-up</button>
    <button class="btn ghost small" data-q="mir">Mir zuweisen</button>
    <button class="btn ghost small" data-q="plus7">Wiedervorlage +7 Tage</button>
    <button class="btn ghost small" data-q="irrelevant">Nicht relevant</button>
    ${zurueck ? `<button class="btn danger small" id="d-undo"
        title="Stellt den Stand vor dieser Änderung wieder her"
      >↩ ${esc(zurueck.label)} zurücknehmen</button>` : ""}`;

  el("d-quick").querySelectorAll("[data-q]").forEach((b) => {
    b.onclick = () => schnellaktion(b.dataset.q);
  });
  if (el("d-undo")) el("d-undo").onclick = zuruecknehmen;
}

function leseFeld(eingabe) {
  const { name, value, type } = eingabe;
  if (value === "") {
    return ["date", "number"].includes(type) || name === "bearbeiter"
      || name === "google_profil_vorhanden" || name === "prioritaet" ? null : "";
  }
  if (name === "google_profil_vorhanden") return value === "true";
  if (name === "prioritaet") return Number(value);
  if (type === "number") return Number(value);
  return value;
}

async function speichereFeld(eingabe) {
  const lead = state.offen;
  if (!lead) return;
  const feld = eingabe.name;
  const neu = leseFeld(eingabe);
  const alt = lead[feld] ?? (typeof neu === "string" ? "" : null);
  if (String(alt ?? "") === String(neu ?? "")) return;

  merkeVorzustand(lead, { [feld]: neu }, "Änderung an " + (FELDNAMEN[feld] || feld));
  await schreibe({ [feld]: neu });
}

async function schnellaktion(welche) {
  const lead = state.offen;
  if (!lead) return;
  const aenderung = {};

  if (welche === "angerufen") {
    aenderung.letzter_kontakt_am = heute();
    aenderung.anzahl_kontakte = (lead.anzahl_kontakte || 0) + 1;
    aenderung.kontaktkanal = lead.kontaktkanal || (lead.telefon ? "Telefon" : "Persönlich vor Ort");
    if (!lead.kontaktiert_am) aenderung.kontaktiert_am = heute();
    if (lead.status === "Neu" || lead.status === "Recherchiert") aenderung.status = "Kontaktiert";
    if (!lead.bearbeiter) aenderung.bearbeiter = state.profil.id;
  } else if (welche === "erreicht") {
    aenderung.status = "Follow-up";
    aenderung.letzter_kontakt_am = heute();
    aenderung.wiedervorlage_am = inTagen(7);
    if (!lead.bearbeiter) aenderung.bearbeiter = state.profil.id;
  } else if (welche === "mir") {
    aenderung.bearbeiter = state.profil.id;
  } else if (welche === "plus7") {
    const basis = lead.wiedervorlage_am ? new Date(lead.wiedervorlage_am) : new Date();
    basis.setDate(basis.getDate() + 7);
    aenderung.wiedervorlage_am = basis.toISOString().slice(0, 10);
  } else if (welche === "irrelevant") {
    aenderung.status = "Nicht relevant";
    aenderung.wiedervorlage_am = null;
  }

  const LABELS = {
    angerufen: "Kontaktiert", erreicht: "Erreicht, Follow-up", mir: "Mir zuweisen",
    plus7: "Wiedervorlage +7 Tage", irrelevant: "Nicht relevant",
  };
  merkeVorzustand(lead, aenderung, LABELS[welche]);

  await schreibe(aenderung);
  zeichneSchublade();
}

/** Werte sichern, die eine Änderung überschreibt. */
function merkeVorzustand(lead, aenderung, label) {
  const vorher = {};
  for (const feld of Object.keys(aenderung)) vorher[feld] = lead[feld] ?? null;
  rueckgaengig.set(lead.id, { label, vorher });
}

async function zuruecknehmen() {
  const lead = state.offen;
  const eintrag = lead && rueckgaengig.get(lead.id);
  if (!eintrag) return;
  rueckgaengig.delete(lead.id);   // das Zurücknehmen selbst ist nicht umkehrbar
  await schreibe(eintrag.vorher);
  zeichneSchublade();
  toast(`„${eintrag.label}" zurückgenommen.`);
}

async function schreibe(aenderung) {
  const lead = state.offen;
  const melde = el("d-saving");
  melde.textContent = "speichert …";
  melde.dataset.state = "";

  const { data, error } = await sb.from("leads")
    .update({ ...aenderung, geaendert_von: state.profil.id })
    .eq("id", lead.id).select().single();

  if (error) {
    melde.textContent = "Nicht gespeichert: " + error.message;
    melde.dataset.state = "err";
    toast("Änderung nicht gespeichert: " + error.message);
    return;
  }

  Object.assign(lead, data, {
    bearbeiter_name: state.team.find((t) => t.id === data.bearbeiter)?.name || "",
    faellig_in_tagen: tageBis(data.wiedervorlage_am),
  });
  const i = state.leads.findIndex((l) => l.id === lead.id);
  if (i >= 0) state.leads[i] = lead;

  melde.textContent = "gespeichert " + new Date().toLocaleTimeString("de-DE");
  melde.dataset.state = "ok";
  zeichne();
  zeichneQuick();
  ladeVerlauf(lead.id);
}

/* ===================================================== Bereich: Mein Bereich */

state.termine = [];
state.termineAlle = false;
state.terminOffen = null;     // Termin, der gerade bearbeitet wird
state.terminLead = null;      // im Formular gewählter Betrieb

state.watch = new Map();      // lead-id -> { notiz }

async function ladeWatchlist() {
  const { data, error } = await sb.from("watchlist")
    .select("lead_id, notiz").eq("benutzer", state.profil.id);
  if (error) { toast("Watchlist konnte nicht geladen werden: " + error.message); return; }
  state.watch = new Map((data || []).map((w) => [w.lead_id, { notiz: w.notiz }]));
}

async function watchSetzen(leadId, drauf) {
  if (drauf) {
    const { error } = await sb.from("watchlist")
      .upsert({ benutzer: state.profil.id, lead_id: leadId });
    if (error) return toast("Nicht gemerkt: " + error.message);
    state.watch.set(leadId, { notiz: "" });
  } else {
    const { error } = await sb.from("watchlist").delete()
      .eq("benutzer", state.profil.id).eq("lead_id", leadId);
    if (error) return toast("Nicht entfernt: " + error.message);
    state.watch.delete(leadId);
  }
  if (state.bereich === "mein") zeichneMein(); else zeichne();
}

async function watchNotiz(leadId, notiz) {
  const { error } = await sb.from("watchlist")
    .update({ notiz }).eq("benutzer", state.profil.id).eq("lead_id", leadId);
  if (error) return toast("Notiz nicht gespeichert: " + error.message);
  state.watch.set(leadId, { notiz });
}

async function ladeTermine() {
  const { data, error } = await sb.from("termine_ansicht")
    .select("*").order("beginn", { ascending: true });
  if (error) { toast("Termine konnten nicht geladen werden: " + error.message); return; }
  state.termine = data || [];
}

function terminZeit(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("de-DE",
    { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Vergangene Termine graufärben, heutige hervorheben. */
function terminLage(iso) {
  const t = new Date(iso), jetzt = new Date();
  if (t < jetzt) return "vorbei";
  if (t.toDateString() === jetzt.toDateString()) return "heute";
  return "";
}

async function zeichneMein() {
  // --- Termine ---
  const meine = state.termineAlle
    ? state.termine
    : state.termine.filter((t) => t.benutzer === state.profil.id);

  el("termin-liste").innerHTML = meine.length ? meine.map((t) => `
    <button class="eintrag ${terminLage(t.beginn)}" data-termin="${t.id}">
      <span class="wann">${esc(terminZeit(t.beginn))}</span>
      <span class="mitte">
        <span class="nm">${esc(t.titel) || "Ohne Titel"}</span>
        <span class="sub">${[
          t.lead_name && `bei ${esc(t.lead_name)}`,
          t.ort && esc(t.ort),
          t.dauer_min && `${t.dauer_min} Min`,
          state.termineAlle && t.benutzer_name ? esc(t.benutzer_name) : "",
        ].filter(Boolean).join(" · ")}</span>
        ${t.notiz ? `<span class="sub notiz-text">${esc(t.notiz)}</span>` : ""}
      </span>
      ${t.benutzer === state.profil.id ? '<span class="tag mine">meiner</span>' : ""}
    </button>`).join("")
    : `<p class="leer">${state.termineAlle ? "Keine Termine." : "Du hast keine Termine eingetragen."}</p>`;

  el("termin-liste").querySelectorAll("[data-termin]").forEach((b) => {
    b.onclick = () => oeffneTermin(state.termine.find((t) => t.id === b.dataset.termin));
  });

  // --- Meine Leads, getrennt nach schon angerufen ---
  const meineLeads = state.leads.filter(
    (l) => l.bearbeiter === state.profil.id && !ERLEDIGT.has(l.status));

  const nochOffen = meineLeads
    .filter((l) => !l.letzter_kontakt_am)
    .sort((a, b) => (a.prioritaet || 9) - (b.prioritaet || 9)
      || (a.firmenname || "").localeCompare(b.firmenname || "", "de"));

  const schonAngerufen = meineLeads
    .filter((l) => l.letzter_kontakt_am)
    .sort((a, b) => (b.letzter_kontakt_am || "").localeCompare(a.letzter_kontakt_am || ""));

  el("offen-zahl").textContent = nochOffen.length ? `${nochOffen.length} offen` : "";
  el("offen-liste").innerHTML = nochOffen.length
    ? nochOffen.slice(0, 200).map((l) => leadEintrag(l, { knopf: "angerufen", aktion: "angerufen" })).join("")
    : '<p class="leer">Nichts offen. Oben suchen, um Leads hinzuzufügen.</p>';

  el("erledigt-zahl").textContent = schonAngerufen.length ? `${schonAngerufen.length} erledigt` : "";
  el("erledigt-liste").innerHTML = schonAngerufen.length
    ? schonAngerufen.slice(0, 200).map((l) => leadEintrag(l, {
        rechts: datumDe(l.letzter_kontakt_am) + (l.anzahl_kontakte > 1 ? ` · ${l.anzahl_kontakte}×` : ""),
        knopf: "nochmal", aktion: "zurueck",
      })).join("")
    : '<p class="leer">Noch nichts angerufen.</p>';

  // --- Watchlist ---
  const gemerkt = [...state.watch.keys()]
    .map((id) => state.leads.find((l) => l.id === id))
    .filter(Boolean)
    .sort((a, b) => (a.prioritaet || 9) - (b.prioritaet || 9)
      || (a.firmenname || "").localeCompare(b.firmenname || "", "de"));

  el("watch-zahl").textContent = gemerkt.length ? `${gemerkt.length} gemerkt` : "";
  el("watch-liste").innerHTML = gemerkt.length
    ? gemerkt.map((l) => leadEintrag(l, {
        knopf: "entfernen", aktion: "unwatch", watch: true,
      })).join("")
    : '<p class="leer">Nichts gemerkt. Oben suchen oder in der Leads-Liste auswählen und „→ Watchlist“.</p>';

  // --- Priorisierte Leads ---
  const prio = state.leads
    .filter((l) => l.prioritaet && !ERLEDIGT.has(l.status))
    .sort((a, b) => a.prioritaet - b.prioritaet
      || (a.firmenname || "").localeCompare(b.firmenname || "", "de"));

  el("prio-zahl").textContent = prio.length ? `${prio.length} offen` : "";
  el("prio-liste").innerHTML = prio.length
    ? prio.map((l) => leadEintrag(l, { rechts: PRIO_NAME[l.prioritaet] })).join("")
    : '<p class="leer">Noch nichts priorisiert. In der Liste links auf die Balken klicken.</p>';

  bindeEintraege();
}

/** Ein Lead als Zeile in Mein Bereich. opt: {rechts, knopf, aktion, watch} */
function leadEintrag(l, opt = {}) {
  const notiz = opt.watch ? (state.watch.get(l.id)?.notiz || "") : (l.notizen || "");
  return `
    <div class="eintrag" data-id="${l.id}">
      <span class="prio-marke" data-p="${l.prioritaet || 0}"></span>
      <span class="mitte">
        <button class="nm nur-text" data-lead="${l.id}">${esc(l.firmenname) || "ohne Namen"}</button>
        <span class="sub">${esc(l.branche)}${l.strasse ? " · " + esc(l.strasse) : ""}${l.ort ? " · " + esc(l.ort) : ""}</span>
        <div class="notiz klein" tabindex="0" data-notiz="${opt.watch ? "watch" : "lead"}"
             title="Klicken zum Bearbeiten">${esc(notiz) || '<span class="sub">Notiz …</span>'}</div>
      </span>
      ${opt.rechts ? `<span class="sub rechts">${esc(opt.rechts)}</span>` : ""}
      ${opt.knopf ? `<button class="btn ghost small" data-aktion="${opt.aktion}">${esc(opt.knopf)}</button>` : ""}
    </div>`;
}

function bindeEintraege() {
  el("b-mein").querySelectorAll(".eintrag").forEach((zeile) => {
    const id = zeile.dataset.id;

    zeile.querySelector("[data-lead]").onclick = () => oeffne(id);

    const notiz = zeile.querySelector("[data-notiz]");
    if (notiz) {
      const istWatch = notiz.dataset.notiz === "watch";
      notiz.onclick = () => notizBearbeiten(notiz, id, istWatch);
      notiz.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); notizBearbeiten(notiz, id, istWatch); }
      };
    }

    const knopf = zeile.querySelector("[data-aktion]");
    if (knopf) knopf.onclick = () => meinAktion(id, knopf.dataset.aktion);
  });
}

async function meinAktion(id, aktion) {
  const lead = state.leads.find((l) => l.id === id);
  if (!lead) return;

  if (aktion === "angerufen") {
    const aenderung = {
      letzter_kontakt_am: heute(),
      anzahl_kontakte: (lead.anzahl_kontakte || 0) + 1,
      kontaktkanal: lead.kontaktkanal || (lead.telefon ? "Telefon" : "Persönlich vor Ort"),
    };
    if (!lead.kontaktiert_am) aenderung.kontaktiert_am = heute();
    if (lead.status === "Neu" || lead.status === "Recherchiert") aenderung.status = "Kontaktiert";
    merkeVorzustand(lead, aenderung, "Angerufen");
    await speichereLead(id, aenderung);
    toast(`„${lead.firmenname}" als angerufen vermerkt.`);
  } else if (aktion === "zurueck") {
    const aenderung = { letzter_kontakt_am: null };
    merkeVorzustand(lead, aenderung, "Zurück in die Anrufliste");
    await speichereLead(id, aenderung);
    toast(`„${lead.firmenname}" steht wieder zum Anrufen an.`);
  } else if (aktion === "unwatch") {
    return watchSetzen(id, false);
  }
  zeichneMein();
}

/* ------------------------------------------- Leads suchen und hinzufügen */

document.querySelectorAll(".sucher").forEach((sucher) => {
  const feld = sucher.querySelector("input");
  const kasten = sucher.querySelector(".lead-treffer");
  const ziel = sucher.dataset.ziel;

  feld.addEventListener("input", () => {
    const q = leerString(feld.value);
    if (q.length < 2) { kasten.hidden = true; return; }

    const treffer = state.leads
      .filter((l) => leerString(l.firmenname).includes(q) || leerString(l.strasse).includes(q))
      .slice(0, 8);

    if (!treffer.length) { kasten.hidden = true; return; }
    kasten.hidden = false;
    kasten.innerHTML = treffer.map((l) => `
      <button class="treffer" data-id="${l.id}">
        <span class="nm">${esc(l.firmenname) || "ohne Namen"}</span>
        <span class="sub">${esc(l.branche)}${l.strasse ? " · " + esc(l.strasse) : ""}${l.ort ? " · " + esc(l.ort) : ""}</span>
      </button>`).join("");

    kasten.querySelectorAll(".treffer").forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.id;
        feld.value = "";
        kasten.hidden = true;
        await hinzufuegen(id, ziel);
      };
    });
  });
});

async function hinzufuegen(id, ziel) {
  const lead = state.leads.find((l) => l.id === id);
  if (!lead) return;

  if (ziel === "watch") {
    await watchSetzen(id, true);
    return toast(`„${lead.firmenname}" auf die Watchlist gesetzt.`);
  }

  const aenderung = { bearbeiter: state.profil.id };
  // "Schon angerufen" heisst: Kontaktdatum setzen, sonst landet er im
  // falschen Block.
  if (ziel === "erledigt" && !lead.letzter_kontakt_am) {
    aenderung.letzter_kontakt_am = heute();
    aenderung.anzahl_kontakte = (lead.anzahl_kontakte || 0) + 1;
    if (!lead.kontaktiert_am) aenderung.kontaktiert_am = heute();
    if (lead.status === "Neu" || lead.status === "Recherchiert") aenderung.status = "Kontaktiert";
  }
  if (ziel === "offen" && lead.letzter_kontakt_am) aenderung.letzter_kontakt_am = null;

  merkeVorzustand(lead, aenderung, "In Mein Bereich übernommen");
  await speichereLead(id, aenderung);
  zeichneMein();
  toast(`„${lead.firmenname}" übernommen.`);
}

/* ------------------------------------------------------- Termin anlegen */

function oeffneTermin(termin) {
  state.terminOffen = termin || null;
  state.terminLead = termin?.lead_id
    ? state.leads.find((l) => l.id === termin.lead_id) || null
    : null;

  const eigener = !termin || termin.benutzer === state.profil.id;

  el("termin-titel").textContent = termin ? "Termin bearbeiten" : "Neuer Termin";
  el("t-titel").value = termin?.titel || "";
  el("t-beginn").value = termin
    ? new Date(new Date(termin.beginn).getTime()
        - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : naechsteStunde();
  el("t-dauer").value = termin?.dauer_min ?? 60;
  el("t-ort").value = termin?.ort || "";
  el("t-notiz").value = termin?.notiz || "";
  el("t-suche").value = "";
  el("t-treffer").hidden = true;

  zeigeGewaehltenLead();

  el("termin-speichern").textContent = termin ? "Änderungen speichern" : "Termin anlegen";
  el("termin-speichern").hidden = !eigener;
  el("termin-loeschen").hidden = !termin || !eigener;
  el("termin-melde").textContent = eigener ? "" : `Termin von ${termin.benutzer_name || "jemand anderem"} — nur lesbar.`;
  el("termin-melde").className = "note";

  el("termin-scrim").hidden = false;
  el("termin-modal").hidden = false;
  if (eigener) el("t-titel").focus();
}

function naechsteStunde() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function schliesseTermin() {
  el("termin-scrim").hidden = true;
  el("termin-modal").hidden = true;
  state.terminOffen = null;
  state.terminLead = null;
}

function zeigeGewaehltenLead() {
  const kasten = el("t-gewaehlt");
  const l = state.terminLead;
  if (!l) { kasten.hidden = true; kasten.innerHTML = ""; return; }
  kasten.hidden = false;
  kasten.innerHTML = `
    <span class="nm">${esc(l.firmenname) || "ohne Namen"}</span>
    <span class="sub">${esc(l.strasse)}${l.ort ? " · " + esc(l.ort) : ""}</span>
    <button class="btn ghost small" id="t-loesen">entfernen</button>`;
  el("t-loesen").onclick = () => { state.terminLead = null; zeigeGewaehltenLead(); };
}

el("t-suche").addEventListener("input", (e) => {
  const q = leerString(e.target.value);
  const kasten = el("t-treffer");
  if (q.length < 2) { kasten.hidden = true; return; }

  const treffer = state.leads
    .filter((l) => leerString(l.firmenname).includes(q))
    .slice(0, 8);

  if (!treffer.length) { kasten.hidden = true; return; }
  kasten.hidden = false;
  kasten.innerHTML = treffer.map((l) => `
    <button class="treffer" data-id="${l.id}">
      <span class="nm">${esc(l.firmenname)}</span>
      <span class="sub">${esc(l.strasse)}${l.ort ? " · " + esc(l.ort) : ""}</span>
    </button>`).join("");

  kasten.querySelectorAll(".treffer").forEach((b) => {
    b.onclick = () => {
      state.terminLead = state.leads.find((l) => l.id === b.dataset.id) || null;
      el("t-suche").value = "";
      kasten.hidden = true;
      zeigeGewaehltenLead();
    };
  });
});

async function terminSpeichern() {
  const beginn = el("t-beginn").value;
  if (!beginn) {
    el("termin-melde").textContent = "Ohne Beginn geht es nicht.";
    el("termin-melde").className = "note err";
    return;
  }

  const datensatz = {
    titel: el("t-titel").value.trim(),
    beginn: new Date(beginn).toISOString(),
    dauer_min: Number(el("t-dauer").value) || 60,
    ort: el("t-ort").value.trim(),
    notiz: el("t-notiz").value.trim(),
    lead_id: state.terminLead?.id || null,
    benutzer: state.profil.id,
  };

  el("termin-melde").textContent = "speichert …";
  el("termin-melde").className = "note";
  el("termin-speichern").disabled = true;

  const { error } = state.terminOffen
    ? await sb.from("termine").update(datensatz).eq("id", state.terminOffen.id)
    : await sb.from("termine").insert(datensatz);

  el("termin-speichern").disabled = false;

  if (error) {
    el("termin-melde").textContent = "Nicht gespeichert: " + error.message;
    el("termin-melde").className = "note err";
    return;
  }

  schliesseTermin();
  await ladeTermine();
  zeichneMein();
  toast("Termin gespeichert.");
}

async function terminLoeschen() {
  const t = state.terminOffen;
  if (!t) return;
  if (!confirm(`Termin „${t.titel || "ohne Titel"}“ am ${terminZeit(t.beginn)} löschen?`)) return;

  const { error } = await sb.from("termine").delete().eq("id", t.id);
  if (error) return toast("Nicht gelöscht: " + error.message);

  schliesseTermin();
  await ladeTermine();
  zeichneMein();
  toast("Termin gelöscht.");
}

el("termin-oeffnen").onclick = () => oeffneTermin(null);
el("termin-close").onclick = schliesseTermin;
el("termin-scrim").onclick = schliesseTermin;
el("termin-speichern").onclick = terminSpeichern;
el("termin-loeschen").onclick = terminLoeschen;
el("termine-alle").onchange = (e) => { state.termineAlle = e.target.checked; zeichneMein(); };

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("termin-modal").hidden) schliesseTermin();
});

/* ------------------------------------------------------------ Neuer Lead */

const NEU_FELDER = [
  { k: "firmenname", t: "Firmenname", typ: "text", voll: true },
  { k: "branche", t: "Branche", typ: "liste", liste: "branche" },
  { k: "status", t: "Status", typ: "liste", liste: "status" },
  { k: "strasse", t: "Straße & Nr.", typ: "text", voll: true },
  { k: "plz", t: "PLZ", typ: "text" },
  { k: "ort", t: "Ort", typ: "text" },
  { k: "telefon", t: "Telefon", typ: "tel" },
  { k: "email", t: "E-Mail", typ: "email" },
  { k: "website", t: "Website", typ: "url", voll: true },
  { k: "ansprechpartner", t: "Ansprechpartner", typ: "text" },
  { k: "bearbeiter", t: "Bearbeiter", typ: "team" },
  { k: "prioritaet", t: "Priorität", typ: "prio" },
  { k: "notizen", t: "Notiz", typ: "mehrzeilig", voll: true },
];

const leerString = (s) =>
  (s || "").toLowerCase().replace(/[^\wäöüß\s]/g, " ").replace(/\s+/g, " ").trim();

/** Leads suchen, die dem Eingetippten ähneln. Läuft gegen den bereits
 *  geladenen Bestand, also ohne weitere Abfrage. */
function findeDubletten(name, strasse, ort) {
  const n = leerString(name);
  const s = leerString(strasse);
  if (n.length < 3 && s.length < 4) return [];

  return state.leads.filter((l) => {
    const ln = leerString(l.firmenname);
    const ls = leerString(l.strasse);
    if (ort && l.ort && leerString(l.ort) !== leerString(ort)) return false;
    const nameTrifft = n.length >= 3 && (ln.includes(n) || n.includes(ln)) && ln.length >= 3;
    const strasseTrifft = s.length >= 4 && ls === s;
    return nameTrifft || strasseTrifft;
  }).slice(0, 6);
}

function zeigeDubletten() {
  const form = el("neu-form");
  const hole = (k) => form.querySelector(`[name="${k}"]`)?.value || "";
  const treffer = findeDubletten(hole("firmenname"), hole("strasse"), hole("ort"));
  const kasten = el("neu-dubletten");

  if (!treffer.length) { kasten.hidden = true; kasten.innerHTML = ""; return; }

  kasten.hidden = false;
  kasten.innerHTML = `
    <p class="dubletten-kopf">Gibt es möglicherweise schon — anlegen geht trotzdem:</p>
    ${treffer.map((l) => `
      <button class="dublette" data-id="${l.id}">
        <span class="nm">${esc(l.firmenname) || "ohne Namen"}</span>
        <span class="sub">${esc(l.branche)}${l.strasse ? " · " + esc(l.strasse) : ""}${l.ort ? " · " + esc(l.ort) : ""}</span>
        <span class="status" data-s="${esc(l.status)}">${esc(l.status)}</span>
      </button>`).join("")}`;

  kasten.querySelectorAll(".dublette").forEach((b) => {
    b.onclick = () => { schliesseNeu(); oeffne(b.dataset.id); };
  });
}

function oeffneNeu() {
  const vorgabe = {
    firmenname: "", branche: "", status: "Neu", strasse: "", plz: "", ort: "",
    telefon: "", email: "", website: "", ansprechpartner: "",
    bearbeiter: state.profil.id, prioritaet: null, notizen: "",
    // Ort vorbelegen, wenn gerade nach einem gefiltert wird
    ...(state.ort ? { ort: state.ort } : {}),
  };

  el("neu-form").innerHTML =
    `<div class="grid2">${NEU_FELDER.map((f) => feldHtml(f, vorgabe, "n")).join("")}</div>`;
  el("neu-melde").textContent = "";
  el("neu-dubletten").hidden = true;
  el("neu-scrim").hidden = false;
  el("neu-modal").hidden = false;

  el("neu-form").querySelectorAll('[name="firmenname"], [name="strasse"], [name="ort"]')
    .forEach((e) => e.addEventListener("input", zeigeDubletten));

  el("neu-form").querySelector('[name="firmenname"]').focus();
}

function schliesseNeu() {
  el("neu-scrim").hidden = true;
  el("neu-modal").hidden = true;
}

async function neuAnlegen() {
  const form = el("neu-form");
  const datensatz = {};
  form.querySelectorAll("input, select, textarea").forEach((e) => {
    datensatz[e.name] = leseFeld(e);
  });

  if (!datensatz.firmenname && !datensatz.ansprechpartner) {
    el("neu-melde").textContent = "Firmenname oder Ansprechpartner wird gebraucht.";
    el("neu-melde").className = "note err";
    return;
  }

  datensatz.land = "Deutschland";
  datensatz.status = datensatz.status || "Neu";
  datensatz.lead_quelle = `Von Hand ${state.profil.name || ""} ${new Date().toLocaleDateString("de-DE")}`.trim();
  datensatz.erstellt_von = state.profil.id;
  datensatz.geaendert_von = state.profil.id;
  // import_schluessel bleibt leer: Der ist eindeutig und wuerde das Anlegen
  // eines bewusst doppelten Eintrags verhindern. Die Pruefung ist ein Hinweis,
  // keine Sperre.

  el("neu-melde").textContent = "legt an …";
  el("neu-melde").className = "note";
  el("neu-speichern").disabled = true;

  const { data, error } = await sb.from("leads").insert(datensatz).select().single();
  el("neu-speichern").disabled = false;

  if (error) {
    el("neu-melde").textContent = "Nicht angelegt: " + error.message;
    el("neu-melde").className = "note err";
    return;
  }

  state.leads.push({
    ...data,
    bearbeiter_name: state.team.find((t) => t.id === data.bearbeiter)?.name || "",
    faellig_in_tagen: tageBis(data.wiedervorlage_am),
  });

  schliesseNeu();
  zeichneFilter();
  zeichne();
  toast(`„${data.firmenname || data.ansprechpartner}" angelegt.`);
  oeffne(data.id);
}

el("neu-oeffnen").onclick = oeffneNeu;
el("neu-close").onclick = schliesseNeu;
el("neu-scrim").onclick = schliesseNeu;
el("neu-speichern").onclick = neuAnlegen;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("neu-modal").hidden) schliesseNeu();
});

/* ---------------------------------------------------------------- Verlauf */

const FELDNAMEN = {
  status: "Status", bearbeiter: "Bearbeiter", notizen: "Notiz",
  letzter_kontakt_am: "Letzter Kontakt", kontaktiert_am: "Erstkontakt",
  wiedervorlage_am: "Wiedervorlage", anzahl_kontakte: "Anzahl Kontakte",
  kontaktkanal: "Kontaktkanal", angebotswert: "Angebotswert",
  abschluss_wahrsch: "Abschluss-Wahrsch.", angebot_gesendet_am: "Angebot gesendet",
  firmenname: "Firmenname", telefon: "Telefon", email: "E-Mail", website: "Website",
  strasse: "Straße", plz: "PLZ", ort: "Ort", branche: "Branche",
  ansprechpartner: "Ansprechpartner", position: "Position",
  place_id: "Place-ID", bewertungslink: "Bewertungslink",
  produktinteresse: "Produktinteresse", prioritaet: "Priorität",
};

/** Das Protokoll speichert alles als Text. Fürs Zurückschreiben muss daraus
 *  wieder der Typ der Spalte werden, sonst lehnt PostgREST ab. */
const FELD_TYP = Object.fromEntries(FELDER.flatMap((g) => g.felder.map((f) => [f.k, f.typ])));

function wertAusText(feld, text) {
  const typ = FELD_TYP[feld];
  const leer = text === null || text === undefined || text === "";
  if (typ === "prio") return leer ? null : Number(text);
  if (typ === "zahl") return leer ? null : Number(text);
  if (typ === "datum") return leer ? null : text;
  if (typ === "janein") return leer ? null : text === "true";
  if (typ === "team") return leer ? null : text;
  return leer ? "" : text;
}

function verlaufWert(feld, roh) {
  if (roh === null || roh === undefined || roh === "") return "leer";
  if (feld === "bearbeiter") return state.team.find((t) => t.id === roh)?.name || "nicht zugeordnet";
  if (feld === "prioritaet") return PRIO_NAME[roh] || roh;
  if (FELD_TYP[feld] === "datum") return datumDe(roh);
  if (FELD_TYP[feld] === "janein") return roh === "true" ? "Ja" : "Nein";
  return roh.length > 60 ? roh.slice(0, 60) + "…" : roh;
}

async function stelleWiederHer(feld, altText, beschriftung) {
  const lead = state.offen;
  if (!lead) return;
  const wert = wertAusText(feld, altText);
  merkeVorzustand(lead, { [feld]: wert }, "Wiederherstellung von " + beschriftung);
  await schreibe({ [feld]: wert });
  zeichneSchublade();
  toast(`${beschriftung} auf „${verlaufWert(feld, altText)}" zurückgesetzt.`);
}

async function ladeVerlauf(leadId) {
  const { data, error } = await sb.from("aktivitaet")
    .select("feld, alt, neu, zeit, benutzer")
    .eq("lead_id", leadId).order("zeit", { ascending: false }).limit(40);

  const ziel = el("d-log");
  if (error) { ziel.innerHTML = `<p class="note err">${esc(error.message)}</p>`; return; }
  if (!data.length) { ziel.innerHTML = '<p class="note">Noch keine Änderungen.</p>'; return; }

  ziel.innerHTML = data.map((a, i) => {
    const wer = state.team.find((t) => t.id === a.benutzer)?.name || "jemand";
    const feld = FELDNAMEN[a.feld] || a.feld;
    const alt = verlaufWert(a.feld, a.alt);
    const neu = verlaufWert(a.feld, a.neu);
    const herstellbar = a.feld in FELD_TYP;
    return `<div class="log-row">
      <span class="when">${esc(zeitDe(a.zeit))}</span>
      <span class="what">
        ${esc(wer)}: ${esc(feld)} <s>${esc(alt)}</s> → <b>${esc(neu)}</b>
        ${herstellbar ? `<button class="log-undo" data-i="${i}"
            title="Setzt ${esc(feld)} wieder auf ${esc(alt)}">↩ zurück auf ${esc(alt)}</button>` : ""}
      </span>
    </div>`;
  }).join("");

  ziel.querySelectorAll(".log-undo").forEach((b) => {
    b.onclick = () => {
      const a = data[Number(b.dataset.i)];
      stelleWiederHer(a.feld, a.alt, FELDNAMEN[a.feld] || a.feld);
    };
  });
}

/* ------------------------------------------------------------------ Start */

sb.auth.onAuthStateChange((ereignis) => {
  if (ereignis === "SIGNED_IN" && el("app").hidden) starten();
  if (ereignis === "SIGNED_OUT") zeigeGate();
});

/* Eine leere Seite ist das schlechteste Fehlerbild: Wirft start() irgendwo,
   bleiben Anmeldemaske und Anwendung beide versteckt und niemand weiss warum.
   Deshalb faengt diese Huelle alles ab und schreibt es sichtbar hin. */
async function starten() {
  try {
    await start();
  } catch (e) {
    console.error("Start fehlgeschlagen:", e);
    zeigeGate("Die Seite konnte nicht geladen werden: " + (e?.message || e));
  }
}

// Auch Fehler, die ausserhalb von start() auftreten, sollen sichtbar werden.
addEventListener("error", (e) => {
  if (el("app").hidden && el("gate").hidden) {
    zeigeGate("Fehler beim Laden: " + (e.message || "unbekannt"));
  }
});

addEventListener("unhandledrejection", (e) => {
  if (el("app").hidden && el("gate").hidden) {
    zeigeGate("Fehler beim Laden: " + (e.reason?.message || e.reason || "unbekannt"));
  }
});

starten();
