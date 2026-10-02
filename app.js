import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { ABTEILUNGEN, abteilungRaten, zutatParsen, mengeSkalieren, mengenZusammen, norm } from './logik.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');
const toastEl = document.getElementById('toast');

const state = {
  session: null,
  haushalt: null,
  kategorien: [],
  gerichte: [],
  plan: [],
  zutaten: [],
  einkauf: [],
  artikel: [],
  mitglieder: [],
  bildUrls: new Map(),
  push: null,
  offline: false,
  tab: localGet('tab') || 'plan',
  weekStart: mondayOf(new Date()),
  filterKat: null,
  suche: '',
  channel: null,
};

/* ---------- Hilfsfunktionen ---------- */

function localGet(k) { try { return localStorage.getItem('menu.' + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem('menu.' + k, v); } catch { /* egal */ } }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function mondayOf(d) { const r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); return r; }
const todayIso = () => iso(new Date());
const plusTage = (isoDatum, n) => iso(addDays(parseIso(isoDatum), n));
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WT_LANG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const fmtKurz = (d) => `${d.getDate()}. ${MON[d.getMonth()]}`;
const tagText = (isoDatum) => { const d = parseIso(isoDatum); return `${WT_LANG[d.getDay()]}, ${fmtKurz(d)}`; };
function kw(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}
function tageSeit(isoDatum) {
  return Math.round((parseIso(todayIso()) - parseIso(isoDatum)) / 86400000);
}
function seitText(isoDatum) {
  if (!isoDatum) return 'noch nie';
  const n = tageSeit(isoDatum);
  if (n === 0) return 'heute';
  if (n === 1) return 'gestern';
  if (n < 14) return `vor ${n} Tagen`;
  if (n < 60) return `vor ${Math.round(n / 7)} Wochen`;
  return `vor ${Math.round(n / 30)} Monaten`;
}

function toast(msg, aktionen = []) {
  toastEl.innerHTML = `<span>${esc(msg)}</span>${aktionen.map((a, i) => `<button class="toast-btn" data-i="${i}">${esc(a.label)}</button>`).join('')}`;
  toastEl.hidden = false;
  toastEl.onclick = (ev) => {
    const b = ev.target.closest('.toast-btn');
    if (!b) return;
    toastEl.hidden = true;
    aktionen[Number(b.dataset.i)].fn();
  };
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, aktionen.length ? 6000 : 2600);
}

const istNetzFehler = (e) => !navigator.onLine || /fetch|network|load failed|netzwerk/i.test(e?.message || '');

function fehler(e) {
  console.error(e);
  toast(istNetzFehler(e) ? 'Keine Verbindung – bitte später nochmals versuchen.' : 'Fehler: ' + (e?.message || e));
}

async function db(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

const meineId = () => state.session?.user?.id;
const katById = (id) => state.kategorien.find((k) => k.id === id);
const gerichtById = (id) => state.gerichte.find((g) => g.id === id);
const zutatenVon = (gid) => state.zutaten.filter((z) => z.gericht_id === gid);
const istDessert = (g) => norm(katById(g.kategorie_id)?.name).startsWith('dessert');
const sortierePlan = () => state.plan.sort((a, b) => a.datum.localeCompare(b.datum) || a.erstellt_am.localeCompare(b.erstellt_am));

const WANN = { immer: 'Immer', woche: 'Unter der Woche', wochenende: 'Wochenende' };
const WANN_KURZ = { woche: 'Woche', wochenende: 'WE' };
const istWochenende = (datum) => [0, 6].includes(parseIso(datum).getDay());
const tagTyp = (datum) => (istWochenende(datum) ? 'wochenende' : 'woche');
const passtZuTag = (g, datum) => !g.wann || g.wann === 'immer' || g.wann === tagTyp(datum);
const istSchnell = (g) => g.kochzeit && g.kochzeit <= 30;

/** Statistik pro Gericht: wann zuletzt gekocht, wie oft, Bewertungssumme. */
function statistik() {
  const heute = todayIso();
  const byName = new Map(state.gerichte.map((g) => [norm(g.name), g.id]));
  const stats = new Map();
  for (const p of state.plan) {
    if (p.datum > heute || p.reste) continue;
    const gid = p.gericht_id || byName.get(norm(p.titel));
    if (!gid) continue;
    const s = stats.get(gid) || { zuletzt: null, anzahl: 0, bewertung: 0 };
    s.anzahl++;
    s.bewertung += p.bewertung || 0;
    if (!s.zuletzt || p.datum > s.zuletzt) s.zuletzt = p.datum;
    stats.set(gid, s);
  }
  return stats;
}

function farbeFuerEintrag(p) {
  const g = p.gericht_id && gerichtById(p.gericht_id);
  const k = g && katById(g.kategorie_id);
  return k ? k.farbe : null;
}

/* ---------- Artikel-Katalog (Abteilung, Vorrat) ---------- */

const artikelInfo = (name) => state.artikel.find((a) => a.name_norm === norm(name));
const abteilungVon = (name) => artikelInfo(name)?.abteilung || abteilungRaten(name);
const istVorrat = (name) => !!artikelInfo(name)?.vorrat;

async function artikelSetzen(name, aenderung) {
  const row = { haushalt_id: state.haushalt.id, name_norm: norm(name), name: name.trim(), ...aenderung, geaendert_am: new Date().toISOString() };
  const alt = artikelInfo(name);
  if (alt) Object.assign(alt, row); else state.artikel.push(row);
  await db(sb.from('menu_artikel').upsert(row, { onConflict: 'haushalt_id,name_norm' }));
}

/* ---------- Mitglieder ---------- */

const MITGLIED_FARBEN = ['#1f6f5c', '#c2410c', '#7c3aed', '#0369a1'];
function mitgliedName(uid) {
  const m = state.mitglieder.find((x) => x.user_id === uid);
  return m?.anzeigename || (uid === meineId() ? 'Ich' : 'Partner/in');
}
function mitgliedBadge(uid) {
  if (!uid) return '';
  const i = Math.max(0, state.mitglieder.findIndex((x) => x.user_id === uid));
  const name = mitgliedName(uid);
  return `<span class="koch" style="background:${MITGLIED_FARBEN[i % MITGLIED_FARBEN.length]}" title="${esc(name)} kocht">${esc(name.charAt(0).toUpperCase())}</span>`;
}

/* ---------- Auth & Laden ---------- */

sb.auth.onAuthStateChange((event, session) => {
  const vorher = state.session?.user?.id;
  state.session = session;
  if (event === 'PASSWORD_RECOVERY') { neuesPasswortSheet(); return; }
  if (event === 'INITIAL_SESSION' || (session?.user?.id || null) !== (vorher || null)) {
    // ausserhalb des Callbacks weiterarbeiten (Supabase-Empfehlung)
    setTimeout(start, 0);
  }
});

async function start() {
  if (!state.session) { renderAuth(); return; }
  try {
    const mitglied = await db(sb.from('menu_mitglieder').select('haushalt_id, menu_haushalte(*)')
      .eq('user_id', state.session.user.id).order('beigetreten_am').limit(1));
    if (!mitglied.length) { renderSetup(); return; }
    state.haushalt = mitglied[0].menu_haushalte;
    await ladeAlles();
    state.offline = false;
    await warteschlangeAbarbeiten();
    abonnieren();
    render();
    if (state.tab === 'plan') document.querySelector('.day.today')?.scrollIntoView({ block: 'center' });
    eigenenNamenSicherstellen();
    pushStatusLaden();
  } catch (e) {
    // Ohne Verbindung mit den zuletzt gespeicherten Daten starten
    if (istNetzFehler(e) && cacheLaden()) {
      state.offline = true;
      render();
      return;
    }
    app.innerHTML = `<div class="center"><div><p>Daten konnten nicht geladen werden.</p><p class="muted small">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Neu laden</button></div></div>`;
  }
}

const TABELLEN = ['menu_kategorien', 'menu_gerichte', 'menu_plan', 'menu_zutaten', 'menu_einkauf', 'menu_artikel', 'menu_mitglieder'];

async function ladeTabelle(name) {
  const hid = state.haushalt.id;
  const q = sb.from(name).select('*').eq('haushalt_id', hid);
  if (name === 'menu_kategorien') state.kategorien = await db(q.order('sortierung').order('name'));
  if (name === 'menu_gerichte') { state.gerichte = await db(q.order('name')); bilderLaden(); }
  if (name === 'menu_plan') state.plan = await db(q.order('datum').order('erstellt_am'));
  if (name === 'menu_zutaten') state.zutaten = await db(q.order('sortierung').order('erstellt_am'));
  if (name === 'menu_einkauf') { state.einkauf = await db(q.order('erstellt_am')); warteschlangeAnwenden(); }
  if (name === 'menu_artikel') state.artikel = await db(q);
  if (name === 'menu_mitglieder') state.mitglieder = await db(q.order('beigetreten_am'));
  cacheSpeichern();
}

async function ladeAlles() {
  await Promise.all(TABELLEN.map(ladeTabelle));
}

function abonnieren() {
  if (state.channel) sb.removeChannel(state.channel);
  const hid = state.haushalt.id;
  const ch = sb.channel('menu-' + hid);
  const timer = {};
  for (const table of TABELLEN) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `haushalt_id=eq.${hid}` }, () => {
      clearTimeout(timer[table]);
      timer[table] = setTimeout(async () => {
        try { await ladeTabelle(table); render(); } catch (e) { console.error(e); }
      }, 250);
    });
  }
  ch.subscribe();
  state.channel = ch;
}

// Beim Zurückkehren in die App (z.B. Handy entsperrt) Daten auffrischen
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.haushalt) {
    try { await warteschlangeAbarbeiten(); await ladeAlles(); state.offline = false; render(); } catch (e) { console.error(e); }
  }
});

async function eigenenNamenSicherstellen() {
  const ich = state.mitglieder.find((m) => m.user_id === meineId());
  if (!ich || ich.anzeigename) return;
  const vorschlag = (state.session.user.email || 'Ich').split('@')[0].split(/[._-]/)[0];
  const name = vorschlag.charAt(0).toUpperCase() + vorschlag.slice(1);
  try {
    await db(sb.from('menu_mitglieder').update({ anzeigename: name }).eq('haushalt_id', state.haushalt.id).eq('user_id', meineId()));
    ich.anzeigename = name;
  } catch (e) { console.error(e); }
}

/* ---------- Bilder ---------- */

async function bilderLaden() {
  const pfade = state.gerichte.map((g) => g.bild_pfad).filter((p) => p && !state.bildUrls.has(p));
  if (!pfade.length) return;
  try {
    const { data } = await sb.storage.from('menu-bilder').createSignedUrls(pfade, 60 * 60 * 24 * 7);
    for (const x of data || []) if (x.signedUrl) state.bildUrls.set(x.path, x.signedUrl);
    render();
  } catch (e) { console.error(e); }
}
const bildVon = (g) => (g.bild_pfad && state.bildUrls.get(g.bild_pfad)) || g.bild_url || null;

async function bildVerkleinern(file, max = 1200) {
  const bmp = await createImageBitmap(file);
  const f = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * f);
  c.height = Math.round(bmp.height * f);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

/* ---------- Offline: Zwischenspeicher & Warteschlange für die Einkaufsliste ---------- */

function cacheSpeichern() {
  if (!state.haushalt) return;
  const { haushalt, kategorien, gerichte, plan, zutaten, einkauf, artikel, mitglieder } = state;
  localSet('cache', JSON.stringify({ user: meineId(), haushalt, kategorien, gerichte, plan, zutaten, einkauf, artikel, mitglieder }));
}
function cacheLaden() {
  try {
    const c = JSON.parse(localGet('cache') || 'null');
    if (!c || c.user !== meineId()) return false;
    Object.assign(state, { haushalt: c.haushalt, kategorien: c.kategorien, gerichte: c.gerichte, plan: c.plan, zutaten: c.zutaten, einkauf: c.einkauf, artikel: c.artikel || [], mitglieder: c.mitglieder || [] });
    warteschlangeAnwenden();
    return true;
  } catch { return false; }
}
const warteschlange = () => { try { return JSON.parse(localGet('queue') || '[]'); } catch { return []; } };
const warteschlangeSetzen = (q) => localSet('queue', JSON.stringify(q));

/** Noch nicht synchronisierte Änderungen auf die (neu geladene) Liste anwenden. */
function warteschlangeAnwenden() {
  for (const op of warteschlange()) {
    if (op.typ === 'insert' && !state.einkauf.some((e) => e.id === op.row.id)) state.einkauf.push(op.row);
    if (op.typ === 'update') state.einkauf.filter((e) => op.ids.includes(e.id)).forEach((e) => Object.assign(e, op.daten));
    if (op.typ === 'delete') state.einkauf = state.einkauf.filter((e) => !op.ids.includes(e.id));
  }
}

async function einkaufAusfuehren(op) {
  if (op.typ === 'insert') await db(sb.from('menu_einkauf').upsert(op.row, { onConflict: 'id' }));
  if (op.typ === 'update') await db(sb.from('menu_einkauf').update(op.daten).in('id', op.ids));
  if (op.typ === 'delete') await db(sb.from('menu_einkauf').delete().in('id', op.ids));
}

/** Änderung an der Einkaufsliste: sofort lokal, dann Server – ohne Verbindung in die Warteschlange. */
async function einkaufAendern(op) {
  if (op.typ === 'insert') state.einkauf.push(...[].concat(op.row));
  if (op.typ === 'update') state.einkauf.filter((e) => op.ids.includes(e.id)).forEach((e) => Object.assign(e, op.daten));
  if (op.typ === 'delete') state.einkauf = state.einkauf.filter((e) => !op.ids.includes(e.id));
  render();
  cacheSpeichern();
  const ops = op.typ === 'insert' ? [].concat(op.row).map((row) => ({ typ: 'insert', row })) : [op];
  if (warteschlange().length || !navigator.onLine) { warteschlangeSetzen([...warteschlange(), ...ops]); state.offline = true; render(); return; }
  try {
    for (const o of ops) await einkaufAusfuehren(o);
  } catch (e) {
    if (!istNetzFehler(e)) { fehler(e); return; }
    warteschlangeSetzen([...warteschlange(), ...ops]);
    state.offline = true;
    render();
  }
}

let syncLaeuft = false;
async function warteschlangeAbarbeiten() {
  if (syncLaeuft || !navigator.onLine) return;
  syncLaeuft = true;
  try {
    let q = warteschlange();
    while (q.length) {
      await einkaufAusfuehren(q[0]);
      q = q.slice(1);
      warteschlangeSetzen(q);
    }
    if (state.offline) { state.offline = false; toast('Wieder online – Einkaufsliste synchronisiert.'); }
  } catch (e) {
    if (!istNetzFehler(e)) { warteschlangeSetzen([]); fehler(e); }
  } finally {
    syncLaeuft = false;
  }
}
window.addEventListener('online', async () => {
  if (!state.haushalt) return;
  await warteschlangeAbarbeiten();
  try { await ladeAlles(); state.offline = false; render(); } catch (e) { console.error(e); }
});
window.addEventListener('offline', () => { if (state.haushalt) { state.offline = true; render(); } });

/* ---------- Login ---------- */

function renderAuth(modus = 'login', meldung = '') {
  const reg = modus === 'register';
  app.innerHTML = `
    <div class="auth">
      <img class="logo" src="icon.svg" alt="">
      <h1>Menüplan</h1>
      <p class="muted">${reg ? 'Konto erstellen' : 'Anmelden, um euren gemeinsamen Menüplan zu sehen.'}</p>
      <form id="auth-form" class="card panel">
        <div class="field"><label for="email">E-Mail</label><input class="input" id="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="pw">Passwort</label><input class="input" id="pw" type="password" minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
        ${meldung ? `<div class="err">${esc(meldung)}</div>` : ''}
        <button class="btn primary block" type="submit">${reg ? 'Registrieren' : 'Anmelden'}</button>
        <div class="row" style="justify-content:space-between;margin-top:12px">
          <button class="btn ghost small" type="button" id="auth-switch">${reg ? 'Schon ein Konto? Anmelden' : 'Neues Konto erstellen'}</button>
          ${reg ? '' : '<button class="btn ghost small" type="button" id="auth-reset">Passwort vergessen?</button>'}
        </div>
      </form>
    </div>`;
  const form = document.getElementById('auth-form');
  document.getElementById('auth-switch').onclick = () => renderAuth(reg ? 'login' : 'register');
  const reset = document.getElementById('auth-reset');
  if (reset) reset.onclick = async () => {
    const email = form.email.value.trim();
    if (!email) { renderAuth('login', 'Bitte zuerst die E-Mail eingeben.'); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    toast(error ? error.message : 'E-Mail zum Zurücksetzen wurde gesendet.');
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const email = form.email.value.trim();
    const password = form.pw.value;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    if (reg) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
      if (error) { renderAuth('register', error.message); return; }
      if (!data.session) renderAuth('login', 'Fast geschafft: Bitte den Link in der Bestätigungs-E-Mail öffnen und dann hier anmelden.');
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) renderAuth('login', error.message === 'Invalid login credentials' ? 'E-Mail oder Passwort falsch.' : error.message);
    }
  };
}

const appUrl = () => location.origin + location.pathname;

function neuesPasswortSheet() {
  openSheet({
    titel: 'Neues Passwort',
    body: `<div class="field"><label>Neues Passwort</label><input class="input" id="np" type="password" minlength="6" autocomplete="new-password"></div>`,
    foot: `<span class="spacer"></span><button class="btn primary" data-a="np-save">Speichern</button>`,
    actions: {
      'np-save': async () => {
        const { error } = await sb.auth.updateUser({ password: document.getElementById('np').value });
        if (error) { toast(error.message); return; }
        closeSheet(); toast('Passwort geändert.'); start();
      },
    },
  });
}

/* ---------- Haushalt einrichten ---------- */

function renderSetup() {
  app.innerHTML = `
    <div class="auth">
      <h1>Willkommen!</h1>
      <p class="muted">Ein Haushalt verbindet euch beide: alle Mitglieder sehen und bearbeiten dieselben Gerichte und denselben Menüplan.</p>
      <form id="join" class="card panel" style="margin-bottom:14px">
        <h3 style="margin-top:0">Haushalt beitreten</h3>
        <p class="muted small">Den Code findet deine Partnerin / dein Partner in der App unter «Mehr».</p>
        <div class="field"><input class="input code" id="code" maxlength="6" placeholder="ABC123" autocapitalize="characters" required></div>
        <button class="btn primary block">Beitreten</button>
      </form>
      <form id="create" class="card panel">
        <h3 style="margin-top:0">Neuen Haushalt erstellen</h3>
        <div class="field"><label for="hname">Name</label><input class="input" id="hname" value="Unser Haushalt"></div>
        <label class="check"><input type="checkbox" id="seed" checked> Gerichte & Menüplan aus unseren bisherigen Notizen übernehmen</label>
        <button class="btn block">Erstellen</button>
      </form>
      <p style="text-align:center"><button class="btn ghost small" id="logout">Abmelden (${esc(state.session.user.email)})</button></p>
    </div>`;
  document.getElementById('logout').onclick = () => sb.auth.signOut();
  document.getElementById('join').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await db(sb.rpc('menu_haushalt_beitreten', { p_code: ev.target.code.value })); start(); }
    catch (e) { toast(e.message.includes('Ungültig') ? 'Dieser Code ist ungültig.' : e.message); }
  };
  document.getElementById('create').onsubmit = async (ev) => {
    ev.preventDefault();
    if (ev.submitter) ev.submitter.disabled = true;
    try {
      await db(sb.rpc('menu_haushalt_erstellen', { p_name: ev.target.hname.value, p_mit_startdaten: ev.target.seed.checked }));
      start();
    } catch (e) { fehler(e); }
  };
}

/* ---------- Hauptansicht ---------- */

function render() {
  if (!state.haushalt) return;
  if (drag) return; // während dem Verschieben nicht neu zeichnen
  // Eingaben, Fokus und Scroll-Position über das Neuzeichnen hinweg erhalten
  const aktivId = document.activeElement?.id;
  const caret = aktivId && document.activeElement.selectionStart;
  const werte = Object.fromEntries(['ek-name', 'ek-menge', 'vorrat-neu'].map((id) => [id, document.getElementById(id)?.value || '']));
  const scroll = window.scrollY;

  const titel = { plan: 'Menüplan', gerichte: 'Gerichte', einkauf: 'Einkaufsliste', einstellungen: 'Mehr' }[state.tab];
  let inhalt = '';
  if (state.tab === 'plan') inhalt = viewPlan();
  if (state.tab === 'gerichte') inhalt = viewGerichte();
  if (state.tab === 'einkauf') inhalt = viewEinkauf();
  if (state.tab === 'einstellungen') inhalt = viewEinstellungen();

  const offen = offeneArtikel();
  app.innerHTML = `
    <div class="shell">
      ${state.offline ? `<div class="offline-banner">📴 Offline – Einkaufsliste funktioniert, Änderungen werden später synchronisiert.${warteschlange().length ? ` (${warteschlange().length} ausstehend)` : ''}</div>` : ''}
      <header class="topbar"><h1>${titel}</h1>
        ${installPrompt && !istInstalliert() ? '<button class="btn" data-a="installieren">📲 App</button>' : ''}
        ${state.tab === 'plan' ? '<button class="btn" data-a="zufall">🎲 Vorschlag</button>' : ''}
      </header>
      ${inhalt}
    </div>
    ${state.tab === 'gerichte' ? '<button class="fab" data-a="gericht-neu" aria-label="Neues Gericht">+</button>' : ''}
    <nav class="tabbar">
      ${[['plan', '📅', 'Plan'], ['gerichte', '📖', 'Gerichte'], ['einkauf', '🛒', 'Einkauf'], ['einstellungen', '⚙️', 'Mehr']]
        .map(([t, i, l]) => `<button data-a="tab" data-tab="${t}" class="${state.tab === t ? 'active' : ''}"><span class="ico">${i}${t === 'einkauf' && offen ? `<span class="tab-badge">${offen}</span>` : ''}</span>${l}</button>`).join('')}
    </nav>`;

  for (const [id, wert] of Object.entries(werte)) { const el = document.getElementById(id); if (el && wert) el.value = wert; }
  const fokus = aktivId && ['suche', 'ek-name', 'ek-menge', 'vorrat-neu'].includes(aktivId) && document.getElementById(aktivId);
  if (fokus) {
    fokus.focus();
    if (caret != null) fokus.setSelectionRange(caret, caret);
  }
  window.scrollTo(0, scroll);
}

function eintragZeile(p) {
  const farbe = farbeFuerEintrag(p);
  const g = p.gericht_id && gerichtById(p.gericht_id);
  const extras = [
    p.reste ? '<span class="tag">🍲 Reste</span>' : '',
    p.bewertung === 1 ? '👍' : p.bewertung === -1 ? '👎' : '',
    g && g.kochzeit ? `<span class="tag">⏱ ${g.kochzeit}'</span>` : '',
  ].filter(Boolean).join(' ');
  return `<li class="entry ${p.erledigt ? 'done' : ''}" data-id="${p.id}">
    <span class="grip" aria-label="Verschieben" title="Gedrückt halten und auf einen anderen Tag ziehen">⠿</span>
    <button class="cb" data-a="toggle" data-id="${p.id}" aria-label="Erledigt">✓</button>
    <span class="dot" style="${farbe ? `background:${esc(farbe)}` : ''}"></span>
    <button class="title" data-a="eintrag" data-id="${p.id}">${esc(p.titel)} ${extras}${p.notiz ? `<span class="note">${esc(p.notiz)}</span>` : ''}</button>
    ${mitgliedBadge(p.koch_user)}
  </li>`;
}

function viewPlan() {
  const start = state.weekStart;
  const ende = addDays(start, 6);
  const heute = todayIso();
  const istAktuelleWoche = iso(mondayOf(new Date())) === iso(start);
  let tage = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const ds = iso(d);
    const eintraege = state.plan.filter((p) => p.datum === ds);
    tage += `
      <div class="card day ${ds === heute ? 'today' : ''}" data-datum="${ds}">
        <div class="day-head">
          <span class="wd">${WT[d.getDay()]}</span>
          <span class="dt">${fmtKurz(d)}</span>
          ${ds === heute ? '<span class="badge">Heute</span>' : ''}
        </div>
        <ul class="entries">${eintraege.map(eintragZeile).join('')}</ul>
        <button class="add-entry" data-a="hinzu" data-datum="${ds}">+ ${eintraege.length ? 'weiteres Gericht' : 'Gericht planen'}</button>
      </div>`;
  }
  return `
    <div class="weeknav">
      <button class="btn icon" data-a="woche" data-d="-7" aria-label="Vorherige Woche">‹</button>
      <div class="label">${fmtKurz(start)} – ${fmtKurz(ende)} ${ende.getFullYear()}<div class="muted small">KW ${kw(start)}</div></div>
      <button class="btn icon" data-a="woche" data-d="7" aria-label="Nächste Woche">›</button>
    </div>
    <div class="row" style="justify-content:center;margin:-4px 0 12px;flex-wrap:wrap">
      ${istAktuelleWoche ? '' : '<button class="btn small" data-a="heute">Aktuelle Woche</button>'}
      <button class="btn small" data-a="woche-auto">🎲 Woche füllen</button>
      <button class="btn small" data-a="woche-menu">⋯ Mehr</button>
    </div>
    ${tage}`;
}

function gerichtTags(g, stats) {
  const s = stats.get(g.id);
  return [
    WANN_KURZ[g.wann] ? `<span class="tag ${g.wann}">${WANN_KURZ[g.wann]}</span>` : '',
    g.kochzeit ? `<span class="tag">⏱ ${g.kochzeit}'</span>` : '',
    zutatenVon(g.id).length ? '<span class="tag">🛒</span>' : '',
    s && s.bewertung > 0 ? `<span class="tag gut">👍 ${s.bewertung}</span>` : '',
    s && s.bewertung < 0 ? `<span class="tag">👎 ${-s.bewertung}</span>` : '',
  ].join(' ');
}

function viewGerichte() {
  const stats = statistik();
  const q = norm(state.suche);
  const f = state.filterKat;
  const treffer = state.gerichte.filter((g) =>
    (!f || g.kategorie_id === f || (f === 'fav' && g.favorit) || (f === 'schnell' && istSchnell(g)) ||
      (['woche', 'wochenende'].includes(f) && g.wann === f)) &&
    (!q || norm(g.name).includes(q) || norm(g.notiz).includes(q) || zutatenVon(g.id).some((z) => norm(z.name).includes(q))));

  const gruppen = [...state.kategorien, { id: null, name: 'Ohne Kategorie', farbe: '#999' }]
    .map((k) => ({ k, items: treffer.filter((g) => (g.kategorie_id || null) === k.id) }))
    .filter((x) => x.items.length);

  const chip = (k, label) => `<button class="chip ${(f || '') === k ? 'active' : ''}" data-a="filter" data-k="${k}">${label}</button>`;
  const chips = [
    chip('', `Alle (${state.gerichte.length})`), chip('fav', '★ Favoriten'), chip('schnell', '⏱ Schnell'),
    chip('woche', 'Unter der Woche'), chip('wochenende', 'Wochenende'),
    ...state.kategorien.map((k) => chip(k.id, `<span class="dot" style="background:${esc(k.farbe)}"></span>${esc(k.name)}`)),
  ].join('');

  return `
    <div class="search"><input class="input" id="suche" type="search" placeholder="Gericht oder Zutat suchen …" value="${esc(state.suche)}" autocomplete="off"></div>
    <div class="chips">${chips}</div>
    ${gruppen.length ? gruppen.map(({ k, items }) => `
      <div class="cat-title"><span class="dot" style="background:${esc(k.farbe)}"></span>${esc(k.name)} <span class="count">${items.length}</span></div>
      <ul class="dish-list card">
        ${items.map((g) => {
          const s = stats.get(g.id);
          const bild = bildVon(g);
          return `<li><button class="dish" data-a="gericht" data-id="${g.id}">
            ${bild ? `<img class="thumb" src="${esc(bild)}" alt="" loading="lazy">` : ''}
            <span class="name">${g.favorit ? '<span class="fav">★</span> ' : ''}${esc(g.name)} ${gerichtTags(g, stats)}</span>
            <span class="meta">${s ? seitText(s.zuletzt) : ''}</span>
          </button></li>`;
        }).join('')}
      </ul>`).join('') : `<div class="empty">Keine Gerichte gefunden.${q ? `<br><br><button class="btn" data-a="gericht-neu" data-name="${esc(state.suche)}">«${esc(state.suche)}» hinzufügen</button>` : ''}</div>`}`;
}

const offeneArtikel = () => new Set(state.einkauf.filter((e) => !e.erledigt).map((e) => norm(e.name))).size;

/** Einkaufsliste: gleiche Artikel zusammenfassen und nach Abteilungen gruppieren. */
function einkaufGruppen(liste) {
  const map = new Map();
  for (const e of liste) {
    const k = norm(e.name);
    if (!map.has(k)) map.set(k, { key: k, name: e.name, eintraege: [] });
    map.get(k).eintraege.push(e);
  }
  return [...map.values()].map((g) => ({
    ...g,
    ids: g.eintraege.map((e) => e.id),
    menge: mengenZusammen(g.eintraege.map((e) => e.menge)),
    quellen: [...new Set(g.eintraege.map((e) => e.quelle).filter(Boolean))],
    abteilung: abteilungVon(g.name),
  }));
}

function viewEinkauf() {
  const offen = einkaufGruppen(state.einkauf.filter((e) => !e.erledigt));
  const erledigt = einkaufGruppen(state.einkauf.filter((e) => e.erledigt));
  const zeile = (g, done) => `<li class="ek ${done ? 'done' : ''}">
      <button class="cb" data-a="ek-toggle" data-ids="${g.ids.join(',')}" data-wert="${done ? '0' : '1'}" aria-label="Gekauft">✓</button>
      <button class="title" data-a="ek-bearbeiten" data-key="${esc(g.key)}">${esc(g.name)}${g.menge ? ` <span class="muted">· ${esc(g.menge)}</span>` : ''}${g.eintraege.length > 1 && !g.menge ? ` <span class="muted">· ${g.eintraege.length}×</span>` : ''}${g.quellen.length ? `<span class="note">${esc(g.quellen.join(' · '))}</span>` : ''}</button>
      <button class="btn icon ghost" data-a="ek-weg" data-ids="${g.ids.join(',')}" aria-label="Entfernen">✕</button>
    </li>`;
  const abschnitte = ABTEILUNGEN.map((a) => ({ a, items: offen.filter((g) => g.abteilung === a.id) })).filter((x) => x.items.length);
  return `
    <form class="row" id="ek-form" style="margin-bottom:12px">
      <input class="input grow" id="ek-name" placeholder="Artikel hinzufügen …" autocomplete="off" enterkeyhint="done" list="artikel-vorschlaege">
      <input class="input menge" id="ek-menge" placeholder="Menge" autocomplete="off" enterkeyhint="done">
      <button class="btn primary icon" aria-label="Hinzufügen">＋</button>
    </form>
    <datalist id="artikel-vorschlaege">${state.artikel.map((a) => `<option value="${esc(a.name)}">`).join('')}</datalist>
    ${abschnitte.length ? abschnitte.map(({ a, items }) => `
      <div class="cat-title">${a.icon} ${esc(a.name)} <span class="count">${items.length}</span></div>
      <ul class="ek-list card">${items.map((g) => zeile(g, false)).join('')}</ul>`).join('')
      : '<div class="empty">Der Warenkorb ist leer.<br><span class="small">Beim Einplanen eines Gerichts mit Zutaten könnt ihr diese hier hinzufügen.</span></div>'}
    ${erledigt.length ? `
      <div class="cat-title">✅ Im Korb <span class="count">${erledigt.length}</span><span style="flex:1"></span><button class="btn small" data-a="ek-aufraeumen">Entfernen</button></div>
      <ul class="ek-list card">${erledigt.map((g) => zeile(g, true)).join('')}</ul>` : ''}`;
}

function viewEinstellungen() {
  const h = state.haushalt;
  const ich = state.mitglieder.find((m) => m.user_id === meineId());
  const vorrat = state.artikel.filter((a) => a.vorrat).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return `
    <div class="settings">
      <section class="card panel">
        <h2>Haushalt</h2>
        <div class="row"><input class="input grow" id="hname" value="${esc(h.name)}"><button class="btn" data-a="hname">Speichern</button></div>
        <div class="field" style="margin:12px 0 0"><label for="mein-name">Dein Name (für «Wer kocht?»)</label>
          <div class="row"><input class="input grow" id="mein-name" value="${esc(ich?.anzeigename || '')}"><button class="btn" data-a="mein-name">Speichern</button></div>
        </div>
        <p class="muted small" style="margin-bottom:0">Mitglieder: ${state.mitglieder.map((m) => esc(m.anzeigename || '…')).join(', ')}</p>
      </section>
      <section class="card panel">
        <h2>Partnerin / Partner einladen</h2>
        <p class="muted small" style="margin-top:0">Sie/er registriert sich in der App und gibt diesen Code unter «Haushalt beitreten» ein. Danach seht ihr beide dieselben Daten.</p>
        <div class="row"><span class="code grow">${esc(h.beitrittscode)}</span><button class="btn" data-a="teilen">Teilen</button></div>
      </section>
      ${viewPushEinstellungen()}
      <section class="card panel">
        <h2>🥫 Vorrat – «haben wir immer»</h2>
        <p class="muted small" style="margin-top:0">Diese Zutaten sind beim Einkaufen automatisch abgewählt.</p>
        <div class="chips wrap">${vorrat.map((a) => `<button class="chip" data-a="vorrat-weg" data-key="${esc(a.name_norm)}">${esc(a.name)} ✕</button>`).join('') || '<span class="muted small">Noch nichts erfasst.</span>'}</div>
        <form class="row" id="vorrat-form" style="margin-top:8px">
          <input class="input grow" id="vorrat-neu" placeholder="z.B. Salz, Öl, Reis" autocomplete="off">
          <button class="btn">Hinzufügen</button>
        </form>
      </section>
      <section class="card panel">
        <h2>📊 Statistik</h2>
        <p class="muted small" style="margin-top:0">Was esst ihr am meisten, was gab es lange nicht mehr?</p>
        <button class="btn" data-a="statistik">Statistik anzeigen</button>
      </section>
      <section class="card panel">
        <h2>Kategorien</h2>
        ${state.kategorien.map((k) => `
          <div class="cat-row">
            <input type="color" value="${esc(k.farbe)}" data-kat-farbe="${k.id}" aria-label="Farbe">
            <input class="input grow" value="${esc(k.name)}" data-kat-name="${k.id}">
            <button class="btn icon danger" data-a="kat-loeschen" data-id="${k.id}" aria-label="Löschen">🗑</button>
          </div>`).join('')}
        <div class="row" style="margin-top:12px">
          <input class="input grow" id="neue-kat" placeholder="Neue Kategorie">
          <button class="btn" data-a="kat-neu">Hinzufügen</button>
        </div>
      </section>
      ${istInstalliert() ? '' : `<section class="card panel">
        <h2>Als App installieren</h2>
        <p class="muted small" style="margin-top:0">Menüplan auf den Startbildschirm legen und wie eine App öffnen.</p>
        <button class="btn primary" data-a="installieren">📲 App installieren</button>
      </section>`}
      <section class="card panel">
        <h2>Konto</h2>
        <p class="muted small" style="margin-top:0">Angemeldet als ${esc(state.session.user.email)}</p>
        <button class="btn" data-a="logout">Abmelden</button>
      </section>
    </div>`;
}

/* ---------- Push-Erinnerungen ---------- */

const pushMoeglich = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const istIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function swBereit() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Service Worker nicht bereit')), 5000))]);
}

async function pushStatusLaden() {
  if (!pushMoeglich()) { state.push = { moeglich: false }; return; }
  try {
    const reg = await swBereit();
    const sub = await reg.pushManager.getSubscription();
    const abo = sub ? (await db(sb.from('menu_push_abos').select('*').eq('endpoint', sub.endpoint)))[0] || null : null;
    state.push = { moeglich: true, sub, abo };
  } catch (e) {
    console.warn(e);
    state.push = { moeglich: true, sub: null, abo: null };
  }
  if (state.tab === 'einstellungen') render();
}

function viewPushEinstellungen() {
  const p = state.push;
  let inhalt;
  if (!p) inhalt = '<p class="muted small">Wird geprüft …</p>';
  else if (!p.moeglich) {
    inhalt = istIos() && !istInstalliert()
      ? '<p class="muted small">Auf dem iPhone funktionieren Mitteilungen nur, wenn der Menüplan als App installiert ist (Safari → Teilen → «Zum Home-Bildschirm»). Danach die App öffnen und hier aktivieren.</p>'
      : '<p class="muted small">Dieser Browser unterstützt keine Mitteilungen.</p>';
  } else if (!p.abo) {
    inhalt = `<p class="muted small" style="margin-top:0">Täglich erinnern, was es heute gibt (und ob eingekauft ist), und sonntags, wenn die nächste Woche noch nicht geplant ist.</p>
      <button class="btn primary" data-a="push-an">🔔 Erinnerungen aktivieren</button>`;
  } else {
    const a = p.abo;
    inhalt = `
      <div class="field"><label for="push-stunde">Uhrzeit</label>
        <select class="input" id="push-stunde">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === a.stunde ? 'selected' : ''}>${String(h).padStart(2, '0')}:00 Uhr</option>`).join('')}</select>
      </div>
      <label class="check"><input type="checkbox" id="push-taeglich" ${a.taeglich ? 'checked' : ''}> Täglich: «Heute gibt es …»</label>
      <label class="check"><input type="checkbox" id="push-woche" ${a.wochenplan ? 'checked' : ''}> Sonntags: nächste Woche noch nicht geplant</label>
      <div class="row"><button class="btn" data-a="push-test">Test senden</button><span class="spacer" style="flex:1"></span><button class="btn danger" data-a="push-aus">Deaktivieren</button></div>`;
  }
  return `<section class="card panel"><h2>🔔 Erinnerungen</h2>${inhalt}</section>`;
}

function b64ZuBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushAktivieren() {
  const erlaubnis = await Notification.requestPermission();
  if (erlaubnis !== 'granted') { toast('Mitteilungen wurden nicht erlaubt (in den Handy-Einstellungen änderbar).'); return; }
  const { data, error } = await sb.functions.invoke('menu-erinnerung', { body: { modus: 'schluessel' } });
  if (error) throw error;
  const reg = await swBereit();
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ZuBytes(data.publicKey) }));
  const j = sub.toJSON();
  const abo = await db(sb.from('menu_push_abos').upsert({
    haushalt_id: state.haushalt.id, user_id: meineId(), endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
  }, { onConflict: 'endpoint' }).select().single());
  state.push = { moeglich: true, sub, abo };
  render();
  toast('Erinnerungen aktiviert.');
}

async function pushAenderung(daten) {
  const a = state.push?.abo;
  if (!a) return;
  try {
    Object.assign(a, await db(sb.from('menu_push_abos').update(daten).eq('id', a.id).select().single()));
    toast('Gespeichert.');
  } catch (e) { fehler(e); }
}

/* ---------- Aktionen Hauptansicht ---------- */

const aktionen = {
  tab: (el) => { state.tab = el.dataset.tab; localSet('tab', state.tab); window.scrollTo(0, 0); render(); },
  woche: (el) => { state.weekStart = addDays(state.weekStart, Number(el.dataset.d)); render(); },
  heute: () => { state.weekStart = mondayOf(new Date()); render(); },
  toggle: async (el) => {
    const p = state.plan.find((x) => x.id === el.dataset.id);
    p.erledigt = !p.erledigt;
    render();
    try {
      await db(sb.from('menu_plan').update({ erledigt: p.erledigt }).eq('id', p.id));
      if (p.erledigt && p.gericht_id && !p.reste && !p.bewertung) {
        toast(`Wie war «${p.titel}»?`, [
          { label: '👍', fn: () => bewerten(p, 1) },
          { label: '👎', fn: () => bewerten(p, -1) },
        ]);
      }
    } catch (e) { fehler(e); }
  },
  hinzu: (el) => pickerSheet(el.dataset.datum),
  eintrag: (el) => eintragSheet(state.plan.find((x) => x.id === el.dataset.id)),
  zufall: () => zufallSheet(),
  'woche-auto': () => autoWocheSheet(),
  'woche-menu': () => wochenMenuSheet(),
  filter: (el) => { state.filterKat = el.dataset.k || null; render(); },
  gericht: (el) => gerichtSheet(gerichtById(el.dataset.id)),
  'gericht-neu': (el) => gerichtSheet(null, el.dataset.name || state.suche),
  hname: async () => {
    const name = document.getElementById('hname').value.trim();
    if (!name) return;
    try {
      await db(sb.from('menu_haushalte').update({ name }).eq('id', state.haushalt.id));
      state.haushalt.name = name; toast('Gespeichert.');
    } catch (e) { fehler(e); }
  },
  'mein-name': async () => {
    const name = document.getElementById('mein-name').value.trim();
    if (!name) return;
    try {
      await db(sb.from('menu_mitglieder').update({ anzeigename: name }).eq('haushalt_id', state.haushalt.id).eq('user_id', meineId()));
      const ich = state.mitglieder.find((m) => m.user_id === meineId());
      if (ich) ich.anzeigename = name;
      render(); toast('Gespeichert.');
    } catch (e) { fehler(e); }
  },
  teilen: async () => {
    const text = `Tritt unserem Menüplan bei: ${appUrl()} – Beitrittscode: ${state.haushalt.beitrittscode}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Menüplan', text });
      else { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert.'); }
    } catch { /* abgebrochen */ }
  },
  'kat-neu': async () => {
    const inp = document.getElementById('neue-kat');
    const name = inp.value.trim();
    if (!name) return;
    try {
      const k = await db(sb.from('menu_kategorien').insert({
        haushalt_id: state.haushalt.id, name, sortierung: state.kategorien.length + 1, farbe: zufallsFarbe(),
      }).select().single());
      state.kategorien.push(k); render();
    } catch (e) { fehler(e); }
  },
  'kat-loeschen': async (el) => {
    const k = katById(el.dataset.id);
    const n = state.gerichte.filter((g) => g.kategorie_id === k.id).length;
    if (!confirm(`Kategorie «${k.name}» löschen?${n ? ` Die ${n} Gerichte bleiben erhalten (ohne Kategorie).` : ''}`)) return;
    try {
      await db(sb.from('menu_kategorien').delete().eq('id', k.id));
      state.kategorien = state.kategorien.filter((x) => x.id !== k.id);
      state.gerichte.forEach((g) => { if (g.kategorie_id === k.id) g.kategorie_id = null; });
      render();
    } catch (e) { fehler(e); }
  },
  'ek-toggle': (el) => einkaufAendern({ typ: 'update', ids: el.dataset.ids.split(','), daten: { erledigt: el.dataset.wert === '1' } }),
  'ek-weg': (el) => einkaufAendern({ typ: 'delete', ids: el.dataset.ids.split(',') }),
  'ek-aufraeumen': () => einkaufAendern({ typ: 'delete', ids: state.einkauf.filter((e) => e.erledigt).map((e) => e.id) }),
  'ek-bearbeiten': (el) => artikelSheet(el.dataset.key),
  'vorrat-weg': async (el) => {
    const a = state.artikel.find((x) => x.name_norm === el.dataset.key);
    try { await artikelSetzen(a.name, { vorrat: false }); render(); } catch (e) { fehler(e); }
  },
  statistik: () => statistikSheet(),
  'push-an': async () => { try { await pushAktivieren(); } catch (e) { fehler(e); } },
  'push-aus': async () => {
    try {
      const { sub, abo } = state.push;
      if (abo) await db(sb.from('menu_push_abos').delete().eq('id', abo.id));
      if (sub) await sub.unsubscribe();
      state.push = { moeglich: true, sub: null, abo: null };
      render(); toast('Erinnerungen deaktiviert.');
    } catch (e) { fehler(e); }
  },
  'push-test': async () => {
    try {
      const { data, error } = await sb.functions.invoke('menu-erinnerung', { body: { modus: 'test' } });
      if (error) throw error;
      toast(data.gesendet ? 'Test-Mitteilung gesendet.' : 'Senden fehlgeschlagen – bitte deaktivieren und neu aktivieren.');
    } catch (e) { fehler(e); }
  },
  installieren: () => installieren(),
  logout: async () => {
    if (state.channel) sb.removeChannel(state.channel);
    Object.assign(state, { haushalt: null, kategorien: [], gerichte: [], plan: [], zutaten: [], einkauf: [], artikel: [], mitglieder: [], channel: null });
    localSet('cache', '');
    warteschlangeSetzen([]);
    await sb.auth.signOut();
  },
};

function zufallsFarbe() {
  const h = Math.floor(Math.random() * 360);
  const a = 0.55 * 0.5; // Sättigung 55 %, Helligkeit 50 %
  const f = (n) => { const k = (n + h / 30) % 12;
    return Math.round(255 * (0.5 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function bewerten(p, wert) {
  try {
    p.bewertung = p.bewertung === wert ? null : wert;
    await db(sb.from('menu_plan').update({ bewertung: p.bewertung }).eq('id', p.id));
    render();
  } catch (e) { fehler(e); }
}

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el || !aktionen[el.dataset.a]) return;
  aktionen[el.dataset.a](el);
});
app.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (ev.target.id === 'ek-form') {
    const name = document.getElementById('ek-name').value.trim();
    const menge = document.getElementById('ek-menge').value.trim() || null;
    if (!name) return;
    document.getElementById('ek-name').value = '';
    document.getElementById('ek-menge').value = '';
    await einkaufAendern({ typ: 'insert', row: { id: crypto.randomUUID(), haushalt_id: state.haushalt.id, name, menge, erledigt: false, erstellt_am: new Date().toISOString() } });
    document.getElementById('ek-name')?.focus();
  }
  if (ev.target.id === 'vorrat-form') {
    const namen = document.getElementById('vorrat-neu').value.split(',').map((x) => x.trim()).filter(Boolean);
    document.getElementById('vorrat-neu').value = '';
    try { for (const n of namen) await artikelSetzen(n, { vorrat: true }); render(); } catch (e) { fehler(e); }
  }
});
app.addEventListener('input', (ev) => {
  if (ev.target.id === 'suche') { state.suche = ev.target.value; render(); }
});
app.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'push-stunde') return pushAenderung({ stunde: Number(t.value) });
  if (t.id === 'push-taeglich') return pushAenderung({ taeglich: t.checked });
  if (t.id === 'push-woche') return pushAenderung({ wochenplan: t.checked });
  const id = t.dataset.katName || t.dataset.katFarbe;
  if (!id) return;
  const feld = t.dataset.katName ? 'name' : 'farbe';
  const wert = t.value.trim();
  if (!wert) return;
  try {
    await db(sb.from('menu_kategorien').update({ [feld]: wert }).eq('id', id));
    katById(id)[feld] = wert;
    toast('Gespeichert.');
  } catch (e) { fehler(e); }
});

/* ---------- Verschieben per Ziehen (Touch & Maus) ---------- */

let drag = null;
app.addEventListener('pointerdown', (ev) => {
  const grip = ev.target.closest('.grip');
  if (!grip || ev.button > 0) return;
  ev.preventDefault();
  const li = grip.closest('.entry');
  const p = state.plan.find((x) => x.id === li.dataset.id);
  const rect = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px' });
  document.body.append(ghost);
  li.classList.add('dragging');
  drag = { p, ghost, li, dy: ev.clientY - rect.top, ziel: null, y: ev.clientY };

  const scrollTimer = setInterval(() => {
    if (!drag) return;
    if (drag.y < 90) window.scrollBy(0, -12);
    else if (drag.y > window.innerHeight - 110) window.scrollBy(0, 12);
  }, 16);

  const move = (e) => {
    drag.y = e.clientY;
    ghost.style.top = e.clientY - drag.dy + 'px';
    // elementsFromPoint, damit Hinweise/Overlays über dem Tag nicht stören
    const tag = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest('.day[data-datum]')).find(Boolean);
    document.querySelectorAll('.day.drop').forEach((d) => d !== tag && d.classList.remove('drop'));
    if (tag) tag.classList.add('drop');
    drag.ziel = tag?.dataset.datum || null;
  };
  const ende = async () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', ende);
    window.removeEventListener('pointercancel', ende);
    clearInterval(scrollTimer);
    const { ziel } = drag;
    ghost.remove();
    drag = null;
    if (ziel && ziel !== p.datum) {
      const alt = p.datum;
      p.datum = ziel;
      sortierePlan();
      render();
      try {
        await db(sb.from('menu_plan').update({ datum: ziel }).eq('id', p.id));
        toast(`«${p.titel}» auf ${tagText(ziel)} verschoben.`, [{ label: 'Rückgängig', fn: async () => {
          p.datum = alt; sortierePlan(); render();
          try { await db(sb.from('menu_plan').update({ datum: alt }).eq('id', p.id)); } catch (err) { fehler(err); }
        } }]);
      } catch (e) { p.datum = alt; sortierePlan(); render(); fehler(e); }
    } else {
      render();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', ende);
  window.addEventListener('pointercancel', ende);
});

/* ---------- Sheets (Dialoge) ---------- */

let sheetActions = {};
function openSheet({ titel, body, foot = '', actions = {}, onOpen }) {
  sheetActions = actions;
  sheetRoot.innerHTML = `
    <div class="backdrop" data-close>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(titel)}">
        <div class="sheet-head"><h2>${esc(titel)}</h2><button class="btn icon ghost" data-close aria-label="Schliessen">✕</button></div>
        <div class="sheet-body">${body}</div>
        ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}
      </div>
    </div>`;
  if (onOpen) onOpen(sheetRoot.querySelector('.sheet')); // Listener hängen am Dialog und verschwinden mit ihm
}
function closeSheet() { sheetRoot.innerHTML = ''; sheetActions = {}; }

sheetRoot.addEventListener('click', (ev) => {
  if (ev.target.hasAttribute('data-close') || ev.target.closest('.sheet-head [data-close], .sheet-foot [data-close]')) { closeSheet(); return; }
  const el = ev.target.closest('[data-a]');
  if (el && sheetActions[el.dataset.a]) sheetActions[el.dataset.a](el);
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && sheetRoot.innerHTML) closeSheet(); });

function katOptionen(selected) {
  return `<option value="">– ohne –</option>` + state.kategorien
    .map((k) => `<option value="${k.id}" ${k.id === selected ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
}

function pickItem(g, stats, extraKlasse = '') {
  const k = katById(g.kategorie_id);
  const s = stats.get(g.id);
  return `<li><button class="pick ${extraKlasse}" data-a="waehlen" data-id="${g.id}">
    <span class="dot" style="background:${esc(k?.farbe || '')}"></span>
    <span class="name">${g.favorit ? '★ ' : ''}${esc(g.name)} ${gerichtTags(g, stats)}</span>
    <span class="meta">${s ? seitText(s.zuletzt) : 'noch nie'}</span>
  </button></li>`;
}

/** Gewicht für Vorschläge: lange nicht gegessen, Favorit, gute Bewertung. */
function gewicht(g, stats) {
  const s = stats.get(g.id);
  const tage = s ? Math.min(tageSeit(s.zuletzt), 120) : 90;
  const bewertung = Math.max(0.3, Math.min(2, 1 + 0.3 * (s?.bewertung || 0)));
  return (tage + 5) * (g.favorit ? 1.5 : 1) * bewertung;
}

/** Vorschläge: Gerichte, die am längsten nicht mehr gekocht wurden (mit etwas Zufall). */
function vorschlaege(anzahl, datum) {
  const stats = statistik();
  const geplant = new Set(state.plan.filter((p) => p.datum >= todayIso()).map((p) => p.gericht_id));
  return state.gerichte
    .filter((g) => !geplant.has(g.id) && !istDessert(g) && passtZuTag(g, datum))
    .map((g) => ({ g, w: gewicht(g, stats) * (0.5 + Math.random()) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, anzahl).map((x) => x.g);
}

async function eintragHinzufuegen(datum, titel, gerichtId, extra = {}) {
  const row = await db(sb.from('menu_plan').insert({
    haushalt_id: state.haushalt.id, datum, titel, gericht_id: gerichtId || null, ...extra,
  }).select().single());
  state.plan.push(row);
  sortierePlan();
  return row;
}

/** Nach dem Einplanen: Hinweis zeigen und – falls Zutaten hinterlegt sind – den Warenkorb-Dialog öffnen. */
function nachEinplanen(eintraege) {
  eintraege = [].concat(eintraege);
  closeSheet();
  render();
  toast(eintraege.length === 1 ? `«${eintraege[0].titel}» für ${tagText(eintraege[0].datum)} geplant.` : `${eintraege.length} Gerichte geplant.`);
  if (eintraege.some((e) => e.gericht_id && zutatenVon(e.gericht_id).length)) warenkorbSheet(eintraege);
}

async function gerichtSpeichern(daten, id) {
  if (id) {
    const row = await db(sb.from('menu_gerichte').update(daten).eq('id', id).select().single());
    Object.assign(gerichtById(id), row);
    return row;
  }
  const row = await db(sb.from('menu_gerichte').insert({ ...daten, haushalt_id: state.haushalt.id }).select().single());
  state.gerichte.push(row);
  state.gerichte.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return row;
}

function pickerSheet(datum) {
  const typ = tagTyp(datum);
  let suche = '';
  let nurPassende = true;
  let nurSchnell = false;

  const liste = () => {
    const stats = statistik();
    const q = norm(suche);
    let html = `<div class="chips">
      <button class="chip ${nurPassende ? 'active' : ''}" data-a="passend">${typ === 'wochenende' ? 'Nur Wochenend-Menüs' : 'Nur unter der Woche'}</button>
      <button class="chip ${nurSchnell ? 'active' : ''}" data-a="schnell">⏱ Schnell (≤ 30 Min.)</button>
    </div>`;
    if (!q) {
      html += `<div class="section-label">Vorschläge – länger nicht gegessen</div><ul class="pick-list">${vorschlaege(3, datum).filter((g) => !nurSchnell || istSchnell(g)).map((g) => pickItem(g, stats, 'suggest')).join('')}
        <li><button class="pick free" data-a="reste">🍲 Reste essen</button></li></ul>`;
    } else if (!state.gerichte.some((g) => norm(g.name) === q)) {
      html += `<ul class="pick-list">
        <li><button class="pick free" data-a="frei">＋ «${esc(suche.trim())}» eintragen</button></li>
        <li><button class="pick free" data-a="frei-speichern">＋ «${esc(suche.trim())}» eintragen & in Gerichte speichern</button></li>
      </ul>`;
    }
    const treffer = state.gerichte.filter((g) => (!q || norm(g.name).includes(q)) &&
      (!nurPassende || q || passtZuTag(g, datum)) && (!nurSchnell || istSchnell(g)));
    let gefunden = false;
    for (const k of [...state.kategorien, { id: null, name: 'Ohne Kategorie' }]) {
      const items = treffer.filter((g) => (g.kategorie_id || null) === k.id);
      if (!items.length) continue;
      gefunden = true;
      html += `<div class="section-label">${esc(k.name)}</div><ul class="pick-list">${items.map((g) => pickItem(g, stats)).join('')}</ul>`;
    }
    return gefunden || q ? html : html + `<div class="empty">Keine passenden Gerichte${nurSchnell ? ' (Kochzeit bei den Gerichten erfassen)' : ''}</div>`;
  };
  const neuZeichnen = () => { sheetRoot.querySelector('#pick-liste').innerHTML = liste(); };

  openSheet({
    titel: tagText(datum),
    body: `<div class="field" style="position:sticky;top:0;background:var(--bg);padding-top:4px;z-index:1">
        <input class="input" id="pick-suche" type="search" placeholder="Suchen oder neues Gericht eingeben …" autocomplete="off">
      </div>
      <div id="pick-liste">${liste()}</div>`,
    actions: {
      passend: () => { nurPassende = !nurPassende; neuZeichnen(); },
      schnell: () => { nurSchnell = !nurSchnell; neuZeichnen(); },
      waehlen: async (el) => {
        const g = gerichtById(el.dataset.id);
        try { nachEinplanen(await eintragHinzufuegen(datum, g.name, g.id)); } catch (e) { fehler(e); }
      },
      reste: async () => {
        try { nachEinplanen(await eintragHinzufuegen(datum, 'Reste', null, { reste: true })); } catch (e) { fehler(e); }
      },
      frei: async () => {
        try { nachEinplanen(await eintragHinzufuegen(datum, suche.trim(), null)); } catch (e) { fehler(e); }
      },
      'frei-speichern': async () => {
        const t = suche.trim();
        try {
          const g = await gerichtSpeichern({ name: t, kategorie_id: state.filterKat && katById(state.filterKat) ? state.filterKat : null });
          nachEinplanen(await eintragHinzufuegen(datum, t, g.id));
        } catch (e) { fehler(e); }
      },
    },
    onOpen: (root) => {
      const inp = root.querySelector('#pick-suche');
      inp.addEventListener('input', () => { suche = inp.value; neuZeichnen(); });
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); root.querySelector('#pick-liste .pick')?.click(); }
      });
      if (window.matchMedia('(min-width: 640px)').matches) inp.focus();
    },
  });
}

/**
 * Zutaten eines oder mehrerer geplanter Gerichte auswählen und in den Warenkorb legen.
 * Portionen pro Gericht anpassbar; Vorrat und bereits vorhandene Artikel sind abgewählt.
 */
function warenkorbSheet(eintraege) {
  const liste = [].concat(eintraege).filter((e) => e.gericht_id && zutatenVon(e.gericht_id).length);
  if (!liste.length) { toast('Für diese Gerichte sind keine Zutaten erfasst.'); return; }
  const offen = new Set(state.einkauf.filter((e) => !e.erledigt).map((e) => norm(e.name)));
  const portionen = liste.map((e) => e.portionen || gerichtById(e.gericht_id).portionen || 2);
  const gewaehlt = new Set();
  liste.forEach((e, i) => zutatenVon(e.gericht_id).forEach((z) => {
    if (!offen.has(norm(z.name)) && !istVorrat(z.name)) gewaehlt.add(`${i}:${z.id}`);
  }));

  const inhalt = () => liste.map((e, i) => {
    const g = gerichtById(e.gericht_id);
    const faktor = portionen[i] / (g.portionen || 2);
    return `<div class="wk-gericht">
      <div class="wk-kopf">
        <div class="grow"><strong>${esc(e.titel)}</strong><div class="muted small">${tagText(e.datum)}</div></div>
        <div class="stepper" aria-label="Portionen">
          <button class="btn icon" data-a="port" data-i="${i}" data-d="-1" aria-label="Weniger Portionen">−</button>
          <span>${portionen[i]} P.</span>
          <button class="btn icon" data-a="port" data-i="${i}" data-d="1" aria-label="Mehr Portionen">+</button>
        </div>
      </div>
      <ul class="check-list card">
        ${zutatenVon(g.id).map((z) => {
          const key = `${i}:${z.id}`;
          const hinweis = offen.has(norm(z.name)) ? 'schon im Warenkorb' : istVorrat(z.name) ? 'Vorrat' : '';
          return `<li><label>
            <input type="checkbox" data-zutat="${key}" ${gewaehlt.has(key) ? 'checked' : ''}>
            <span class="grow">${esc(z.name)}${hinweis ? ` <span class="muted small">(${hinweis})</span>` : ''}</span>
            <span class="muted small">${esc(mengeSkalieren(z.menge, faktor))}</span>
          </label></li>`;
        }).join('')}
      </ul></div>`;
  }).join('');

  const zaehlen = () => {
    const btn = sheetRoot.querySelector('[data-a=in-korb]');
    btn.textContent = gewaehlt.size ? `${gewaehlt.size} in den Warenkorb` : 'Nichts hinzufügen';
  };
  const neu = () => { sheetRoot.querySelector('#wk-liste').innerHTML = inhalt(); zaehlen(); };

  openSheet({
    titel: '🛒 Zutaten einkaufen?',
    body: `
      <p class="muted small" style="margin-top:0">Häkchen entfernen bei allem, was ihr schon zu Hause habt. Mengen passen sich den Portionen an.</p>
      <div class="row" style="margin-bottom:8px"><button class="btn small" data-a="alle">Alle</button><button class="btn small" data-a="keine">Keine</button></div>
      <div id="wk-liste">${inhalt()}</div>`,
    foot: `<button class="btn" data-close>Überspringen</button><span class="spacer"></span><button class="btn primary" data-a="in-korb"></button>`,
    actions: {
      alle: () => { liste.forEach((e, i) => zutatenVon(e.gericht_id).forEach((z) => gewaehlt.add(`${i}:${z.id}`))); neu(); },
      keine: () => { gewaehlt.clear(); neu(); },
      port: (el) => {
        const i = Number(el.dataset.i);
        portionen[i] = Math.max(1, Math.min(50, portionen[i] + Number(el.dataset.d)));
        neu();
      },
      'in-korb': async () => {
        const rows = [];
        liste.forEach((e, i) => {
          const g = gerichtById(e.gericht_id);
          const faktor = portionen[i] / (g.portionen || 2);
          for (const z of zutatenVon(g.id)) {
            if (!gewaehlt.has(`${i}:${z.id}`)) continue;
            rows.push({
              id: crypto.randomUUID(), haushalt_id: state.haushalt.id, name: z.name, menge: mengeSkalieren(z.menge, faktor) || null,
              plan_id: e.id, quelle: `${e.titel} (${WT[parseIso(e.datum).getDay()]} ${fmtKurz(parseIso(e.datum))})`,
              erledigt: false, erstellt_am: new Date().toISOString(),
            });
          }
        });
        // Geänderte Portionen am Plan-Eintrag merken
        liste.forEach((e, i) => {
          const std = gerichtById(e.gericht_id).portionen || 2;
          const neuP = portionen[i] === std ? null : portionen[i];
          if ((e.portionen || null) !== neuP) {
            e.portionen = neuP;
            sb.from('menu_plan').update({ portionen: neuP }).eq('id', e.id).then(({ error }) => error && console.error(error));
          }
        });
        closeSheet();
        if (!rows.length) return;
        await einkaufAendern({ typ: 'insert', row: rows });
        toast(`${rows.length} Artikel im Warenkorb.`);
      },
    },
    onOpen: (root) => {
      root.addEventListener('change', (ev) => {
        const k = ev.target.dataset.zutat;
        if (!k) return;
        if (ev.target.checked) gewaehlt.add(k); else gewaehlt.delete(k);
        zaehlen();
      });
      zaehlen();
    },
  });
}

function eintragSheet(p) {
  if (!p) return;
  const g = p.gericht_id && gerichtById(p.gericht_id);
  const imKorb = state.einkauf.filter((e) => e.plan_id === p.id);
  let bewertung = p.bewertung || null;
  const bewertungHtml = () => `
    <button class="btn ${bewertung === 1 ? 'aktiv' : ''}" data-a="bew" data-w="1" aria-label="Gut">👍</button>
    <button class="btn ${bewertung === -1 ? 'aktiv' : ''}" data-a="bew" data-w="-1" aria-label="Nicht so gut">👎</button>`;
  openSheet({
    titel: p.reste ? '🍲 Reste' : 'Eintrag bearbeiten',
    body: `
      <div class="field"><label for="e-titel">Gericht</label><input class="input" id="e-titel" value="${esc(p.titel)}"></div>
      <div class="row">
        <div class="field grow"><label for="e-datum">Datum</label><input class="input" id="e-datum" type="date" value="${p.datum}"></div>
        ${g ? `<div class="field" style="width:110px"><label for="e-port">Portionen</label><input class="input" id="e-port" type="number" min="1" max="50" value="${p.portionen || g.portionen || 2}"></div>` : ''}
      </div>
      <div class="field"><label>Wer kocht?</label>
        <div class="segmented">
          <label><input type="radio" name="e-koch" value="" ${!p.koch_user ? 'checked' : ''}><span>Offen</span></label>
          ${state.mitglieder.map((m) => `<label><input type="radio" name="e-koch" value="${m.user_id}" ${p.koch_user === m.user_id ? 'checked' : ''}><span>${esc(m.anzeigename || '…')}</span></label>`).join('')}
        </div>
      </div>
      <div class="field"><label for="e-notiz">Notiz</label><textarea class="input" id="e-notiz" placeholder="z.B. Beilage, Gäste …">${esc(p.notiz || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="e-erledigt" ${p.erledigt ? 'checked' : ''}> Gekocht / erledigt</label>
      ${g && !p.reste ? `<div class="field"><label>Wie war's?</label><div class="row" id="bew">${bewertungHtml()}</div></div>` : ''}
      <div class="stack">
        ${g ? `
          <p class="muted small" style="margin:0">Verknüpft mit «${esc(g.name)}».${imKorb.length ? ` ${imKorb.length} Artikel davon im Warenkorb.` : ''}</p>
          ${zutatenVon(g.id).length ? '<button class="btn block" data-a="korb">🛒 Zutaten in den Warenkorb …</button>' : '<p class="muted small" style="margin:0">Für dieses Gericht sind noch keine Zutaten erfasst.</p>'}
          <button class="btn block" data-a="zum-gericht">📖 Gericht & Rezept anzeigen</button>` : ''}
        ${p.reste ? '' : '<button class="btn block" data-a="reste-morgen">🍲 Reste für den nächsten Tag einplanen</button>'}
        ${!g && !p.reste ? `
          <div class="card panel" style="padding:12px">
            <div class="small muted" style="margin-bottom:6px">Noch nicht in der Gerichte-Sammlung</div>
            <div class="row"><select class="input grow" id="e-kat">${katOptionen(null)}</select><button class="btn" data-a="sammeln">Speichern</button></div>
          </div>` : ''}
      </div>`,
    foot: `<button class="btn danger" data-a="loeschen">Löschen</button><span class="spacer"></span><button class="btn primary" data-a="speichern">Speichern</button>`,
    actions: {
      bew: (el) => {
        const w = Number(el.dataset.w);
        bewertung = bewertung === w ? null : w;
        document.getElementById('bew').innerHTML = bewertungHtml();
      },
      korb: () => warenkorbSheet(p),
      'zum-gericht': () => gerichtSheet(g),
      'reste-morgen': async () => {
        try {
          const row = await eintragHinzufuegen(plusTage(p.datum, 1), `Reste: ${p.titel}`, null, { reste: true });
          closeSheet(); render(); toast(`Reste für ${tagText(row.datum)} eingeplant.`);
        } catch (e) { fehler(e); }
      },
      speichern: async () => {
        const port = document.getElementById('e-port');
        const std = g?.portionen || 2;
        const daten = {
          titel: document.getElementById('e-titel').value.trim() || p.titel,
          datum: document.getElementById('e-datum').value || p.datum,
          notiz: document.getElementById('e-notiz').value.trim() || null,
          erledigt: document.getElementById('e-erledigt').checked,
          koch_user: sheetRoot.querySelector('input[name=e-koch]:checked')?.value || null,
          bewertung,
          ...(port ? { portionen: Number(port.value) && Number(port.value) !== std ? Number(port.value) : null } : {}),
        };
        try {
          const row = await db(sb.from('menu_plan').update(daten).eq('id', p.id).select().single());
          Object.assign(p, row);
          sortierePlan();
          closeSheet(); render();
        } catch (e) { fehler(e); }
      },
      loeschen: async () => {
        // Noch nicht gekaufte Zutaten dieses Eintrags wieder aus dem Warenkorb nehmen
        const offen = state.einkauf.filter((e) => e.plan_id === p.id && !e.erledigt);
        if (offen.length && !confirm(`Eintrag löschen? ${offen.length} noch nicht gekaufte Artikel werden auch aus dem Warenkorb entfernt.`)) return;
        try {
          if (offen.length) await einkaufAendern({ typ: 'delete', ids: offen.map((e) => e.id) });
          await db(sb.from('menu_plan').delete().eq('id', p.id));
          state.plan = state.plan.filter((x) => x.id !== p.id);
          closeSheet(); render(); toast('Eintrag gelöscht.');
        } catch (e) { fehler(e); }
      },
      sammeln: async () => {
        try {
          const titel = document.getElementById('e-titel').value.trim() || p.titel;
          const neu = await gerichtSpeichern({ name: titel, kategorie_id: document.getElementById('e-kat').value || null });
          const row = await db(sb.from('menu_plan').update({ gericht_id: neu.id, titel }).eq('id', p.id).select().single());
          Object.assign(p, row);
          closeSheet(); render(); toast(`«${titel}» zu den Gerichten hinzugefügt.`);
        } catch (e) { fehler(e); }
      },
    },
  });
}

function naechsterFreierTag(g) {
  const belegt = new Set(state.plan.map((p) => p.datum));
  let d = new Date();
  for (let i = 0; i < 60 && (belegt.has(iso(d)) || (g && !passtZuTag(g, iso(d)))); i++) d = addDays(d, 1);
  return iso(d);
}

function gerichtSheet(g, vorschlagName = '') {
  const stats = statistik();
  const s = g && stats.get(g.id);
  const kategorie = g ? g.kategorie_id : (state.filterKat && katById(state.filterKat) ? state.filterKat : null);
  const verlauf = g ? state.plan.filter((p) => p.gericht_id === g.id).slice(-5).reverse() : [];
  const wann = g?.wann || (['woche', 'wochenende'].includes(state.filterKat) ? state.filterKat : 'immer');
  // Lokale, bearbeitbare Kopien
  const zut = g ? zutatenVon(g.id).map((z) => ({ ...z })) : [];
  let bild = { pfad: g?.bild_pfad || null, url: g?.bild_url || null, datei: null, vorschau: g ? bildVon(g) : null };
  let quelleUrl = g?.quelle_url || null;

  const zutatenHtml = () => zut.length
    ? zut.map((z, i) => `<div class="zutat-row">
        <input class="input grow" data-z="${i}" data-f="name" value="${esc(z.name)}" placeholder="Zutat">
        <input class="input menge" data-z="${i}" data-f="menge" value="${esc(z.menge || '')}" placeholder="Menge">
        <button class="btn icon ghost" data-a="z-weg" data-i="${i}" aria-label="Entfernen">✕</button>
      </div>`).join('')
    : '<p class="muted small" style="margin:0 0 8px">Noch keine Zutaten erfasst.</p>';
  const bildHtml = () => bild.vorschau
    ? `<img class="hero" src="${esc(bild.vorschau)}" alt=""><div class="row" style="margin:6px 0 12px"><button class="btn small" data-a="foto">📷 Anderes Foto</button><button class="btn small danger" data-a="foto-weg">Foto entfernen</button></div>`
    : '<button class="btn block" data-a="foto" style="margin-bottom:12px">📷 Foto hinzufügen</button>';
  const zutatenNeu = () => { document.getElementById('z-liste').innerHTML = zutatenHtml(); };

  const zutatHinzu = () => {
    const n = document.getElementById('z-neu');
    const m = document.getElementById('z-menge');
    // Mehrere Zutaten auf einmal: durch Komma oder Zeilenumbruch getrennt; «200 g Mehl» wird zerlegt
    const zeilen = n.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    if (!zeilen.length) return;
    zeilen.forEach((zeile, i) => {
      const p = zutatParsen(zeile);
      zut.push({ name: p.name, menge: (i === 0 && m.value.trim()) || p.menge });
    });
    n.value = ''; m.value = '';
    zutatenNeu();
    n.focus();
  };

  openSheet({
    titel: g ? 'Gericht' : 'Neues Gericht',
    body: `
      <div id="bild-bereich">${bildHtml()}</div>
      <input type="file" id="foto-datei" accept="image/*" hidden>
      <div class="field"><label for="g-link">Rezept aus Link übernehmen</label>
        <div class="row"><input class="input grow" id="g-link" type="url" placeholder="https://… (Betty Bossi, Fooby, Swissmilk …)" value="${esc(quelleUrl || '')}"><button class="btn" data-a="import">Laden</button></div>
      </div>
      <div class="field"><label for="g-name">Name</label><input class="input" id="g-name" value="${esc(g ? g.name : vorschlagName)}"></div>
      <div class="row">
        <div class="field grow"><label for="g-kat">Kategorie</label><select class="input" id="g-kat">${katOptionen(kategorie)}</select></div>
        <div class="field" style="width:96px"><label for="g-zeit">Minuten</label><input class="input" id="g-zeit" type="number" min="1" max="1440" inputmode="numeric" value="${g?.kochzeit || ''}" placeholder="⏱"></div>
      </div>
      <div class="field"><label>Geeignet für</label>
        <div class="segmented" role="radiogroup">
          ${Object.entries(WANN).map(([w, l]) => `<label><input type="radio" name="g-wann" value="${w}" ${w === wann ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
      </div>
      <div class="field"><label>Zutaten für <input class="input inline-num" id="g-port" type="number" min="1" max="50" value="${g?.portionen || 2}"> Portionen</label>
        <div id="z-liste">${zutatenHtml()}</div>
        <div class="zutat-row">
          <input class="input grow" id="z-neu" placeholder="z.B. 200 g Mehl, 2 Eier" enterkeyhint="done">
          <input class="input menge" id="z-menge" placeholder="Menge" enterkeyhint="done">
          <button class="btn icon" data-a="z-hinzu" aria-label="Zutat hinzufügen">＋</button>
        </div>
      </div>
      <div class="field"><label for="g-rezept">Zubereitung</label><textarea class="input" id="g-rezept" rows="5" placeholder="Schritte, Tipps …">${esc(g?.rezept || '')}</textarea></div>
      <div class="field"><label for="g-notiz">Notiz</label><textarea class="input" id="g-notiz">${esc(g?.notiz || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="g-fav" ${g?.favorit ? 'checked' : ''}> ★ Favorit</label>
      ${g ? `
        <div class="card panel" style="padding:12px;margin-bottom:12px">
          <div class="small muted">Zuletzt gegessen: <strong>${s ? `${seitText(s.zuletzt)} (${fmtKurz(parseIso(s.zuletzt))})` : 'noch nie'}</strong>${s ? ` · ${s.anzahl}× insgesamt` : ''}${s?.bewertung ? ` · Bewertung ${s.bewertung > 0 ? '+' : ''}${s.bewertung}` : ''}</div>
          ${verlauf.length ? `<div class="small muted" style="margin-top:4px">Geplant/gegessen: ${verlauf.map((p) => fmtKurz(parseIso(p.datum))).join(', ')}</div>` : ''}
        </div>
        <div class="field"><label for="g-datum">Einplanen am</label>
          <div class="row"><input class="input grow" id="g-datum" type="date" value="${naechsterFreierTag(g)}"><button class="btn" data-a="einplanen">Einplanen</button></div>
        </div>` : ''}`,
    foot: `${g ? '<button class="btn danger" data-a="loeschen">Löschen</button>' : ''}<span class="spacer"></span><button class="btn primary" data-a="speichern">Speichern</button>`,
    actions: {
      'z-hinzu': zutatHinzu,
      'z-weg': (el) => { zut.splice(Number(el.dataset.i), 1); zutatenNeu(); },
      foto: () => document.getElementById('foto-datei').click(),
      'foto-weg': () => { bild = { pfad: null, url: null, datei: null, vorschau: null }; document.getElementById('bild-bereich').innerHTML = bildHtml(); },
      import: async (el) => {
        const url = document.getElementById('g-link').value.trim();
        if (!url) { toast('Bitte zuerst einen Link einfügen.'); return; }
        el.disabled = true; el.textContent = '…';
        try {
          const { data, error } = await sb.functions.invoke('menu-rezept-import', { body: { url } });
          if (error) throw error;
          if (data.error) throw new Error(data.error);
          quelleUrl = data.quelle_url || url;
          const nameFeld = document.getElementById('g-name');
          if (data.name && !nameFeld.value.trim()) nameFeld.value = data.name;
          if (!data.gefunden) { toast('Auf dieser Seite wurde kein Rezept gefunden – Link wird als Quelle gespeichert.'); return; }
          if (data.kochzeit) document.getElementById('g-zeit').value = data.kochzeit;
          if (data.portionen) document.getElementById('g-port').value = data.portionen;
          const rezept = document.getElementById('g-rezept');
          if (data.anleitung && !rezept.value.trim()) rezept.value = data.anleitung;
          if (data.zutaten?.length) {
            if (zut.length && !confirm(`${data.zutaten.length} Zutaten gefunden. Bisherige Zutaten ersetzen?`)) {
              zut.push(...data.zutaten.map(zutatParsen));
            } else {
              zut.splice(0, zut.length, ...data.zutaten.map(zutatParsen));
            }
            zutatenNeu();
          }
          if (data.bild && !bild.pfad && !bild.datei) {
            bild = { ...bild, url: data.bild, vorschau: data.bild };
            document.getElementById('bild-bereich').innerHTML = bildHtml();
          }
          toast(`Rezept übernommen${data.zutaten?.length ? ` (${data.zutaten.length} Zutaten)` : ''} – bitte prüfen und speichern.`);
        } catch (e) {
          fehler(e);
        } finally {
          el.disabled = false; el.textContent = 'Laden';
        }
      },
      speichern: async (el) => {
        const name = document.getElementById('g-name').value.trim();
        if (!name) { toast('Bitte einen Namen eingeben.'); return; }
        zutatHinzu(); // noch nicht übernommene Eingabe nicht verlieren
        el.disabled = true;
        try {
          const zeit = Number(document.getElementById('g-zeit').value) || null;
          const port = Math.max(1, Math.min(50, Number(document.getElementById('g-port').value) || 2));
          const daten = {
            name,
            kategorie_id: document.getElementById('g-kat').value || null,
            wann: sheetRoot.querySelector('input[name=g-wann]:checked').value,
            kochzeit: zeit,
            portionen: port,
            rezept: document.getElementById('g-rezept').value.trim() || null,
            notiz: document.getElementById('g-notiz').value.trim() || null,
            favorit: document.getElementById('g-fav').checked,
            quelle_url: quelleUrl,
            bild_url: bild.url,
            bild_pfad: bild.pfad,
          };
          const row = await gerichtSpeichern(daten, g?.id);
          if (bild.datei) {
            const pfad = `${state.haushalt.id}/${row.id}-${Date.now()}.jpg`;
            const { error } = await sb.storage.from('menu-bilder').upload(pfad, bild.datei, { contentType: 'image/jpeg' });
            if (error) throw error;
            state.bildUrls.set(pfad, bild.vorschau);
            Object.assign(gerichtById(row.id), await db(sb.from('menu_gerichte').update({ bild_pfad: pfad, bild_url: null }).eq('id', row.id).select().single()));
          }
          // altes hochgeladenes Bild aufräumen
          if (g?.bild_pfad && g.bild_pfad !== gerichtById(row.id).bild_pfad) sb.storage.from('menu-bilder').remove([g.bild_pfad]);
          await zutatenSpeichern(row.id, zut);
          closeSheet(); render(); toast('Gespeichert.');
        } catch (e) { fehler(e); el.disabled = false; }
      },
      einplanen: async () => {
        const datum = document.getElementById('g-datum').value;
        if (!datum) return;
        try { nachEinplanen(await eintragHinzufuegen(datum, g.name, g.id)); } catch (e) { fehler(e); }
      },
      loeschen: async () => {
        if (!confirm(`«${g.name}» wirklich löschen? Bereits geplante Einträge bleiben erhalten.`)) return;
        try {
          await db(sb.from('menu_gerichte').delete().eq('id', g.id));
          if (g.bild_pfad) sb.storage.from('menu-bilder').remove([g.bild_pfad]);
          state.gerichte = state.gerichte.filter((x) => x.id !== g.id);
          state.zutaten = state.zutaten.filter((z) => z.gericht_id !== g.id);
          state.plan.forEach((p) => { if (p.gericht_id === g.id) p.gericht_id = null; });
          closeSheet(); render(); toast('Gelöscht.');
        } catch (e) { fehler(e); }
      },
    },
    onOpen: (root) => {
      root.addEventListener('input', (ev) => {
        const i = ev.target.dataset.z;
        if (i !== undefined) zut[Number(i)][ev.target.dataset.f] = ev.target.value;
      });
      for (const id of ['z-neu', 'z-menge']) {
        root.querySelector('#' + id).addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); zutatHinzu(); }
        });
      }
      root.querySelector('#foto-datei').addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          const blob = await bildVerkleinern(file);
          bild = { pfad: null, url: null, datei: blob, vorschau: URL.createObjectURL(blob) };
          document.getElementById('bild-bereich').innerHTML = bildHtml();
        } catch (e) { fehler(e); }
      });
    },
  });
}

/** Zutaten eines Gerichts mit der bearbeiteten Liste abgleichen. */
async function zutatenSpeichern(gerichtId, liste) {
  const vorher = zutatenVon(gerichtId);
  const bleibend = liste.filter((z) => z.name.trim());
  const behalteIds = new Set(bleibend.filter((z) => z.id).map((z) => z.id));
  const weg = vorher.filter((z) => !behalteIds.has(z.id)).map((z) => z.id);
  if (weg.length) await db(sb.from('menu_zutaten').delete().in('id', weg));
  const upserts = bleibend.map((z, i) => ({
    ...(z.id ? { id: z.id } : {}),
    haushalt_id: state.haushalt.id, gericht_id: gerichtId,
    name: z.name.trim(), menge: (z.menge || '').trim() || null, sortierung: i,
  }));
  const neu = upserts.length ? await db(sb.from('menu_zutaten').upsert(upserts, { defaultToNull: false }).select()) : [];
  state.zutaten = state.zutaten.filter((z) => z.gericht_id !== gerichtId).concat(neu);
  state.zutaten.sort((a, b) => a.sortierung - b.sortierung);
}

function zufallSheet() {
  const stats = statistik();
  let tag = naechsterFreierTag();
  const zeigen = () => vorschlaege(5, tag).map((g) => pickItem(g, stats, 'suggest')).join('') || '<div class="empty">Keine passenden Gerichte</div>';
  openSheet({
    titel: 'Was kochen wir?',
    body: `<p class="muted small" style="margin-top:0">Gerichte, die ihr länger nicht mehr gegessen habt – passend zum gewählten Tag. Antippen plant es ein.</p>
      <div class="field"><label for="z-tag">Für</label><input class="input" id="z-tag" type="date" value="${tag}"></div>
      <ul class="pick-list" id="zufall-liste">${zeigen()}</ul>`,
    foot: `<span class="spacer"></span><button class="btn" data-a="neu-mischen">🎲 Neu mischen</button>`,
    actions: {
      'neu-mischen': () => { document.getElementById('zufall-liste').innerHTML = zeigen(); },
      waehlen: async (el) => {
        const g = gerichtById(el.dataset.id);
        try {
          const row = await eintragHinzufuegen(tag, g.name, g.id);
          state.weekStart = mondayOf(parseIso(tag));
          state.tab = 'plan';
          nachEinplanen(row);
        } catch (e) { fehler(e); }
      },
    },
    onOpen: (root) => {
      root.querySelector('#z-tag').addEventListener('change', (ev) => {
        if (!ev.target.value) return;
        tag = ev.target.value;
        document.getElementById('zufall-liste').innerHTML = zeigen();
      });
    },
  });
}

/* ---------- Woche: automatisch füllen, kopieren, einkaufen ---------- */

/** Gericht für einen Tag zufällig (gewichtet) wählen – mit Abwechslung bei den Kategorien. */
function gerichtFuerTag(datum, vorschlag, schnellUnterWoche, ausschliessen) {
  const stats = statistik();
  const kats = new Map();
  for (const g of vorschlag.values()) if (g) kats.set(g.kategorie_id, (kats.get(g.kategorie_id) || 0) + 1);
  const nachbarn = [vorschlag.get(plusTage(datum, -1)), vorschlag.get(plusTage(datum, 1))].filter(Boolean).map((g) => g.kategorie_id);
  const genutzt = new Set([...vorschlag.values()].filter(Boolean).map((g) => g.id));
  const kandidaten = state.gerichte
    .filter((g) => !istDessert(g) && passtZuTag(g, datum) && !genutzt.has(g.id) && !ausschliessen.has(g.id))
    .filter((g) => !schnellUnterWoche || istWochenende(datum) || !g.kochzeit || g.kochzeit <= 30)
    .map((g) => {
      let w = gewicht(g, stats);
      if (schnellUnterWoche && !istWochenende(datum) && !g.kochzeit) w *= 0.6;
      w /= 1 + 1.5 * (kats.get(g.kategorie_id) || 0);
      if (nachbarn.includes(g.kategorie_id)) w *= 0.3;
      return { g, w: w * (0.6 + 0.8 * Math.random()) };
    });
  const summe = kandidaten.reduce((a, k) => a + k.w, 0);
  let r = Math.random() * summe;
  for (const k of kandidaten) { r -= k.w; if (r <= 0) return k.g; }
  return kandidaten[0]?.g || null;
}

function autoWocheSheet() {
  const heute = todayIso();
  const tage = Array.from({ length: 7 }, (_, i) => iso(addDays(state.weekStart, i)))
    .filter((d) => d >= heute && !state.plan.some((p) => p.datum === d));
  if (!tage.length) { toast('In dieser Woche ist schon alles geplant.'); return; }
  let schnell = localGet('auto-schnell') === '1';
  const vorschlag = new Map();
  const bereitsGeplant = new Set(state.plan.filter((p) => p.datum >= heute && p.gericht_id).map((p) => p.gericht_id));
  const fuellen = () => { vorschlag.clear(); for (const d of tage) vorschlag.set(d, gerichtFuerTag(d, vorschlag, schnell, bereitsGeplant)); };
  fuellen();

  const inhalt = () => `<ul class="auto-liste">${tage.map((d) => {
    const g = vorschlag.get(d);
    return `<li class="${g ? '' : 'leer'}">
      <span class="auto-tag">${WT[parseIso(d).getDay()]}<span class="muted small"> ${fmtKurz(parseIso(d))}</span></span>
      <span class="grow">${g ? esc(g.name) : '<span class="muted">– frei lassen –</span>'}</span>
      <button class="btn icon ghost" data-a="neu-tag" data-d="${d}" aria-label="Anderes Gericht">🎲</button>
      <button class="btn icon ghost" data-a="weg-tag" data-d="${d}" aria-label="Frei lassen">✕</button>
    </li>`;
  }).join('')}</ul>`;
  const neu = () => { document.getElementById('auto-inhalt').innerHTML = inhalt(); };

  openSheet({
    titel: '🎲 Woche automatisch füllen',
    body: `<p class="muted small" style="margin-top:0">Vorschlag für die freien Tage: abwechslungsreich, passend zu Wochenende/Woche und bevorzugt Gerichte, die ihr länger nicht hattet. Einzelne Tage neu würfeln oder frei lassen.</p>
      <label class="check"><input type="checkbox" id="auto-schnell" ${schnell ? 'checked' : ''}> Unter der Woche nur schnelle Gerichte (≤ 30 Min.)</label>
      <div id="auto-inhalt">${inhalt()}</div>`,
    foot: `<button class="btn" data-a="alles-neu">🎲 Alles neu</button><span class="spacer"></span><button class="btn primary" data-a="uebernehmen">Übernehmen</button>`,
    actions: {
      'neu-tag': (el) => {
        const d = el.dataset.d;
        const alt = vorschlag.get(d);
        vorschlag.set(d, null);
        vorschlag.set(d, gerichtFuerTag(d, vorschlag, schnell, new Set([...bereitsGeplant, alt?.id].filter(Boolean))) || alt);
        neu();
      },
      'weg-tag': (el) => { vorschlag.set(el.dataset.d, null); neu(); },
      'alles-neu': () => { fuellen(); neu(); },
      uebernehmen: async (el) => {
        const liste = tage.filter((d) => vorschlag.get(d));
        if (!liste.length) { closeSheet(); return; }
        el.disabled = true;
        try {
          const rows = await db(sb.from('menu_plan').insert(liste.map((d) => ({
            haushalt_id: state.haushalt.id, datum: d, titel: vorschlag.get(d).name, gericht_id: vorschlag.get(d).id,
          }))).select());
          state.plan.push(...rows);
          sortierePlan();
          nachEinplanen(rows);
        } catch (e) { fehler(e); el.disabled = false; }
      },
    },
    onOpen: (root) => {
      root.querySelector('#auto-schnell').addEventListener('change', (ev) => {
        schnell = ev.target.checked;
        localSet('auto-schnell', schnell ? '1' : '0');
        fuellen(); neu();
      });
    },
  });
}

function wochenMenuSheet() {
  const start = iso(state.weekStart);
  const ende = plusTage(start, 6);
  const dieseWoche = state.plan.filter((p) => p.datum >= start && p.datum <= ende);
  const letzteWoche = state.plan.filter((p) => p.datum >= plusTage(start, -7) && p.datum < start);
  const mitZutaten = dieseWoche.filter((p) => p.datum >= todayIso() && !p.erledigt && p.gericht_id && zutatenVon(p.gericht_id).length);
  openSheet({
    titel: `Woche ${kw(state.weekStart)}`,
    body: `<div class="stack">
      <button class="btn block left" data-a="auto">🎲 Freie Tage automatisch füllen</button>
      <button class="btn block left" data-a="kopieren" ${letzteWoche.length ? '' : 'disabled'}>📋 Letzte Woche übernehmen <span class="muted small">(${letzteWoche.length} Gerichte, nur auf freie Tage)</span></button>
      <button class="btn block left" data-a="einkaufen" ${mitZutaten.length ? '' : 'disabled'}>🛒 Zutaten der Woche einkaufen <span class="muted small">(${mitZutaten.length} Gerichte)</span></button>
    </div>`,
    actions: {
      auto: () => autoWocheSheet(),
      einkaufen: () => warenkorbSheet(mitZutaten),
      kopieren: async () => {
        const belegt = new Set(dieseWoche.map((p) => p.datum));
        const neu = letzteWoche.filter((p) => !belegt.has(plusTage(p.datum, 7)) && !p.reste).map((p) => ({
          haushalt_id: state.haushalt.id, datum: plusTage(p.datum, 7), titel: p.titel, gericht_id: p.gericht_id, koch_user: p.koch_user, notiz: p.notiz,
        }));
        if (!neu.length) { toast('Keine freien Tage für die Gerichte der letzten Woche.'); return; }
        try {
          const rows = await db(sb.from('menu_plan').insert(neu).select());
          state.plan.push(...rows);
          sortierePlan();
          nachEinplanen(rows);
        } catch (e) { fehler(e); }
      },
    },
  });
}

/* ---------- Einkaufsartikel bearbeiten (Abteilung, Vorrat, Menge) ---------- */

function artikelSheet(key) {
  const gruppe = einkaufGruppen(state.einkauf).find((g) => g.key === key);
  if (!gruppe) return;
  const einzel = gruppe.eintraege.length === 1 ? gruppe.eintraege[0] : null;
  openSheet({
    titel: gruppe.name,
    body: `
      <div class="field"><label for="a-name">Artikel</label><input class="input" id="a-name" value="${esc(gruppe.name)}"></div>
      ${einzel ? `<div class="field"><label for="a-menge">Menge</label><input class="input" id="a-menge" value="${esc(einzel.menge || '')}"></div>`
        : `<p class="muted small">Zusammengefasst aus ${gruppe.eintraege.length} Einträgen: ${gruppe.eintraege.map((e) => esc(e.menge || '–')).join(', ')}</p>`}
      <div class="field"><label for="a-abt">Abteilung im Laden</label>
        <select class="input" id="a-abt">${ABTEILUNGEN.map((a) => `<option value="${a.id}" ${a.id === gruppe.abteilung ? 'selected' : ''}>${a.icon} ${esc(a.name)}</option>`).join('')}</select>
        <span class="muted small">Wird für diesen Artikel gemerkt.</span>
      </div>
      <label class="check"><input type="checkbox" id="a-vorrat" ${istVorrat(gruppe.name) ? 'checked' : ''}> 🥫 Haben wir immer (Vorrat) – künftig nicht automatisch auf die Liste</label>
      ${gruppe.quellen.length ? `<p class="muted small">Für: ${esc(gruppe.quellen.join(', '))}</p>` : ''}`,
    foot: `<button class="btn danger" data-a="weg">Entfernen</button><span class="spacer"></span><button class="btn primary" data-a="speichern">Speichern</button>`,
    actions: {
      weg: () => { closeSheet(); einkaufAendern({ typ: 'delete', ids: gruppe.ids }); },
      speichern: async () => {
        // Werte lesen, bevor der Dialog geschlossen wird
        const name = document.getElementById('a-name').value.trim() || gruppe.name;
        const abteilung = document.getElementById('a-abt').value;
        const vorrat = document.getElementById('a-vorrat').checked;
        const menge = einzel ? document.getElementById('a-menge').value.trim() || null : undefined;
        closeSheet();
        const daten = {};
        if (name !== gruppe.name) daten.name = name;
        if (einzel && menge !== (einzel.menge || null)) daten.menge = menge;
        if (Object.keys(daten).length) await einkaufAendern({ typ: 'update', ids: gruppe.ids, daten });
        try { await artikelSetzen(name, { abteilung, vorrat }); render(); } catch (e) { if (!istNetzFehler(e)) fehler(e); }
      },
    },
  });
}

/* ---------- Statistik ---------- */

function statistikSheet() {
  const stats = statistik();
  const mit = state.gerichte.map((g) => ({ g, s: stats.get(g.id) })).filter((x) => x.s);
  const top = [...mit].sort((a, b) => b.s.anzahl - a.s.anzahl).slice(0, 8);
  const lange = [...mit].filter((x) => tageSeit(x.s.zuletzt) > 21).sort((a, b) => a.s.zuletzt.localeCompare(b.s.zuletzt)).slice(0, 8);
  const beste = [...mit].filter((x) => x.s.bewertung > 0).sort((a, b) => b.s.bewertung - a.s.bewertung).slice(0, 5);
  const nie = state.gerichte.filter((g) => !stats.has(g.id) && !istDessert(g));
  const seit30 = state.plan.filter((p) => tageSeit(p.datum) >= 0 && tageSeit(p.datum) < 30 && !p.reste).length;
  const kochen = new Map();
  for (const p of state.plan) if (p.koch_user && p.datum <= todayIso()) kochen.set(p.koch_user, (kochen.get(p.koch_user) || 0) + 1);
  const max = Math.max(1, ...top.map((x) => x.s.anzahl));
  const zeile = (x, rechts) => `<li><button class="pick" data-a="oeffnen" data-id="${x.g.id}"><span class="name">${esc(x.g.name)}</span><span class="meta">${rechts}</span></button></li>`;
  openSheet({
    titel: '📊 Statistik',
    body: `
      <div class="stat-kacheln">
        <div class="card"><strong>${state.gerichte.length}</strong><span>Gerichte</span></div>
        <div class="card"><strong>${seit30}</strong><span>Menüs in 30 Tagen</span></div>
        <div class="card"><strong>${nie.length}</strong><span>noch nie gekocht</span></div>
      </div>
      ${top.length ? `<div class="section-label">Am häufigsten gegessen</div>
        <ul class="balken">${top.map((x) => `<li><span class="b-name">${esc(x.g.name)}</span><span class="b-bar"><span style="width:${(x.s.anzahl / max) * 100}%"></span></span><span class="b-zahl">${x.s.anzahl}×</span></li>`).join('')}</ul>` : ''}
      ${lange.length ? `<div class="section-label">Lange nicht mehr gegessen</div><ul class="pick-list">${lange.map((x) => zeile(x, seitText(x.s.zuletzt))).join('')}</ul>` : ''}
      ${beste.length ? `<div class="section-label">Am besten bewertet</div><ul class="pick-list">${beste.map((x) => zeile(x, `👍 ${x.s.bewertung}`)).join('')}</ul>` : ''}
      ${kochen.size ? `<div class="section-label">Wer hat gekocht?</div><p>${[...kochen].map(([u, n]) => `${esc(mitgliedName(u))}: <strong>${n}×</strong>`).join(' · ')}</p>` : ''}
      ${nie.length ? `<div class="section-label">Noch nie gekocht</div><p class="muted small">${nie.slice(0, 20).map((g) => esc(g.name)).join(' · ')}${nie.length > 20 ? ' …' : ''}</p>` : ''}`,
    actions: {
      oeffnen: (el) => gerichtSheet(gerichtById(el.dataset.id)),
    },
  });
}

/* ---------- Als App installieren ---------- */
let installPrompt = null;
function istInstalliert() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installPrompt = ev; render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('App installiert 🎉'); render(); });

async function installieren() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    render();
  } else {
    installAnleitungSheet();
  }
}

function installAnleitungSheet() {
  const ua = navigator.userAgent;
  const samsung = /SamsungBrowser/.test(ua);
  const inApp = /Instagram|FBAN|FBAV|WhatsApp|Line\//.test(ua);
  let schritte;
  if (inApp) {
    schritte = '<li>Diese Seite ist in einer anderen App geöffnet (z.B. WhatsApp). Tippe oben auf <strong>⋮</strong> und wähle <strong>«Im Browser öffnen»</strong>, dann nochmals «App installieren».</li>';
  } else if (istIos()) {
    schritte = `<li>Die Seite in <strong>Safari</strong> öffnen (in anderen Browsern geht es auf dem iPhone nicht).</li>
      <li>Unten auf das <strong>Teilen-Symbol</strong> (Quadrat mit Pfeil nach oben) tippen.</li>
      <li>Nach unten scrollen und <strong>«Zum Home-Bildschirm»</strong> wählen, dann «Hinzufügen».</li>`;
  } else if (samsung) {
    schritte = `<li>Unten rechts auf das <strong>Menü ≡</strong> tippen.</li>
      <li><strong>«Seite hinzufügen zu»</strong> → <strong>«Startbildschirm»</strong> wählen.</li>`;
  } else {
    schritte = `<li>Oben rechts auf das <strong>Menü ⋮</strong> tippen.</li>
      <li><strong>«App installieren»</strong> oder <strong>«Zum Startbildschirm hinzufügen»</strong> wählen.</li>
      <li>Falls das fehlt: Seite einmal neu laden und ein paar Sekunden warten.</li>`;
  }
  openSheet({
    titel: '📲 Als App installieren',
    body: `<ol class="anleitung">${schritte}</ol>
      <p class="muted small">Danach startet der Menüplan wie eine normale App vom Startbildschirm – ohne Browserleiste.</p>`,
    foot: '<span class="spacer"></span><button class="btn primary" data-close>OK</button>',
  });
}

/* ---------- Offline-Unterstützung (App-Hülle) ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}
