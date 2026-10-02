import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

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
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WT_LANG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const fmtKurz = (d) => `${d.getDate()}. ${MON[d.getMonth()]}`;
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

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function fehler(e) {
  console.error(e);
  toast('Fehler: ' + (e?.message || e));
}

async function db(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

const katById = (id) => state.kategorien.find((k) => k.id === id);
const gerichtById = (id) => state.gerichte.find((g) => g.id === id);
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Statistik pro Gericht: wann zuletzt gekocht und wie oft (bis heute). */
function statistik() {
  const heute = todayIso();
  const byName = new Map(state.gerichte.map((g) => [norm(g.name), g.id]));
  const stats = new Map();
  for (const p of state.plan) {
    if (p.datum > heute) continue;
    const gid = p.gericht_id || byName.get(norm(p.titel));
    if (!gid) continue;
    const s = stats.get(gid) || { zuletzt: null, anzahl: 0 };
    s.anzahl++;
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
    abonnieren();
    render();
    if (state.tab === 'plan') document.querySelector('.day.today')?.scrollIntoView({ block: 'center' });
  } catch (e) {
    app.innerHTML = `<div class="center"><div><p>Daten konnten nicht geladen werden.</p><p class="muted small">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Neu laden</button></div></div>`;
  }
}

async function ladeTabelle(name) {
  const hid = state.haushalt.id;
  if (name === 'menu_kategorien') state.kategorien = await db(sb.from(name).select('*').eq('haushalt_id', hid).order('sortierung').order('name'));
  if (name === 'menu_gerichte') state.gerichte = await db(sb.from(name).select('*').eq('haushalt_id', hid).order('name'));
  if (name === 'menu_plan') state.plan = await db(sb.from(name).select('*').eq('haushalt_id', hid).order('datum').order('erstellt_am'));
}

async function ladeAlles() {
  await Promise.all(['menu_kategorien', 'menu_gerichte', 'menu_plan'].map(ladeTabelle));
}

function abonnieren() {
  if (state.channel) sb.removeChannel(state.channel);
  const hid = state.haushalt.id;
  const ch = sb.channel('menu-' + hid);
  let timer = {};
  for (const table of ['menu_kategorien', 'menu_gerichte', 'menu_plan']) {
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
    try { await ladeAlles(); render(); } catch (e) { console.error(e); }
  }
});

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
        <p class="muted small">Den Code findet deine Partnerin / dein Partner in der App unter «Einstellungen».</p>
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
    ev.submitter && (ev.submitter.disabled = true);
    try {
      await db(sb.rpc('menu_haushalt_erstellen', { p_name: ev.target.hname.value, p_mit_startdaten: ev.target.seed.checked }));
      start();
    } catch (e) { fehler(e); }
  };
}

/* ---------- Hauptansicht ---------- */

function render() {
  if (!state.haushalt) return;
  const aktiv = document.activeElement;
  const fokusSuche = aktiv && aktiv.id === 'suche';
  const caret = fokusSuche ? aktiv.selectionStart : null;
  const scroll = window.scrollY;

  const titel = { plan: 'Menüplan', gerichte: 'Gerichte', einstellungen: 'Einstellungen' }[state.tab];
  let inhalt = '';
  if (state.tab === 'plan') inhalt = viewPlan();
  if (state.tab === 'gerichte') inhalt = viewGerichte();
  if (state.tab === 'einstellungen') inhalt = viewEinstellungen();

  app.innerHTML = `
    <div class="shell">
      <header class="topbar"><h1>${titel}</h1>${state.tab === 'plan' ? '<button class="btn" data-a="zufall">🎲 Vorschlag</button>' : ''}</header>
      ${inhalt}
    </div>
    ${state.tab === 'gerichte' ? '<button class="fab" data-a="gericht-neu" aria-label="Neues Gericht">+</button>' : ''}
    <nav class="tabbar">
      ${[['plan', '📅', 'Plan'], ['gerichte', '📖', 'Gerichte'], ['einstellungen', '⚙️', 'Einstellungen']]
        .map(([t, i, l]) => `<button data-a="tab" data-tab="${t}" class="${state.tab === t ? 'active' : ''}"><span class="ico">${i}</span>${l}</button>`).join('')}
    </nav>`;

  if (fokusSuche) {
    const s = document.getElementById('suche');
    s.focus();
    s.setSelectionRange(caret, caret);
  }
  window.scrollTo(0, scroll);
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
      <div class="card day ${ds === heute ? 'today' : ''}">
        <div class="day-head">
          <span class="wd">${WT[d.getDay()]}</span>
          <span class="dt">${fmtKurz(d)}</span>
          ${ds === heute ? '<span class="badge">Heute</span>' : ''}
        </div>
        <ul class="entries">
          ${eintraege.map((p) => {
            const farbe = farbeFuerEintrag(p);
            return `<li class="entry ${p.erledigt ? 'done' : ''}">
              <button class="cb" data-a="toggle" data-id="${p.id}" aria-label="Erledigt">✓</button>
              <span class="dot" style="${farbe ? `background:${esc(farbe)}` : ''}"></span>
              <button class="title" data-a="eintrag" data-id="${p.id}">${esc(p.titel)}${p.notiz ? `<span class="note">${esc(p.notiz)}</span>` : ''}</button>
            </li>`;
          }).join('')}
        </ul>
        <button class="add-entry" data-a="hinzu" data-datum="${ds}">+ ${eintraege.length ? 'weiteres Gericht' : 'Gericht planen'}</button>
      </div>`;
  }
  return `
    <div class="weeknav">
      <button class="btn icon" data-a="woche" data-d="-7" aria-label="Vorherige Woche">‹</button>
      <div class="label">${fmtKurz(start)} – ${fmtKurz(ende)} ${ende.getFullYear()}<div class="muted small">KW ${kw(start)}</div></div>
      <button class="btn icon" data-a="woche" data-d="7" aria-label="Nächste Woche">›</button>
    </div>
    ${istAktuelleWoche ? '' : '<p style="text-align:center;margin:-4px 0 10px"><button class="btn small" data-a="heute">Zur aktuellen Woche</button></p>'}
    ${tage}`;
}

function viewGerichte() {
  const stats = statistik();
  const q = norm(state.suche);
  const treffer = state.gerichte.filter((g) =>
    (!state.filterKat || g.kategorie_id === state.filterKat || (state.filterKat === 'fav' && g.favorit)) &&
    (!q || norm(g.name).includes(q) || norm(g.notiz).includes(q)));

  const gruppen = [...state.kategorien, { id: null, name: 'Ohne Kategorie', farbe: '#999' }]
    .map((k) => ({ k, items: treffer.filter((g) => (g.kategorie_id || null) === k.id) }))
    .filter((x) => x.items.length);

  const chips = [
    `<button class="chip ${!state.filterKat ? 'active' : ''}" data-a="filter" data-k="">Alle (${state.gerichte.length})</button>`,
    `<button class="chip ${state.filterKat === 'fav' ? 'active' : ''}" data-a="filter" data-k="fav">★ Favoriten</button>`,
    ...state.kategorien.map((k) => `<button class="chip ${state.filterKat === k.id ? 'active' : ''}" data-a="filter" data-k="${k.id}"><span class="dot" style="background:${esc(k.farbe)}"></span>${esc(k.name)}</button>`),
  ].join('');

  return `
    <div class="search"><input class="input" id="suche" type="search" placeholder="Gericht suchen …" value="${esc(state.suche)}" autocomplete="off"></div>
    <div class="chips">${chips}</div>
    ${gruppen.length ? gruppen.map(({ k, items }) => `
      <div class="cat-title"><span class="dot" style="background:${esc(k.farbe)}"></span>${esc(k.name)} <span class="count">${items.length}</span></div>
      <ul class="dish-list card">
        ${items.map((g) => {
          const s = stats.get(g.id);
          return `<li><button class="dish" data-a="gericht" data-id="${g.id}">
            <span class="name">${g.favorit ? '<span class="fav">★</span> ' : ''}${esc(g.name)}</span>
            <span class="meta">${s ? seitText(s.zuletzt) : ''}</span>
          </button></li>`;
        }).join('')}
      </ul>`).join('') : `<div class="empty">Keine Gerichte gefunden.${q ? `<br><br><button class="btn" data-a="gericht-neu" data-name="${esc(state.suche)}">«${esc(state.suche)}» hinzufügen</button>` : ''}</div>`}`;
}

function viewEinstellungen() {
  const h = state.haushalt;
  return `
    <div class="settings">
      <section class="card panel">
        <h2>Haushalt</h2>
        <div class="row"><input class="input grow" id="hname" value="${esc(h.name)}"><button class="btn" data-a="hname">Speichern</button></div>
      </section>
      <section class="card panel">
        <h2>Partnerin / Partner einladen</h2>
        <p class="muted small" style="margin-top:0">Sie/er registriert sich in der App und gibt diesen Code unter «Haushalt beitreten» ein. Danach seht ihr beide dieselben Daten – Änderungen erscheinen sofort auf beiden Geräten.</p>
        <div class="row"><span class="code grow">${esc(h.beitrittscode)}</span><button class="btn" data-a="teilen">Teilen</button></div>
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
      <section class="card panel">
        <h2>Konto</h2>
        <p class="muted small" style="margin-top:0">Angemeldet als ${esc(state.session.user.email)}</p>
        <button class="btn" data-a="logout">Abmelden</button>
      </section>
    </div>`;
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
    try { await db(sb.from('menu_plan').update({ erledigt: p.erledigt }).eq('id', p.id)); } catch (e) { fehler(e); }
  },
  hinzu: (el) => pickerSheet(el.dataset.datum),
  eintrag: (el) => eintragSheet(state.plan.find((x) => x.id === el.dataset.id)),
  zufall: () => zufallSheet(),
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
        haushalt_id: state.haushalt.id, name, sortierung: state.kategorien.length + 1,
        farbe: zufallsFarbe(),
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
  logout: async () => {
    if (state.channel) sb.removeChannel(state.channel);
    Object.assign(state, { haushalt: null, kategorien: [], gerichte: [], plan: [], channel: null });
    await sb.auth.signOut();
  },
};

function zufallsFarbe() {
  const h = Math.floor(Math.random() * 360);
  // HSL -> Hex, damit <input type=color> den Wert anzeigen kann
  const a = 0.55 * 0.5; // Sättigung 55 %, Helligkeit 50 %
  const f = (n) => { const k = (n + h / 30) % 12;
    return Math.round(255 * (0.5 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}

app.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]');
  if (!el || !aktionen[el.dataset.a]) return;
  aktionen[el.dataset.a](el);
});
app.addEventListener('input', (ev) => {
  if (ev.target.id === 'suche') { state.suche = ev.target.value; render(); }
});
app.addEventListener('change', async (ev) => {
  const t = ev.target;
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
  onOpen && onOpen(sheetRoot);
}
function closeSheet() { sheetRoot.innerHTML = ''; sheetActions = {}; }

sheetRoot.addEventListener('click', (ev) => {
  if (ev.target.hasAttribute('data-close') || ev.target.closest('.sheet-head [data-close]')) { closeSheet(); return; }
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
    <span class="name">${g.favorit ? '★ ' : ''}${esc(g.name)}</span>
    <span class="meta">${s ? seitText(s.zuletzt) : 'noch nie'}</span>
  </button></li>`;
}

/** Vorschläge: Gerichte, die am längsten nicht mehr gekocht wurden (mit etwas Zufall). */
function vorschlaege(anzahl = 3) {
  const stats = statistik();
  const geplant = new Set(state.plan.filter((p) => p.datum >= todayIso()).map((p) => p.gericht_id));
  const desserts = new Set(state.kategorien.filter((k) => norm(k.name).startsWith('dessert')).map((k) => k.id));
  const kandidaten = state.gerichte
    .filter((g) => !geplant.has(g.id) && !desserts.has(g.kategorie_id))
    .map((g) => {
      const s = stats.get(g.id);
      const tage = s ? tageSeit(s.zuletzt) : 120;
      return { g, gewicht: Math.min(tage, 120) * (g.favorit ? 1.5 : 1) * (0.5 + Math.random()) };
    })
    .sort((a, b) => b.gewicht - a.gewicht);
  return kandidaten.slice(0, anzahl).map((x) => x.g);
}

async function eintragHinzufuegen(datum, titel, gerichtId) {
  const row = await db(sb.from('menu_plan').insert({
    haushalt_id: state.haushalt.id, datum, titel, gericht_id: gerichtId || null,
  }).select().single());
  state.plan.push(row);
  state.plan.sort((a, b) => a.datum.localeCompare(b.datum) || a.erstellt_am.localeCompare(b.erstellt_am));
  return row;
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
  const d = parseIso(datum);
  let suche = '';

  const liste = () => {
    const stats = statistik();
    const q = norm(suche);
    let html = '';
    if (!q) {
      html += `<div class="section-label">Vorschläge – länger nicht gegessen</div><ul class="pick-list">${vorschlaege().map((g) => pickItem(g, stats, 'suggest')).join('')}</ul>`;
    } else {
      const exakt = state.gerichte.some((g) => norm(g.name) === q);
      if (!exakt) {
        html += `<ul class="pick-list">
          <li><button class="pick free" data-a="frei">＋ «${esc(suche.trim())}» eintragen</button></li>
          <li><button class="pick free" data-a="frei-speichern">＋ «${esc(suche.trim())}» eintragen & in Gerichte speichern</button></li>
        </ul>`;
      }
    }
    const treffer = state.gerichte.filter((g) => !q || norm(g.name).includes(q));
    for (const k of [...state.kategorien, { id: null, name: 'Ohne Kategorie' }]) {
      const items = treffer.filter((g) => (g.kategorie_id || null) === k.id);
      if (!items.length) continue;
      html += `<div class="section-label">${esc(k.name)}</div><ul class="pick-list">${items.map((g) => pickItem(g, stats)).join('')}</ul>`;
    }
    return html || '<div class="empty">Keine Treffer</div>';
  };

  const fertig = (titel) => { closeSheet(); render(); toast(`«${titel}» für ${WT_LANG[d.getDay()]} geplant.`); };

  openSheet({
    titel: `${WT_LANG[d.getDay()]}, ${fmtKurz(d)}`,
    body: `<div class="field" style="position:sticky;top:0;background:var(--bg);padding-top:4px;z-index:1">
        <input class="input" id="pick-suche" type="search" placeholder="Suchen oder neues Gericht eingeben …" autocomplete="off">
      </div>
      <div id="pick-liste">${liste()}</div>`,
    actions: {
      waehlen: async (el) => {
        const g = gerichtById(el.dataset.id);
        try { await eintragHinzufuegen(datum, g.name, g.id); fertig(g.name); } catch (e) { fehler(e); }
      },
      frei: async () => {
        const t = suche.trim();
        try { await eintragHinzufuegen(datum, t, null); fertig(t); } catch (e) { fehler(e); }
      },
      'frei-speichern': async () => {
        const t = suche.trim();
        try {
          const g = await gerichtSpeichern({ name: t, kategorie_id: state.filterKat && state.filterKat !== 'fav' ? state.filterKat : null });
          await eintragHinzufuegen(datum, t, g.id);
          fertig(t);
        } catch (e) { fehler(e); }
      },
    },
    onOpen: (root) => {
      const inp = root.querySelector('#pick-suche');
      inp.addEventListener('input', () => { suche = inp.value; root.querySelector('#pick-liste').innerHTML = liste(); });
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); root.querySelector('#pick-liste .pick')?.click(); }
      });
      if (window.matchMedia('(min-width: 640px)').matches) inp.focus();
    },
  });
}

function eintragSheet(p) {
  if (!p) return;
  const g = p.gericht_id && gerichtById(p.gericht_id);
  openSheet({
    titel: 'Eintrag bearbeiten',
    body: `
      <div class="field"><label for="e-titel">Gericht</label><input class="input" id="e-titel" value="${esc(p.titel)}"></div>
      <div class="field"><label for="e-datum">Datum</label><input class="input" id="e-datum" type="date" value="${p.datum}"></div>
      <div class="field"><label for="e-notiz">Notiz</label><textarea class="input" id="e-notiz" placeholder="z.B. Beilage, wer kocht, Einkauf …">${esc(p.notiz || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="e-erledigt" ${p.erledigt ? 'checked' : ''}> Gekocht / erledigt</label>
      ${g ? `<p class="muted small">Verknüpft mit «${esc(g.name)}» aus den Gerichten.</p>` : `
        <div class="card panel" style="padding:12px">
          <div class="small muted" style="margin-bottom:6px">Noch nicht in der Gerichte-Sammlung</div>
          <div class="row"><select class="input grow" id="e-kat">${katOptionen(null)}</select><button class="btn" data-a="sammeln">Speichern</button></div>
        </div>`}`,
    foot: `<button class="btn danger" data-a="loeschen">Löschen</button><span class="spacer"></span><button class="btn primary" data-a="speichern">Speichern</button>`,
    actions: {
      speichern: async () => {
        const daten = {
          titel: document.getElementById('e-titel').value.trim() || p.titel,
          datum: document.getElementById('e-datum').value || p.datum,
          notiz: document.getElementById('e-notiz').value.trim() || null,
          erledigt: document.getElementById('e-erledigt').checked,
        };
        try {
          const row = await db(sb.from('menu_plan').update(daten).eq('id', p.id).select().single());
          Object.assign(p, row);
          state.plan.sort((a, b) => a.datum.localeCompare(b.datum) || a.erstellt_am.localeCompare(b.erstellt_am));
          closeSheet(); render();
        } catch (e) { fehler(e); }
      },
      loeschen: async () => {
        try {
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

function naechsterFreierTag() {
  const belegt = new Set(state.plan.map((p) => p.datum));
  let d = new Date();
  for (let i = 0; i < 60 && belegt.has(iso(d)); i++) d = addDays(d, 1);
  return iso(d);
}

function gerichtSheet(g, vorschlagName = '') {
  const stats = statistik();
  const s = g && stats.get(g.id);
  const kategorie = g ? g.kategorie_id : (state.filterKat && state.filterKat !== 'fav' ? state.filterKat : null);
  const verlauf = g ? state.plan.filter((p) => p.gericht_id === g.id).slice(-5).reverse() : [];
  openSheet({
    titel: g ? 'Gericht' : 'Neues Gericht',
    body: `
      <div class="field"><label for="g-name">Name</label><input class="input" id="g-name" value="${esc(g ? g.name : vorschlagName)}"></div>
      <div class="field"><label for="g-kat">Kategorie</label><select class="input" id="g-kat">${katOptionen(kategorie)}</select></div>
      <div class="field"><label for="g-notiz">Notiz / Zutaten / Rezept-Link</label><textarea class="input" id="g-notiz">${esc(g?.notiz || '')}</textarea></div>
      <label class="check"><input type="checkbox" id="g-fav" ${g?.favorit ? 'checked' : ''}> ★ Favorit</label>
      ${g ? `
        <div class="card panel" style="padding:12px;margin-bottom:12px">
          <div class="small muted">Zuletzt gegessen: <strong>${s ? `${seitText(s.zuletzt)} (${fmtKurz(parseIso(s.zuletzt))})` : 'noch nie'}</strong>${s ? ` · ${s.anzahl}× insgesamt` : ''}</div>
          ${verlauf.length ? `<div class="small muted" style="margin-top:4px">Geplant/gegessen: ${verlauf.map((p) => fmtKurz(parseIso(p.datum))).join(', ')}</div>` : ''}
        </div>
        <div class="field"><label for="g-datum">Einplanen am</label>
          <div class="row"><input class="input grow" id="g-datum" type="date" value="${naechsterFreierTag()}"><button class="btn" data-a="einplanen">Einplanen</button></div>
        </div>` : ''}`,
    foot: `${g ? '<button class="btn danger" data-a="loeschen">Löschen</button>' : ''}<span class="spacer"></span><button class="btn primary" data-a="speichern">Speichern</button>`,
    actions: {
      speichern: async () => {
        const name = document.getElementById('g-name').value.trim();
        if (!name) { toast('Bitte einen Namen eingeben.'); return; }
        try {
          await gerichtSpeichern({
            name,
            kategorie_id: document.getElementById('g-kat').value || null,
            notiz: document.getElementById('g-notiz').value.trim() || null,
            favorit: document.getElementById('g-fav').checked,
          }, g?.id);
          closeSheet(); render(); toast('Gespeichert.');
        } catch (e) { fehler(e); }
      },
      einplanen: async () => {
        const datum = document.getElementById('g-datum').value;
        if (!datum) return;
        try {
          await eintragHinzufuegen(datum, g.name, g.id);
          closeSheet(); render();
          const d = parseIso(datum);
          toast(`Für ${WT_LANG[d.getDay()]}, ${fmtKurz(d)} geplant.`);
        } catch (e) { fehler(e); }
      },
      loeschen: async () => {
        if (!confirm(`«${g.name}» wirklich löschen? Bereits geplante Einträge bleiben erhalten.`)) return;
        try {
          await db(sb.from('menu_gerichte').delete().eq('id', g.id));
          state.gerichte = state.gerichte.filter((x) => x.id !== g.id);
          state.plan.forEach((p) => { if (p.gericht_id === g.id) p.gericht_id = null; });
          closeSheet(); render(); toast('Gelöscht.');
        } catch (e) { fehler(e); }
      },
    },
  });
}

function zufallSheet() {
  const stats = statistik();
  const tag = naechsterFreierTag();
  const d = parseIso(tag);
  const zeigen = () => vorschlaege(5).map((g) => pickItem(g, stats, 'suggest')).join('');
  openSheet({
    titel: 'Was kochen wir?',
    body: `<p class="muted small" style="margin-top:0">Gerichte, die ihr länger nicht mehr gegessen habt. Antippen plant es für den nächsten freien Tag ein (<strong>${WT_LANG[d.getDay()]}, ${fmtKurz(d)}</strong>).</p>
      <ul class="pick-list" id="zufall-liste">${zeigen()}</ul>`,
    foot: `<span class="spacer"></span><button class="btn" data-a="neu-mischen">🎲 Neu mischen</button>`,
    actions: {
      'neu-mischen': () => { document.getElementById('zufall-liste').innerHTML = zeigen(); },
      waehlen: async (el) => {
        const g = gerichtById(el.dataset.id);
        try {
          await eintragHinzufuegen(tag, g.name, g.id);
          state.weekStart = mondayOf(d);
          state.tab = 'plan';
          closeSheet(); render(); toast(`«${g.name}» für ${WT_LANG[d.getDay()]} geplant.`);
        } catch (e) { fehler(e); }
      },
    },
  });
}

/* ---------- Offline-Unterstützung (App-Hülle) ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}
