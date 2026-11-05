// Saisie des coupons navettes (bouton "🎫 Coupons" de l'en-tête).
//
// Remplace la feuille "semaine" du classeur "Affectation des coupons" :
// un écran par jour, une carte par navette (LF1-LF3, LN1-LN2, LA1, plus
// LF4/LN3/LA2... au besoin), 4 lignes par carte comme dans le classeur :
//   C | N° du coupon | code site (LHTTDF/LHTTMS/LHTATL) | date jjmm | Nb wgs
// La date du coupon peut précéder celle de la navette (coupon du vendredi
// pour la navette du lundi) : elle est proposée (jour ouvré précédent) mais
// jamais imposée. Ce qui compte, c'est que le numéro corresponde au coupon.
//
// Données : localStorage (STORAGE_KEYS.coupons, voir storage.js), comme le
// reste de l'app. Export Excel (jour ou semaine) au format exact du
// classeur, et import d'un classeur existant (ou d'un export) pour
// reprendre l'historique — via ExcelJS chargé à la demande (mis en cache
// par le Service Worker pour fonctionner hors-ligne).
//
// Le module est autonome : il crée sa propre fenêtre plein écran
// (#couponsRoot) et n'utilise rien d'app.js. Point d'entrée : openCoupons().

import { COUPON_FAMILIES as FAMS } from './config.js';
import { loadCoupons, saveCoupons, loadSettings } from './storage.js';

const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JC = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const famOf = (s) => FAMS.find((f) => s.startsWith(f.id));

// ---------- Dates ----------
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return iso(d); };
const mondayOf = (s) => { const d = toDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
function isoWeek(s) {
  const d = toDate(s); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const j4 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((d - j4) / 864e5 - 3 + ((j4.getDay() + 6) % 7)) / 7);
}
const todayISO = () => iso(new Date());
const longDay = (s) => { const d = toDate(s); return JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear(); };
const shortDay = (s) => { const d = toDate(s); return JC[d.getDay()] + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1); };
const dcFromISO = (s) => { const d = toDate(s); return d.getDate() * 100 + d.getMonth() + 1; };
function prevWorking(s) { let p = addDays(s, -1); while ([0, 6].includes(toDate(p).getDay())) p = addDays(p, -1); return p; }
// Date de coupon "jour+mois" comme dans le classeur : 2210, 0511, 511, 5/11, 05.11
function parseDC(txt) {
  txt = String(txt ?? '').trim();
  let dd, mm; const m = txt.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})$/);
  if (m) { dd = +m[1]; mm = +m[2]; }
  else if (/^\d{3,4}$/.test(txt)) { const v = +txt; dd = Math.floor(v / 100); mm = v % 100; }
  else return null;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  return dd * 100 + mm;
}
const fmtDC = (dc) => (typeof dc === 'number' && dc >= 101) ? String(dc).padStart(4, '0') : (dc == null ? '' : String(dc));
function dcToISO(dc, dayS) {
  if (typeof dc !== 'number' || dc < 101) return null;
  const dd = Math.floor(dc / 100), mm = dc % 100;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const day = toDate(dayS); let y = day.getFullYear();
  if (mm > day.getMonth() + 2) y--; // coupon de décembre saisi en janvier
  const d = new Date(y, mm - 1, dd, 12);
  return d.getMonth() === mm - 1 ? iso(d) : null;
}
const fmtN = (n) => (typeof n === 'number' ? pad(n) : (n == null ? '' : String(n)));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- État ----------
const state = {
  day: todayISO(), view: 'saisie', docs: {}, rows: {}, active: {},
  index: new Map(), wagonTop: {}, root: null,
};
const getDoc = (day) => state.docs[day] || { date: day, nav: {} };
const sumW = (lines) => (lines || []).reduce((a, l) => a + (typeof l.w === 'number' ? l.w : 0), 0);
const dayCount = (doc) => (doc ? Object.values(doc.nav || {}).reduce((a, l) => a + l.length, 0) : 0);

// Index des coupons déjà saisis (même famille + N° + date) et nombres de
// wagons les plus fréquents par famille (raccourcis de saisie).
function rebuildIndex() {
  const idx = new Map(); const freq = {};
  for (const [date, doc] of Object.entries(state.docs)) {
    for (const [s, lines] of Object.entries(doc.nav || {})) {
      const f = famOf(s); if (!f) continue;
      (lines || []).forEach((l, i) => {
        const k = f.id + '|' + l.n + '|' + l.dc;
        if (!idx.has(k)) idx.set(k, []);
        idx.get(k).push({ date, s, i });
        if (typeof l.w === 'number') { freq[f.id] = freq[f.id] || {}; freq[f.id][l.w] = (freq[f.id][l.w] || 0) + 1; }
      });
    }
  }
  state.index = idx;
  for (const f of FAMS) {
    const top = Object.entries(freq[f.id] || {}).sort((a, b) => b[1] - a[1]).map((e) => +e[0]);
    state.wagonTop[f.id] = [...new Set([...top, 9, 18, 27, 8])].slice(0, 4).sort((a, b) => a - b);
  }
}

function lineIssues(day, s, i, l) {
  const out = []; const f = famOf(s);
  const dISO = dcToISO(l.dc, day);
  if (!dISO) out.push({ lvl: 'err', txt: 'Date du coupon illisible (' + esc(l.dc ?? 'vide') + ')' });
  else if (dISO > day) out.push({ lvl: 'warn', txt: 'Date du coupon après le ' + shortDay(day) + ' : à vérifier' });
  if (l.w == null) out.push({ lvl: 'warn', txt: l.note ? 'Wagons : « ' + esc(l.note) + ' »' : 'Nombre de wagons manquant' });
  else if (l.w > 40 || l.w <= 0) out.push({ lvl: 'warn', txt: l.w + ' wagons, valeur inhabituelle' });
  const others = (state.index.get(f.id + '|' + l.n + '|' + l.dc) || []).filter((o) => !(o.date === day && o.s === s && o.i === i));
  if (others.length) {
    const o = others[0];
    out.push({ lvl: 'warn', txt: 'Déjà saisi ' + (o.date === day ? "aujourd'hui" : 'le ' + shortDay(o.date)) + ' sur ' + o.s + (others.length > 1 ? ' (+' + (others.length - 1) + ')' : '') });
  }
  return out;
}

// ---------- Mutations ----------
function persist() {
  if (!saveCoupons(state.docs)) toast('Enregistrement impossible : stockage de l’appareil plein.');
}
// Envoi des coupons d'une journée vers l'onglet "Coupons" du Google Sheet
// (même adresse que le Journal, Réglages) : la saisie du Suivi des
// circulations les relit et les affiche (bouton 🎫 Coupons de la saisie).
// Toute la journée est renvoyée à chaque changement, 2 s après la dernière
// frappe ; sans adresse configurée, rien ne part.
const pushTimers = {};
function couponRows(day) {
  const doc = getDoc(day); const rows = [];
  Object.keys(doc.nav || {}).sort().forEach((s) => {
    const f = famOf(s);
    (doc.nav[s] || []).forEach((l, i) => rows.push({
      navette: s, ligne: i + 1, numero: fmtN(l.n), site: f ? f.code : '', dateCoupon: fmtDC(l.dc),
      wagons: typeof l.w === 'number' ? l.w : '', note: l.note || '',
    }));
  });
  return rows;
}
function schedulePushCoupons(day) {
  clearTimeout(pushTimers[day]);
  pushTimers[day] = setTimeout(() => pushCoupons(day), 2000);
}
async function pushCoupons(day) {
  let url = '';
  try { url = (loadSettings() || {}).sheetsWebAppUrl || ''; } catch (e) { url = ''; }
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'logCoupons', date: day, coupons: couponRows(day), misAJour: new Date().toISOString() }),
    });
  } catch (e) { /* hors ligne : renvoyé au prochain changement de la journée */ }
}

function mutate(day, fn) {
  const doc = JSON.parse(JSON.stringify(getDoc(day)));
  doc.nav = doc.nav || {};
  fn(doc);
  for (const k of Object.keys(doc.nav)) if (!doc.nav[k].length && !(doc.keep || []).includes(k)) delete doc.nav[k];
  doc.maj = new Date().toISOString();
  const empty = !Object.values(doc.nav).some((a) => a.length) && !(doc.keep || []).length;
  if (empty) delete state.docs[day]; else state.docs[day] = doc;
  rebuildIndex(); persist(); render();
  schedulePushCoupons(day);
}

function shuttlesFor(day, f) {
  const doc = getDoc(day);
  const set = new Set(f.base);
  Object.keys(doc.nav || {}).forEach((k) => { if (k.startsWith(f.id)) set.add(k); });
  (doc.keep || []).forEach((k) => { if (k.startsWith(f.id)) set.add(k); });
  return [...set].sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
}

function defaultDCText(s) {
  const lines = getDoc(state.day).nav[s] || [];
  const last = lines[lines.length - 1];
  if (last && typeof last.dc === 'number' && last.dc >= 101) return fmtDC(last.dc);
  return fmtDC(dcFromISO(prevWorking(state.day)));
}

// Lignes de la grille : une ligne saisie = un coupon. Ce que l'utilisateur
// tape reste dans state.rows tant que la ligne n'est pas validée (Entrée,
// clic sur un nombre de wagons, ou sortie de la ligne).
const rowKey = (s, k) => state.day + '|' + s + '|' + k;
const savedVals = (l) => ({ n: l ? fmtN(l.n) : '', d: l ? fmtDC(l.dc) : '', w: l && l.w != null ? String(l.w) : '' });
function rowVals(s, k) {
  const r = state.rows[rowKey(s, k)]; if (r) return r;
  const l = (getDoc(state.day).nav[s] || [])[k];
  return l ? savedVals(l) : { n: '', d: '', w: '' };
}
const rowCount = (n) => (n < 4 ? 4 : n + 1);
function draftRow(s, k) { const key = rowKey(s, k); if (!state.rows[key]) state.rows[key] = { ...rowVals(s, k) }; return state.rows[key]; }

function commitRow(s, k, opts = {}) {
  const key = rowKey(s, k); const r = state.rows[key]; if (!r) return true;
  const lines = getDoc(state.day).nav[s] || []; const saved = lines[k];
  let nTxt = String(r.n).trim(), dTxt = String(r.d).trim(), wTxt = String(r.w).trim();
  // Saisie express dans N° : "2 27" (N° + wagons) ou "2 27 2210" (+ date)
  const parts = nTxt.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) { nTxt = parts[0]; wTxt = parts[1]; if (parts[2]) dTxt = parts[2]; }
  if (!dTxt && !saved) dTxt = defaultDCText(s);
  if (saved) {
    const sv = savedVals(saved);
    if (sv.n === nTxt && sv.d === dTxt && sv.w === wTxt) {
      delete state.rows[key];
      if (opts.next) { render(); focusCell(s, k + 1, 'n'); } else if (opts.render) render();
      return true;
    }
  } else if (!nTxt && !wTxt) { delete state.rows[key]; if (opts.render) render(); return true; }
  const bad = [];
  if (!nTxt) bad.push('n');
  const dc = parseDC(dTxt); if (dc == null) bad.push('d');
  const w = /^\d{1,3}$/.test(wTxt) ? +wTxt : null; if (w == null) bad.push('w');
  if (bad.length) {
    state.rows[key] = { n: nTxt, d: dTxt, w: wTxt, bad };
    render();
    if (opts.next) {
      focusCell(s, k, bad[0]);
      toast(bad.includes('n') ? 'Indiquez le numéro du coupon.' : bad.includes('d') ? 'Date du coupon : jour + mois, par ex. 2210.' : 'Indiquez le nombre de wagons.');
    }
    return false;
  }
  const line = { n: /^\d{1,3}$/.test(nTxt) ? +nTxt : nTxt, dc, w };
  delete state.rows[key];
  mutate(state.day, (doc) => {
    const arr = doc.nav[s] = doc.nav[s] || [];
    if (k < arr.length) { if (arr[k].t) line.t = arr[k].t; arr[k] = line; }
    else { line.t = Date.now(); arr.push(line); }
  });
  if (opts.next) { const nk = Math.min(k, lines.length) + 1; state.active[s] = nk; focusCell(s, nk, 'n'); }
  return true;
}

function commitPending() {
  for (const key of Object.keys(state.rows)) {
    const [day, s, k] = key.split('|'); if (day !== state.day) continue;
    commitRow(s, +k, { render: true });
  }
}

function removeLine(s, i) {
  const day = state.day; const old = (getDoc(day).nav[s] || [])[i]; if (!old) return;
  for (const key of Object.keys(state.rows)) if (key.startsWith(day + '|' + s + '|')) delete state.rows[key];
  mutate(day, (doc) => { doc.nav[s].splice(i, 1); });
  toast('Coupon ' + fmtN(old.n) + ' ' + famOf(s).code + ' ' + fmtDC(old.dc) + ' retiré de ' + s + '.', () => mutate(day, (doc) => { doc.nav[s] = doc.nav[s] || []; doc.nav[s].splice(i, 0, old); }));
}

function activeRow(s) {
  const n = (getDoc(state.day).nav[s] || []).length;
  const a = state.active[s];
  return (a != null && a < rowCount(n)) ? a : Math.min(n, rowCount(n) - 1);
}

// ---------- Rendu ----------
const q = (sel) => state.root.querySelector(sel);
function focusCell(s, k, f) {
  requestAnimationFrame(() => { const el = document.getElementById('cp-' + f + '-' + s + '-' + k); if (el) { el.focus(); if (el.select) el.select(); } });
}

function render() {
  if (!state.root) return;
  for (const v of ['saisie', 'semaine']) {
    q('#cp-v-' + v).hidden = state.view !== v;
    q('#cp-tab-' + v).setAttribute('aria-selected', String(state.view === v));
  }
  if (state.view === 'saisie') renderSaisie(); else renderSemaine();
}

function renderSaisie() {
  const day = state.day;
  const ae = document.activeElement; const keepId = ae && ae.id && ae.id.startsWith('cp-') ? ae.id : null;
  const selS = keepId ? ae.selectionStart : null, selE = keepId ? ae.selectionEnd : null;
  q('#cp-dayTitle').textContent = longDay(day);
  q('#cp-daySub').textContent = 'Semaine ' + isoWeek(day);
  q('#cp-datePick').value = day;

  const mon = mondayOf(day); let ws = '';
  for (let k = 0; k < 6; k++) {
    const d = addDays(mon, k); const doc = state.docs[d];
    const n = dayCount(doc); const w = doc ? Object.values(doc.nav || {}).reduce((a, l) => a + sumW(l), 0) : 0;
    ws += '<button type="button" class="cp-wday' + (d === day ? ' on' : '') + (d === todayISO() ? ' today' : '') + (n ? '' : ' empty') + (k === 5 ? ' sat' : '') + '" data-day="' + d + '"><b>' + shortDay(d) + '</b><span>' + (n ? w + ' wgs · ' + n + ' c.' : 'vide') + '</span></button>';
  }
  q('#cp-weekStrip').innerHTML = ws;

  const doc = getDoc(day); let html = '';
  for (const f of FAMS) {
    const shuttles = shuttlesFor(day, f);
    const tot = shuttles.reduce((a, s) => a + sumW(doc.nav[s]), 0);
    html += '<section class="cp-site cp-fam-' + f.id + '"><div class="cp-site-h"><i class="cp-sw"></i><h3>' + f.id + ' · ' + f.code + '</h3><span class="cp-site-tot"><b>' + tot + '</b> wgs</span></div><div class="cp-cards">';
    for (const s of shuttles) html += cardHTML(day, f, s, doc.nav[s] || []);
    html += '<button type="button" class="cp-add-shuttle" data-addshuttle="' + f.id + '">+ navette ' + f.id + (shuttles.length + 1) + '</button>';
    html += '</div></section>';
  }
  q('#cp-sites').innerHTML = html;
  renderAside(day);
  if (keepId) { const el = document.getElementById(keepId); if (el && el !== document.activeElement) { el.focus(); try { el.setSelectionRange(selS, selE); } catch (e) { /* champ sans sélection */ } } }
}

function cardHTML(day, f, s, lines) {
  const nRows = rowCount(lines.length);
  let rows = '<div class="cp-row cp-head" aria-hidden="true"><span></span><span>N°</span><span>Code</span><span>Date</span><span>Wgs</span><span></span></div>';
  for (let k = 0; k < nRows; k++) {
    const l = lines[k]; const v = rowVals(s, k); const pending = !!state.rows[rowKey(s, k)]; const bad = (state.rows[rowKey(s, k)] || {}).bad || [];
    const inp = (fld, label) => '<input id="cp-' + fld + '-' + s + '-' + k + '" data-f="' + fld + '" data-s="' + s + '" data-k="' + k + '" inputmode="numeric" enterkeyhint="next" autocomplete="off" aria-label="' + label + ' ligne ' + (k + 1) + ' ' + s + '" value="' + esc(v[fld]) + '"' + (fld === 'd' && !l ? ' placeholder="' + esc(defaultDCText(s)) + '"' : '') + (bad.includes(fld) ? ' class="bad"' : '') + '>';
    rows += '<div class="cp-row' + (l ? ' filled' : '') + (pending ? ' pending' : '') + '" data-s="' + s + '" data-k="' + k + '"><span class="cp-c">C</span>' + inp('n', 'Numéro') + '<span class="cp-code">' + f.code + '</span>' + inp('d', 'Date') + inp('w', 'Wagons') +
      '<button type="button" class="cp-del" tabindex="-1" data-del="' + s + '|' + k + '" aria-label="Retirer la ligne ' + (k + 1) + '"' + (l ? '' : ' style="visibility:hidden"') + '>×</button></div>';
    const iss = l && !pending ? lineIssues(day, s, k, l) : [];
    if (pending && !bad.length) iss.push({ lvl: 'info', txt: 'Non enregistrée : Entrée pour valider' });
    if (iss.length) rows += '<div class="cp-row-issues">' + iss.map((x) => '<span class="cp-issue ' + x.lvl + '">' + x.txt + '</span>').join('') + '</div>';
  }
  const ak = activeRow(s); const avd = rowVals(s, ak).d || defaultDCText(s);
  const chipsD = [prevWorking(prevWorking(day)), prevWorking(day), day].map((d) => { const t = fmtDC(dcFromISO(d)); return '<button type="button" class="cp-chip cp-chip-d' + (avd === t ? ' on' : '') + '" data-setd="' + s + '|' + t + '" title="' + shortDay(d) + '"><small>' + JC[toDate(d).getDay()] + '</small> ' + t + '</button>'; }).join('');
  const chipsW = (state.wagonTop[f.id] || [9, 18, 27]).map((w) => '<button type="button" class="cp-chip" data-setw="' + s + '|' + w + '" title="' + w + ' wagons">' + w + '</button>').join('');
  return '<div class="cp-card"><div class="cp-card-h"><span class="cp-shuttle">' + s + '</span><span class="cp-card-code">' + f.code + '</span><span class="cp-tot"><b>' + sumW(lines) + '</b><small>wagons</small></span></div>' +
    '<div class="cp-grid">' + rows + '</div>' +
    '<div class="cp-chips"><span class="cp-lab">Date</span>' + chipsD + '</div><div class="cp-chips"><span class="cp-lab">Wgs</span>' + chipsW + '</div></div>';
}

function renderAside(day) {
  const doc = getDoc(day); let total = 0, count = 0; const per = []; const alerts = [];
  for (const f of FAMS) {
    let t = 0;
    for (const s of shuttlesFor(day, f)) {
      (doc.nav[s] || []).forEach((l, i) => {
        t += typeof l.w === 'number' ? l.w : 0; count++;
        lineIssues(day, s, i, l).forEach((x) => alerts.push({ lvl: x.lvl, txt: s + ' · ' + esc(fmtN(l.n)) + ' ' + f.code + ' ' + esc(fmtDC(l.dc)) + ' : ' + x.txt }));
      });
    }
    per.push({ f, t }); total += t;
  }
  const errs = alerts.filter((a) => a.lvl === 'err').length;
  const al = alerts.length
    ? alerts.slice(0, 8).map((a) => '<li class="' + a.lvl + '">' + a.txt + '</li>').join('') + (alerts.length > 8 ? '<li class="warn">+ ' + (alerts.length - 8) + ' autres</li>' : '')
    : (count ? '<li class="ok">Aucune anomalie détectée</li>' : '');
  q('#cp-aside').innerHTML =
    '<div class="cp-panel"><h3>Récap du jour</h3><div class="cp-big"><b>' + total + '</b><span>wagons · ' + count + ' coupon' + (count > 1 ? 's' : '') + '</span></div>' +
    '<div class="cp-kv">' + per.map((p) => '<div class="cp-fam-' + p.f.id + '"><i class="cp-sw"></i>' + p.f.code + ' <span class="cp-meta">(' + p.f.id + ')</span><b>' + p.t + '</b></div>').join('') + '</div>' +
    '<button type="button" class="btn btn-primary" data-action="export-day"' + (count ? '' : ' disabled') + '>📥 Extraire le jour en Excel</button></div>' +
    (al ? '<div class="cp-panel"><h3>Contrôles' + (errs ? ' · ' + errs + ' à corriger' : '') + '</h3><ul class="cp-alerts">' + al + '</ul></div>' : '') +
    '<div class="cp-panel"><h3>Semaine ' + isoWeek(day) + '</h3><p class="cp-meta">Totaux de la semaine, export Excel et import du classeur.</p><button type="button" class="btn btn-outline" data-view="semaine">Voir la semaine</button></div>';
}

function weekDays(mon) {
  const days = []; for (let k = 0; k < 5; k++) days.push(addDays(mon, k));
  const sat = addDays(mon, 5);
  if (dayCount(state.docs[sat])) days.push(sat);
  return days;
}

function renderSemaine() {
  const mon = mondayOf(state.day); const days = weekDays(mon);
  q('#cp-weekTitle').textContent = 'Semaine ' + isoWeek(mon) + ' · du ' + shortDay(mon) + ' au ' + shortDay(days[days.length - 1]);
  let h = '<thead><tr><th>Navette</th>' + days.map((d) => '<th class="cp-clickable" data-openday="' + d + '">' + shortDay(d) + '</th>').join('') + '<th>Semaine</th></tr></thead><tbody>';
  const colTot = days.map(() => 0); let grand = 0, grandC = 0;
  for (const f of FAMS) {
    const all = new Set(); days.forEach((d) => shuttlesFor(d, f).forEach((s) => all.add(s)));
    const list = [...all].sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
    const sub = days.map(() => 0); let subT = 0;
    for (const s of list) {
      let rowT = 0;
      const cells = days.map((d, k) => { const l = getDoc(d).nav[s] || []; const w = sumW(l); rowT += w; grandC += l.length; sub[k] += w; return '<td class="cp-n' + (l.length ? '' : ' zero') + '">' + (l.length ? w + '<small>' + l.length + 'c</small>' : '·') + '</td>'; }).join('');
      subT += rowT;
      h += '<tr><td><span class="cp-tag cp-fam-' + f.id + '"><i class="cp-sw"></i>' + s + '</span></td>' + cells + '<td class="cp-n">' + rowT + '</td></tr>';
    }
    h += '<tr class="cp-sub"><td>' + f.code + '</td>' + sub.map((v) => '<td class="cp-n">' + v + '</td>').join('') + '<td class="cp-n">' + subT + '</td></tr>';
    sub.forEach((v, k) => { colTot[k] += v; }); grand += subT;
  }
  h += '<tr class="cp-total"><td>Total wagons</td>' + colTot.map((v) => '<td class="cp-n">' + v + '</td>').join('') + '<td class="cp-n">' + grand + '<small>' + grandC + 'c</small></td></tr></tbody>';
  q('#cp-weekTable').innerHTML = h;
  const nDays = Object.keys(state.docs).length;
  q('#cp-stored').textContent = nDays ? nDays + ' journée' + (nDays > 1 ? 's' : '') + ' de coupons enregistrée' + (nDays > 1 ? 's' : '') + ' sur cet appareil.' : 'Aucun coupon enregistré sur cet appareil pour l’instant.';
}

// ---------- Excel ----------
let excelLoading = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (excelLoading) return excelLoading;
  excelLoading = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = EXCELJS_URL;
    sc.onload = () => res(window.ExcelJS);
    sc.onerror = () => { excelLoading = null; rej(new Error('ExcelJS')); };
    document.head.appendChild(sc);
  });
  return excelLoading;
}

// Reproduit la feuille "semaine" du classeur : un bloc par jour (date en
// A, fusionnée A:R), LF1-LF3 en colonnes B/H/N, puis LN, puis LA ; 4 lignes
// minimum par navette (C | N° | code | date | Nb wgs), TOTAL en formules.
async function buildWorkbook(days, sheetName) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const widths = [2.66, 3.66, 7.66, 5.66, 10.89, 11.55];
  const cols = [{ width: 11.55 }]; for (let c = 1; c < 19; c++) cols.push({ width: widths[(c - 1) % 6] });
  ws.columns = cols;
  const thin = { style: 'thin' }; const box = { top: thin, left: thin, bottom: thin, right: thin };
  const center = { horizontal: 'center', vertical: 'middle' };
  const orange = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
  const L = (n) => String.fromCharCode(64 + n);
  let r = 1;
  for (const day of days) {
    const [y, m, d] = day.split('-').map(Number);
    const a = ws.getCell(r, 1); a.value = new Date(Date.UTC(y, m - 1, d)); a.numFmt = 'dddd\\ d\\ mmm\\ yyyy'; a.font = { bold: true, size: 11 }; a.alignment = center;
    ws.mergeCells(r, 1, r, 18);
    r += 2;
    const doc = getDoc(day);
    for (const f of FAMS) {
      const shuttles = shuttlesFor(day, f);
      for (let g = 0; g < shuttles.length; g += 3) {
        const chunk = shuttles.slice(g, g + 3);
        const n = Math.max(4, ...chunk.map((s) => (doc.nav[s] || []).length));
        chunk.forEach((s, k) => {
          const b = 2 + 6 * k;
          const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f.excelFill } };
          const hc = ws.getCell(r, b); hc.value = s; ws.mergeCells(r, b, r, b + 3);
          hc.fill = fill; hc.font = { size: 12 }; hc.alignment = center; hc.border = box;
          const nb = ws.getCell(r, b + 4); nb.value = 'Nb wgs'; nb.fill = fill; nb.font = { size: 12 }; nb.alignment = center; nb.border = box;
          const lines = doc.nav[s] || []; const refs = []; let sum = 0;
          for (let i = 0; i < n; i++) {
            const rr = r + 1 + 2 * i; const l = lines[i] || {};
            const vals = ['C', l.n ?? null, f.code, l.dc ?? null, (typeof l.w === 'number' ? l.w : (l.note || null))];
            vals.forEach((v, j) => {
              const c = ws.getCell(rr, b + j); c.value = v; c.border = box; c.alignment = center;
              if (j === 1 || j === 3) { c.fill = orange; c.numFmt = '00'; }
            });
            refs.push(L(b + 4) + rr); if (typeof l.w === 'number') sum += l.w;
            if (i < n - 1) { ws.getRow(rr + 1).height = 3; ws.mergeCells(rr + 1, b, rr + 1, b + 4); }
          }
          const tc = ws.getCell(r + 2 * n, b + 4);
          tc.value = { formula: refs.join('+'), result: sum }; tc.font = { bold: true, color: { argb: 'FFFF0000' } }; tc.alignment = center;
        });
        const tr = r + 2 * n; ws.getCell(tr, 1).value = 'TOTAL'; ws.getCell(tr, 1).alignment = center;
        r = tr + 1;
      }
    }
    r += 1;
  }
  return wb.xlsx.writeBuffer();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportExcel(btn, days, sheetName, filename) {
  commitPending();
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Préparation…';
  try {
    const buf = await buildWorkbook(days, sheetName);
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
    toast('Fichier Excel créé : ' + filename);
  } catch (e) {
    toast(e && e.message === 'ExcelJS' ? "Le module Excel n'a pas pu se charger (connexion ?). Réessayez une fois en ligne." : "L'export a échoué : " + ((e && e.message) || 'erreur') + '.');
  }
  btn.disabled = false; btn.textContent = label;
}
function exportDay(btn) {
  const d = toDate(state.day); const lbl = pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear();
  exportExcel(btn, [state.day], JC[d.getDay()] + ' ' + pad(d.getDate()) + '-' + pad(d.getMonth() + 1), 'Coupons_' + JOURS[d.getDay()] + '_' + lbl + '.xlsx');
}
function exportWeek(btn) {
  const mon = mondayOf(state.day);
  exportExcel(btn, weekDays(mon), 'semaine ' + isoWeek(mon), 'Coupons_semaine_' + isoWeek(mon) + '_' + mon.slice(0, 4) + '.xlsx');
}

// Import d'un classeur "Affectation des coupons" (toutes les feuilles
// "semaine"), ou d'un export de cet écran. Les navettes sont reconnues par
// leur position (colonne B/H/N = 1/2/3) et le code site de la ligne.
function cellVal(cell) {
  const v = cell.value;
  if (v == null) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if ('result' in v) return v.result ?? null;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
  if ('text' in v) return v.text;
  return null;
}
const isoUTC = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());

async function parseWorkbook(file) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const found = {};
  wb.eachSheet((ws) => {
    if (/vierge/i.test(ws.name)) return;
    const rowDate = {}; let cur = null;
    for (let r = 1; r <= ws.rowCount; r++) {
      const cA = ws.getCell(r, 1); let a = cellVal(cA);
      if (typeof a === 'number' && a > 30000 && a < 80000 && /[dy]/i.test(cA.numFmt || '')) a = new Date(Math.round((a - 25569) * 864e5));
      if (a == null && cA.value && cA.value.formula) {
        const m = String(cA.value.formula).match(/^A(\d+)\s*\+\s*(\d+)$/i);
        if (m && rowDate[m[1]]) a = new Date(Date.UTC(...rowDate[m[1]].split('-').map((x, i) => (i === 1 ? +x - 1 : +x))) + (+m[2]) * 864e5);
      }
      if (a instanceof Date && !isNaN(a)) { cur = isoUTC(a); rowDate[r] = cur; }
      if (!cur) continue;
      [2, 8, 14].forEach((c, ci) => {
        if (String(cellVal(ws.getCell(r, c)) ?? '').trim().toUpperCase() !== 'C') return;
        const code = String(cellVal(ws.getCell(r, c + 2)) ?? '').trim().toUpperCase();
        const f = FAMS.find((x) => x.code === code); if (!f) return;
        const n = cellVal(ws.getCell(r, c + 1)); const dcRaw = cellVal(ws.getCell(r, c + 3)); const w = cellVal(ws.getCell(r, c + 4));
        if ((n == null || n === '') && (w == null || w === '')) return;
        const line = {
          n: typeof n === 'number' ? n : (n == null || n === '' ? null : String(n).trim()),
          dc: typeof dcRaw === 'number' ? dcRaw : (parseDC(dcRaw) ?? (dcRaw == null ? null : String(dcRaw))),
          w: typeof w === 'number' ? w : null,
        };
        if (typeof w !== 'number' && w != null && String(w).trim()) line.note = String(w).trim();
        const s = f.id + (ci + 1);
        if (!found[cur]) found[cur] = { date: cur, nav: {} };
        (found[cur].nav[s] = found[cur].nav[s] || []).push(line);
      });
    }
  });
  return found;
}

async function importFile(file, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Lecture du fichier…';
  try {
    const found = await parseWorkbook(file);
    let added = 0, skipped = 0, coupons = 0;
    for (const [date, doc] of Object.entries(found)) {
      if (dayCount(state.docs[date])) { skipped++; continue; }
      state.docs[date] = { ...doc, source: 'import', maj: new Date().toISOString() };
      added++; coupons += dayCount(doc);
      if (date >= addDays(todayISO(), -1)) schedulePushCoupons(date);
    }
    rebuildIndex(); persist(); render();
    if (!added && !skipped) toast('Aucun coupon reconnu dans ce fichier.');
    else toast(added + ' journée' + (added > 1 ? 's' : '') + ' importée' + (added > 1 ? 's' : '') + ' (' + coupons + ' coupons)' + (skipped ? ', ' + skipped + ' déjà saisie' + (skipped > 1 ? 's' : '') + ' laissée' + (skipped > 1 ? 's' : '') + ' telle' + (skipped > 1 ? 's' : '') + ' quelle' + (skipped > 1 ? 's' : '') : '') + '.');
  } catch (e) {
    toast(e && e.message === 'ExcelJS' ? "Le module Excel n'a pas pu se charger (connexion ?)." : 'Fichier illisible : choisissez un classeur Excel (.xlsx).');
  }
  btn.disabled = false; btn.textContent = label;
}

// ---------- Toast ----------
let toastTimer = null, undoFn = null;
function toast(msg, undo) {
  const t = q('#cp-toast'); q('#cp-toastMsg').textContent = msg;
  const u = q('#cp-toastUndo'); undoFn = undo || null; u.hidden = !undo;
  t.hidden = false; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; undoFn = null; }, undo ? 6000 : 4000);
}

// ---------- Fenêtre ----------
const SHELL = `
  <div class="cp-top">
    <div class="cp-top-row">
      <h2 class="cp-title"><span aria-hidden="true">🎫</span> Coupons navettes</h2>
      <nav class="cp-tabs" role="tablist" aria-label="Vues coupons">
        <button type="button" class="cp-tab" role="tab" id="cp-tab-saisie" data-view="saisie">Saisie du jour</button>
        <button type="button" class="cp-tab" role="tab" id="cp-tab-semaine" data-view="semaine">Semaine &amp; Excel</button>
      </nav>
      <button type="button" class="icon-btn cp-close" data-action="close" aria-label="Fermer les coupons">✕</button>
    </div>
  </div>
  <div class="cp-body">
    <section id="cp-v-saisie">
      <div class="cp-daybar">
        <button type="button" class="icon-btn" data-action="prev-day" aria-label="Jour précédent">‹</button>
        <div class="cp-daytitle"><strong id="cp-dayTitle"></strong><span id="cp-daySub"></span></div>
        <button type="button" class="icon-btn" data-action="next-day" aria-label="Jour suivant">›</button>
        <button type="button" class="btn btn-outline" data-action="today">Aujourd'hui</button>
        <label class="btn btn-ghost cp-datepick">📅 Date<input type="date" id="cp-datePick" aria-label="Choisir une date"></label>
      </div>
      <div class="cp-week-strip" id="cp-weekStrip"></div>
      <div class="cp-layout">
        <div>
          <p class="cp-hint">Comme dans le classeur : <b>N°</b> <kbd>Tab</kbd> <b>date</b> (proposée, ex. 2210) <kbd>Tab</kbd> <b>wagons</b> <kbd>Entrée</kbd> → ligne suivante. Plus rapide : <kbd>2 27</kbd> dans N° puis <kbd>Entrée</kbd>, ou le N° puis un clic sur un nombre de wagons. Une ligne remplie se corrige directement.</p>
          <div id="cp-sites"></div>
        </div>
        <aside class="cp-aside" id="cp-aside"></aside>
      </div>
    </section>
    <section id="cp-v-semaine" hidden>
      <div class="cp-week-head">
        <button type="button" class="icon-btn" data-action="prev-week" aria-label="Semaine précédente">‹</button>
        <h3 id="cp-weekTitle"></h3>
        <button type="button" class="icon-btn" data-action="next-week" aria-label="Semaine suivante">›</button>
        <span class="cp-spacer"></span>
        <button type="button" class="btn btn-primary" data-action="export-week">📥 Exporter la semaine en Excel</button>
      </div>
      <div class="cp-table-wrap"><table id="cp-weekTable"></table></div>
      <p class="cp-meta cp-note">Export au format de la feuille « semaine » du classeur : un bloc par jour, LF en orange, LN en bleu, LA en jaune, colonnes C · N° · code · date · Nb wgs, lignes TOTAL en formules.</p>
      <div class="cp-panel cp-import">
        <h3>Reprendre l'historique</h3>
        <p class="cp-meta" id="cp-stored"></p>
        <p class="cp-meta">Importez le classeur « Affectation des coupons » (toutes ses feuilles semaine) ou un export de cet écran. Les journées déjà saisies ici ne sont pas modifiées.</p>
        <label class="btn btn-outline cp-file">📤 Importer un classeur Excel<input type="file" id="cp-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
      </div>
    </section>
  </div>
  <div class="cp-toast" id="cp-toast" hidden role="status"><span id="cp-toastMsg"></span><button type="button" id="cp-toastUndo" hidden>Annuler</button></div>`;

function goDay(d) { commitPending(); state.day = d; state.active = {}; render(); }
function setView(v) { commitPending(); state.view = v; render(); }

function bindEvents(root) {
  // Les boutons ne prennent pas le focus à la souris : la ligne en cours
  // reste active pour les raccourcis date/wagons.
  root.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

  root.addEventListener('click', (e) => {
    const t = e.target;
    const view = t.closest('[data-view]'); if (view) { setView(view.dataset.view); return; }
    const act = t.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'close') closeCoupons();
      else if (a === 'prev-day') { let d = addDays(state.day, -1); if (toDate(d).getDay() === 0) d = addDays(d, -1); goDay(d); }
      else if (a === 'next-day') { let d = addDays(state.day, 1); if (toDate(d).getDay() === 0) d = addDays(d, 1); goDay(d); }
      else if (a === 'today') goDay(todayISO());
      else if (a === 'prev-week') goDay(addDays(mondayOf(state.day), -7));
      else if (a === 'next-week') goDay(addDays(mondayOf(state.day), 7));
      else if (a === 'export-day') exportDay(act);
      else if (a === 'export-week') exportWeek(act);
      return;
    }
    const wd = t.closest('[data-day]'); if (wd) { goDay(wd.dataset.day); return; }
    const od = t.closest('[data-openday]'); if (od) { commitPending(); state.day = od.dataset.openday; setView('saisie'); return; }
    const del = t.closest('[data-del]'); if (del) { const [s, i] = del.dataset.del.split('|'); removeLine(s, +i); return; }
    const sd = t.closest('[data-setd]'); if (sd) {
      const [s, v] = sd.dataset.setd.split('|'); const k = activeRow(s); const r = draftRow(s, k); r.d = v;
      if ((getDoc(state.day).nav[s] || [])[k]) commitRow(s, k, { render: true }); else render();
      focusCell(s, k, String(r.n).trim() ? 'w' : 'n'); return;
    }
    const sw = t.closest('[data-setw]'); if (sw) {
      const [s, v] = sw.dataset.setw.split('|'); const k = activeRow(s); const r = draftRow(s, k); r.w = v;
      if (String(r.n).trim()) commitRow(s, k, { next: true }); else { render(); focusCell(s, k, 'n'); }
      return;
    }
    const as = t.closest('[data-addshuttle]'); if (as) {
      const f = FAMS.find((x) => x.id === as.dataset.addshuttle); const next = f.id + (shuttlesFor(state.day, f).length + 1);
      mutate(state.day, (doc) => { doc.keep = doc.keep || []; if (!doc.keep.includes(next)) doc.keep.push(next); doc.nav[next] = doc.nav[next] || []; });
      focusCell(next, 0, 'n');
    }
  });

  root.addEventListener('input', (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.f) return;
    const r = draftRow(el.dataset.s, +el.dataset.k); r[el.dataset.f] = el.value;
    if (r.bad) r.bad = r.bad.filter((x) => x !== el.dataset.f);
    el.classList.remove('bad'); el.closest('.cp-row').classList.add('pending');
  });
  root.addEventListener('focusin', (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.f) return;
    const s = el.dataset.s, k = +el.dataset.k;
    if (state.active[s] !== k) {
      state.active[s] = k;
      const card = el.closest('.cp-card'); const avd = rowVals(s, k).d || defaultDCText(s);
      if (card) card.querySelectorAll('[data-setd]').forEach((b) => b.classList.toggle('on', b.dataset.setd.split('|')[1] === avd));
    }
  });
  // Quitter une ligne l'enregistre (comme une cellule Excel).
  root.addEventListener('focusout', (e) => {
    const row = e.target.closest && e.target.closest('.cp-row[data-k]'); if (!row) return;
    if (e.relatedTarget && row.contains(e.relatedTarget)) return;
    const s = row.dataset.s, k = +row.dataset.k;
    setTimeout(() => {
      const a = document.activeElement; if (a && a.dataset && a.dataset.s === s && +a.dataset.k === k) return;
      if (state.root && state.rows[rowKey(s, k)]) commitRow(s, k, { render: true });
    }, 0);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.f) {
      const s = el.dataset.s, k = +el.dataset.k;
      if (e.key === 'Enter') { e.preventDefault(); draftRow(s, k); commitRow(s, k, { next: true }); return; }
      if (e.key === 'Escape' && state.rows[rowKey(s, k)]) { e.stopPropagation(); delete state.rows[rowKey(s, k)]; render(); focusCell(s, k, el.dataset.f); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) { e.preventDefault(); focusCell(s, Math.max(0, k + (e.key === 'ArrowDown' ? 1 : -1)), el.dataset.f); return; }
    }
    if (e.key === 'Escape') closeCoupons();
  });
  root.querySelector('#cp-datePick').addEventListener('change', (e) => { if (e.target.value) goDay(e.target.value); });
  root.querySelector('#cp-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (file) importFile(file, root.querySelector('.cp-file'));
  });
  root.querySelector('#cp-toastUndo').addEventListener('click', () => { if (undoFn) undoFn(); undoFn = null; q('#cp-toast').hidden = true; });
}

export function openCoupons() {
  state.docs = loadCoupons();
  state.rows = {}; state.active = {};
  state.day = todayISO(); if (toDate(state.day).getDay() === 0) state.day = addDays(state.day, 1);
  state.view = 'saisie';
  rebuildIndex();
  if (!state.root) {
    const root = document.createElement('div');
    root.id = 'couponsRoot'; root.className = 'cp-root';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Coupons navettes');
    root.innerHTML = SHELL;
    document.body.appendChild(root);
    state.root = root;
    bindEvents(root);
    // Échap ferme aussi quand le focus est resté hors de la fenêtre.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.root && !state.root.hidden && !state.root.contains(e.target)) closeCoupons();
    });
  }
  state.root.hidden = false;
  document.body.classList.add('coupons-open');
  render();
  if (window.matchMedia('(pointer: fine)').matches) focusCell('LF1', activeRow('LF1'), 'n');
}

export function closeCoupons() {
  if (!state.root || state.root.hidden) return;
  commitPending();
  state.root.hidden = true;
  document.body.classList.remove('coupons-open');
  const btn = document.getElementById('btnCoupons'); if (btn) btn.focus();
}
