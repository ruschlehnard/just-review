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
    t !== null && t <= 0 && !ERLEDIGT.has(l.status)
      ? `<span class="tag due">${t === 0 ? "heute fällig" : `${-t} T überfällig`}</span>` : "",
  ].filter(Boolean).join("");
}

function kontaktZellen(l) {
  return `
    ${l.telefon ? `<a class="tel" href="tel:${esc(l.telefon)}" onclick="event.stopPropagation()">${esc(l.telefon)}</a>`
      : '<span class="dot">T</span>'}
    ${l.email ? `<a class="dot on" href="mailto:${esc(l.email)}" title="${esc(l.email)}" onclick="event.stopPropagation()">@</a>` : ""}
    ${l.website ? `<a class="dot on" href="${esc(l.website)}" target="_blank" rel="noopener noreferrer" title="${esc(l.website)}" onclick="event.stopPropagation()">W</a>` : ""}
    ${l.google_profil_link ? `<a class="dot on" href="${esc(l.google_profil_link)}" target="_blank" rel="noopener noreferrer" title="Google-Profil" onclick="event.stopPropagation()">G</a>` : ""}`;
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
      <td class="stripe"><i></i></td>
      <td class="klick zelle-name">
        <span class="nm">${esc(l.firmenname) || '<span class="sub">ohne Firmenname</span>'}</span>
        ${marken(l) ? `<div class="tags">${marken(l)}</div>` : ""}
        <div class="sub">${esc(l.branche)}${l.strasse ? " · " + esc(l.strasse) : ""}</div>
      </td>
      <td class="klick" data-label="Ort">${esc(l.ort)}<div class="sub mono">${esc(l.plz)}</div></td>
      <td class="klick" data-label="Status"><span class="status" data-s="${esc(l.status)}">${esc(l.status)}</span></td>
      <td class="klick" data-label="Bearbeiter">${esc(l.bearbeiter_name) || '<span class="sub">—</span>'}</td>
      <td class="klick mono" data-label="Letzter Kontakt">${datumDe(l.letzter_kontakt_am) || '<span class="sub">nie</span>'}${
        l.anzahl_kontakte ? `<div class="sub">${l.anzahl_kontakte}× Kontakt</div>` : ""}</td>
      <td class="klick mono" data-label="Wiedervorlage">${datumDe(l.wiedervorlage_am) || '<span class="sub">—</span>'}</td>
      <td class="zelle-kontakt">${kontaktZellen(l)}</td>
    </tr>`).join("");

  el("tb").querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelectorAll("td.klick").forEach((td) => { td.onclick = () => oeffne(id); });
    tr.querySelector("td.pick input").onchange = (e) => waehle(id, e.target.checked);
  });

  const alleGewaehlt = rows.length > 0 && rows.every((l) => state.auswahl.has(l.id));
  el("pick-all").checked = alleGewaehlt;
  el("pick-all").indeterminate = !alleGewaehlt && rows.some((l) => state.auswahl.has(l.id));
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

el("views").querySelectorAll(".view-btn").forEach((b) => {
  b.onclick = () => {
    state.view = b.dataset.view;
    el("views").querySelectorAll(".view-btn").forEach((o) =>
      o.setAttribute("aria-pressed", String(o === b)));
    zeichne();
  };
});

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
  produktinteresse: "Produktinteresse",
};

/** Das Protokoll speichert alles als Text. Fürs Zurückschreiben muss daraus
 *  wieder der Typ der Spalte werden, sonst lehnt PostgREST ab. */
const FELD_TYP = Object.fromEntries(FELDER.flatMap((g) => g.felder.map((f) => [f.k, f.typ])));

function wertAusText(feld, text) {
  const typ = FELD_TYP[feld];
  const leer = text === null || text === undefined || text === "";
  if (typ === "zahl") return leer ? null : Number(text);
  if (typ === "datum") return leer ? null : text;
  if (typ === "janein") return leer ? null : text === "true";
  if (typ === "team") return leer ? null : text;
  return leer ? "" : text;
}

function verlaufWert(feld, roh) {
  if (roh === null || roh === undefined || roh === "") return "leer";
  if (feld === "bearbeiter") return state.team.find((t) => t.id === roh)?.name || "nicht zugeordnet";
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
  if (ereignis === "SIGNED_IN" && el("app").hidden) start();
  if (ereignis === "SIGNED_OUT") zeigeGate();
});

start();
