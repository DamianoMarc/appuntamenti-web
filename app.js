(() => {
'use strict';

/* =====================================================
   Utilità
   ===================================================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch {} },
  del(k){ try { localStorage.removeItem(k); } catch {} },
  json(k, def){ try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } }
};
// sessionStorage: il token admin sparisce alla chiusura della scheda (meno esposto di localStorage)
const sess = {
  get(k){ try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { sessionStorage.setItem(k,v); } catch {} },
  del(k){ try { sessionStorage.removeItem(k); } catch {} }
};
const TZ = 'Europe/Rome';
const fmtTime = d => d.toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit', timeZone:TZ});
const fmtDate = d => d.toLocaleDateString('it-IT', {weekday:'short', day:'numeric', month:'short', timeZone:TZ});
const fmtDateLong = d => d.toLocaleDateString('it-IT', {weekday:'long', day:'numeric', month:'long', timeZone:TZ});
const isoDay = d => new Intl.DateTimeFormat('en-CA', {timeZone:TZ}).format(d);
const todayISO = () => isoDay(new Date());
const hourOf = d => parseInt(d.toLocaleTimeString('it-IT', {hour:'2-digit', hour12:false, timeZone:TZ}), 10) % 24;
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hm = t => t == null ? '' : (Array.isArray(t) ? t.slice(0,2).map(n => String(n).padStart(2,'0')).join(':') : String(t).slice(0,5));
const eur = n => n == null ? '–' : Number(n).toLocaleString('it-IT', {style:'currency', currency:'EUR'});
const STATI = {CONFERMATO:'Confermato', COMPLETATO:'Completato', CANCELLATO:'Cancellato', NO_SHOW:'Non presentato'};
const DAYS = [['MONDAY','Lunedì'],['TUESDAY','Martedì'],['WEDNESDAY','Mercoledì'],['THURSDAY','Giovedì'],['FRIDAY','Venerdì'],['SATURDAY','Sabato'],['SUNDAY','Domenica']];
const dayName = k => (DAYS.find(d => d[0] === k) || [k,k])[1];

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = '', 4800);
}
async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message || String(e), 'bad'); }
  finally { if (btn) btn.disabled = false; }
}
function fillSelect(sel, items, label, placeholder) {
  sel.innerHTML = `<option value="">${esc(placeholder)}</option>` +
    items.map(i => `<option value="${esc(i.id)}">${esc(label(i))}</option>`).join('');
  sel.disabled = items.length === 0;
  if (items.length === 1) sel.value = items[0].id;
}
function confirmDlg(title, text, okLabel = 'Conferma') {
  return new Promise(resolve => {
    const d = $('#dlgConfirm');
    $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfOk').textContent = okLabel;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), {once: true});
    d.showModal();
  });
}
function downloadFile(name, mime, content) {
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* =====================================================
   Stato + API
   ===================================================== */
const DEFAULT_API = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || 'http://localhost:8080';
const REQUIRE_LOGIN = !(window.APP_CONFIG && window.APP_CONFIG.REQUIRE_CUSTOMER_LOGIN === false);
// pulizia: le vecchie versioni salvavano il token admin in localStorage
['token','strutturaId','strutturaNome'].forEach(store.del);
const S = {
  base: store.get('api') || DEFAULT_API,
  token: sess.get('token'), strutturaId: sess.get('strutturaId'), strutturaNome: sess.get('strutturaNome'),
  c: {token: store.get('ctoken'), nome: store.get('cnome') || '', email: store.get('cemail') || ''},  // account cliente
  sound: store.get('sound') === '1'
};
const baseUrl = () => S.base.replace(/\/$/, '');

async function api(path, {method = 'GET', body, auth = false} = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // auth === true -> token admin; auth === 'cliente' -> token dell'account cliente
  const tok = auth === 'cliente' ? S.c.token : (auth ? S.token : null);
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  let res;
  try {
    res = await fetch(baseUrl() + path, {method, headers, body: body !== undefined ? JSON.stringify(body) : undefined});
  } catch {
    throw new Error('Backend non raggiungibile su ' + S.base + '. Controlla che sia avviato (⚙ Impostazioni per cambiare indirizzo).');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && auth === 'cliente') clienteLogout('Sessione scaduta: accedi di nuovo.');
    else if (res.status === 401 && auth) logout('Sessione scaduta: accedi di nuovo.');
    const msg = (data && data.message) || (typeof data === 'string' && data) || ('Errore ' + res.status);
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

async function checkHealth() {
  const el = $('#status');
  try {
    const r = await fetch(baseUrl() + '/api/health');
    el.className = 'status ' + (r.ok ? 'on' : 'off');
    el.lastElementChild.textContent = r.ok ? 'online' : 'errore ' + r.status;
  } catch {
    el.className = 'status off';
    el.lastElementChild.textContent = 'non raggiungibile';
  }
}

/* =====================================================
   Navigazione
   ===================================================== */
let MODE = 'prenota';
// nome nell'intestazione: la struttura (admin loggato o cliente), non un nome generico
function paintBrand() {
  const el = $('.brand > span:last-child'); if (!el) return;
  el.textContent = (MODE === 'admin' && S.token && S.strutturaNome) ? S.strutturaNome : ((C.strutture[0] && C.strutture[0].nome) || 'Appuntamenti');
}
// Cosa si vede dipende da chi è: i clienti non vedono mai navigazione, pulsanti o schermate di gestione.
// (È solo interfaccia: la protezione vera sono i ruoli sul backend, vedi BACKEND.md §4.6.)
function paintShell() {
  const inAdmin = MODE === 'admin', logged = inAdmin && !!S.token;
  document.body.classList.toggle('admin-mode', inAdmin);
  document.body.classList.toggle('admin-in', logged);
  const fab = $('#fabNew'); if (fab) fab.hidden = !(logged && A.view === 'appuntamenti');
  // stato del backend e impostazioni: solo per chi ha già fatto l'accesso di gestione
  $('#status').hidden = !logged; $('#btnSettings').hidden = !logged;
}
function setMode(m) {
  MODE = m;
  paintShell();
  paintBrand();
  $$('[data-mode]').forEach(b => b.setAttribute('aria-current', b.dataset.mode === m));
  $('#viewPrenota').hidden = m !== 'prenota';
  $('#viewMie').hidden = m !== 'mie';
  $('#viewAdmin').hidden = m !== 'admin';
  if (m === 'admin') renderAdmin();
  if (m === 'mie') run(null, renderMie);
  try { history.replaceState(null, '', '#' + m); } catch {}
  window.scrollTo({top: 0});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshMineCount(); if (MODE === 'mie') run(null, renderMie); } });
document.addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });

/* ---- impostazioni ---- */
$('#btnSettings').onclick = () => {
  $('#apiUrl').value = S.base; $('#optSound').checked = S.sound;
  $('#dlgSettings').returnValue = ''; $('#dlgSettings').showModal();
};
$('#dlgSettings').addEventListener('close', e => {
  if (e.target.returnValue !== 'ok') return;
  const v = $('#apiUrl').value.trim() || DEFAULT_API;
  const changed = v !== S.base;
  S.base = v; store.set('api', v);
  S.sound = $('#optSound').checked; store.set('sound', S.sound ? '1' : '0');
  checkHealth();
  if (changed) {
    C.strutturaId = ''; run(null, loadStrutture);
    if (S.token) logout('Indirizzo cambiato: accedi di nuovo.');
    if (S.c.token) clienteLogout('Indirizzo cambiato: accedi di nuovo.');
  }
  toast('Impostazioni salvate', 'ok');
});

/* =====================================================
   CLIENTE — prenotazione
   ===================================================== */
const C = {strutture: [], strutturaId: '', slots: [], slot: null, giorno: todayISO(), req: 0};

/* ---- account cliente (registrazione, accesso, recupero password) ---- */
const AUTH_TITLES = {login: 'Accedi', register: 'Crea il tuo account', forgot: 'Password dimenticata', reset: 'Scegli una nuova password', account: 'Il mio account'};
let resetToken = null;
const strongEnough = p => p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);

function authMsg(kind, msg) {
  const e = $('#authErr'), o = $('#authOk');
  e.hidden = !(kind === 'err' && msg); o.hidden = !(kind === 'ok' && msg);
  (kind === 'ok' ? o : e).textContent = msg || '';
}
function authPane(p) {
  $$('#dlgAuth [data-pane]').forEach(el => el.hidden = el.dataset.pane !== p);
  $('#authTitle').textContent = AUTH_TITLES[p]; authMsg('', '');
  const f = $(`#dlgAuth [data-pane="${p}"] input:not([type=checkbox])`);
  if (f) setTimeout(() => f.focus(), 30);
}
function openAuth(p) {
  if (!p || (S.c.token && (p === 'login' || p === 'register'))) p = S.c.token ? 'account' : 'login';
  if (p === 'account') { $('#acNome').textContent = S.c.nome; $('#acEmail').textContent = S.c.email; }
  authPane(p);
  const d = $('#dlgAuth'); if (!d.open) d.showModal();
}
async function authRun(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { authMsg('err', e.message || String(e)); }
  finally { btn.disabled = false; }
}
function updateAccountBtn() {
  const b = $('#btnAccount');
  b.hidden = !REQUIRE_LOGIN;      // senza account cliente il pulsante non serve
  b.textContent = S.c.token ? ('👤 ' + (S.c.nome.split(' ')[0] || 'Account')) : 'Accedi';
  b.dataset.auth = S.c.token ? 'account' : 'login';
}
function onCustomerChange() {
  if (C.slot != null && C.slots[C.slot] && $('#bookDone').hidden) showBookForm(); else if ($('#bookDone').hidden) resetBooking();
  refreshMineCount();
  if (MODE === 'mie') run(null, renderMie);
}
function setCustomer(r) {
  S.c = {token: r.token, nome: r.nome || '', email: r.email || ''};
  store.set('ctoken', S.c.token); store.set('cnome', S.c.nome); store.set('cemail', S.c.email);
  updateAccountBtn();
}
function clienteLogout(msg) {
  S.c = {token: null, nome: '', email: ''};
  ['ctoken', 'cnome', 'cemail'].forEach(store.del);
  updateAccountBtn();
  if (msg) toast(msg, 'bad');
  onCustomerChange();
}

document.addEventListener('click', e => {
  const a = e.target.closest('[data-auth]'); if (a) { openAuth(a.dataset.auth); return; }
  const g = e.target.closest('[data-goto]'); if (g) authPane(g.dataset.goto);
});
document.addEventListener('change', e => {
  const t = e.target.closest('[data-showpw]');
  if (t) $$('input[data-pw]', t.closest('form')).forEach(i => i.type = t.checked ? 'text' : 'password');
});
$('#authClose').onclick = () => $('#dlgAuth').close();
$('#dlgAuth').addEventListener('close', () => $$('#dlgAuth input[data-pw]').forEach(i => { i.value = ''; i.type = 'password'; }));

$('#paneLogin').onsubmit = e => {
  e.preventDefault(); authMsg('', '');
  const email = $('#lgEmail').value.trim(), password = $('#lgPass').value;
  if (!email || !password) return authMsg('err', 'Inserisci email e password.');
  authRun($('#lgBtn'), async () => {
    const r = await api('/api/clienti/login', {method: 'POST', body: {email, password}});
    setCustomer(r); $('#dlgAuth').close();
    toast('Accesso effettuato', 'ok'); onCustomerChange();
  });
};
$('#paneRegister').onsubmit = e => {
  e.preventDefault(); authMsg('', '');
  const nome = $('#rgNome').value.trim(), email = $('#rgEmail').value.trim(), tel = $('#rgTel').value.trim();
  const p1 = $('#rgPass').value, p2 = $('#rgPass2').value;
  if (nome.length < 2) return authMsg('err', 'Inserisci nome e cognome.');
  if (!email || !$('#rgEmail').checkValidity()) return authMsg('err', 'Inserisci un indirizzo email valido.');
  if (!strongEnough(p1)) return authMsg('err', 'La password deve avere almeno 10 caratteri, con lettere e numeri.');
  if (p1 !== p2) return authMsg('err', 'Le due password non coincidono.');
  if (!$('#rgPriv').checked || !$('#rgTratt').checked) return authMsg('err', 'Servono entrambi i consensi.');
  authRun($('#rgBtn'), async () => {
    const r = await api('/api/clienti/registrazione', {method: 'POST', body: {
      nome, email, telefono: tel || null, password: p1, privacyAccettata: true, trattamentoDatiAccettato: true}});
    $('#paneRegister').reset();
    authPane('login'); $('#lgEmail').value = email;
    authMsg('ok', (r && r.message) || 'Account creato. Controlla la tua email e conferma l’indirizzo, poi accedi.');
  });
};
$('#paneForgot').onsubmit = e => {
  e.preventDefault(); authMsg('', '');
  const email = $('#fgEmail').value.trim();
  if (!email || !$('#fgEmail').checkValidity()) return authMsg('err', 'Inserisci un indirizzo email valido.');
  authRun($('#fgBtn'), async () => {
    await api('/api/clienti/password-dimenticata', {method: 'POST', body: {email}});
    authMsg('ok', 'Se l’indirizzo è registrato, ti abbiamo inviato un’email con il link per scegliere una nuova password.');
  });
};
$('#paneReset').onsubmit = e => {
  e.preventDefault(); authMsg('', '');
  const p1 = $('#rsPass').value, p2 = $('#rsPass2').value;
  if (!resetToken) return authMsg('err', 'Link non valido: richiedine uno nuovo.');
  if (!strongEnough(p1)) return authMsg('err', 'La password deve avere almeno 10 caratteri, con lettere e numeri.');
  if (p1 !== p2) return authMsg('err', 'Le due password non coincidono.');
  authRun($('#rsBtn'), async () => {
    await api('/api/clienti/password-reset', {method: 'POST', body: {token: resetToken, nuovaPassword: p1}});
    resetToken = null; $('#paneReset').reset();
    authPane('login'); authMsg('ok', 'Password aggiornata. Ora puoi accedere.');
  });
};
$('#acMie').onclick = () => { $('#dlgAuth').close(); setMode('mie'); };
$('#acLogout').onclick = () => { $('#dlgAuth').close(); clienteLogout(); toast('Sei uscito dal tuo account', 'ok'); };
$('#acDelete').onclick = async () => {
  $('#dlgAuth').close();
  if (!await confirmDlg('Eliminare il tuo account?', 'Verranno cancellati i tuoi dati personali e le prenotazioni future saranno annullate. Non si può annullare.', 'Elimina account')) return;
  run(null, async () => {
    await api('/api/clienti/me', {method: 'DELETE', auth: 'cliente'});
    clienteLogout(); toast('Account eliminato', 'ok');
  });
};

// Il cliente vede UNA sola struttura: quella del link (?s=ID). Nessun elenco delle altre.
// Se il link non c'è (es. app installata) si usa l'ultima struttura aperta su questo dispositivo.
async function loadStrutture() {
  const sel = $('#cStruttura');
  const fromLink = new URLSearchParams(location.search).get('s');
  const wanted = fromLink || store.get('lastStruttura');
  const title = $('#strutturaTitolo'), msg = $('#strutturaMsg');
  const notFound = () => {
    C.strutture = []; sel.innerHTML = '<option value="">–</option>';
    store.del('lastStruttura');
    title.textContent = 'Prenotazioni online';
    msg.textContent = 'Per prenotare usa il link o il QR code che ti ha dato la struttura.';
    $('#cardGiorno').hidden = true;
  };
  if (!wanted) return notFound();
  let s = null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted);
  try {
    s = await api((isUuid ? '/api/strutture/' : '/api/strutture/slug/') + encodeURIComponent(wanted));
  } catch (e) {
    if (String(e.message).startsWith('Backend non raggiungibile')) { sel.innerHTML = '<option value="">Errore</option>'; throw e; }
    s = null;   // 404 / id non valido: nessun elenco di altre strutture come ripiego
  }
  if (!s) return notFound();
  C.strutture = [s];
  sel.innerHTML = `<option value="${esc(s.id)}">${esc(s.nome)}</option>`;
  sel.value = s.id;
  $('#cardGiorno').hidden = false;
  title.textContent = s.nome;
  msg.textContent = 'Scegli servizio e orario. Ricevi subito un codice per gestire o annullare la prenotazione.';
  document.title = s.nome + ' – Prenotazioni';
  paintBrand();
  await selectStruttura(s.id);
}

async function selectStruttura(id) {
  C.strutturaId = id; C.slots = []; C.slot = null; resetBooking();
  $('#cSlots').innerHTML = '';
  if (!id) { fillSelect($('#cRisorsa'), [], x => x, '–'); fillSelect($('#cTipo'), [], x => x, '–'); return; }
  store.set('lastStruttura', id);  const q = encodeURIComponent(id);
  const [ris, tipi] = await Promise.all([api('/api/risorse/pubbliche?strutturaId=' + q), api('/api/tipi-servizio?strutturaId=' + q)]);
  fillSelect($('#cTipo'), tipi, t => `${t.nome} · ${t.durataMinuti} min${t.prezzo != null ? ' · ' + eur(t.prezzo) : ''}`, tipi.length ? 'Scegli un servizio' : 'Nessun servizio attivo');
  fillSelect($('#cRisorsa'), ris, r => `${r.nome} (${r.tipo})`, ris.length ? 'Scegli' : 'Nessuna risorsa attiva');
  await loadSlots();
}
$('#cStruttura').onchange = e => run(null, () => selectStruttura(e.target.value));
$('#cTipo').onchange = () => run(null, loadSlots);
$('#cRisorsa').onchange = () => run(null, loadSlots);

/* ---- striscia giorni ---- */
// condiviso tra prenotazione cliente e "Nuovo appuntamento" dell'admin: stesso aspetto, stesso comportamento
function stripHtml(sel) {
  const t = todayISO();
  return Array.from({length: 14}, (_, i) => addDays(t, i)).map(iso => {
    const d = new Date(iso + 'T12:00:00Z');
    const wd = d.toLocaleDateString('it-IT', {weekday:'short', timeZone:'UTC'}).replace('.', '');
    return `<button type="button" class="day" data-d="${iso}" aria-pressed="${iso === sel}"><small>${esc(wd)}</small><b>${d.getUTCDate()}</b><small>${esc(d.toLocaleDateString('it-IT', {month:'short', timeZone:'UTC'}).replace('.', ''))}</small></button>`;
  }).join('');
}
function renderStrip() {
  $('#dateStrip').innerHTML = stripHtml(C.giorno);
  $('#cData').value = C.giorno; $('#cData').min = todayISO();
}
$('#dateStrip').onclick = e => {
  const b = e.target.closest('.day'); if (!b) return;
  C.giorno = b.dataset.d; renderStrip(); run(null, loadSlots);
};
$('#cData').onchange = e => {
  if (!e.target.value) return;
  C.giorno = e.target.value; renderStrip(); run(null, loadSlots);
};

/* ---- slot ---- */
async function loadSlots() {
  const r = $('#cRisorsa').value, t = $('#cTipo').value, d = C.giorno;
  C.slot = null; resetBooking();
  const box = $('#cSlots');
  if (!C.strutturaId || !r || !t) {
    C.slots = [];
    box.innerHTML = C.strutturaId ? '<p class="empty">Scegli servizio e risorsa per vedere gli orari.</p>' : '';
    return;
  }
  const my = ++C.req;
  box.innerHTML = '<div class="slots">' + '<div class="skeleton"></div>'.repeat(8) + '</div>';
  let slots;
  try {
    slots = await api(`/api/disponibilita?risorsaId=${encodeURIComponent(r)}&data=${d}&tipoServizioId=${encodeURIComponent(t)}`);
  } catch (e) { if (my === C.req) box.innerHTML = '<p class="empty">Non riesco a caricare gli orari.</p>'; throw e; }
  if (my !== C.req) return;
  C.slots = slots; renderSlots();
}

function slotsHtml(slots, sel, giorno) {
  if (!slots.length) return '<p class="empty">Nessun orario per questo giorno. Prova un altro giorno o un’altra risorsa.</p>';
  const now = Date.now();
  const groups = [['Mattina', h => h < 13], ['Pomeriggio', h => h >= 13 && h < 18], ['Sera', h => h >= 18]];
  let any = false, html = '';
  for (const [title, test] of groups) {
    const items = slots.map((s, i) => ({s, i, d: new Date(s.inizio)})).filter(x => test(hourOf(x.d)));
    if (!items.length) continue;
    any = true;
    html += `<div class="group-title">${title}</div><div class="slots">` + items.map(({s, i, d}) => {
      const off = !s.disponibile || d.getTime() < now;
      return `<button type="button" class="slot" data-i="${i}" ${off ? 'disabled' : ''} aria-pressed="${sel === i}">${fmtTime(d)}</button>`;
    }).join('') + '</div>';
  }
  const free = slots.filter(s => s.disponibile && new Date(s.inizio).getTime() >= now).length;
  return (any ? `<p class="small muted" style="margin:6px 0 0">${free ? free + ' orari liberi' : 'Tutto occupato per questo giorno'} · ${esc(fmtDateLong(new Date(giorno + 'T12:00:00Z')).replace(/^./, c => c.toUpperCase()))}</p>` : '') + html;
}
function renderSlots() { $('#cSlots').innerHTML = slotsHtml(C.slots, C.slot, C.giorno); }
$('#cSlots').onclick = e => {
  const b = e.target.closest('.slot'); if (!b || b.disabled) return;
  C.slot = Number(b.dataset.i); renderSlots(); showBookForm();
  if (window.matchMedia('(max-width:900px)').matches) $('#bookCard').scrollIntoView({behavior:'smooth', block:'start'});
};

function resetBooking() {
  $('#bookEmpty').hidden = false; $('#bookForm').hidden = true; $('#bookDone').hidden = true; $('#bookLogin').hidden = true;
}
function showBookForm() {
  const s = C.slots[C.slot], i = new Date(s.inizio), f = new Date(s.fine);
  const ris = $('#cRisorsa').selectedOptions[0].textContent, tipo = $('#cTipo').selectedOptions[0].textContent;
  const str = $('#cStruttura').selectedOptions[0].textContent;
  const html = `<b>${esc(fmtDateLong(i))}</b><br>${fmtTime(i)}–${fmtTime(f)}<br>${esc(tipo)}<br>${esc(ris)} · ${esc(str)}`;
  $('#bookSummary').innerHTML = html; $('#bookLoginSummary').innerHTML = html;
  $('#bookEmpty').hidden = true; $('#bookDone').hidden = true;
  const gated = REQUIRE_LOGIN && !S.c.token;       // senza account si vede solo l'invito ad accedere
  $('#bookLogin').hidden = !gated; $('#bookForm').hidden = gated;
  if (gated) return;
  const saved = store.json('contatto', {});
  if (S.c.token) {
    $('#bNome').value = S.c.nome || $('#bNome').value;
    $('#bEmail').value = S.c.email || ''; $('#bEmail').readOnly = true;   // l'email è quella dell'account
  } else {
    $('#bEmail').readOnly = false;
    if (!$('#bNome').value) $('#bNome').value = saved.nome || '';
    if (!$('#bEmail').value) $('#bEmail').value = saved.email || '';
  }
  if (!$('#bTel').value) $('#bTel').value = saved.tel || '';
}

function bookError(msg) {
  const el = $('#bErr'); el.textContent = msg; el.hidden = !msg;
}
$('#bookForm').onsubmit = e => {
  e.preventDefault(); bookError('');
  if (REQUIRE_LOGIN && !S.c.token) { openAuth('login'); return; }
  const nome = $('#bNome').value.trim(), tel = $('#bTel').value.trim(), email = $('#bEmail').value.trim();
  $$('#bookForm input').forEach(i => i.classList.remove('invalid'));
  if (nome.length < 2) { $('#bNome').classList.add('invalid'); return bookError('Inserisci nome e cognome.'); }
  if (tel.replace(/\D/g, '').length < 6) { $('#bTel').classList.add('invalid'); return bookError('Inserisci un numero di telefono valido.'); }
  if (email && !$('#bEmail').checkValidity()) { $('#bEmail').classList.add('invalid'); return bookError('L’indirizzo email non sembra valido.'); }
  if (!$('#bPriv').checked || !$('#bTratt').checked) return bookError('Per prenotare servono entrambi i consensi.');
  run($('#bSubmit'), async () => {
    const s = C.slots[C.slot];
    const info = {
      strutturaId: C.strutturaId, strutturaNome: $('#cStruttura').selectedOptions[0].textContent,
      servizio: $('#cTipo').selectedOptions[0].textContent, risorsa: $('#cRisorsa').selectedOptions[0].textContent,
      risorsaId: $('#cRisorsa').value, tipoServizioId: $('#cTipo').value,
      inizio: s.inizio, fine: s.fine
    };
    const res = await api('/api/appuntamenti', {method: 'POST', auth: REQUIRE_LOGIN ? 'cliente' : false, body: {
      strutturaId: C.strutturaId,
      risorsaId: $('#cRisorsa').value,
      tipoServizioId: $('#cTipo').value,
      inizio: s.inizio,
      nomeCliente: nome, telefono: tel,
      email: email || null,
      note: $('#bNote').value.trim() || null,
      privacyAccettata: true,
      trattamentoDatiAccettato: true
    }});
    store.set('contatto', JSON.stringify({nome, tel, email}));
    addMine({...info, codice: res.codice, stato: 'CONFERMATO'});
    $('#bookForm').hidden = true; $('#bookLogin').hidden = true;
    const box = $('#bookDone'); box.hidden = false;
    const i = new Date(s.inizio);
    box.innerHTML = `<div class="tick" aria-hidden="true">✓</div><h3>Prenotazione confermata</h3>
      <p class="muted small" style="margin-top:4px">${esc(fmtDateLong(i))}, ${fmtTime(i)}</p>
      <div class="code">${esc(res.codice)}</div>
      <p class="small muted">${REQUIRE_LOGIN ? 'Trovi la prenotazione anche in «Le mie prenotazioni».' : 'Conserva il codice: serve per annullare. L’ho salvato anche in «Le mie prenotazioni».'}</p>
      <div class="acts"><button class="btn ghost" type="button" id="bIcs">Aggiungi al calendario</button>
      <button class="btn ghost" type="button" id="bCopy">Copia codice</button>
      <button class="btn" type="button" id="bNew">Nuova prenotazione</button></div>`;
    $('#bIcs').onclick = () => downloadIcs({...info, codice: res.codice});
    $('#bCopy').onclick = () => { navigator.clipboard?.writeText(res.codice).then(() => toast('Codice copiato', 'ok'), () => toast('Copia non riuscita', 'bad')); };
    $('#bNew').onclick = () => { $('#bookForm').reset(); $('#bNome').value = ''; resetBooking(); window.scrollTo({top: 0, behavior: 'smooth'}); };
    $('#bPriv').checked = $('#bTratt').checked = false;
    C.slot = null;
    await loadSlots().catch(() => {});
    $('#bookEmpty').hidden = true; $('#bookForm').hidden = true; box.hidden = false;
  });
};

function downloadIcs(b) {
  const z = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const t = s => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Appuntamenti//IT', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${b.codice}@appuntamenti`, `DTSTAMP:${z(new Date().toISOString())}`,
    `DTSTART:${z(b.inizio)}`, `DTEND:${z(b.fine)}`,
    `SUMMARY:${t(b.servizio)} – ${t(b.strutturaNome)}`,
    `DESCRIPTION:${t('Codice prenotazione: ' + b.codice + '\n' + b.risorsa)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', 'DESCRIPTION:Promemoria appuntamento', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  downloadFile(`appuntamento-${b.codice}.ics`, 'text/calendar;charset=utf-8', ics);
}

/* =====================================================
   CLIENTE — le mie prenotazioni
   Con account obbligatorio arrivano dal server (collegate all'utente);
   altrimenti restano solo su questo dispositivo.
   ===================================================== */
const getMine = () => store.json('mie', []);
const setMine = a => { store.set('mie', JSON.stringify(a.slice(0, 50))); refreshMineCount(); };
function addMine(b) {
  if (REQUIRE_LOGIN) { refreshMineCount(); return; }
  setMine([b, ...getMine().filter(x => !(x.codice === b.codice && x.strutturaId === b.strutturaId))]);
}
// Allinea le prenotazioni salvate sul dispositivo con il database: se uno slot che risulta
// prenotato è tornato libero, l'appuntamento è stato annullato/eliminato dalla gestione.
async function syncMine() {
  if (REQUIRE_LOGIN) return false;
  const all = getMine(), cache = new Map(); let changed = false;
  const key = b => `${b.risorsaId}|${b.tipoServizioId}|${isoDay(new Date(b.inizio))}`;
  for (const b of all) {
    if (!isUpcoming(b) || !b.risorsaId || !b.tipoServizioId || cache.has(key(b))) continue;
    cache.set(key(b), api(`/api/disponibilita?risorsaId=${encodeURIComponent(b.risorsaId)}&data=${isoDay(new Date(b.inizio))}&tipoServizioId=${encodeURIComponent(b.tipoServizioId)}`).catch(() => null));
  }
  for (const b of all) {
    if (!isUpcoming(b) || !cache.has(key(b))) continue;
    const slots = await cache.get(key(b)); if (!Array.isArray(slots)) continue;
    const t = new Date(b.inizio).getTime(), s = slots.find(x => new Date(x.inizio).getTime() === t);
    if (s && s.disponibile) { b.stato = 'CANCELLATO'; changed = true; }
  }
  if (changed) setMine(all);
  return changed;
}
const isUpcoming = b => b.stato === 'CONFERMATO' && new Date(b.fine).getTime() > Date.now();
function paintCount(n) { const c = $('#mieCount'); c.textContent = n; c.hidden = !n; }
async function fetchMine() {
  const r = await api('/api/clienti/me/appuntamenti', {auth: 'cliente'});
  return (r || []).map(a => ({id: a.id, codice: a.codice, strutturaId: a.strutturaId, strutturaNome: a.strutturaNome || '',
    servizio: a.tipoServizioNome, risorsa: a.risorsaNome, inizio: a.inizio, fine: a.fine, stato: a.status}));
}
async function refreshMineCount() {
  if (!REQUIRE_LOGIN) { await syncMine().catch(() => {}); return paintCount(getMine().filter(isUpcoming).length); }
  if (!S.c.token) return paintCount(0);
  try { paintCount((await fetchMine()).filter(isUpcoming).length); } catch {}
}

let MIE = [];
async function renderMie() {
  const box = $('#mieList');
  $('#cardCodice').hidden = REQUIRE_LOGIN;
  if (REQUIRE_LOGIN) {
    if (!S.c.token) {
      MIE = [];
      box.innerHTML = '<div class="card"><p class="empty">Accedi per vedere e gestire le tue prenotazioni.</p><button class="btn" type="button" data-auth="login">Accedi o registrati</button></div>';
      return;
    }
    box.innerHTML = '<div class="card"><div class="skeleton"></div></div>';
    paintMie(await fetchMine());
  } else {
    paintMie(getMine());
    if (await syncMine().catch(() => false)) paintMie(getMine());
  }
}

function paintMie(list) {
  MIE = list;
  const box = $('#mieList');
  if (!list.length) { box.innerHTML = '<div class="card"><p class="empty">Nessuna prenotazione.</p><button class="btn" type="button" data-mode="prenota">Prenota ora</button></div>'; return; }
  list = [...list].sort((a, b) => new Date(a.inizio) - new Date(b.inizio));
  const up = list.filter(isUpcoming), old = list.filter(b => !isUpcoming(b)).reverse();
  const row = (b, past) => {
    const i = new Date(b.inizio);
    const ids = `data-c="${esc(b.codice)}" data-s="${esc(b.strutturaId)}"`;
    return `<div class="card booking ${past ? 'past' : ''}">
      <div><div class="when">${esc(fmtDateLong(i))}, ${fmtTime(i)}</div>
        <div>${esc(b.servizio)}</div><div class="meta">${esc(b.risorsa)}${b.strutturaNome ? ' · ' + esc(b.strutturaNome) : ''} · codice <code>${esc(b.codice)}</code></div></div>
      <div class="acts">${past
        ? `<span class="badge ${b.stato === 'CANCELLATO' ? 's-off' : 's-info'}">${b.stato === 'CANCELLATO' ? 'Annullata' : 'Passata'}</span>${REQUIRE_LOGIN ? '' : `<button class="btn ghost sm" type="button" data-mine="rm" ${ids}>Rimuovi</button>`}`
        : `<button class="btn ghost sm" type="button" data-mine="ics" ${ids}>Calendario</button>
           <button class="btn danger sm" type="button" data-mine="cancel" ${ids}>Annulla</button>`}</div></div>`;
  };
  box.innerHTML = (up.length ? '<div class="group-title" style="margin-top:0">In programma</div>' + up.map(b => row(b, false)).join('') : '')
    + (old.length ? '<div class="group-title">Storico</div>' + old.map(b => row(b, true)).join('') : '');
}
$('#mieList').addEventListener('click', e => {
  const b = e.target.closest('[data-mine]'); if (!b) return;
  const it = MIE.find(x => x.codice === b.dataset.c && x.strutturaId === b.dataset.s); if (!it) return;
  if (b.dataset.mine === 'ics') return downloadIcs(it);
  if (b.dataset.mine === 'rm') { setMine(getMine().filter(x => !(x.codice === it.codice && x.strutturaId === it.strutturaId))); return run(null, renderMie); }
  if (b.dataset.mine === 'cancel') run(b, async () => {
    if (!await confirmDlg('Annullare la prenotazione?', `${fmtDateLong(new Date(it.inizio))}, ${fmtTime(new Date(it.inizio))} – ${it.servizio}`, 'Annulla prenotazione')) return;
    let r;
    try { r = await api('/api/appuntamenti/annulla', {method: 'POST', auth: REQUIRE_LOGIN ? 'cliente' : false, body: {codice: it.codice, strutturaId: it.strutturaId}}); }
    catch (e) {
      if (e.status !== 404) throw e;
      r = {message: 'Questa prenotazione non esiste più: l’ho tolta dall’elenco.'};   // già annullata o eliminata dalla gestione
    }
    if (!REQUIRE_LOGIN) setMine(getMine().map(x => x.codice === it.codice && x.strutturaId === it.strutturaId ? {...x, stato: 'CANCELLATO'} : x));
    toast(r.message || 'Appuntamento annullato', 'ok');
    await renderMie(); refreshMineCount();
    if (it.strutturaId === C.strutturaId) loadSlots().catch(() => {});
  });
});

$('#aBtn').onclick = e => run(e.currentTarget, async () => {
  const codice = $('#aCodice').value.trim().toUpperCase();
  if (!C.strutturaId) { toast('Seleziona prima la struttura nella pagina «Prenota».'); return; }
  if (!codice) { toast('Inserisci il codice.'); return; }
  if (!await confirmDlg('Annullare la prenotazione?', `Codice ${codice}`, 'Annulla prenotazione')) return;
  let r;
  try { r = await api('/api/appuntamenti/annulla', {method: 'POST', body: {codice, strutturaId: C.strutturaId}}); }
  catch (e) { if (e.status !== 404) throw e; r = {message: 'Nessuna prenotazione attiva con questo codice.'}; }
  setMine(getMine().map(x => x.codice === codice && x.strutturaId === C.strutturaId ? {...x, stato: 'CANCELLATO'} : x));
  $('#aCodice').value = '';
  toast(r.message || 'Appuntamento annullato', 'ok'); await renderMie();
  loadSlots().catch(() => {});
});

/* =====================================================
   ADMIN
   ===================================================== */
const A = {view: 'appuntamenti', me: null, started: false, es: null, fData: todayISO(), fStato: '', fRis: '', fQ: '', vista: '', req: 0, resetScroll: true, risorsaSel: '', refreshTimer: null, list: []};
const NAV = [['appuntamenti','Agenda'],['risorse','Risorse'],['servizi','Servizi'],['orari','Orari'],['team','Team'],['account','Account']];
const ICON = {
  appuntamenti: '<path d="M7 3v3M17 3v3M4 9h16"/><rect x="4" y="5" width="16" height="15" rx="2"/>',
  risorse: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0114 0"/>',
  servizi: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  orari: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  team: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.3"/><path d="M3 19a6 6 0 0112 0M15 19a4.5 4.5 0 016 0"/>',
  account: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'
};
const ico = k => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
const main = () => $('#adminMain');

/* timeout per inattività: la gestione si richiude da sola dopo 30 minuti senza uso */
const IDLE_MS = 30 * 60 * 1000;
let idleT;
function armIdle() { clearTimeout(idleT); if (S.token) idleT = setTimeout(() => logout('Sessione chiusa per inattività.'), IDLE_MS); }
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (S.token) armIdle(); }, {passive: true}));

function logout(msg) {
  closeSSE(); clearTimeout(idleT);
  S.token = null; A.me = null; A.started = false;
  ['token','strutturaId','strutturaNome'].forEach(sess.del);
  if (msg) toast(msg, 'bad');
  renderAdmin();
}
function renderAdmin() {
  const logged = !!S.token;
  paintShell(); paintBrand();
  $('#adminLogin').hidden = logged;
  $('#adminApp').hidden = !logged;
  if (logged && !A.started) { A.started = true; startDashboard(); }
}
$('#loginForm').onsubmit = e => {
  e.preventDefault();
  run($('#loginBtn'), async () => {
    const r = await api('/api/auth/login', {method: 'POST', body: {codiceStruttura: $('#lCodice').value.trim(), username: $('#lUser').value.trim() || null, password: $('#lPass').value}});
    S.token = r.token; S.strutturaId = r.strutturaId; S.strutturaNome = r.strutturaNome;
    sess.set('token', r.token); sess.set('strutturaId', r.strutturaId); sess.set('strutturaNome', r.strutturaNome);
    store.set('staff', '1');   // questo dispositivo è della gestione: la prossima volta l'app si apre direttamente qui
    $('#lPass').value = '';
    renderAdmin();
  });
};
async function startDashboard() {
  try { A.me = await api('/api/admin/me', {auth: true}); }
  catch { A.started = false; if (S.token) logout('Token non più valido: accedi di nuovo.'); return; }
  renderNav(); connectSSE(); armIdle(); show(A.view);
}
function renderNav() {
  const items = NAV.map(([k, l]) => `<button type="button" data-view="${k}" aria-current="${A.view === k}">${ico(k)}<span>${l}</span></button>`).join('');
  // desktop: barra laterale · mobile: barra in basso (stessa lista, due contenitori)
  $('#nav').innerHTML =
    `<div class="who"><b>${esc(S.strutturaNome)}</b><span class="muted small">ruolo ${esc(A.me.role)}</span></div>` + items +
    `<div class="live" id="live"><i></i><span>aggiornamenti live: –</span></div>`;
  $('#adminBar').innerHTML = items;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if (!b || !S.token) return;
  show(b.dataset.view); window.scrollTo({top: 0});
});
function show(v) {
  A.view = v; paintShell();
  $$('[data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === v));
  run(null, ({appuntamenti: vAppuntamenti, risorse: vRisorse, servizi: vServizi, orari: vOrari, team: vTeam, account: vAccount})[v]);
}

/* ---- realtime (SSE) ---- */
function setLive(on) {
  const l = $('#live'); if (!l) return;
  l.className = 'live' + (on ? ' on' : '');
  l.lastElementChild.textContent = 'aggiornamenti live: ' + (on ? 'attivi' : 'in riconnessione…');
}
function closeSSE() { clearTimeout(A.sseT); if (A.es) { A.es.close(); A.es = null; } }
function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(.15, ac.currentTime + .02); g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + .35);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + .4);
    setTimeout(() => ac.close(), 600);
  } catch {}
}
async function connectSSE() {
  closeSSE();
  if (!S.token) return;
  // Se il backend lo supporta, usa un "ticket" monouso di pochi secondi al posto del token vero nell'URL
  // (gli URL finiscono nei log dei server). Altrimenti ripiega sul token come prima.
  let q;
  try {
    const t = await api('/api/stream/ticket', {method: 'POST', auth: true});
    q = 'ticket=' + encodeURIComponent(t.ticket);
  } catch {
    setLive(false); clearTimeout(A.sseT);
    A.sseT = setTimeout(() => { if (S.token && A.started) connectSSE(); }, 8000);
    return;
  }
  if (!S.token) return;
  const es = new EventSource(baseUrl() + '/api/stream?' + q);
  A.es = es;
  es.onopen = () => setLive(true);
  es.onerror = () => {   // chiudo e riconnetto io, così ogni tentativo usa un ticket nuovo
    setLive(false); es.close();
    if (A.es === es) { A.es = null; clearTimeout(A.sseT); A.sseT = setTimeout(() => { if (S.token && A.started) connectSSE(); }, 4000); }
  };
  const verbi = {CREATED: 'Nuovo appuntamento', UPDATED: 'Appuntamento aggiornato', DELETED: 'Appuntamento eliminato'};
  Object.keys(verbi).forEach(t => es.addEventListener(t, ev => {
    let d = {}; try { d = JSON.parse(ev.data); } catch {}
    toast(`${verbi[t]}: ${d.nomeCliente || ''}`.trim(), 'ok');
    if (t === 'CREATED' && S.sound) beep();
    if (A.view === 'appuntamenti') {
      clearTimeout(A.refreshTimer);
      A.refreshTimer = setTimeout(() => run(null, loadApps), 700);
    }
  }));
}

/* ---- Agenda (stile Google Calendar) ---- */
const HOUR_PX = 56;
const CHEV_L = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const weekStart = iso => { const d = new Date(iso + 'T12:00:00Z'); return addDays(iso, -((d.getUTCDay() + 6) % 7)); };
const minOf = d => hourOf(d) * 60 + parseInt(d.toLocaleTimeString('it-IT', {minute: '2-digit', timeZone: TZ}), 10);
const isMobile = () => window.matchMedia('(max-width:720px)').matches;
const colorIdx = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 6; };
const stepDays = () => A.vista === 'giorno' ? 1 : 7;
function rangeDays() {
  const a = A.fData || todayISO();
  return A.vista === 'giorno' ? [a] : Array.from({length: 7}, (_, i) => addDays(weekStart(a), i));
}
function rangeTitle() {
  if (A.vista === 'lista') return 'Tutti gli appuntamenti';
  const ds = rangeDays(), f = iso => new Date(iso + 'T12:00:00Z');
  const o = (iso, opt) => f(iso).toLocaleDateString('it-IT', {...opt, timeZone: 'UTC'});
  if (ds.length === 1) return o(ds[0], {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});
  const a = ds[0], b = ds[6], sameM = f(a).getUTCMonth() === f(b).getUTCMonth(), sameY = f(a).getUTCFullYear() === f(b).getUTCFullYear();
  if (sameM) return `${f(a).getUTCDate()} – ${o(b, {day: 'numeric', month: 'long', year: 'numeric'})}`;
  return `${o(a, {day: 'numeric', month: 'short', ...(sameY ? {} : {year: 'numeric'})})} – ${o(b, {day: 'numeric', month: 'short', year: 'numeric'})}`;
}

async function vAppuntamenti() {
  if (!A.vista) A.vista = isMobile() ? 'giorno' : 'settimana';
  A.resetScroll = true;
  main().innerHTML = `
    <div class="stats" id="stats"></div>
    <div class="card cal-card">
      <div class="cal-bar" id="calBar">
        <button class="btn sm" type="button" data-act="cal-oggi">Oggi</button>
        <div class="cal-nav">
          <button class="icon-btn" type="button" data-act="cal-prev" aria-label="Precedente">${CHEV_L}</button>
          <button class="icon-btn" type="button" data-act="cal-next" aria-label="Successivo">${CHEV_R}</button>
        </div>
        <label class="datebtn" title="Vai a una data"><span id="calTitle"></span><input type="date" id="fData" value="${esc(A.fData)}" aria-label="Vai a una data"></label>
        <div class="seg" role="group" aria-label="Vista">
          <button type="button" data-act="cal-vista" data-v="giorno">Giorno</button>
          <button type="button" data-act="cal-vista" data-v="settimana">Settimana</button>
          <button type="button" data-act="cal-vista" data-v="lista">Lista</button>
        </div>
      </div>
      <div class="cal-filters" id="calFilters">
        <input type="search" id="fQ" value="${esc(A.fQ)}" placeholder="Cerca cliente, telefono, codice…" aria-label="Cerca">
        <button class="icon-btn filt-btn" type="button" data-act="cal-filtri" aria-label="Filtri" aria-expanded="false"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg></button>
        <div class="cal-more">
          <select id="fStato" aria-label="Stato"><option value="">Appuntamenti attivi</option><option value="ALL">Tutti (anche annullati)</option>${Object.entries(STATI).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <select id="fRis" aria-label="Risorsa"><option value="">Tutte le risorse</option></select>
          <button class="btn ghost sm" type="button" data-act="app-agg">Aggiorna</button>
          <button class="btn ghost sm" type="button" data-act="app-csv">Esporta CSV</button>
        </div>
      </div>
      <div class="cal-legend" id="calLegend"></div>
      <div class="cal-box" id="calBox"><div class="skeleton" style="height:240px"></div></div>
      <p class="small muted" id="appCount" style="margin:10px 0 0"></p>
    </div>
    <details class="card"><summary>Pulizia dei dati vecchi</summary>
      <div class="toolbar">
        <div class="field"><label for="giorni">Elimina appuntamenti più vecchi di (giorni, 30–3650)</label><input type="number" id="giorni" value="365" min="30" max="3650"></div>
        <button class="btn danger" type="button" data-act="app-vecchi">Elimina</button>
      </div>
    </details>`;
  $('#fStato').value = A.fStato;
  // swipe sinistra/destra per cambiare giorno (solo vista Giorno)
  let t0 = null; const box = $('#calBox');
  box.addEventListener('touchstart', e => { t0 = [e.touches[0].clientX, e.touches[0].clientY]; }, {passive: true});
  box.addEventListener('touchend', e => {
    if (!t0 || A.vista !== 'giorno') return;
    const dx = e.changedTouches[0].clientX - t0[0], dy = e.changedTouches[0].clientY - t0[1]; t0 = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) { A.fData = addDays(A.fData, dx < 0 ? 1 : -1); run(null, navCal); }
  }, {passive: true});
  box.addEventListener('click', e => { const ev = e.target.closest('[data-ev]'); if (ev) openAppt(ev.dataset.ev); });
  paintBar();
  await loadApps();
}
function paintBar() {
  const bar = $('#calBar'); if (!bar) return;
  bar.dataset.v = A.vista;
  $('#calTitle').textContent = rangeTitle().replace(/^./, c => c.toUpperCase());
  $('#fData').value = A.fData;
  $$('#calBar .seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === A.vista));
}
async function navCal() { A.resetScroll = true; paintBar(); await loadApps(); }

async function loadApps() {
  const my = ++A.req;
  const days = A.vista === 'lista' ? null : rangeDays();
  const [lists, st] = await Promise.all([
    days ? Promise.all(days.map(d => api('/api/appuntamenti?data=' + d, {auth: true}))) : api('/api/appuntamenti', {auth: true}).then(x => [x]),
    api('/api/appuntamenti/statistiche', {auth: true})
  ]);
  if (my !== A.req || !$('#stats')) return;
  const seen = new Set();
  A.list = lists.flat().filter(a => !seen.has(a.id) && seen.add(a.id));
  $('#stats').innerHTML =
    `<div class="stat"><b>${st.oggi ?? 0}</b><span>confermati oggi</span></div>
     <div class="stat"><b>${st.settimana ?? 0}</b><span>ultimi 7 giorni</span></div>
     <div class="stat"><b>${st.futuro ?? 0}</b><span>da domani in poi</span></div>`;
  const names = [...new Set(A.list.map(a => a.risorsaNome).filter(Boolean))].sort();
  if (A.fRis && !names.includes(A.fRis)) names.push(A.fRis);
  $('#fRis').innerHTML = '<option value="">Tutte le risorse</option>' + names.map(n => `<option value="${esc(n)}" ${n === A.fRis ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('#calLegend').innerHTML = names.map(n => `<span><i class="dot c${colorIdx(n)}"></i>${esc(n)}</span>`).join('');
  paintApps();
}

function filteredApps() {
  const q = A.fQ.trim().toLowerCase();
  return A.list.filter(a =>
    (A.fStato === 'ALL' || (A.fStato ? a.status === A.fStato : a.status !== 'CANCELLATO')) &&
    (!A.fRis || a.risorsaNome === A.fRis) &&
    (!q || [a.nomeCliente, a.telefono, a.email, a.codice, a.tipoServizioNome, a.risorsaNome].some(v => String(v ?? '').toLowerCase().includes(q)))
  ).sort((x, y) => new Date(x.inizio) - new Date(y.inizio));
}
function paintApps() {
  const box = $('#calBox'); if (!box) return;
  box.dataset.v = A.vista;
  const l = filteredApps();
  $('#appCount').textContent = l.length + (l.length === 1 ? ' appuntamento' : ' appuntamenti') + (A.vista === 'lista' ? '' : ' in questo periodo');
  A.vista === 'lista' ? paintList(l) : paintCal(l);
}

function layoutDay(items) {
  const evs = items.map(a => ({a, s: +new Date(a.inizio), e: +new Date(a.fine)})).sort((x, y) => x.s - y.s || y.e - x.e);
  const out = []; let cl = [], end = 0;
  const flush = () => { const n = Math.max(1, ...cl.map(c => c.lane + 1)); cl.forEach(c => c.lanes = n); out.push(...cl); cl = []; };
  for (const ev of evs) {
    if (cl.length && ev.s >= end) flush();
    const used = new Set(cl.filter(c => c.e > ev.s).map(c => c.lane));
    let lane = 0; while (used.has(lane)) lane++;
    ev.lane = lane; cl.push(ev); end = Math.max(end, ev.e);
  }
  flush(); return out;
}
function paintCal(l) {
  const box = $('#calBox'), days = rangeDays(), today = todayISO();
  const prev = box.querySelector('.cal-scroll'), prevTop = prev ? prev.scrollTop : null;
  const by = Object.fromEntries(days.map(d => [d, []]));
  let lo = 8 * 60, hi = 19 * 60;
  for (const a of l) {
    const d = isoDay(new Date(a.inizio)); if (!by[d]) continue; by[d].push(a);
    const s = minOf(new Date(a.inizio)); lo = Math.min(lo, s); hi = Math.max(hi, s + (new Date(a.fine) - new Date(a.inizio)) / 60000);
  }
  const h0 = Math.max(0, Math.floor(lo / 60)), h1 = Math.min(24, Math.ceil(hi / 60)), H = (h1 - h0) * HOUR_PX;
  const hours = Array.from({length: h1 - h0}, (_, i) => `<div class="cal-h" style="top:${i * HOUR_PX}px"><span>${String(h0 + i).padStart(2, '0')}:00</span></div>`).join('');
  const nowMin = minOf(new Date());
  const cols = days.map(d => {
    const evs = layoutDay(by[d]).map(({a, lane, lanes}) => {
      const i = new Date(a.inizio), f = new Date(a.fine);
      const top = (minOf(i) - h0 * 60) / 60 * HOUR_PX, h = Math.max(22, (f - i) / 3600000 * HOUR_PX - 2);
      const pend = a.status === 'CONFERMATO' && f.getTime() < Date.now();
      const tip = `${fmtTime(i)}–${fmtTime(f)} · ${a.nomeCliente} · ${a.tipoServizioNome} · ${a.risorsaNome}`;
      return `<button type="button" class="ev c${colorIdx(a.risorsaNome)} st-${esc(a.status)} ${pend ? 'pend' : ''} ${h < 40 ? 'one' : ''}" data-ev="${esc(a.id)}" title="${esc(tip)}"
        style="top:${top}px;height:${h}px;left:calc(${lane / lanes * 100}% + 2px);width:calc(${100 / lanes}% - 4px)">
        <b>${esc(a.nomeCliente)}</b><span>${fmtTime(i)}–${fmtTime(f)}${h >= 58 ? ' · ' + esc(a.tipoServizioNome) : ''}</span></button>`;
    }).join('');
    const now = d === today && nowMin >= h0 * 60 && nowMin <= h1 * 60 ? `<i class="cal-now" style="top:${(nowMin - h0 * 60) / 60 * HOUR_PX}px"></i>` : '';
    return `<div class="cal-col ${d === today ? 'today' : ''}">${evs}${now}</div>`;
  }).join('');
  const head = days.map(d => {
    const x = new Date(d + 'T12:00:00Z'), n = by[d].filter(a => a.status === 'CONFERMATO').length;
    return `<button type="button" class="cal-dh ${d === today ? 'today' : ''}" data-act="cal-day" data-d="${d}" ${A.vista === 'giorno' ? 'tabindex="-1"' : ''}><small>${esc(x.toLocaleDateString('it-IT', {weekday: 'short', timeZone: 'UTC'}).replace('.', ''))}</small><b>${x.getUTCDate()}</b>${n ? `<em>${n}</em>` : ''}</button>`;
  }).join('');
  box.innerHTML = `<div class="cal-scroll"><div class="cal-grid" style="--n:${days.length};--hh:${HOUR_PX}px">
    <div class="cal-head"><div class="cal-corner"></div>${head}</div>
    <div class="cal-body" style="height:${H + 10}px"><div class="cal-hours" style="height:${H}px">${hours}</div>${cols.replace(/class="cal-col/g, `style="height:${H}px" class="cal-col`)}</div>
  </div></div>${l.length ? '' : '<p class="empty" style="margin:12px 0 0">Nessun appuntamento in questo periodo.</p>'}`;
  const sc = box.querySelector('.cal-scroll');
  if (prevTop != null && !A.resetScroll) sc.scrollTop = prevTop;
  else {
    const first = l.filter(a => by[isoDay(new Date(a.inizio))]).map(a => minOf(new Date(a.inizio)));
    const target = days.includes(today) ? nowMin - 90 : first.length ? Math.min(...first) - 30 : 8 * 60;
    sc.scrollTop = Math.max(0, (target - h0 * 60) / 60 * HOUR_PX);
  }
  A.resetScroll = false;
}
function paintList(l) {
  const tb = $('#calBox');
  if (!l.length) { tb.innerHTML = '<p class="empty" style="margin:0">Nessun appuntamento con questi filtri.</p>'; return; }
  let html = '', last = '';
  for (const a of l) {
    const day = isoDay(new Date(a.inizio));
    if (day !== last) { last = day; html += `<div class="group-title">${esc(fmtDateLong(new Date(a.inizio)))}</div>`; }
    html += rowApp(a);
  }
  tb.innerHTML = `<div class="applist">${html}</div>`;
}
function rowApp(a) {
  const i = new Date(a.inizio), f = new Date(a.fine), pastConf = a.status === 'CONFERMATO' && f.getTime() < Date.now();
  return `<article class="appt c${colorIdx(a.risorsaNome)} st-${esc(a.status)}" data-ev="${esc(a.id)}" tabindex="0" role="button">
    <div class="appt-time"><b>${fmtTime(i)}</b><span>${fmtTime(f)}</span></div>
    <div class="appt-body"><div class="appt-top"><strong>${esc(a.nomeCliente)}</strong>
      <span class="badge s-${esc(a.status)}">${esc(pastConf ? 'Da chiudere' : (STATI[a.status] || a.status))}</span></div>
      <div class="appt-sub">${esc(a.tipoServizioNome)} · ${esc(a.risorsaNome)}</div></div></article>`;
}
function openAppt(id) {
  const a = A.list.find(x => String(x.id) === String(id)); if (!a) return;
  const i = new Date(a.inizio), f = new Date(a.fine), conf = a.status === 'CONFERMATO';
  const st = (s, l, cls = 'ghost') => `<button class="btn ${cls} sm" type="button" data-act="app-status" data-id="${esc(a.id)}" data-st="${s}">${l}</button>`;
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  $('#apptBody').innerHTML = `
    <div class="ap-head"><i class="dot c${colorIdx(a.risorsaNome)}"></i><div><h3>${esc(a.nomeCliente)}</h3>
      <p class="muted small" style="margin:2px 0 0">${esc(fmtDateLong(i).replace(/^./, c => c.toUpperCase()))} · ${fmtTime(i)}–${fmtTime(f)}</p></div></div>
    <dl class="ap-dl">${row('Servizio', esc(a.tipoServizioNome))}${row('Risorsa', esc(a.risorsaNome))}
      ${row('Telefono', a.telefono ? `<a href="tel:${esc(a.telefono)}">${esc(a.telefono)}</a>` : '')}
      ${row('Email', a.email ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : '')}
      ${row('Codice', `<code>${esc(a.codice)}</code>`)}${row('Stato', `<span class="badge s-${esc(a.status)}">${esc(STATI[a.status] || a.status)}</span>`)}
      ${row('Note', esc(a.note))}</dl>
    <div class="acts">${conf ? st('COMPLETATO', 'Segna completato', '') + st('NO_SHOW', 'Non presentato') + st('CANCELLATO', 'Annulla', 'danger') : ''}
      <button class="btn danger sm" type="button" data-act="app-del" data-id="${esc(a.id)}">Elimina</button></div>`;
  const d = $('#dlgAppt'); if (!d.open) d.showModal();
}
function exportCsv() {
  const l = filteredApps();
  if (!l.length) return toast('Niente da esportare.');
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Data','Inizio','Fine','Cliente','Telefono','Email','Servizio','Risorsa','Codice','Stato','Note']];
  for (const a of l) { const i = new Date(a.inizio), f = new Date(a.fine);
    rows.push([isoDay(i), fmtTime(i), fmtTime(f), a.nomeCliente, a.telefono, a.email, a.tipoServizioNome, a.risorsaNome, a.codice, STATI[a.status] || a.status, a.note]); }
  downloadFile(`appuntamenti-${A.vista === 'lista' ? 'tutti' : A.fData}.csv`, 'text/csv;charset=utf-8', '\uFEFF' + rows.map(r => r.map(q).join(';')).join('\r\n'));
}

/* ---- Risorse ---- */
async function vRisorse() {
  const list = await api('/api/risorse', {auth: true});
  main().innerHTML = `
    <div class="card"><h2>Nuova risorsa</h2>
      <p class="small muted">Una risorsa è chi o cosa eroga il servizio: un professionista, una sala, un macchinario.</p>
      <form data-form="ris-new"><div class="toolbar">
        <div class="field grow"><label for="rNome">Nome</label><input id="rNome" name="nome" required></div>
        <div class="field"><label for="rTipo">Tipo</label><input id="rTipo" name="tipo" list="tipiRis" value="PROFESSIONISTA" required>
          <datalist id="tipiRis"><option>PROFESSIONISTA</option><option>SALA</option><option>MACCHINARIO</option></datalist></div>
        <button class="btn" type="submit">Aggiungi</button></div></form></div>
    <div class="card"><h3>Risorse della struttura</h3><div class="tablewrap"><table>
      <thead><tr><th>Nome</th><th>Tipo</th><th>Stato</th><th></th></tr></thead><tbody>
      ${list.length ? list.map(r => `<tr><td>${esc(r.nome)}</td><td>${esc(r.tipo)}</td>
        <td><span class="badge ${r.attiva ? 's-on' : 's-off'}">${r.attiva ? 'Attiva' : 'Disattivata'}</span></td>
        <td><div class="acts"><button class="btn ghost sm" type="button" data-act="ris-toggle" data-id="${esc(r.id)}" data-val="${!r.attiva}">${r.attiva ? 'Disattiva' : 'Attiva'}</button>
        <button class="btn danger sm" type="button" data-act="ris-del" data-id="${esc(r.id)}" data-name="${esc(r.nome)}">Elimina</button></div></td></tr>`).join('')
        : '<tr><td colspan="4" class="empty">Nessuna risorsa. Creane una per iniziare.</td></tr>'}
      </tbody></table></div></div>`;
}

/* ---- Servizi ---- */
async function vServizi() {
  const list = await api('/api/tipi-servizio/admin', {auth: true});
  main().innerHTML = `
    <div class="card"><h2>Nuovo servizio</h2>
      <form data-form="srv-new">
        <div class="row">
          <div class="field"><label for="sNome">Nome</label><input id="sNome" name="nome" required></div>
          <div class="row keep" style="margin:0">
            <div class="field"><label for="sDur">Durata (min)</label><input id="sDur" name="durata" type="number" min="5" step="5" value="30" required></div>
            <div class="field"><label for="sPrezzo">Prezzo (€)</label><input id="sPrezzo" name="prezzo" type="number" min="0" step="0.5"></div>
          </div></div>
        <div class="field"><label for="sDesc">Descrizione</label><input id="sDesc" name="descrizione"></div>
        <button class="btn" type="submit">Aggiungi servizio</button></form></div>
    <div class="card"><h3>Servizi della struttura</h3><div class="tablewrap"><table>
      <thead><tr><th>Nome</th><th>Durata</th><th>Prezzo</th><th>Stato</th><th></th></tr></thead><tbody>
      ${list.length ? list.map(t => `<tr><td>${esc(t.nome)}<br><span class="muted small">${esc(t.descrizione || '')}</span></td>
        <td>${t.durataMinuti} min</td><td>${eur(t.prezzo)}</td>
        <td><span class="badge ${t.attivo ? 's-on' : 's-off'}">${t.attivo ? 'Attivo' : 'Disattivato'}</span></td>
        <td><div class="acts"><button class="btn ghost sm" type="button" data-act="srv-toggle" data-id="${esc(t.id)}" data-val="${!t.attivo}">${t.attivo ? 'Disattiva' : 'Attiva'}</button>
        <button class="btn danger sm" type="button" data-act="srv-del" data-id="${esc(t.id)}" data-name="${esc(t.nome)}">Elimina</button></div></td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">Nessun servizio. Creane uno per iniziare.</td></tr>'}
      </tbody></table></div></div>`;
}

/* ---- Orari (griglia settimanale) ---- */
async function vOrari() {
  const ris = await api('/api/risorse', {auth: true});
  if (!ris.length) { main().innerHTML = '<div class="card"><p class="empty">Crea prima una risorsa: gli orari si impostano per ogni risorsa.</p></div>'; return; }
  if (!ris.some(r => r.id === A.risorsaSel)) A.risorsaSel = ris[0].id;
  const orari = await api('/api/disponibilita/admin?risorsaId=' + encodeURIComponent(A.risorsaSel), {auth: true});
  const week = DAYS.map(([k, l]) => {
    const rs = orari.filter(o => o.giornoSettimana === k).sort((a, b) => hm(a.oraInizio).localeCompare(hm(b.oraInizio)));
    return `<div class="wday ${rs.length ? '' : 'off'}"><h4>${l}</h4>` + (rs.length ? rs.map(o =>
      `<div class="rng"><span>${hm(o.oraInizio)}–${hm(o.oraFine)}${o.pausaInizio ? `<small>pausa ${hm(o.pausaInizio)}–${hm(o.pausaFine)}</small>` : ''}</span>
       <button type="button" data-act="ora-del" data-id="${esc(o.id)}" aria-label="Elimina orario">✕</button></div>`).join('') : '<span class="small muted">Chiuso</span>') + '</div>';
  }).join('');
  main().innerHTML = `
    <div class="card"><h2>Orari di lavoro</h2>
      <div class="field" style="max-width:320px"><label for="oRis">Risorsa</label>
        <select id="oRis">${ris.map(r => `<option value="${esc(r.id)}" ${r.id === A.risorsaSel ? 'selected' : ''}>${esc(r.nome)}</option>`).join('')}</select></div>
      <div class="week">${week}</div>
      ${orari.length ? '' : '<p class="empty">Nessun orario: i clienti non vedranno slot per questa risorsa.</p>'}</div>
    <div class="card"><h3>Aggiungi una fascia</h3>
      <form data-form="ora-new">
        <div class="row">
          <div class="field"><label for="oGiorno">Giorno</label><select id="oGiorno" name="giorno">${DAYS.map(d => `<option value="${d[0]}">${d[1]}</option>`).join('')}</select></div>
          <div class="row keep" style="margin:0">
            <div class="field"><label for="oIni">Dalle</label><input id="oIni" name="ini" type="time" value="09:00" required></div>
            <div class="field"><label for="oFin">Alle</label><input id="oFin" name="fin" type="time" value="13:00" required></div></div></div>
        <div class="row keep">
          <div class="field"><label for="oPI">Pausa dalle <span class="opt">(facoltativa)</span></label><input id="oPI" name="pi" type="time"></div>
          <div class="field"><label for="oPF">Pausa alle</label><input id="oPF" name="pf" type="time"></div></div>
        <div class="acts"><button class="btn" type="submit">Aggiungi orario</button>
          <button class="btn ghost" type="button" data-act="ora-std">Imposta lun–ven 9–13 e 15–19</button></div>
      </form></div>`;
}

/* ---- Team ---- */
async function vTeam() {
  const list = await api('/api/admin', {auth: true});
  main().innerHTML = `
    <div class="card"><h2>Nuovo accesso</h2>
      <form data-form="team-new"><div class="toolbar">
        <div class="field grow"><label for="tUser">Nome utente (min. 3 caratteri)</label><input id="tUser" name="username" minlength="3" maxlength="60" required autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="field grow"><label for="tPass">Password (min. 8 caratteri)</label><input id="tPass" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
        <div class="field"><label for="tRole">Ruolo</label><select id="tRole" name="role"><option>ADMIN</option><option>STAFF</option></select></div>
        <button class="btn" type="submit">Crea accesso</button></div></form></div>
    <div class="card"><h3>Accessi della struttura</h3><div class="tablewrap"><table>
      <thead><tr><th>Utente</th><th>Ruolo</th><th></th></tr></thead><tbody>
      ${list.map(a => `<tr><td><b>${esc(a.username || 'senza nome')}</b> <code>${esc(a.id.slice(0, 8))}</code>${a.id === A.me.id ? ' <span class="muted small">(tu)</span>' : ''}</td>
        <td><span class="badge s-info">${esc(a.role)}</span></td>
        <td><div class="acts"><button class="btn ghost sm" type="button" data-act="team-role" data-id="${esc(a.id)}" data-role="${a.role === 'ADMIN' ? 'STAFF' : 'ADMIN'}">Rendi ${a.role === 'ADMIN' ? 'STAFF' : 'ADMIN'}</button>
        <button class="btn danger sm" type="button" data-act="team-del" data-id="${esc(a.id)}">Elimina</button></div></td></tr>`).join('')}
      </tbody></table></div></div>`;
}

/* ---- Account ---- */
async function vAccount() {
  A.me = await api('/api/admin/me', {auth: true});
  main().innerHTML = `
    <div class="card"><h2>Il tuo account</h2>
      <p>Struttura: <b>${esc(S.strutturaNome)}</b><br>Utente: <b>${esc(A.me.username || '–')}</b><br>Ruolo: <b>${esc(A.me.role)}</b><br><span class="muted small">Id admin ${esc(A.me.id)}</span></p>
      <button class="btn ghost" type="button" data-act="logout">Esci</button></div>
    <div class="card"><h3>Link e QR per i clienti</h3>
      <p class="small muted">I clienti inquadrano il QR (o aprono il link) e arrivano direttamente alla prenotazione della tua struttura. Stampalo e mettilo in studio, o mandalo per messaggio.</p>
      <div class="field"><label for="qrBase">Indirizzo del sito</label><input id="qrBase" type="url" spellcheck="false" value="${esc(location.origin + location.pathname.replace(/index\.html$/, ''))}"></div>
      <p class="form-err" id="qrWarn" hidden>Questo indirizzo funziona solo sul tuo computer. Inserisci qui l’indirizzo pubblico del sito prima di stampare il QR.</p>
      <div class="field"><label for="qrLink">Link di prenotazione</label><input id="qrLink" readonly></div>
      <div class="qr-wrap" id="qrBox" aria-label="QR code di prenotazione"></div>
      <div class="acts"><button class="btn" type="button" data-act="qr-copy">Copia link</button>
        <button class="btn ghost" type="button" data-act="qr-png">Scarica PNG</button>
        <button class="btn ghost" type="button" data-act="qr-svg">Scarica SVG</button>
        <button class="btn ghost" type="button" data-act="qr-print">Stampa cartello</button></div></div>
    <div class="card"><h3>Notifiche sul dispositivo</h3>
      <p class="small muted" id="pushState">Verifico…</p>
      <div class="acts"><button class="btn" type="button" id="pushOn" data-act="push-on" hidden>Attiva notifiche</button>
      <button class="btn ghost" type="button" id="pushOff" data-act="push-off" hidden>Disattiva</button></div></div>
    <div class="card"><h3>Cambia password</h3>
      <form data-form="pwd">
        <div class="field"><label for="pOld">Password attuale</label><input id="pOld" name="old" type="password" required autocomplete="current-password"></div>
        <div class="field"><label for="pNew">Nuova password (min. 8 caratteri)</label><input id="pNew" name="nuova" type="password" minlength="8" required autocomplete="new-password"></div>
        <button class="btn" type="submit">Salva password</button></form></div>`;
  pushRefresh().catch(() => {});
  paintQr().catch(e => toast(e.message, 'bad'));
}

/* ---- QR per i clienti ---- */
function loadQrLib() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((ok, ko) => {
    const sc = document.createElement('script'); sc.src = 'qrcode.js'; sc.onload = ok;
    sc.onerror = () => ko(new Error('Manca qrcode.js: copialo nella stessa cartella di index.html.'));
    document.head.appendChild(sc);
  });
}
const qrLink = () => { try { const u = new URL($('#qrBase').value.trim()); u.search = ''; u.hash = ''; u.searchParams.set('s', S.strutturaId); return u.href; } catch { return ''; } };
function qrSvg(text, px = 320) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
async function paintQr() {
  if (!$('#qrBox')) return;
  await loadQrLib();
  const link = qrLink();
  $('#qrLink').value = link;
  $('#qrWarn').hidden = !/^(localhost|127\.|192\.168\.|10\.)/.test(new URL(link || 'http://x').hostname) ;
  $('#qrBox').innerHTML = link ? qrSvg(link, 240) : '<p class="small muted">Inserisci un indirizzo valido.</p>';
}

/* ---- notifiche push ---- */
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToU8 = s => {
  const raw = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
async function pushRefresh() {
  const el = $('#pushState'); if (!el) return;
  if (!pushOk()) { el.textContent = 'Questo browser non supporta le notifiche push.'; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  el.textContent = Notification.permission === 'denied'
    ? 'Le notifiche sono bloccate: sbloccale dalle impostazioni del browser.'
    : sub ? 'Attive su questo dispositivo.' : 'Non attive su questo dispositivo.';
  $('#pushOn').hidden = !!sub || Notification.permission === 'denied';
  $('#pushOff').hidden = !sub;
}
async function pushEnable() {
  if (!pushOk()) throw new Error('Questo browser non supporta le notifiche push.');
  if (await Notification.requestPermission() !== 'granted') throw new Error('Permesso per le notifiche negato.');
  const {publicKey} = await api('/api/push/vapid-public-key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey)});
  await api('/api/push/subscribe', {method: 'POST', auth: true, body: sub.toJSON()});
}
async function pushDisable() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await api('/api/push/unsubscribe', {method: 'POST', auth: true, body: {endpoint: sub.endpoint}}); } catch {}
  await sub.unsubscribe();
}

/* ---- azioni (click) ---- */
const ACTIONS = {
  'push-on':   async () => { await pushEnable(); toast('Notifiche attivate', 'ok'); await pushRefresh(); },
  'push-off':  async () => { await pushDisable(); toast('Notifiche disattivate', 'ok'); await pushRefresh(); },
  'cal-oggi':  async () => { A.fData = todayISO(); await navCal(); },
  'cal-prev':  async () => { A.fData = addDays(A.fData, -stepDays()); await navCal(); },
  'cal-next':  async () => { A.fData = addDays(A.fData, stepDays()); await navCal(); },
  'cal-vista': async b => { A.vista = b.dataset.v; await navCal(); },
  'cal-day':   async b => { if (A.vista === 'giorno') return; A.vista = 'giorno'; A.fData = b.dataset.d; await navCal(); },
  'cal-filtri': async b => { const f = $('#calFilters'); b.setAttribute('aria-expanded', f.classList.toggle('open')); },
  'app-agg':   async () => { await loadApps(); },
  'app-csv':   async () => exportCsv(),
  'app-status': async b => {
    const d = $('#dlgAppt'); if (d.open) d.close();
    if (b.dataset.st === 'CANCELLATO' && !await confirmDlg('Annullare l’appuntamento?', 'Lo slot tornerà libero e il cliente lo vedrà annullato.', 'Annulla appuntamento')) return;
    await api(`/api/appuntamenti/${b.dataset.id}/status`, {method: 'PATCH', auth: true, body: {status: b.dataset.st}});
    toast('Stato aggiornato', 'ok'); await loadApps();
  },
  'app-del': async b => {
    const d = $('#dlgAppt'); if (d.open) d.close();
    if (!await confirmDlg('Eliminare l’appuntamento?', 'L’operazione è definitiva.', 'Elimina')) return;
    await api('/api/appuntamenti/' + b.dataset.id, {method: 'DELETE', auth: true});
    toast('Appuntamento eliminato', 'ok'); await loadApps();
  },
  'app-vecchi': async () => {
    const g = Number($('#giorni').value);
    if (!await confirmDlg('Pulizia dati vecchi', `Eliminare tutti gli appuntamenti più vecchi di ${g} giorni? Non si può annullare.`, 'Elimina')) return;
    const r = await api('/api/appuntamenti/vecchi?giorni=' + g, {method: 'DELETE', auth: true});
    toast(`Eliminati: ${r.eliminati}`, 'ok'); await loadApps();
  },
  'ris-toggle': async b => { await api('/api/risorse/' + b.dataset.id, {method: 'PATCH', auth: true, body: {attiva: b.dataset.val === 'true'}}); await vRisorse(); },
  'ris-del': async b => {
    if (!await confirmDlg('Eliminare la risorsa?', b.dataset.name || '', 'Elimina')) return;
    await api('/api/risorse/' + b.dataset.id, {method: 'DELETE', auth: true}); toast('Risorsa eliminata', 'ok'); await vRisorse();
  },
  'srv-toggle': async b => { await api('/api/tipi-servizio/' + b.dataset.id, {method: 'PATCH', auth: true, body: {attivo: b.dataset.val === 'true'}}); await vServizi(); },
  'srv-del': async b => {
    if (!await confirmDlg('Eliminare il servizio?', b.dataset.name || '', 'Elimina')) return;
    await api('/api/tipi-servizio/' + b.dataset.id, {method: 'DELETE', auth: true}); toast('Servizio eliminato', 'ok'); await vServizi();
  },
  'ora-del': async b => { await api('/api/disponibilita/admin/' + b.dataset.id, {method: 'DELETE', auth: true}); await vOrari(); },
  'ora-std': async () => {
    if (!await confirmDlg('Orario standard', 'Aggiungere lun–ven 09:00–13:00 e 15:00–19:00 a questa risorsa?', 'Aggiungi')) return;
    let ok = 0, err = '';
    for (const [g] of DAYS.slice(0, 5)) for (const [i, f] of [['09:00','13:00'],['15:00','19:00']]) {
      try { await api('/api/disponibilita/admin', {method: 'POST', auth: true, body: {risorsaId: A.risorsaSel, giornoSettimana: g, oraInizio: i, oraFine: f}}); ok++; }
      catch (e) { err = e.message; }
    }
    toast(`Aggiunti ${ok} orari${err ? ' – ultimo errore: ' + err : ''}`, err ? 'bad' : 'ok'); await vOrari();
  },
  'team-role': async b => {
    await api(`/api/admin/${b.dataset.id}/role`, {method: 'PATCH', auth: true, body: {role: b.dataset.role}}); await vTeam();
  },
  'team-del': async b => {
    if (!await confirmDlg('Eliminare questo accesso?', '', 'Elimina')) return;
    await api('/api/admin/' + b.dataset.id, {method: 'DELETE', auth: true}); toast('Accesso eliminato', 'ok'); await vTeam();
  },
  'qr-copy':  async () => { const l = qrLink(); if (!l) return toast('Indirizzo non valido.', 'bad'); try { await navigator.clipboard.writeText(l); toast('Link copiato', 'ok'); } catch { $('#qrLink').select(); toast('Seleziona e copia il link.'); } },
  'qr-svg':   async () => { await loadQrLib(); const l = qrLink(); if (l) downloadFile('qr-prenotazione.svg', 'image/svg+xml', qrSvg(l, 1024)); },
  'qr-png':   async () => {
    await loadQrLib(); const l = qrLink(); if (!l) return;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(l, 1024));
    await img.decode();
    const cv = document.createElement('canvas'); cv.width = cv.height = 1024; cv.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png')); downloadFile('qr-prenotazione.png', 'image/png', blob);
  },
  'qr-print': async () => {
    await loadQrLib(); const l = qrLink(); if (!l) return;
    const w = window.open('', '_blank'); if (!w) return toast('Il browser ha bloccato la finestra: consenti i popup.', 'bad');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>QR prenotazioni</title><style>body{font-family:system-ui,sans-serif;text-align:center;margin:0;padding:48px 24px}h1{font-size:34px;margin:0 0 6px}p{font-size:22px;margin:0 0 28px;color:#444}small{display:block;margin-top:24px;color:#666;font-size:14px;word-break:break-all}svg{width:min(70vw,420px);height:auto}</style><h1>${esc(S.strutturaNome)}</h1><p>Inquadra per prenotare online</p>${qrSvg(l, 420)}<small>${esc(l)}</small>`);
    w.document.close(); setTimeout(() => w.print(), 300);
  },
  'logout': async () => { store.del('staff'); logout(); setMode('prenota'); }   // uscita volontaria: il dispositivo torna "da cliente"
};
// finestra dettaglio appuntamento + icone SVG al posto dei simboli testuali
document.body.insertAdjacentHTML('beforeend', `<dialog id="dlgAppt" aria-label="Dettaglio appuntamento"><div class="dlg">
  <div class="auth-head"><h3>Appuntamento</h3><button type="button" class="icon-btn" id="apptClose" aria-label="Chiudi">${'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'}</button></div>
  <div id="apptBody"></div></div></dialog>`);
const svg = p => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
$('#btnSettings').innerHTML = svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>');
$('#authClose').innerHTML = svg('<path d="M6 6l12 12M18 6L6 18"/>');
const bb = $$('#bottombar [data-mode] > span');
if (bb[0]) bb[0].innerHTML = svg('<path d="M12 5v14M5 12h14"/>');
if (bb[1]) bb[1].innerHTML = svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>');
const onAct = e => {
  const b = e.target.closest('[data-act]'); if (!b || !ACTIONS[b.dataset.act]) return;
  run(b, () => ACTIONS[b.dataset.act](b));
};
$('#adminMain').addEventListener('click', onAct);
$('#dlgAppt').addEventListener('click', e => { if (e.target.id === 'dlgAppt') e.target.close(); else onAct(e); });
$('#apptClose').onclick = () => $('#dlgAppt').close();
$('#adminMain').addEventListener('click', e => { if (e.target.id === 'fData' && e.target.showPicker) { try { e.target.showPicker(); } catch {} } });
$('#adminMain').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.appt[data-ev]')) { e.preventDefault(); openAppt(e.target.dataset.ev); } });

/* ---- form ---- */
const FORMS = {
  'ris-new': async f => {
    await api('/api/risorse', {method: 'POST', auth: true, body: {nome: f.nome.value.trim(), tipo: f.tipo.value.trim()}});
    toast('Risorsa creata', 'ok'); await vRisorse();
  },
  'srv-new': async f => {
    await api('/api/tipi-servizio', {method: 'POST', auth: true, body: {
      nome: f.nome.value.trim(), descrizione: f.descrizione.value.trim() || null,
      durataMinuti: Number(f.durata.value), prezzo: f.prezzo.value === '' ? null : Number(f.prezzo.value)}});
    toast('Servizio creato', 'ok'); await vServizi();
  },
  'ora-new': async f => {
    await api('/api/disponibilita/admin', {method: 'POST', auth: true, body: {
      risorsaId: A.risorsaSel, giornoSettimana: f.giorno.value, oraInizio: f.ini.value, oraFine: f.fin.value,
      pausaInizio: f.pi.value || null, pausaFine: f.pf.value || null}});
    toast('Orario aggiunto', 'ok'); await vOrari();
  },
  'team-new': async f => {
    await api('/api/admin', {method: 'POST', auth: true, body: {username: f.username.value.trim(), password: f.password.value, role: f.role.value}});
    toast('Accesso creato', 'ok'); await vTeam();
  },
  'pwd': async f => {
    await api('/api/admin/password', {method: 'PATCH', auth: true, body: {vecchiaPassword: f.old.value, nuovaPassword: f.nuova.value}});
    f.reset(); toast('Password aggiornata', 'ok');
  }
};
$('#adminMain').addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f || !FORMS[f.dataset.form]) return;
  e.preventDefault();
  run(f.querySelector('[type=submit]'), () => FORMS[f.dataset.form](f));
});

/* ---- Nuovo appuntamento (admin): stesso flusso del cliente — servizio → giorno → orario → dati ---- */
// Con account cliente obbligatorio il POST pubblico richiede ROLE_CLIENTE: serve un endpoint admin (vedi BACKEND.md §10).
const ADMIN_BOOK = REQUIRE_LOGIN ? '/api/admin/appuntamenti' : '/api/appuntamenti';
const N = {slots: [], slot: null, giorno: todayISO(), req: 0, known: new Map()};
const X_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
document.body.insertAdjacentHTML('beforeend', `<dialog id="dlgNew" aria-labelledby="newTitle"><form class="dlg sheet" id="newForm" novalidate>
  <div class="auth-head"><h3 id="newTitle">Nuovo appuntamento</h3><button type="button" class="icon-btn" id="newClose" aria-label="Chiudi">${X_ICON}</button></div>
  <div class="sheet-body">
    <h4 class="sheet-step"><span class="step">1</span> Cosa</h4>
    <div class="row">
      <div class="field"><label for="nTipo">Servizio</label><select id="nTipo" disabled></select></div>
      <div class="field"><label for="nRis">Con chi / dove</label><select id="nRis" disabled></select></div>
    </div>
    <h4 class="sheet-step"><span class="step">2</span> Giorno e orario</h4>
    <div class="datestrip" id="nStrip" role="group" aria-label="Giorni"></div>
    <div class="field datepick"><label for="nData">Oppure un’altra data</label><input type="date" id="nData"></div>
    <div id="nSlots" aria-live="polite"></div>
    <h4 class="sheet-step"><span class="step">3</span> Dati del cliente</h4>
    <div class="summary" id="nSummary" hidden></div>
    <div class="field"><label for="nNome">Nome e cognome</label><input id="nNome" autocomplete="off" list="nNomi" minlength="2"><datalist id="nNomi"></datalist></div>
    <div class="row">
      <div class="field"><label for="nTel">Telefono</label><input id="nTel" type="tel" inputmode="tel" autocomplete="off"></div>
      <div class="field"><label for="nEmail">Email <span class="opt">(facoltativa)</span></label><input id="nEmail" type="email" autocomplete="off"></div>
    </div>
    <div class="field"><label for="nNote">Note <span class="opt">(facoltative)</span></label><textarea id="nNote" maxlength="500"></textarea></div>
    <label class="check"><input type="checkbox" id="nPriv"> <span>Il cliente ha letto l’informativa privacy e acconsente al trattamento dei dati per gestire l’appuntamento</span></label>
    <p class="form-err" id="nErr" role="alert" hidden></p>
  </div>
  <div class="sheet-foot"><button class="btn block" id="nSubmit" type="submit">Conferma appuntamento</button></div>
</form></dialog>`);
const nErr = m => { const el = $('#nErr'); el.textContent = m || ''; el.hidden = !m; };

async function openNew() {
  const d = $('#dlgNew');
  $('#newForm').reset(); nErr('');
  N.slot = null; N.slots = [];
  N.giorno = A.fData && A.fData > todayISO() ? A.fData : todayISO();   // parte dal giorno che l'admin sta guardando
  $('#nSummary').hidden = true; $('#nSlots').innerHTML = '';
  $('#nStrip').innerHTML = stripHtml(N.giorno); $('#nData').value = N.giorno; $('#nData').min = todayISO();
  N.known = new Map(A.list.filter(a => a.nomeCliente).map(a => [a.nomeCliente.toLowerCase(), a]));
  $('#nNomi').innerHTML = [...N.known.values()].map(a => `<option value="${esc(a.nomeCliente)}"></option>`).join('');
  d.showModal();
  try {
    const q = encodeURIComponent(S.strutturaId);
    const [ris, tipi] = await Promise.all([api('/api/risorse/pubbliche?strutturaId=' + q), api('/api/tipi-servizio?strutturaId=' + q)]);
    fillSelect($('#nTipo'), tipi, t => `${t.nome} · ${t.durataMinuti} min${t.prezzo != null ? ' · ' + eur(t.prezzo) : ''}`, tipi.length ? 'Scegli un servizio' : 'Nessun servizio attivo');
    fillSelect($('#nRis'), ris, r => `${r.nome} (${r.tipo})`, ris.length ? 'Scegli' : 'Nessuna risorsa attiva');
    await loadNSlots();
  } catch (e) { d.close(); throw e; }
}
async function loadNSlots() {
  const r = $('#nRis').value, t = $('#nTipo').value, day = N.giorno, box = $('#nSlots');
  N.slot = null; $('#nSummary').hidden = true;
  if (!r || !t) { N.slots = []; box.innerHTML = '<p class="empty">Scegli servizio e risorsa per vedere gli orari.</p>'; return; }
  const my = ++N.req;
  box.innerHTML = '<div class="slots">' + '<div class="skeleton"></div>'.repeat(8) + '</div>';
  let slots;
  try { slots = await api(`/api/disponibilita?risorsaId=${encodeURIComponent(r)}&data=${day}&tipoServizioId=${encodeURIComponent(t)}`); }
  catch (e) { if (my === N.req) box.innerHTML = '<p class="empty">Non riesco a caricare gli orari.</p>'; throw e; }
  if (my !== N.req) return;
  N.slots = slots; box.innerHTML = slotsHtml(N.slots, N.slot, N.giorno);
}
function setNDay(iso) {
  N.giorno = iso; $('#nStrip').innerHTML = stripHtml(iso); $('#nData').value = iso; run(null, loadNSlots);
}
$('#fabNew').onclick = e => run(e.currentTarget, openNew);
$('#newClose').onclick = () => $('#dlgNew').close();
$('#dlgNew').addEventListener('click', e => { if (e.target.id === 'dlgNew') e.target.close(); });
$('#nTipo').onchange = $('#nRis').onchange = () => run(null, loadNSlots);
$('#nStrip').onclick = e => { const b = e.target.closest('.day'); if (b) setNDay(b.dataset.d); };
$('#nData').onchange = e => { if (e.target.value) setNDay(e.target.value); };
$('#nSlots').onclick = e => {
  const b = e.target.closest('.slot'); if (!b || b.disabled) return;
  N.slot = Number(b.dataset.i); nErr('');
  $('#nSlots').innerHTML = slotsHtml(N.slots, N.slot, N.giorno);
  const s = N.slots[N.slot], i = new Date(s.inizio), f = new Date(s.fine);
  const sum = $('#nSummary');
  sum.innerHTML = `<b>${esc(fmtDateLong(i))}</b><br>${fmtTime(i)}–${fmtTime(f)}<br>${esc($('#nTipo').selectedOptions[0].textContent)}<br>${esc($('#nRis').selectedOptions[0].textContent)}`;
  sum.hidden = false; sum.scrollIntoView({behavior: 'smooth', block: 'nearest'});
};
// nome già presente in agenda → precompila telefono ed email
$('#nNome').addEventListener('input', e => {
  const k = N.known.get(e.target.value.trim().toLowerCase()); if (!k) return;
  if (!$('#nTel').value) $('#nTel').value = k.telefono || '';
  if (!$('#nEmail').value) $('#nEmail').value = k.email || '';
});
$('#newForm').onsubmit = async e => {
  e.preventDefault(); nErr('');
  const nome = $('#nNome').value.trim(), tel = $('#nTel').value.trim(), email = $('#nEmail').value.trim();
  $$('#newForm input').forEach(i => i.classList.remove('invalid'));
  if (N.slot == null) return nErr('Scegli prima servizio, giorno e orario.');
  if (nome.length < 2) { $('#nNome').classList.add('invalid'); return nErr('Inserisci nome e cognome.'); }
  if (tel.replace(/\D/g, '').length < 6) { $('#nTel').classList.add('invalid'); return nErr('Inserisci un numero di telefono valido.'); }
  if (email && !$('#nEmail').checkValidity()) { $('#nEmail').classList.add('invalid'); return nErr('L’indirizzo email non sembra valido.'); }
  if (!$('#nPriv').checked) return nErr('Serve il consenso al trattamento dei dati.');
  const btn = $('#nSubmit'); btn.disabled = true;
  try {
    const s = N.slots[N.slot];
    await api(ADMIN_BOOK, {method: 'POST', auth: true, body: {
      strutturaId: S.strutturaId, risorsaId: $('#nRis').value, tipoServizioId: $('#nTipo').value, inizio: s.inizio,
      nomeCliente: nome, telefono: tel, email: email || null, note: $('#nNote').value.trim() || null,
      privacyAccettata: true, trattamentoDatiAccettato: true}});
    $('#dlgNew').close();
    toast('Appuntamento creato', 'ok');
    A.fData = isoDay(new Date(s.inizio));   // l'agenda salta al giorno del nuovo appuntamento
    if (A.view === 'appuntamenti' && $('#calBar')) await navCal();
  } catch (err) {
    nErr(err.message || String(err));
    if (err.status === 409) loadNSlots().catch(() => {});   // slot appena occupato: aggiorna gli orari
  } finally { btn.disabled = false; }
};

/* ---- filtri e selezioni ---- */
const searchDebounced = debounce(() => paintApps(), 150);
$('#adminMain').addEventListener('change', e => {
  if (e.target.id === 'fData')  { if (e.target.value) { A.fData = e.target.value; run(null, navCal); } }
  if (e.target.id === 'fStato') { A.fStato = e.target.value; paintApps(); }
  if (e.target.id === 'fRis')   { A.fRis = e.target.value; paintApps(); }
  if (e.target.id === 'oRis')   { A.risorsaSel = e.target.value; run(null, vOrari); }
});
$('#adminMain').addEventListener('input', e => {
  if (e.target.id === 'fQ') { A.fQ = e.target.value; searchDebounced(); }
  if (e.target.id === 'qrBase') paintQr().catch(() => {});
});

/* =====================================================
   Avvio + PWA
   ===================================================== */
renderStrip();
updateAccountBtn();
refreshMineCount();
checkHealth();
setInterval(checkHealth, 30000);
run(null, loadStrutture);

// link nelle email: https://sito/#verify=TOKEN  e  https://sito/#reset=TOKEN
// (il frammento dopo # non viene mai inviato al server né finisce nei suoi log)
const hash = (location.hash || '').slice(1);
const hp = new URLSearchParams(hash);
if (hp.get('verify')) {
  const t = hp.get('verify');
  try { history.replaceState(null, '', location.pathname); } catch {}
  run(null, async () => {
    await api('/api/clienti/verifica-email', {method: 'POST', body: {token: t}});
    toast('Email confermata! Ora puoi accedere.', 'ok'); openAuth('login');
  });
} else if (hp.get('reset')) {
  resetToken = hp.get('reset');
  try { history.replaceState(null, '', location.pathname); } catch {}
  openAuth('reset');
} else if (['prenota', 'mie', 'admin'].includes(hash)) setMode(hash);
// dispositivo della gestione (c'è stato un accesso admin): l'app si apre sull'agenda, a meno che arrivi da un link cliente (?s=)
else if (store.get('staff') === '1' && !new URLSearchParams(location.search).get('s')) setMode('admin');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).catch(() => {}));
}
})();
