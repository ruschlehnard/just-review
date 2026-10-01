/* just-review Lead-Dashboard
   Statische Seite, redet direkt mit Supabase. Kein eigener Server.

   Ablauf:
     1. Google-Anmeldung über Supabase Auth
     2. Profil laden - wer keins hat, ist nicht eingeladen und sieht nichts
     3. Leads laden, Echtzeit abonnieren
     4. Änderungen gehen sofort an die Datenbank, der Trigger protokolliert sie
*/

"use strict";

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

if (!window.CONFIG || window.CONFIG.SUPABASE_URL.includes("DEIN-PROJEKT")) {
  document.body.innerHTML =
    '<div class="gate"><div class="gate-card"><h1>Einrichtung fehlt</h1>' +
    '<p>Kopiere <code>config.example.js</code> zu <code>config.js</code> ' +
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
];

const state = {
  profil: null,
  leads: [],
  team: [],
  listen: {},
  offen: null,
  q: "", ort: "", bearbeiter: "", branche: "",
  status: new Set(),
  kachel: "",
  sort: { k: "firmenname", dir: 1 },
};

/* Letzte Änderung je Lead, damit sie zurückgenommen werden kann:
   lead-id -> { label, vorher: {feld: Wert davor} }
   Nur im Speicher - nach dem Neuladen der Seite ist der Verlauf weg. Was
   dauerhaft nachvollziehbar sein muss, steht unten in der Tabelle "Verlauf". */
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

const initialen = (name) =>
  (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();

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
    // Nach einer Rückleitung von Google sollte hier eine Sitzung stehen. Tut
    // sie es nicht, ist der Code-Tausch gescheitert - das muss man sehen.
    const kamVonGoogle = new URLSearchParams(location.search).has("code");
    if (kamVonGoogle) {
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

  if (error) {
    zeigeGate(`Profil konnte nicht geladen werden: ${error.message}`);
    return;
  }
  if (!profil) {
    zeigeGate(
      `Für ${session.user.email} ist kein Zugang freigeschaltet. ` +
      "Bitte Leon melden, damit er dich in der Tabelle 'einladungen' einträgt."
    );
    return;
  }

  state.profil = profil;
  el("gate").hidden = true;
  el("app").hidden = false;
  el("username").textContent = profil.name || profil.email;
  el("avatar").textContent = initialen(profil.name || profil.email);

  await Promise.all([ladeTeam(), ladeListen()]);
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
  (data || []).forEach(({ kategorie, wert }) => {
    (state.listen[kategorie] ||= []).push(wert);
  });
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
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, (nutzlast) => {
      const { eventType, new: neu, old: alt } = nutzlast;
      if (eventType === "DELETE") {
        state.leads = state.leads.filter((l) => l.id !== alt.id);
      } else {
        const i = state.leads.findIndex((l) => l.id === neu.id);
        // Realtime liefert die Tabelle, nicht die Sicht - abgeleitete Felder ergänzen.
        const angereichert = {
          ...neu,
          bearbeiter_name: state.team.find((t) => t.id === neu.bearbeiter)?.name || "",
          faellig_in_tagen: tageBis(neu.wiedervorlage_am),
        };
        if (i >= 0) state.leads[i] = angereichert;
        else state.leads.push(angereichert);

        if (state.offen?.id === neu.id && document.activeElement?.form?.id !== "d-form") {
          state.offen = angereichert;
          zeichneSchublade();
        }
      }
      zeichne();
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
  { id: "offen", cls: "", lbl: "Nie kontaktiert", f: (l) => !l.letzter_kontakt_am },
  { id: "faellig", cls: "t-warn", lbl: "Wiedervorlage fällig", f: (l) => {
      const t = tageBis(l.wiedervorlage_am); return t !== null && t <= 0; } },
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
    b.onclick = () => {
      state.kachel = state.kachel === b.dataset.k ? "" : b.dataset.k;
      zeichneKacheln(); zeichne();
    };
  });
}

function zeichneFilter() {
  const fuellen = (id, werte, aktuell) => {
    const s = el(id);
    const erste = s.options[0].outerHTML;
    s.innerHTML = erste + werte.map((w) =>
      `<option value="${esc(w.v)}"${w.v === aktuell ? " selected" : ""}>${esc(w.t)}</option>`).join("");
  };

  const orte = [...new Set(state.leads.map((l) => l.ort).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "de"));
  fuellen("f-ort", orte.map((o) => ({
    v: o, t: `${o} (${state.leads.filter((l) => l.ort === o).length})` })), state.ort);

  fuellen("f-bearbeiter", [
    { v: "__keiner", t: "– nicht zugeordnet –" },
    ...state.team.map((t) => ({ v: t.id, t: t.name || t.email })),
  ], state.bearbeiter);

  const branchen = [...new Set(state.leads.map((l) => l.branche).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "de"));
  fuellen("f-branche", branchen.map((b) => ({ v: b, t: b })), state.branche);

  el("status-chips").innerHTML = (state.listen.status || STATUS).map((s) => `
    <button class="chip" data-s="${esc(s)}" aria-pressed="${state.status.has(s)}">
      ${esc(s)}<span class="c">${state.leads.filter((l) => l.status === s).length}</span>
    </button>`).join("");
  el("status-chips").querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => {
      const s = b.dataset.s;
      state.status.has(s) ? state.status.delete(s) : state.status.add(s);
      zeichneFilter(); zeichne();
    };
  });
}

/* --------------------------------------------------------------- Tabelle */

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

  const { k, dir } = state.sort;
  out.sort((a, b) => {
    const av = a[k] ?? "", bv = b[k] ?? "";
    if (!av && bv) return 1;
    if (av && !bv) return -1;
    return String(av).localeCompare(String(bv), "de", { numeric: true }) * dir;
  });
  return out;
}

function zeichne() {
  zeichneKacheln();
  const rows = sichtbar();
  el("empty").hidden = rows.length > 0;
  el("count").textContent =
    `${rows.length} von ${state.leads.length} Leads angezeigt`;

  el("tb").innerHTML = rows.map((l) => {
    const faellig = tageBis(l.wiedervorlage_am);
    const istFaellig = faellig !== null && faellig <= 0;
    const cls = [!l.website ? "no-web" : "", istFaellig ? "faellig" : ""].filter(Boolean).join(" ");
    const tags = [
      l.bearbeiter === state.profil.id ? '<span class="tag mine">meiner</span>' : "",
      !l.website ? '<span class="tag nw">keine Website</span>' : "",
      istFaellig ? `<span class="tag due">${faellig === 0 ? "heute fällig" : `${-faellig} T überfällig`}</span>` : "",
    ].filter(Boolean).join("");

    return `<tr data-id="${l.id}" class="${cls}" aria-selected="${state.offen?.id === l.id}">
      <td class="stripe"><i></i></td>
      <td>
        <span class="nm">${esc(l.firmenname) || '<span class="sub">ohne Firmenname</span>'}</span>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
        <div class="sub">${esc(l.branche)}${l.strasse ? " · " + esc(l.strasse) : ""}</div>
      </td>
      <td>${esc(l.ort)}<div class="sub mono">${esc(l.plz)}</div></td>
      <td><span class="status" data-s="${esc(l.status)}">${esc(l.status)}</span></td>
      <td>${esc(l.bearbeiter_name) || '<span class="sub">—</span>'}</td>
      <td class="mono">${datumDe(l.letzter_kontakt_am) || '<span class="sub">nie</span>'}
        ${l.anzahl_kontakte ? `<div class="sub">${l.anzahl_kontakte}× Kontakt</div>` : ""}</td>
      <td class="mono">${datumDe(l.wiedervorlage_am) || '<span class="sub">—</span>'}</td>
      <td>
        ${l.telefon ? `<a class="dot on" href="tel:${esc(l.telefon)}" title="${esc(l.telefon)}" onclick="event.stopPropagation()">T</a>` : '<span class="dot">T</span>'}
        ${l.email ? `<a class="dot on" href="mailto:${esc(l.email)}" title="${esc(l.email)}" onclick="event.stopPropagation()">@</a>` : '<span class="dot">@</span>'}
        ${l.website ? `<a class="dot on" href="${esc(l.website)}" target="_blank" rel="noopener noreferrer" title="${esc(l.website)}" onclick="event.stopPropagation()">W</a>` : '<span class="dot">W</span>'}
      </td>
    </tr>`;
  }).join("");

  el("tb").querySelectorAll("tr").forEach((tr) => {
    tr.onclick = () => oeffne(tr.dataset.id);
  });
}

/* -------------------------------------------------------------- Steuerung */

el("q").oninput = (e) => { state.q = e.target.value; zeichne(); };
el("f-ort").onchange = (e) => { state.ort = e.target.value; zeichne(); };
el("f-bearbeiter").onchange = (e) => { state.bearbeiter = e.target.value; zeichne(); };
el("f-branche").onchange = (e) => { state.branche = e.target.value; zeichne(); };

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
  { legend: "Vertrieb", felder: [
    { k: "status", t: "Status", typ: "liste", liste: "status" },
    { k: "bearbeiter", t: "Bearbeiter", typ: "team" },
    { k: "kontaktkanal", t: "Kontaktkanal", typ: "liste", liste: "kontaktkanal" },
    { k: "anzahl_kontakte", t: "Anzahl Kontakte", typ: "zahl" },
    { k: "kontaktiert_am", t: "Erstkontakt am", typ: "datum" },
    { k: "letzter_kontakt_am", t: "Letzter Kontakt am", typ: "datum" },
    { k: "wiedervorlage_am", t: "Wiedervorlage am", typ: "datum" },
    { k: "produktinteresse", t: "Produktinteresse", typ: "liste", liste: "produktinteresse" },
  ]},
  { legend: "Angebot", felder: [
    { k: "angebot_gesendet_am", t: "Angebot gesendet am", typ: "datum" },
    { k: "angebotswert", t: "Angebotswert (€)", typ: "zahl", schritt: "0.01" },
    { k: "abschluss_wahrsch", t: "Abschluss-Wahrsch. (0–1)", typ: "zahl", schritt: "0.05", max: "1" },
  ]},
  { legend: "Firma und Kontakt", felder: [
    { k: "firmenname", t: "Firmenname", typ: "text", voll: true },
    { k: "branche", t: "Branche", typ: "liste", liste: "branche", frei: true },
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
  { legend: "Notizen", felder: [
    { k: "notizen", t: "Notizen / nächster Schritt", typ: "mehrzeilig", voll: true },
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

el("d-close").onclick = schliesse;
el("scrim").onclick = schliesse;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("drawer").hidden) schliesse();
});

function feldHtml(f, lead) {
  const wert = lead[f.k];
  const id = `f-${f.k}`;
  const cls = f.voll ? ' class="full"' : "";
  let eingabe;

  if (f.typ === "liste" || f.typ === "team" || f.typ === "janein") {
    let opts;
    if (f.typ === "team") {
      opts = [{ v: "", t: "– nicht zugeordnet –" },
        ...state.team.map((t) => ({ v: t.id, t: t.name || t.email }))];
    } else if (f.typ === "janein") {
      opts = [{ v: "", t: "– offen –" }, { v: "true", t: "Ja" }, { v: "false", t: "Nein" }];
    } else {
      const werte = state.listen[f.liste] || [];
      // Ein vorhandener Wert, der nicht in der Liste steht, geht nicht verloren.
      const extra = wert && !werte.includes(wert) ? [wert] : [];
      opts = [{ v: "", t: "– leer –" }, ...[...extra, ...werte].map((w) => ({ v: w, t: w }))];
    }
    const aktuell = f.typ === "janein"
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

function zeichneSchublade() {
  const lead = state.offen;
  if (!lead) return;

  el("d-title").textContent = lead.firmenname || lead.ansprechpartner || "Ohne Namen";

  zeichneQuick();

  el("d-form").innerHTML = FELDER.map((gruppe) => `
    <fieldset>
      <legend>${esc(gruppe.legend)}</legend>
      <div class="grid2">${gruppe.felder.map((f) => feldHtml(f, lead)).join("")}</div>
    </fieldset>`).join("");

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
    <button class="btn small" data-q="angerufen">Angerufen</button>
    <button class="btn ghost small" data-q="erreicht">Erreicht, Follow-up</button>
    <button class="btn ghost small" data-q="mir">Mir zuweisen</button>
    <button class="btn ghost small" data-q="plus7">Wiedervorlage +7 Tage</button>
    ${lead.telefon ? `<a class="btn ghost small" href="tel:${esc(lead.telefon)}">Anrufen</a>` : ""}
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
    // Leere Textfelder bleiben leer, leere Datums-/Zahlenfelder werden NULL.
    return ["date", "number"].includes(type) || name === "bearbeiter"
      || name === "google_profil_vorhanden" ? null : "";
  }
  if (name === "google_profil_vorhanden") return value === "true";
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

  const beschriftung = FELDNAMEN[feld] || feld;
  merkeVorzustand(lead, { [feld]: neu }, "Änderung an " + beschriftung);
  await schreibe({ [feld]: neu });
}

async function schnellaktion(welche) {
  const lead = state.offen;
  if (!lead) return;
  const aenderung = {};

  if (welche === "angerufen") {
    aenderung.letzter_kontakt_am = heute();
    aenderung.anzahl_kontakte = (lead.anzahl_kontakte || 0) + 1;
    aenderung.kontaktkanal = lead.kontaktkanal || "Telefon";
    if (!lead.kontaktiert_am) aenderung.kontaktiert_am = heute();
    if (lead.status === "Neu" || lead.status === "Recherchiert") aenderung.status = "Kontaktiert";
    if (!lead.bearbeiter) aenderung.bearbeiter = state.profil.id;
  } else if (welche === "erreicht") {
    aenderung.status = "Follow-up";
    aenderung.letzter_kontakt_am = heute();
    const in7 = new Date(); in7.setDate(in7.getDate() + 7);
    aenderung.wiedervorlage_am = in7.toISOString().slice(0, 10);
    if (!lead.bearbeiter) aenderung.bearbeiter = state.profil.id;
  } else if (welche === "mir") {
    aenderung.bearbeiter = state.profil.id;
  } else if (welche === "plus7") {
    const basis = lead.wiedervorlage_am ? new Date(lead.wiedervorlage_am) : new Date();
    basis.setDate(basis.getDate() + 7);
    aenderung.wiedervorlage_am = basis.toISOString().slice(0, 10);
  }

  const LABELS = {
    angerufen: "Angerufen",
    erreicht: "Erreicht, Follow-up",
    mir: "Mir zuweisen",
    plus7: "Wiedervorlage +7 Tage",
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

  const { data, error } = await sb
    .from("leads")
    .update({ ...aenderung, geaendert_von: state.profil.id })
    .eq("id", lead.id)
    .select()
    .single();

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
  zeichneQuick();   // lässt den Rückgängig-Knopf erscheinen bzw. verschwinden
  ladeVerlauf(lead.id);
}

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
};

async function ladeVerlauf(leadId) {
  const { data, error } = await sb
    .from("aktivitaet")
    .select("feld, alt, neu, zeit, benutzer")
    .eq("lead_id", leadId)
    .order("zeit", { ascending: false })
    .limit(40);

  const ziel = el("d-log");
  if (error) { ziel.innerHTML = `<p class="note err">${esc(error.message)}</p>`; return; }
  if (!data.length) { ziel.innerHTML = '<p class="note">Noch keine Änderungen.</p>'; return; }

  ziel.innerHTML = data.map((a) => {
    const wer = state.team.find((t) => t.id === a.benutzer)?.name || "jemand";
    const feld = FELDNAMEN[a.feld] || a.feld;
    let wert = a.neu || "leer";
    if (a.feld === "bearbeiter") {
      wert = state.team.find((t) => t.id === a.neu)?.name || "nicht zugeordnet";
    }
    if (wert.length > 80) wert = wert.slice(0, 80) + "…";
    return `<div class="log-row">
      <span class="when">${esc(zeitDe(a.zeit))}</span>
      <span class="what">${esc(wer)}: ${esc(feld)} → <b>${esc(wert)}</b></span>
    </div>`;
  }).join("");
}

/* ------------------------------------------------------------------ Start */

sb.auth.onAuthStateChange((ereignis) => {
  if (ereignis === "SIGNED_IN" && el("app").hidden) start();
  if (ereignis === "SIGNED_OUT") zeigeGate();
});

start();
