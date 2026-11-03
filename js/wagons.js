// Convertisseur longueur ⇄ wagons (bouton "🚃 Wagons" de l'en-tête, à côté
// de "🎫 Coupons").
//
// - Longueur de voie → nombre de wagons plats porte-conteneurs 60' et 80'
//   (entier = arrondi inférieur, et valeur décimale).
// - Nombre de wagons → longueur nécessaire (opération inverse).
// - Choix du type de wagon (Touax, Ermewa, Wascosa, VTG, Eurowagon,
//   Đuro Đaković, Tatravagónka) : longueur hors tampons, tare, charge utile
//   et masse brute maxi, et tonnage / conteneurs 40' de la rame.
// - "Règle du plan" : 28 m par wagon 80' (plan Poste 50/54 annoté) et
//   21,4 m par wagon 60' (600 m → 28 wgs sur le plan d'origine). Modifiables.
//
// Module autonome comme coupons.js : il crée sa propre fenêtre plein écran
// (#wagonsRoot) et n'utilise rien d'app.js. Point d'entrée : openWagons().
// Seuls le type choisi et les règles sont mémorisés (localStorage).

const STORE_KEY = 'traintrack:wagons:v1';
const ESSIEU_MAX = 22.5; // t par essieu

const FAMILLES = {
  sgnss60: "Sgnss 60' · 4 essieux · 1 × 40' (+ 1 × 20')",
  sggrss80: "Sggrss 80' articulé · 6 essieux · 2 × 40'",
  sggnss80: "Sggnss 80' plat · 4 essieux · 2 × 40'",
  sggrrss80: "Sggrrss 80' double · 8 essieux · 2 × 40'",
};

// Fiches constructeurs / loueurs (voir README, § Convertisseur wagons).
const WAGONS = {
  60: [
    { id: 'touax60', fam: 'sgnss60', nom: "Touax Sgnss 60'", lob: 19.74, utile: '18,40 m', tare: 20.0, cu: 70.0, essieux: 4, c40: 1, c20: 1,
      note: "Fiche Touax : longueur utile 18,40 m, tare 20 t maxi. Longueur hors tampons non indiquée : valeur standard Sgnss 60' (19,74 m)." },
    { id: 'ermewa60', fam: 'sgnss60', nom: "Ermewa Sgnss 60'", lob: 19.74, utile: null, tare: 19.0, cu: 71.0, essieux: 4, c40: 1, c20: 1 },
    { id: 'wascosa60', fam: 'sgnss60', nom: "Wascosa Sgnss 60' light", lob: 20.00, utile: '18,76 m', tare: 17.4, cu: 72.6, essieux: 4, c40: 1, c20: 1 },
  ],
  80: [
    { id: 'ermewa80', fam: 'sggrss80', nom: "Ermewa Sggrss 80'", lob: 26.40, utile: null, tare: 26.6, cu: 108.8, essieux: 6, c40: 2,
      note: "Ermewa annonce 108,8 t de charge utile ; la masse brute reste plafonnée à 135 t (6 essieux × 22,5 t)." },
    { id: 'wascosa80', fam: 'sggrss80', nom: "Wascosa Sggrss 80'", lob: 26.39, utile: '2 × 11,99 m', tare: 26.5, cu: 108.5, essieux: 6, c40: 2 },
    { id: 'vtg80', fam: 'sggrss80', nom: "VTG Sggrs(s) 80'", lob: 26.39, utile: '2 × 12,20 m', tare: 28.5, cu: 106.5, essieux: 6, c40: 2 },
    { id: 'eurowagon80', fam: 'sggrss80', nom: "Eurowagon Sggrs 80'", lob: 26.39, utile: null, tare: 27.5, cu: 107.5, essieux: 6, c40: 2 },
    { id: 'ermewa80n', fam: 'sggnss80', nom: "Ermewa Sggnss 80'", lob: 25.94, utile: null, tare: 21.8, cu: 68.2, essieux: 4, c40: 2 },
    { id: 'dd80n', fam: 'sggnss80', nom: "Đuro Đaković Sggnss 80'", lob: 25.94, utile: null, tare: 21.3, cu: 68.7, essieux: 4, c40: 2 },
    { id: 'tatra80rr', fam: 'sggrrss80', nom: "Tatravagónka Sggrrss 80'", lob: 26.48, utile: null, tare: 32.2, cu: 147.8, essieux: 8, c40: 2,
      note: "Wagon double à 8 essieux : 180 t de masse brute maxi, pour conteneurs lourds." },
  ],
};
const REGLE = { 60: 21.4, 80: 28 };
const VOIES = [
  ['5411⇦5416', 600], ['5401⇦5416', 789], ['5411⇦5410', 264], ['5401⇦5410', 453], ['5003⇨Heurtoir', 750],
  ['Vr5', 922], ['Vr7', 990], ['Vr12', 880], ['Vf1', 881], ['Vf3', 817], ['Vfl4', 528], ['Vext1', 1170], ['Vext2', 1470],
];
const SOURCES = [
  ["Sgnss 4563 Touax (Rail Cargo)", 'https://www.railcargo.com/bg/dam/jcr:edc68b0b-06bc-4b0e-a826-5fef312bc7a9/sgnss-4563-touax.pdf'],
  ["Ermewa Sgnss 60'", 'https://www.ermewa.com/en/wagons/sgnss-60-2/'],
  ["Wascosa 60' light", 'https://wascosa.alpha.bag.ch/99-datenobjekte/wagenpark/Typenbl%C3%A4tter/en/intermodalwagen/containertragwagen/Containertragwagen60_light_EN.pdf'],
  ["Ermewa Sggrss 80'", 'https://www.ermewa.com/en/wagons/sggrss-80-6-axles-2/'],
  ["Wascosa Sggrss 80'", 'https://www.wascosa.com/99-datenobjekte/wagenpark/Typenbl%C3%A4tter/en/intermodalwagen/containertragwagen/ID-145_Containertragwagen%2080_Sggrss_EN_TAK_2.pdf'],
  ["VTG Sggrs(s) 80'", 'https://www.vtg.com/solutions/fleet/containerwagen/sggrs-s-80_sggrss_i71080d'],
  ["Eurowagon Sggrs 80'", 'https://www.euro-wagon.com/fileadmin/user-files/oferta/sggrs80/en-technical-specification-80.pdf'],
  ["Ermewa Sggnss 80'", 'https://www.ermewa.com/en/wagons/sggnss-80-2/'],
  ["Đuro Đaković Sggnss 80", 'https://duro-dakovic.com/wp-content/uploads/2024/01/TDS_Sggnss-80.pdf'],
  ["Tatravagónka Sggrrss 80'", 'https://tatravagonka.sk/inc/uploads/2021/09/Sggrrss-80_nahlad.pdf'],
];

// ---------- État ----------
const st = { mode: 'regle', dir: 'len', type: { 60: 'touax60', 80: 'ermewa80' }, regle: { ...REGLE }, root: null };
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) { Object.assign(st.type, saved.type || {}); Object.assign(st.regle, saved.regle || {}); if (saved.mode) st.mode = saved.mode; }
  } catch (e) { /* stockage indisponible */ }
  for (const f of [60, 80]) if (!WAGONS[f].some((w) => w.id === st.type[f])) st.type[f] = WAGONS[f][0].id;
}
function savePrefs() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ mode: st.mode, type: st.type, regle: st.regle })); } catch (e) { /* ignoré */ }
}

// ---------- Utilitaires ----------
const q = (sel) => st.root.querySelector(sel);
const fr = (v, d = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fr0 = (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const num = (el) => { const v = parseFloat(String(el.value).replace(',', '.')); return isFinite(v) && v > 0 ? v : 0; };
const wagon = (f) => WAGONS[f].find((w) => w.id === st.type[f]) || WAGONS[f][0];
const brute = (w) => Math.min(w.tare + w.cu, w.essieux * ESSIEU_MAX);
const pasDe = (f, w) => (st.mode === 'regle' ? st.regle[f] : w.lob);

// ---------- Fenêtre ----------
const SHELL = `
  <div class="wg-top">
    <div class="wg-top-row">
      <h2 class="wg-title"><span aria-hidden="true">🚃</span> Wagons 60' / 80'</h2>
      <button type="button" class="icon-btn wg-close" data-action="close" aria-label="Fermer le convertisseur">✕</button>
    </div>
  </div>
  <div class="wg-body">
    <p class="wg-intro">Entrez une longueur de voie pour obtenir le nombre de wagons, ou un nombre de wagons pour obtenir la longueur nécessaire. Choisissez le type : sa longueur et son tonnage maxi s'affichent.</p>

    <div class="wg-panel">
      <div class="wg-inputs">
        <label class="wg-field" for="wg-len">
          <span class="wg-lbl">Longueur de voie <span class="wg-active" id="wg-tagLen">calcul</span></span>
          <span class="wg-bigbox" id="wg-boxLen"><input id="wg-len" type="number" inputmode="decimal" min="0" step="1" value="600"><span>m</span></span>
        </label>
        <button type="button" class="wg-swap" data-action="swap" title="Inverser le sens du calcul" aria-label="Inverser le sens du calcul">⇄</button>
        <label class="wg-field" for="wg-nb">
          <span class="wg-lbl">Nombre de wagons <span class="wg-active" id="wg-tagNb" hidden>calcul</span></span>
          <span class="wg-bigbox wg-idle" id="wg-boxNb"><input id="wg-nb" type="number" inputmode="numeric" min="0" step="1" value="21"><span>wgs</span></span>
        </label>
        <label class="wg-field wg-opt" for="wg-deduct">
          <span class="wg-lbl">À déduire (loco, marge)</span>
          <span class="wg-box"><input id="wg-deduct" type="number" inputmode="decimal" min="0" step="0.1" value="0"><span>m</span></span>
        </label>
        <div class="wg-field wg-opt">
          <span class="wg-lbl" id="wg-modeLbl">Longueur par wagon</span>
          <div class="wg-seg" role="group" aria-labelledby="wg-modeLbl">
            <button type="button" data-action="mode-regle" id="wg-modeRule">Règle du plan</button>
            <button type="button" data-action="mode-lob" id="wg-modeLob">Hors tampons</button>
          </div>
        </div>
      </div>
      <div class="wg-chips" id="wg-chips" aria-label="Voies du plan Poste 50/54"></div>
    </div>

    <div class="wg-results">
      <article class="wg-res wg-r60" aria-live="polite">
        <div class="wg-res-h">
          <span class="wg-tag">60'</span><span class="wg-sub" id="wg-sub60"></span>
          <span class="wg-box"><select id="wg-type60" aria-label="Type de wagon 60'"></select></span>
        </div>
        <div class="wg-res-body" id="wg-res60"></div>
      </article>
      <article class="wg-res wg-r80" aria-live="polite">
        <div class="wg-res-h">
          <span class="wg-tag">80'</span><span class="wg-sub" id="wg-sub80"></span>
          <span class="wg-box"><select id="wg-type80" aria-label="Type de wagon 80'"></select></span>
        </div>
        <div class="wg-res-body" id="wg-res80"></div>
      </article>
    </div>

    <div class="wg-panel">
      <h3 class="wg-h3">Types de wagons, longueurs et tonnages</h3>
      <div class="wg-table-wrap"><table class="wg-table" id="wg-specs"></table></div>
      <p class="wg-foot">
        <b>Règle du plan :</b> 80' = 28 m par wagon (plan annoté), 60' = 21,4 m (600 m → 28 wgs sur le plan d'origine). Valeurs avec marge, identiques pour tous les types ; modifiables dans le tableau.
        <br><b>Hors tampons :</b> longueur réelle du type choisi. Le nombre de wagons est arrondi à l'entier inférieur ; la longueur nécessaire inclut la valeur « à déduire ».
        <br>Charge utile maxi = grille de charge la plus haute (catégorie D, ligne S). Masse brute plafonnée à 22,5 t par essieu (souvent 100 km/h à 22,5 t/essieu, 120 km/h à 20 t/essieu).
        <br>Sources : ${SOURCES.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join(' · ')}
      </p>
    </div>
  </div>`;

// ---------- Rendu ----------
function fillSelects() {
  for (const f of [60, 80]) {
    let h = '';
    for (const fam of Object.keys(FAMILLES)) {
      const list = WAGONS[f].filter((w) => w.fam === fam); if (!list.length) continue;
      h += '<optgroup label="' + FAMILLES[fam] + '">' + list.map((w) => '<option value="' + w.id + '"' + (w.id === st.type[f] ? ' selected' : '') + '>' + w.nom + ' — ' + fr(w.lob) + ' m · ' + fr0(brute(w)) + ' t</option>').join('') + '</optgroup>';
    }
    q('#wg-type' + f).innerHTML = h;
  }
}

function renderChips() {
  const L = num(q('#wg-len'));
  q('#wg-chips').innerHTML = '<span class="wg-lbl">Voies du plan</span>' + VOIES.map(([n, m]) =>
    '<button type="button" class="wg-chip' + (st.dir === 'len' && L === m ? ' on' : '') + '" data-len="' + m + '">' + n + ' <b>' + m + '</b></button>').join('');
}

function ficheHTML(w) {
  return '<div class="wg-fiche"><span class="wg-fam">' + FAMILLES[w.fam] + '</span>' +
    '<span>Longueur hors tampons <b>' + fr(w.lob) + ' m</b></span>' +
    (w.utile ? '<span>Longueur utile <b>' + w.utile + '</b></span>' : '') +
    '<span>Tare <b>' + fr0(w.tare) + ' t</b></span>' +
    '<span>Charge utile maxi <b>' + fr0(w.cu) + ' t</b></span>' +
    '<span>Masse brute maxi <b>' + fr0(brute(w)) + ' t</b></span></div>';
}

function kvHTML(n, w) {
  return '<div class="wg-kv">' +
    '<div><small>Charge utile maxi</small><b>' + fr0(n * w.cu) + ' t</b></div>' +
    '<div><small>Masse brute maxi</small><b>' + fr0(n * brute(w)) + ' t</b></div>' +
    '<div><small>Tare de la rame</small><b>' + fr0(n * w.tare) + ' t</b></div>' +
    '<div><small>Conteneurs 40\'</small><b>' + n * w.c40 + (w.c20 ? ' <small>+ ' + n * w.c20 + ' × 20\'</small>' : '') + '</b></div>' +
    '<div><small>Longueur hors tampons</small><b>' + fr0(n * w.lob) + ' m</b></div>' +
    '<div><small>Par wagon</small><b>' + fr(w.lob) + ' m</b></div>' +
    '</div>';
}

function renderResult(f) {
  const w = wagon(f);
  const pas = pasDe(f, w);
  const ded = num(q('#wg-deduct'));
  const modeTxt = st.mode === 'regle' ? ' · règle du plan' : ' · hors tampons';
  const pasTxt = fr(pas, pas % 1 ? 2 : 0);
  q('#wg-sub' + f).textContent = FAMILLES[w.fam];
  let html = ficheHTML(w);
  let n;
  if (st.dir === 'len') {
    const L = Math.max(0, num(q('#wg-len')) - ded);
    const x = pas > 0 ? L / pas : 0;
    n = Math.floor(x + 1e-9);
    html += '<div class="wg-big"><b>' + n + '</b><span>wgs (' + f + '\')</span><em>' + fr(x) + '</em></div>' +
      '<p class="wg-calc">' + fr0(L) + ' m ÷ ' + pasTxt + ' m = ' + fr(x) + modeTxt + '</p>';
  } else {
    n = Math.floor(num(q('#wg-nb')));
    const L = n * pas + ded;
    html += '<div class="wg-big"><b>' + fr0(L) + '</b><span>m nécessaires</span><em>pour ' + n + ' wgs</em></div>' +
      '<p class="wg-calc">' + n + ' × ' + pasTxt + ' m' + (ded ? ' + ' + fr0(ded) + ' m' : '') + ' = ' + fr0(L) + ' m' + modeTxt + '</p>';
  }
  html += kvHTML(n, w);
  if (w.note) html += '<p class="wg-note">' + w.note + '</p>';
  q('#wg-res' + f).innerHTML = html;
}

function renderSpecs() {
  let h = '<thead><tr><th>Type</th><th>Hors tampons</th><th>Longueur utile</th><th>Essieux</th><th>Conteneurs 40\'</th><th>Tare</th><th>Charge utile maxi</th><th>Masse brute maxi</th></tr></thead><tbody>';
  for (const f of [60, 80]) {
    for (const fam of Object.keys(FAMILLES)) {
      const list = WAGONS[f].filter((w) => w.fam === fam); if (!list.length) continue;
      h += '<tr class="wg-grp"><td colspan="8"><i class="wg-sw wg-sw' + f + '"></i>' + FAMILLES[fam] + '</td></tr>';
      for (const w of list) {
        h += '<tr><td>' + w.nom + '</td><td class="n">' + fr(w.lob) + ' m</td><td class="n">' + (w.utile || '—') + '</td><td class="n">' + w.essieux + '</td><td class="n">' + w.c40 + (w.c20 ? ' + 1 × 20\'' : '') + '</td><td class="n">' + fr0(w.tare) + ' t</td><td class="n">' + fr0(w.cu) + ' t</td><td class="n">' + fr0(brute(w)) + ' t</td></tr>';
      }
    }
  }
  h += '<tr class="wg-grp"><td colspan="8">Règle du plan (longueur par wagon, marge comprise)</td></tr>';
  for (const f of [60, 80]) {
    h += '<tr><td>Wagons ' + f + '\'</td><td colspan="7"><span class="wg-box wg-rule"><input id="wg-rule' + f + '" data-rule="' + f + '" type="number" step="0.1" min="1" value="' + st.regle[f] + '" aria-label="Longueur de la règle du plan ' + f + '\'"><span>m</span></span></td></tr>';
  }
  q('#wg-specs').innerHTML = h + '</tbody>';
}

function render() {
  q('#wg-modeRule').setAttribute('aria-pressed', String(st.mode === 'regle'));
  q('#wg-modeLob').setAttribute('aria-pressed', String(st.mode === 'lob'));
  q('#wg-boxLen').classList.toggle('wg-idle', st.dir !== 'len');
  q('#wg-boxNb').classList.toggle('wg-idle', st.dir !== 'wgs');
  q('#wg-tagLen').hidden = st.dir !== 'len';
  q('#wg-tagNb').hidden = st.dir !== 'wgs';
  renderResult(60); renderResult(80); renderChips();
}

// ---------- Événements ----------
function bindEvents(root) {
  const setDir = (d) => { st.dir = d; render(); };
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a) {
      const act = a.dataset.action;
      if (act === 'close') closeWagons();
      else if (act === 'swap') { setDir(st.dir === 'len' ? 'wgs' : 'len'); q(st.dir === 'len' ? '#wg-len' : '#wg-nb').focus(); }
      else if (act === 'mode-regle' || act === 'mode-lob') { st.mode = act === 'mode-regle' ? 'regle' : 'lob'; savePrefs(); render(); }
      return;
    }
    const chip = e.target.closest('[data-len]');
    if (chip) { q('#wg-len').value = chip.dataset.len; setDir('len'); q('#wg-len').focus(); }
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'wg-len') setDir('len');
    else if (t.id === 'wg-nb') setDir('wgs');
    else if (t.id === 'wg-deduct') render();
    else if (t.dataset.rule) { const v = num(t); if (v) { st.regle[t.dataset.rule] = v; savePrefs(); render(); } }
  });
  root.addEventListener('focusin', (e) => {
    if (e.target.id === 'wg-len' && st.dir !== 'len') setDir('len');
    if (e.target.id === 'wg-nb' && st.dir !== 'wgs') setDir('wgs');
  });
  root.addEventListener('change', (e) => {
    const m = /^wg-type(60|80)$/.exec(e.target.id);
    if (m) { st.type[m[1]] = e.target.value; savePrefs(); render(); }
  });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWagons(); });
}

export function openWagons() {
  if (!st.root) {
    loadPrefs();
    const root = document.createElement('div');
    root.id = 'wagonsRoot'; root.className = 'wg-root';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Convertisseur wagons 60\' / 80\'');
    root.innerHTML = SHELL;
    document.body.appendChild(root);
    st.root = root;
    bindEvents(root);
    fillSelects(); renderSpecs();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && st.root && !st.root.hidden && !st.root.contains(e.target)) closeWagons();
    });
  }
  st.root.hidden = false;
  document.body.classList.add('wagons-open');
  render();
  if (window.matchMedia('(pointer: fine)').matches) q('#wg-len').focus();
}

// Le module branche lui-même son bouton (chargé par sa propre balise
// <script type="module"> dans index.html) : il ne dépend pas d'app.js, et
// continue de marcher même si une ancienne copie d'app.js est en cache.
function wireButton() {
  const btn = document.getElementById('btnWagons');
  if (btn && !btn.dataset.wired) { btn.dataset.wired = '1'; btn.addEventListener('click', openWagons); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireButton);
else wireButton();

export function closeWagons() {
  if (!st.root || st.root.hidden) return;
  st.root.hidden = true;
  document.body.classList.remove('wagons-open');
  const btn = document.getElementById('btnWagons'); if (btn) btn.focus();
}
